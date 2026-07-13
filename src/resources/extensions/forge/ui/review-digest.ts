/**
 * Review digest — the read-side formatter shared by the milestone finale
 * (`ui/finale.ts`) and `/forge status` (S04). Turns the S02 collector's
 * still-pending review items into the operator-facing summary the ROADMAP
 * demo asks for: a glyph + count header, then one `R# (S##): claim` line per
 * item plus the origin REVIEW.md path.
 *
 * Pure read-side, never throws: any collector error, missing milestone, or
 * empty pending set degrades to `[]` so callers can skip the block entirely
 * (finale's byte-identical-when-empty guarantee depends on this).
 *
 * No new REVIEW.md parsing lives here — everything comes from
 * `collectPendingReviewBlocks` (review/artifact.ts), the single owner of the
 * `### R#` grammar (Forward Intelligence boundary from S02).
 */

import { relative } from "node:path";
import { collectPendingReviewBlocks, collectReviewArtifactWarnings, type PendingReviewBlock } from "../review/artifact.js";

/** Claims are truncated to keep the digest line scannable in a terminal. */
const MAX_CLAIM_LEN = 80;

/** Suffix applied to a conceded item whose fix could not land. */
// "concedida" and not "fix falhou": since the fresh-`_pendente_` fix
// (artifact.ts pendingStatus, M8-close), most conceded-sem-fix items were
// never ATTEMPTED — labeling them "falhou" lies about a fix that never ran.
const FIX_FAILED_SUFFIX = " · concedida — fix pendente";

function truncateClaim(claim: string): string {
  if (claim.length <= MAX_CLAIM_LEN) return claim;
  return `${claim.slice(0, MAX_CLAIM_LEN - 1).trimEnd()}…`;
}

/** Render one pending item as its two-line digest entry: summary + origin path. */
function formatItem(cwd: string, block: PendingReviewBlock): string[] {
  const suffix = block.status === "conceded-sem-fix" ? FIX_FAILED_SUFFIX : "";
  const claim = truncateClaim(block.claim);
  return [
    `  ${block.id} (${block.slice}): ${claim}${suffix}`,
    `    ↳ ${relative(cwd, block.reviewPath)}`,
  ];
}

/**
 * Format the pending-review digest for `milestoneId`, scanning every slice's
 * `S##-REVIEW.md` under it via `collectPendingReviewBlocks`. Returns lines
 * WITHOUT banner indentation — callers (finale, status) apply their own
 * prefix. Returns `[]` when `milestoneId` is empty, there are no pending
 * items, or any read fails — this function never throws.
 */
export function formatReviewDigest(cwd: string, milestoneId: string): string[] {
  if (!milestoneId) return [];

  try {
    const pending = collectPendingReviewBlocks(cwd, milestoneId);
    // S04-R1: an unreadable/malformed artifact must NEVER be presented as
    // "nothing pending" — surface it even when the parseable set is empty.
    const warnings = collectReviewArtifactWarnings(cwd, milestoneId);
    if (pending.length === 0 && warnings.length === 0) return [];

    const lines: string[] = [];
    if (pending.length > 0) {
      lines.push(`⚖ ${pending.length} aberta(s) — triagem de review pendente · /forge fix`);
      for (const block of pending) {
        lines.push(...formatItem(cwd, block));
      }
    }
    for (const w of warnings) {
      lines.push(`⚠ ${w}`);
    }
    return lines;
  } catch {
    return []; // collector/read failure — digest omitted, never fatal
  }
}
