import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { envPath } from './lib/common.js';
import { getApiConfig, request } from './api-writer.js';
import type { SourceSyncResult, SyncResult } from './types.js';

/**
 * Per-source availability seen on this host, kept beside the checkpoint.
 * `reported` means the unavailable state was already published once; the
 * ingestor then stays silent for that source until it becomes available.
 */
interface AvailabilityRecord {
  lastAvailableAt?: string;
  reported?: 'not_installed' | 'missing';
}
type AvailabilityState = Record<string, AvailabilityRecord>;

const AVAILABILITY_FILE = 'source-availability.json';

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return fallback; }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function stateKey(source: string): string {
  return `ai-session:${os.hostname()}:${source}`;
}

function availableError(source: SourceSyncResult): string | null {
  return source.failed > 0 ? `${source.failed} records failed`
    : source.warnings.length ? 'Scan completed with warnings' : null;
}

export async function saveAndReportSync(result: SyncResult): Promise<void> {
  const directory = envPath('DATA_DIR', '.data');
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomic(path.join(directory, 'last-sync.json'), result);
  const config = getApiConfig();
  if (!config || result.dryRun) return;

  const availabilityFile = path.join(directory, AVAILABILITY_FILE);
  const availability = await readJson<AvailabilityState>(availabilityFile, {});
  const auth = { Authorization: `Bearer ${config.token}` };
  const put = (key: string, body: Record<string, unknown>) => request(
    `${config.baseUrl}/api/sync-state/${encodeURIComponent(key)}`, 'PUT',
    { 'Content-Type': 'application/json', ...auth }, JSON.stringify(body), 15000);

  for (const source of result.sources) {
    const key = stateKey(source.source);
    const record: AvailabilityRecord = availability[source.source] ?? {};
    availability[source.source] = record;

    if (source.available) {
      record.lastAvailableAt = result.finishedAt;
      delete record.reported;
      const error = availableError(source);
      const response = await put(key, {
        source: source.source, last_run_at: result.finishedAt,
        ...(!error ? { last_sync_date: result.finishedAt } : {}), error_message: error,
        metadata: { hostname: os.hostname(), ingestor: 'ai-session-ingestor', started_at: result.startedAt,
          finished_at: result.finishedAt, available: true, discovered: source.discovered,
          pending: source.pending, inserted: source.inserted, skipped: source.skipped, failed: source.failed,
          held_for_migration: source.heldForMigration,
          warning_count: source.warnings.length, warnings: source.warnings.slice(0, 5) },
      }).catch((failure: unknown) => ({ ok: false, status: String(failure) }));
      if (!response.ok) console.error(`[ai-session-ingestor] Could not report ${source.source} freshness: HTTP ${response.status}`);
      continue;
    }

    // Unavailable. Report it at most once, then stay quiet every run.
    if (record.reported) continue;
    let lastAvailable = record.lastAvailableAt ?? null;
    if (!lastAvailable) {
      // Never seen here by this version: look at what an earlier version
      // published, so a stale error row can be cleared (or a source that did
      // work here before is flagged once). No row means nothing to publish.
      const existing = await request(`${config.baseUrl}/api/sync-state/${encodeURIComponent(key)}`, 'GET', auth, undefined, 15000)
        .catch(() => null);
      if (!existing) continue; // Network trouble: try again next run, quietly.
      if (existing.status === 404) { record.reported = 'not_installed'; continue; }
      if (!existing.ok) continue;
      let row: { metadata?: { available?: unknown } | null; last_sync_date?: unknown } = {};
      try { row = JSON.parse(existing.bodyText); } catch { /* treat as unknown */ }
      if (row.metadata?.available === true) {
        lastAvailable = typeof row.last_sync_date === 'string' ? row.last_sync_date : 'unknown';
      }
    }

    const base = { hostname: os.hostname(), ingestor: 'ai-session-ingestor', available: false, checked_at: result.finishedAt };
    if (lastAvailable) {
      // It worked on this host before and has gone: worth exactly one warning.
      const message = `Source data no longer found on this host (last available ${lastAvailable})`;
      const response = await put(key, { source: source.source, error_message: message,
        metadata: { ...base, status: 'missing', last_available_at: lastAvailable } }).catch(() => null);
      if (response?.ok) {
        record.reported = 'missing';
        console.warn(`[ai-session-ingestor] ${source.source}: ${message}. Reported once; quiet until it returns.`);
      }
    } else {
      // Not installed here: publish a clean status (clears an earlier
      // "Source unavailable on this host" error) and never repeat it.
      const response = await put(key, { source: source.source, error_message: null,
        metadata: { ...base, status: 'not_installed' } }).catch(() => null);
      if (response?.ok) record.reported = 'not_installed';
    }
  }

  await writeJsonAtomic(availabilityFile, availability);
}

export async function readLastSync(): Promise<SyncResult|null> {
  try { return JSON.parse(await fs.readFile(path.join(envPath('DATA_DIR','.data'),'last-sync.json'),'utf8')); }
  catch { return null; }
}
