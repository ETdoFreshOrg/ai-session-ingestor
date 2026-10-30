import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/state-store.js";
import { runSync } from "../src/sync.js";
import { saveAndReportSync } from "../src/sync-report.js";
import type { SourceAdapter, SourceSyncResult, SyncResult } from "../src/types.js";

let root: string;
let server: http.Server | null = null;
let rows: Map<string, Record<string, unknown>>;
let calls: Array<{ method: string; key: string; body?: Record<string, unknown> }>;
const saved = { ...process.env };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-ingestor-report-"));
  rows = new Map();
  calls = [];
  server = http.createServer((request, response) => {
    const key = decodeURIComponent((request.url ?? "").replace("/api/sync-state/", ""));
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : undefined;
      calls.push({ method: request.method ?? "", key, body });
      if (request.method === "GET") {
        const row = rows.get(key);
        response.writeHead(row ? 200 : 404, { "Content-Type": "application/json" });
        response.end(JSON.stringify(row ?? { error: "Not found" }));
        return;
      }
      rows.set(key, { ...(rows.get(key) ?? {}), ...body });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(rows.get(key)));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  process.env.MEMORY_DATABASE_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.MEMORY_DATABASE_API_WRITE_TOKEN = "t";
  process.env.DATA_DIR = root;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  process.env = { ...saved };
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function sourceResult(source: SourceSyncResult["source"], available: boolean): SourceSyncResult {
  return { source, available, sessions: 0, discovered: 0, pending: 0, baselined: 0, inserted: 0, skipped: 0, appended: 0, failed: 0, heldForMigration: 0, warnings: [] };
}

function syncResult(...sources: SourceSyncResult[]): SyncResult {
  const now = new Date().toISOString();
  return { startedAt: now, finishedAt: now, dryRun: false, sources, totals: { sessions: 0, discovered: 0, pending: 0, baselined: 0, inserted: 0, skipped: 0, appended: 0, failed: 0, heldForMigration: 0 } };
}

const key = (source: string) => `ai-session:${os.hostname()}:${source}`;

describe("unavailable sources", () => {
  it("adds no warning to the sync result", async () => {
    const adapter: SourceAdapter = {
      id: "antigravity", displayName: "Antigravity", rootPath: "/nowhere",
      isAvailable: () => false,
      scan: async () => { throw new Error("must not scan"); },
    };
    const result = await runSync({}, { adapters: [adapter], state: new StateStore(path.join(root, "s.json")), writer: async () => ({ successful: [], failed: [] }) });
    expect(result.sources[0]).toMatchObject({ available: false, warnings: [], failed: 0 });
  });

  it("publishes nothing for a tool never installed here, and asks only once", async () => {
    await saveAndReportSync(syncResult(sourceResult("pi", false)));
    await saveAndReportSync(syncResult(sourceResult("pi", false)));
    expect(calls).toEqual([{ method: "GET", key: key("pi"), body: undefined }]);
  });

  it("clears an old 'Source unavailable' error once, then stays quiet", async () => {
    rows.set(key("antigravity"), { error_message: "Source unavailable on this host", metadata: { available: false } });
    await saveAndReportSync(syncResult(sourceResult("antigravity", false)));
    await saveAndReportSync(syncResult(sourceResult("antigravity", false)));
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]?.body).toMatchObject({ error_message: null, metadata: { available: false, status: "not_installed" } });
    expect(calls[1]?.body).not.toHaveProperty("last_sync_date");
  });

  it("warns exactly once when a source that worked here disappears, and recovers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await saveAndReportSync(syncResult(sourceResult("codex", true)));
    await saveAndReportSync(syncResult(sourceResult("codex", false)));
    await saveAndReportSync(syncResult(sourceResult("codex", false)));
    expect(calls.map((call) => call.method)).toEqual(["PUT", "PUT"]);
    expect(String(calls[1]?.body?.error_message)).toMatch(/no longer found on this host/);
    expect(calls[1]?.body?.metadata).toMatchObject({ status: "missing", available: false });
    expect(warn).toHaveBeenCalledTimes(1);

    await saveAndReportSync(syncResult(sourceResult("codex", true)));
    expect(calls[2]?.body).toMatchObject({ error_message: null, metadata: { available: true } });
    expect(calls[2]?.body).toHaveProperty("last_sync_date");
  });

  it("treats a row an earlier version marked available as a disappeared source", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rows.set(key("opencode"), { last_sync_date: "2026-10-01T00:00:00.000Z", metadata: { available: true } });
    await saveAndReportSync(syncResult(sourceResult("opencode", false)));
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]?.body?.metadata).toMatchObject({ status: "missing", last_available_at: "2026-10-01T00:00:00.000Z" });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
