/**
 * Read-side counterpart to `register-conversas.ts`: never writes, only
 * surfaces the last entry of `.gsd/CONVERSAS.md` for `/forge status` (S06).
 * Reuses `isConversationEntryHeading` so the reader and the writer share one
 * heading grammar instead of drifting apart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONVERSAS_FILENAME, isConversationEntryHeading } from "./entry-format.js";

/**
 * Pure parser: scan every line and decompose the LAST valid entry heading
 * into its date and theme (split on the first ` — ` after the date, which
 * `isConversationEntryHeading` already guarantees exists). Zero fs. Returns
 * `null` when no valid heading is present — empty/malformed content included.
 */
export function parseLastConversationHeading(content: string): { date: string; theme: string } | null {
  let lastHeading: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (isConversationEntryHeading(line)) lastHeading = line;
  }
  if (!lastHeading) return null;

  const withoutMarker = lastHeading.slice("## ".length);
  const separatorIndex = withoutMarker.indexOf(" — ");
  if (separatorIndex === -1) return null;

  const date = withoutMarker.slice(0, separatorIndex);
  const theme = withoutMarker.slice(separatorIndex + " — ".length).trim();
  if (!theme) return null;
  return { date, theme };
}

/**
 * Read `.gsd/CONVERSAS.md` under `cwd` and format the pt-BR status line for
 * its last entry. Never throws — same omit-on-failure posture as
 * `formatReviewDigest`: missing file, empty file, unreadable path (e.g. a
 * directory in its place), or content without a valid heading all degrade to
 * `""` so the caller simply skips the block.
 */
export function readLastConversationLine(cwd: string): string {
  try {
    const path = join(cwd, ".gsd", CONVERSAS_FILENAME);
    const content = readFileSync(path, "utf8");
    const last = parseLastConversationHeading(content);
    if (!last) return "";
    return `Última conversa: ${last.date} — ${last.theme}`;
  } catch {
    return "";
  }
}
