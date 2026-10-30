#!/usr/bin/env python3
"""Local macOS iMessage ingestor. Reads SQLite; writes only through Memory API.

Attachments whose bytes are not on disk are retried with backoff and a budget,
then recorded as unavailable. They never hold the row checkpoint or the
freshness heartbeat. --diagnose prints, read-only, why each one is missing.
"""
import argparse
import datetime as dt
import json
import mimetypes
import os
from pathlib import Path
import shlex
import socket
import sqlite3
import stat
import sys
import time
import urllib.request
import uuid

MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
FILES_PER_UPLOAD = 10          # Memory API ingest accepts at most 10 files per request
RETRY_ROWS_PER_RUN = 50
RETRY_BASE_SECONDS = 30 * 60   # 30m, 1h, 2h, 4h, 8h, 16h, then daily
RETRY_CAP_SECONDS = 24 * 3600
DEFAULT_MAX_RETRIES = 8        # about three days of retries before giving up
GAVE_UP_KEEP = 5000
# Reasons that no amount of waiting changes.
PERMANENT_REASONS = {'too_large', 'not_a_file'}
OPTIONAL_ATTACHMENT_COLUMNS = ('transfer_state', 'is_sticker', 'hide_attachment', 'uti', 'total_bytes', 'is_outgoing')


def timestamp(value):
    seconds = value / 1e9 if abs(value) > 1e12 else value
    return dt.datetime.fromtimestamp(seconds + 978307200, dt.timezone.utc).isoformat()


def request(config, path, data, content_type='application/json', method='POST'):
    req=urllib.request.Request(config['MEMORY_DATABASE_API_URL'].rstrip('/')+path,data=data,method=method,
        headers={'Authorization':'Bearer '+config['MEMORY_DATABASE_API_WRITE_TOKEN'],
                 'Content-Type':content_type,'User-Agent':'Mozilla/5.0 LocalMemoryIngestor/1.0'})
    with urllib.request.urlopen(req,timeout=90) as response:
        return json.load(response)


def upload(config,message,attachments):
    boundary='memory-'+uuid.uuid4().hex
    body=bytearray()
    metadata=[]
    for att,path in attachments:
        metadata.append({'original_file_name':att['transfer_name'] or path.name,
                         'provider':'imessage','provider_attachment_id':att['guid'],'role':'original'})
    for key,value in [('message',message),('attachments_meta',metadata)]:
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        body.extend(json.dumps(value).encode()); body.extend(b'\r\n')
    for att,path in attachments:
        name=path.name.replace('"','_').replace('\r','_').replace('\n','_')
        mime=att['mime_type'] or mimetypes.guess_type(name)[0] or 'application/octet-stream'
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode())
        body.extend(path.read_bytes()); body.extend(b'\r\n')
    body.extend(f'--{boundary}--\r\n'.encode())
    # Retry of an unchanged source record is idempotent; this also lets missing
    # local attachment bytes be attached later without rewriting message text.
    return request(config,'/api/messages/ingest?conflict_mode=skip_or_append',bytes(body),'multipart/form-data; boundary='+boundary)


def send(config,message,available):
    """Upload the message with its available files, ten per request.

    Later batches resend the identical message, which the API skips before
    linking the extra files. Raises unless every request confirms a record.
    """
    batches=[available[i:i+FILES_PER_UPLOAD] for i in range(0,len(available),FILES_PER_UPLOAD)] or [[]]
    for batch in batches:
        result=upload(config,message,batch)
        if not result.get('message',{}).get('record_id'): raise ValueError('No confirmed record ID')


def messages_home(database):
    """Home directory that owns chat.db (<home>/Library/Messages/chat.db).

    chat.db stores attachment paths as ~/Library/Messages/Attachments/...; they
    belong to the account that owns the database, not to whatever HOME the
    collector process happens to run with (launchd, pm2, sudo).
    """
    db=Path(database).expanduser()
    if db.parent.name=='Messages' and db.parent.parent.name=='Library':
        return db.parent.parent.parent
    return Path.home()


def resolve_attachment_path(filename, database):
    if not filename: return None
    if filename=='~' or filename.startswith('~/'):
        return messages_home(database)/filename[2:]
    path=Path(filename)
    return path if path.is_absolute() else Path(database).expanduser().parent/path


def classify(att, database):
    """Return (path, reason); reason is None when the file can be uploaded."""
    path=resolve_attachment_path(att['filename'], database)
    if path is None: return None,'no_local_path'
    try: info=path.stat()
    except FileNotFoundError: return path,'not_on_disk'
    except PermissionError: return path,'permission_denied'
    except OSError: return path,'unreadable'
    if not stat.S_ISREG(info.st_mode): return path,'not_a_file'
    if info.st_size>MAX_ATTACHMENT_BYTES: return path,'too_large'
    try:
        with open(path,'rb') as handle: handle.read(1)
    except PermissionError: return path,'permission_denied'
    except OSError: return path,'unreadable'
    return path,None


def attachments_for(db,rowid):
    # Unchanged query: attachment_ids order feeds the message metadata, which
    # must stay identical so retries never create a new record version.
    return db.execute('''SELECT a.guid,a.filename,a.transfer_name,a.mime_type FROM attachment a
        JOIN message_attachment_join j ON j.attachment_id=a.ROWID WHERE j.message_id=?''',[rowid]).fetchall()


def build_message(row,records):
    text=(row['text'] or '').strip()
    text_missing=not text and bool(row['has_attributed']) and not records
    metadata={'chat_id':row['chat_id'],'chat_identifier':row['chat_identifier'],
        'conversation_id':row['chat_identifier'] or str(row['chat_id']) if row['chat_id'] else None,
        'service':row['service'],'is_from_me':bool(row['is_from_me']),
        'reply_to_guid':row['reply_to_guid'],'hasAttachments':bool(records),
        'attachment_ids':[att['guid'] for att in records],'source_text_unavailable':text_missing,
        'kind':'human_message','ingestor':'local-imessage'}
    message={'source':'imessage','external_id':row['guid'],'sender':'ET' if row['is_from_me'] else row['sender'],
        'recipient':row['chat_identifier'],'timestamp':timestamp(row['date']),
        'content':text or ('[Message with attachments]' if records else '[Message text unavailable]'),'metadata':metadata}
    return message,text_missing


MESSAGE_SELECT='''SELECT m.ROWID AS rowid,m.guid,m.text,m.attributedBody IS NOT NULL AS has_attributed,
    m.date,m.is_from_me,m.service,m.cache_has_attachments,m.reply_to_guid,h.id AS sender,
    c.ROWID AS chat_id,c.chat_identifier,c.display_name
    FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id
    LEFT JOIN chat c ON c.ROWID=(SELECT chat_id FROM chat_message_join WHERE message_id=m.ROWID LIMIT 1)'''


def load_state(state_path,max_retries):
    state=json.loads(state_path.read_text()) if state_path.exists() else {}
    state.setdefault('last_rowid',0)
    retry=state.get('retry',{})
    if isinstance(retry,list):
        # Rows queued by the earlier collector were retried every run with no
        # limit. Give each one final attempt (with corrected path resolution).
        now=dt.datetime.now(dt.timezone.utc).isoformat()
        retry={str(rowid):{'attempts':max_retries-1,'next_retry_at':0,'first_missing_at':now,'missing':None}
               for rowid in dict.fromkeys(retry)}
    state['retry']=retry
    state.setdefault('gave_up',{})
    return state


def save_state(state_path,state):
    if len(state['gave_up'])>GAVE_UP_KEEP:
        keep=sorted(state['gave_up'],key=int)[-GAVE_UP_KEEP:]
        state['gave_up']={key:state['gave_up'][key] for key in keep}
    state_path.parent.mkdir(parents=True,exist_ok=True)
    temporary=state_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state)); temporary.chmod(0o600); temporary.replace(state_path)


def run(config,args):
    state_path=Path(args.state).expanduser()
    max_retries=getattr(args,'max_attachment_retries',DEFAULT_MAX_RETRIES)
    state=load_state(state_path,max_retries)
    db=sqlite3.connect('file:'+str(Path(args.database).expanduser())+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    since=dt.datetime.fromisoformat(args.since.replace('Z','+00:00')).timestamp()
    apple_since=int((since-978307200)*1e9)
    now=time.time()
    new_rows=db.execute(MESSAGE_SELECT+' WHERE m.ROWID>? AND m.date>=? ORDER BY m.ROWID LIMIT ?',
                        [state['last_rowid'],apple_since,args.limit]).fetchall()
    due=sorted((entry.get('next_retry_at',0),int(rowid)) for rowid,entry in state['retry'].items()
               if entry.get('next_retry_at',0)<=now)[:RETRY_ROWS_PER_RUN]
    report={'source':'imessage','hostname':socket.gethostname(),'scanned':len(new_rows)+len(due),
            'new_messages':len(new_rows),'written':0,'retried':0,'attachments_missing':0,
            'attachments_recovered':0,'attachments_gave_up':0,'missing_reasons':{},
            'text_unavailable':0,'failed':0}
    latest=None

    def note_missing(rowid,missing):
        """Queue transient gaps for retry; give up on permanent ones now."""
        key=str(rowid)
        transient={g:r for g,r in missing.items() if r not in PERMANENT_REASONS}
        permanent={g:r for g,r in missing.items() if r in PERMANENT_REASONS}
        entry=state['retry'].get(key)
        if transient and entry is not None and entry.get('attempts',0)+1>=max_retries:
            permanent.update(transient); transient={}
        if permanent:
            gone=state['gave_up'].setdefault(key,{'missing':{},'at':dt.datetime.now(dt.timezone.utc).isoformat()})
            gone['missing'].update(permanent); report['attachments_gave_up']+=len(permanent)
        if transient:
            attempts=0 if entry is None else entry.get('attempts',0)+1
            state['retry'][key]={'attempts':attempts,
                'next_retry_at':now+min(RETRY_CAP_SECONDS,RETRY_BASE_SECONDS*2**attempts),
                'first_missing_at':(entry or {}).get('first_missing_at') or dt.datetime.now(dt.timezone.utc).isoformat(),
                'missing':sorted(transient),'reasons':transient}
        else:
            state['retry'].pop(key,None)

    def inspect(records,targets=None):
        available=[]; missing={}
        for att in records:
            if targets is not None and att['guid'] not in targets: continue
            path,reason=classify(att,args.database)
            if reason: missing[att['guid']]=reason
            else: available.append((att,path))
        for reason in missing.values():
            report['missing_reasons'][reason]=report['missing_reasons'].get(reason,0)+1
        return available,missing

    for row in new_rows:
        records=attachments_for(db,row['rowid'])
        available,missing=inspect(records)
        message,text_missing=build_message(row,records)
        if args.dry_run:
            report['attachments_missing']+=len(missing); continue
        try: send(config,message,available)
        except Exception as error:
            report['failed']+=1; report['error']=type(error).__name__; report['error_detail']=str(error)[:200]; break
        report['written']+=1; report['attachments_missing']+=len(missing)
        report['text_unavailable']+=int(text_missing)
        state['last_rowid']=max(state['last_rowid'],row['rowid'])
        latest=message['timestamp']
        if missing: note_missing(row['rowid'],missing)
        save_state(state_path,state)

    for _,rowid in ([] if report['failed'] else due):
        entry=state['retry'].get(str(rowid))
        if entry is None: continue
        found=db.execute(MESSAGE_SELECT+' WHERE m.ROWID=?',[rowid]).fetchone()
        if found is None:
            state['retry'].pop(str(rowid),None)
            if not args.dry_run: save_state(state_path,state)
            continue
        records=attachments_for(db,rowid)
        targets=set(entry['missing']) if entry.get('missing') is not None else None
        available,missing=inspect(records,targets)
        report['retried']+=1
        if args.dry_run: continue
        if available:
            message,_=build_message(found,records)
            try: send(config,message,available)
            except Exception as error:
                report['failed']+=1; report['error']=type(error).__name__; report['error_detail']=str(error)[:200]; break
            report['attachments_recovered']+=len(available)
        note_missing(rowid,missing)
        save_state(state_path,state)
    db.close()

    report['retry_rows_pending']=len(state['retry'])
    report['attachments_retry_pending']=sum(len(e.get('missing') or [None]) for e in state['retry'].values())
    report['attachments_unavailable_total']=sum(len(e.get('missing',{})) for e in state['gave_up'].values())
    if not args.dry_run:
        nowiso=dt.datetime.now(dt.timezone.utc).isoformat()
        # Only write failures are errors. Missing attachment bytes and
        # undecoded attributed-only bodies are known gaps, counted in metadata.
        error=report.get('error')
        heartbeat={'source':'imessage','last_run_at':nowiso,'error_message':error,'metadata':report}
        if not error: heartbeat['last_sync_date']=nowiso
        if latest: heartbeat['last_record_date']=latest[:10]
        request(config,'/api/sync-state/local-imessage:'+socket.gethostname(),json.dumps(heartbeat).encode(),method='PUT')
    print(json.dumps(report),flush=True)
    return len(new_rows)>=args.limit and not report['failed']


def diagnose(args,out=None):
    """Read-only: explain every queued or abandoned attachment. Sends nothing."""
    out=out or sys.stdout
    state_path=Path(args.state).expanduser()
    state=load_state(state_path,DEFAULT_MAX_RETRIES) if state_path.exists() else {'retry':{},'gave_up':{},'last_rowid':0}
    database=Path(args.database).expanduser()
    print(json.dumps({'context':{'python':sys.executable,'uid':os.getuid() if hasattr(os,'getuid') else None,
        'HOME':os.environ.get('HOME'),'path_home':str(Path.home()),'messages_home':str(messages_home(args.database)),
        'database':str(database),'database_readable':os.access(database,os.R_OK),
        'last_rowid':state['last_rowid'],'retry_rows':len(state['retry']),'gave_up_rows':len(state['gave_up'])}}),file=out)
    db=sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    columns={r['name'] for r in db.execute('PRAGMA table_info(attachment)')}
    extra=[c for c in OPTIONAL_ATTACHMENT_COLUMNS if c in columns]
    rowids=sorted({int(r) for r in state['retry']}|{int(r) for r in state['gave_up']}|set(args.rowid or []))
    summary={}
    for rowid in rowids:
        found=db.execute('SELECT date FROM message WHERE ROWID=?',[rowid]).fetchone()
        select=','.join(['a.guid','a.filename','a.transfer_name','a.mime_type',*('a.'+c for c in extra)])
        for att in db.execute(f'''SELECT {select} FROM attachment a JOIN message_attachment_join j
                ON j.attachment_id=a.ROWID WHERE j.message_id=?''',[rowid]).fetchall():
            path,reason=classify(att,args.database)
            size=None
            try: size=path.stat().st_size if path else None
            except OSError: pass
            summary[reason or 'available']=summary.get(reason or 'available',0)+1
            print(json.dumps({'rowid':rowid,'message_date':timestamp(found['date']) if found else None,
                'queue':'retry' if str(rowid) in state['retry'] else 'gave_up' if str(rowid) in state['gave_up'] else 'requested',
                'guid':att['guid'],'filename':att['filename'],'resolved_path':str(path) if path else None,
                'reason':reason or 'available','size':size,'transfer_name':att['transfer_name'],'mime_type':att['mime_type'],
                **{c:att[c] for c in extra}}),file=out)
    db.close()
    print(json.dumps({'summary':summary}),file=out)
    return summary


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env')
    parser.add_argument('--database',default='~/Library/Messages/chat.db')
    parser.add_argument('--state',default='~/.local/share/memory-ingestors/imessage.json')
    parser.add_argument('--since',help='ISO date for the initial import window (required unless --diagnose)')
    parser.add_argument('--limit',type=int,default=200)
    parser.add_argument('--interval',type=int,default=0)
    parser.add_argument('--max-attachment-retries',type=int,default=DEFAULT_MAX_RETRIES)
    parser.add_argument('--dry-run',action='store_true')
    parser.add_argument('--diagnose',action='store_true',help='read-only report on missing attachments; sends nothing')
    parser.add_argument('--rowid',type=int,action='append',help='with --diagnose: also inspect this message ROWID')
    args=parser.parse_args()
    if args.diagnose:
        diagnose(args); return
    if not args.env or not args.since: parser.error('--env and --since are required')
    config={}
    for line in Path(args.env).expanduser().read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k,v=line.split('=',1); words=shlex.split(v); config[k]=words[0] if words else ''
    while True:
        try: backlog=run(config,args)
        except Exception as error:
            print(json.dumps({'source':'imessage','error':type(error).__name__,'error_detail':str(error)[:200]}),flush=True); backlog=False
            if not args.interval: raise
        if not args.interval or args.dry_run: break
        time.sleep(2 if backlog else args.interval)


if __name__=='__main__': main()
