import { createAdapters } from "./adapters/index.js";
import { writeMessages } from "./api-writer.js";
import { heldForMigration, planRecords } from "./record-plan.js";
import { StateStore } from "./state-store.js";
import type {
  NormalizedMessage,
  SourceAdapter,
  SourceSyncResult,
  SyncOptions,
  SyncResult,
} from "./types.js";

export interface SyncDependencies {
  adapters?: SourceAdapter[];
  state?: StateStore;
  writer?: typeof writeMessages;
}

function uniqueMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const byIdentity = new Map<string, NormalizedMessage>();
  for (const message of messages) {
    byIdentity.set(`${message.source}\0${message.externalId}`, message);
  }
  return [...byIdentity.values()];
}

function emptyResult(source: SourceAdapter, available: boolean): SourceSyncResult {
  return {
    source: source.id,
    available,
    sessions: 0,
    discovered: 0,
    pending: 0,
    baselined: 0,
    inserted: 0,
    skipped: 0,
    appended: 0,
    failed: 0,
    heldForMigration: 0,
    warnings: [],
  };
}

const TOOL_EVENTS_SETTING = "claudecode.toolEventsSince";

/**
 * CLAUDECODE_TOOL_EVENTS controls tool call/result records:
 *   new (default) - only events after this version's first non-dry-run sync
 *   all           - every event in local transcripts (large one-off backfill)
 *   <ISO date>    - events at or after that date
 *   off           - none
 */
export async function resolveToolEventsSince(
  state: StateStore,
  startedAt: string,
  dryRun: boolean,
): Promise<number | undefined> {
  const raw = process.env.CLAUDECODE_TOOL_EVENTS?.trim() || "new";
  const mode = raw.toLowerCase();
  if (["off", "false", "0", "none"].includes(mode)) return undefined;
  if (["all", "true"].includes(mode)) return 0;
  if (mode !== "new") {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) throw new Error(`Invalid CLAUDECODE_TOOL_EVENTS value: ${raw}`);
    return parsed;
  }
  const stored = state.getSetting(TOOL_EVENTS_SETTING);
  if (stored && !Number.isNaN(Date.parse(stored))) return Date.parse(stored);
  if (!dryRun) {
    state.setSetting(TOOL_EVENTS_SETTING, startedAt);
    await state.save();
  }
  return Date.parse(startedAt);
}

export async function runSync(
  options: SyncOptions = {},
  dependencies: SyncDependencies = {},
): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const adapters = dependencies.adapters ?? createAdapters();
  const state = dependencies.state ?? new StateStore();
  const writer = dependencies.writer ?? writeMessages;
  await state.load();

  const selected = options.sources?.length
    ? adapters.filter((adapter) => options.sources?.includes(adapter.id))
    : adapters;
  const sourceResults: SourceSyncResult[] = [];

  let toolEventsSinceMs: number | undefined;
  let toolEventsError: string | null = null;
  try {
    toolEventsSinceMs = await resolveToolEventsSince(state, startedAt, options.dryRun ?? false);
  } catch (error) {
    toolEventsError = error instanceof Error ? error.message : String(error);
  }

  for (const adapter of selected) {
    const available = adapter.isAvailable();
    const result = emptyResult(adapter, available);
    if (!available) {
      // A tool that is not installed on this host is not a problem. The
      // freshness report decides whether anything is published for it.
      sourceResults.push(result);
      continue;
    }
    if (toolEventsError && adapter.id === "claudecode") result.warnings.push(toolEventsError);

    try {
      const scan = await adapter.scan({
        sinceMs: options.sinceMs,
        maxMessages: options.maxMessages,
        toolEventsSinceMs,
      });
      const records: NormalizedMessage[] = [];
      const newlySplit: NormalizedMessage[] = [];
      for (const group of uniqueMessages(scan.messages).map((message) => planRecords(message))) {
        if (heldForMigration(group, state)) {
          result.heldForMigration += 1;
          continue;
        }
        if (group.split) newlySplit.push(group.original);
        records.push(...group.records);
      }
      const pending = options.rescan
        ? records
        : records.filter((message) => !state.has(message.source, message.externalId));
      result.sessions = scan.sessions;
      result.discovered = records.length;
      result.warnings.push(...scan.warnings);
      if (!options.dryRun) {
        for (const message of newlySplit) state.markSplit(message.source, message.externalId);
      }

      if (options.baseline) {
        if (options.dryRun) {
          result.baselined = pending.length;
        } else {
          for (const message of pending) {
            state.mark(message.source, message.externalId);
          }
          result.baselined = pending.length;
          await state.save();
        }
        sourceResults.push(result);
        continue;
      }

      result.pending = pending.length;

      if (!options.dryRun && pending.length > 0) {
        const writes = await writer(pending);
        for (const success of writes.successful) {
          result[success.action] += 1;
          state.mark(success.message.source, success.message.externalId);
        }
        result.failed = writes.failed.length;
        result.warnings.push(
          ...writes.failed.slice(0, 20).map((failure) =>
            `${failure.message.externalId}: ${failure.error}`,
          ),
        );
        await state.save();
      }
    } catch (error) {
      result.failed += 1;
      result.warnings.push(error instanceof Error ? error.message : String(error));
    }
    sourceResults.push(result);
  }

  const totals = sourceResults.reduce(
    (sum, result) => ({
      sessions: sum.sessions + result.sessions,
      discovered: sum.discovered + result.discovered,
      pending: sum.pending + result.pending,
      baselined: sum.baselined + result.baselined,
      inserted: sum.inserted + result.inserted,
      skipped: sum.skipped + result.skipped,
      appended: sum.appended + result.appended,
      failed: sum.failed + result.failed,
      heldForMigration: sum.heldForMigration + result.heldForMigration,
    }),
    { sessions: 0, discovered: 0, pending: 0, baselined: 0, inserted: 0, skipped: 0, appended: 0, failed: 0, heldForMigration: 0 },
  );

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: options.dryRun ?? false,
    sources: sourceResults,
    totals,
  };
}
