/**
 * `auto/model-rank.ts` — the D6 pure rank: `rankPool(eligibleRefs, opts)`
 * picks the winning ref from an ALREADY-FILTERED candidate list (family-ok ∩
 * available — S04's adversarial filter and S03's `isModelAvailable` have
 * already run) by composing `model-capabilities.ts` (T01) into downgrade-only
 * + budget pressure + flat-rate suppression + a deterministic tie-break.
 *
 * `rankPool` NEVER re-filters by availability or family — that invariant of
 * order is load-bearing (S04 Forward Intelligence): the adversarial filter
 * and the availability filter compose by intersection and run BEFORE the
 * rank. If this module re-filtered, it would duplicate or regress
 * `reviewer_not_author`. T03 plugs `rankPool` into `role.ts`'s "rankear" step
 * strictly after both filters.
 *
 * S03 (capacidade-esforço) adds the per-domain capability factor the ROADMAP
 * names ("capability entra como fator novo em RankOpts"): `RankOpts` gains
 * `domain` + an injected `capabilityOf` lookup, composed ONLY into the
 * finalist tie-break per D-S03-1. The module stays I/O-free — it never reads
 * the CAPABILITIES file or imports `capability-matrix.ts`; the caller
 * pre-resolves the matrix and injects a pure, pre-bound lookup (T03 wires
 * `(d, r) => capabilityFor(matrix, d, r)` at the seam).
 *
 * Pure module: no I/O, no `Date`, no `Math.random`, no `pi-ai`/
 * `forge-agent-core` import — only `./model-capabilities.js` (T01).
 */

import {
  type Tier,
  TIER_ORDINAL,
  tierOf,
  capabilityScore,
  costRank,
  isFlatRateProvider,
  providerOf,
} from "./model-capabilities.js";

/**
 * Rank inputs, both optional — omitting both reproduces S03's pool-order
 * pick byte-identically (the no-hint, no-budget-pressure path always returns
 * `eligibleRefs[0]`, same as the pre-S05 "first available ref wins" body).
 *
 * - `tierHint` — the planner's `tier` frontmatter for the dispatched unit
 *   (`plan-slice.ts:154-163`), pre-resolved by the caller (T03) before the
 *   seam. Lowers the rank's target tier below the pool's ceiling; never
 *   raises it — downgrade-only.
 * - `budgetPressure` — a synthetic-in-S05 signal (see S05-PLAN §Notes) that
 *   forces the target tier one ordinal level lower still, clamped to the
 *   lowest tier actually present in `eligibleRefs` (never invents a tier that
 *   doesn't exist in the pool, never rises).
 * - `domain` — the planner's `domain:` frontmatter hint for the dispatched
 *   unit, pre-resolved by the caller (`domainHintForUnit`, T01/T03). Open
 *   vocabulary (D-S03-4): a domain absent from the matrix simply produces
 *   `undefined` lookups — no validation happens here.
 * - `capabilityOf` — the S02 capability-matrix lookup, pre-bound by the
 *   caller (`(d, r) => capabilityFor(matrix, d, r)`); this module never reads
 *   the filesystem. Per the S02 contract, `undefined` means "factor ABSENT
 *   for this ref" — never score 0 — so an unscored ref falls back to its
 *   normalized static profile (D-S03-1).
 *
 * The capability factor engages ONLY when BOTH `domain` and `capabilityOf`
 * are present, and ONLY in the finalist tie-break (D-S03-1): tier
 * candidate/finalist selection (downgrade-only/teto) and the flat-rate
 * short-circuit are untouched. With either field absent, the tie-break runs
 * the exact pre-S03 comparator — a structural branch, so byte-identity does
 * not depend on any arithmetic coincidence.
 */
export interface RankOpts {
  tierHint?: Tier;
  budgetPressure?: boolean;
  domain?: string;
  capabilityOf?: (domain: string, ref: string) => number | undefined;
}

/**
 * Normalizes the static `capabilityScore` fallback onto the matrix's `[0,1]`
 * axis (D-S03-1): the synthetic table's maximum is 95, so
 * `capabilityScore(ref) / 100` always lands in `[0,1]`. Division by a
 * positive constant is a monotone transformation — the RELATIVE order among
 * refs the matrix does not score is identical to the current static order.
 */
const STATIC_CAPABILITY_SCALE = 100;

/** `TIER_ORDINAL` inverted (ordinal → tier), built once from the T01 source of truth. */
const ORDINAL_TO_TIER: Tier[] = (Object.keys(TIER_ORDINAL) as Tier[]).sort(
  (a, b) => TIER_ORDINAL[a] - TIER_ORDINAL[b],
);

/** Ordinal → `Tier`, clamped to the lowest/highest declared tier for an out-of-range ordinal. */
function tierAtOrdinal(ordinal: number): Tier {
  const clamped = Math.max(0, Math.min(ordinal, ORDINAL_TO_TIER.length - 1));
  return ORDINAL_TO_TIER[clamped];
}

/**
 * Picks the winning ref from `eligibleRefs` (already family-ok ∩ available)
 * per the D6 rank, or `null` for an empty pool.
 *
 * Algorithm (S05-PLAN §Semântica do rank D6 / T02-PLAN Steps):
 * 1. Empty pool ⇒ `null`.
 * 2. `topRef = eligibleRefs[0]`; `ceiling = tierOf(topRef)` — the pool's
 *    declared order names its top as the tier-teto. downgrade-only: the rank
 *    never returns a ref above `ceiling`.
 * 3. Flat-rate short-circuit FIRST: if `topRef`'s provider is flat-rate
 *    (subscription, no marginal per-token cost — `isFlatRateProvider`),
 *    return `topRef` immediately. There is no marginal cost to optimize, so
 *    fine-grained routing (hint, budget pressure, tie-break) is suppressed
 *    entirely — even when both a hint and budget pressure are present.
 * 4. Target tier: starts at `ceiling`. A `tierHint` strictly below `ceiling`
 *    lowers the target to the hint (a hint at or above `ceiling` is a no-op —
 *    downgrade-only never lets a hint raise the target). `budgetPressure`
 *    then lowers the target one more ordinal level, clamped to the lowest
 *    tier ordinal actually present in `eligibleRefs` (can't force a tier that
 *    doesn't exist in the pool; never raises it back up).
 * 5. Candidates: every ref with `tierOf(ref) <= target`. If that set is empty
 *    (the target is below every tier present, e.g. a hint lower than any
 *    available ref), fall back to every ref `<= ceiling` — i.e. the whole
 *    eligible pool, since `ceiling` is never exceeded regardless. Within
 *    whichever set is used, keep only the refs at the HIGHEST tier present
 *    (the closest available tier to the target from below/at) — the target
 *    is a preference ceiling-within-a-ceiling, not an exact-match
 *    requirement.
 * 6. Tie-break among the finalists — total, deterministic, stable order:
 *    - When BOTH `opts.domain` and `opts.capabilityOf` are present (D-S03-1),
 *      the primary key per finalist is
 *      `capabilityOf(domain, ref) ?? capabilityScore(ref) / STATIC_CAPABILITY_SCALE`
 *      desc, then `costRank` asc, then pool order. The `??` implements the
 *      S02 contract: a matrix miss is "factor absent" for that ref (fall back
 *      to the normalized static profile), never score 0.
 *    - Otherwise: `capabilityScore` desc, then `costRank` asc, then pool
 *      order — the exact pre-S03 comparator, structurally unchanged.
 *
 * Pure: no I/O, never throws.
 */
export function rankPool(eligibleRefs: string[], opts: RankOpts = {}): string | null {
  if (eligibleRefs.length === 0) return null;

  const topRef = eligibleRefs[0];
  const ceilingOrdinal = TIER_ORDINAL[tierOf(topRef)];

  if (isFlatRateProvider(providerOf(topRef))) {
    return topRef;
  }

  let targetOrdinal = ceilingOrdinal;
  if (opts.tierHint !== undefined) {
    const hintOrdinal = TIER_ORDINAL[opts.tierHint];
    if (hintOrdinal < ceilingOrdinal) targetOrdinal = hintOrdinal;
  }

  if (opts.budgetPressure) {
    const minOrdinalInPool = eligibleRefs.reduce(
      (min, ref) => Math.min(min, TIER_ORDINAL[tierOf(ref)]),
      ceilingOrdinal,
    );
    targetOrdinal = Math.max(targetOrdinal - 1, minOrdinalInPool);
  }

  const targetTier = tierAtOrdinal(targetOrdinal);

  let candidates = eligibleRefs.filter((ref) => TIER_ORDINAL[tierOf(ref)] <= TIER_ORDINAL[targetTier]);
  if (candidates.length === 0) {
    candidates = eligibleRefs.filter((ref) => TIER_ORDINAL[tierOf(ref)] <= ceilingOrdinal);
  }

  const bestOrdinal = candidates.reduce((max, ref) => Math.max(max, TIER_ORDINAL[tierOf(ref)]), -1);
  const finalists = candidates.filter((ref) => TIER_ORDINAL[tierOf(ref)] === bestOrdinal);

  if (opts.domain !== undefined && opts.capabilityOf !== undefined) {
    const { domain, capabilityOf } = opts;
    const keyed = finalists.map((ref, idx) => ({
      ref,
      idx,
      key: capabilityOf(domain, ref) ?? capabilityScore(ref) / STATIC_CAPABILITY_SCALE,
    }));
    keyed.sort((a, b) => {
      const keyDiff = b.key - a.key;
      if (keyDiff !== 0) return keyDiff;
      const costDiff = costRank(a.ref) - costRank(b.ref);
      if (costDiff !== 0) return costDiff;
      return a.idx - b.idx;
    });
    return keyed[0].ref;
  }

  const ranked = finalists.map((ref, idx) => ({ ref, idx }));
  ranked.sort((a, b) => {
    const capDiff = capabilityScore(b.ref) - capabilityScore(a.ref);
    if (capDiff !== 0) return capDiff;
    const costDiff = costRank(a.ref) - costRank(b.ref);
    if (costDiff !== 0) return costDiff;
    return a.idx - b.idx;
  });

  return ranked[0].ref;
}
