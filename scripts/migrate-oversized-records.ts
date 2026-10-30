/**
 * One-off migration for messages that were stored whole before the ingestor
 * split oversized messages (e.g. a ~3.4M-character Claude Code prompt).
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is given, and
 * --apply should only be used with the owner's approval.
 *
 * For each held message (its original identity is in the local checkpoint but
 * it was never split), with --apply:
 *   1. POST part 1 under the ORIGINAL external_id with conflict_mode
 *      skip_or_append. The API retires the whole-text version into the
 *      record's version history (SCD type 2; GET /api/messages/:record_id/history)
 *      and part 1 becomes the current version. Nothing is deleted, and the
 *      search index drops the whole text because only current rows are indexed.
 *   2. POST parts 2..n with skip_existing (insert-only).
 *   3. Mark every part and the split in the local checkpoint, and append a
 *      journal line under DATA_DIR/migrations/.
 * It stops at the first unexpected response.
 *
 * Modes:
 *   local (default)    re-reads local transcripts; covers messages whose
 *                      transcript still exists on this host.
 *   --record <uuid>    reads one stored record from the API (for records whose
 *                      local transcript is gone); repeatable.
 *
 * Stop the ingestor service first (pm2 stop ai-session-ingestor) so the two do
 * not write the checkpoint at the same time.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAdapters } from "../src/adapters/index.js";
import { getApiConfig, request, requireInsertOnlyCapability, toApiPayload, type ApiConfig } from "../src/api-writer.js";
import { envPath, MAX_RECORD_CHARS } from "../src/lib/common.js";
import { heldForMigration, planRecords, type RecordGroup } from "../src/record-plan.js";
import { StateStore } from "../src/state-store.js";
import { SOURCE_IDS, type NormalizedMessage, type SourceAdapter, type SourceId } from "../src/types.js";

export interface MigrationOptions {
  apply: boolean;
  sources?: SourceId[];
  session?: string;
  limit?: number;
  recordIds: string[];
}

export interface GroupOutcome {
  source: SourceId;
  originalExternalId: string;
  originalChars: number;
  parts: number;
  actions?: string[];
  recordIds?: string[];
}

export function parseArgs(args: string[]): MigrationOptions {
  const options: MigrationOptions = { apply: false, recordIds: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--source" || arg === "--sources") {
      const sources = value().split(",").map((item) => item.trim()).filter(Boolean);
      const invalid = sources.filter((item) => !SOURCE_IDS.includes(item as SourceId));
      if (invalid.length) throw new Error(`Unknown sources: ${invalid.join(", ")}`);
      options.sources = sources as SourceId[];
    } else if (arg === "--session") options.session = value();
    else if (arg === "--limit") {
      const limit = Number.parseInt(value(), 10);
      if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit requires a positive integer");
      options.limit = limit;
    } else if (arg === "--record") options.recordIds.push(value());
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run migrate:oversized -- [--apply] [--source ids] [--session id] [--limit n] [--record uuid ...]\nDry run unless --apply. Stop the ingestor service first.");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** Held groups found in local transcripts (the same rule the sync uses). */
export async function findLocalGroups(
  state: StateStore,
  adapters: SourceAdapter[],
  options: Pick<MigrationOptions, "sources" | "session" | "limit">,
): Promise<RecordGroup[]> {
  const groups: RecordGroup[] = [];
  for (const adapter of adapters) {
    if (options.sources?.length && !options.sources.includes(adapter.id)) continue;
    if (!adapter.isAvailable()) continue;
    const scan = await adapter.scan({});
    const seen = new Set<string>();
    for (const message of scan.messages) {
      if (seen.has(message.externalId) || message.content.length <= MAX_RECORD_CHARS) continue;
      seen.add(message.externalId);
      if (options.session && message.metadata.sessionId !== options.session) continue;
      const group = planRecords(message);
      if (heldForMigration(group, state)) groups.push(group);
    }
  }
  groups.sort((a, b) => a.original.timestamp.getTime() - b.original.timestamp.getTime());
  return options.limit ? groups.slice(0, options.limit) : groups;
}

/** Build the source message back from a stored API record. */
export function messageFromRecord(record: Record<string, unknown>): NormalizedMessage {
  const source = String(record.source ?? "");
  if (!SOURCE_IDS.includes(source as SourceId)) throw new Error(`Record source ${source} is not an ingestor source`);
  if (typeof record.external_id !== "string" || !record.external_id) throw new Error("Record has no external_id");
  if (typeof record.content !== "string") throw new Error("Record has no content");
  const timestamp = new Date(String(record.timestamp));
  if (Number.isNaN(timestamp.getTime())) throw new Error("Record has no valid timestamp");
  const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? { ...(record.metadata as Record<string, unknown>) }
    : {};
  return {
    source: source as SourceId,
    externalId: record.external_id,
    timestamp,
    sender: String(record.sender ?? ""),
    recipient: String(record.recipient ?? ""),
    content: record.content,
    metadata,
  };
}

async function post(config: ApiConfig, mode: "skip_or_append" | "skip_existing", message: NormalizedMessage) {
  const response = await request(
    `${config.baseUrl}/api/messages?conflict_mode=${mode}`,
    "POST",
    { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    JSON.stringify(toApiPayload(message)),
    Math.max(1_000, Number.parseInt(process.env.API_TIMEOUT_MS ?? "60000", 10) || 60_000),
  );
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(response.bodyText) as Record<string, unknown>; } catch { /* reported below */ }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.bodyText.slice(0, 300)}`);
  if (body.conflict_mode !== mode) throw new Error(`API did not honor conflict_mode ${mode}`);
  return { action: String(body.action), recordId: typeof body.record_id === "string" ? body.record_id : null };
}

/** Replace one whole record by its parts. Throws on anything unexpected. */
export async function replaceGroup(config: ApiConfig, group: RecordGroup): Promise<GroupOutcome> {
  const [first, ...rest] = group.records;
  if (!first || !group.split) throw new Error(`${group.original.externalId} does not need splitting`);
  const actions: string[] = [];
  const recordIds: string[] = [];
  const head = await post(config, "skip_or_append", first);
  // appended: whole version retired into history; skipped: already migrated;
  // inserted: the whole record was not actually stored.
  if (!["appended", "skipped", "inserted"].includes(head.action)) {
    throw new Error(`${first.externalId}: unexpected action ${head.action}`);
  }
  actions.push(head.action);
  if (head.recordId) recordIds.push(head.recordId);
  for (const part of rest) {
    const result = await post(config, "skip_existing", part);
    if (!["inserted", "skipped"].includes(result.action)) {
      throw new Error(`${part.externalId}: unexpected action ${result.action}`);
    }
    actions.push(result.action);
    if (result.recordId) recordIds.push(result.recordId);
  }
  return {
    source: group.original.source,
    originalExternalId: group.original.externalId,
    originalChars: group.original.content.length,
    parts: group.records.length,
    actions,
    recordIds,
  };
}

async function fetchRecord(config: ApiConfig, recordId: string): Promise<NormalizedMessage> {
  if (!/^[0-9a-f-]{36}$/i.test(recordId)) throw new Error(`Invalid record id ${recordId}`);
  const response = await request(`${config.baseUrl}/api/memory/records/${recordId}`, "GET",
    { Authorization: `Bearer ${config.token}` }, undefined, 60_000);
  if (!response.ok) throw new Error(`Could not read record ${recordId}: HTTP ${response.status}`);
  const body = JSON.parse(response.bodyText) as { record?: Record<string, unknown> };
  if (!body.record) throw new Error(`Record ${recordId} not found`);
  return messageFromRecord(body.record);
}

export async function migrate(
  options: MigrationOptions,
  dependencies: { state?: StateStore; adapters?: SourceAdapter[]; config?: ApiConfig | null; log?: (line: string) => void } = {},
): Promise<GroupOutcome[]> {
  const log = dependencies.log ?? ((line: string) => console.log(line));
  const state = dependencies.state ?? new StateStore();
  await state.load();
  const config = dependencies.config === undefined ? getApiConfig() : dependencies.config;

  let groups: RecordGroup[];
  if (options.recordIds.length) {
    if (!config) throw new Error("--record needs MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_WRITE_TOKEN");
    groups = [];
    for (const recordId of options.recordIds) {
      const group = planRecords(await fetchRecord(config, recordId));
      if (!group.split) log(JSON.stringify({ record: recordId, skipped: "not oversized" }));
      else groups.push(group);
    }
  } else {
    groups = await findLocalGroups(state, dependencies.adapters ?? createAdapters(), options);
  }

  const outcomes: GroupOutcome[] = [];
  if (!options.apply) {
    for (const group of groups) {
      const outcome: GroupOutcome = {
        source: group.original.source,
        originalExternalId: group.original.externalId,
        originalChars: group.original.content.length,
        parts: group.records.length,
      };
      outcomes.push(outcome);
      log(JSON.stringify({ dryRun: true, ...outcome, sessionId: group.original.metadata.sessionId ?? null }));
    }
    log(JSON.stringify({ dryRun: true, records: groups.length, parts: groups.reduce((n, g) => n + g.records.length, 0) }));
    return outcomes;
  }

  if (!config) throw new Error("--apply needs MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_WRITE_TOKEN");
  await requireInsertOnlyCapability(config);
  const journalDir = path.join(envPath("DATA_DIR", ".data"), "migrations");
  await fs.mkdir(journalDir, { recursive: true });
  const journal = path.join(journalDir, `oversized-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  for (const group of groups) {
    const outcome = await replaceGroup(config, group);
    for (const record of group.records) state.mark(record.source, record.externalId);
    state.markSplit(group.original.source, group.original.externalId);
    await state.save();
    await fs.appendFile(journal, `${JSON.stringify({ at: new Date().toISOString(), ...outcome })}\n`, { mode: 0o600 });
    outcomes.push(outcome);
    log(JSON.stringify(outcome));
  }
  log(JSON.stringify({ applied: true, records: outcomes.length, journal }));
  return outcomes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve().then(() => migrate(parseArgs(process.argv.slice(2)))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
