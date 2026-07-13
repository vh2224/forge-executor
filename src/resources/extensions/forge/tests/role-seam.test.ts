/**
 * G2 seam regression test — proves, on the REAL dispatch path (`runForgeLoop →
 * driver → journal`, fake driver, no real pi session — mirrors
 * `tests/authorship.test.ts`'s scaffolding), that the model recorded as
 * authorship for a unit is what `resolveModelForRole` (the S02 seam,
 * `auto/role.ts`) produces — not a bypass:
 *
 *  1. "Seam sourced": injecting a role→model resolution (a flat per-unit pref
 *     keyed to the unit's role/type, `unit_model_execute_task`) makes the
 *     journal's `unit_dispatched`/`unit_result` carry that EXACT model/
 *     provider/family, and calling `resolveModelForRole` directly for the
 *     same unit/session agrees with what was recorded.
 *  2. "Degenerate pool-of-one": with NO per-unit pref (the seam falls through
 *     to the session's own model via `effectiveModelFor`), the journal still
 *     carries the seam's output — proving the pre-S02 flat-pref/session-model
 *     legacy path survives as a pool of one.
 *
 * Both cases assert the SINGLE resolution point: the model the driver would
 * `setModel` to (the seam's direct output) and the model recorded as
 * authorship AGREE for the same unit — one resolution, no divergence between
 * the applied model and the recorded author. This is the demo evidence named
 * by ROADMAP §S02 ("um teste injeta um mapa role→modelo e prova que o modelo
 * aplicado no `session_start` veio do seam; o comportamento flat-pref legado
 * continua verde como caso degenerado do novo seam").
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
import { resolveModelForRole, roleForUnit } from "../auto/role.ts";

const MID = "M-toy";

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-role-seam-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function milestoneDir(cwd: string): string {
  return join(cwd, ".gsd", "milestones", MID);
}

/** Write ROADMAP with a single pending slice S01 (matches loop.test.ts / authorship.test.ts). */
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

describe("G2 role-seam — journal authorship on the real dispatch path came from resolveModelForRole", () => {
  test("injected role→model pref (flat, per-unit) → unit_dispatched/unit_result carry the seam's exact model/provider/family, and resolveModelForRole agrees (single resolution point)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      // The "mapa role→modelo" the seam reads for the `executor` role — a flat
      // per-unit pref keyed to the unit's type (S02 is flat-only; role×pool
      // config is S03), same key `resolveUnitModel` has always read.
      writeFileSync(join(cwd, ".gsd", "prefs.md"), "unit_model_execute_task: fakeprov/model-x\n");

      const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      const executeUnit = driver.units.find((u) => u.type === "execute-task");
      assert.ok(executeUnit, "fake driver recorded the execute-task unit");

      const expectedFamily = familyOf("fakeprov/model-x");
      assert.equal(expectedFamily, "fakeprov", "sanity: unknown provider slug falls back to itself");

      const events = readEvents(cwd);

      const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
      assert.equal(dispatched.model, "fakeprov/model-x");
      assert.equal(dispatched.provider, "fakeprov");
      assert.equal(dispatched.family, expectedFamily);

      const result = events.find((e) => e.kind === "unit_result" && e.task === "T01");
      assert.ok(result, "unit_result for the execute-task (T01) exists in the journal");
      assert.equal(result.model, "fakeprov/model-x");
      assert.equal(result.provider, "fakeprov");
      assert.equal(result.family, expectedFamily);

      // Cross-check: call the seam DIRECTLY for the same unit/session — this is
      // literally what `driver.ts`'s `dispatchUnitViaNewSession` calls to decide
      // what it would `pi.setModel` to. If its output agrees with what the
      // journal recorded, the recorded authorship came from the seam, not a
      // parallel/divergent resolution.
      const role = roleForUnit(executeUnit as NextUnit);
      assert.equal(role, "executor", "sanity: execute-task maps to the executor role");
      const viaSeam = resolveModelForRole(role, executeUnit as NextUnit, { session: s });
      assert.deepEqual(
        viaSeam,
        { model: dispatched.model, provider: dispatched.provider, family: dispatched.family },
        "the seam's direct output equals the journal's recorded authorship — single resolution point, no divergence",
      );
    });
  });

  test("degenerate pool-of-one: no per-unit pref, session model on baselineModel → journal carries the SAME {provider, model} the legacy flat-pref path yields, and the seam agrees", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      // Deliberately NO `.gsd/prefs.md` — the per-unit pref is absent, so the
      // pool-of-one seam falls through to `effectiveModelFor`'s session-model
      // fallback, exactly like the pre-S02 flat-pref path did when unset.

      const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
      const s = makeSession(cwd);
      // The interactive session's own model, published on the container the
      // same way `runAuto` captures it before the loop narrows anything
      // (`session.ts`'s `baselineModel` doc comment).
      s.baselineModel = { id: "sessionprov/session-model", provider: "sessionprov" } as never;

      await runForgeLoop(s, { cwd, driver });

      const executeUnit = driver.units.find((u) => u.type === "execute-task");
      assert.ok(executeUnit, "fake driver recorded the execute-task unit");

      const expectedFamily = familyOf("sessionprov/session-model");

      const events = readEvents(cwd);

      const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
      assert.equal(dispatched.model, "sessionprov/session-model");
      assert.equal(dispatched.provider, "sessionprov");
      assert.equal(dispatched.family, expectedFamily);

      const result = events.find((e) => e.kind === "unit_result" && e.task === "T01");
      assert.ok(result, "unit_result for the execute-task (T01) exists in the journal");
      assert.equal(result.model, "sessionprov/session-model");
      assert.equal(result.provider, "sessionprov");
      assert.equal(result.family, expectedFamily);

      // Pool-of-one parity: the seam, invoked directly with the same session,
      // produces the SAME {model, provider, family} triple the journal
      // recorded — the legacy session-fallback path survives unchanged as the
      // seam's degenerate (role-ignoring) case, and there is still one
      // resolution point, not two.
      const role = roleForUnit(executeUnit as NextUnit);
      const viaSeam = resolveModelForRole(role, executeUnit as NextUnit, { session: s });
      assert.deepEqual(
        viaSeam,
        { model: dispatched.model, provider: dispatched.provider, family: dispatched.family },
        "the seam's degenerate output equals the journal's recorded authorship — pool of one, no divergence",
      );
    });
  });
});
