/**
 * Forge migrate — status normalizer + `StateDoc.units[]` populator (S03/T03).
 *
 * `state-convert.ts` (S02/T02) deliberately leaves `StateDoc.units[]` empty —
 * "deferido a S03" — because deriving per-slice/per-task status from a forge
 * 1.0 milestone mid-flight needs THREE corroborating disk signals, not one:
 *   - the roadmap checkbox (`Roadmap1xSlice.done`, via `parseRoadmap1x`, T01)
 *   - the `status:` frontmatter field of each `T##-PLAN.md`
 *   - whether the corresponding `S##-SUMMARY.md`/`T##-SUMMARY.md` exists
 *
 * This module cross-checks all three rather than trusting any single one in
 * isolation — a checkbox or frontmatter string alone is not proof of a written
 * artifact, and `deriveNextUnit` (state/dispatch.ts) treats a `done` slice/task
 * unit as "never touch this again": a false `done` here silently drops
 * pending work, which is why every fallback below is `pending`, never `done`.
 *
 * Slice-scoped task directories (`slices/S##/tasks/T##/`) use the SHORT `T##`
 * label, not the `T-<timestamp>`/`TASK-###` shapes `state/ids.ts:isValid`/
 * `entityKind` recognize — those two only cover top-level milestone/task IDs
 * (see the same documented gotcha in `memory/memory-store.ts` and
 * `gates/checker-memory.ts`). Enumeration here instead reuses the `/^T\d+$/`
 * convention already established by `gates/plan-checker.ts` and
 * `verify/verify-slice.ts` for this exact directory shape.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` runtime import.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatter, parseFrontmatterMap } from "../../shared/frontmatter.js";
import { parseRoadmap1x, type Roadmap1xSlice } from "./roadmap-layout.js";
import { updateState } from "../state/store.js";
import type { StateUnit, UnitStatus } from "../state/types.js";

/**
 * forge 1.0 status vocabulary → the 2.0 `UnitStatus` enum. Keys are already
 * lowercased (callers must `.toLowerCase().trim()` before lookup). Provenance
 * (grep real, not guessed): `status: DONE` is the observed real value in
 * `T##-PLAN.md` fixtures (`~/Documents/dev/forge-agent/.gsd/milestones/M002`);
 * `blocked`/`partial`/`running`/`in_progress`/`planned` are documented 1.0
 * vocabulary in skills/agents even where no fixture exercises them.
 */
export const STATUS_MAP: Record<string, UnitStatus> = {
  done: "done",
  blocked: "blocked",
  partial: "partial",
  running: "running",
  in_progress: "running",
  planned: "pending",
  pending: "pending",
  "": "pending",
};

/** Slice-scoped task directory label (`T01`, `T02`, …) — see module gotcha above. */
const TASK_DIR = /^T\d+$/;

function milestoneDir(cwd: string, milestoneId: string): string {
  return join(cwd, ".gsd", "milestones", milestoneId);
}

function sliceDir(cwd: string, milestoneId: string, sliceId: string): string {
  return join(milestoneDir(cwd, milestoneId), "slices", sliceId);
}

/** List `T##` task directories under a slice, sorted in numeric order. Missing/unreadable `tasks/` → `[]`, never throws. */
function listTaskDirs(cwd: string, milestoneId: string, sliceId: string): string[] {
  const tasksDir = join(sliceDir(cwd, milestoneId, sliceId), "tasks");
  if (!existsSync(tasksDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => TASK_DIR.test(e))
    .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
}

/** Extract the `status:` frontmatter field of a `T##-PLAN.md`. Absent/unreadable content degrades to `""`. */
function readTaskStatus(raw: string): string {
  const [fmLines] = splitFrontmatter(raw);
  if (!fmLines) return "";
  const map = parseFrontmatterMap(fmLines);
  return typeof map.status === "string" ? map.status : "";
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Derive one task unit's status from its `T##-PLAN.md` frontmatter `status:`,
 * corroborated by `T##-SUMMARY.md` existence. An unrecognized status string
 * falls back to `pending` and pushes an explicit warning (unit id + raw
 * string) — it never throws, never infers `done`. A recognized `done` is
 * downgraded to `partial` when `T##-SUMMARY.md` is missing: the 1.0 workflow
 * never marks `DONE` without writing the artifact, so an isolated frontmatter
 * `done` with no SUMMARY is a stronger signal of "interrupted mid-write" than
 * "genuinely complete".
 */
function deriveTaskUnit(
  cwd: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  warnings: string[],
): StateUnit {
  const taskDir = join(sliceDir(cwd, milestoneId, sliceId), "tasks", taskId);
  const planRaw = readFileOrEmpty(join(taskDir, `${taskId}-PLAN.md`));
  const rawStatus = readTaskStatus(planRaw);
  const key = rawStatus.toLowerCase().trim();

  let status: UnitStatus;
  if (key in STATUS_MAP) {
    status = STATUS_MAP[key];
  } else {
    status = "pending";
    warnings.push(
      `${milestoneId}/${sliceId}/${taskId}: status 1.0 desconhecido "${rawStatus}" — fallback pending`,
    );
  }

  if (status === "done" && !existsSync(join(taskDir, `${taskId}-SUMMARY.md`))) {
    status = "partial";
  }

  return { id: taskId, type: "task", status, slice: sliceId };
}

/**
 * Derive a slice's status. `Roadmap1xSlice.done` (checkbox) is a NECESSARY but
 * not sufficient signal: even when the checkbox is marked, the slice is only
 * `done` when either it owns no task directories on disk, or `S##-SUMMARY.md`
 * exists AND every one of its own task units already resolved to `done`. The
 * last conjunct is not spelled out by the checkbox+SUMMARY rule alone, but is
 * required for correctness — `deriveNextUnit`/`sliceComplete` (state/dispatch.ts)
 * treats a `done` slice unit as "skip forever," so a slice marked done while a
 * child task is merely `running` would silently hide pending work (the exact
 * failure this slice's risk section warns about). Any other combination
 * (checkbox unmarked, or checkbox marked but the corroborating artifact/task
 * completeness is missing) is the fail-safe `pending`.
 */
function deriveSliceStatus(slice: Roadmap1xSlice, taskUnits: StateUnit[], sliceSummaryExists: boolean): UnitStatus {
  if (!slice.done) return "pending";
  if (taskUnits.length === 0) return "done";
  if (!sliceSummaryExists) return "pending";
  return taskUnits.every((t) => t.status === "done") ? "done" : "pending";
}

/**
 * Derive one slice's fail-safe 2.0 status purely from disk (same cross-check
 * as `deriveSliceStatus` above) — reused by `roadmap-convert.ts` (T02) so the
 * converted `<mid>-ROADMAP.md` pipe-table Status column can never disagree
 * with the STATE unit this module writes for the same slice. Before this was
 * shared, `roadmap-convert.ts` trusted the 1.0 checkbox alone: a slice with
 * `[x]` but a missing `S##-SUMMARY.md` got ROADMAP status `done` while its
 * STATE unit got `pending`, and `deriveNextUnit`'s `sliceComplete` (which
 * honors EITHER source) then read the ROADMAP `done` and skipped the slice
 * forever — a false-complete on real migrated data (found by S03/T05's
 * real-fixture dispatch proof, not a synthetic case).
 */
export function computeSliceStatus(cwd: string, milestoneId: string, slice: Roadmap1xSlice): UnitStatus {
  const taskIds = listTaskDirs(cwd, milestoneId, slice.id);
  const taskUnits = taskIds.map((taskId) => deriveTaskUnit(cwd, milestoneId, slice.id, taskId, []));
  const sliceSummaryExists = existsSync(join(sliceDir(cwd, milestoneId, slice.id), `${slice.id}-SUMMARY.md`));
  return deriveSliceStatus(slice, taskUnits, sliceSummaryExists);
}

/**
 * Compute the normalized `StateUnit[]` (slice + task) for a milestone, from
 * its `<mid>-ROADMAP.md` (forge 1.0 prose+checkbox, via `parseRoadmap1x` — T01)
 * plus on-disk `T##-PLAN.md`/`*-SUMMARY.md` signals. Pure read: never writes,
 * never throws — an absent/unreadable roadmap degrades to `{ units: [],
 * warnings: [] }`.
 */
export function computeUnitsConversion(cwd: string, milestoneId: string): { units: StateUnit[]; warnings: string[] } {
  const roadmapPath = join(milestoneDir(cwd, milestoneId), `${milestoneId}-ROADMAP.md`);
  const raw = readFileOrEmpty(roadmapPath);
  const slices = raw ? parseRoadmap1x(raw) : [];

  const units: StateUnit[] = [];
  const warnings: string[] = [];

  for (const slice of slices) {
    const taskIds = listTaskDirs(cwd, milestoneId, slice.id);
    const taskUnits = taskIds.map((taskId) => deriveTaskUnit(cwd, milestoneId, slice.id, taskId, warnings));
    const sliceSummaryExists = existsSync(join(sliceDir(cwd, milestoneId, slice.id), `${slice.id}-SUMMARY.md`));

    units.push({ id: slice.id, type: "slice", status: deriveSliceStatus(slice, taskUnits, sliceSummaryExists) });
    units.push(...taskUnits);
  }

  return { units, warnings };
}

/**
 * Apply `computeUnitsConversion` to `StateDoc.units[]` via `updateState` — a
 * pure functional merge over whatever the current STATE.md already holds
 * (`milestone`/`phase`/`current_slice`/`next_action`, e.g. already written by
 * `applyStateConversion`, S02/T02), never a substitution. An empty roadmap
 * (no slices found) writes nothing (`written: false`) — there is nothing to
 * populate.
 */
export function applyUnitsConversion(
  cwd: string,
  milestoneId: string,
): { written: boolean; unitCount: number; warnings: string[] } {
  const { units, warnings } = computeUnitsConversion(cwd, milestoneId);
  if (units.length === 0) {
    return { written: false, unitCount: 0, warnings };
  }
  updateState(cwd, (current) => ({ ...current, units }));
  return { written: true, unitCount: units.length, warnings };
}
