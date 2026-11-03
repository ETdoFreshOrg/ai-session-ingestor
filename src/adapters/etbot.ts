import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyMessageLimit,
  capText,
  envPath,
  hostname,
  isAfter,
  stringValue,
  userName,
} from "../lib/common.js";
import type { NormalizedMessage, ScanOptions, ScanResult, SourceAdapter } from "../types.js";

/**
 * ETBot (github.com/ETdoFreshOrg/duet-rust) keeps its whole workspace as one
 * JSON document in etbot.sqlite: channels with their messages and side
 * threads, and tasks whose conversations are threads. The database is opened
 * read-only; nothing in ETBot changes.
 */

type Json = Record<string, unknown>;

/** The global conversation, stored as a channel (duet-rust EVERYTHING_ID). */
const EVERYTHING_ID = "c-everything";
const BOT = "ETBot";

interface Conversation {
  id: string;
  title: string;
  channel: Json;
  thread: Json | null;
  task: Json | null;
}

function defaultDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".local", "share"), "etbot");
}

function objects(value: unknown): Json[] {
  return Array.isArray(value)
    ? value.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** "Model: claude-opus-5-5, medium effort" -> "claude-opus-5-5". */
function modelFromNote(note: string | null): string | null {
  const match = note ? /^Model:\s*([^\s,.]+(?:\.[^\s,.]+)*)/.exec(note) : null;
  return match?.[1] ?? null;
}

function attachmentRefs(message: Json): Array<Record<string, unknown>> {
  return objects(message.attachments).map((file) => ({
    id: stringValue(file.id),
    name: stringValue(file.name),
    mime: stringValue(file.mime),
    bytes: typeof file.bytes === "number" ? file.bytes : null,
    storageKey: stringValue(file.storage_key),
  }));
}

function messageContent(message: Json, attachments: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (text) parts.push(text);
  const card = message.card && typeof message.card === "object" ? message.card as Json : null;
  if (card) {
    const fields = Array.isArray(card.fields)
      ? card.fields.filter(Array.isArray).map((pair) => `${String(pair[0])}: ${String(pair[1])}`)
      : [];
    const body = [stringValue(card.title), stringValue(card.body), ...fields].filter(Boolean).join("\n");
    if (body) parts.push(`[Card]\n${body}`);
  }
  if (!text && attachments.length) {
    parts.push(attachments.map((file) => `[Attachment: ${String(file.name ?? "file")}]`).join("\n"));
  }
  return parts.join("\n\n");
}

export class EtbotAdapter implements SourceAdapter {
  readonly id = "etbot" as const;
  readonly displayName = "ETBot";
  readonly rootPath: string;
  readonly databasePath: string;

  constructor(
    rootPath = envPath("ETBOT_DATA_DIR", defaultDataDir()),
    databasePath = process.env.ETBOT_DB_PATH?.trim()
      ? envPath("ETBOT_DB_PATH", "")
      : path.join(rootPath, "etbot.sqlite"),
  ) {
    this.rootPath = rootPath;
    this.databasePath = databasePath;
  }

  isAvailable(): boolean {
    return fs.existsSync(this.databasePath);
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const warnings: string[] = [];
    if (!this.isAvailable()) return { source: this.id, sessions: 0, messages: [], warnings };

    let db: DatabaseSync | null = null;
    let raw: string;
    try {
      db = new DatabaseSync(this.databasePath, { readOnly: true });
      const row = db.prepare("SELECT revision, json FROM workspace WHERE id = 1").get() as Json | undefined;
      if (!row) return { source: this.id, sessions: 0, messages: [], warnings };
      raw = String(row.json);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return { source: this.id, sessions: 0, messages: [], warnings };
    } finally {
      db?.close();
    }

    let workspace: Json;
    try {
      workspace = JSON.parse(raw) as Json;
    } catch (error) {
      warnings.push(`ETBot workspace JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
      return { source: this.id, sessions: 0, messages: [], warnings };
    }

    // Messages imported from Duet are already archived under the "anthropic"
    // source (their provenance names that record), so they are skipped unless
    // ETBOT_IMPORTED=include.
    const includeImported = process.env.ETBOT_IMPORTED?.trim().toLowerCase() === "include";
    const shellRuns = !["off", "false", "0", "none"].includes(process.env.ETBOT_TOOL_EVENTS?.trim().toLowerCase() ?? "");
    const tasks = new Map(objects(workspace.tasks).map((task) => [String(task.id), task]));
    const human = userName();
    const host = hostname();
    const messages: NormalizedMessage[] = [];
    let sessions = 0;

    const conversations: Array<{ conversation: Conversation; list: Json[] }> = [];
    for (const channel of objects(workspace.channels)) {
      const channelId = String(channel.id);
      const channelTitle = channelId === EVERYTHING_ID ? `${BOT} · Everything` : `${BOT} · ${String(channel.name ?? channelId)}`;
      conversations.push({
        conversation: { id: `etbot:${channelId}`, title: channelTitle, channel, thread: null, task: null },
        list: objects(channel.messages),
      });
      for (const thread of objects(channel.threads)) {
        const taskId = stringValue(thread.task_id);
        conversations.push({
          conversation: {
            id: `etbot:${channelId}:${String(thread.id)}`,
            title: `${channelTitle} · ${String(thread.title ?? thread.id)}`,
            channel,
            thread,
            task: taskId ? tasks.get(taskId) ?? null : null,
          },
          list: objects(thread.messages),
        });
      }
    }

    for (const { conversation, list } of conversations) {
      const { channel, thread, task } = conversation;
      const before = messages.length;
      // Timestamps are whole seconds and a reply often shares its question's
      // second. A millisecond per earlier message in that second keeps the
      // conversation in order; messages are only appended, so it is stable.
      const perSecond = new Map<number, number>();
      for (const message of list) {
        const seconds = typeof message.ts === "number" ? message.ts : null;
        if (seconds === null) continue;
        const offset = perSecond.get(seconds) ?? 0;
        perSecond.set(seconds, offset + 1);

        const role = message.role === "user" ? "human" : message.role === "assistant" ? "assistant" : null;
        // A reply still streaming is saved with streaming=true; it is taken
        // once finished, because writes never replace an existing record.
        if (!role || message.streaming === true) continue;
        const imported = message.imported && typeof message.imported === "object" ? message.imported as Json : null;
        if (imported && !includeImported) continue;
        const timestamp = new Date(seconds * 1000 + Math.min(offset, 999));
        if (!isAfter(timestamp, options.sinceMs)) continue;

        const label = stringValue(message.label);
        const note = stringValue(message.note);
        const attachments = attachmentRefs(message);
        const content = messageContent(message, attachments);
        const messageId = String(message.id);
        const base = {
          sessionId: conversation.id,
          conversationTitle: conversation.title,
          channelId: String(channel.id),
          channelName: stringValue(channel.name),
          channelGroup: stringValue(channel.group),
          threadId: thread ? String(thread.id) : null,
          threadTitle: thread ? stringValue(thread.title) : null,
          threadRootId: thread ? stringValue(thread.root_message_id) : null,
          taskId: task ? String(task.id) : thread ? stringValue(thread.task_id) : null,
          taskTitle: task ? stringValue(task.title) : null,
          messageId,
          hostname: host,
        };

        if (content) {
          // Schedule turns are prompts ETBot sends itself on a timer; a Brief
          // is the brief Claude writes for a side thread it starts.
          const automated = role === "human" && label !== null;
          const sender = role === "assistant" || label === "Brief" ? BOT : automated ? `${BOT} ${label}` : human;
          const replyTo = message.reply_to && typeof message.reply_to === "object" ? message.reply_to as Json : null;
          messages.push({
            source: this.id,
            externalId: `etbot:${messageId}`,
            timestamp,
            sender,
            recipient: role === "assistant" ? human : BOT,
            content,
            metadata: {
              ...base,
              role,
              ...(label === "Schedule" ? { kind: "injected_instructions" } : {}),
              label,
              model: role === "assistant" ? modelFromNote(note) : null,
              note,
              error: stringValue(message.error),
              actions: strings(message.actions),
              replyTo: replyTo ? { messageId: stringValue(replyTo.message), author: stringValue(replyTo.author) } : null,
              answerTo: stringValue(message.answer_to),
              reportOf: stringValue(message.report_of),
              attachments,
              ...(imported ? {
                importedFrom: {
                  source: stringValue(imported.source),
                  recordId: stringValue(imported.record_id),
                  externalId: stringValue(imported.external_id),
                },
              } : {}),
            },
          });
        }

        if (!shellRuns) continue;
        objects(message.shell).forEach((run, index) => {
          const command = typeof run.command === "string" ? run.command : "";
          const output = typeof run.output === "string" ? run.output : "";
          const capped = capText(`$ ${command}\n${output || "(no output)"}`);
          messages.push({
            source: this.id,
            externalId: `etbot:${messageId}:shell:${index}`,
            timestamp: new Date(timestamp.getTime() + index + 1),
            sender: "tool:shell",
            recipient: BOT,
            content: capped.text,
            metadata: {
              ...base,
              role: "tool",
              kind: "tool_output",
              toolEvent: "result",
              toolName: "shell",
              exitCode: typeof run.code === "number" ? run.code : null,
              isError: typeof run.code === "number" && run.code !== 0,
              isolated: run.isolated === true,
              truncated: capped.truncated,
              originalChars: capped.originalChars,
            },
          });
        });
      }
      if (messages.length > before) sessions += 1;
    }

    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return {
      source: this.id,
      sessions,
      messages: applyMessageLimit(messages, options.maxMessages),
      warnings,
    };
  }
}
