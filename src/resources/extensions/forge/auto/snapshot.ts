/**
 * `readSnapshot` — the disk→memory read side of the S03 dispatch loop.
 *
 * It reads the authoritative on-disk state ONCE per loop iteration and assembles
 * the immutable `ForgeSnapshot` that the pure housekeeping brain
 * (`auto/housekeeping.ts`) and the pure dispatch (`state/dispatch.ts` —
 * `deriveNextUnit`) consume. Reading is the ONLY I/O this module performs; it
 * never writes (the store's `updateState` is the single writer, D3).
 *
 * Task-status source of truth (M1 decision, S03-PLAN § B5 design note): the loop
 * NEVER rewrites S##-PLAN.md / T##-PLAN.md — there are no serializers for them.
 * The list of tasks per slice is discovered from the REAL on-disk layout
 * (`.gsd/milestones/<mid>/slices/S##/tasks/T##/T##-PLAN.md`), and each task's
 * STATUS is OVERLAID from the matching STATE unit — STATE.md is authoritative for
 * unit completion. A task with no STATE unit degrades to "pending".
 *
 * Degradation (first run / partial trees): every missing file yields empty
 * defaults instead of throwing, so a fresh milestone (STATE with a milestone id
 * but no ROADMAP/plans yet) still produces a usable snapshot.
 *
 * Pure of the harness runtime: node builtins + the sibling S02 store barrel only.
 * No `@gsd/*` import — exhaustively testable without the harness build.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  readState,
  parseRoadmap,
  parsePlan,
  type StateDoc,
  type RoadmapSlice,
  type PlansBySlice,
  type SlicePlanInfo,
  type TaskState,
} from "../state/index.js";

/** The immutable per-iteration view of on-disk forge state. */
export interface ForgeSnapshot {
  /** The working directory the snapshot was read from. */
  cwd: string;
  /** Active milestone id (from STATE.md `milestone`), or "" on a bare first run. */
  milestoneId: string;
  /** Parsed STATE.md — authoritative for unit status. */
  state: StateDoc;
  /** Parsed ROADMAP "## Slices" table, in execution order. */
  roadmap: RoadmapSlice[];
  /** Per-slice plan info (planned? + tasks with STATE-overlaid status). */
  plans: PlansBySlice;
  /**
   * Whether the milestone's `<mid>-SUMMARY.md` exists on disk. The
   * `complete-milestone` gate in `deriveNextUnit` reads this via
   * `CompletionInfo.milestoneSummaryWritten`. Degrades to false when absent.
   */
  milestoneSummaryWritten: boolean;
  /** Human-readable titles for prompt composition (T02 `composePrompt`). */
  titles: SnapshotTitles;
}

/** Titles harvested for `composePrompt` (never load-bearing for dispatch). */
export interface SnapshotTitles {
  /** First markdown H1 of the ROADMAP, when readable. */
  milestone?: string;
  /** slice id → S##-PLAN title (frontmatter `title`, else first H1). */
  slice: Record<string, string>;
  /** `${slice}/${task}` → T##-PLAN title (frontmatter `title`). */
  task: Record<string, string>;
}

/** Read a UTF-8 file, returning `undefined` when it does not exist. */
function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** List immediate subdirectory names of `dir`, or [] when `dir` is absent. */
function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * The status of a STATE unit matching `id`/`type`, or undefined if none.
 * Task lookups are SLICE-QUALIFIED: task ids (T01…) collide across slices, so
 * an entry only matches when its `slice` stamp equals `sliceId`. Legacy
 * unqualified task entries never match — the same strict rule as
 * `persistedUnitStatus` (housekeeping.ts), fixed together 2026-07-11 after the
 * live M3/S02 incident where this OVERLAY (a second, independent bare-id
 * lookup) made S01's done T01-T04 mark S02's tasks as executed and derive
 * dispatched T05 first.
 */
function unitStatus(
  state: StateDoc,
  id: string,
  type: "slice" | "task",
  sliceId?: string,
): string | undefined {
  return state.units?.find(
    (u) =>
      u.id === id &&
      u.type === type &&
      (type !== "task" || u.slice === sliceId),
  )?.status;
}

/** First markdown H1 (`# ...`) of a document, trimmed, or undefined. */
function firstHeading(md: string | undefined): string | undefined {
  if (!md) return undefined;
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : undefined;
}

/**
 * Read the full on-disk snapshot for `cwd`. Never throws on missing files —
 * absent ROADMAP/plans degrade to empty defaults (first-run friendly).
 */
export function readSnapshot(cwd: string): ForgeSnapshot {
  const state = readState(cwd);
  const milestoneId = state.milestone;

  const titles: SnapshotTitles = { slice: {}, task: {} };
  const plans: PlansBySlice = {};

  if (!milestoneId) {
    // Bare first run: a STATE with no milestone yet. Nothing to overlay.
    return {
      cwd,
      milestoneId: "",
      state,
      roadmap: [],
      plans,
      milestoneSummaryWritten: false,
      titles,
    };
  }

  const milestoneDir = join(cwd, ".gsd", "milestones", milestoneId);

  const roadmapMd = tryRead(join(milestoneDir, `${milestoneId}-ROADMAP.md`));
  const roadmap = roadmapMd ? parseRoadmap(roadmapMd) : [];
  titles.milestone = firstHeading(roadmapMd);

  for (const slice of roadmap) {
    const sliceDir = join(milestoneDir, "slices", slice.id);
    const slicePlanMd = tryRead(join(sliceDir, `${slice.id}-PLAN.md`));

    // "planned" means the worker has broken this slice into tasks — proven by
    // the presence of its S##-PLAN.md on disk.
    const planned = slicePlanMd !== undefined;
    if (slicePlanMd) {
      const slicePlan = parsePlan(slicePlanMd);
      titles.slice[slice.id] = slicePlan.title ?? firstHeading(slicePlanMd) ?? slice.name;
    }

    const tasks: TaskState[] = [];
    const tasksDir = join(sliceDir, "tasks");
    for (const taskDirName of listDirs(tasksDir).sort()) {
      const taskPlanMd = tryRead(join(tasksDir, taskDirName, `${taskDirName}-PLAN.md`));
      // S06 (D-S06-1): a present-but-MALFORMED `must_haves:` makes `parsePlan`
      // (→ `parseMustHaves`) throw. The snapshot must NOT crash on it — that
      // would kill the loop BEFORE the pre-dispatch enforcing guard can read the
      // raw plan text and block the unit cleanly. Degrade a malformed/unreadable
      // task plan to a dir-name-id, `pending` task; the enforcing guard
      // (`enforceExecuteTaskPlan`) then does the blocking. A WELL-FORMED plan is
      // parsed exactly as before (no behavior change on the happy path).
      let taskPlan: ReturnType<typeof parsePlan> | undefined;
      if (taskPlanMd) {
        try {
          taskPlan = parsePlan(taskPlanMd);
        } catch {
          taskPlan = undefined;
        }
      }
      const taskId = taskPlan?.id && taskPlan.id.length > 0 ? taskPlan.id : taskDirName;
      // Overlay: the STATE unit status wins; absent unit ⇒ "pending".
      const status = unitStatus(state, taskId, "task", slice.id) ?? "pending";
      tasks.push({ id: taskId, status });
      if (taskPlan?.title) titles.task[`${slice.id}/${taskId}`] = taskPlan.title;
    }

    // Existence of the slice's SUMMARY gates `complete-slice` in dispatch: once
    // written, the completion unit has produced its artifact. Missing file ⇒
    // false (never throws — `existsSync`).
    const summaryWritten = existsSync(join(sliceDir, `${slice.id}-SUMMARY.md`));

    // Slice status overlay is honored directly by `deriveNextUnit`
    // (`sliceComplete` reads STATE units), so we need not fold it into `plans`.
    const info: SlicePlanInfo = { planned, tasks, summaryWritten };
    plans[slice.id] = info;
  }

  // Milestone-close gate: does `<mid>-SUMMARY.md` exist yet? Missing ⇒ false.
  const milestoneSummaryWritten = existsSync(
    join(milestoneDir, `${milestoneId}-SUMMARY.md`),
  );

  return { cwd, milestoneId, state, roadmap, plans, milestoneSummaryWritten, titles };
}
