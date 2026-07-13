/**
 * G1 regression test — proves that `model`/`provider`/`family` are populated
 * on the journal's `unit_dispatched`/`unit_result` events from the EFFECTIVE
 * model, through the real `runForgeLoop → dispatch → decideNextAction →
 * appendEvent` path (fake driver, no real pi session) — and proves the guard:
 * when no model is known, the fields are ABSENT (never synthesized as
 * `""`/`"null"`). This is the demo evidence named by ROADMAP §S01 ("grep no
 * journal mostra a autoria; teste de regressão prova que o campo é populado
 * no caminho real de dispatch").
 *
 * Scaffolding (sandbox/fakeDriver/writeRoadmap/writeSlicePlan/completionSteps/
 * readEvents) mirrors `tests/loop.test.ts` — see that file for the full
 * scenario catalog this one specializes for authorship.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForgeLoop, type SessionDriver } from "../auto/loop.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { updateState } from "../state/store.ts";
import type { StateDoc } from "../state/types.ts";
import type { NextUnit } from "../state/dispatch.ts";
import { unitSlice } from "../state/dispatch.ts";
import type { UnitOutcome } from "../worker/rendezvous.ts";
import { familyOf } from "../state/family.ts";

const MID = "M-toy";

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-authorship-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function milestoneDir(cwd: string): string {
  return join(cwd, ".gsd", "milestones", MID);
}

/** Write ROADMAP with a single pending slice S01 (matches loop.test.ts). */
function writeRoadmap(cwd: string): void {
  writeFileSync(
    join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
    `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | pending |\n`,
  );
}

/** Write S01-PLAN.md + task dirs/plans for the given task ids (simulates the planner). */
function writeSlicePlan(cwd: string, taskIds: string[]): void {
  const slicesDir = join(milestoneDir(cwd), "slices", "S01");
  mkdirSync(slicesDir, { recursive: true });
  writeFileSync(
    join(slicesDir, "S01-PLAN.md"),
    `---\nid: S01\nmilestone: ${MID}\ntitle: "Primeira slice"\n---\n\n# S01 plan\n`,
  );
  for (const t of taskIds) {
    mkdirSync(join(slicesDir, "tasks", t), { recursive: true });
    writeFileSync(
      join(slicesDir, "tasks", t, `${t}-PLAN.md`),
      `---\nid: ${t}\nslice: S01\ntitle: "Task ${t}"\nmust_haves:\n  truths:\n    - "task ${t} does its thing"\n  artifacts: []\n  key_links: []\n---\n\n# ${t}\n`,
    );
  }
}

function writeSliceSummary(cwd: string, slice = "S01"): void {
  writeFileSync(join(milestoneDir(cwd), "slices", slice, `${slice}-SUMMARY.md`), `# ${slice} summary\n`);
}

function writeMilestoneSummary(cwd: string): void {
  writeFileSync(join(milestoneDir(cwd), `${MID}-SUMMARY.md`), `# ${MID} summary\n`);
}

/** The complete-slice + complete-milestone steps the fake driver plays after the tasks. */
function completionSteps(): Step[] {
  return [
    { onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)), outcome: done("slice summary written") },
    { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary written") },
  ];
}

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface Step {
  onDispatch?: (cwd: string, unit: NextUnit, prompt: string) => void;
  outcome: UnitOutcome;
}

function fakeDriver(cwd: string, steps: Step[]): SessionDriver & { prompts: string[]; units: NextUnit[] } {
  const prompts: string[] = [];
  const units: NextUnit[] = [];
  let i = 0;
  return {
    prompts,
    units,
    async dispatch(unit: NextUnit, prompt: string): Promise<UnitOutcome> {
      const step = steps[i++];
      assert.ok(step, `fake driver ran out of scripted steps at dispatch #${i}`);
      prompts.push(prompt);
      units.push(unit);
      step.onDispatch?.(cwd, unit, prompt);
      return step.outcome;
    },
  };
}

function done(summary = "ok"): UnitOutcome {
  return { kind: "result", result: { status: "done", summary, artifacts: [] } };
}

function makeSession(cwd: string): ForgeAutoSession {
  const s = new ForgeAutoSession();
  s.active = true;
  s.cwd = cwd;
  return s;
}

describe("G1 authorship — journal events on the real dispatch path", () => {
  test("known model (flat pref unit_model_execute_task) → unit_dispatched AND unit_result carry model/provider/family", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      // Already planned (skips plan-slice) — the first dispatched unit is the
      // execute-task, which is the only unit type `resolveUnitModel` keys on
      // via `unit_model_execute_task` here (plan-slice's own flat key,
      // `unit_model_plan_slice`, is intentionally NOT set — out of scope for
      // this truth; T02-SUMMARY documents plan-slice uses the same mechanism).
      writeSlicePlan(cwd, ["T01"]);
      writeFileSync(join(cwd, ".gsd", "prefs.md"), "unit_model_execute_task: openai/gpt-5.5\n");

      const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      const expectedFamily = familyOf("openai/gpt-5.5");
      assert.equal(expectedFamily, "gpt", "sanity: familyOf derivation for openai/* is still 'gpt'");

      const events = readEvents(cwd);

      const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
      assert.equal(dispatched.model, "openai/gpt-5.5");
      assert.equal(dispatched.provider, "openai");
      assert.equal(dispatched.family, expectedFamily);

      const result = events.find((e) => e.kind === "unit_result" && e.task === "T01");
      assert.ok(result, "unit_result for the execute-task (T01) exists in the journal");
      assert.equal(result.model, "openai/gpt-5.5");
      assert.equal(result.provider, "openai");
      assert.equal(result.family, expectedFamily);
    });
  });

  test("no known model (no pref, no cmdCtx/baseline) → unit_dispatched AND unit_result have NO model/provider/family fields (guard)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      // Deliberately no `.gsd/prefs.md` and a raw `makeSession` (no cmdCtx, no
      // baselineModel) — `effectiveModelFor` returns `{ model: null, provider:
      // null }`, so neither `dispatchedEvent` nor `makeEvent` should set the
      // authorship fields at all (not `""`/`"null"` — genuinely absent keys).

      const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      const events = readEvents(cwd);

      const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
      assert.equal(dispatched.model, undefined, "guard: no synthesized model on unit_dispatched");
      assert.equal(dispatched.provider, undefined, "guard: no synthesized provider on unit_dispatched");
      assert.equal(dispatched.family, undefined, "guard: no synthesized family on unit_dispatched");
      assert.ok(!("model" in dispatched), "the model key is genuinely absent, not just undefined-valued");

      const result = events.find((e) => e.kind === "unit_result" && e.task === "T01");
      assert.ok(result, "unit_result for the execute-task (T01) exists in the journal");
      assert.equal(result.model, undefined, "guard: no synthesized model on unit_result");
      assert.equal(result.provider, undefined, "guard: no synthesized provider on unit_result");
      assert.equal(result.family, undefined, "guard: no synthesized family on unit_result");
      assert.ok(!("model" in result), "the model key is genuinely absent, not just undefined-valued");
    });
  });
});
