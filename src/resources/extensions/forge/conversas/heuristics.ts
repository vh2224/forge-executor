import type { SessionEntry } from "@gsd/pi-coding-agent";

/** Minimum number of substantive operator messages required for distillation. */
export const MIN_OPERATOR_MESSAGES = 3;

const DISTILL_REASONS = new Set(["quit", "new", "resume", "fork"]);

// S01 established that cross-module custom-message markers compare by raw value.
const WORKER_CUSTOM_TYPES = new Set(["forge-dispatch", "forge-review"]);

/**
 * Extract text blocks from a user or assistant session message. Non-text blocks,
 * including tool calls and tool results, deliberately contribute no transcript text.
 */
export function sessionMessageText(entry: SessionEntry): string {
  if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) {
    return "";
  }

  const { content } = entry.message;
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * Count user messages that are conversational input rather than slash/bang
 * commands. Commands normally do not enter the transcript, but this defensive
 * prefix check handles text that fell through to the model.
 *
 * Whitespace is ignored only for command classification. The original text is
 * otherwise preserved for excerpt construction, so human wording stays intact.
 */
export function countOperatorMessages(entries: SessionEntry[]): number {
  return entries.filter((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return false;
    const text = sessionMessageText(entry).trimStart();
    return text.length > 0 && !text.startsWith("/") && !text.startsWith("!");
  }).length;
}

/**
 * Worker/review dispatches are never operator conversations, even if they
 * contain user text. Scan the full session rather than just the first entry:
 * resumed and legacy session files can place the hidden marker later.
 */
export function isWorkerSliceEntries(entries: SessionEntry[]): boolean {
  return entries.some(
    (entry) => entry.type === "custom_message" && WORKER_CUSTOM_TYPES.has(entry.customType),
  );
}

/**
 * Return whether a shutdown is eligible for one best-effort conversational
 * distillation. Reload intentionally is absent because its session remains live.
 * This is intentionally a pure predicate: it makes no inference from session
 * metadata and does not inspect the filesystem or provider configuration.
 */
export function shouldDistillSession(entries: SessionEntry[], reason: string): boolean {
  return (
    DISTILL_REASONS.has(reason) &&
    !isWorkerSliceEntries(entries) &&
    countOperatorMessages(entries) >= MIN_OPERATOR_MESSAGES
  );
}
