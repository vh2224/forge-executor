/**
 * `auto/role.ts` — the G2 seam: `resolveModelForRole(role, unit, ctx)`, the
 * single point the dispatch consults to pick a model for a unit, plus the
 * `unitTypeToRole` map that derives a `Role` from `NextUnit['type']`.
 *
 * S03 scope: the body now does the real role×pool resolution — filter the
 * role's ordered candidate pools by availability, rank by pool/pool-list
 * order (rank fino is S05), choose the first available ref. `on_missing_pool`
 * (`degrade+warn` default | `block`) decides what happens when there is no
 * config, no roles entry for `role`, or no available candidate anywhere in
 * the role's pools: `degrade+warn` falls back to the S02 pool-of-one body
 * (`effectiveModelFor` + `familyOf`) and logs a warning; `block` returns a
 * blocked `{ model: null, provider: null, family: null }` the caller can act
 * on. The absent-config case is byte-identical to S02 — `readModelsConfig`
 * degrades to an empty `ModelsConfig` (no pools, no roles, no constraints),
 * which is indistinguishable from "role has no candidates" and always
 * degrades.
 *
 * S04 scope: `Role` widens with `reviewer`/`advocate` (the
 * `reviewer_not_author: family` adversarial invariant). `unitTypeToRole`
 * gains NO new entry — no `NextUnit['type']` dispatches to either role yet
 * (S04-PLAN decisão B); a future switch/exhaustiveness over `Role` must
 * still handle them. Inside the pool walk, when `role` is `reviewer` or
 * `advocate` AND `reviewerIndependenceActive(config.constraints)` AND
 * `ctx.authorFamily` is known (not `null`/`undefined`), each candidate pool
 * is narrowed by the T01 predicate BEFORE the availability filter:
 * `excludeAuthorFamily` for `reviewer`, `onlyAuthorFamily` for `advocate`.
 * Outside that compound condition the pool passes through unfiltered — the
 * S03 body, byte-identical.
 *
 * S05 scope: the "rankear" step stops being pool-order-only. For each
 * candidate pool, AFTER the S04 adversarial filter and the S03 availability
 * filter (order is load-bearing — S04 Forward Intelligence), the winner is
 * `rankPool(eligibleRefs, { tierHint: ctx.tierHint, budgetPressure:
 * ctx.budgetPressure })` (`model-rank.ts`, T02) instead of "first available
 * ref in pool order". `rankPool` never re-filters by availability or family —
 * it only orders the already-filtered set (downgrade-only teto ×
 * tier-hint × budget-pressure × capability/cost tie-break × flat-rate
 * suppression). `ResolveModelCtx` widens ADDITIVELY with `tierHint?: Tier`
 * and `budgetPressure?: boolean`: omitting both reproduces S03/S04 exactly
 * (`rankPool` with no opts returns the pool's declared top ref, same as the
 * old "first available wins"). `driver.ts:149` is untouched this slice —
 * `tierHintForUnit` (`auto/rank-hint.ts`) is the pre-resolved reader that
 * threading the hint into production would call, but it is NOT wired into
 * the real dispatch path yet (S05-PLAN §Notes).
 *
 * M-20260711135806-wiring-multi-llm / S02 / T01 (fail-closed) addition:
 * closes HIGH #2 -- until now, when the S04 adversarial filter emptied every
 * candidate pool, resolution fell open to on_missing_pool's degrade+warn
 * default, which degrades via the S02 pool-of-one body (effectiveModelFor +
 * familyOf) WITHOUT checking whether the degrade target shares the author's
 * family -- a reviewer could silently be routed back to the family it was
 * supposed to exclude. Now, on that same path, when the adversarial filter
 * is active (applyAdversarialFilter), the degrade candidate is computed
 * first and compared against authorFamily via familyOf (the single
 * derivation site, never re-derived here): a collision returns BLOCKED with
 * an ADDITIVE `violation: "reviewer_not_author"` marker and a warn
 * textually distinct from the generic degrade warn (cites the violation and
 * the author family); no collision degrades exactly as before. An explicit
 * `on_missing_pool: "block"` is unaffected -- it still returns the bare
 * BLOCKED (no `violation` marker) before any degrade candidate is even
 * computed, since that block is operator-requested, not a detected
 * adversarial violation (S02-PLAN §"Sinal de violação").
 *
 * S06/T02 addition (diagnostic, purely additive): the walk over
 * `candidatePools` now distinguishes a `poolName` ABSENT from `config.pools`
 * (misconfiguration -- typo/case mismatch) from a `poolName` that EXISTS but
 * whose refs are all filtered out (exhaustion, now). The former fires a named
 * `warnUndefinedPool` (mirroring T01's `models-config.ts` "undefined pool"
 * WARN); the latter stays silent, exactly as before. Neither `ResolveResult`
 * nor any degrade/block/violation branch changes -- the WARN is emitted
 * during the walk, before the pool is read, and the walk falls through to the
 * next candidate exactly as it did when an undefined pool silently became
 * `[]`.
 *
 * S04 do milestone capacidade-esforço (T03, D-S04-2/D-S04-3): the unit
 * parameter of `roleForUnit`/`resolveModelForRole` (and the degrade helpers)
 * widens type-only from `NextUnit` to `ComposableUnit` so the production
 * dispatch spine can route direct-dispatch units (`research-models` first).
 * The `unitTypeToRole` TABLE stays `Record<NextUnit["type"], Role>`
 * (exhaustiveness over the derive preserved); only the LOOKUP goes tolerant
 * (typed partial read + `"executor"` fallback — the semantics the tolerant
 * doc-comment already promised). Zero behavior change on any existing path.
 *
 * S03 do milestone capacidade-esforço: the rank gains the per-domain
 * capability factor. `ResolveModelCtx` widens ADDITIVELY with `domain?:
 * string` (the planner's `domain:` frontmatter hint, pre-resolved by the
 * caller via `domainHintForUnit` — same caller-side discipline as
 * `tierHint`) and `capabilities?: CapabilityMatrix` (test injection seam,
 * D-S03-2). ONLY when `ctx.domain` is present, the body resolves the S02
 * matrix ONCE before the pool walk (`ctx.capabilities ??
 * readCapabilities(ctx.session.cwd)` — synchronous, never throws, same
 * discipline as `ctx.config ?? readModelsConfig`) and injects a pure,
 * pre-bound `capabilityOf` lookup into `rankPool`, which composes it into
 * the finalist tie-break per D-S03-1 (reorder WITHIN the pool's teto —
 * never above it, never resurrecting a filtered ref). With `ctx.domain`
 * absent, NO CAPABILITIES read happens (not even a syscall) and the
 * `rankPool` call is behaviorally identical to S05's. The adversarial →
 * availability → rank filter order is untouched — this scope only widens
 * the opts passed to `rankPool` plus the pre-walk resolution.
 *
 * M-20260712041002-polimento-cockpit / S01 / T02 addition: `Role` widens
 * ADDITIVELY with `researcher` (the `/forge research-models` channel-X/grok
 * role). `unitTypeToRole` gains NO new entry — `research-models` is not a
 * `NextUnit['type']` (it is a direct-dispatch `ComposableUnit`, S04 do
 * milestone capacidade-esforço). Instead, `roleForUnit`'s tolerant LOOKUP
 * consults a small `directDispatchRole` map BEFORE the `"executor"`
 * fallback, mapping `"research-models"` to `"researcher"`. Inside
 * `resolveModelForRole`, when `role === "researcher"` and
 * `config.roles["researcher"]` is `undefined` (the operator has not
 * configured a `researcher:` entry in models.md), the candidate pools are
 * read from `config.roles["executor"] ?? []` instead of `[]` — byte-compat
 * with today's behavior (where `research-models` resolves as `executor` via
 * the old tolerant fallback), since an empty `[]` would otherwise degrade
 * through `on_missing_pool`'s pool-of-one path, which is NOT what happens
 * today. A `researcher:` entry present in config (even `[]`) is honored
 * as-is — only an ABSENT key triggers the fallback. Everything else in the
 * walk (adversarial filter, availability, rank, degrade/block) is untouched.
 *
 * M-20260712170458-cockpit-v2 / S02 / T01 addition: `directDispatchRole`
 * gains `"task-plan": "planner"` -- the planner phase of the repo-level
 * loose task unit (`/forge task "<descricao>"`). `task-execute` deliberately
 * gets NO entry (S02-PLAN Interpretation Decision 4): it falls through the
 * `unitTypeToRole` lookup (a miss, since it is not a `NextUnit['type']`
 * either) and lands on the `"executor"` fallback, which is exactly the role
 * it needs -- the identical pattern `execute-task` itself already uses via
 * `unitTypeToRole`.
 *
 * M-20260712170458-cockpit-v2 / S09 / T02 addition: `resolveModelForRole`
 * gains a cross-pool JUDGMENT mode, guarded structurally ahead of the S03
 * per-pool walk. When `capabilityOf` is defined (i.e. `ctx.domain` is
 * present — the same pre-walk resolution S03 already does), the walk builds
 * the UNION of every candidate pool's already-filtered refs (adversarial ∩
 * availability, per pool, same order as the S03/S04 walk — addendum
 * principle 2, "Ordem dos filtros" — deduped by ref, first occurrence wins)
 * and hands it to `rankUnion` (`model-rank-union.ts`, T01), which treats the
 * capability matrix as the PRIMARY factor rather than a finalist tie-break.
 * A non-null result returns immediately with an ADDITIVE `rank_reason`
 * field (never present outside this branch, never `""`). A `null` result
 * (zero candidates carry a matrix score for the domain) — OR `capabilityOf`
 * itself being `undefined` (no domain hint at all) — falls through
 * UNCHANGED to the S03/S04/S05 per-pool walk below, which stays
 * byte-identical code (S09-PLAN §Decisões de interpretação 2, the guard).
 * The union-construction walk deliberately does NOT call `warnUndefinedPool`
 * — that walk duplicates the pool-resolution step (accepted minimal
 * duplication per T02-PLAN Step 4) but the diagnostic warn fires only from
 * the untouched legacy loop below, so the zero-scored/no-domain guard path
 * emits the exact same warns as before (never doubled by the union scan
 * that preceded it). `ResolveModelCtx` widens ADDITIVELY with
 * `requestedEffort?: EffortLevel` and `effortCeilingOf?: (ref: string) =>
 * EffortLevel | undefined` — both optional pass-throughs into `rankUnion`'s
 * clamp-penalty tie-break (T03 feeds them from a journal scan in
 * production; omitted ⇒ no clamp penalty, S09-PLAN decision 4).
 */

import type { NextUnit } from "../state/dispatch.js";
import type { ComposableUnit } from "../prompts/compose.js";
import { familyOf } from "../state/family.js";
import { effectiveModelFor, type ForgeAutoSession } from "./session.js";
import { readModelsConfig, type ModelsConfig } from "./models-config.js";
import { isModelAvailable, type AvailabilityProbe } from "./availability.js";
import {
  excludeAuthorFamily,
  onlyAuthorFamily,
  reviewerIndependenceActive,
} from "./reviewer-independence.js";
import { rankPool } from "./model-rank.js";
import { providerOf, type Tier } from "./model-capabilities.js";
import { readCapabilities, capabilityFor, type CapabilityMatrix } from "./capability-matrix.js";
import { rankUnion, type UnionCandidate } from "./model-rank-union.js";
import type { EffortLevel } from "./effort.js";

/**
 * The roles a unit can be dispatched under. `reviewer`/`advocate` (S04's
 * `reviewer_not_author` invariant) have a resolution body but no
 * `unitTypeToRole` entry — see below. `researcher` (S01/T02 do
 * polimento-cockpit) is reached only via `directDispatchRole` — no
 * `NextUnit['type']` maps to it either.
 */
export type Role = "planner" | "executor" | "completer" | "reviewer" | "advocate" | "researcher";

/**
 * `NextUnit['type']` → `Role`, exhaustive over the 4 current variants. Used
 * by call-sites to derive the role to pass into `resolveModelForRole`.
 * Deliberately has NO entry for `reviewer`/`advocate` (S04-PLAN decisão B) —
 * no `NextUnit['type']` maps to either role; they are reached only by a
 * caller that already knows it wants adversarial review and passes the role
 * directly.
 */
export const unitTypeToRole: Record<NextUnit["type"], Role> = {
  "plan-slice": "planner",
  "execute-task": "executor",
  "complete-slice": "completer",
  "complete-milestone": "completer",
};

/**
 * `ComposableUnit['type']` values dispatched directly (outside
 * `deriveNextUnit`'s `unitTypeToRole` table) that route to a role other than
 * the `"executor"` fallback. `roleForUnit` consults this BEFORE the
 * `unitTypeToRole` lookup and its fallback — `unitTypeToRole` itself stays
 * exhaustive over `NextUnit["type"]` with no new entry (S01/T02 do
 * polimento-cockpit, same decision as S04-PLAN decisão B for reviewer/advocate).
 */
const directDispatchRole: Partial<Record<string, Role>> = {
  "research-models": "researcher",
  "task-plan": "planner",
  // M-nascimento/S01 recon correction: this once fell through to executor,
  // which also selected executor effort because effort is keyed by role.
  "plan-milestone": "planner",
  // M-nascimento/S02: CONTEXT authorship is a planner unit, not executor work.
  "milestone-context": "planner",
};

/**
 * Tolerant lookup over `unitTypeToRole` (with `directDispatchRole` consulted
 * first) — an unrecognized `unit.type` (future variant, or a malformed value
 * slipping through at a boundary) falls back to `"executor"` rather than
 * throwing. Never lets a role-lookup miss crash the dispatch.
 */
export function roleForUnit(unit: ComposableUnit): Role {
  // S04/T03: the parameter widened to `ComposableUnit`, whose `type` no longer
  // indexes `Record<NextUnit["type"], Role>` — the LOOKUP goes tolerant (typed
  // partial read + fallback, the exact semantics this doc-comment promises)
  // while the TABLE stays exhaustive over `NextUnit["type"]`.
  return (
    directDispatchRole[unit.type] ??
    (unitTypeToRole as Partial<Record<string, Role>>)[unit.type] ??
    "executor"
  );
}

/**
 * The injectable context `resolveModelForRole` reads from — carries at least
 * the live `ForgeAutoSession` so the seam's degrade fallback can delegate to
 * `effectiveModelFor`. S03 widens this ADDITIVELY with the role×pool config
 * and the availability probe: both optional, so every existing caller
 * (`driver.ts`, S02's tests) still type-checks without passing them.
 *
 * - `config` — when omitted, the seam resolves it itself via
 *   `readModelsConfig(ctx.session.cwd)` (synchronous, same discipline as
 *   `readForgePrefs` — no `await` enters the seam). Tests inject it directly
 *   to drive role×pool resolution without a sandbox on disk.
 * - `availabilityProbe` — when omitted, `isModelAvailable` treats every ref
 *   as available (its own default), so the no-probe path never filters
 *   anything out.
 * - `authorFamily` (S04) — the LLM family that authored the slice under
 *   review, injected already-resolved (`authorFamilyForSlice(readEvents(cwd),
 *   slice)` at the call-site that knows the slice, T01) so the seam itself
 *   stays synchronous with no I/O. `undefined` (omitted) and `null` (no known
 *   author) both mean "unknown" and leave reviewer/advocate resolution
 *   unfiltered — only a non-null string activates the adversarial filter.
 * - `tierHint` (S05) — the planner's `tier` frontmatter hint for the
 *   dispatched unit, pre-resolved by the caller (`tierHintForUnit(cwd, unit)`,
 *   `auto/rank-hint.ts`) exactly like `authorFamily` — the seam never reads a
 *   plan file itself. Omitted ⇒ the rank targets the pool's declared ceiling
 *   (S03/S04 byte-identical); `rankPool` is downgrade-only, so a hint can
 *   only lower the pick within the pool's teto, never raise it.
 * - `budgetPressure` (S05) — a synthetic-in-S05 signal (S05-PLAN §Notes) that
 *   forces `rankPool` to downgrade one more tier level within the pool.
 *   Omitted/`false` ⇒ no effect, S03/S04 byte-identical.
 * - `domain` (S03 capacidade-esforço) — the planner's `domain:` frontmatter
 *   hint for the dispatched unit, pre-resolved by the caller
 *   (`domainHintForUnit(cwd, unit)`, `auto/rank-hint.ts`) exactly like
 *   `tierHint` — the seam never reads a plan file itself. Open vocabulary
 *   (D-S03-4). Omitted ⇒ no capability factor AND no CAPABILITIES read at
 *   all — the rank call is byte-identical to today's.
 * - `capabilities` (S03 capacidade-esforço, D-S03-2) — the S02 capability
 *   matrix, injected pre-resolved by tests so they can drive the domain
 *   factor without a sandbox on disk. When omitted AND `domain` is present,
 *   production resolves it once pre-walk via
 *   `readCapabilities(ctx.session.cwd)` (synchronous, never throws — same
 *   discipline as `ctx.config ?? readModelsConfig`). Per the S02 Forward
 *   Intelligence, the call-site pre-resolves the matrix and injects a pure
 *   lookup — `rankPool` never reads the filesystem.
 * - `requestedEffort`/`effortCeilingOf` (S09 cross-pool, T02) — both optional
 *   and travel together into `rankUnion`'s ε-group clamp-penalty tie-break
 *   (`model-rank-union.ts`, T01); the penalty only engages when BOTH are
 *   present (S09-PLAN decision 4). `effortCeilingOf` is a best-effort,
 *   pre-resolved journal lookup (T03 wires a real one in production —
 *   `undefined` for a ref means "no observation", never a penalty); tests
 *   inject both directly. Neither field is read by the S03/S04/S05 legacy
 *   per-pool walk — they only ever reach `rankUnion`.
 */
export interface ResolveModelCtx {
  session: ForgeAutoSession;
  config?: ModelsConfig;
  availabilityProbe?: AvailabilityProbe;
  authorFamily?: string | null;
  tierHint?: Tier;
  budgetPressure?: boolean;
  domain?: string;
  capabilities?: CapabilityMatrix;
  requestedEffort?: EffortLevel;
  effortCeilingOf?: (ref: string) => EffortLevel | undefined;
}

/** Blocked result for `on_missing_pool: block` — never `""`/`"null"` (G1). */
const BLOCKED = { model: null, provider: null, family: null } as const;

/**
 * A resolved model/provider/family, optionally carrying the S02/T01
 * violation marker or (S09/T02) the cross-pool judgment's `rank_reason` —
 * present ONLY when `rankUnion` produced the winner, never `""`.
 */
type ResolveResult = {
  model: string | null;
  provider: string | null;
  family: string | null;
  violation?: "reviewer_not_author";
  rank_reason?: string;
};

/**
 * S02/T01: the pool-of-one degrade CANDIDATE — pure computation via
 * `effectiveModelFor` + `familyOf`, no warn, no side effect. Split out of
 * the old `degradeToPoolOfOne` so the fail-closed collision check can
 * inspect the candidate's family before any warn is chosen/emitted.
 */
function degradeCandidate(
  unit: ComposableUnit,
  ctx: ResolveModelCtx,
): { model: string | null; provider: string | null; family: string | null } {
  const { model, provider } = effectiveModelFor(ctx.session, unit);
  const family = model || provider ? familyOf((model ?? provider) as string) : null;
  return { model, provider, family };
}

/** The generic degrade warn — unchanged text from S02/S03. */
function warnDegradeToPoolOfOne(role: Role): void {
  console.warn(
    `[forge] resolveModelForRole: no available role×pool candidate for role "${role}" — degrading to pool-of-one`,
  );
}

/**
 * S06/T02: mirrors T01's `models-config.ts` "undefined pool" WARN, but fired
 * from the resolve-time walk (a `poolName` in `config.roles[role]` that is
 * NOT a key of `config.pools` — misconfiguration, not exhaustion). Textually
 * distinct from `warnDegradeToPoolOfOne` above.
 */
function warnUndefinedPool(role: Role, poolName: string): void {
  console.warn(
    `[forge] resolveModelForRole: role "${role}" references undefined pool "${poolName}" — check for a typo or case mismatch`,
  );
}

/**
 * S02/T01: the VIOLATION warn — textually distinct from the generic degrade
 * warn above; cites the `reviewer_not_author` violation and the author
 * family the degrade target collided with.
 */
function warnReviewerNotAuthorViolation(role: Role, authorFamily: string | null): void {
  console.warn(
    `[forge] resolveModelForRole: VIOLATION reviewer_not_author — degrade target for role "${role}" would share the author's family "${authorFamily}"; blocking instead of degrading`,
  );
}

/**
 * S09/T02: builds the cross-pool UNION candidate list — one pass over
 * `candidatePools`, applying the SAME per-pool filters as the legacy walk
 * below (adversarial narrowing when active, then `isModelAvailable`), but
 * collecting every surviving ref instead of picking a winner. Dedupe is
 * first-occurrence-wins by ref (addendum principle 2 — the union preserves
 * `(poolIndex, posIndex)` of the first pool/position a ref is seen at).
 * Deliberately does NOT call `warnUndefinedPool` — see the module header's
 * S09/T02 note: that diagnostic fires only from the untouched legacy loop,
 * so the guard fallback (this scan finding zero scored candidates) never
 * double-warns relative to the no-domain path.
 */
function buildCrossPoolUnion(
  role: Role,
  candidatePools: string[],
  config: ModelsConfig,
  applyAdversarialFilter: boolean,
  authorFamily: string | null | undefined,
  availabilityProbe: AvailabilityProbe | undefined,
): UnionCandidate[] {
  const seenRefs = new Set<string>();
  const union: UnionCandidate[] = [];
  candidatePools.forEach((poolName, poolIndex) => {
    let pool = config.pools[poolName] ?? [];
    if (applyAdversarialFilter) {
      pool =
        role === "reviewer"
          ? excludeAuthorFamily(pool, authorFamily ?? null)
          : onlyAuthorFamily(pool, authorFamily ?? null);
    }
    const eligible = pool.filter((ref) => isModelAvailable(ref, availabilityProbe));
    eligible.forEach((ref, posIndex) => {
      if (seenRefs.has(ref)) return;
      seenRefs.add(ref);
      union.push({ ref, poolIndex, posIndex });
    });
  });
  return union;
}

/** The S02 degrade fallback: pool-of-one via `effectiveModelFor` + `familyOf`, with the generic degrade warn. */
function degradeToPoolOfOne(
  role: Role,
  unit: ComposableUnit,
  ctx: ResolveModelCtx,
): { model: string | null; provider: string | null; family: string | null } {
  const candidate = degradeCandidate(unit, ctx);
  warnDegradeToPoolOfOne(role);
  return candidate;
}

/**
 * The G2 seam: the single function the dispatch consults to resolve which
 * model/provider runs `unit`, given its derived `role`.
 *
 * S03 body — role×pool resolution: derive the role's ordered candidate pools
 * from config, walk them in order (pool order, then rank within each pool —
 * S05 fills this step, see below), and choose the winning ref. `provider`
 * is the ref's prefix before `/`; `family` is derived via `familyOf` (the
 * single family-derivation site, S01) — never re-derived ad hoc.
 *
 * When there is no config, no `roles[role]` entry, or no available ref in any
 * candidate pool, `constraints.on_missing_pool` (default `"degrade+warn"`)
 * decides: `"degrade+warn"` falls back to the S02 pool-of-one body (logging a
 * warning); `"block"` returns `{ model: null, provider: null, family: null }`.
 * The no-config case degrades identically to S02, since `readModelsConfig`
 * returns an empty config (no `roles[role]` entry either).
 *
 * S04 addition: when `role` is `reviewer`/`advocate`,
 * `reviewerIndependenceActive(config.constraints)` is true, and
 * `ctx.authorFamily` is a known family (not `null`/`undefined`), each
 * candidate pool is narrowed by the T01 predicate before the availability
 * filter — `excludeAuthorFamily` for `reviewer`, `onlyAuthorFamily` for
 * `advocate`. An emptied pool falls through to the next candidate pool same
 * as an all-unavailable one; if every pool empties out, `on_missing_pool`
 * decides exactly as in S03 — the filter only narrows the eligible set, it
 * never touches the degradation mechanics.
 *
 * S05 addition: the "rankear" step. For each candidate pool, AFTER the S04
 * adversarial narrowing, the eligible refs are collected — every ref of the
 * (possibly adversarially-narrowed) pool that passes `isModelAvailable`,
 * preserving pool order — and `rankPool(eligible, { tierHint, budgetPressure
 * })` (`model-rank.ts`, T02) picks the winner. `rankPool` itself never
 * re-filters by availability or family; it only orders an already-filtered
 * set. A `null` winner (the eligible set was empty) falls through to the
 * next candidate pool, same as S03/S04's "every ref unavailable" case;
 * `on_missing_pool` still decides once every pool is exhausted.
 *
 * S02/T01 addition (fail-closed): an explicit `on_missing_pool: "block"`
 * still short-circuits to the bare `BLOCKED` (no `violation` marker) before
 * any degrade candidate is computed. Otherwise, when `applyAdversarialFilter`
 * is true, the degrade candidate is computed FIRST (no warn yet) and its
 * `family` compared against `authorFamily`: a collision returns `BLOCKED`
 * with `violation: "reviewer_not_author"` and the distinct violation warn,
 * instead of degrading; no collision degrades exactly as S03/S04, with the
 * unchanged generic warn.
 *
 * S01/T02 do polimento-cockpit addition: when `role === "researcher"` and
 * `config.roles["researcher"]` is `undefined`, `candidatePools` reads from
 * `config.roles["executor"] ?? []` instead of `[]` — the rest of the walk
 * (availability, rank, undefined-pool WARN, degrade/block) is unchanged and
 * runs exactly as it would for `role === "executor"` on the same config. A
 * `researcher:` entry present in config (including an empty list) is honored
 * as declared — only an ABSENT key triggers the fallback.
 *
 * S09/T02 addition: BEFORE the walk below, when `capabilityOf` is defined
 * (i.e. `ctx.domain` is present), the cross-pool UNION of every candidate
 * pool's post-filter refs is ranked by `rankUnion` — capability as the
 * PRIMARY factor. A non-null verdict returns immediately with an ADDITIVE
 * `rank_reason`. A `null` verdict (or no domain at all) falls through
 * UNCHANGED to the walk below — see the module header's S09/T02 note for
 * the full guard/byte-identity contract.
 */
export function resolveModelForRole(
  role: Role,
  unit: ComposableUnit,
  ctx: ResolveModelCtx,
): ResolveResult {
  const config = ctx.config ?? readModelsConfig(ctx.session.cwd);
  // S01/T02 do polimento-cockpit: byte-compat fallback — an operator who has
  // not configured `researcher:` in models.md gets the SAME pools `executor`
  // would (not `[]`, which would spuriously degrade+warn pool-of-one). A
  // `researcher:` entry present in config (even `[]`) is honored as declared.
  const candidatePools =
    role === "researcher" && config.roles["researcher"] === undefined
      ? (config.roles["executor"] ?? [])
      : (config.roles[role] ?? []);

  const authorFamily = ctx.authorFamily;
  const applyAdversarialFilter =
    (role === "reviewer" || role === "advocate") &&
    reviewerIndependenceActive(config.constraints) &&
    authorFamily != null;

  // S03 capacidade-esforço (D-S03-2): resolve the capability matrix ONCE,
  // pre-walk, and ONLY when a domain hint is present — an absent domain must
  // not even cost a CAPABILITIES read. Tests inject `ctx.capabilities`;
  // production falls back to the on-disk cascade. The lookup handed to
  // `rankPool` is pure and pre-bound — the rank never touches the fs.
  const capabilities =
    ctx.domain !== undefined ? (ctx.capabilities ?? readCapabilities(ctx.session.cwd)) : undefined;
  const capabilityOf =
    capabilities !== undefined
      ? (d: string, r: string) => capabilityFor(capabilities, d, r)
      : undefined;

  // S09/T02 (addendum principle 1): cross-pool JUDGMENT mode, guarded by
  // `capabilityOf` being defined (which itself implies `ctx.domain` is
  // present — same guard S03 already established). A `null` verdict (zero
  // candidates scored for the domain) falls through UNCHANGED to the
  // S03/S04/S05 per-pool walk below.
  if (capabilityOf !== undefined) {
    const union = buildCrossPoolUnion(
      role,
      candidatePools,
      config,
      applyAdversarialFilter,
      authorFamily,
      ctx.availabilityProbe,
    );
    const judged = rankUnion(union, {
      domain: ctx.domain as string,
      capabilityOf,
      requestedEffort: ctx.requestedEffort,
      effortCeilingOf: ctx.effortCeilingOf,
    });
    if (judged !== null) {
      return {
        model: judged.ref,
        provider: providerOf(judged.ref),
        family: familyOf(judged.ref),
        rank_reason: judged.reason,
      };
    }
  }

  for (const poolName of candidatePools) {
    if (!(poolName in config.pools)) warnUndefinedPool(role, poolName);
    let pool = config.pools[poolName] ?? [];
    if (applyAdversarialFilter) {
      pool =
        role === "reviewer"
          ? excludeAuthorFamily(pool, authorFamily ?? null)
          : onlyAuthorFamily(pool, authorFamily ?? null);
    }
    const eligible = pool.filter((ref) => isModelAvailable(ref, ctx.availabilityProbe));
    const winner = rankPool(eligible, {
      tierHint: ctx.tierHint,
      budgetPressure: ctx.budgetPressure,
      domain: ctx.domain,
      capabilityOf,
    });
    if (winner !== null) {
      const slash = winner.indexOf("/");
      const provider = slash > 0 ? winner.slice(0, slash) : winner;
      return { model: winner, provider, family: familyOf(winner) };
    }
  }

  const onMissingPool = config.constraints["on_missing_pool"] ?? "degrade+warn";
  if (onMissingPool === "block") return BLOCKED;

  if (applyAdversarialFilter) {
    const candidate = degradeCandidate(unit, ctx);
    if (candidate.family !== null && candidate.family === authorFamily) {
      warnReviewerNotAuthorViolation(role, authorFamily ?? null);
      return { ...BLOCKED, violation: "reviewer_not_author" };
    }
    warnDegradeToPoolOfOne(role);
    return candidate;
  }

  return degradeToPoolOfOne(role, unit, ctx);
}
