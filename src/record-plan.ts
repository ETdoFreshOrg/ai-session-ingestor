import { MAX_RECORD_CHARS, splitContent } from "./lib/common.js";
import type { StateStore } from "./state-store.js";
import type { NormalizedMessage } from "./types.js";

/** One source message and the record(s) it is stored as. */
export interface RecordGroup {
  original: NormalizedMessage;
  /** One record (the message unchanged) or its ordered parts. */
  records: NormalizedMessage[];
  split: boolean;
}

/**
 * Part 1 keeps the message's original identity, so a message that was already
 * stored whole can be replaced in place (see scripts/migrate-oversized-records.ts);
 * later parts get `<original>:part:<n>`.
 */
export function partExternalId(originalExternalId: string, part: number): string {
  return part === 1 ? originalExternalId : `${originalExternalId}:part:${part}`;
}

export function planRecords(message: NormalizedMessage, maxChars = MAX_RECORD_CHARS): RecordGroup {
  const chunks = splitContent(message.content, maxChars);
  if (chunks.length === 1) return { original: message, records: [message], split: false };
  const records = chunks.map((content, index): NormalizedMessage => {
    const part = index + 1;
    return {
      ...message,
      externalId: partExternalId(message.externalId, part),
      // A millisecond per part keeps parts in order in timestamp-ordered views.
      timestamp: new Date(message.timestamp.getTime() + index),
      content,
      metadata: {
        ...message.metadata,
        part,
        parts: chunks.length,
        partOf: message.externalId,
        originalChars: message.content.length,
      },
    };
  });
  return { original: message, records, split: true };
}

/**
 * An oversized message whose original identity was confirmed before this
 * version split messages is stored whole. Writing its parts now would store
 * the text twice, so they wait for the migration script.
 */
export function heldForMigration(group: RecordGroup, state: StateStore): boolean {
  const { source, externalId } = group.original;
  return group.split && state.has(source, externalId) && !state.isSplit(source, externalId);
}
