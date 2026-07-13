/**
 * Forge migrate — coverage for `units-convert.ts` (S03/T03): `STATUS_MAP`
 * fallback + warning for unrecognized statuses, slice-status derivation
 * (checkbox + SUMMARY existence + all-tasks-done cross-check), task-status
 * derivation (frontmatter `status:` + SUMMARY-existence downgrade), and the
 * non-destructive `applyUnitsConversion` merge via `updateState`.
 *
 * Same one-shot-copy / skip-honest discipline as `migrate-roadmap-convert.test.ts`
 * (T02): the real `~/Documents/dev/forge-agent/.gsd/milestones/M002` fixture
 * is copied (via `cpSync`, recursive) into a `mkdtemp` sandbox and only the
 * sandbox copy is ever read or mutated — the original is never touched.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  cpSync,
  unlinkSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { computeUnitsConversion, applyUnitsConversion, STATUS_MAP } from "../migrate/units-convert.ts";
import { updateState, readState } from "../state/store.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-migrate-units-convert-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function milestoneDir(cwd: string, milestoneId: string): string {
  return join(cwd, ".gsd", "milestones", milestoneId);
}

function writeRoadmap(cwd: string, milestoneId: string, content: string): void {
  const dir = milestoneDir(cwd, milestoneId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${milestoneId}-ROADMAP.md`), content, "utf-8");
}

function writeTaskPlan(
  cwd: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  status: string,
): string {
  const taskDir = join(milestoneDir(cwd, milestoneId), "slices", sliceId, "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  const path = join(taskDir, `${taskId}-PLAN.md`);
  writeFileSync(
    path,
    [`---`, `id: ${taskId}`, `slice: ${sliceId}`, `milestone: ${milestoneId}`, `status: ${status}`, `---`, "", `# ${taskId}`, ""].join("\n"),
    "utf-8",
  );
  return path;
}

function writeTaskSummary(cwd: string, milestoneId: string, sliceId: string, taskId: string): void {
  const taskDir = join(milestoneDir(cwd, milestoneId), "slices", sliceId, "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, `${taskId}-SUMMARY.md`), `---\nid: ${taskId}\n---\n\ndone.\n`, "utf-8");
}

function writeSliceSummary(cwd: string, milestoneId: string, sliceId: string): void {
  const sliceDir = join(milestoneDir(cwd, milestoneId), "slices", sliceId);
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, `${sliceId}-SUMMARY.md`), `---\nid: ${sliceId}\n---\n\ndone.\n`, "utf-8");
}

const SINGLE_SLICE_ROADMAP = [
  "---",
  "id: M999",
  "---",
  "",
  "## Slices",
  "",
  "- [x] **S01: Slice única** `risk:high` `depends:[]`",
  "",
].join("\n");

// ── STATUS_MAP ────────────────────────────────────────────────────────────────

describe("STATUS_MAP", () => {
  test("covers the documented 1.0 vocabulary", () => {
    assert.equal(STATUS_MAP["done"], "done");
    assert.equal(STATUS_MAP["blocked"], "blocked");
    assert.equal(STATUS_MAP["partial"], "partial");
    assert.equal(STATUS_MAP["running"], "running");
    assert.equal(STATUS_MAP["in_progress"], "running");
    assert.equal(STATUS_MAP["planned"], "pending");
    assert.equal(STATUS_MAP["pending"], "pending");
    assert.equal(STATUS_MAP[""], "pending");
  });
});

// ── computeUnitsConversion — synthetic slice+task coverage ─────────────────────

describe("computeUnitsConversion", () => {
  test("one slice+task per roadmap entry / tasks dir — no silent omission", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", SINGLE_SLICE_ROADMAP);
      writeTaskPlan(dir, "M999", "S01", "T01", "DONE");
      writeTaskSummary(dir, "M999", "S01", "T01");
      writeSliceSummary(dir, "M999", "S01");

      const { units, warnings } = computeUnitsConversion(dir, "M999");
      assert.deepEqual(warnings, []);
      assert.equal(units.length, 2);
      assert.deepEqual(units[0], { id: "S01", type: "slice", status: "done" });
      assert.deepEqual(units[1], { id: "T01", type: "task", status: "done", slice: "S01" });
    });
  });

  test("task status is downgraded done→partial when T##-SUMMARY.md is missing", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", SINGLE_SLICE_ROADMAP);
      writeTaskPlan(dir, "M999", "S01", "T01", "DONE");
      // no writeTaskSummary — SUMMARY missing
      writeSliceSummary(dir, "M999", "S01");

      const { units } = computeUnitsConversion(dir, "M999");
      const task = units.find((u) => u.type === "task");
      assert.deepEqual(task, { id: "T01", type: "task", status: "partial", slice: "S01" });

      // Slice itself must NOT be done: its only task isn't done.
      const slice = units.find((u) => u.type === "slice");
      assert.equal(slice?.status, "pending");
    });
  });

  test("unrecognized status string → pending + one warning naming the unit id and raw string", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", SINGLE_SLICE_ROADMAP);
      writeTaskPlan(dir, "M999", "S01", "T01", "WEIRD_1.0_VALUE");
      writeTaskSummary(dir, "M999", "S01", "T01");
      writeSliceSummary(dir, "M999", "S01");

      const { units, warnings } = computeUnitsConversion(dir, "M999");
      const task = units.find((u) => u.type === "task");
      assert.equal(task?.status, "pending");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /M999\/S01\/T01/);
      assert.match(warnings[0], /WEIRD_1\.0_VALUE/);
    });
  });

  test("checkbox marked but no tasks on disk → slice done (no-task slice, e.g. docs-only)", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", SINGLE_SLICE_ROADMAP);
      // no tasks dir at all
      const { units, warnings } = computeUnitsConversion(dir, "M999");
      assert.deepEqual(warnings, []);
      assert.deepEqual(units, [{ id: "S01", type: "slice", status: "done" }]);
    });
  });

  test("checkbox marked, tasks all done, but S##-SUMMARY.md missing → slice pending (fail-safe)", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", SINGLE_SLICE_ROADMAP);
      writeTaskPlan(dir, "M999", "S01", "T01", "DONE");
      writeTaskSummary(dir, "M999", "S01", "T01");
      // no writeSliceSummary
      const { units } = computeUnitsConversion(dir, "M999");
      const slice = units.find((u) => u.type === "slice");
      assert.equal(slice?.status, "pending");
    });
  });

  test("checkbox unmarked → slice pending regardless of task/summary state", () => {
    withSandbox((dir) => {
      const roadmap = SINGLE_SLICE_ROADMAP.replace("[x]", "[ ]");
      writeRoadmap(dir, "M999", roadmap);
      writeTaskPlan(dir, "M999", "S01", "T01", "DONE");
      writeTaskSummary(dir, "M999", "S01", "T01");
      writeSliceSummary(dir, "M999", "S01");

      const { units } = computeUnitsConversion(dir, "M999");
      const slice = units.find((u) => u.type === "slice");
      assert.equal(slice?.status, "pending");
    });
  });

  test("absent ROADMAP.md degrades to empty units/warnings, never throws", () => {
    withSandbox((dir) => {
      const result = computeUnitsConversion(dir, "M999");
      assert.deepEqual(result, { units: [], warnings: [] });
    });
  });

  test("orphan/malformed task dir names (not matching T\\d+) are excluded from enumeration", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", SINGLE_SLICE_ROADMAP);
      writeTaskPlan(dir, "M999", "S01", "T01", "DONE");
      writeTaskSummary(dir, "M999", "S01", "T01");
      writeSliceSummary(dir, "M999", "S01");
      // Orphan dir under tasks/ that isn't a T## shape.
      mkdirSync(join(milestoneDir(dir, "M999"), "slices", "S01", "tasks", "notes"), { recursive: true });

      const { units } = computeUnitsConversion(dir, "M999");
      const taskUnits = units.filter((u) => u.type === "task");
      assert.equal(taskUnits.length, 1);
      assert.equal(taskUnits[0].id, "T01");
    });
  });
});

// ── applyUnitsConversion — merge via updateState, never destructive ────────────

describe("applyUnitsConversion", () => {
  test("empty roadmap (no slices) → written:false, no STATE.md write", () => {
    withSandbox((dir) => {
      const result = applyUnitsConversion(dir, "M999");
      assert.equal(result.written, false);
      assert.equal(result.unitCount, 0);
      assert.equal(existsSync(join(dir, ".gsd", "STATE.md")), false);
    });
  });

  test("writes units[] without clobbering milestone/phase/current_slice/next_action already present", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", SINGLE_SLICE_ROADMAP);
      writeTaskPlan(dir, "M999", "S01", "T01", "DONE");
      writeTaskSummary(dir, "M999", "S01", "T01");
      writeSliceSummary(dir, "M999", "S01");

      // Simulate applyStateConversion (S02/T02) having already written the shell.
      updateState(dir, () => ({
        milestone: "M999",
        phase: "execute-task",
        current_slice: "S01",
        next_action: "algo pendente",
      }));

      const result = applyUnitsConversion(dir, "M999");
      assert.equal(result.written, true);
      assert.equal(result.unitCount, 2);

      const state = readState(dir);
      assert.equal(state.milestone, "M999");
      assert.equal(state.phase, "execute-task");
      assert.equal(state.current_slice, "S01");
      assert.equal(state.next_action, "algo pendente");
      assert.equal(state.units?.length, 2);
    });
  });
});

// ── Real fixture: forge-agent 1.0's M002 (all done) ──────────────────────────

const FORGE_AGENT_ROOT = join(homedir(), "Documents", "dev", "forge-agent");
const M002_DIR = join(FORGE_AGENT_ROOT, ".gsd", "milestones", "M002");
const FORGE_AGENT_SKIP =
  "~/Documents/dev/forge-agent não existe nesta máquina — projeto 1.0 separado, " +
  "fixture só disponível no workspace de desenvolvimento que o tem clonado";

describe("computeUnitsConversion — real fixture (forge-agent 1.0 M002, all done)", { skip: !existsSync(M002_DIR) && FORGE_AGENT_SKIP }, () => {
  test("all 4 slices done, every task reflects its real status: DONE", () => {
    withSandbox((dir) => {
      const destMilestonesDir = join(dir, ".gsd", "milestones");
      mkdirSync(destMilestonesDir, { recursive: true });
      cpSync(M002_DIR, join(destMilestonesDir, "M002"), { recursive: true });

      const { units, warnings } = computeUnitsConversion(dir, "M002");
      assert.deepEqual(warnings, []);

      const sliceUnits = units.filter((u) => u.type === "slice");
      assert.equal(sliceUnits.length, 4);
      assert.deepEqual(
        sliceUnits.map((u) => u.id),
        ["S01", "S02", "S03", "S04"],
      );
      assert.ok(sliceUnits.every((u) => u.status === "done"), "expected all 4 M002 slices status:done");

      const taskUnits = units.filter((u) => u.type === "task");
      assert.ok(taskUnits.length > 0, "expected at least one task unit");
      assert.ok(taskUnits.every((u) => u.status === "done"), "expected every M002 task status:done");
      assert.ok(taskUnits.every((u) => typeof u.slice === "string" && u.slice.length > 0), "every task unit must carry slice:");
    });
  });

  test("adulterated copy: revert one task (remove its SUMMARY, flip status: DONE → RUNNING) — task becomes running, parent slice drops out of done", () => {
    withSandbox((dir) => {
      const destMilestonesDir = join(dir, ".gsd", "milestones");
      mkdirSync(destMilestonesDir, { recursive: true });
      const destM002 = join(destMilestonesDir, "M002");
      cpSync(M002_DIR, destM002, { recursive: true });

      // S01/T01 is real in the M002 fixture (verified during planning). Revert it.
      const t01Dir = join(destM002, "slices", "S01", "tasks", "T01");
      const t01Plan = join(t01Dir, "T01-PLAN.md");
      const t01Summary = join(t01Dir, "T01-SUMMARY.md");
      assert.ok(existsSync(t01Plan) && existsSync(t01Summary), "fixture assumption: S01/T01 exists with PLAN+SUMMARY");

      const planRaw = readFileSync(t01Plan, "utf-8");
      assert.match(planRaw, /^status:\s*DONE\s*$/m);
      writeFileSync(t01Plan, planRaw.replace(/^status:\s*DONE\s*$/m, "status: RUNNING"), "utf-8");
      unlinkSync(t01Summary);

      const { units, warnings } = computeUnitsConversion(dir, "M002");
      assert.deepEqual(warnings, []);

      const t01Unit = units.find((u) => u.type === "task" && u.id === "T01" && u.slice === "S01");
      assert.equal(t01Unit?.status, "running");

      const s01Unit = units.find((u) => u.type === "slice" && u.id === "S01");
      assert.equal(s01Unit?.status, "pending", "S01 must fall out of done — T01 is no longer done");

      // Untouched sibling slices remain done.
      const s02Unit = units.find((u) => u.type === "slice" && u.id === "S02");
      assert.equal(s02Unit?.status, "done");
    });
  });
});
