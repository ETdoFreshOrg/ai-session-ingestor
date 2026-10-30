import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('imessage',Path(__file__).parents[1]/'connectors/imessage.py')
imessage=importlib.util.module_from_spec(spec)
spec.loader.exec_module(imessage)


class LocalCollectorTest(unittest.TestCase):
    def test_checkpoint_only_follows_confirmed_writes_and_retry_is_safe(self):
        with tempfile.TemporaryDirectory() as tmp:
            dbpath=Path(tmp)/'chat.db'; state=Path(tmp)/'state.json'
            db=sqlite3.connect(dbpath)
            db.executescript('''
              CREATE TABLE message(guid,text,attributedBody,date,is_from_me,service,cache_has_attachments,reply_to_guid,handle_id);
              CREATE TABLE handle(id);
              CREATE TABLE chat(chat_identifier,display_name);
              CREATE TABLE chat_message_join(chat_id,message_id);
              CREATE TABLE attachment(guid,filename,transfer_name,mime_type);
              CREATE TABLE message_attachment_join(attachment_id,message_id);
              INSERT INTO handle VALUES('person@example.test');
              INSERT INTO chat VALUES('stable-chat','Test');
              INSERT INTO message VALUES('guid-one','first',NULL,800000000000000000,0,'iMessage',0,NULL,1);
              INSERT INTO message VALUES('guid-two','second',NULL,800000001000000000,1,'iMessage',0,NULL,1);
              INSERT INTO chat_message_join VALUES(1,1),(1,2);
            ''');db.close()
            args=SimpleNamespace(state=str(state),database=str(dbpath),since='2026-01-01T00:00:00Z',limit=200,dry_run=False)
            with patch.object(imessage,'request',return_value={}),contextlib.redirect_stdout(io.StringIO()):
                with patch.object(imessage,'upload',side_effect=[{'message':{'record_id':'one'}},OSError('offline')]):
                    imessage.run({},args)
                self.assertEqual(json.loads(state.read_text())['last_rowid'],1)
                with patch.object(imessage,'upload',return_value={'message':{'record_id':'two'}}) as upload:
                    imessage.run({},args)
                    self.assertEqual(upload.call_count,1)
                    self.assertEqual(upload.call_args.args[1]['external_id'],'guid-two')
                with patch.object(imessage,'upload') as upload:
                    imessage.run({},args);upload.assert_not_called()


SCHEMA='''
  CREATE TABLE message(guid,text,attributedBody,date,is_from_me,service,cache_has_attachments,reply_to_guid,handle_id);
  CREATE TABLE handle(id);
  CREATE TABLE chat(chat_identifier,display_name);
  CREATE TABLE chat_message_join(chat_id,message_id);
  CREATE TABLE attachment(guid,filename,transfer_name,mime_type,transfer_state);
  CREATE TABLE message_attachment_join(attachment_id,message_id);
  INSERT INTO handle VALUES('person@example.test');
  INSERT INTO chat VALUES('stable-chat','Test');
'''


class AttachmentRetryTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); root=Path(self.tmp.name)
        # Mirror <home>/Library/Messages so "~/" paths resolve against this home.
        self.home=root/'home'; self.messages=self.home/'Library'/'Messages'
        (self.messages/'Attachments').mkdir(parents=True)
        self.dbpath=self.messages/'chat.db'; self.state=root/'state.json'
        db=sqlite3.connect(self.dbpath); db.executescript(SCHEMA); db.close()
        self.args=SimpleNamespace(state=str(self.state),database=str(self.dbpath),since='2026-01-01T00:00:00Z',
                                  limit=200,dry_run=False,max_attachment_retries=3)
        self.clock=1_800_000_000.0
        self.heartbeats=[]; self.uploads=[]

    def tearDown(self): self.tmp.cleanup()

    def add_message(self,guid,attachments):
        db=sqlite3.connect(self.dbpath)
        rowid=db.execute('INSERT INTO message VALUES(?,?,NULL,800000000000000000,0,?,1,NULL,1)',[guid,'','iMessage']).lastrowid
        db.execute('INSERT INTO chat_message_join VALUES(1,?)',[rowid])
        for name in attachments:
            arow=db.execute('INSERT INTO attachment VALUES(?,?,?,?,5)',[guid+'-'+name,'~/Library/Messages/Attachments/'+name,name,'image/png']).lastrowid
            db.execute('INSERT INTO message_attachment_join VALUES(?,?)',[arow,rowid])
        db.commit(); db.close(); return rowid

    def put_file(self,name,size=4): (self.messages/'Attachments'/name).write_bytes(b'x'*size)

    def run_once(self,hours=0):
        self.clock+=hours*3600
        def fake_upload(config,message,attachments):
            self.uploads.append((message,[att['guid'] for att,_ in attachments])); return {'message':{'record_id':'r'}}
        def fake_request(config,path,data,content_type='application/json',method='POST'):
            self.heartbeats.append(json.loads(data)); return {}
        with patch.object(imessage,'upload',side_effect=fake_upload),patch.object(imessage,'request',side_effect=fake_request),\
             patch.object(imessage.time,'time',return_value=self.clock),contextlib.redirect_stdout(io.StringIO()):
            imessage.run({},self.args)
        return self.heartbeats[-1]

    def test_missing_attachments_do_not_block_checkpoint_or_freshness(self):
        self.put_file('here.png'); self.add_message('m1',['here.png','gone.png'])
        beat=self.run_once()
        self.assertIsNone(beat['error_message']); self.assertIn('last_sync_date',beat)
        self.assertEqual(beat['metadata']['missing_reasons'],{'not_on_disk':1})
        self.assertEqual(self.uploads[0][1],['m1-here.png'])
        state=json.loads(self.state.read_text())
        self.assertEqual(state['last_rowid'],1); self.assertEqual(state['retry']['1']['missing'],['m1-gone.png'])
        # Not due yet: nothing is re-sent on the next run.
        self.run_once(hours=0.1); self.assertEqual(len(self.uploads),1)

    def test_retry_sends_only_recovered_files_with_identical_message(self):
        self.add_message('m1',['late.png'])
        self.run_once(); first=self.uploads[0][0]
        self.run_once(hours=1); self.assertEqual(len(self.uploads),1)   # still missing: no API call
        self.put_file('late.png'); beat=self.run_once(hours=2)
        self.assertEqual(self.uploads[-1],(first,['m1-late.png']))
        self.assertEqual(beat['metadata']['attachments_recovered'],1)
        self.assertEqual(json.loads(self.state.read_text())['retry'],{})

    def test_retry_budget_then_gives_up(self):
        self.add_message('m1',['never.png'])
        self.run_once()
        for _ in range(5): beat=self.run_once(hours=48)
        state=json.loads(self.state.read_text())
        self.assertEqual(state['retry'],{})
        self.assertEqual(state['gave_up']['1']['missing'],{'m1-never.png':'not_on_disk'})
        self.assertEqual(beat['metadata']['attachments_unavailable_total'],1)
        self.assertEqual(len(self.uploads),1)

    def test_oversized_files_are_abandoned_immediately(self):
        self.put_file('huge.mov',imessage.MAX_ATTACHMENT_BYTES+1); self.add_message('m1',['huge.mov'])
        beat=self.run_once()
        self.assertEqual(beat['metadata']['attachments_gave_up'],1)
        self.assertEqual(json.loads(self.state.read_text())['retry'],{})

    def test_legacy_retry_list_gets_one_final_attempt(self):
        self.add_message('m1',['gone.png'])
        self.state.write_text(json.dumps({'last_rowid':1,'retry':[1,1]}))
        beat=self.run_once()
        state=json.loads(self.state.read_text())
        self.assertEqual(state['retry'],{}); self.assertIn('1',state['gave_up'])
        self.assertEqual(beat['metadata']['retried'],1); self.assertEqual(self.uploads,[])

    def test_more_than_ten_files_are_sent_in_batches(self):
        names=[f'f{i}.png' for i in range(12)]
        for name in names: self.put_file(name)
        self.add_message('m1',names); self.run_once()
        self.assertEqual([len(guids) for _,guids in self.uploads],[10,2])
        self.assertEqual(self.uploads[0][0],self.uploads[1][0])

    def test_tilde_paths_resolve_against_the_database_home(self):
        self.put_file('a.png')
        with patch.dict(os.environ,{'HOME':'/nonexistent-home'}):
            path,reason=imessage.classify({'filename':'~/Library/Messages/Attachments/a.png'},str(self.dbpath))
        self.assertIsNone(reason); self.assertEqual(path,self.messages/'Attachments'/'a.png')

    def test_diagnose_is_read_only_and_explains_reasons(self):
        self.add_message('m1',['gone.png']); self.run_once()
        before=self.state.read_text(); out=io.StringIO()
        summary=imessage.diagnose(SimpleNamespace(state=str(self.state),database=str(self.dbpath),rowid=None),out)
        self.assertEqual(summary,{'not_on_disk':1}); self.assertEqual(self.state.read_text(),before)
        line=json.loads(out.getvalue().splitlines()[1])
        self.assertEqual((line['reason'],line['queue'],line['transfer_state']),('not_on_disk','retry',5))

if __name__=='__main__': unittest.main()
