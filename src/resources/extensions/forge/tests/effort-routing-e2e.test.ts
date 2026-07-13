/**
 * S01/T04 demo evidence — proves, on the REAL dispatch path (`runForgeLoop →
 * driver → journal`, fake driver, no real pi session — scaffolding copied
 * verbatim from `tests/authorship-routing-e2e.test.ts`), the four scenarios
 * named by ROADMAP §S01's demo: (A) a task with `effort: low` frontmatter
 * journals `effort=low`/`effort_reason=task-frontmatter` on `unit_dispatched`;
 * (B) prefs `effort_executor: medium` with no frontmatter resolves the role
 * default, and `effort_max: medium` demotes a `effort: high` task with the
 * demotion audited in the reason; (C) an applied clamp reaches `unit_result`
 * as `effort_clamped: "high→medium"`; (D) with NO effort config anywhere, no
 * journal event carries any `effort*` key — byte-identity by absence.
 *
 * **Nota de honestidade (through-the-driver, não seam sintético):** the fake
 * driver never resolves effort itself — `runForgeLoop` calls
 * `resolveDispatchAuthor` (`auto/loop.ts`, pre-journal), which reads the REAL
 * `T##-PLAN.md` frontmatter (`effortHintForUnit`) and the REAL `.gsd/prefs.md`
 * cascade (`readForgePrefs`) off disk and publishes `s.resolvedDispatchEffort`
 * — so the effort recorded in the journal here is produced by production code
 * on the exact journaling path production uses. What does NOT run on the
 * fake-driver path is the real `session_start` hook (the `setThinkingLevel`
 * application with observed clamp) — that application is proven by T03's hook
 * tests (`tests/register-extension.test.ts`); HERE we prove what the
 * CODING-STANDARDS through-the-driver claim requires: resolution, journaling
 * and token correlation on `runForgeLoop → driver → journal`.
 *
 * **Decisão de injeção do "effort aplicado" (Cenário C):** the real
 * `session_start` hook publishes `s.appliedUnitEffort`(+Token); on the
 * fake-driver path it never runs. Empirically, `loop.ts` reads
 * `s.appliedUnitEffort` token-gated AFTER `await deps.driver.dispatch(...)`
 * settles, and the fake driver invokes `step.onDispatch?.(...)` synchronously
 * before resolving its outcome — so setting `s.appliedUnitEffort` +
 * `s.appliedUnitEffortToken = s.currentRendezvousToken` from a step's
 * `onDispatch` lands exactly where the real hook would have written it (same
 * technique as `appliedUnitModel` in the authorship template, Caso 2).
 *
 * The user-scope prefs layers (~/.claude + gsdHome()) are isolated per test —
 * same fixture discipline as `tests/driver.test.ts` (S01/T03) — so a real
 * prefs file on the machine running these tests can never contaminate the
 * resolution (critical for scenario D's absence assertion).
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

const MID = "M-toy";

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-effort-routing-e2e-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Isolates the two user-scope prefs layers (`~/.claude/forge-agent-prefs.md`
 * and `gsdHome()/prefs.md`) behind a throwaway HOME/FORGE_HOME, so the ONLY
 * effort config the resolution can see is what each scenario writes into the
 * sandbox's `.gsd/prefs.md` (copied from `tests/driver.test.ts`, S01/T03).
 */
async function withIsolatedHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
  const fakeHome = mkdtempSync(join(tmpdir(), "forge-effort-routing-e2e-home-"));
  const prevHome = process.env.HOME;
  const prevForgeHome = process.env.FORGE_HOME;
  process.env.HOME = fakeHome;
  process.env.FORGE_HOME = join(fakeHome, ".forge");
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevForgeHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevForgeHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function milestoneDir(cwd: string): string {
  return join(cwd, ".gsd", "milestones", MID);
}

/** Write ROADMAP with a single pending slice S01 (matches authorship-routing-e2e.test.ts). */
function writeRoadmap(cwd: string): void {
  writeFileSync(
    join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
    `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | pending |\n`,
  );
}

/**
 * Write S01-PLAN.md + task dirs/plans (simulates the planner). Each task's
 * frontmatter gets `effortFrontmatterLine` spliced in verbatim (e.g.
 * `"effort: low\n"`) — empty string writes the control plan with NO `effort:`
 * key at all, the exact file `effortHintForUnit` degrades to `undefined` on.
 */
function writeSlicePlan(cwd: string, taskIds: string[], effortFrontmatterLine = ""): void {
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
      `---\nid: ${t}\nslice: S01\ntitle: "Task ${t}"\n${effortFrontmatterLine}must_haves:\n  truths:\n    - "task ${t} does its thing"\n  artifacts: []\n  key_links: []\n---\n\n# ${t}\n`,
    );
  }
}

/** Write the sandbox repo's `.gsd/prefs.md` (flat `key: value` lines, D-S01-1/D3). */
function writePrefs(cwd: string, flatLines: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(join(cwd, ".gsd", "prefs.md"), flatLines);
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

/** Prepare the standard toy sandbox: STATE + ROADMAP + S01 with a single T01. */
function seedSandbox(cwd: string, effortFrontmatterLine = ""): void {
  updateState(cwd, () => ({ milestone: MID }) as StateDoc);
  mkdirSync(milestoneDir(cwd), { recursive: true });
  writeRoadmap(cwd);
  writeSlicePlan(cwd, ["T01"], effortFrontmatterLine);
}

const EFFORT_KEYS = ["effort", "effort_reason", "effort_clamped"] as const;

describe("S01/T04 through-the-driver — effort no journal, teto, clamp e byte-identidade", () => {
  test("Cenário A: task `effort: low` no frontmatter → unit_dispatched com effort=low / effort_reason=task-frontmatter", async () => {
    await withIsolatedHomeAsync(async () => {
      await withSandboxAsync(async (cwd) => {
        seedSandbox(cwd, "effort: low\n");

        const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver });

        const events = readEvents(cwd);

        const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
        assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
        assert.equal(dispatched.effort, "low", "dispatched carries the RESOLVED effort from the plan frontmatter");
        assert.equal(dispatched.effort_reason, "task-frontmatter", "the audit trail names the frontmatter as source");
        assert.ok(!("effort_clamped" in dispatched), "no clamp happened — the key is genuinely absent");

        // Honesty (D-S01-3): the hook never ran on the fake-driver path, so the
        // RESULT must NOT claim an applied effort — resolved ≠ applied.
        const result = events.find((e) => e.kind === "unit_result" && e.task === "T01");
        assert.ok(result, "unit_result for the execute-task (T01) exists in the journal");
        assert.ok(!("effort" in result), "result claims no effort — nothing was applied (no hook on this path)");
        assert.ok(!("effort_clamped" in result), "result carries no clamp record either");
      });
    });
  });

  test("Cenário B(i): prefs `effort_executor: medium` sem frontmatter → effort=medium / role-default:executor (e não vaza p/ completion units)", async () => {
    await withIsolatedHomeAsync(async () => {
      await withSandboxAsync(async (cwd) => {
        seedSandbox(cwd); // plan WITHOUT `effort:` key
        writePrefs(cwd, "effort_executor: medium\n");

        const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver });

        const events = readEvents(cwd);

        const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
        assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
        assert.equal(dispatched.effort, "medium", "no frontmatter hint — the executor role default from prefs wins");
        assert.equal(dispatched.effort_reason, "role-default:executor", "the audit trail names the role default");

        // Role scoping: `effort_executor` must not leak onto the completion
        // units (role `completer`, no `effort_completer` key written here).
        const completionDispatched = events.filter(
          (e) => e.kind === "unit_dispatched" && !("task" in e),
        );
        assert.ok(completionDispatched.length > 0, "completion units were dispatched in this run");
        for (const ev of completionDispatched) {
          assert.ok(!("effort" in ev), "executor default does not leak onto a completer-role dispatch");
        }
      });
    });
  });

  test("Cenário B(ii): prefs `effort_max: medium` + task `effort: high` → effort=medium com o rebaixamento auditado no reason", async () => {
    await withIsolatedHomeAsync(async () => {
      await withSandboxAsync(async (cwd) => {
        seedSandbox(cwd, "effort: high\n");
        writePrefs(cwd, "effort_max: medium\n");

        const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver });

        const events = readEvents(cwd);

        const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
        assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
        assert.equal(dispatched.effort, "medium", "the effort_max ceiling demoted the frontmatter's high");
        assert.equal(
          dispatched.effort_reason,
          "task-frontmatter; capped high→medium by effort_max",
          "the demotion is audited in the reason — original request preserved (D-S01-3)",
        );
      });
    });
  });

  test("Cenário C: applied-effort com clamp injetado via onDispatch → unit_result com effort=medium / effort_clamped=high→medium", async () => {
    await withIsolatedHomeAsync(async () => {
      await withSandboxAsync(async (cwd) => {
        seedSandbox(cwd, "effort: high\n");

        const s = makeSession(cwd);
        // Injection point (see header): `onDispatch` runs synchronously inside
        // the fake driver's `dispatch`, before it resolves — the same point in
        // time the real `session_start` hook would have published
        // `s.appliedUnitEffort`, and strictly before `loop.ts` reads it
        // token-gated (after `await deps.driver.dispatch(...)` settles).
        const driver = fakeDriver(cwd, [
          {
            onDispatch: () => {
              s.appliedUnitEffort = { level: "medium", clamped: "high→medium" };
              s.appliedUnitEffortToken = s.currentRendezvousToken;
            },
            outcome: done("t01"),
          },
          ...completionSteps(),
        ]);

        await runForgeLoop(s, { cwd, driver });

        const events = readEvents(cwd);

        const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
        assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
        assert.equal(dispatched.effort, "high", "dispatched carries the RESOLVED effort (pre-clamp, D-S01-3)");
        assert.equal(dispatched.effort_reason, "task-frontmatter");
        assert.ok(!("effort_clamped" in dispatched), "the clamp belongs to the result, never the dispatch");

        const result = events.find((e) => e.kind === "unit_result" && e.task === "T01");
        assert.ok(result, "unit_result for the execute-task (T01) exists in the journal");
        assert.equal(result.effort, "medium", "result carries the APPLIED (effective post-clamp) level");
        assert.equal(result.effort_clamped, "high→medium", "the clamp record reaches the journal verbatim");
        assert.equal(
          result.effort_reason,
          "task-frontmatter",
          "the result's audit trail comes from the RESOLUTION (appliedUnitEffort only knows level+clamp)",
        );
        assert.notEqual(
          result.effort,
          dispatched.effort,
          "the asymmetry D-S01-3 institutes: dispatched(resolved) vs result(applied) actually diverge here",
        );
      });
    });
  });

  test("Cenário D (byte-identidade): sem NENHUMA config de effort → nenhum evento do journal contém chaves effort*", async () => {
    await withIsolatedHomeAsync(async () => {
      await withSandboxAsync(async (cwd) => {
        // Deliberately: plan with NO `effort:` key, NO `.gsd/prefs.md`, and the
        // user-scope layers behind the isolated HOME — the resolution degrades
        // to `undefined`, `dispatchedEvent` writes nothing, and the token-gated
        // applied read stays null. The journal must be key-for-key identical to
        // a pre-S01 run: absence proven on EVERY event, not just the unit ones.
        seedSandbox(cwd);

        const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver });

        const events = readEvents(cwd);
        assert.ok(events.length > 0, "the run journaled events (the absence assertion is not vacuous)");
        assert.ok(
          events.some((e) => e.kind === "unit_dispatched" && e.task === "T01"),
          "the execute-task was dispatched and journaled",
        );
        assert.ok(
          events.some((e) => e.kind === "unit_result" && e.task === "T01"),
          "the execute-task's result was journaled",
        );

        for (const ev of events) {
          for (const key of EFFORT_KEYS) {
            assert.equal(
              key in ev,
              false,
              `no-config byte-identity: event kind=${String(ev.kind)} must not carry "${key}"`,
            );
          }
        }
      });
    });
  });
});
