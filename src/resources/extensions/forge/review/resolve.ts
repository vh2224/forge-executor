/**
 * Forge review — `resolveReview`, the pure heart of the dialectic resolution
 * machine (the native port of the forge 1.0 review gate, Step 5 truth table plus
 * the deterministic semantics of the `Engine workflow` script).
 *
 * Source (rewritten in the forge namespace — never imported from the condemned
 * `gsd/` tree): `shared/forge-review.md` Step 5 (advocate verdict x reviewer
 * rebuttal truth table) and the in-script normalizations of the `Engine
 * workflow` block: open/maintained defaults, duplicate-advocate-first-kept,
 * last-round-wins, `noFlags` for an empty objection set.
 *
 * KEPT (native parity):
 *   - the exact truth table: advocate `conceded` wins outright; else rebuttal
 *     `withdrawn` resolves; else the item is OPEN.
 *   - defaults: an objection with no advocate verdict is treated as `open`
 *     ("defesa indisponivel"); with no rebuttal verdict (or rounds == 0) as
 *     `maintained` (conservative).
 *   - duplicate advocate verdict for the same id -> first occurrence kept, a
 *     warning is recorded.
 *   - only the last rebuttal round that carries a verdict for an id counts
 *     (last-round-wins).
 *   - a verdict whose id is not among the objections -> ignored, a warning.
 *   - zero objections -> `noFlags` (the NO_FLAGS path of Step 2).
 *
 * DROPPED / DEFERRED (belongs to the orchestrator, not this pure machine):
 *   - dispatching the challenger/advocate/rebuttal agents (Steps 2-4).
 *   - render/persist of the review artifact, write-backs, event log, triage.
 *   - the `Date`-stamped `Reviewed:` line (injected by the caller downstream).
 *
 * This module is a PURE function: no filesystem/OS access, no `Date`, no
 * `Math.random`, no `@gsd/*` import — the same inputs always yield the same
 * output (parity with the forge 1.0 engine-workflow prohibition on
 * `Date.now()`/`new Date()`/`Math.random()`). All I/O lives in the caller; the
 * writer half arrives in T03. That separation is what makes the truth table
 * exhaustively unit-testable without the harness build.
 */

/** Severity buckets a challenger assigns to an objection (Step 2 output). */
export type ObjectionSeverity = "critical" | "high" | "medium" | "low";

/** The advocate's per-objection verdict (Step 3). */
export type AdvocateVerdictKind = "refuted" | "conceded" | "open";

/** The reviewer's per-objection rebuttal verdict (Step 4). */
export type RebuttalVerdictKind = "maintained" | "withdrawn" | "conceded";

/** The resolved posture for an objection after the truth table (Step 5). */
export type Resolution = "conceded" | "resolved" | "open";

/**
 * A single objection raised by the challenger. `pathLine` is the `path:line`
 * anchor, `challenge` the one question that decides whether the issue is real.
 */
export interface ReviewObjection {
  id: string;
  pathLine: string;
  severity: ObjectionSeverity;
  claim: string;
  suggestedFix: string;
  challenge: string;
}

/**
 * A per-objection verdict carried by the advocate (defense) or the reviewer
 * (rebuttal). `K` narrows the allowed verdict kind per phase.
 */
export interface ReviewVerdict<K extends string = string> {
  id: string;
  verdict: K;
  rationale: string;
}

/** A verdict paired with its rationale, embedded in a resolved item. */
export interface VerdictRecord<K extends string = string> {
  verdict: K;
  rationale: string;
}

/**
 * A fully resolved objection: the original objection fields plus the advocate
 * defense, the reviewer rebuttal and the computed `resolution`.
 */
export interface ResolvedReviewItem {
  id: string;
  pathLine: string;
  severity: ObjectionSeverity;
  claim: string;
  suggestedFix: string;
  challenge: string;
  defense: VerdictRecord<AdvocateVerdictKind>;
  rebuttal: VerdictRecord<RebuttalVerdictKind>;
  resolution: Resolution;
}

/** Tally of resolved items by posture; `resolved + conceded + open` totals the item count. */
export interface ResolutionCounts {
  resolved: number;
  conceded: number;
  open: number;
}

/** The deterministic output of `resolveReview`. */
export interface ResolveReviewResult {
  /** True only when there were zero objections (the NO_FLAGS path). */
  noFlags: boolean;
  /** One entry per objection, in objection order. */
  items: ResolvedReviewItem[];
  counts: ResolutionCounts;
  /** Non-fatal normalization notes (dedupe, unknown ids). Empty when none. */
  warnings: string[];
}

const DEFENSE_UNAVAILABLE =
  "defesa indisponivel (agent null/throw) — tratada como open";
const REBUTTAL_ABSENT =
  "sem replica (rounds=0 ou agent null/throw) — mantida (conservador)";

/**
 * Resolve every objection into its final posture via the forge 1.0 truth table.
 *
 * @param objections       the challenger's objections (Step 2). Empty -> noFlags.
 * @param defenseVerdicts  the advocate's verdicts (Step 3), one per objection id.
 *                         Duplicates: first occurrence kept + warning. Unknown
 *                         ids: ignored + warning. Missing: default `open`.
 * @param rebuttalRounds   the reviewer's rebuttal verdicts per round (Step 4),
 *                         outer index = round. Only the last round carrying a
 *                         verdict for an id wins. Missing: default `maintained`.
 * @param rounds           how many rebuttal rounds to apply. Clamped to >= 0
 *                         (0 -> every rebuttal treated as `maintained`).
 *                         Non-integer -> 1 (parity with the 1.0 script).
 *
 * Pure and deterministic: no I/O, no `Date`, no `Math.random`.
 */
export function resolveReview(
  objections: ReviewObjection[],
  defenseVerdicts: ReviewVerdict<AdvocateVerdictKind>[],
  rebuttalRounds: ReviewVerdict<RebuttalVerdictKind>[][],
  rounds: number,
): ResolveReviewResult {
  // (a) NO_FLAGS — zero objections short-circuits the whole machine (Step 2).
  if (objections.length === 0) {
    return {
      noFlags: true,
      items: [],
      counts: { resolved: 0, conceded: 0, open: 0 },
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const objectionIds = new Set(objections.map((o) => o.id));

  // (b) Index the advocate verdicts by id, first-occurrence-kept. A duplicate or
  //     an id that does not belong to any objection is a warning, never fatal.
  const defById = new Map<string, ReviewVerdict<AdvocateVerdictKind>>();
  for (const v of defenseVerdicts) {
    if (!objectionIds.has(v.id)) {
      warnings.push(
        `advocate verdict for unknown id ${v.id} — ignored (no matching objection)`,
      );
      continue;
    }
    if (defById.has(v.id)) {
      warnings.push(
        `duplicate advocate verdict for ${v.id} — first occurrence kept`,
      );
      continue;
    }
    defById.set(v.id, v);
  }

  // (c) Fill the advocate default: an objection with no verdict is `open`.
  for (const o of objections) {
    if (!defById.has(o.id)) {
      defById.set(o.id, {
        id: o.id,
        verdict: "open",
        rationale: DEFENSE_UNAVAILABLE,
      });
    }
  }

  // (d) Rebuttal defaults: every objection starts `maintained` (conservative).
  const rebById = new Map<string, ReviewVerdict<RebuttalVerdictKind>>();
  for (const o of objections) {
    rebById.set(o.id, {
      id: o.id,
      verdict: "maintained",
      rationale: REBUTTAL_ABSENT,
    });
  }

  // (e) Apply the rebuttal rounds in order, last-round-wins. `rounds` is clamped
  //     to >= 0 (a non-integer defaults to 1, parity with the 1.0 script). The
  //     machine accepts N rounds even though the native caller only drives 0..1.
  const n = Number.isInteger(rounds) ? Math.max(rounds, 0) : 1;
  const limit = Math.min(n, rebuttalRounds.length);
  for (let i = 0; i < limit; i++) {
    const round = rebuttalRounds[i];
    if (!round) continue;
    for (const v of round) {
      if (!rebById.has(v.id)) {
        warnings.push(
          `rebuttal verdict for unknown id ${v.id} — ignored (no matching objection)`,
        );
        continue;
      }
      rebById.set(v.id, v); // later round overwrites — last-round-wins
    }
  }

  // (f) Compute the resolution per objection via the exact Step 5 truth table,
  //     preserving objection order, and tally the counts.
  const counts: ResolutionCounts = { resolved: 0, conceded: 0, open: 0 };
  const items: ResolvedReviewItem[] = objections.map((o) => {
    const d = defById.get(o.id)!;
    const r = rebById.get(o.id)!;

    let resolution: Resolution;
    if (d.verdict === "conceded") {
      resolution = "conceded"; // advocate concedes -> action item (any rebuttal)
    } else if (r.verdict === "withdrawn") {
      resolution = "resolved"; // reviewer dropped it -> no action
    } else {
      resolution = "open"; // genuine disagreement -> human decides
    }
    counts[resolution]++;

    return {
      id: o.id,
      pathLine: o.pathLine,
      severity: o.severity,
      claim: o.claim,
      suggestedFix: o.suggestedFix,
      challenge: o.challenge,
      defense: { verdict: d.verdict, rationale: d.rationale },
      rebuttal: { verdict: r.verdict, rationale: r.rationale },
      resolution,
    };
  });

  return { noFlags: false, items, counts, warnings };
}
