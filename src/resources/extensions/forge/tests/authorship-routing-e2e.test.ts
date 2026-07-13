/**
 * S01/T02 demo evidence — proves, on the REAL dispatch path (`runForgeLoop →
 * driver → journal`, fake driver, no real pi session — scaffolding copied
 * verbatim from `tests/role-seam.test.ts`/`tests/authorship.test.ts`), the
 * exact scenario named by ROADMAP §S01: a session whose baseline model is
 * Claude, but whose `.gsd/models.md` role×pool config routes the `executor`
 * role to a GPT pool, gets GPT — not Claude — recorded as authorship on BOTH
 * `unit_dispatched` and `unit_result`.
 *
 * **Nota de honestidade (through-the-driver, não seam sintético):** the fake
 * driver never calls `resolveModelForRole` itself — but T01 moved the
 * authorship derivation (both the dispatched-event `resolved` value and the
 * result-event `resultAuthor`) INSIDE `runForgeLoop`, immediately before/
 * after `deps.driver.dispatch` (`auto/loop.ts:961-975`). So the model
 * recorded in the journal here is produced by the loop reading the REAL
 * `.gsd/models.md` off disk via the seam, on the exact same journaling path
 * production uses — this is the through-the-driver proof the S01 gate rule
 * requires (model resolution happens in production code, not in the test
 * file), same discipline `dispatch-concurrency-e2e.test.ts` documents for its
 * own scope.
 *
 * **Decisão de injeção do "modelo aplicado" (Caso 2, proibido silenciar):**
 * the real `session_start` hook (which publishes `s.appliedUnitModel`) does
 * not run on the fake-driver path. Empirically, `loop.ts` reads
 * `s.appliedUnitModel` AFTER `await deps.driver.dispatch(...)` settles
 * (`loop.ts:964,974`), and the fake driver invokes `step.onDispatch?.(...)`
 * synchronously before resolving its outcome — so setting
 * `s.appliedUnitModel` from a step's `onDispatch` lands exactly where the
 * real hook would have written it. That is the injection point used below
 * (not a custom `SessionDriver`).
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
  const dir = mkdtempSync(join(tmpdir(), "forge-authorship-routing-e2e-test-"));
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

/**
 * The role×pool config `.gsd/models.md` format (`auto/models-config.ts:56-206`):
 * a single GPT pool with one ref, and `executor` routed to it. No
 * `unit_model_execute_task` flat pref is written anywhere in this file — the
 * legacy `effectiveModelFor` path would resolve the Claude baseline, so only
 * the seam (reading THIS config) can produce GPT.
 */
function writeExecutorRoutesToGptConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    `pools:\n  gpt:\n    - openai/gpt-5.5\n\nroles:\n  executor:\n    - gpt\n`,
  );
}

describe("S01/T02 through-the-driver — Claude-baseline session roteada p/ GPT grava GPT no journal", () => {
  test("Caso 1: unit_dispatched E unit_result gravam GPT (roteado), não o baseline Claude da sessão", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      writeExecutorRoutesToGptConfig(cwd);

      const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
      const s = makeSession(cwd);
      // The session/baseline IS Claude — deliberately, per T02-PLAN's
      // contract. If authorship were still sourced from `effectiveModelFor`
      // (the pre-T01 bug), the journal would record THIS, not GPT.
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      await runForgeLoop(s, { cwd, driver });

      const expectedFamily = familyOf("openai/gpt-5.5");
      assert.equal(expectedFamily, "gpt", "sanity: familyOf derivation for openai/* is 'gpt'");

      const events = readEvents(cwd);

      const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
      assert.equal(dispatched.model, "openai/gpt-5.5");
      assert.equal(dispatched.provider, "openai");
      assert.equal(dispatched.family, expectedFamily);
      assert.notEqual(dispatched.family, "claude", "the pre-T01 bug (recording the baseline) is closed");

      const result = events.find((e) => e.kind === "unit_result" && e.task === "T01");
      assert.ok(result, "unit_result for the execute-task (T01) exists in the journal");
      assert.equal(result.model, "openai/gpt-5.5");
      assert.equal(result.provider, "openai");
      assert.equal(result.family, expectedFamily);
      assert.notEqual(result.family, "claude", "the result-event propagated the same lie pre-T01 — now closed too");
    });
  });

  test("Caso 2: unit_result reflete o modelo APLICADO quando diverge do roteado; unit_dispatched permanece o roteado", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      writeExecutorRoutesToGptConfig(cwd);

      const s = makeSession(cwd);
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      // Injection point (see header §Nota de honestidade): `onDispatch` runs
      // synchronously inside the fake driver's `dispatch`, before it resolves
      // — the same point in time the real `session_start` hook would have
      // published `s.appliedUnitModel`, and strictly before `loop.ts` reads
      // it (after `await deps.driver.dispatch(...)` settles).
      const driver = fakeDriver(cwd, [
        {
          onDispatch: () => {
            s.appliedUnitModel = "openai/gpt-5-mini";
          },
          outcome: done("t01"),
        },
        ...completionSteps(),
      ]);

      await runForgeLoop(s, { cwd, driver });

      const events = readEvents(cwd);

      const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
      assert.equal(dispatched.model, "openai/gpt-5.5", "dispatched carries the ROUTED model (pre-dispatch)");
      assert.equal(dispatched.provider, "openai");
      assert.equal(dispatched.family, familyOf("openai/gpt-5.5"));

      const result = events.find((e) => e.kind === "unit_result" && e.task === "T01");
      assert.ok(result, "unit_result for the execute-task (T01) exists in the journal");
      assert.equal(result.model, "openai/gpt-5-mini", "result carries the APPLIED model (post-dispatch), not the routed one");
      assert.equal(result.provider, "openai");
      assert.equal(result.family, familyOf("openai/gpt-5-mini"));

      assert.notEqual(
        result.model,
        dispatched.model,
        "the asymmetry T01 institutes: dispatched(routed) vs result(applied) actually diverge in this scenario",
      );
    });
  });

  test("Caso 3 (guard G1, não-regressão): sem modelo conhecido (sem config, sem pref, sem baseline) → campos ausentes", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      // Deliberately no `.gsd/models.md`, no `.gsd/prefs.md`, and a raw
      // `makeSession` (no cmdCtx, no baselineModel) — the seam degrades to
      // `effectiveModelFor`'s `{ model: null, provider: null }`, so neither
      // `dispatchedEvent` nor the result event should set the authorship
      // fields at all (not `""`/`"null"` — genuinely absent keys).

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
