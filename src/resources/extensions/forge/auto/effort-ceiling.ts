/**
 * `auto/effort-ceiling.ts` — S09/T03: the production, best-effort source for
 * `rankUnion`'s (`model-rank-union.ts`) ε-group clamp-penalty tie-break
 * (S09-PLAN decision 4): "entregabilidade de effort = observação
 * journalada, nunca heurística". `effort_clamped` is stamped on the
 * `unit_result`/`unit_timeout` journal event (`housekeeping.ts:704`, format
 * `"<pedido>→<efetivo>"`, e.g. `"high→medium"`) by the `session_start` hook
 * observing what the HOST actually delivered for the model/provider ref
 * that ran (`register-extension.ts`) — never predictable from a static
 * table.
 *
 * Read side (`observedEffortCeilings`, fs) is deliberately separate from the
 * lookup side (`effortCeilingFor`, pure) — same split as
 * `capability-matrix.ts`'s `readCapabilities`/`capabilityFor`: the call-site
 * (`auto/driver.ts`'s `resolveDispatchAuthor`) pre-resolves the map ONCE and
 * injects a pure lookup into `rankUnion` via `ResolveModelCtx.effortCeilingOf`
 * — `rankUnion` itself never reads the filesystem.
 *
 * Cost note: reads the WHOLE journal (`state/store.ts`'s `readEvents`, same
 * path/parser every other journal reader uses) rather than tailing — the
 * repo's `.gsd/forge/events.jsonl` is small at S09 scale; a real tail-read
 * would need an index this module deliberately does not build (documented
 * cost, S09-PLAN §Steps 2). Best-effort, total try/catch: any failure
 * (missing file, malformed journal, permission error) degrades to an empty
 * map — "sem observação, nunca inventa penalidade" (S09-PLAN decision 4) —
 * this module never throws, never blocks the dispatch.
 */

import { readEvents } from "../state/index.js";
import { EFFORT_LEVELS, type EffortLevel } from "./effort.js";

/**
 * ref (`provider/model-id`, or bare `provider` when no per-unit model
 * resolved — same convention as `resultAuthor`/`dispatchAuthor` elsewhere in
 * `auto/driver.ts`/`auto/loop.ts`) → most-recently-observed delivered
 * effort ceiling (the EFFECTIVE, post-clamp half of `effort_clamped`'s
 * `"<pedido>→<efetivo>"`).
 */
export type EffortCeilingMap = Map<string, EffortLevel>;

/**
 * Scans `.gsd/forge/events.jsonl` for `effort_clamped` events and records the
 * most recently observed delivered ceiling per ref. Journal order is append
 * order (`readEvents`), so the LAST matching event per ref wins — "o clamp
 * mais recente" (T03-PLAN step 2).
 *
 * An event only contributes when it carries BOTH `effort_clamped` and a
 * derivable ref (`model` preferred, `provider` as fallback — an event with
 * neither authored nothing, so it teaches nothing about a ref's ceiling).
 * The clamp string's EFFECTIVE half can be `"minimal"` (a `ThinkingLevel`
 * with no `EffortLevel` counterpart — `auto/effort.ts`'s `EFFORT_TO_THINKING`
 * never maps INTO it, only a real host clamp produces it) or otherwise
 * malformed; such an event is silently skipped for that ref — "no
 * observation" rather than a fabricated/mistyped ceiling (S09-PLAN decision
 * 4). Total try/catch: any failure anywhere in the scan (a `readEvents`
 * throw, an unexpected shape) degrades to an empty map — never throws,
 * never blocks the dispatch.
 */
export function observedEffortCeilings(cwd: string): EffortCeilingMap {
  const ceilings: EffortCeilingMap = new Map();
  try {
    for (const ev of readEvents(cwd)) {
      const clamped = ev.effort_clamped;
      if (!clamped) continue;
      const ref = ev.model ?? ev.provider;
      if (!ref) continue;
      const arrowIndex = clamped.indexOf("→");
      if (arrowIndex < 0) continue;
      const effective = clamped.slice(arrowIndex + 1);
      if (!EFFORT_LEVELS.has(effective)) continue;
      ceilings.set(ref, effective as EffortLevel);
    }
  } catch {
    return new Map();
  }
  return ceilings;
}

/**
 * Pure lookup injected into `rankUnion`'s `RankUnionOpts.effortCeilingOf`
 * (`model-rank-union.ts`) — `undefined` means "no observation for this ref",
 * never a penalty (S09-PLAN decision 4).
 */
export function effortCeilingFor(ceilings: EffortCeilingMap, ref: string): EffortLevel | undefined {
  return ceilings.get(ref);
}
