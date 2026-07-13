/**
 * `auto/reviewer-independence.ts` — pure mechanics of the `reviewer_not_author:
 * family` adversarial invariant (S04): the authorship referent
 * (`authorFamilyForSlice`) plus the two family filter predicates
 * (`excludeAuthorFamily`/`onlyAuthorFamily`) `resolveModelForRole` (T02)
 * composes into the reviewer/advocate resolution, and the constraint gate
 * (`reviewerIndependenceActive`).
 *
 * Pure module, same boundary discipline as `review/resolve.ts` /
 * `state/dispatch.ts`: no filesystem/OS access (no `readEvents`/
 * `readFileSync`), no `Date`, no `Math.random`, no `@gsd/*` (forge-agent-core)
 * import. `authorFamilyForSlice` receives the already-read `ForgeEvent[]`
 * (the caller reads the journal via `readEvents`, S01) rather than reading it
 * itself — the same "resolver puro consultado no dispatch" split S01/S02/S03
 * established.
 *
 * `familyOf` (`state/family.ts`) is the single family-derivation site and is
 * NEVER re-derived here: `authorFamilyForSlice` reads `ev.family` verbatim
 * (already derived once at the journal-recording site, S01 key_decision);
 * `excludeAuthorFamily`/`onlyAuthorFamily` derive a family from a pool *ref*
 * (not an event) via `familyOf` — the one legitimate derivation point in this
 * module (S04-PLAN §Context).
 */

import { familyOf } from "../state/family.js";
import type { ForgeEvent } from "../state/types.js";

/**
 * The two journal event kinds `loop.ts`/`housekeeping.ts` write on the real
 * execute-task dispatch path (S01) — `unit_dispatched` before dispatch,
 * `unit_result` after. Both carry `task`/`slice`/`family` for an
 * `execute-task` unit (never for `plan-slice`/`complete-slice`/
 * `complete-milestone`, which leave `task` unset).
 */
const AUTHORSHIP_EVENT_KINDS: ReadonlySet<string> = new Set(["unit_dispatched", "unit_result"]);

/**
 * Returns the LLM family recorded on the most-recent `execute-task`
 * authorship event for `slice`, or `null` when no such event carries a
 * `family`.
 *
 * An "execute-task authorship event for `slice`" is a `unit_dispatched` or
 * `unit_result` event with `ev.slice === slice` and `ev.task` set (only
 * `execute-task` units populate `task` on these kinds, S01). "Latest wins":
 * `events` is scanned in the append order `readEvents` returns it in — the
 * last matching event that carries a `family` decides.
 *
 * Pure: no I/O, no `Date`, no `Math.random`, never throws.
 */
export function authorFamilyForSlice(events: ForgeEvent[], slice: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!AUTHORSHIP_EVENT_KINDS.has(ev.kind ?? "")) continue;
    if (ev.slice !== slice || ev.task === undefined) continue;
    if (ev.family) return ev.family;
  }
  return null;
}

/**
 * Loose-task counterpart of `authorFamilyForSlice` (S03/T02): a `/forge task`
 * invocation has no `unit_dispatched`/`unit_result` pair to read (S02-PLAN
 * Interpretation Decision 5 — it journals `task_dispatched`/`task_result`
 * instead), so the authorship referent for its review dialectic is derived
 * from that distinct event family.
 *
 * Returns the LLM family recorded on the most-recent `task_dispatched` event
 * for `taskId`'s `task-execute` phase, or `null` when no such event carries a
 * `family`. Deliberately scoped to `unit === "task-execute"` (not
 * `"task-plan"`): the review dialectic reviews the EXECUTED work, so the
 * reviewer must be independent from whichever family authored *that* phase,
 * not the planner. `commands/task-command.ts`'s `journalDispatched` is the
 * only writer of `task_dispatched` and stamps `family` from
 * `resolveDispatchAuthor` at dispatch time; `journalResult` never carries a
 * `family` field, so only `task_dispatched` is a candidate authorship event
 * here (unlike `authorFamilyForSlice`, which also reads `unit_result`).
 *
 * "Latest wins": `events` is scanned in the append order `readEvents` returns
 * it in — the last matching event that carries a `family` decides.
 *
 * Pure: no I/O, no `Date`, no `Math.random`, never throws.
 */
export function authorFamilyForTask(events: ForgeEvent[], taskId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== "task_dispatched" || ev.unit !== "task-execute") continue;
    if (ev.task !== taskId) continue;
    if (ev.family) return ev.family;
  }
  return null;
}

/**
 * Drops every ref whose `familyOf(ref)` equals `authorFamily`, preserving
 * input order. `authorFamily === null` (no known author) is the identity —
 * nothing is excluded.
 *
 * Pure: no I/O, never throws.
 */
export function excludeAuthorFamily(refs: string[], authorFamily: string | null): string[] {
  if (authorFamily === null) return refs;
  return refs.filter((ref) => familyOf(ref) !== authorFamily);
}

/**
 * Keeps only refs whose `familyOf(ref)` equals `authorFamily`, preserving
 * input order. `authorFamily === null` (no known author) returns `[]` — the
 * advocate has no target to resolve toward without a known author.
 *
 * Pure: no I/O, never throws.
 */
export function onlyAuthorFamily(refs: string[], authorFamily: string | null): string[] {
  if (authorFamily === null) return [];
  return refs.filter((ref) => familyOf(ref) === authorFamily);
}

/**
 * Whether the `reviewer_not_author: family` invariant is active for this
 * config, i.e. `constraints['reviewer_not_author'] === 'family'` exactly.
 * Any other value (including absence) leaves `reviewer`/`advocate`
 * resolution degraded to the plain role×pool body (S03) with no adversarial
 * filter — aditive, never a regression of S03.
 */
export function reviewerIndependenceActive(constraints: Record<string, string>): boolean {
  return constraints["reviewer_not_author"] === "family";
}
