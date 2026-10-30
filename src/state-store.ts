import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { envPath } from "./lib/common.js";
import type { SourceId } from "./types.js";

interface SerializedState {
  version: 1;
  sources: Partial<Record<SourceId, string[]>>;
  /**
   * Original identities of oversized messages that this ingestor itself wrote
   * as split parts (or that the migration split). An oversized identity that is
   * seen but absent here was stored whole by an earlier version.
   */
  split?: Partial<Record<SourceId, string[]>>;
  settings?: Record<string, string>;
  updatedAt: string;
}

function toMap(input: Partial<Record<SourceId, string[]>> | undefined): Map<SourceId, Set<string>> {
  return new Map(Object.entries(input ?? {}).map(([source, ids]) => [source as SourceId, new Set(ids)]));
}

function fromMap(input: Map<SourceId, Set<string>>): Partial<Record<SourceId, string[]>> {
  return Object.fromEntries([...input].map(([source, values]) => [source, [...values].sort()]));
}

export class StateStore {
  readonly filePath: string;
  private seen = new Map<SourceId, Set<string>>();
  private split = new Map<SourceId, Set<string>>();
  private settings: Record<string, string> = {};

  constructor(filePath = path.join(envPath("DATA_DIR", ".data"), "ingest-state.json")) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    this.seen.clear();
    this.split.clear();
    this.settings = {};
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(await fsPromises.readFile(this.filePath, "utf8")) as SerializedState;
      this.seen = toMap(parsed.sources);
      this.split = toMap(parsed.split);
      this.settings = { ...(parsed.settings ?? {}) };
    } catch (error) {
      throw new Error(
        `Could not load state file ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  has(source: SourceId, externalId: string): boolean {
    return this.seen.get(source)?.has(externalId) ?? false;
  }

  mark(source: SourceId, externalId: string): void {
    const values = this.seen.get(source) ?? new Set<string>();
    values.add(externalId);
    this.seen.set(source, values);
  }

  isSplit(source: SourceId, originalExternalId: string): boolean {
    return this.split.get(source)?.has(originalExternalId) ?? false;
  }

  markSplit(source: SourceId, originalExternalId: string): void {
    const values = this.split.get(source) ?? new Set<string>();
    values.add(originalExternalId);
    this.split.set(source, values);
  }

  getSetting(key: string): string | undefined {
    return this.settings[key];
  }

  setSetting(key: string, value: string): void {
    this.settings[key] = value;
  }

  count(source: SourceId): number {
    return this.seen.get(source)?.size ?? 0;
  }

  counts(): Partial<Record<SourceId, number>> {
    return Object.fromEntries([...this.seen].map(([source, values]) => [source, values.size]));
  }

  async save(): Promise<void> {
    const state: SerializedState = {
      version: 1,
      sources: fromMap(this.seen),
      ...(this.split.size ? { split: fromMap(this.split) } : {}),
      ...(Object.keys(this.settings).length ? { settings: this.settings } : {}),
      updatedAt: new Date().toISOString(),
    };
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fsPromises.rename(temporaryPath, this.filePath);
  }
}
