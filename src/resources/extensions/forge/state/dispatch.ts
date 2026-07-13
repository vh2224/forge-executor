/**
 * Forge dispatch — `deriveNextUnit`, the pure heart of the S03 orchestration
 * loop.
 *
 * Given a disk-derived snapshot (parsed STATE + roadmap + per-slice plan info)
 * it returns the next unit of work to run, or `null` when everything is done.
 * It is a PURE function: no filesystem/OS access, no `@gsd/*` import, fully
 * deterministic — the same inputs always yield the same output. All I/O
 * (reading STATE/ROADMAP/PLAN files) happens in the caller; this module only
 * decides. That separation is what makes the dispatch table exhaustively
 * unit-testable without the harness build.
 *
 * Dispatch table (evaluated in roadmap order — the first matching branch wins):
 *   (a) first not-done slice that has NO plan yet      → { plan-slice }
 *   (b) a planned, not-done slice with a pending task   → { execute-task }
 *   (c) a planned slice whose tasks are all done        → skip to next slice
 *   (d) no slice matches (a) or (b)                     → null (all done)
 */

import type { StateDoc, RoadmapSlice } from "./types.js";

/** Status of a single task row within a slice plan. */
export interface TaskState {
  id: string;
  status: string;
}

/** Per-slice plan info supplied by the caller (derived from S##-PLAN.md). */
export interface SlicePlanInfo {
  /** Whether an S##-PLAN.md exists (the slice has been broken into tasks). */
  planned: boolean;
  /** The task rows of the slice plan, in execution order. */
  tasks: TaskState[];
  /**
   * Whether the slice's `S##-SUMMARY.md` already exists on disk. When true the
   * `complete-slice` unit has already run (the SUMMARY is its artifact) but the
   * STATE flip may still be pending (the window until T02 migrates the flip onto
   * the completion unit's `done` result). Absent ⇒ treated as false.
   */
  summaryWritten?: boolean;
}

/** Optional completion signals the caller derives from disk (SUMMARY existence). */
export interface CompletionInfo {
  /** Whether the milestone's `<mid>-SUMMARY.md` already exists on disk. */
  milestoneSummaryWritten?: boolean;
}

/** Map of slice id → its plan info. Absent key ⇒ slice not yet planned. */
export type PlansBySlice = Record<string, SlicePlanInfo>;

/** The next unit the loop should run, as decided by `deriveNextUnit`. */
export type NextUnit =
  | { type: "plan-slice"; slice: string }
  | { type: "execute-task"; slice: string; task: string }
  | { type: "complete-slice"; slice: string }
  | { type: "complete-milestone"; milestone: string };

/**
 * Minimal structural shape `unitSlice` accepts (S04/T03, D-S04-2): any
 * dispatched unit that either carries a slice id or does not. Every `NextUnit`
 * AND every `prompts/` `ComposableUnit` satisfies it — deliberately LOCAL and
 * structural so this state/ module never imports from `prompts/` (that would
 * invert the state→prompts layering).
 */
type SliceScopedUnit = { type: string; slice: string } | { type: string };

/**
 * The slice id a unit pertains to, or "" for milestone-level units
 * (`complete-milestone`, which carries a `milestone` id instead of a `slice`)
 * and slice-less repo-level `prompts/` composable units (S04, D-S04-2) — this
 * module stays deliberately generic about which ones (never importing from
 * `prompts/` or naming a specific unit type, S04/T04's hard fronteira: this
 * file must have zero knowledge of any individual composable unit's name).
 * A convenience for the display / event-journal / key call-sites that predate
 * the S03 completion variants and treated every unit as slice-scoped. Behavior
 * for the pre-S03 variants is unchanged (they all carry a `slice`).
 */
export function unitSlice(unit: SliceScopedUnit): string {
  return "slice" in unit ? unit.slice : "";
}

/** A status string that counts as terminal-complete for a unit. */
function isDone(status: string | undefined): boolean {
  return status === "done";
}

/**
 * Return true when the slice is complete according to EITHER the roadmap row or
 * a matching STATE unit — the store may mark a slice done in STATE before the
 * roadmap row is rewritten, so we honor both sources.
 */
export function sliceComplete(slice: RoadmapSlice, state: StateDoc): boolean {
  if (isDone(slice.status)) return true;
  const unit = state.units?.find((u) => u.id === slice.id && u.type === "slice");
  return isDone(unit?.status);
}

/**
 * True when every id in `slice.depends` refers to a roadmap slice that is
 * complete (per `sliceComplete`). A dependency id absent from the roadmap is
 * treated as unsatisfied (never silently ignored). An empty `depends` array
 * is trivially satisfied.
 */
function depsSatisfied(
  slice: RoadmapSlice,
  roadmap: RoadmapSlice[],
  state: StateDoc,
): boolean {
  return slice.depends.every((depId) => {
    const dep = roadmap.find((s) => s.id === depId);
    return dep !== undefined && sliceComplete(dep, state);
  });
}

/**
 * Pure dispatch: derive the next unit of work from a parsed state snapshot.
 * Returns `null` when there is nothing left to do. Honors `RoadmapSlice.depends`
 * topological order: a not-done slice whose deps aren't all complete is
 * skipped in favor of a later (dependency-satisfied) slice. When at least one
 * not-done slice was skipped this way and nothing else was dispatchable, that
 * is a cycle/deadlock — this throws a clear `Error` rather than returning
 * `null` (which callers would otherwise read as a false milestone-complete).
 */
export function deriveNextUnit(
  state: StateDoc,
  roadmap: RoadmapSlice[],
  plans: PlansBySlice = {},
  completion: CompletionInfo = {},
): NextUnit | null {
  const blockedIds: string[] = [];

  for (const slice of roadmap) {
    // (c) already-complete slice → skip to the next roadmap row.
    if (sliceComplete(slice, state)) continue;

    // Honor topological order: a not-done slice with unsatisfied deps is not
    // dispatchable yet — skip it in favor of a later, dependency-satisfied
    // slice (array order does not imply dependency order).
    if (!depsSatisfied(slice, roadmap, state)) {
      blockedIds.push(slice.id);
      continue;
    }

    const info = plans[slice.id];

    // (a) not-done slice with no plan yet → plan it.
    if (!info || !info.planned) {
      return { type: "plan-slice", slice: slice.id };
    }

    // (b) planned slice with a pending task → execute the first one.
    const pending = info.tasks.find((t) => !isDone(t.status));
    if (pending) {
      return { type: "execute-task", slice: slice.id, task: pending.id };
    }

    // (c) planned slice whose tasks are ALL done but the slice isn't yet marked
    // complete in STATE (guaranteed here: `sliceComplete` returned false at the
    // top of the loop). If it has >=1 task and no `S##-SUMMARY.md` yet, the
    // completion unit still owes its artifact → dispatch `complete-slice`.
    if (info.tasks.length > 0 && !info.summaryWritten) {
      return { type: "complete-slice", slice: slice.id };
    }

    // `summaryWritten` already true: the SUMMARY was written but the STATE flip
    // is still pending (the window until T02 migrates the flip onto the
    // completion result). Fall through — `reconcileCompletion`/the flip own it,
    // not the dispatch.
  }

  // A not-done slice was blocked on unsatisfied deps and nothing else was
  // dispatchable. This is EITHER a genuine deadlock (a real dependency cycle
  // among not-done slices, or a dep id absent from the roadmap) OR merely a
  // transient artifact of a STUCK slice (F4: all tasks done but the slice
  // status never flipped to `done`, so a dependent slice is temporarily blocked
  // on it). Only the former is unsolvable.
  if (blockedIds.length > 0) {
    // R4 (M2/S02 review): distinguish the two. A genuine deadlock MUST throw a
    // clear error (callers surface it as a hard block). A stuck-slice-only block
    // MUST return null so the caller's `reconcileCompletion` (housekeeping.ts)
    // can degrade it safely — throwing there was an UNCAUGHT crash of `/forge
    // auto` (forge-command.ts try/finally has no catch), turning a recoverable
    // F4 into a fatal one.
    if (hasUnsolvableDependency(roadmap, state)) {
      throw new Error(
        `deriveNextUnit: dependência insolúvel (ciclo ou dep ausente) entre slices: ${blockedIds.join(", ")}`,
      );
    }
    // Non-cyclic: the block is caused by a stuck/complete-but-unflipped slice,
    // not a real cycle. Return null → reconcileCompletion takes over.
    return null;
  }

  // Every roadmap slice is complete, the milestone hasn't been flipped to `done`
  // yet, and its `<mid>-SUMMARY.md` isn't on disk → the milestone-close unit
  // still owes its artifacts. Dispatch `complete-milestone`. (An empty roadmap
  // is NOT a completed milestone — `every` is vacuously true, so we also require
  // at least one slice before emitting.)
  if (
    roadmap.length > 0 &&
    roadmap.every((s) => sliceComplete(s, state)) &&
    !milestoneComplete(state) &&
    !completion.milestoneSummaryWritten
  ) {
    return { type: "complete-milestone", milestone: state.milestone };
  }

  // (d) no slice needs planning or task execution and the milestone is closed
  // (or its SUMMARY already exists) → everything is done.
  return null;
}

/**
 * True when a STATE unit of type `milestone` is marked done — the milestone has
 * already been flipped/closed, so `complete-milestone` must not be re-emitted.
 */
function milestoneComplete(state: StateDoc): boolean {
  return isDone(state.units?.find((u) => u.type === "milestone")?.status);
}

/**
 * True when the not-done slice dependency graph is genuinely UNSOLVABLE — i.e.
 * a dep id is absent from the roadmap, or there is a real directed cycle among
 * not-done slices (A depends B, B depends A). A slice that is merely STUCK
 * (F4: tasks done, status not flipped) has all its OWN deps already complete, so
 * it contributes no edge into the not-done graph and never forms a cycle — a
 * dependent blocked on it is therefore NOT a deadlock. Pure; no I/O. (R4)
 */
function hasUnsolvableDependency(roadmap: RoadmapSlice[], state: StateDoc): boolean {
  const byId = new Map(roadmap.map((s) => [s.id, s]));
  const notDone = roadmap.filter((s) => !sliceComplete(s, state));
  const notDoneIds = new Set(notDone.map((s) => s.id));

  // Missing dependency among not-done slices → genuinely unsolvable.
  for (const s of notDone) {
    for (const depId of s.depends) {
      if (!byId.has(depId)) return true;
    }
  }

  // Cycle detection (DFS 3-coloring) over the subgraph of not-done slices, with
  // an edge slice → dep for each dep that is itself a not-done slice. A gray
  // (on-stack) neighbor means a back edge → a real cycle.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  let cyclic = false;

  const visit = (id: string): void => {
    color.set(id, GRAY);
    const slice = byId.get(id);
    for (const depId of slice?.depends ?? []) {
      if (!notDoneIds.has(depId)) continue; // edge only into other not-done slices
      const c = color.get(depId) ?? WHITE;
      if (c === GRAY) {
        cyclic = true;
        return;
      }
      if (c === WHITE) {
        visit(depId);
        if (cyclic) return;
      }
    }
    color.set(id, BLACK);
  };

  for (const id of notDoneIds) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id);
    if (cyclic) return true;
  }
  return false;
}
