/**
 * Forge review — `§ Review follow-ups` appender for `.gsd/KNOWLEDGE.md`.
 *
 * The write-back target for decisions the operator marks `follow-up (nota de
 * uma linha)` during `/forge fix` (D-S02-3/D-S02-4, S02-PLAN): the item stays
 * off the REVIEW.md's own grammar and instead lands as a durable line in
 * KNOWLEDGE.md's `## Review follow-ups` section, the same section the S01/M0
 * lineage of this repo already uses by hand.
 *
 * Same posture as `artifact.ts`'s write-backs: tolerant (missing file/section
 * is created, never a throw), idempotent (re-applying the same entries appends
 * nothing and reports `{ appended: 0 }`), atomic (`writeFileAtomic`, only when
 * content actually changes). The appender matches the section by EXACT line
 * (`## Review follow-ups`), never a prefix — `## Review follow-ups (M1)` and
 * other milestone-suffixed sections in this repo's real KNOWLEDGE.md are left
 * byte-for-byte untouched.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../state/ledger.js";
import { normCwd } from "./artifact.js";

/** One decided-as-follow-up review item to record in KNOWLEDGE.md. */
export interface ReviewFollowUpEntry {
  milestoneId: string;
  slice: string;
  id: string;
  pathLine: string;
  claim: string;
  note: string;
}

const FOLLOWUP_HEADER = "## Review follow-ups";
const SECTION_HEADER = /^##\s+\S/;

/** Render one entry as its KNOWLEDGE.md bullet line (the dedupe/idempotency key). */
function formatFollowUpLine(entry: ReviewFollowUpEntry): string {
  return (
    `- **[follow-up de ${entry.slice} ${entry.id} · ${entry.milestoneId}]** ` +
    `${entry.claim} (\`${entry.pathLine}\`) — ${entry.note}`
  );
}

/**
 * Append `entries` to `.gsd/KNOWLEDGE.md`'s `## Review follow-ups` section,
 * creating the file (minimal `# KNOWLEDGE` header) and/or the section (at the
 * end of the file) when absent. Idempotent by exact-line comparison: an entry
 * whose formatted line is already present in the section is skipped; when
 * every entry is already present, returns `{ appended: 0, ok: true }` with
 * ZERO writes. All other existing content — including other `## Review
 * follow-ups (...)` sections — is preserved byte-for-byte. Never throws: any
 * read/write failure is caught and reported as `{ appended: 0, ok: false }` —
 * `ok` (R1) is what lets a caller tell "nothing new to append" apart from "the
 * append failed," so it can avoid stamping a REVIEW.md marker whose note was
 * actually lost.
 */
export function appendReviewFollowUps(
  cwd: string,
  entries: ReviewFollowUpEntry[],
): { appended: number; ok: boolean } {
  if (entries.length === 0) return { appended: 0, ok: true };

  const path = join(normCwd(cwd), ".gsd", "KNOWLEDGE.md");

  try {
    const existed = existsSync(path);
    const lines = existed ? readFileSync(path, "utf-8").split("\n") : ["# KNOWLEDGE", ""];

    let headerIdx = lines.findIndex((l) => l === FOLLOWUP_HEADER);
    if (headerIdx === -1) {
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.push("", FOLLOWUP_HEADER, "");
      headerIdx = lines.length - 2;
    }

    let sectionEnd = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (SECTION_HEADER.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }

    // Insert right after the section's last non-blank line, so the blank-line
    // separator before the next section (or EOF) is preserved untouched.
    let contentEnd = sectionEnd;
    while (contentEnd > headerIdx + 1 && lines[contentEnd - 1].trim() === "") contentEnd--;
    const insertAt = contentEnd > headerIdx + 1 ? contentEnd : headerIdx + 1;

    const existingLines = new Set(lines.slice(headerIdx + 1, sectionEnd));
    const newLines: string[] = [];
    for (const entry of entries) {
      const line = formatFollowUpLine(entry);
      if (existingLines.has(line) || newLines.includes(line)) continue;
      newLines.push(line);
    }

    if (newLines.length === 0) return { appended: 0, ok: true };

    lines.splice(insertAt, 0, ...newLines);
    writeFileAtomic(path, lines.join("\n"));
    return { appended: newLines.length, ok: true };
  } catch {
    return { appended: 0, ok: false };
  }
}
