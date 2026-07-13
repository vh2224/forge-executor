/**
 * `auto/rank-hint.ts` — pure-outward readers of the planner's per-task
 * frontmatter hints on a dispatched unit's T##-PLAN.md:
 *
 * - `tierHintForUnit(cwd, unit)` — the `tier` hint (the contract
 *   `prompts/plan-slice.ts:154-163` already declares —
 *   `tier: light|standard|heavy|max`, optional, default `standard` when
 *   omitted). S05's rank (`model-rank.ts`, T02) consumes the return value via
 *   `ResolveModelCtx.tierHint`.
 * - `effortHintForUnit(cwd, unit)` — the `effort` hint from the same embedded
 *   contract (`effort: low|medium|high|xhigh|max`, D-S01-2). Consumed by the
 *   effort resolver's caller (`resolveUnitEffort`, `auto/effort.ts`) as the
 *   highest-precedence input.
 * - `domainHintForUnit(cwd, unit)` — the `domain` hint (open vocabulary,
 *   lowercase — e.g. `domain: backend`). Unlike its siblings there is NO
 *   valid-value set (D-S03-4, deliberate): the reader only normalizes
 *   (trim + lowercase); an unknown domain flows through and "no effect on
 *   rank" is delivered downstream by `capabilityFor` (S02) returning
 *   `undefined` on a matrix miss — the miss is the tolerance mechanism, not
 *   reader validation. Consumed by the driver as `ResolveModelCtx.domain`.
 *
 * All three share one internal frontmatter reader (`frontmatterHintForUnit`)
 * and the same discipline described below.
 *
 * Mirrors `authorFamilyForSlice`'s discipline (S04,
 * `auto/reviewer-independence.ts`): pre-resolved by the caller, synchronous,
 * called OUTSIDE the `resolveModelForRole` seam — never inside it. The one
 * difference from `authorFamilyForSlice` is that THIS reader does its own
 * file I/O (there is no pre-read `ForgeEvent[]` equivalent for a task plan's
 * frontmatter), so every failure mode — missing STATE.md, missing plan file,
 * unreadable frontmatter, an invalid tier value — degrades to `undefined`
 * rather than throwing. `undefined` means exactly what an omitted `tierHint`
 * means downstream: no hint, rank targets the pool's declared ceiling (S03
 * behavior preserved).
 *
 * Only `execute-task` units have a T##-PLAN.md to read; every other
 * `ComposableUnit` variant (`plan-slice`, `complete-slice`,
 * `complete-milestone`, `research-models`, …) returns `undefined` immediately
 * — there is no per-task tier or effort hint for a unit that is not
 * task-scoped (S04/T03 widened the signatures type-only; the existing
 * `execute-task` narrowing already covers every new variant).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComposableUnit } from "../prompts/compose.js";
import { readState } from "../state/store.js";
import { splitFrontmatter, parseFrontmatterMap } from "../../shared/frontmatter.js";
import { TIER_ORDINAL, type Tier } from "./model-capabilities.js";
import { EFFORT_LEVELS, type EffortLevel } from "./effort.js";

/** The 4 declared `Tier` values, derived from `TIER_ORDINAL` (T01) — the single source of truth. */
const VALID_TIERS: ReadonlySet<string> = new Set(Object.keys(TIER_ORDINAL));

/**
 * Shared body of both hint readers: fetches one raw string-valued
 * frontmatter field off the T##-PLAN.md of the unit under dispatch, or
 * `undefined` when the unit has no plan or the field is absent/illegible.
 * Vocabulary validation stays in each exported reader — this helper only
 * knows how to find and read the plan, not what a legal value is.
 *
 * Path: `.gsd/milestones/<currentMilestoneId>/slices/<unit.slice>/tasks/
 * <unit.task>/<unit.task>-PLAN.md`, mirroring `prompts/compose.ts`'s
 * `execute-task` path-building. `currentMilestoneId` comes from
 * `readState(cwd).milestone` (the same "current milestone" resolution every
 * other call-site uses, e.g. `auto/snapshot.ts`) — an `execute-task` unit
 * under dispatch always belongs to the active milestone.
 *
 * Best-effort at every step: an absent/unreadable STATE.md, an absent
 * milestone id, an absent/unreadable plan file, a plan with no frontmatter,
 * or a non-string field value all degrade to `undefined` — NEVER throws.
 */
function frontmatterHintForUnit(cwd: string, unit: ComposableUnit, field: string): string | undefined {
  if (unit.type !== "execute-task") return undefined;

  try {
    const milestoneId = readState(cwd).milestone;
    if (!milestoneId) return undefined;

    const planPath = join(
      cwd,
      ".gsd",
      "milestones",
      milestoneId,
      "slices",
      unit.slice,
      "tasks",
      unit.task,
      `${unit.task}-PLAN.md`,
    );
    const md = readFileSync(planPath, "utf-8");

    const [fmLines] = splitFrontmatter(md);
    if (!fmLines) return undefined;

    const map = parseFrontmatterMap(fmLines);
    const value = map[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the `tier` frontmatter field off the T##-PLAN.md of the unit under
 * dispatch, or `undefined` when absent, illegible, or outside the 4 declared
 * `Tier`s — see `frontmatterHintForUnit` for the path and degrade discipline.
 */
export function tierHintForUnit(cwd: string, unit: ComposableUnit): Tier | undefined {
  const tier = frontmatterHintForUnit(cwd, unit, "tier");
  return tier !== undefined && VALID_TIERS.has(tier) ? (tier as Tier) : undefined;
}

/**
 * Reads the `effort` frontmatter field off the T##-PLAN.md of the unit under
 * dispatch, or `undefined` when absent, illegible, or outside the 5-level
 * vocabulary (`EFFORT_LEVELS`, D-S01-2) — see `frontmatterHintForUnit` for
 * the path and degrade discipline. `undefined` means exactly what it means
 * downstream in `resolveUnitEffort`: no task hint, fall through to the
 * role's prefs default (or to no effort at all — the byte-identity path).
 */
export function effortHintForUnit(cwd: string, unit: ComposableUnit): EffortLevel | undefined {
  const effort = frontmatterHintForUnit(cwd, unit, "effort");
  return effort !== undefined && EFFORT_LEVELS.has(effort) ? (effort as EffortLevel) : undefined;
}

/**
 * Reads the `domain` frontmatter field off the T##-PLAN.md of the unit under
 * dispatch, trimmed + lowercased, or `undefined` when absent, illegible, or
 * empty after trimming — see `frontmatterHintForUnit` for the path and
 * degrade discipline. Deliberately does NOT validate against a value set
 * (D-S03-4): the domain vocabulary is open, and an unknown value has no
 * effect on rank because `capabilityFor` (S02) misses on it — validation by
 * matrix miss, not by reader. `undefined` means what an omitted domain means
 * downstream: no capability factor, rank behaves exactly as today.
 */
export function domainHintForUnit(cwd: string, unit: ComposableUnit): string | undefined {
  const raw = frontmatterHintForUnit(cwd, unit, "domain");
  const domain = raw?.trim().toLowerCase();
  return domain ? domain : undefined;
}
