import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EtbotAdapter } from "../src/adapters/index.js";

let tempRoot: string;
const saved = { ...process.env };

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-ingestor-etbot-"));
  process.env.SENDER_NAME = "Tester";
  delete process.env.ETBOT_IMPORTED;
  delete process.env.ETBOT_TOOL_EVENTS;
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  process.env = { ...saved };
});

function writeWorkspace(workspace: unknown): string {
  const databasePath = path.join(tempRoot, "etbot.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,json TEXT NOT NULL)");
  db.prepare("INSERT OR REPLACE INTO workspace(id,revision,json) VALUES(1,1,?)").run(JSON.stringify(workspace));
  db.close();
  return databasePath;
}

const imported = {
  source: "claude-duet-sessions",
  record_id: "f59d4e5f-e646-4b7b-8339-f394f6d71710",
  external_id: "duet:cmsg_1",
  timestamp: "2026-10-29T12:06:37Z",
  channel_id: "chan_1",
  thread_root: null,
};

const workspace = {
  channels: [
    {
      id: "c-everything",
      name: "Everything",
      messages: [
        { id: "duet:message:cmsg_1", imported, role: "user", text: "already archived", ts: 1000 },
        { id: "m1", role: "user", text: "hello", ts: 2000 },
        { id: "m2", role: "assistant", text: "hi there", ts: 2000, note: "Model: claude-opus-5-5, medium effort", actions: ["Created task “Ship it”"] },
        { id: "m3", role: "system", text: "Claude made this channel.", ts: 2001 },
        { id: "m4", role: "assistant", text: "still typ", ts: 2002, streaming: true },
        { id: "m5", role: "assistant", text: "", ts: 2003 },
      ],
      threads: [],
    },
    {
      id: "c-dev",
      name: "dev",
      archived: true,
      group: "Work",
      messages: [
        { id: "m6", role: "user", text: "", ts: 3000, attachments: [{ id: "a1", name: "shot.png", mime: "image/png", bytes: 12, data: "", storage_key: "abc" }] },
      ],
      threads: [
        {
          id: "th1",
          root_message_id: "m6",
          title: "Fix the build",
          task_id: "t1",
          messages: [
            { id: "m7", role: "user", label: "Brief", text: "ET wants the build fixed.", ts: 3001 },
            { id: "m8", role: "user", label: "Schedule", text: "Check whether CI passed.", ts: 3002 },
            { id: "m9", role: "assistant", text: "Ran it.", ts: 3003, shell: [{ command: "make", output: "ok\n", code: 0, isolated: true }] },
          ],
        },
      ],
    },
  ],
  tasks: [{ id: "t1", channel_id: "c-dev", title: "Fix the build", state: "Working", steps: [], updated: 3003, thread_id: "th1" }],
};

describe("ETBot adapter", () => {
  it("reads channels, side threads and task threads with stable identities", async () => {
    const result = await new EtbotAdapter(tempRoot, writeWorkspace(workspace)).scan();
    expect(result.warnings).toEqual([]);
    expect(result.sessions).toBe(3);
    expect(result.messages.map((message) => message.externalId)).toEqual([
      "etbot:m1",
      "etbot:m2",
      "etbot:m6",
      "etbot:m7",
      "etbot:m8",
      "etbot:m9",
      "etbot:m9:shell:0",
    ]);

    const [hello, reply, attachment, brief, schedule, ran, shell] = result.messages;
    // The reply shares its question's second and sorts after it.
    expect(reply!.timestamp.getTime() - hello!.timestamp.getTime()).toBe(1);
    expect(hello).toMatchObject({ sender: "Tester", recipient: "ETBot", content: "hello" });
    expect(reply).toMatchObject({ sender: "ETBot", recipient: "Tester" });
    expect(reply!.metadata).toMatchObject({
      sessionId: "etbot:c-everything",
      conversationTitle: "ETBot · Everything",
      role: "assistant",
      model: "claude-opus-5-5",
      actions: ["Created task “Ship it”"],
    });
    expect(attachment!.content).toBe("[Attachment: shot.png]");
    expect(attachment!.metadata).toMatchObject({
      conversationTitle: "ETBot · dev",
      channelGroup: "Work",
      attachments: [{ id: "a1", name: "shot.png", mime: "image/png", bytes: 12, storageKey: "abc" }],
    });
    expect(brief).toMatchObject({ sender: "ETBot", recipient: "ETBot" });
    expect(brief!.metadata).toMatchObject({
      sessionId: "etbot:c-dev:th1",
      conversationTitle: "ETBot · dev · Fix the build",
      threadRootId: "m6",
      taskId: "t1",
      taskTitle: "Fix the build",
      label: "Brief",
    });
    expect(brief!.metadata.kind).toBeUndefined();
    expect(schedule).toMatchObject({ sender: "ETBot Schedule" });
    expect(schedule!.metadata.kind).toBe("injected_instructions");
    expect(ran!.content).toBe("Ran it.");
    expect(shell!.content).toBe("$ make\nok\n");
    expect(shell!.metadata).toMatchObject({ role: "tool", kind: "tool_output", toolName: "shell", exitCode: 0, isError: false });
  });

  it("includes messages imported from Duet only when asked", async () => {
    const databasePath = writeWorkspace(workspace);
    process.env.ETBOT_IMPORTED = "include";
    process.env.ETBOT_TOOL_EVENTS = "off";
    const result = await new EtbotAdapter(tempRoot, databasePath).scan();
    const ids = result.messages.map((message) => message.externalId);
    expect(ids[0]).toBe("etbot:duet:message:cmsg_1");
    expect(result.messages[0]!.metadata.importedFrom).toEqual({
      source: "claude-duet-sessions",
      recordId: "f59d4e5f-e646-4b7b-8339-f394f6d71710",
      externalId: "duet:cmsg_1",
    });
    expect(ids).not.toContain("etbot:m9:shell:0");
  });

  it("applies since and reports nothing when ETBot is not installed", async () => {
    const databasePath = writeWorkspace(workspace);
    const recent = await new EtbotAdapter(tempRoot, databasePath).scan({ sinceMs: 3001_000 });
    expect(recent.messages.map((message) => message.externalId)).toEqual([
      "etbot:m7",
      "etbot:m8",
      "etbot:m9",
      "etbot:m9:shell:0",
    ]);

    const missing = new EtbotAdapter(path.join(tempRoot, "none"));
    expect(missing.isAvailable()).toBe(false);
    expect(await missing.scan()).toEqual({ source: "etbot", sessions: 0, messages: [], warnings: [] });
  });
});
