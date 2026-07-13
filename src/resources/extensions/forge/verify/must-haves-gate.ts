/**
 * Forge must-haves-gate — the ONE enforcing predicate in the anti-hallucination
 * suite (D-S06-1). Everything else in `verify/` (artifact-audit, test-quality,
 * verify-slice, file-audit, evidence) is advisory and never blocks.
 *
 * `enforceMustHaves(planText)` reuses `state/must-haves.ts` (`hasStructuredMustHaves`
 * / `parseMustHaves`, M1) — this module does NOT re-implement the YAML parser.
 *
 * Enforcing rule (D-S06-1): a T##-PLAN.md that is PRESENT but INVALID blocks —
 *   - legacy (no structured `must_haves:` block at all) → blocked
 *   - malformed (`parseMustHaves` throws on a present-but-broken schema) → blocked
 *   - valid → allowed
 * An IO error reading the plan (file missing/unreadable) is a caller concern —
 * this module only ever receives `planText` as a string, so IO never surfaces
 * here; the caller (loop.ts guard) must not synthesize a block for read failures.
 *
 * PURE module: only imports `state/must-haves.js`. No I/O, no `@gsd/*` runtime.
 */

import { hasStructuredMustHaves, parseMustHaves } from "../state/must-haves.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EnforceReason = "legacy" | "malformed";

export type EnforceResult =
  | { ok: true }
  | { ok: false; reason: EnforceReason; detail?: string };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enforce the `must_haves:` schema-check on a T##-PLAN.md's raw text.
 *
 * Never throws — `parseMustHaves` failures (present-but-invalid schema) are
 * caught and converted into `{ok:false, reason:'malformed', detail}`. This is
 * the ONLY enforcing gate in the anti-hallucination suite (D-S06-1); callers
 * must not add other block paths on top of this predicate.
 */
export function enforceMustHaves(planText: string): EnforceResult {
  if (!hasStructuredMustHaves(planText)) {
    return { ok: false, reason: "legacy" };
  }

  try {
    parseMustHaves(planText);
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "malformed", detail };
  }
}
