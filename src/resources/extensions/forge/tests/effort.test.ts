/**
 * S01/T01 contract test — the pure effort core (`auto/effort.ts`) and the
 * frontmatter reader (`effortHintForUnit`, `auto/rank-hint.ts`).
 *
 * Truth table of `resolveUnitEffort` (every precedence branch, the
 * `effort_max` ceiling capping BOTH a task hint and a role default, a
 * ceiling at/above the pick having no effect, invalid prefs values ignored,
 * total absence → `undefined` — the byte-identity precondition), the 5-level
 * `EffortLevel → ThinkingLevel` map (D-S01-2, `max→xhigh`), and
 * `effortHintForUnit` in a scratch-dir sandbox (valid frontmatter, invalid
 * value, missing plan/STATE, non-execute-task unit — all degrade to
 * `undefined`, never throw), mirroring `role.test.ts`'s `tierHintForUnit`
 * coverage.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextUnit } from "../state/dispatch.ts";
import { updateState } from "../state/store.ts";
import {
  EFFORT_LEVELS,
  EFFORT_ORDINAL,
  EFFORT_TO_THINKING,
  effortToThinkingLevel,
  effortPrefsFor,
  resolveUnitEffort,
  type EffortLevel,
} from "../auto/effort.ts";
import { effortHintForUnit, tierHintForUnit } from "../auto/rank-hint.ts";

function withScratchDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-effort-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePlan(cwd: string, milestone: string, slice: string, task: string, frontmatterExtra: string): void {
  const taskDir = join(cwd, ".gsd", "milestones", milestone, "slices", slice, "tasks", task);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, `${task}-PLAN.md`),
    `---\nid: ${task}\nslice: ${slice}\nmilestone: ${milestone}\n${frontmatterExtra}---\n\n# ${task}\n`,
    "utf-8",
  );
}

const EXECUTE_TASK: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
const PLAN_SLICE: NextUnit = { type: "plan-slice", slice: "S01" };
const COMPLETE_SLICE: NextUnit = { type: "complete-slice", slice: "S01" };
const COMPLETE_MILESTONE: NextUnit = { type: "complete-milestone", milestone: "M-toy" };

describe("effort vocabulary — 5 levels, ordinal, thinking-level map (D-S01-2)", () => {
  test("EFFORT_LEVELS contains exactly the 5 declared levels", () => {
    assert.deepEqual([...EFFORT_LEVELS].sort(), ["high", "low", "max", "medium", "xhigh"]);
  });

  test("EFFORT_ORDINAL orders low < medium < high < xhigh < max", () => {
    assert.ok(EFFORT_ORDINAL.low < EFFORT_ORDINAL.medium);
    assert.ok(EFFORT_ORDINAL.medium < EFFORT_ORDINAL.high);
    assert.ok(EFFORT_ORDINAL.high < EFFORT_ORDINAL.xhigh);
    assert.ok(EFFORT_ORDINAL.xhigh < EFFORT_ORDINAL.max);
  });

  test("effortToThinkingLevel maps all 5 levels (max→xhigh, no thinking 'max')", () => {
    assert.equal(effortToThinkingLevel("low"), "low");
    assert.equal(effortToThinkingLevel("medium"), "medium");
    assert.equal(effortToThinkingLevel("high"), "high");
    assert.equal(effortToThinkingLevel("xhigh"), "xhigh");
    assert.equal(effortToThinkingLevel("max"), "xhigh");
    assert.deepEqual(EFFORT_TO_THINKING, { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" });
  });
});

describe("effortPrefsFor — validated projection of the flat effort_* keys (D-S01-1)", () => {
  test("reads all 5 role keys plus effort_max", () => {
    const { byRole, max } = effortPrefsFor({
      effort_planner: "low",
      effort_executor: "high",
      effort_completer: "medium",
      effort_reviewer: "xhigh",
      effort_advocate: "max",
      effort_max: "xhigh",
    });
    assert.deepEqual(byRole, { planner: "low", executor: "high", completer: "medium", reviewer: "xhigh", advocate: "max" });
    assert.equal(max, "xhigh");
  });

  test("a value outside the 5-level vocabulary is ignored, never thrown on", () => {
    const { byRole, max } = effortPrefsFor({ effort_executor: "turbo", effort_max: "eleven" });
    assert.deepEqual(byRole, {});
    assert.equal(max, undefined);
  });

  test("a dash-list (string[]) value is ignored", () => {
    const { byRole, max } = effortPrefsFor({ effort_executor: ["high", "low"], effort_max: ["max"] });
    assert.deepEqual(byRole, {});
    assert.equal(max, undefined);
  });

  test("empty prefs yield an empty surface", () => {
    assert.deepEqual(effortPrefsFor({}), { byRole: {}, max: undefined });
  });
});

describe("resolveUnitEffort — precedence + effort_max ceiling truth table", () => {
  test("task frontmatter hint wins with reason 'task-frontmatter'", () => {
    const resolved = resolveUnitEffort({ taskHint: "high", role: "executor", prefs: { effort_executor: "low" } });
    assert.deepEqual(resolved, { level: "high", reason: "task-frontmatter" });
  });

  test("no task hint falls back to effort_<role> with reason 'role-default:<role>'", () => {
    const resolved = resolveUnitEffort({ role: "planner", prefs: { effort_planner: "medium" } });
    assert.deepEqual(resolved, { level: "medium", reason: "role-default:planner" });
  });

  test("another role's key does NOT leak into the resolution", () => {
    const resolved = resolveUnitEffort({ role: "executor", prefs: { effort_planner: "high" } });
    assert.equal(resolved, undefined);
  });

  test("no effort_* keys and no frontmatter → undefined (byte-identity precondition)", () => {
    assert.equal(resolveUnitEffort({ role: "executor", prefs: {} }), undefined);
    assert.equal(resolveUnitEffort({ role: "executor", prefs: { mode: "auto" } }), undefined);
  });

  test("effort_max caps a task hint above the ceiling and records the demotion", () => {
    const resolved = resolveUnitEffort({
      taskHint: "high",
      role: "executor",
      prefs: { effort_max: "medium" },
    });
    assert.deepEqual(resolved, { level: "medium", reason: "task-frontmatter; capped high→medium by effort_max" });
  });

  test("effort_max caps a role default above the ceiling and records the demotion", () => {
    const resolved = resolveUnitEffort({
      role: "completer",
      prefs: { effort_completer: "max", effort_max: "low" },
    });
    assert.deepEqual(resolved, { level: "low", reason: "role-default:completer; capped max→low by effort_max" });
  });

  test("effort_max equal to the pick has no effect and leaves the reason untouched", () => {
    const resolved = resolveUnitEffort({ taskHint: "medium", role: "executor", prefs: { effort_max: "medium" } });
    assert.deepEqual(resolved, { level: "medium", reason: "task-frontmatter" });
  });

  test("effort_max above the pick has no effect", () => {
    const resolved = resolveUnitEffort({ taskHint: "low", role: "executor", prefs: { effort_max: "xhigh" } });
    assert.deepEqual(resolved, { level: "low", reason: "task-frontmatter" });
  });

  test("an invalid effort_max is ignored — no ceiling applied", () => {
    const resolved = resolveUnitEffort({ taskHint: "max", role: "executor", prefs: { effort_max: "bogus" } });
    assert.deepEqual(resolved, { level: "max", reason: "task-frontmatter" });
  });

  test("an invalid effort_<role> value resolves as if the key were absent", () => {
    assert.equal(resolveUnitEffort({ role: "executor", prefs: { effort_executor: "turbo" } }), undefined);
  });

  test("a ceiling with no pick still yields undefined (effort_max alone selects nothing)", () => {
    assert.equal(resolveUnitEffort({ role: "executor", prefs: { effort_max: "low" } }), undefined);
  });

  test("cap applies to the effort level pre-thinking-map: max hint under xhigh ceiling stays max-uncapped semantics", () => {
    // `max` (ordinal 4) sits above `xhigh` (3): the ceiling demotes it.
    const resolved = resolveUnitEffort({ taskHint: "max", role: "executor", prefs: { effort_max: "xhigh" } });
    assert.deepEqual(resolved, { level: "xhigh", reason: "task-frontmatter; capped max→xhigh by effort_max" });
  });
});

describe("effortHintForUnit — best-effort reader of the planner's effort frontmatter hint", () => {
  test("returns the declared effort for a plan whose frontmatter carries one", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "effort: xhigh\n");

      assert.equal(effortHintForUnit(cwd, EXECUTE_TASK), "xhigh");
    });
  });

  test("returns undefined for a plan with no effort field", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "");

      assert.equal(effortHintForUnit(cwd, EXECUTE_TASK), undefined);
    });
  });

  test("returns undefined (never throws) for an invalid effort value in the frontmatter", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "effort: turbo\n");

      assert.doesNotThrow(() => effortHintForUnit(cwd, EXECUTE_TASK));
      assert.equal(effortHintForUnit(cwd, EXECUTE_TASK), undefined);
    });
  });

  test("returns undefined (never throws) when no STATE.md / no plan file exists on disk", () => {
    withScratchDir((cwd) => {
      assert.doesNotThrow(() => effortHintForUnit(cwd, EXECUTE_TASK));
      assert.equal(effortHintForUnit(cwd, EXECUTE_TASK), undefined);
    });
  });

  test("returns undefined for every non-execute-task unit without touching disk", () => {
    withScratchDir((cwd) => {
      assert.equal(effortHintForUnit(cwd, PLAN_SLICE), undefined);
      assert.equal(effortHintForUnit(cwd, COMPLETE_SLICE), undefined);
      assert.equal(effortHintForUnit(cwd, COMPLETE_MILESTONE), undefined);
    });
  });

  test("tier and effort hints coexist on the same plan and stay independent", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "tier: heavy\neffort: low\n");

      assert.equal(tierHintForUnit(cwd, EXECUTE_TASK), "heavy");
      assert.equal(effortHintForUnit(cwd, EXECUTE_TASK), "low");
    });
  });
});

describe("resolveUnitEffort exhausts the vocabulary as a task hint", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"] as EffortLevel[]) {
    test(`taskHint '${level}' resolves uncapped when no ceiling is set`, () => {
      const resolved = resolveUnitEffort({ taskHint: level, role: "executor", prefs: {} });
      assert.deepEqual(resolved, { level, reason: "task-frontmatter" });
    });
  }
});
