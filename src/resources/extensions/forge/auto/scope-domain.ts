/**
 * `auto/scope-domain.ts` — pure-outward reader of the SCOPE-level `domain:`
 * frontmatter hint (S05), sibling to `auto/rank-hint.ts`'s per-task hint
 * family (`tierHintForUnit`/`effortHintForUnit`/`domainHintForUnit`).
 *
 * Where `domainHintForUnit` reads the `domain:` declared on a dispatched
 * unit's own T##-PLAN.md, `scopeDomainFor` reads the `domain:` declared on
 * the LARGER scope the unit sits inside — the slice's and milestone's
 * CONTEXT/ROADMAP artifacts. Same open-vocabulary discipline (D-S03-4): no
 * valid-value set, only trim + lowercase normalization — an unrecognized
 * domain flows through unchanged, and "no effect on rank" is delivered
 * downstream by a matrix miss, not by this reader (this reader in fact never
 * feeds the rank at all, see below).
 *
 * Precedence cascade (D-S05-A), most specific and most human-curated wins:
 *   1. `slices/<slice>/<slice>-CONTEXT.md`  (only when `slice` is passed)
 *   2. `<milestoneId>-CONTEXT.md`
 *   3. `<milestoneId>-ROADMAP.md`
 * The first readable, non-empty `domain:` wins; any failure at one rung
 * (missing file, no frontmatter, non-string value, empty after trim) falls
 * through to the next rung, not to a thrown error.
 *
 * Unlike `frontmatterHintForUnit` (`auto/rank-hint.ts`), this reader takes
 * `milestoneId` directly from its caller instead of resolving it via
 * `readState` (D-S05-C): the caller (a compose-time or review-time call
 * site) already has the current milestone id in hand, so re-deriving it
 * here would be redundant I/O.
 *
 * `undefined` means "no `domain:` line anywhere in the scope's prompts"
 * (D-S05-D) — callers treat it exactly like an absent hint: the composed
 * prompt/review body omits the corresponding line entirely, staying
 * byte-identical to the pre-S05 output.
 *
 * This reader is prompt-injection-only (D-S05-B): the rank
 * (`ResolveModelCtx.domain`) continues to read ONLY `domainHintForUnit`
 * (the per-task hint). Feeding this scope-level domain into the rank as a
 * fallback is a deliberately deferred, additive future change.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatter, parseFrontmatterMap } from "../../shared/frontmatter.js";

/**
 * Reads the `domain` frontmatter field off one markdown file, or `undefined`
 * when the file is missing/unreadable, has no frontmatter, or the field is
 * absent/non-string. Never throws.
 */
function domainFromFile(path: string): string | undefined {
  try {
    const md = readFileSync(path, "utf-8");
    const [fmLines] = splitFrontmatter(md);
    if (!fmLines) return undefined;

    const value = parseFrontmatterMap(fmLines)["domain"];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the scope-level `domain:` hint for a milestone (and, when given, one
 * of its slices), cascading `S##-CONTEXT.md` > `M###-CONTEXT.md` >
 * `M###-ROADMAP.md` (D-S05-A) and returning the first trim+lowercase
 * non-empty value. `undefined` when `milestoneId` is empty or no rung in the
 * cascade yields a usable value — see the module doc-comment for the full
 * degrade discipline. Never throws.
 */
export function scopeDomainFor(cwd: string, milestoneId: string, slice?: string): string | undefined {
  if (!milestoneId) return undefined;

  const milestoneDir = join(cwd, ".gsd", "milestones", milestoneId);
  const candidates: string[] = [];

  if (slice) {
    candidates.push(join(milestoneDir, "slices", slice, `${slice}-CONTEXT.md`));
  }
  candidates.push(join(milestoneDir, `${milestoneId}-CONTEXT.md`));
  candidates.push(join(milestoneDir, `${milestoneId}-ROADMAP.md`));

  for (const path of candidates) {
    const domain = domainFromFile(path)?.trim().toLowerCase();
    if (domain) return domain;
  }

  return undefined;
}
