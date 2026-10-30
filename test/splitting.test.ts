import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/index.js";
import { toApiPayload, type ApiConfig } from "../src/api-writer.js";
import { capText, MAX_RECORD_CHARS, splitContent, TOOL_OUTPUT_MAX_CHARS } from "../src/lib/common.js";
import { planRecords } from "../src/record-plan.js";
import { StateStore } from "../src/state-store.js";
import { resolveToolEventsSince, runSync } from "../src/sync.js";
import type { BatchWriteResult, NormalizedMessage, SourceAdapter } from "../src/types.js";
import { migrate } from "../scripts/migrate-oversized-records.js";

let root: string;
let server: http.Server | null = null;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-ingestor-split-"));
  process.env.SENDER_NAME = "Tester";
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.SENDER_NAME;
  delete process.env.CLAUDECODE_TOOL_EVENTS;
});

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function message(id: string, content: string): NormalizedMessage {
  return {
    source: "claudecode",
    externalId: id,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    sender: "Tester",
    recipient: "Claude",
    content,
    metadata: { sessionId: "s", role: "human" },
  };
}

function fakeAdapter(messages: () => NormalizedMessage[]): SourceAdapter {
  return {
    id: "claudecode",
    displayName: "Claude Code",
    rootPath: root,
    isAvailable: () => true,
    scan: async () => ({ source: "claudecode", sessions: 1, messages: messages(), warnings: [] }),
  };
}

function recordingWriter(log: string[], failIds: Set<string> = new Set()) {
  return async (messages: NormalizedMessage[]): Promise<BatchWriteResult> => {
    const result: BatchWriteResult = { successful: [], failed: [] };
    for (const item of messages) {
      if (failIds.has(item.externalId)) result.failed.push({ message: item, error: "offline" });
      else {
        log.push(item.externalId);
        result.successful.push({ message: item, action: "inserted" });
      }
    }
    return result;
  };
}

describe("content splitting", () => {
  it("splits deterministically into bounded parts that rejoin exactly", () => {
    const text = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(i % 50)}`).join("\n");
    const parts = splitContent(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => part.length <= 1000)).toBe(true);
    expect(parts.slice(0, -1).every((part) => part.endsWith("\n"))).toBe(true);
    expect(splitContent(text, 1000)).toEqual(parts);
  });

  it("never separates a surrogate pair and leaves small text alone", () => {
    const text = "a" + "😀".repeat(10);
    const parts = splitContent(text, 4);
    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(() => encodeURIComponent(part)).not.toThrow();
    expect(splitContent("short", 10)).toEqual(["short"]);
  });

  it("caps tool output and says how much was kept", () => {
    const capped = capText("y".repeat(TOOL_OUTPUT_MAX_CHARS + 500));
    expect(capped.truncated).toBe(true);
    expect(capped.originalChars).toBe(TOOL_OUTPUT_MAX_CHARS + 500);
    expect(capped.text).toMatch(/\[truncated: 16000 of 16500 characters kept\]$/);
  });

  it("keeps the original identity for part 1 and orders later parts", () => {
    const group = planRecords(message("s:u1", "z".repeat(MAX_RECORD_CHARS * 2 + 10)));
    expect(group.split).toBe(true);
    expect(group.records.map((record) => record.externalId)).toEqual(["s:u1", "s:u1:part:2", "s:u1:part:3"]);
    expect(group.records.map((record) => record.timestamp.getTime() - group.original.timestamp.getTime())).toEqual([0, 1, 2]);
    expect(group.records[2]?.metadata).toMatchObject({ part: 3, parts: 3, partOf: "s:u1", originalChars: MAX_RECORD_CHARS * 2 + 10, role: "human" });
    expect(planRecords(message("s:u2", "small")).records).toHaveLength(1);
  });
});

describe("Claude Code per-message records", () => {
  const rows = [
    { type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "run ls" } },
    { type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", model: "m", content: [{ type: "text", text: "Listing." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", uuid: "r1", sessionId: "s1", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a.txt" }], is_error: false }] } },
    { type: "user", uuid: "r2", sessionId: "s1", timestamp: "2026-01-01T00:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "e".repeat(TOOL_OUTPUT_MAX_CHARS + 1), is_error: true }] } },
  ];

  it("emits tool calls and results as separate tool_output records when enabled", async () => {
    const dir = path.join(root, "claude");
    await writeJsonl(path.join(dir, "projects", "p", "s1.jsonl"), rows);
    const result = await new ClaudeCodeAdapter(dir).scan({ toolEventsSinceMs: 0 });
    expect(result.messages.map((m) => m.externalId)).toEqual([
      "s1:u1", "s1:a1", "s1:a1:tool_use:toolu_1", "s1:r1:tool_result:toolu_1", "s1:r2:tool_result:toolu_2",
    ]);
    const call = result.messages[2]!;
    expect(call).toMatchObject({ sender: "Claude", recipient: "tool:Bash" });
    expect(call.content).toContain('"command": "ls"');
    expect(call.metadata).toMatchObject({ role: "tool", kind: "tool_output", toolEvent: "call", toolName: "Bash", model: "m" });
    expect(result.messages[3]).toMatchObject({ sender: "tool:Bash", content: "a.txt" });
    expect(result.messages[4]?.metadata).toMatchObject({ toolEvent: "result", toolName: "unknown", isError: true, truncated: true });
    expect(toApiPayload(call).metadata).toMatchObject({ kind: "tool_output", conversation_id: "s1" });
    expect(toApiPayload(result.messages[1]!).metadata).toMatchObject({ kind: "assistant_message" });
  });

  it("leaves tool events out when disabled or older than the cutoff", async () => {
    const dir = path.join(root, "claude");
    await writeJsonl(path.join(dir, "projects", "p", "s1.jsonl"), rows);
    const off = await new ClaudeCodeAdapter(dir).scan();
    expect(off.messages.map((m) => m.externalId)).toEqual(["s1:u1", "s1:a1"]);
    const late = await new ClaudeCodeAdapter(dir).scan({ toolEventsSinceMs: Date.parse("2026-01-01T00:00:02Z") });
    expect(late.messages.map((m) => m.externalId)).toEqual(["s1:u1", "s1:a1", "s1:r1:tool_result:toolu_1", "s1:r2:tool_result:toolu_2"]);
    expect(late.messages[2]?.sender).toBe("tool:Bash");
  });
});

describe("tool event cutoff", () => {
  it("defaults to the first real sync and persists it", async () => {
    const state = new StateStore(path.join(root, "state.json"));
    expect(await resolveToolEventsSince(state, "2026-02-01T00:00:00.000Z", true)).toBe(Date.parse("2026-02-01T00:00:00Z"));
    expect(state.getSetting("claudecode.toolEventsSince")).toBeUndefined();
    await resolveToolEventsSince(state, "2026-02-02T00:00:00.000Z", false);
    const reloaded = new StateStore(path.join(root, "state.json"));
    await reloaded.load();
    expect(await resolveToolEventsSince(reloaded, "2026-03-01T00:00:00.000Z", false)).toBe(Date.parse("2026-02-02T00:00:00Z"));
  });

  it("accepts off, all and a date, and rejects nonsense", async () => {
    const state = new StateStore(path.join(root, "state.json"));
    process.env.CLAUDECODE_TOOL_EVENTS = "off";
    expect(await resolveToolEventsSince(state, "2026-02-01T00:00:00Z", false)).toBeUndefined();
    process.env.CLAUDECODE_TOOL_EVENTS = "all";
    expect(await resolveToolEventsSince(state, "2026-02-01T00:00:00Z", false)).toBe(0);
    process.env.CLAUDECODE_TOOL_EVENTS = "2026-01-15";
    expect(await resolveToolEventsSince(state, "2026-02-01T00:00:00Z", false)).toBe(Date.parse("2026-01-15"));
    process.env.CLAUDECODE_TOOL_EVENTS = "soon";
    await expect(resolveToolEventsSince(state, "2026-02-01T00:00:00Z", false)).rejects.toThrow(/Invalid/);
  });
});

describe("sync of oversized and growing sessions", () => {
  it("writes parts once, is idempotent, and only adds appended messages", async () => {
    const big = message("s:big", "b".repeat(MAX_RECORD_CHARS + 5));
    let messages = [message("s:1", "hi"), big];
    const writes: string[] = [];
    const state = new StateStore(path.join(root, "state.json"));
    const deps = { adapters: [fakeAdapter(() => messages)], state, writer: recordingWriter(writes) };

    await runSync({}, deps);
    expect(writes).toEqual(["s:1", "s:big", "s:big:part:2"]);
    const again = await runSync({}, deps);
    expect(again.totals.pending).toBe(0);
    messages = [...messages, message("s:2", "next")];
    await runSync({}, deps);
    expect(writes.slice(3)).toEqual(["s:2"]);
  });

  it("holds the parts of a message already stored whole, until it is migrated", async () => {
    const state = new StateStore(path.join(root, "state.json"));
    state.mark("claudecode", "s:big"); // confirmed whole by an earlier version
    await state.save();
    const writes: string[] = [];
    const big = message("s:big", "b".repeat(MAX_RECORD_CHARS + 5));
    const result = await runSync({}, { adapters: [fakeAdapter(() => [big])], state, writer: recordingWriter(writes) });
    expect(writes).toEqual([]);
    expect(result.sources[0]).toMatchObject({ heldForMigration: 1, pending: 0, warnings: [] });
    const rescan = await runSync({ rescan: true }, { adapters: [fakeAdapter(() => [big])], state, writer: recordingWriter(writes) });
    expect(rescan.totals.heldForMigration).toBe(1);
    expect(writes).toEqual([]);
  });

  it("retries a failed part of a newly split message instead of holding it", async () => {
    const state = new StateStore(path.join(root, "state.json"));
    const writes: string[] = [];
    const big = message("s:big", "b".repeat(MAX_RECORD_CHARS * 2 + 5));
    await runSync({}, { adapters: [fakeAdapter(() => [big])], state, writer: recordingWriter(writes, new Set(["s:big:part:2"])) });
    const next = await runSync({}, { adapters: [fakeAdapter(() => [big])], state, writer: recordingWriter(writes) });
    expect(next.totals.heldForMigration).toBe(0);
    expect(writes).toEqual(["s:big", "s:big:part:3", "s:big:part:2"]);
  });
});

describe("oversized-record migration script", () => {
  async function startApi(): Promise<{ config: ApiConfig; posts: Array<{ url: string; body: Record<string, unknown> }> }> {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    server = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/api/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ capabilities: { message_conflict_modes: ["skip_existing", "skip_or_append"] } }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        posts.push({ url: request.url ?? "", body });
        const mode = new URL(request.url ?? "", "http://x").searchParams.get("conflict_mode");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          record_id: `rec-${posts.length}`,
          action: mode === "skip_or_append" ? "appended" : "inserted",
          conflict_mode: mode,
        }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return { config: { baseUrl: `http://127.0.0.1:${address.port}`, token: "t", concurrency: 1 }, posts };
  }

  it("dry-runs by default with no network, and applies only with --apply", async () => {
    process.env.DATA_DIR = root;
    try {
      const statePath = path.join(root, "state.json");
      const seed = new StateStore(statePath);
      seed.mark("claudecode", "s:big");
      seed.mark("claudecode", "s:small");
      await seed.save();
      const big = message("s:big", "b".repeat(MAX_RECORD_CHARS + 5));
      const adapters = [fakeAdapter(() => [message("s:small", "hi"), big])];
      const log: string[] = [];

      const dry = await migrate({ apply: false, recordIds: [] }, { state: new StateStore(statePath), adapters, config: null, log: (line) => log.push(line) });
      expect(dry).toEqual([{ source: "claudecode", originalExternalId: "s:big", originalChars: MAX_RECORD_CHARS + 5, parts: 2 }]);

      const { config, posts } = await startApi();
      const applied = await migrate({ apply: true, recordIds: [] }, { state: new StateStore(statePath), adapters, config, log: () => {} });
      expect(applied[0]?.actions).toEqual(["appended", "inserted"]);
      expect(posts.map((post) => [post.url, post.body.external_id])).toEqual([
        ["/api/messages?conflict_mode=skip_or_append", "s:big"],
        ["/api/messages?conflict_mode=skip_existing", "s:big:part:2"],
      ]);
      expect(posts[0]?.body.metadata).toMatchObject({ part: 1, parts: 2, partOf: "s:big" });
      const journals = await fs.readdir(path.join(root, "migrations"));
      expect(journals).toHaveLength(1);

      const writes: string[] = [];
      const after = await runSync({}, { adapters, state: new StateStore(statePath), writer: recordingWriter(writes) });
      expect(after.totals).toMatchObject({ heldForMigration: 0, pending: 0 });
      expect(await migrate({ apply: false, recordIds: [] }, { state: new StateStore(statePath), adapters, config: null, log: () => {} })).toEqual([]);
    } finally {
      delete process.env.DATA_DIR;
    }
  });
});
