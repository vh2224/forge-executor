/**
 * `auto/effort.ts` — the pure core of the effort axis (S01, D-S01-1/D-S01-2):
 * the 5-level effort vocabulary the planner prompt already emits
 * (`prompts/plan-slice.ts:159-163`, `effort: low|medium|high|xhigh|max`), its
 * mapping onto `ThinkingLevel`, the flat `effort_*` prefs surface, and the
 * per-unit resolver with the `effort_max` global ceiling.
 *
 * Everything here is PURE — no file I/O, no session state. The caller (T03's
 * `resolveDispatchAuthor`) does the I/O: `readForgePrefs(cwd)` for the prefs
 * and `effortHintForUnit(cwd, unit)` (`auto/rank-hint.ts`) for the task
 * frontmatter hint, then hands both to `resolveUnitEffort`.
 *
 * D3 is honored: this module only CONSUMES already-parsed flat prefs keys
 * (`effort_planner`, `effort_executor`, `effort_completer`,
 * `effort_reviewer`, `effort_advocate`, `effort_max`) — it adds no parsing of
 * its own, nested or otherwise. Invalid or list-shaped values are tolerated
 * and ignored, never thrown on: an operator typo in prefs must not take the
 * auto loop down.
 *
 * Byte-identity precondition: with no `effort_*` key set and no frontmatter
 * hint, `resolveUnitEffort` returns `undefined` — the caller then has nothing
 * to apply, so `setThinkingLevel` is never called and the no-config dispatch
 * path stays byte-identical to today.
 */

import type { ThinkingLevel } from "@gsd/pi-ai";
import type { ForgePrefs } from "../prefs.js";
import type { Role } from "./role.js";

/** The 5 effort levels of the embedded planner contract (D-S01-2). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Ordinal for the `effort_max` ceiling comparison: `low < medium < high <
 * xhigh < max`. Also the single source of truth `EFFORT_LEVELS` derives from.
 */
export const EFFORT_ORDINAL: Record<EffortLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

/** Validation set over the 5 declared levels — used by readers (`effortHintForUnit`) and the prefs parser below. */
export const EFFORT_LEVELS: ReadonlySet<string> = new Set(Object.keys(EFFORT_ORDINAL));

/**
 * `EffortLevel → ThinkingLevel` (D-S01-2). There is no thinking level "max",
 * so `max→"xhigh"`; `"minimal"` is only ever reachable via the model-capability
 * clamp, never through this map.
 */
export const EFFORT_TO_THINKING: Record<EffortLevel, ThinkingLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/** Function form of `EFFORT_TO_THINKING` for call-sites that prefer it. */
export function effortToThinkingLevel(level: EffortLevel): ThinkingLevel {
  return EFFORT_TO_THINKING[level];
}

/**
 * The flat prefs keys, one per `Role` (D-S01-1). `effort_reviewer` and
 * `effort_advocate` are accepted forward-compat — those roles have no
 * dispatch entry today (S04 decisão B) but a resolution body, so a caller
 * that passes the role directly still gets its default.
 */
const EFFORT_ROLE_KEYS: ReadonlyArray<readonly [Role, string]> = [
  ["planner", "effort_planner"],
  ["executor", "effort_executor"],
  ["completer", "effort_completer"],
  ["reviewer", "effort_reviewer"],
  ["advocate", "effort_advocate"],
];

/** The effort-relevant slice of the prefs, validated. */
export interface EffortPrefs {
  byRole: Partial<Record<Role, EffortLevel>>;
  max?: EffortLevel;
}

/**
 * Narrows a raw prefs value to an `EffortLevel`. A value outside the 5-level
 * vocabulary, a dash-list (`string[]`), or an absent key all yield
 * `undefined` — tolerated, never thrown on.
 */
function asEffortLevel(value: string | string[] | undefined): EffortLevel | undefined {
  return typeof value === "string" && EFFORT_LEVELS.has(value) ? (value as EffortLevel) : undefined;
}

/**
 * Extracts the validated effort surface from already-parsed flat prefs
 * (`readForgePrefs(...).prefs`). Purely a projection — no I/O, no defaults
 * invented: a role with no valid `effort_<role>` key simply has no entry in
 * `byRole`, and an invalid `effort_max` means no ceiling.
 */
export function effortPrefsFor(prefs: ForgePrefs): EffortPrefs {
  const byRole: Partial<Record<Role, EffortLevel>> = {};
  for (const [role, key] of EFFORT_ROLE_KEYS) {
    const level = asEffortLevel(prefs[key]);
    if (level) byRole[role] = level;
  }
  return { byRole, max: asEffortLevel(prefs.effort_max) };
}

/** A resolved effort plus the human-auditable trail of WHY (journaled as `effort_reason`, D-S01-3). */
export type ResolvedEffort = { level: EffortLevel; reason: string };

/**
 * Resolves the effort for one unit dispatch. Precedence: task frontmatter
 * hint (`taskHint`, pre-read by the caller via `effortHintForUnit`) >
 * `effort_<role>` prefs default > `undefined` (nothing to apply — the
 * byte-identity precondition).
 *
 * When `effort_max` is set and the picked level sits ABOVE it, the level is
 * capped down to the ceiling and the demotion is recorded in the reason
 * (e.g. `"task-frontmatter; capped high→medium by effort_max"`). A ceiling
 * at or above the picked level has no effect and leaves the reason untouched.
 */
export function resolveUnitEffort(args: {
  taskHint?: EffortLevel;
  role: Role;
  prefs: ForgePrefs;
}): ResolvedEffort | undefined {
  const { byRole, max } = effortPrefsFor(args.prefs);

  let level: EffortLevel;
  let reason: string;
  if (args.taskHint) {
    level = args.taskHint;
    reason = "task-frontmatter";
  } else {
    const roleDefault = byRole[args.role];
    if (!roleDefault) return undefined;
    level = roleDefault;
    reason = `role-default:${args.role}`;
  }

  if (max !== undefined && EFFORT_ORDINAL[level] > EFFORT_ORDINAL[max]) {
    reason += `; capped ${level}→${max} by effort_max`;
    level = max;
  }

  return { level, reason };
}
