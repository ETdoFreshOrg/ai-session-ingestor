import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeCodeAdapter } from "./claudecode.js";
import { CodexAdapter } from "./codex.js";
import { EtbotAdapter } from "./etbot.js";
import { OpenCodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";
import type { SourceAdapter } from "../types.js";

export function createAdapters(): SourceAdapter[] {
  return [
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new OpenCodeAdapter(),
    new AntigravityAdapter(),
    new PiAdapter(),
    new EtbotAdapter(),
  ];
}

export { AntigravityAdapter, ClaudeCodeAdapter, CodexAdapter, EtbotAdapter, OpenCodeAdapter, PiAdapter };
