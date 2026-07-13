/**
 * S03/T01 contract test — `domainHintForUnit` (`auto/rank-hint.ts`), the
 * third frontmatter hint reader.
 *
 * Sandbox coverage (scratch dir with `.gsd/STATE.md` + T##-PLAN.md, mirroring
 * `effort.test.ts`): a valid value is returned trimmed + lowercased; a
 * quoted value with surrounding spaces is trimmed by the reader (the
 * frontmatter parser preserves a quoted scalar's inner spaces); an empty
 * value, a missing field, a missing plan file, a missing STATE.md, and every
 * non-execute-task unit all degrade to `undefined` — never throw.
 *
 * Deliberately NO invalid-vocabulary case (the deliberate difference from
 * `tierHintForUnit`/`effortHintForUnit`, D-S03-4): the domain vocabulary is
 * open, so an arbitrary value like `quantum-basketry` is a VALID hint here —
 * "unknown domain ⇒ no effect on rank" is delivered by `capabilityFor`'s
 * matrix miss (S02), not by this reader.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextUnit } from "../state/dispatch.ts";
import { updateState } from "../state/store.ts";
import { domainHintForUnit, effortHintForUnit, tierHintForUnit } from "../auto/rank-hint.ts";

function withScratchDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-domain-hint-test-"));
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

describe("domainHintForUnit — open-vocabulary reader, trim + lowercase normalization (D-S03-4)", () => {
  test("returns the declared domain lowercased", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "domain: Backend\n");

      assert.equal(domainHintForUnit(cwd, EXECUTE_TASK), "backend");
    });
  });

  test("trims a quoted value whose surrounding spaces the parser preserves", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", 'domain: " infra "\n');

      assert.equal(domainHintForUnit(cwd, EXECUTE_TASK), "infra");
    });
  });

  test("an arbitrary unknown domain flows through — no valid-value set", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "domain: Quantum-Basketry\n");

      assert.equal(domainHintForUnit(cwd, EXECUTE_TASK), "quantum-basketry");
    });
  });

  test("returns undefined for an empty domain value", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "domain:\n");

      assert.equal(domainHintForUnit(cwd, EXECUTE_TASK), undefined);
    });
  });

  test("returns undefined for a plan with no domain field", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "");

      assert.equal(domainHintForUnit(cwd, EXECUTE_TASK), undefined);
    });
  });

  test("returns undefined (never throws) when the plan file is missing", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));

      assert.doesNotThrow(() => domainHintForUnit(cwd, EXECUTE_TASK));
      assert.equal(domainHintForUnit(cwd, EXECUTE_TASK), undefined);
    });
  });

  test("returns undefined (never throws) when no STATE.md exists on disk", () => {
    withScratchDir((cwd) => {
      assert.doesNotThrow(() => domainHintForUnit(cwd, EXECUTE_TASK));
      assert.equal(domainHintForUnit(cwd, EXECUTE_TASK), undefined);
    });
  });

  test("returns undefined for every non-execute-task unit without touching disk", () => {
    withScratchDir((cwd) => {
      assert.equal(domainHintForUnit(cwd, PLAN_SLICE), undefined);
      assert.equal(domainHintForUnit(cwd, COMPLETE_SLICE), undefined);
      assert.equal(domainHintForUnit(cwd, COMPLETE_MILESTONE), undefined);
    });
  });

  test("domain, tier and effort hints coexist on the same plan and stay independent", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "tier: heavy\neffort: low\ndomain: Frontend\n");

      assert.equal(tierHintForUnit(cwd, EXECUTE_TASK), "heavy");
      assert.equal(effortHintForUnit(cwd, EXECUTE_TASK), "low");
      assert.equal(domainHintForUnit(cwd, EXECUTE_TASK), "frontend");
    });
  });
});
