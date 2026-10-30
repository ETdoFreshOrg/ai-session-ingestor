import fs from "node:fs";
import path from "node:path";
import {
  applyMessageLimit,
  capText,
  envPath,
  hostname,
  isAfter,
  readJsonLines,
  textFromBlocks,
  userName,
  validDate,
  walkFiles,
} from "../lib/common.js";
import type { NormalizedMessage, ScanOptions, ScanResult, SourceAdapter } from "../types.js";

const TEXT = new Set(["text"]);

type Block = Record<string, unknown>;

function blocks(value: unknown): Block[] {
  return Array.isArray(value)
    ? value.filter((block): block is Block => Boolean(block) && typeof block === "object" && !Array.isArray(block))
    : [];
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return blocks(value)
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") return block.text.trim();
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function toolCallText(name: string, input: unknown): string {
  let rendered = "";
  try {
    rendered = input === undefined ? "" : JSON.stringify(input, null, 2);
  } catch {
    rendered = String(input);
  }
  return rendered ? `${name}\n${rendered}` : name;
}

/**
 * Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl, plus
 * sub-agent files below a session directory) contain one JSONL entry per
 * message or content block. Each user/assistant entry becomes its own record
 * with the legacy `<session>:<uuid>` identity. Tool calls and tool results
 * become separate records marked kind=tool_output (role "tool") so the Memory
 * Database excludes them from default search; they are emitted only when
 * options.toolEventsSinceMs is set. Thinking blocks are never stored.
 */
export class ClaudeCodeAdapter implements SourceAdapter {
  readonly id = "claudecode" as const;
  readonly displayName = "Claude Code";
  readonly rootPath: string;

  constructor(rootPath = envPath("CLAUDE_DATA_DIR", "~/.claude")) {
    this.rootPath = rootPath;
  }

  isAvailable(): boolean {
    return fs.existsSync(path.join(this.rootPath, "projects"));
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const projectsRoot = path.join(this.rootPath, "projects");
    const files = await walkFiles(projectsRoot, (file) => file.endsWith(".jsonl"));
    const warnings: string[] = [];
    const messages: NormalizedMessage[] = [];
    const human = userName();
    const host = hostname();
    const toolEventsSince = options.toolEventsSinceMs;

    for (const filePath of files) {
      const relative = path.relative(projectsRoot, filePath).split(path.sep);
      const project = relative[0] || "unknown";
      const fallbackSessionId = path.basename(filePath, ".jsonl");
      const toolNames = new Map<string, string>();
      const entries = readJsonLines(filePath, (error: unknown) => {
        warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      });

      for await (const { value } of entries) {
        const type = value.type;
        if (type !== "user" && type !== "assistant") continue;
        const rawMessage = value.message;
        if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
        const message = rawMessage as Record<string, unknown>;
        const uuid = typeof value.uuid === "string" ? value.uuid : null;
        const sessionId =
          (typeof value.sessionId === "string" && value.sessionId) || fallbackSessionId;
        const timestamp = validDate(value.timestamp);
        const contentBlocks = blocks(message.content);

        // Remember tool names even outside the time window: a result may fall
        // inside the window while its call does not.
        if (type === "assistant") {
          for (const block of contentBlocks) {
            if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
              toolNames.set(block.id, block.name);
            }
          }
        }
        if (!uuid || !timestamp || !isAfter(timestamp, options.sinceMs)) continue;
        const model = type === "assistant" && typeof message.model === "string" ? message.model : null;
        const base = { sessionId, project, hostname: host };
        const toolEvents = toolEventsSince !== undefined && timestamp.getTime() >= toolEventsSince;

        if (type === "user" && message.role === "user") {
          const toolResults = contentBlocks.filter((block) => block.type === "tool_result");
          if (toolResults.length) {
            // Entries carrying tool results never produced a human record.
            if (!toolEvents) continue;
            toolResults.forEach((block, index) => {
              const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
              const toolName = (toolUseId && toolNames.get(toolUseId)) || "unknown";
              const capped = capText(toolResultText(block.content) || "(no output)");
              messages.push({
                source: this.id,
                externalId: `${sessionId}:${uuid}:tool_result:${toolUseId ?? index}`,
                timestamp,
                sender: `tool:${toolName}`,
                recipient: "Claude",
                content: capped.text,
                metadata: {
                  ...base,
                  role: "tool",
                  kind: "tool_output",
                  toolEvent: "result",
                  toolName,
                  toolUseId,
                  isError: block.is_error === true,
                  truncated: capped.truncated,
                  originalChars: capped.originalChars,
                },
              });
            });
            continue;
          }
          const content = textFromBlocks(message.content, TEXT);
          if (!content) continue;
          messages.push({
            source: this.id,
            externalId: `${sessionId}:${uuid}`,
            timestamp,
            sender: human,
            recipient: "Claude",
            content,
            metadata: { ...base, model: null, role: "human" },
          });
        } else if (type === "assistant" && message.role === "assistant") {
          const content = textFromBlocks(message.content, TEXT);
          if (content) {
            messages.push({
              source: this.id,
              externalId: `${sessionId}:${uuid}`,
              timestamp,
              sender: "Claude",
              recipient: human,
              content,
              metadata: { ...base, model, role: "assistant" },
            });
          }
          if (!toolEvents) continue;
          contentBlocks.forEach((block, index) => {
            if (block.type !== "tool_use") return;
            const toolName = typeof block.name === "string" ? block.name : "unknown";
            const toolUseId = typeof block.id === "string" ? block.id : null;
            const capped = capText(toolCallText(toolName, block.input));
            messages.push({
              source: this.id,
              externalId: `${sessionId}:${uuid}:tool_use:${toolUseId ?? index}`,
              timestamp,
              sender: "Claude",
              recipient: `tool:${toolName}`,
              content: capped.text,
              metadata: {
                ...base,
                model,
                role: "tool",
                kind: "tool_output",
                toolEvent: "call",
                toolName,
                toolUseId,
                truncated: capped.truncated,
                originalChars: capped.originalChars,
              },
            });
          });
        }
      }
    }

    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return {
      source: this.id,
      sessions: files.length,
      messages: applyMessageLimit(messages, options.maxMessages),
      warnings,
    };
  }
}
