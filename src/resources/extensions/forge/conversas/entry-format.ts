/** Maximum number of model-produced Markdown lines in a conversation entry. */
export const MAX_ENTRY_LINES = 10;

/**
 * File name is kept separate from its project-local .gsd directory.
 * The T02 writer joins it only after confirming that directory already exists.
 */
export const CONVERSAS_FILENAME = "CONVERSAS.md";

const ENTRY_HEADING = /^## \d{4}-\d{2}-\d{2} — .+/;

/**
 * Produce the stable HTML comment marker used to deduplicate a session.
 * It is deliberately separate from model output: providers never choose IDs,
 * and a later writer can append it after deterministic response validation.
 */
export function formatSessionMarker(sessionId: string): string {
  return `<!-- sessao: ${sessionId} -->`;
}

/**
 * Validate an untrusted completion response before the append-only writer sees it.
 * The writer adds the session marker, so this parser accepts only model output.
 *
 * `expectedDate` is the ISO date the caller supplied to `buildDistillPrompt`: the
 * heading must echo it exactly, so a model cannot stamp an arbitrary or stale date
 * that would still pass a syntax-only check.
 */
export function parseDistillResponse(raw: string, expectedDate: string): string | null {
  const normalized = raw.trim();
  if (!normalized || normalized === "SKIP") return null;

  const lines = normalized.split(/\r?\n/);
  const [heading, ...rest] = lines;
  if (lines.length > MAX_ENTRY_LINES || !isConversationEntryHeading(heading)) return null;
  if (!heading.startsWith(`## ${expectedDate} — `)) return null;
  // A second `## ` line would read as its own entry to S06's `/^## /m` split,
  // producing an unmarked phantom entry that escapes session dedupe forever.
  if (rest.some((line) => line.startsWith("## "))) return null;

  // Normalize CRLF to LF so append output has one stable on-disk grammar.
  return lines.join("\n");
}

/**
 * Check the exact marker rather than a loose ID substring, avoiding false
 * positives when one session ID happens to contain another session ID.
 */
export function sessionAlreadyDistilled(existingContent: string, sessionId: string): boolean {
  return existingContent.includes(formatSessionMarker(sessionId));
}

/**
 * The entry boundary expected by S06 is a level-two Markdown heading.
 * This narrow check deliberately leaves semantic quality to the LLM prompt;
 * T01's deterministic gate only accepts a safe, parseable storage envelope.
 */
export function isConversationEntryHeading(line: string): boolean {
  return ENTRY_HEADING.test(line);
}
