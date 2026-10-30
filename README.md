# AI Session Ingestor

One service for ingesting local AI coding sessions into the ET Memory Database.
It replaces the separate Claude Code and Codex ingestors and adds OpenCode,
Antigravity, and Pi.

## Codex cloud service

`npm run start:cloud` runs the separate cloud collector. Dokploy builds it with
`Dockerfile.cloud`. The local ingestor and its existing sources remain separate.

The collector obtains a short-lived access token from a host's own Codex
app-server over SSH, then reads the cloud app-server directly. It tries
`CLOUD_AUTH_HOSTS` in order and retries on the next sync when every host fails.
Refresh tokens stay on their original hosts; no independent ChatGPT login is
needed in the container.

Install `scripts/cloud-auth.py` as `~/.local/bin/codex-cloud-auth.py` on each
host. Give the collector a dedicated SSH key authorized with
`restrict,command="python3 /absolute/home/.local/bin/codex-cloud-auth.py"`.
That key cannot run arbitrary shell commands, forward ports, or allocate a PTY.
Install verified host keys in `/data/.ssh/known_hosts`; the collector requires
strict host-key verification. Its private key is `/data/.ssh/id_ed25519`.

Cloud environment:

```dotenv
CLOUD_AUTH_HOSTS=[{"label":"primary","target":"user@primary"},{"label":"fallback","target":"user@fallback"}]
MEMORY_DATABASE_API_URL=https://your-memory-api.example.com
MEMORY_DATABASE_API_WRITE_TOKEN=...
INGESTOR_API_TOKEN=...
SENDER_NAME=ET
DATA_DIR=/data
CLOUD_EXPORT_DIR=/export/codex
PORT=3461
SYNC_INTERVAL_MS=60000
```

`INGESTOR_API_TOKEN` is required. The memory write token needs only `codex`
scope. An optional `CLOUD_ACCOUNT_ID` pins the expected ChatGPT account;
otherwise the first successful account is pinned in the checkpoint.

Mount separate named volumes at `/data` (SQLite, SSH credentials) and `/export`
(dashboard exports). AI Session Analysis mounts only the export volume and sets
`AI_CLOUD_CODEX_DIR` to its `codex` directory. No credential volume is shared.

Active and archived cloud threads are backfilled with full pagination. User and
completed assistant text, plus incoming cloud delegations, use stable
`cloud:<thread-id>:<item-id>` identities under Memory Database's `codex` source.
Accepted ChatGPT replies sent by Dot through `user_message.send_message` are
indexed as assistant messages, with their delivery IDs and timestamps. Repeated
deliveries or copied histories share `cloud:delivery:<message-id>` identities.
Failed sends and ordinary tool results remain excluded. Versioned text projection
upgrades reprocess retained items, including already-checkpointed terminal turns.
Reasoning stays out of the memory index. SQLite retains the
original cloud items. Completed turns are checkpointed; active turns are
rechecked. Failed memory writes remain pending, and every write uses
`skip_existing`. A running sync is never overlapped.

The service subscribes to active threads without starting turns or sending
messages. Live token notifications are deduplicated by cumulative token total.
Each dated cost record uses only the notification's last model call; cumulative
historical totals and gaps remain separate coverage snapshots. Historical
messages have no inferred model attribution. Weekly allowance estimates are
queried separately and retain the provider's `partial`/`unavailable` status.
Cloud endpoints are private implementation details and may change.

Endpoints:

- `GET /api/health`: liveness and cloud connectivity, no credentials.
- `GET /api/status`: authenticated counts, chosen auth host, failures, last sync.
- `GET /api/usage`: authenticated latest per-thread plan allowance snapshot.
- `POST /api/sync`: authenticated, schedules a sync and returns `202`.

Auth failures try the next host. Connection loss reconnects on the next sync.
An unavailable thread is deferred without blocking other history. Global
turn-start notifications subscribe to new active threads between scans.
SQLite and atomic export files survive redeploys. Shutdown preserves checkpoints.

## Supported sources

| Application | Local store | Memory Database source | Stable identity |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | `claudecode` | session ID + message UUID (tool events add `:tool_use:<id>` / `:tool_result:<id>`) |
| Codex | `~/.codex/sessions/**/*.jsonl` and archived sessions | `codex` | session ID + JSONL line + role |
| OpenCode | `~/.local/share/opencode/opencode.db` | `opencode` | OpenCode message ID |
| Antigravity | `~/.gemini/antigravity-cli/brain/**/transcript.jsonl` | `antigravity` | conversation + step + event + line |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | `pi` | session ID + entry ID |

Every user and assistant message is its own record in its session's
conversation (`metadata.sessionId` / `conversation_id`); no adapter stores a
whole session as one record. Thinking/reasoning blocks are never stored.

Claude Code tool calls and tool results are stored as separate records with
`metadata.role = "tool"`, `metadata.kind = "tool_output"` and
`metadata.toolEvent = "call" | "result"` (plus `toolName`, `toolUseId`,
`isError`). The Memory Database leaves `tool_output` out of default search.
Each tool record is capped at 16,000 characters (`truncated` and
`originalChars` say what was cut). `CLAUDECODE_TOOL_EVENTS` controls them:

- `new` (default): only events after this version's first real sync on the
  host (the cutoff is kept in the checkpoint), so upgrading does not backfill
  every historical tool event.
- `all` or an ISO date: backfill all events, or those since that date.
- `off`: none.

The other adapters still store only user and assistant text.

### Oversized messages

A message longer than 50,000 characters is split into ordered parts. Part 1
keeps the message's original identity; later parts are `<id>:part:<n>`. Each
part carries `part`, `parts`, `partOf` and `originalChars`, and its timestamp
is offset by one millisecond per part to keep order. Boundaries prefer line
breaks and are deterministic, so reruns are idempotent.

An oversized message that an earlier version already stored whole is not
split automatically: its parts are held (`heldForMigration` in the sync result
and `held_for_migration` in the published status) so the text is never stored
twice. `scripts/migrate-oversized-records.ts` replaces such records. It is a
dry run unless `--apply` is given, and should only be applied with the owner's
approval:

```bash
pm2 stop ai-session-ingestor
npm run migrate:oversized                      # dry run: lists records and part counts
npm run migrate:oversized -- --limit 1 --apply # replace one record, then check it
npm run migrate:oversized -- --apply
npm run migrate:oversized -- --record <record-uuid>          # transcript gone locally
pm2 start ai-session-ingestor
```

With `--apply`, part 1 is posted under the original identity with
`conflict_mode=skip_or_append`: the API keeps the whole text as the record's
previous version (`GET /api/messages/:record_id/history`) and part 1 becomes
current. Later parts are insert-only. Nothing is deleted. A journal is written
under `DATA_DIR/migrations/`.

## Safety contract

This ingestor is insert-only:

- Every message has a deterministic `(source, external_id)` identity.
- The writer requires the Memory Database API to advertise
  `skip_existing` support before sending any message.
- Every POST uses `conflict_mode=skip_existing`.
- Existing identities are returned unchanged even when incoming content or
  metadata differs. No overwrite and no SCD history append occurs.
- The client rejects any `appended` or `overwritten` API response.
- A durable `.data/ingest-state.json` checkpoint avoids unnecessary repeat
  requests. Only confirmed inserts/skips are checkpointed.
- API failures are retried with timeouts; failed messages remain pending.

The required API capability is implemented by the companion changes in the
sibling `memory-database-api` checkout. Until that API version is deployed,
production writes fail closed before the first POST.

## Setup

Requires Node.js 22.5 or newer.

```bash
npm install
cp .env.example .env
npm run build
npm test
```

Configure these values in `.env`:

```dotenv
MEMORY_DATABASE_API_URL=https://your-memory-api.example.com
MEMORY_DATABASE_API_WRITE_TOKEN=...
SENDER_NAME=ET
```

The write token should be limited to these sources:

```text
claudecode,codex,opencode,antigravity,pi
```

All source paths can be overridden; see [.env.example](.env.example).

## CLI

Read-only scan of every source:

```bash
npm run sync -- --dry-run
```

Useful bounded scans:

```bash
npm run sync -- --dry-run --source pi
npm run sync -- --dry-run --source opencode,antigravity --since 7d
npm run sync -- --dry-run --source codex --max-messages 100
npm run sync -- --baseline
```

Use `--baseline` during migration from older ingestors. It records all messages
currently present on the host as seen without sending them to Memory Database;
subsequent automatic syncs send only newly discovered messages.

Write pending messages:

```bash
npm run sync -- --source pi
npm run sync -- --source opencode,antigravity --since 7d
```

`--rescan` ignores local state, but the API still skips every existing identity.
It is intended for verifying server-side idempotency after deployment.

## HTTP service

```bash
npm run build
npm start
```

The service binds to `0.0.0.0:3460` by default and exposes:

- `GET /api/health` — source availability and Memory Database configuration
- `GET /api/status` — checkpoint counts and the previous sync result
- `POST /api/sync` — run a sync with JSON options

Example:

```bash
curl -X POST http://localhost:3460/api/sync \
  -H 'Content-Type: application/json' \
  --data '{"sources":["pi"],"dryRun":true,"maxMessages":10}'
```

Set `INGESTOR_API_TOKEN` to require a Bearer token on `POST /api/sync`.
Set `AUTO_SYNC=true` to sync immediately at startup and then every
`SYNC_INTERVAL_MS` (15 minutes by default).

## Migration from the separate ingestors

1. Deploy the Memory Database API `skip_existing` capability.
2. Give this app a write token restricted to the five source names above.
3. Run a complete dry run and review counts.
4. Backfill Pi, then OpenCode and Antigravity in bounded date windows.
5. Run Claude Code and Codex with `--since` set to the last successful old
   ingestor run. Their source names and external IDs remain compatible.
6. Start this service with `AUTO_SYNC=true`.
7. After one successful scheduled cycle, stop the old Claude and Codex
   ingestors. Do not run both indefinitely.

For a large historical import, work in date windows rather than issuing the
entire backlog in one run. The local full-scan count on the development host is
over 240,000 messages.

## Containers and PM2

The repository includes a production `Dockerfile` and
`ecosystem.config.cjs`. Mount the host session directories read-only and mount
a persistent volume at `/app/.data` for the checkpoint:

```text
~/.claude                         -> /sources/claude:ro
~/.codex                          -> /sources/codex:ro
~/.local/share/opencode           -> /sources/opencode:ro
~/.gemini/antigravity-cli         -> /sources/antigravity:ro
~/.pi/agent                       -> /sources/pi:ro
ai-session-ingestor-state volume  -> /app/.data
```

Point the corresponding `*_DATA_DIR` environment variables at those mounted
paths.

## Local reliability and freshness

Session JSONL is streamed rather than loaded as one string, so multi-gigabyte
logs do not hit Node's string-size limit. Physical line numbering remains stable.
The service persists its last sync result and publishes per-host/per-source
heartbeats to the same Memory API. Warnings remain visible; a successful poll
with no new messages is still reported.

A source whose tool is not installed on a host is skipped quietly: no warning,
no error and no log line each run. If an earlier version published an error
row for it, one clean status (`error_message` null, `metadata.status`
`not_installed`) replaces it once; otherwise nothing is published. A source
that was available on the host and then disappears is reported once, with an
error and a single log warning, and then stays quiet until it returns.
`DATA_DIR/source-availability.json` remembers what was reported.

The connectors/imessage.py collector runs locally on a Mac with read access to
~/Library/Messages/chat.db. It uses message GUIDs for idempotency, durable row
checkpoints, and a dedicated imessage write token. It uploads available original
attachments through the Memory API, ten files per request. An attachment whose
bytes are not on disk is retried with backoff (30 minutes doubling to daily,
`--max-attachment-retries`, default 8, about three days) and then recorded as
unavailable; files over 32 MB are recorded as unavailable at once. A retry sends
nothing unless a missing file has appeared. Missing attachments never hold the
row checkpoint and are not errors: the heartbeat counts them in metadata
(`attachments_missing`, `missing_reasons`, `attachments_recovered`,
`attachments_retry_pending`, `attachments_unavailable_total`) and only write
failures set `error_message`. `~/` attachment paths resolve against the home
that owns chat.db. It does not decode attributed-only bodies; these are
explicitly labeled and counted as `text_unavailable`.

To see why attachments are missing, run the read-only diagnosis on the Mac. It
reads chat.db and the state file and sends nothing:

```bash
python3 connectors/imessage.py --diagnose
```

Run it first with --dry-run, --env pointing to its protected credential file,
and --since set to that account's last archived timestamp. Add --interval 900
for regular polling. The env file contains MEMORY_DATABASE_API_URL and
MEMORY_DATABASE_API_WRITE_TOKEN; protect it with mode 0600.
