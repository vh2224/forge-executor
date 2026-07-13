/**
 * `auto/model-rank-union.ts` — the S09 cross-pool rank: `rankUnion(candidates,
 * opts)` picks the winning ref from the UNION of every pool's already-filtered
 * candidates (adversarial ∩ availability have already run per pool, per the
 * addendum's locked filter order — `S09-PLAN.md` §"Ordem dos filtros"),
 * treating the capability matrix as the PRIMARY ranking factor rather than a
 * finalist-only tie-break (that is `model-rank.ts`'s `rankPool`, D6 — this
 * module is its S09 sibling, not a replacement).
 *
 * Doctrinal difference from `rankPool` (load-bearing, addendum principle 1):
 * the matrix is JUDGMENT here, not a fallback tie-break. A ref absent from
 * the matrix (`capabilityOf` returns `undefined`) is "un-judged" — it NEVER
 * falls back to the static `model-capabilities.ts` profile the way `rankPool`
 * does. Un-judged candidates never beat a scored candidate; they only order
 * among themselves, below every scored candidate, by declared union order.
 *
 * Guard (addendum principle 5): when the union has ZERO candidates with a
 * matrix score for `opts.domain`, `rankUnion` returns `null` — the caller
 * (T02's `resolveModelForRole` wiring) treats `null` as "no coverage" and
 * falls back to the legacy per-pool walk byte-identically. This module never
 * partially judges; either it has ≥1 scored candidate to reason about, or it
 * abstains entirely.
 *
 * Algorithm (S09-PLAN §Decisões de interpretação 1/2/4, T01-PLAN Steps):
 * 1. Score every candidate via `capabilityOf(domain, ref)`. `undefined` =
 *    un-judged (excluded from contention, never defaulted to 0 or a static
 *    profile).
 * 2. Zero scored ⇒ `null` (guard).
 * 3. Among scored candidates, the leader is the maximum score. Candidates
 *    within `EPSILON` (0.05) of the leader form the "ε-group" — a curated
 *    threshold (S09-PLAN decision 1), not a heuristic. Outside the ε-group,
 *    plain score-desc order applies (a >0.05 gap is decisive, full stop).
 * 4. Within the ε-group, score no longer discriminates; the tie-break is:
 *    (i) clamp penalty — when BOTH `opts.requestedEffort` and
 *    `opts.effortCeilingOf` are present, a candidate whose observed ceiling
 *    is ordinally BELOW the requested effort (`EFFORT_ORDINAL`,
 *    `auto/effort.ts`) loses to one that is not clamped (or has no
 *    observation at all — no observation never invents a penalty, S09-PLAN
 *    decision 4); (ii) `costRank` ascending (cheaper wins); (iii)
 *    `(poolIndex, posIndex)` ascending — the union's declared order,
 *    preserved from each pool's post-filter position.
 * 5. `reason` cites the deciding factor in human-auditable prose (addendum
 *    principle 5's `rank_reason`): the winner/runner-up scores, plus a
 *    parenthetical when a tie-break (not raw score) decided.
 *
 * Precondition (same invariant as `rankPool`, S04 Forward Intelligence):
 * `candidates` arrives ALREADY filtered (adversarial ∩ availability, per
 * pool) and ALREADY deduped by the caller — this module never re-filters and
 * assumes no two entries share a `(poolIndex, posIndex)` pair. A duplicate
 * `ref` across distinct positions is not a caller error this module detects;
 * it is simply ranked as two independent candidates (documented, not
 * defended against — see the test suite's "duplicate ref" case).
 *
 * Pure module: no I/O, no `Date`, no `Math.random`, no `fs` import — only
 * `./model-capabilities.js` (`costRank`) and `./effort.js` (`EFFORT_ORDINAL`,
 * both pure siblings already composed by `rankPool`/`resolveUnitEffort`).
 * `capability-matrix.ts` is deliberately NOT imported: the caller
 * pre-resolves the matrix once and injects a pure, pre-bound `capabilityOf`
 * lookup, mirroring the exact discipline `rankPool` already established.
 */

import { costRank } from "./model-capabilities.js";
import { EFFORT_ORDINAL, type EffortLevel } from "./effort.js";

/**
 * One candidate in the cross-pool union: its ref plus the declared position
 * (`poolIndex`, `posIndex`) it held in its ORIGINAL pool, after that pool's
 * adversarial + availability filters already ran. This position is the final
 * desempate — never re-derived, always passed through verbatim by the
 * caller.
 */
export interface UnionCandidate {
  ref: string;
  poolIndex: number;
  posIndex: number;
}

/**
 * `rankUnion` inputs. `domain` and `capabilityOf` are both required — unlike
 * `rankPool`'s optional capability factor, this module IS the judgment path;
 * the caller only invokes it when a domain hint and matrix coverage exist
 * (T02 wires the guard before the call, not inside it).
 *
 * `requestedEffort`/`effortCeilingOf` are optional and travel together: the
 * clamp penalty only engages when BOTH are present (S09-PLAN decision 4).
 * `effortCeilingOf` is a best-effort journal observation, pre-resolved and
 * injected by the caller — this module never reads `events.jsonl`.
 */
export interface RankUnionOpts {
  domain: string;
  capabilityOf: (domain: string, ref: string) => number | undefined;
  requestedEffort?: EffortLevel;
  effortCeilingOf?: (ref: string) => EffortLevel | undefined;
}

/** The winning ref plus the human-auditable reason it won (journaled as `rank_reason`). */
export interface RankUnionResult {
  ref: string;
  reason: string;
}

/**
 * Proximity threshold for the ε-group (S09-PLAN decision 1): two scores with
 * `|Δ| ≤ EPSILON` are "close" — the curated matrix's smallest meaningful
 * curation step. `|Δ| > EPSILON` is decisive on score alone.
 */
export const EPSILON = 0.05;

/**
 * Floating-point slack for the `EPSILON` boundary comparison — scores read
 * from a markdown table (e.g. `0.90 - 0.85`) can land a hair off an exact
 * decimal in IEEE 754. Not exported: an implementation guard, not a policy
 * knob.
 */
const FLOAT_TOLERANCE = 1e-9;

/** Formats a `[0,1]` score for the `reason` string — always 2 decimals, matching the matrix's curated precision. */
function formatScore(score: number): string {
  return score.toFixed(2);
}

interface Scored {
  candidate: UnionCandidate;
  score: number;
}

/**
 * `0` (no penalty) unless BOTH `requestedEffort` and `effortCeilingOf` are
 * present AND `effortCeilingOf(ref)` yields an observed ceiling ordinally
 * BELOW `requestedEffort` — "no observation never invents a penalty"
 * (S09-PLAN decision 4).
 */
function clampPenalty(
  ref: string,
  requestedEffort: EffortLevel | undefined,
  effortCeilingOf: ((ref: string) => EffortLevel | undefined) | undefined,
): 0 | 1 {
  if (requestedEffort === undefined || effortCeilingOf === undefined) return 0;
  const ceiling = effortCeilingOf(ref);
  if (ceiling === undefined) return 0;
  return EFFORT_ORDINAL[ceiling] < EFFORT_ORDINAL[requestedEffort] ? 1 : 0;
}

function orderCompare(a: UnionCandidate, b: UnionCandidate): number {
  const poolDiff = a.poolIndex - b.poolIndex;
  if (poolDiff !== 0) return poolDiff;
  return a.posIndex - b.posIndex;
}

function buildReason(
  domain: string,
  winner: Scored,
  runnerUp: Scored | undefined,
  requestedEffort: EffortLevel | undefined,
  effortCeilingOf: ((ref: string) => EffortLevel | undefined) | undefined,
): string {
  const base = `capability:${domain} ${winner.candidate.ref} ${formatScore(winner.score)}`;
  if (!runnerUp) return base;

  const delta = winner.score - runnerUp.score;
  const decisive = delta > EPSILON + FLOAT_TOLERANCE;
  // Within the ε-group the tie-break (clamp/cost/declared-order) — not score — picked
  // `winner`, so it can sit BELOW `runnerUp` on score; "vs" avoids asserting a capability
  // ordering the scores contradict. Outside the ε-group score alone is decisive, so ">" holds.
  const separator = decisive ? ">" : "vs";
  const withRunnerUp = `${base} ${separator} ${runnerUp.candidate.ref} ${formatScore(runnerUp.score)}`;

  if (decisive) return withRunnerUp;

  const winnerClamp = clampPenalty(winner.candidate.ref, requestedEffort, effortCeilingOf);
  const runnerUpClamp = clampPenalty(runnerUp.candidate.ref, requestedEffort, effortCeilingOf);
  if (winnerClamp !== runnerUpClamp) {
    const ceiling = effortCeilingOf?.(runnerUp.candidate.ref);
    return `${withRunnerUp} (${runnerUp.candidate.ref} clamped ${ceiling})`;
  }

  const costDiff = costRank(winner.candidate.ref) - costRank(runnerUp.candidate.ref);
  if (costDiff !== 0) return `${withRunnerUp} (cost tie-break)`;

  return `${withRunnerUp} (declared-order tie-break)`;
}

/**
 * Picks the winning ref from the cross-pool union `candidates`, or `null`
 * when no candidate carries a matrix score for `opts.domain` (guard — the
 * caller falls back to the legacy per-pool walk). See the module header for
 * the full algorithm. Pure: no I/O, never throws.
 */
export function rankUnion(candidates: UnionCandidate[], opts: RankUnionOpts): RankUnionResult | null {
  const { domain, capabilityOf, requestedEffort, effortCeilingOf } = opts;

  const scored: Scored[] = [];
  for (const candidate of candidates) {
    const score = capabilityOf(domain, candidate.ref);
    if (score !== undefined) scored.push({ candidate, score });
  }

  if (scored.length === 0) return null;

  const leaderScore = scored.reduce((max, s) => Math.max(max, s.score), -Infinity);
  const inBand = (score: number) => leaderScore - score <= EPSILON + FLOAT_TOLERANCE;

  const ordered = [...scored].sort((a, b) => {
    const aInBand = inBand(a.score);
    const bInBand = inBand(b.score);
    if (aInBand !== bInBand) return aInBand ? -1 : 1;
    if (!aInBand) return b.score - a.score;

    const clampDiff =
      clampPenalty(a.candidate.ref, requestedEffort, effortCeilingOf) -
      clampPenalty(b.candidate.ref, requestedEffort, effortCeilingOf);
    if (clampDiff !== 0) return clampDiff;

    const costDiff = costRank(a.candidate.ref) - costRank(b.candidate.ref);
    if (costDiff !== 0) return costDiff;

    return orderCompare(a.candidate, b.candidate);
  });

  const winner = ordered[0];
  const runnerUp = ordered.length > 1 ? ordered[1] : undefined;

  return {
    ref: winner.candidate.ref,
    reason: buildReason(domain, winner, runnerUp, requestedEffort, effortCeilingOf),
  };
}
