import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BatchWriteResult,
  MessageWriteResult,
  NormalizedMessage,
  WriteAction,
} from "./types.js";

export interface ApiConfig {
  baseUrl: string;
  token: string;
  concurrency: number;
}

export function getApiConfig(): ApiConfig | null {
  const baseUrl = (
    process.env.MEMORY_DATABASE_API_URL ??
    process.env.MEMORY_DB_API_URL ??
    ""
  ).trim().replace(/\/+$/, "");
  const token = (
    process.env.MEMORY_DATABASE_API_WRITE_TOKEN ??
    process.env.MEMORY_DB_API_WRITE_TOKEN ??
    process.env.MEMORY_DATABASE_API_TOKEN ??
    process.env.MEMORY_DB_API_TOKEN ??
    ""
  ).trim();
  if (!baseUrl || !token) return null;
  const parsedConcurrency = Number.parseInt(process.env.WRITE_CONCURRENCY ?? "2", 10);
  return {
    baseUrl,
    token,
    concurrency: Number.isFinite(parsedConcurrency) ? Math.max(1, Math.min(parsedConcurrency, 20)) : 2,
  };
}

export function toApiPayload(message: NormalizedMessage): Record<string, unknown> {
  return {
    source: message.source,
    sender: message.sender,
    recipient: message.recipient,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
    external_id: message.externalId,
    metadata: {
      ...message.metadata,
      conversation_id: message.metadata.sessionId ?? message.metadata.session_id ?? null,
      // An adapter may classify a record itself (tool_output for tool calls and
      // results, which the Memory Database leaves out of default search).
      kind: typeof message.metadata.kind === 'string' ? message.metadata.kind
        : message.content.startsWith('[IMPORTANT: The user has invoked the ')
        ? 'injected_instructions'
        : message.metadata.phase === 'commentary' ? 'progress_update'
        : message.metadata.role === 'assistant' ? 'assistant_message' : 'human_message',
    },
  };
}

// Postgres text and jsonb reject NUL, and tool output from binary files can carry it.
export function serializeApiPayload(message: NormalizedMessage): string {
  return JSON.stringify(toApiPayload(message), (_key, value) =>
    typeof value === 'string' ? value.replace(/\u0000/g, '') : value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as Error & { code?: unknown }).code;
  return `${error.message}: ${typeof code === "string" ? `${code} ` : ""}${cause.message}`;
}

interface HttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  bodyText: string;
  retryAfter: string | null;
}

async function curlRequest(
  url: string,
  method: "GET" | "POST" | "PUT",
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<HttpResult> {
  const statusMarker = "\n__AI_INGESTOR_HTTP_STATUS__:";
  const config = Object.entries(headers).map(([name, value]) => {
    const escaped = `${name}: ${value}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `header = "${escaped}"`;
  }).join("\n");
  const configDirectory = await mkdtemp(join(tmpdir(), "ai-session-ingestor-curl-"));
  const configPath = join(configDirectory, "headers.conf");

  try {
    await writeFile(configPath, `${config}\n`, { encoding: "utf8", mode: 0o600 });
    const args = [
      "-sS",
      "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1_000))),
      "-X", method,
      "--config", configPath,
      "-w", `${statusMarker}%{http_code}`,
    ];
    if (body !== undefined) args.push("--data-binary", "@-");
    args.push(url);

    const child = spawn(process.env.CURL_PATH?.trim() || "/usr/bin/curl", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.stdin.end(body);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const output = Buffer.concat(stdout).toString("utf8");
    const markerIndex = output.lastIndexOf(statusMarker);
    const detail = Buffer.concat(stderr).toString("utf8").trim();
    if (exitCode !== 0 || markerIndex < 0) {
      throw new Error(detail || `curl exited with status ${String(exitCode)}`);
    }
    const status = Number.parseInt(output.slice(markerIndex + statusMarker.length), 10);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      bodyText: output.slice(0, markerIndex),
      retryAfter: null,
    };
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
}

export async function request(
  url: string,
  method: "GET" | "POST" | "PUT",
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<HttpResult> {
  headers = { "User-Agent": "Mozilla/5.0 MemoryIngestor/1.0", ...headers };
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      bodyText: await response.text(),
      retryAfter: response.headers.get("retry-after"),
    };
  } catch (fetchError) {
    try {
      return await curlRequest(url, method, headers, body, timeoutMs);
    } catch (curlError) {
      throw new Error(
        `${describeError(fetchError)}; curl fallback failed: ${describeError(curlError)}`,
      );
    }
  }
}

function normalizeAction(value: unknown, status: number): WriteAction {
  if (value === "inserted") return "inserted";
  if (value === "appended") return "appended";
  if (value === "skipped") return "skipped";
  return status === 201 ? "inserted" : "skipped";
}

async function writeOne(
  message: NormalizedMessage,
  config: ApiConfig,
): Promise<MessageWriteResult> {
  const url = `${config.baseUrl}/api/messages?conflict_mode=skip_existing`;
  const maxAttempts = 4;
  const timeoutMs = Math.max(1_000, Number.parseInt(process.env.API_TIMEOUT_MS ?? "30000", 10) || 30_000);
  let lastError = "unknown API error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: HttpResult;
    try {
      response = await request(
        url,
        "POST",
        { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
        serializeApiPayload(message),
        timeoutMs,
      );
    } catch (error) {
      lastError = describeError(error);
      if (attempt < maxAttempts) {
        await sleep(500 * (2 ** (attempt - 1)));
        continue;
      }
      throw new Error(lastError);
    }

    const bodyText = response.bodyText;
    let body: Record<string, unknown> = {};
    try {
      const parsed = bodyText ? JSON.parse(bodyText) as unknown : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Error below includes the response excerpt.
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = `Memory Database API ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`;
      if (attempt < maxAttempts) {
        const retryAfter = Number.parseFloat(response.retryAfter ?? "0");
        await sleep(retryAfter > 0 ? retryAfter * 1_000 : 500 * (2 ** (attempt - 1)));
        continue;
      }
      throw new Error(lastError);
    }
    if (!response.ok) {
      throw new Error(
        `Memory Database API ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`,
      );
    }
    if (body.conflict_mode !== "skip_existing") {
      throw new Error("Memory Database API did not honor insert-only conflict mode");
    }
    if (body.action === "overwritten" || body.action === "appended") {
      throw new Error(`Memory Database API unexpectedly ${String(body.action)} an existing message`);
    }
    return { message, action: normalizeAction(body.action, response.status) };
  }

  throw new Error(lastError);
}

export async function requireInsertOnlyCapability(config: ApiConfig): Promise<void> {
  const timeoutMs = Math.max(1_000, Number.parseInt(process.env.API_TIMEOUT_MS ?? "30000", 10) || 30_000);
  let response: HttpResult;
  try {
    response = await request(
      `${config.baseUrl}/api/health`,
      "GET",
      { Authorization: `Bearer ${config.token}` },
      undefined,
      timeoutMs,
    );
  } catch (error) {
    throw new Error(`Could not verify Memory Database capabilities: ${describeError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not verify Memory Database capabilities: HTTP ${response.status}`);
  }
  const body = JSON.parse(response.bodyText) as {
    capabilities?: { message_conflict_modes?: unknown };
  };
  const modes = body.capabilities?.message_conflict_modes;
  if (!Array.isArray(modes) || !modes.includes("skip_existing")) {
    throw new Error(
      "Memory Database API does not advertise skip_existing support; refusing writes to protect existing items",
    );
  }
}

export async function writeMessages(
  messages: NormalizedMessage[],
  config = getApiConfig(),
): Promise<BatchWriteResult> {
  if (!config) {
    throw new Error(
      "Memory Database API is not configured. Set MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_WRITE_TOKEN.",
    );
  }
  const resolvedConfig = config;
  await requireInsertOnlyCapability(resolvedConfig);

  const successful: BatchWriteResult["successful"] = [];
  const failed: BatchWriteResult["failed"] = [];
  if (messages.length === 0) return { successful, failed };

  // Seed each source serially. This lets the API create its source row before
  // concurrent inserts and avoids first-run source-creation lock contention.
  const first = messages[0]!;
  try {
    successful.push(await writeOne(first, resolvedConfig));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failed.push({ message: first, error: reason });
    failed.push(...messages.slice(1).map((message) => ({
      message,
      error: `Batch stopped after the first write failed: ${reason}`,
    })));
    return { successful, failed };
  }

  let nextIndex = 1;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const message = messages[index];
      if (!message) return;
      try {
        successful.push(await writeOne(message, resolvedConfig));
      } catch (error) {
        failed.push({
          message,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(resolvedConfig.concurrency, Math.max(1, messages.length - 1)) }, () => worker()),
  );
  return { successful, failed };
}
