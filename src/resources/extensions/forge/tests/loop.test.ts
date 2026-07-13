/**
 * `auto/loop.ts` + `auto/driver.ts` — unit tests with a scripted FAKE driver
 * (loop) and a fake command context (driver). No real pi session, no harness:
 * the injectable-driver seam is what makes this possible, and it also de-risks
 * the T06 e2e by proving the whole derive→compose→dispatch→housekeep decision
 * path in isolation.
 *
 * Scenarios (S03-PLAN acceptance + T04 truths):
 *  - happy path: plan-slice → execute-task×2 → milestone complete
 *  - retry: a `partial` unit re-dispatches exactly once, with failure context
 *  - pause: a `blocked` unit halts the loop, STATE untouched for that unit
 *  - timeout (driver, B1/B3/B4): a worker that never delivers resolves as a
 *    timeout outcome — zero hang — and the container tracks the fresh ctx
 *  - reconcile (B5.2): tasks all done but milestone not flipped → repaired
 *  - once: exactly one unit runs
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForgeLoop, notifyReviewerNotAuthorViolation, type SessionDriver } from "../auto/loop.ts";
import type { ReviewDispatcher } from "../review/dispatch.ts";
import { dispatchUnitViaNewSession } from "../auto/driver.ts";
import { ForgeAutoSession, resolveUnitModel } from "../auto/session.ts";
import { FORGE_MCP_UNIT_RESULT_TOOL } from "../worker/mcp-bridge.ts";
import { readState, updateState } from "../state/store.ts";
import type { StateDoc } from "../state/types.ts";
import type { NextUnit } from "../state/dispatch.ts";
import { unitSlice } from "../state/dispatch.ts";
import type { UnitOutcome } from "../worker/rendezvous.ts";
import { deliverUnitResult, hasPendingRendezvous } from "../worker/rendezvous.ts";
import { clearWorkerMcp, getWorkerMcpRecord } from "../worker/mcp-bridge.ts";

const MID = "M-toy";

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-loop-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readStateDoc(cwd: string): StateDoc {
  return readState(cwd);
}

function milestoneDir(cwd: string): string {
  return join(cwd, ".gsd", "milestones", MID);
}

/** Write ROADMAP with a single pending slice S01. */
function writeRoadmap(cwd: string): void {
  writeFileSync(
    join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
    `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | pending |\n`,
  );
}

/**
 * Write S01-PLAN.md + task dirs/plans for the given task ids (simulates the
 * planner). `extraFrontmatterLine` (S09/T03) is spliced in verbatim right
 * after `title:` — e.g. `"domain: infra\n"` — empty string (the default)
 * writes the control plan with NO extra key, the exact shape
 * `domainHintForUnit` degrades to `undefined` on.
 */
function writeSlicePlan(cwd: string, taskIds: string[], extraFrontmatterLine = ""): void {
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
      // S06 (D-S06-1): task plans carry a VALID `must_haves:` block so the loop's
      // pre-dispatch enforcing guard passes them through (a legacy/malformed plan
      // would be blocked). Kept minimal but schema-valid (a single truth).
      `---\nid: ${t}\nslice: S01\ntitle: "Task ${t}"\n${extraFrontmatterLine}must_haves:\n  truths:\n    - "task ${t} does its thing"\n  artifacts: []\n  key_links: []\n---\n\n# ${t}\n`,
    );
  }
}

/** Write a slice's S##-SUMMARY.md (the `complete-slice` worker's durable artifact). */
function writeSliceSummary(cwd: string, slice = "S01"): void {
  writeFileSync(join(milestoneDir(cwd), "slices", slice, `${slice}-SUMMARY.md`), `# ${slice} summary\n`);
}

/** Write the milestone's <mid>-SUMMARY.md (the `complete-milestone` worker's durable artifact). */
function writeMilestoneSummary(cwd: string): void {
  writeFileSync(join(milestoneDir(cwd), `${MID}-SUMMARY.md`), `# ${MID} summary\n`);
}

/**
 * The two completion steps the fake driver plays after all tasks of the single
 * toy slice are done: `complete-slice` (writes S01-SUMMARY) then
 * `complete-milestone` (writes <mid>-SUMMARY). Under D-S03-1 the STATE flip lives
 * on these units, and the loop's done-without-SUMMARY guard requires each to
 * leave its artifact — so a realistic completer fake writes them here.
 */
function completionSteps(): Step[] {
  return [
    { onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)), outcome: done("slice summary written") },
    { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary written") },
  ];
}

/** Stable label for a dispatched unit, across all four `NextUnit` variants. */
function label(u: NextUnit): string {
  if (u.type === "execute-task") return `task:${u.task}`;
  if (u.type === "complete-slice") return `complete-slice:${u.slice}`;
  if (u.type === "complete-milestone") return `complete-milestone:${u.milestone}`;
  return `plan:${unitSlice(u)}`;
}

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A scripted step for the fake driver: an optional side effect + the outcome to return. */
interface Step {
  onDispatch?: (cwd: string, unit: NextUnit, prompt: string) => void;
  outcome: UnitOutcome;
}

/** Build a fake SessionDriver that plays `steps` in order and records prompts/units. */
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

// ── happy path ───────────────────────────────────────────────────────────────

describe("runForgeLoop — happy path", () => {
  test("plan-slice → execute-task×2 → milestone complete", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      const driver = fakeDriver(cwd, [
        // 1) plan-slice: the planner writes S01-PLAN + two task plans.
        { onDispatch: (c) => writeSlicePlan(c, ["T01", "T02"]), outcome: done("planned") },
        // 2) execute-task T01 (records ONLY the task — no slice flip under D-S03-1)
        { outcome: done("t01") },
        // 3) execute-task T02 (last task; the slice stays `running` until complete-slice)
        { outcome: done("t02") },
        // 4) complete-slice: flips S01 done + writes its SUMMARY.
        // 5) complete-milestone: flips the milestone + writes its SUMMARY.
        ...completionSteps(),
      ]);

      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: (message, level) => notes.push([message, level]) });

      assert.deepEqual(
        driver.units.map(label),
        ["plan:S01", "task:T01", "task:T02", "complete-slice:S01", "complete-milestone:M-toy"],
      );

      const state = readStateDoc(cwd);
      assert.equal(state.phase, "complete", "milestone flipped to complete by the complete-milestone unit");
      assert.ok(state.units?.some((u) => u.type === "slice" && u.id === "S01" && u.status === "done"));
      assert.ok(state.units?.some((u) => u.type === "task" && u.id === "T02" && u.status === "done"));

      const kinds = readEvents(cwd).map((e) => e.kind);
      assert.equal(kinds.filter((k) => k === "unit_dispatched").length, 5);
      assert.equal(kinds.filter((k) => k === "unit_result").length, 5);
      const renderedNotes = notes.map(([message]) => message);
      assert.equal(renderedNotes.filter((message) => message.startsWith("▶ ")).length, 5);
      assert.equal(renderedNotes.filter((message) => message.startsWith("✓ ")).length, 5);
      assert.ok(
        renderedNotes.filter((message) => message.startsWith("✓ ")).every((message) => / · (done|partial|blocked) · \d+ms$/.test(message)),
        "every result card exposes a measured elapsed value",
      );
      assert.ok(renderedNotes.every((message) => !message.startsWith("⏸ PAUSADO")));
      assert.equal(s.active, false);
    });
  });
});

// ── S04 advisory hook does NOT alter pre-S04 loop decisions ──────────────────

describe("runForgeLoop — S04 advisory hook is lateral (no decision regression)", () => {
  test("the happy path still yields the exact same continue-flow; plan_check/plan_gate are ADDITIVE events only", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01", "T02"]), outcome: done("planned") },
        { outcome: done("t01") },
        { outcome: done("t02") },
        ...completionSteps(),
      ]);

      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      // Same dispatch sequence and same terminal STATE as the pre-S04 happy path.
      assert.deepEqual(
        driver.units.map(label),
        ["plan:S01", "task:T01", "task:T02", "complete-slice:S01", "complete-milestone:M-toy"],
      );
      assert.equal(readStateDoc(cwd).phase, "complete");

      const kinds = readEvents(cwd).map((e) => e.kind);
      // The pre-S04 decision events are UNCHANGED in count.
      assert.equal(kinds.filter((k) => k === "unit_dispatched").length, 5);
      assert.equal(kinds.filter((k) => k === "unit_result").length, 5);
      assert.ok(!kinds.includes("unit_retry"), "no spurious retry introduced by the hook");
      // The advisory events are present, exactly once, and ADDITIVE.
      assert.equal(kinds.filter((k) => k === "plan_check").length, 1, "one plan_check per plan-slice: done");
      assert.equal(kinds.filter((k) => k === "plan_gate").length, 1, "one plan_gate per plan-slice: done");
    });
  });

  test("a plan-slice that FAILS the M1R-2 guard runs NO advisory hook (retry path is untouched)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      // plan-slice reports done but writes no PLAN → downgraded to partial → retry.
      const driver = fakeDriver(cwd, [
        { outcome: done("nothing written") },
        { outcome: done("still nothing") },
      ]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      const kinds = readEvents(cwd).map((e) => e.kind);
      assert.ok(!kinds.includes("plan_check"), "no plan_check when the plan failed the M1R-2 guard");
      assert.ok(!kinds.includes("plan_gate"), "no plan_gate on the retry path");
      assert.ok(kinds.includes("unit_retry"), "the retry decision is unchanged by the hook");
    });
  });
});

// ── retry ──────────────────────────────────────────────────────────────────

describe("runForgeLoop — retry (B4)", () => {
  test("a partial unit re-dispatches exactly once with the failure context in the next prompt", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]); // already planned ⇒ first unit is execute-task

      const driver = fakeDriver(cwd, [
        { outcome: { kind: "result", result: { status: "partial", summary: "faltou o gate", artifacts: [] } } },
        { outcome: done("t01 retry ok") },
        ...completionSteps(),
      ]);

      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      assert.equal(driver.units.length, 4, "T01 (partial) + one retry, then complete-slice + complete-milestone");
      assert.match(driver.prompts[1], /## Retry Context/, "retry prompt carries the failure context section");
      assert.match(driver.prompts[1], /faltou o gate/, "retry prompt threads the previous summary");

      const state = readStateDoc(cwd);
      assert.ok(state.units?.some((u) => u.id === "T01" && u.status === "done"));
      assert.equal(state.phase, "complete");

      const kinds = readEvents(cwd).map((e) => e.kind);
      assert.equal(kinds.filter((k) => k === "unit_retry").length, 1);
    });
  });

  test("a second failure of the same unit pauses the loop (retry exhausted)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const partial: UnitOutcome = { kind: "result", result: { status: "partial", summary: "nope", artifacts: [] } };
      const driver = fakeDriver(cwd, [{ outcome: partial }, { outcome: partial }]);

      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      assert.equal(driver.units.length, 2, "no third dispatch after retry is exhausted");
      const state = readStateDoc(cwd);
      assert.ok(!state.units?.some((u) => u.id === "T01" && u.status === "done"), "task not marked done");
      assert.ok(notes.some(([, l]) => l === "warning"), "paused with a warning");
      assert.equal(s.active, false);
      assert.ok(readEvents(cwd).some((e) => e.kind === "loop_paused"));
    });
  });
});

// ── pause on blocked ─────────────────────────────────────────────────────────

describe("runForgeLoop — pause on blocked (B4)", () => {
  test("a blocked unit halts the loop immediately, STATE untouched for that unit", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const driver = fakeDriver(cwd, [
        { outcome: { kind: "result", result: { status: "blocked", summary: "need human", artifacts: [], reason: "ambíguo" } } },
      ]);

      const notes: string[] = [];
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: (m) => notes.push(m) });

      assert.equal(driver.units.length, 1, "no retry on blocked");
      const state = readStateDoc(cwd);
      assert.ok(!state.units?.some((u) => u.id === "T01" && u.status === "done"));
      assert.ok(notes.some((m) => m.includes("ambíguo")), "pause reason surfaced");
      assert.ok(notes.some((m) => m.startsWith("⏸ PAUSADO") && m.includes("/forge auto")), "persistent resume banner surfaced");
      assert.ok(readEvents(cwd).some((e) => e.kind === "loop_paused"));
    });
  });
});

// ── M1R-4 persist blocked/partial + resume guard ─────────────────────────────

describe("runForgeLoop — M1R-4 persist terminal status + resume guard", () => {
  test("(a) pause by blocked persists status 'blocked' into STATE (so /forge status sees it)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const driver = fakeDriver(cwd, [
        { outcome: { kind: "result", result: { status: "blocked", summary: "need human", artifacts: [], reason: "ambíguo" } } },
      ]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      const state = readStateDoc(cwd);
      const t01 = state.units?.find((u) => u.id === "T01" && u.type === "task");
      assert.equal(t01?.status, "blocked", "the blocked status is persisted durably in STATE");
      assert.equal(s.active, false);
    });
  });

  test("(a') pause by retry-exhausted (partial×2) persists status 'partial' into STATE", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const partial: UnitOutcome = { kind: "result", result: { status: "partial", summary: "nope", artifacts: [] } };
      const driver = fakeDriver(cwd, [{ outcome: partial }, { outcome: partial }]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      const state = readStateDoc(cwd);
      const t01 = state.units?.find((u) => u.id === "T01" && u.type === "task");
      assert.equal(t01?.status, "partial", "the exhausted-retry partial status is persisted in STATE");
    });
  });

  test("(b) a re-run whose STATE already reads 'blocked' re-pauses WITHOUT calling the driver", async () => {
    await withSandboxAsync(async (cwd) => {
      // STATE already carries a durable `blocked` for T01 (a prior session's pause).
      updateState(cwd, () => ({ milestone: MID, units: [{ id: "T01", type: "task", status: "blocked", slice: "S01" }] }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      // Empty scripted steps → the fake driver THROWS if the loop ever dispatches.
      const driver = fakeDriver(cwd, []);
      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      assert.equal(driver.units.length, 0, "budget não renasce: the blocked unit is NOT re-dispatched");
      assert.equal(s.active, false, "loop re-paused immediately");
      assert.ok(notes.some(([, l]) => l === "warning"), "re-pause surfaced a warning");
      const events = readEvents(cwd);
      assert.ok(events.some((e) => e.kind === "loop_paused"), "loop_paused journaled for the re-pause");
      // The blocked status is untouched — still awaiting a human.
      const t01 = readStateDoc(cwd).units?.find((u) => u.id === "T01" && u.type === "task");
      assert.equal(t01?.status, "blocked");
    });
  });

  test("(b') a re-run whose STATE already reads 'partial' (budget spent) also re-pauses without re-dispatch", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID, units: [{ id: "T01", type: "task", status: "partial", slice: "S01" }] }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const driver = fakeDriver(cwd, []);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      assert.equal(driver.units.length, 0, "a persisted partial does not re-dispatch from a zeroed budget");
      assert.equal(s.active, false);
      assert.ok(readEvents(cwd).some((e) => e.kind === "loop_paused"));
    });
  });

  test("the guard does NOT fire for a normal pending unit (regression)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      assert.equal(driver.units.length, 3, "T01 + the two completion units dispatch normally — the guard is inert");
      assert.equal(readStateDoc(cwd).phase, "complete");
    });
  });
});

// ── M2R-4 persist blocked/partial for ALL unit types (not just execute-task) ─

describe("runForgeLoop — M2R-4 durable pause for plan-slice/complete-slice/complete-milestone", () => {
  test("(a) a blocked plan-slice persists 'blocked' on the slice unit and re-pauses on resume without re-dispatch", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      // No S01-PLAN.md yet → deriveNextUnit emits plan-slice.

      const blocked: UnitOutcome = {
        kind: "result",
        result: { status: "blocked", summary: "plano ambíguo", artifacts: [], reason: "faltam requisitos" },
      };
      const driver1 = fakeDriver(cwd, [{ outcome: blocked }]);
      const s1 = makeSession(cwd);
      await runForgeLoop(s1, { cwd, driver: driver1 });

      const stateAfterPause = readStateDoc(cwd);
      const sliceUnit = stateAfterPause.units?.find((u) => u.id === "S01" && u.type === "slice");
      assert.equal(sliceUnit?.status, "blocked", "the blocked plan-slice pause is persisted durably in STATE");

      // Restart: a fresh process, zeroed retry budget — the fake driver has ZERO
      // scripted steps, so it throws if the loop ever dispatches.
      const driver2 = fakeDriver(cwd, []);
      const notes: Array<[string, string | undefined]> = [];
      const s2 = makeSession(cwd);
      const result = await runForgeLoop(s2, { cwd, driver: driver2, notify: (m, l) => notes.push([m, l]) });

      assert.equal(driver2.units.length, 0, "budget não renasce: the blocked plan-slice is NOT re-dispatched");
      assert.equal(result.reason, "blocked");
      assert.ok(readEvents(cwd).some((e) => e.kind === "loop_paused"), "loop_paused journaled for the re-pause");
      assert.equal(
        readStateDoc(cwd).units?.find((u) => u.id === "S01" && u.type === "slice")?.status,
        "blocked",
        "the durable pause survives the restart untouched",
      );
    });
  });

  test("(b) a partial complete-slice (retry exhausted) persists 'partial' and re-pauses on resume without re-dispatch", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID, units: [{ id: "T01", type: "task", status: "done", slice: "S01" }] }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const partial: UnitOutcome = { kind: "result", result: { status: "partial", summary: "gate faltando", artifacts: [] } };
      const driver1 = fakeDriver(cwd, [{ outcome: partial }, { outcome: partial }]);
      const s1 = makeSession(cwd);
      await runForgeLoop(s1, { cwd, driver: driver1 });

      const sliceUnit = readStateDoc(cwd).units?.find((u) => u.id === "S01" && u.type === "slice");
      assert.equal(sliceUnit?.status, "partial", "the exhausted-retry complete-slice pause is persisted in STATE");

      const driver2 = fakeDriver(cwd, []);
      const s2 = makeSession(cwd);
      const result = await runForgeLoop(s2, { cwd, driver: driver2 });

      assert.equal(driver2.units.length, 0, "a persisted partial does not re-dispatch from a zeroed budget");
      assert.equal(result.reason, "paused");
      assert.ok(readEvents(cwd).some((e) => e.kind === "loop_paused"));
      assert.equal(
        readStateDoc(cwd).units?.find((u) => u.id === "S01" && u.type === "slice")?.status,
        "partial",
        "the durable pause survives the restart untouched",
      );
    });
  });

  test("(c) done results still flip/advance normally (no regression to the happy path)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
      const s = makeSession(cwd);
      const result = await runForgeLoop(s, { cwd, driver });

      assert.equal(driver.units.length, 3);
      assert.equal(result.reason, "complete");
      assert.equal(readStateDoc(cwd).phase, "complete");
      assert.equal(
        readStateDoc(cwd).units?.find((u) => u.id === "S01" && u.type === "slice")?.status,
        "done",
        "complete-slice's done flip is untouched by the pause fix",
      );
    });
  });
});

// ── E2E-3 journal fidelity: unit_retry vs unit_readvanced ────────────────────

describe("runForgeLoop — E2E-3 retry-vs-readvance journal fidelity", () => {
  test("a retry that RE-DISPATCHES the same unit journals unit_retry (not unit_readvanced)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const driver = fakeDriver(cwd, [
        { outcome: { kind: "result", result: { status: "partial", summary: "faltou o gate", artifacts: [] } } },
        { outcome: done("t01 retry ok") },
        ...completionSteps(),
      ]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      const kinds = readEvents(cwd).map((e) => e.kind);
      assert.equal(kinds.filter((k) => k === "unit_retry").length, 1, "same unit re-dispatched → exactly one unit_retry");
      assert.ok(!kinds.includes("unit_readvanced"), "no readvance — the same unit was re-dispatched");
      assert.equal(driver.units.length, 4, "T01 + one retry of the SAME unit, then the two completion units");
    });
  });

  test("a retry where on-disk progress ADVANCES the loop to a different unit journals unit_readvanced (not unit_retry)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01", "T02"]);

      const driver = fakeDriver(cwd, [
        // T01 reports partial → retry deferred; but out-of-band, T01 lands as done
        // on disk (progress the loop must honor), so the NEXT derive advances to T02.
        {
          onDispatch: (c) =>
            updateState(c, (st) => ({
              ...st,
              units: [...(st.units ?? []), { id: "T01", type: "task", status: "done", slice: "S01" }],
            })),
          outcome: { kind: "result", result: { status: "partial", summary: "parcial mas disco progrediu", artifacts: [] } },
        },
        { outcome: done("t02") },
        ...completionSteps(),
      ]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      const kinds = readEvents(cwd).map((e) => e.kind);
      assert.ok(kinds.includes("unit_readvanced"), "advanced to a different unit → unit_readvanced");
      assert.ok(!kinds.includes("unit_retry"), "the journal does NOT lie with a unit_retry for a re-derive that advanced");
      assert.deepEqual(
        driver.units.map(label),
        ["task:T01", "task:T02", "complete-slice:S01", "complete-milestone:M-toy"],
        "the loop advanced T01 → T02, then ran the completion units",
      );
    });
  });
});

// ── reconcile (B5.2) ─────────────────────────────────────────────────────────

describe("runForgeLoop — reconcileCompletion (B5.2, kill-9 net)", () => {
  test("slice done + milestone SUMMARY on disk but milestone not flipped → reconciled, never a silent exit", async () => {
    await withSandboxAsync(async (cwd) => {
      // The genuine D-S03-1 kill-9 window: every slice is flipped `done` in STATE
      // AND the <mid>-SUMMARY.md is already on disk (so `deriveNextUnit` no longer
      // re-emits complete-milestone), yet the milestone flip itself was lost to a
      // crash. `deriveNextUnit` therefore returns null and reconcileCompletion is
      // the only thing that can repair it — never a silent exit.
      updateState(
        cwd,
        () =>
          ({
            milestone: MID,
            units: [
              { id: "T01", type: "task", status: "done", slice: "S01" },
              { id: "S01", type: "slice", status: "done" },
            ],
          }) as StateDoc,
      );
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      writeSliceSummary(cwd);
      writeMilestoneSummary(cwd); // milestoneSummaryWritten ⇒ complete-milestone not re-emitted

      const driver = fakeDriver(cwd, []); // deriveNextUnit === null ⇒ driver never runs
      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      assert.equal(driver.units.length, 0, "no unit dispatched — nothing to derive");
      const state = readStateDoc(cwd);
      assert.equal(state.phase, "complete", "milestone reconciled to complete");
      assert.ok(readEvents(cwd).some((e) => e.kind === "milestone_complete"));
      assert.ok(notes.some(([, l]) => l === "success"));
    });
  });

  // ── R1 (S03 review-fix): SLICE-level kill-9 → resume flips the slice, unblocks
  //    the dependent slice, and NEVER reports a false milestone-complete. ──
  test("R1: slice done+summary but flip lost → resume reconciles the slice, S02 unblocks and completes, no false milestone-complete", async () => {
    await withSandboxAsync(async (cwd) => {
      // Layout: S01 → S02 (S02 depends on S01). S01's task is done and its
      // S01-SUMMARY.md is on disk, but the slice flip was lost to a kill-9 —
      // STATE reads S01 `running`. Under the bug, resume derives null,
      // reconcileCompletion's F4 guard returns null, and the loop reports a FALSE
      // "milestone concluído" while S02 never runs. The fix reconciles S01 to
      // done and keeps the loop running so S02 is dispatched to completion.
      updateState(
        cwd,
        () =>
          ({
            milestone: MID,
            units: [
              { id: "T01", type: "task", status: "done", slice: "S01" },
              { id: "S01", type: "slice", status: "running" }, // flip lost
            ],
          }) as StateDoc,
      );
      mkdirSync(milestoneDir(cwd), { recursive: true });
      // ROADMAP with two slices, S02 depending on S01.
      writeFileSync(
        join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
        `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira | med | — | pending |\n| S02 | Segunda | med | S01 | pending |\n`,
      );
      // S01 fully done on disk with its SUMMARY; S02 planned with one pending task.
      writeSlicePlan(cwd, ["T01"]);
      writeSliceSummary(cwd, "S01");
      const s02Dir = join(milestoneDir(cwd), "slices", "S02");
      mkdirSync(join(s02Dir, "tasks", "T02"), { recursive: true });
      writeFileSync(join(s02Dir, "S02-PLAN.md"), `---\nid: S02\nmilestone: ${MID}\ntitle: "Segunda"\n---\n\n# S02 plan\n`);
      writeFileSync(
        join(s02Dir, "tasks", "T02", "T02-PLAN.md"),
        // S06 (D-S06-1): valid must_haves so the enforcing guard passes T02 through.
        `---\nid: T02\nslice: S02\ntitle: "T02"\nmust_haves:\n  truths:\n    - "T02 does its thing"\n  artifacts: []\n  key_links: []\n---\n\n# T02\n`,
      );

      // After the slice reconcile, the loop must dispatch S02's task then the two
      // completion units for S02, then the milestone close.
      const driver = fakeDriver(cwd, [
        { outcome: done("t02") },
        {
          onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)),
          outcome: done("s02 summary"),
        },
        { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary") },
      ]);
      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      // The dependent slice's work actually ran — no false early completion.
      assert.deepEqual(
        driver.units.map(label),
        ["task:T02", "complete-slice:S02", "complete-milestone:M-toy"],
        "S02 unblocked and ran to completion after the S01 reconcile",
      );
      const state = readStateDoc(cwd);
      assert.equal(state.phase, "complete", "milestone genuinely complete (all real work done)");
      assert.ok(state.units?.some((u) => u.type === "slice" && u.id === "S01" && u.status === "done"), "S01 reconciled to done");
      assert.ok(state.units?.some((u) => u.type === "slice" && u.id === "S02" && u.status === "done"), "S02 completed");
      // The slice reconcile was journaled and did NOT masquerade as a milestone event.
      assert.ok(readEvents(cwd).some((e) => e.kind === "slice_complete" && e.slice === "S01"), "slice_complete journaled");
      assert.equal(term.reason, "complete");
    });
  });

  // ── R2 (S03 review-fix): a MILESTONE-level reconcile must ALSO run the
  //    in-process close (rebuild LEDGER.md/DECISIONS.md + apply cleanup pref). ──
  test("R2: milestone flip lost → resume reconcile rebuilds LEDGER.md/DECISIONS.md (runMilestoneClose runs on the reconcile path)", async () => {
    await withSandboxAsync(async (cwd) => {
      // The complete-milestone kill-9 tail: slice done, <mid>-SUMMARY on disk, but
      // the milestone flip was lost. Under the bug the reconcile path flips STATE
      // but NEVER calls runMilestoneClose, so the projections are never rebuilt —
      // LEDGER.md / DECISIONS.md never exist on this recovery path.
      updateState(
        cwd,
        () =>
          ({
            milestone: MID,
            units: [
              { id: "T01", type: "task", status: "done", slice: "S01" },
              { id: "S01", type: "slice", status: "done" },
            ],
          }) as StateDoc,
      );
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      writeSliceSummary(cwd);
      writeMilestoneSummary(cwd);

      // Pre-condition (fail-before witness): neither projection exists yet.
      assert.equal(existsSync(join(cwd, ".gsd", "LEDGER.md")), false);
      assert.equal(existsSync(join(cwd, ".gsd", "DECISIONS.md")), false);

      const driver = fakeDriver(cwd, []); // nothing to derive → driver never runs
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver });

      assert.equal(driver.units.length, 0, "no unit dispatched — pure reconcile path");
      assert.equal(readStateDoc(cwd).phase, "complete", "milestone reconciled to complete");
      // The FIX: runMilestoneClose ran on the reconcile path → projections rebuilt.
      assert.ok(existsSync(join(cwd, ".gsd", "LEDGER.md")), "LEDGER.md rebuilt on the reconcile path");
      assert.ok(existsSync(join(cwd, ".gsd", "DECISIONS.md")), "DECISIONS.md rebuilt on the reconcile path");
      assert.equal(term.reason, "complete");
    });
  });
});

// ── R4 (M2/S02 review): genuine deadlock → structured blocked, not a crash ──

describe("runForgeLoop — deadlock safety net (R4)", () => {
  test("a genuine dependency cycle (A↔B) pauses structured { reason: 'blocked' }, never an uncaught throw", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      // S01 depends S02, S02 depends S01 — deriveNextUnit throws; the loop must
      // convert that into a structured blocked pause (forge-command.ts has no
      // catch, so a raw throw would crash `/forge auto`).
      writeFileSync(
        join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
        `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Slice um | med | S02 | pending |\n| S02 | Slice dois | med | S01 | pending |\n`,
      );

      const driver = fakeDriver(cwd, []); // never dispatches — derive throws first
      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);

      let terminal: { reason: string; message?: string } | undefined;
      await assert.doesNotReject(async () => {
        terminal = await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });
      }, "a genuine cycle must NOT surface as an uncaught rejection");

      assert.equal(terminal?.reason, "blocked", "the loop pauses structured on a real deadlock");
      assert.equal(driver.units.length, 0, "nothing dispatched");
      assert.equal(s.active, false);
      assert.ok(
        readEvents(cwd).some((e) => e.kind === "loop_paused"),
        "a loop_paused event is journaled for the deadlock",
      );
      assert.ok(notes.some(([, l]) => l === "warning"));
    });
  });
});

// ── M2R-6 (review-fix): derive-null-but-slice-running must PAUSE, not exit 0 ──

describe("runForgeLoop — stuck-derive safety net (M2R-6)", () => {
  test("S01-PLAN present but task plans missing (wrong path) → deriveNextUnit is null while S01 is still pending → loop PAUSES (loop_stuck), never a false 'complete'", async () => {
    await withSandboxAsync(async (cwd) => {
      // Reproduces the A1 live failure: the plan worker wrote S01-PLAN.md but its
      // task plans landed at the WRONG path, so the snapshot reads S01 as
      // `planned: true, tasks: []`. deriveNextUnit's dispatch table has no branch
      // for this (0 tasks skips both the pending-task AND the complete-slice
      // branches) — it falls out of the loop and returns null, while the roadmap
      // still reads S01 `pending`. Before the fix this fell into "Nada a fazer —
      // milestone concluído" and returned `{ reason: "complete" }` with exit 0.
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd); // S01 pending, no deps
      const slicesDir = join(milestoneDir(cwd), "slices", "S01");
      mkdirSync(slicesDir, { recursive: true });
      writeFileSync(
        join(slicesDir, "S01-PLAN.md"),
        `---\nid: S01\nmilestone: ${MID}\ntitle: "Primeira slice"\n---\n\n# S01 plan\n`,
      );
      // Deliberately NOT writing slices/S01/tasks/T01/T01-PLAN.md — simulates the
      // wrong-path bug: the plan exists but no task rows are discoverable.

      const driver = fakeDriver(cwd, []); // must NEVER be dispatched — derive is null
      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      assert.equal(term.reason, "blocked", "a stuck derive with unfinished work pauses, it never reports complete");
      assert.equal(driver.units.length, 0, "nothing was dispatchable — the driver never ran");
      assert.equal(s.active, false);
      const state = readStateDoc(cwd);
      assert.notEqual(state.phase, "complete", "STATE must NOT be flipped to complete on a stuck derive");
      assert.ok(
        readEvents(cwd).some((e) => e.kind === "loop_stuck" && e.slice === "S01"),
        "a loop_stuck event is journaled, naming the unfinished slice",
      );
      assert.ok(notes.some(([, l]) => l === "warning"), "the operator is notified with a warning, not a success");
      assert.ok(
        !notes.some(([m]) => m.includes("Nada a fazer")),
        "the old silent false-success message must never fire",
      );
    });
  });

  test("genuinely complete milestone (all slices done, no reconcile needed) still reports complete — no regression", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(
        cwd,
        () =>
          ({
            milestone: MID,
            units: [
              { id: "T01", type: "task", status: "done", slice: "S01" },
              { id: "S01", type: "slice", status: "done" },
              { id: MID, type: "milestone", status: "done" },
            ],
          }) as StateDoc,
      );
      mkdirSync(milestoneDir(cwd), { recursive: true });
      // Roadmap row also reflects done, so `sliceComplete` is true from either source.
      writeFileSync(
        join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
        `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | done |\n`,
      );
      writeSlicePlan(cwd, ["T01"]);
      writeSliceSummary(cwd);
      writeMilestoneSummary(cwd);

      const driver = fakeDriver(cwd, []); // nothing left to dispatch
      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      assert.equal(term.reason, "complete", "a genuinely finished milestone still reports complete");
      assert.equal(driver.units.length, 0);
      assert.ok(
        !readEvents(cwd).some((e) => e.kind === "loop_stuck"),
        "no loop_stuck event when the milestone is genuinely done",
      );
      assert.ok(notes.some(([m, l]) => l === "success" && m.includes("Nada a fazer")));
    });
  });

  // ── M2R-3 (review-fix): crash AFTER the STATE flip but BEFORE runMilestoneClose
  //    rebuilt the projections must be repaired on resume — even though there is
  //    NOTHING left to reconcile (STATE already agrees with the journal/roadmap,
  //    so `reconcileCompletion` returns null and the loop falls straight into the
  //    "genuinely complete" branch above). Before the fix that branch returned
  //    `complete` WITHOUT ever calling `runMilestoneClose`, so LEDGER.md/
  //    DECISIONS.md/CHECKER.md/AUTO-MEMORY.md stayed stale/absent forever. ──
  test("M2R-3 (i): STATE already complete but projections never built (crash before runMilestoneClose) → resume rebuilds them", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(
        cwd,
        () =>
          ({
            milestone: MID,
            units: [
              { id: "T01", type: "task", status: "done", slice: "S01" },
              { id: "S01", type: "slice", status: "done" },
              { id: MID, type: "milestone", status: "done" },
            ],
          }) as StateDoc,
      );
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeFileSync(
        join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
        `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | done |\n`,
      );
      writeSlicePlan(cwd, ["T01"]);
      writeSliceSummary(cwd);
      writeMilestoneSummary(cwd);

      // Fail-before witness: the STATE flip landed but the close's rebuild never
      // ran — no LEDGER/DECISIONS projections exist yet.
      assert.equal(existsSync(join(cwd, ".gsd", "LEDGER.md")), false);
      assert.equal(existsSync(join(cwd, ".gsd", "DECISIONS.md")), false);

      const driver = fakeDriver(cwd, []); // nothing to derive — pure "already complete" path
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver });

      assert.equal(driver.units.length, 0, "no unit dispatched — the milestone is already complete");
      assert.equal(term.reason, "complete");
      assert.ok(existsSync(join(cwd, ".gsd", "LEDGER.md")), "LEDGER.md rebuilt on the already-complete resume path");
      assert.ok(
        existsSync(join(cwd, ".gsd", "DECISIONS.md")),
        "DECISIONS.md rebuilt on the already-complete resume path",
      );

      // Idempotency: a second resume must reproduce byte-identical projections.
      const ledgerAfterFirst = readFileSync(join(cwd, ".gsd", "LEDGER.md"), "utf-8");
      const decisionsAfterFirst = readFileSync(join(cwd, ".gsd", "DECISIONS.md"), "utf-8");

      const s2 = makeSession(cwd);
      const driver2 = fakeDriver(cwd, []);
      const term2 = await runForgeLoop(s2, { cwd, driver: driver2 });
      assert.equal(term2.reason, "complete");
      assert.equal(
        readFileSync(join(cwd, ".gsd", "LEDGER.md"), "utf-8"),
        ledgerAfterFirst,
        "second resume produces a byte-identical LEDGER.md",
      );
      assert.equal(
        readFileSync(join(cwd, ".gsd", "DECISIONS.md"), "utf-8"),
        decisionsAfterFirst,
        "second resume produces a byte-identical DECISIONS.md",
      );
    });
  });

  // ── M2R-3 (ii): a journaled `complete-milestone: done` whose STATE flip never
  //    landed is repaired by `replayJournalOnResume` (applies the mutator) — but
  //    that replay alone does not rebuild projections. The very same resume must
  //    still drive `runMilestoneClose` once the flip is reconciled and the loop
  //    falls into the "nothing left to derive" branch. ──
  test("M2R-3 (ii): journaled complete-milestone replay (STATE flip lost) → same resume rebuilds LEDGER.md/DECISIONS.md", async () => {
    await withSandboxAsync(async (cwd) => {
      // STATE has the slice/task done, but the milestone unit itself is ABSENT
      // (flip lost) — mirrors the crash window between appendEvent and
      // updateState for the complete-milestone result.
      updateState(
        cwd,
        () =>
          ({
            milestone: MID,
            units: [
              { id: "T01", type: "task", status: "done", slice: "S01" },
              { id: "S01", type: "slice", status: "done" },
            ],
          }) as StateDoc,
      );
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeFileSync(
        join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
        `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | done |\n`,
      );
      writeSlicePlan(cwd, ["T01"]);
      writeSliceSummary(cwd);
      writeMilestoneSummary(cwd);

      // Journal the complete-milestone `done` result exactly as the loop would,
      // BEFORE the crash prevented the STATE flip from persisting.
      const journalDir = join(cwd, ".gsd", "forge");
      mkdirSync(journalDir, { recursive: true });
      writeFileSync(
        join(journalDir, "events.jsonl"),
        `${JSON.stringify({
          ts: "2026-07-08T00:00:00Z",
          kind: "unit_result",
          unit: `complete/${MID}`,
          agent: "forge-loop",
          milestone: MID,
          status: "done",
          summary: "Milestone concluído",
        })}\n`,
        { flag: "a" },
      );

      assert.equal(existsSync(join(cwd, ".gsd", "LEDGER.md")), false);
      assert.equal(existsSync(join(cwd, ".gsd", "DECISIONS.md")), false);
      assert.notEqual(readStateDoc(cwd).phase, "complete", "STATE flip not yet applied before resume");

      const driver = fakeDriver(cwd, []); // never dispatches — replay + fallthrough only
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver });

      assert.equal(driver.units.length, 0, "no re-dispatch — the replay reconciles STATE, never the driver");
      assert.equal(term.reason, "complete");
      assert.equal(readStateDoc(cwd).phase, "complete", "replay reconciled the milestone flip");
      assert.ok(
        readEvents(cwd).some((e) => e.kind === "unit_result_replayed"),
        "the replay audit marker was journaled",
      );
      assert.ok(existsSync(join(cwd, ".gsd", "LEDGER.md")), "LEDGER.md rebuilt after the replayed flip");
      assert.ok(existsSync(join(cwd, ".gsd", "DECISIONS.md")), "DECISIONS.md rebuilt after the replayed flip");
    });
  });
});

// ── once ─────────────────────────────────────────────────────────────────────

describe("runForgeLoop — once (the /forge next base)", () => {
  test("runs exactly one unit", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01", "T02"]);

      const driver = fakeDriver(cwd, [{ outcome: done("t01") }, { outcome: done("t02") }]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver }, { once: true });

      assert.equal(driver.units.length, 1, "exactly one unit under once:true");
      assert.equal((driver.units[0] as { task?: string }).task, "T01");
      const state = readStateDoc(cwd);
      assert.ok(state.units?.some((u) => u.id === "T01" && u.status === "done"));
      assert.ok(!state.units?.some((u) => u.id === "T02" && u.status === "done"), "T02 left for the next run");
      assert.equal(s.active, false);
    });
  });
});

// ── R1 (S04 review): worker-turn error must become a blocked unit ───────────

describe("runForgeLoop — worker-turn error via the REAL driver (R1)", () => {
  test("a withSession rejection journals a blocked unit, sets s.active = false, and the loop RESOLVES (no unhandled rejection)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);

      const s = makeSession(cwd);
      const freshCtx = {
        async sendMessage() {
          throw new Error("boom: transient API/network error inside the worker turn");
        },
      };
      s.cmdCtx = {
        async newSession(opts: { withSession?: (ctx: unknown) => Promise<void> }) {
          await opts.withSession?.(freshCtx);
          return { cancelled: false };
        },
      } as never;

      // The REAL production driver, exercised through the loop — proves the
      // exception never escapes `Promise.race` as an unhandled rejection.
      const driver: SessionDriver = { dispatch: (unit, prompt) => dispatchUnitViaNewSession(s, unit, prompt) };

      const notes: Array<[string, string | undefined]> = [];
      await assert.doesNotReject(
        runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) }),
        "runForgeLoop must resolve, never reject, on a worker-turn error",
      );

      assert.equal(s.active, false, "loop pauses (s.active = false) instead of crashing");
      const state = readStateDoc(cwd);
      assert.ok(!state.units?.some((u) => u.id === "T01" && u.status === "done"), "unit not marked done");
      assert.ok(notes.some(([m]) => m.includes("worker") || m.includes("Sessão")), "pause reason surfaced");
      assert.ok(readEvents(cwd).some((e) => e.kind === "loop_paused"), "blocked unit journaled as a paused loop");
    });
  });
});

// ── driver: B1 rendezvous + B3 fresh ctx + B4 no-hang ────────────────────────

describe("dispatchUnitViaNewSession — B1/B3/B4", () => {
  const UNIT: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };

  test("delivers a worker result via the rendezvous and re-points s.cmdCtx to the fresh ctx (B1/B3)", async () => {
    const s = new ForgeAutoSession();
    s.cwd = "/nonexistent";

    const freshCtx = {
      async sendMessage() {
        // Simulate the worker calling forge_unit_result during its turn — the
        // tool handler (fresh instance) delivers into the module-level rendezvous.
        deliverUnitResult({ status: "done", summary: "worker done", artifacts: ["a.ts"] });
      },
    };

    const staleCtx = {
      async newSession(opts: { withSession?: (ctx: unknown) => Promise<void> }) {
        await opts.withSession?.(freshCtx);
        return { cancelled: false };
      },
    };
    s.cmdCtx = staleCtx as never;

    const outcome = await dispatchUnitViaNewSession(s, UNIT, "PROMPT");
    assert.equal(outcome.kind, "result");
    assert.equal(outcome.kind === "result" && outcome.result.summary, "worker done");
    assert.equal(s.cmdCtx, freshCtx as never, "B3: s.cmdCtx now points at the fresh ctx, not the stale handle");
    assert.equal(s.pendingUnitType, "execute-task");
  });

  test("a worker that never delivers resolves as a timeout — zero hang (B4)", async () => {
    const prev = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "40";
    try {
      const s = new ForgeAutoSession();
      s.cwd = "/nonexistent";
      const freshCtx = { async sendMessage() {/* worker only narrates, never emits the tool */} };
      s.cmdCtx = {
        async newSession(opts: { withSession?: (ctx: unknown) => Promise<void> }) {
          await opts.withSession?.(freshCtx);
          return { cancelled: false };
        },
      } as never;

      const start = Date.now();
      const outcome = await dispatchUnitViaNewSession(s, UNIT, "PROMPT");
      assert.equal(outcome.kind, "timeout", "resolves as timeout instead of hanging");
      assert.ok(Date.now() - start < 5000, "resolved promptly at the short timeout");
      assert.equal(hasPendingRendezvous(), false, "rendezvous cleared after timeout");
    } finally {
      if (prev === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prev;
    }
  });

  test("a newSession whose worker turn NEVER resolves still resolves within ~timeoutMs — real wall-clock ceiling (R1-a)", async () => {
    const prev = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "50";
    try {
      const s = new ForgeAutoSession();
      s.cwd = "/nonexistent";
      let aborted = false;
      // The worker turn hangs forever (bash/edit loop that never emits the
      // tool). newSession() itself never resolves — the OLD code would await it
      // unbounded and hang. The wall-clock ceiling must interrupt it.
      s.cmdCtx = {
        abort() {
          aborted = true;
        },
        async newSession() {
          return await new Promise<{ cancelled: boolean }>(() => {
            /* never resolves — simulates a hung worker turn */
          });
        },
      } as never;

      const start = Date.now();
      const outcome = await dispatchUnitViaNewSession(s, UNIT, "PROMPT");
      assert.equal(outcome.kind, "timeout", "resolves as timeout instead of hanging");
      assert.ok(Date.now() - start < 5000, "resolved promptly at the wall-clock ceiling");
      assert.equal(aborted, true, "abort() called to interrupt the hung streaming turn");
      assert.equal(hasPendingRendezvous(), false, "rendezvous dropped after the ceiling fired");
    } finally {
      if (prev === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prev;
    }
  });

  // ── E2E-2/W1: early-settle on MCP delivery ───────────────────────────────
  test("delivery via the rendezvous settles the dispatch even while newSession never returns — early-settle aborts the residual turn (E2E-2/W1)", async () => {
    const prev = process.env.FORGE_UNIT_TIMEOUT_MS;
    // Long ceiling so the ONLY prompt settle path is the early-settle on
    // delivery — never the wall-clock timeout.
    process.env.FORGE_UNIT_TIMEOUT_MS = "60000";
    try {
      const s = new ForgeAutoSession();
      s.cwd = "/nonexistent";
      let aborted = false;
      s.cmdCtx = {
        abort() {
          aborted = true;
        },
        async newSession() {
          // SDK worker turn hangs (subprocess mid-tool) and NEVER returns, but
          // it has already committed its result through the MCP rendezvous.
          return await new Promise<{ cancelled: boolean }>(() => {});
        },
      } as never;

      // The forge_unit_result tool delivers mid-turn, before newSession resolves.
      setTimeout(() => {
        deliverUnitResult({ status: "done", summary: "delivered mid-turn", artifacts: ["x.ts"] });
      }, 20);

      const start = Date.now();
      const outcome = await dispatchUnitViaNewSession(s, UNIT, "PROMPT");
      assert.equal(outcome.kind, "result");
      assert.equal(outcome.kind === "result" && outcome.result.summary, "delivered mid-turn");
      assert.ok(Date.now() - start < 5000, "settled on delivery, not on the 60s ceiling");
      assert.equal(aborted, true, "early-settle aborted the residual SDK turn");
      assert.equal(hasPendingRendezvous(), false, "rendezvous consumed by the delivery");
    } finally {
      if (prev === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prev;
    }
  });

  test("a cancelled newSession short-circuits to a synthetic blocked outcome (B4)", async () => {
    const s = new ForgeAutoSession();
    s.cwd = "/nonexistent";
    s.cmdCtx = { async newSession() { return { cancelled: true }; } } as never;

    const outcome = await dispatchUnitViaNewSession(s, UNIT, "PROMPT");
    assert.equal(outcome.kind, "result");
    assert.equal(outcome.kind === "result" && outcome.result.status, "blocked");
    assert.equal(outcome.kind === "result" && outcome.result.reason, "session_cancelled");
  });

  // ── R1 (S04 review): worker-turn error → synthetic blocked, no unhandled rejection ──
  test("a withSession that rejects (worker-turn error) resolves as a synthetic blocked outcome, not a throw (R1)", async () => {
    const s = new ForgeAutoSession();
    s.cwd = "/nonexistent";
    const freshCtx = {
      async sendMessage() {
        // Simulate `sendMessage` throwing inside `withSession` (transient
        // API/network error on the live worker-turn path).
        throw new Error("boom: worker sendMessage failed");
      },
    };
    s.cmdCtx = {
      async newSession(opts: { withSession?: (ctx: unknown) => Promise<void> }) {
        await opts.withSession?.(freshCtx);
        return { cancelled: false };
      },
    } as never;

    const outcome = await dispatchUnitViaNewSession(s, UNIT, "PROMPT");
    assert.equal(outcome.kind, "result");
    assert.equal(outcome.kind === "result" && outcome.result.status, "blocked");
    assert.equal(outcome.kind === "result" && outcome.result.reason, "worker_turn_error");
    assert.equal(hasPendingRendezvous(), false, "abandoned rendezvous dropped via cancelRendezvous()");
  });

  // ── B1: WorkerMcpRecord lifecycle == dispatch window ─────────────────────────
  test("publishes the WorkerMcpRecord during the dispatch and clears it after a delivered result (B1)", async () => {
    clearWorkerMcp();
    const s = new ForgeAutoSession();
    s.cwd = "/nonexistent";

    let recordDuringDispatch: { token: number } | null = null;
    const freshCtx = {
      async sendMessage() {
        // Mid-dispatch: the externalCli record must be published with a token.
        recordDuringDispatch = getWorkerMcpRecord();
        deliverUnitResult({ status: "done", summary: "ok", artifacts: [] });
      },
    };
    s.cmdCtx = {
      async newSession(opts: { withSession?: (ctx: unknown) => Promise<void> }) {
        await opts.withSession?.(freshCtx);
        return { cancelled: false };
      },
    } as never;

    const outcome = await dispatchUnitViaNewSession(s, UNIT, "PROMPT");
    assert.equal(outcome.kind, "result");
    assert.ok(recordDuringDispatch, "record published during the dispatch window");
    assert.equal(
      (recordDuringDispatch as unknown as { token: number }).token,
      s.currentRendezvousToken,
      "published token == THIS dispatch's rendezvous token (B1/MEM001)",
    );
    assert.equal(getWorkerMcpRecord(), null, "record cleared in the dispatch finally");
  });

  test("clears the WorkerMcpRecord after the wall-clock ceiling settles a timeout (B1 — every exit path)", async () => {
    const prev = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "40";
    clearWorkerMcp();
    try {
      const s = new ForgeAutoSession();
      s.cwd = "/nonexistent";
      let recordDuringDispatch: { token: number } | null = null;
      const freshCtx = {
        async sendMessage() {
          recordDuringDispatch = getWorkerMcpRecord();
          // Worker never emits the tool → ceiling fires.
        },
      };
      s.cmdCtx = {
        abort() {},
        async newSession(opts: { withSession?: (ctx: unknown) => Promise<void> }) {
          await opts.withSession?.(freshCtx);
          return { cancelled: false };
        },
      } as never;

      const outcome = await dispatchUnitViaNewSession(s, UNIT, "PROMPT");
      assert.equal(outcome.kind, "timeout");
      assert.ok(recordDuringDispatch, "record published during the dispatch window");
      assert.equal(getWorkerMcpRecord(), null, "record cleared after the timeout settle");
    } finally {
      if (prev === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prev;
    }
  });
});

// ── M1R-2: plan-slice done requires real progress ────────────────────────────

describe("runForgeLoop — M1R-2 plan-slice progress guard", () => {
  test("(a) plan-slice reports done without writing S##-PLAN.md → retry consumed, then pause (no infinite replan, no false complete)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      // The fake plan-slice worker reports `done` but never writes S01-PLAN.md.
      const driver = fakeDriver(cwd, [
        { outcome: done("planned but nothing written") },
        { outcome: done("still nothing written") },
      ]);

      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      assert.equal(driver.units.length, 2, "one dispatch + exactly one retry — no infinite replan");
      const state = readStateDoc(cwd);
      assert.notEqual(state.phase, "complete", "no false milestone-complete");
      assert.equal(s.active, false, "loop paused");
      assert.ok(notes.some(([, l]) => l === "warning"), "paused with a warning");
      const kinds = readEvents(cwd).map((e) => e.kind);
      assert.ok(kinds.includes("unit_retry"), "consumed a normal retry");
      assert.ok(kinds.includes("loop_paused"), "paused after retry exhausted");
    });
  });

  test("(b) plan-slice done with S##-PLAN.md present but 0 task dirs → same destination (no infinite replan, no false complete)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      // Writes S01-PLAN.md but zero task dirs — `planned` is true, `tasks` is empty.
      // deriveNextUnit's dispatch table treats a planned-but-taskless slice as
      // neither plannable (already has a PLAN) nor executable (no task rows),
      // so it falls through to "nothing left to derive" on the very next
      // iteration — the progress-check downgrade still consumes its retry
      // (journaled), and `reconcileCompletion`'s planned+0-tasks guard is what
      // stops the false milestone-complete (2nd door of F4), rather than a
      // second literal re-dispatch. Same observable destination as (a): no
      // infinite replan, no false complete.
      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, []), outcome: done("planned, 0 tasks") },
      ]);

      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      assert.ok(driver.units.length <= 2, "bounded — no infinite replan");
      const state = readStateDoc(cwd);
      assert.notEqual(state.phase, "complete", "no false milestone-complete");
      assert.equal(s.active, false, "loop halts");
      const kinds = readEvents(cwd).map((e) => e.kind);
      // E2E-3: the downgraded-done still consumed a retry attempt, but the loop
      // re-derived to a DIFFERENT outcome (the planned-but-taskless slice falls
      // through to null) rather than re-dispatching the same plan-slice — so the
      // deferred retry marker honestly materializes as `unit_readvanced`, never a
      // `unit_retry` that would claim a re-dispatch that never happened.
      assert.ok(kinds.includes("unit_readvanced"), "the deferred retry marker advanced (no lying unit_retry)");
      assert.ok(!kinds.includes("unit_retry"), "no eager unit_retry for a retry that did not re-dispatch the same unit");
    });
  });

  test("(c) an intact milestone still completes — no regression of the happy path", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01"]), outcome: done("planned") },
        { outcome: done("t01") },
        ...completionSteps(),
      ]);

      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver });

      assert.equal(driver.units.length, 4, "plan + task + the two completion units");
      const state = readStateDoc(cwd);
      assert.equal(state.phase, "complete", "the real progress check does not regress the happy path");
    });
  });

  test("a driver that never makes progress is bounded by the retry taxonomy well under the iteration ceiling", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      let dispatches = 0;
      const s = makeSession(cwd);
      const driver: SessionDriver = {
        async dispatch() {
          dispatches++;
          return done("loops forever without progress");
        },
      };

      await runForgeLoop(s, { cwd, driver });

      assert.ok(dispatches <= 32, "bounded by the retry taxonomy well under the iteration ceiling");
      assert.equal(s.active, false);
    });
  });
});

// ── R2 (review-fix): exercise the iteration-ceiling pause path directly ─────

describe("runForgeLoop — iteration ceiling (R2)", () => {
  test(
    "iterations >= maxIterations pauses with loop_ceiling_reached, never completes, " +
      "and does so WITHOUT tripping the R3 no-progress guard first",
    async () => {
      await withSandboxAsync(async (cwd) => {
        updateState(cwd, () => ({ milestone: MID }) as StateDoc);
        mkdirSync(milestoneDir(cwd), { recursive: true });
        writeRoadmap(cwd);

        // A ping-pong pair (D1/D2) that never lets the slice/milestone
        // complete: whichever of the two isn't the CURRENT dispatch's own
        // task is reverted back to `pending` before the outcome is
        // returned, so `deriveNextUnit` always finds SOMETHING pending
        // from this pair. Sorted after the "AAA*" freshie prefix, so a
        // freshie always takes priority over the pair when one is pending.
        // `ZZBACKSTOP` is NEVER dispatched/touched — its permanently-pending
        // status guarantees `sliceNowDone` can never be true (the flip
        // decision in `applyUnitResult` is computed against the SNAPSHOT
        // read at the top of the iteration, so D1/D2 alone would otherwise
        // both read as "done" in that same snapshot right after the pair's
        // first two dispatches — the backstop closes that gap).
        writeSlicePlan(cwd, ["D1", "D2", "ZZBACKSTOP"]);

        const revertOther = (c: string, taskId: string) => {
          const other = taskId === "D1" ? "D2" : "D1";
          updateState(c, (state) => ({
            ...state,
            units: (state.units ?? []).filter((u) => !(u.id === other && u.type === "task")),
          }));
        };

        // Every 7th dispatch mints ONE brand-new, never-repeated "freshie"
        // task (genuine forward progress — resets the R3 streak) on disk,
        // discoverable by the NEXT iteration's `readSnapshot`. Between
        // freshies, only the D1/D2 pair is pending, so the streak climbs
        // by at most 6 before the next reset — comfortably under R3's
        // `NO_PROGRESS_LIMIT` (8). Each freshie permanently grows
        // `knownTasks` by 1, which nudges `maxIterations` up too (the 4x
        // multiplier) — but the streak-avoidance cadence (every 7) grows
        // `knownTasks` slower than the ceiling's own growth converges, so
        // the loop's OWN `iterations` counter eventually overtakes
        // `maxIterations` (verified empirically below rather than
        // hardcoding the exact convergence point).
        let dispatchCount = 0;
        const driver: SessionDriver = {
          async dispatch(unit, _prompt) {
            dispatchCount++;
            if (unit.type === "execute-task" && (unit.task === "D1" || unit.task === "D2")) {
              revertOther(cwd, unit.task);
            }
            if (dispatchCount % 7 === 0) {
              const freshId = `AAA${String(dispatchCount).padStart(5, "0")}`;
              mkdirSync(join(milestoneDir(cwd), "slices", "S01", "tasks", freshId), { recursive: true });
              writeFileSync(
                join(milestoneDir(cwd), "slices", "S01", "tasks", freshId, `${freshId}-PLAN.md`),
                // S06 (D-S06-1): valid must_haves so the enforcing guard passes the freshie through.
                `---\nid: ${freshId}\nslice: S01\ntitle: "Freshie ${freshId}"\nmust_haves:\n  truths:\n    - "freshie ${freshId} does its thing"\n  artifacts: []\n  key_links: []\n---\n\n# ${freshId}\n`,
              );
            }
            return done("ok");
          },
        };

        const notes: Array<[string, string | undefined]> = [];
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

        assert.equal(s.active, false, "loop pauses, does not hang or throw");
        assert.ok(dispatchCount >= 32, "ran at least the floor number of iterations before pausing");

        const state = readStateDoc(cwd);
        assert.notEqual(state.phase, "complete", "the ceiling path NEVER reconciles/completes the milestone");

        const events = readEvents(cwd);
        const kinds = events.map((e) => e.kind);
        assert.ok(kinds.includes("loop_ceiling_reached"), "loop_ceiling_reached journaled");
        assert.ok(!kinds.includes("loop_no_progress"), "the pacing dodges R3 — this run tests the ceiling in isolation");
        assert.ok(!kinds.includes("milestone_complete"), "no completion event — the ceiling branch never reconciles");
        assert.equal(kinds[kinds.length - 1], "loop_ceiling_reached", "the ceiling event is the loop's final act");
        assert.ok(notes.some(([, l]) => l === "warning"), "paused with a warning notification");
      });
    },
  );
});

// ── R3 (review-fix, operator-approved): the additive no-progress guard ──────

describe("runForgeLoop — no-progress guard (R3)", () => {
  test(
    "a driver oscillating between two tasks (always `done`, never real net progress) is caught by " +
      "loop_no_progress well before the (much higher) iteration ceiling — never completes",
    async () => {
      await withSandboxAsync(async (cwd) => {
        updateState(cwd, () => ({ milestone: MID }) as StateDoc);
        mkdirSync(milestoneDir(cwd), { recursive: true });
        writeRoadmap(cwd);
        // Two oscillating tasks plus a permanently-pending backstop
        // (`ZZBACKSTOP`, never dispatched/touched) so the slice can never
        // read as fully done in the snapshot `applyUnitResult` computes the
        // flip decision against (see the R2 test's comment for why D1/D2
        // alone would otherwise complete after just 2 dispatches).
        // knownTasks=3, unplanned=0 → maxIterations = max(32, 4*3+8) = 32.
        writeSlicePlan(cwd, ["D1", "D2", "ZZBACKSTOP"]);

        // Every dispatch succeeds (`done` → `continue`, so the retry
        // taxonomy never pauses), but each one REVERTS the OTHER task back
        // to `pending` first — an oscillation that keeps re-deriving one
        // of the SAME two already-seen keys forever. Every `continue` after
        // the first two (one per key) is a REPEAT — this is exactly the
        // adversarial "no real net progress" pattern R3 targets (mirrors
        // the review's `knownTasks` inflation concern: a driver that keeps
        // reporting local success without ever advancing the milestone).
        // `NO_PROGRESS_LIMIT` (8) is far below the ceiling (32), so
        // `loop_no_progress` must fire FIRST.
        const revertOther = (c: string, unit: NextUnit) => {
          if (unit.type !== "execute-task") return;
          const other = unit.task === "D1" ? "D2" : "D1";
          updateState(c, (state) => ({
            ...state,
            units: (state.units ?? []).filter((u) => !(u.id === other && u.type === "task")),
          }));
        };
        const driver: SessionDriver = {
          async dispatch(unit, _prompt) {
            revertOther(cwd, unit);
            return done("locally succeeded, no real net progress");
          },
        };

        const notes: Array<[string, string | undefined]> = [];
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

        assert.equal(s.active, false, "loop pauses");
        const state = readStateDoc(cwd);
        assert.notEqual(state.phase, "complete", "no false milestone-complete despite the oscillating local successes");

        const kinds = readEvents(cwd).map((e) => e.kind);
        assert.ok(kinds.includes("loop_no_progress"), "loop_no_progress journaled — the additive guard catches the oscillation");
        assert.ok(!kinds.includes("loop_ceiling_reached"), "the no-progress guard fires well before the ceiling (8 << 32)");
        assert.ok(notes.some(([, l]) => l === "warning"), "paused with a warning notification");
      });
    },
  );
});

// ── R1 (review-fix): stale pendingUnitModel must not survive into the next
//    unit's compose and mis-resolve its result-tool name ──────────────────────

describe("runForgeLoop — R1 stale pendingUnitModel reset (review-fix)", () => {
  test(
    "unit N with a per-type model override (non-claude-code) then N+1 without one → " +
      "N+1's composed prompt uses the namespaced tool name of N+1's LIVE claude-code provider, not N's stale hint",
    async () => {
      await withSandboxAsync(async (cwd) => {
        updateState(cwd, () => ({ milestone: MID }) as StateDoc);
        mkdirSync(milestoneDir(cwd), { recursive: true });
        writeRoadmap(cwd);
        // Per-type override ONLY for plan-slice (unit N), pointing at a
        // non-claude-code provider. execute-task (unit N+1) has NO override.
        writeFileSync(join(cwd, ".gsd", "prefs.md"), "unit_model_plan_slice: openai/gpt-4\n");

        const s = makeSession(cwd);
        // N+1's live provider baseline is claude-code (externalCli) → its worker
        // is instructed to call the namespaced MCP tool name.
        s.baselineModel = { provider: "claude-code" } as never;

        const prompts: string[] = [];
        const units: NextUnit[] = [];
        const driver: SessionDriver = {
          async dispatch(unit, prompt) {
            prompts.push(prompt);
            units.push(unit);
            // Mimic the REAL driver (driver.ts:90-91): publish the per-unit hints
            // for THIS dispatch. Absent the loop-top reset, this stale value
            // survives into the NEXT iteration's compose.
            s.pendingUnitType = unit.type;
            s.pendingUnitModel = resolveUnitModel(cwd, unit.type);
            if (unit.type === "plan-slice") {
              writeSlicePlan(cwd, ["T01"]);
              return done("planned");
            }
            // Completion units leave their durable SUMMARY (the done-without-SUMMARY
            // guard requires it), so the loop runs through to milestone-complete.
            if (unit.type === "complete-slice") {
              writeSliceSummary(cwd, unit.slice);
              return done("slice summary");
            }
            if (unit.type === "complete-milestone") {
              writeMilestoneSummary(cwd);
              return done("milestone summary");
            }
            return done("t01");
          },
        };

        await runForgeLoop(s, { cwd, driver });

        assert.deepEqual(
          units.map(label),
          ["plan:S01", "task:T01", "complete-slice:S01", "complete-milestone:M-toy"],
          "dispatched plan-slice → execute-task → the completion units",
        );
        // N+1 (execute-task) prompt must carry the namespaced name of its OWN
        // live claude-code provider — never the bare name that N's stale
        // openai/gpt-4 hint would have produced (fail-before/pass-after).
        assert.ok(
          prompts[1].includes(FORGE_MCP_UNIT_RESULT_TOOL),
          "N+1 prompt uses the namespaced mcp__forge__forge_unit_result (live provider), not N's stale hint",
        );
      });
    },
  );
});

// ── R2/R4 (review-fix): early-settle serialization + no spurious stale cancel ─

describe("dispatchUnitViaNewSession — R2/R4 early-settle serialization (review-fix)", () => {
  const U1: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
  const U2: NextUnit = { type: "execute-task", slice: "S01", task: "T02" };

  test(
    "R2: after an early-settle, the abandoned newSession settles BEFORE the next dispatch's newSession starts",
    async () => {
      const prev = process.env.FORGE_UNIT_TIMEOUT_MS;
      process.env.FORGE_UNIT_TIMEOUT_MS = "60000"; // long ceiling — only early-settle can win
      try {
        const s = new ForgeAutoSession();
        s.cwd = "/nonexistent";
        const order: string[] = [];
        let releaseFirst: () => void = () => {};
        const firstNs = new Promise<{ cancelled: boolean }>((res) => {
          releaseFirst = () => res({ cancelled: false });
        });
        let call = 0;
        s.cmdCtx = {
          abort() {
            // The early-settle abort triggers the abandoned first newSession to
            // unwind, but only after a tick so the ordering is observable.
            setTimeout(() => {
              order.push("first-newSession-settles");
              releaseFirst();
            }, 30);
          },
          async newSession() {
            call++;
            if (call === 1) {
              order.push("first-newSession-start");
              return await firstNs; // resolves ~30ms after abort()
            }
            order.push("second-newSession-start");
            deliverUnitResult({ status: "done", summary: "second", artifacts: [] });
            return { cancelled: false };
          },
        } as never;

        // First unit delivers mid-turn → early-settle wins the race.
        setTimeout(() => deliverUnitResult({ status: "done", summary: "first", artifacts: [] }), 10);

        const first = await dispatchUnitViaNewSession(s, U1, "P1");
        assert.equal(
          first.kind === "result" && first.result.summary,
          "first",
          "(a) the dispatch settled with the delivered result",
        );

        const second = await dispatchUnitViaNewSession(s, U2, "P2");
        assert.equal(second.kind === "result" && second.result.summary, "second");

        const iSettle = order.indexOf("first-newSession-settles");
        const iSecondStart = order.indexOf("second-newSession-start");
        assert.ok(iSettle >= 0, "the abandoned first newSession settled");
        assert.ok(iSecondStart >= 0, "the second newSession started");
        assert.ok(
          iSettle < iSecondStart,
          "(b) the second newSession starts only AFTER the abandoned first settles — no overlap",
        );
      } finally {
        if (prev === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
        else process.env.FORGE_UNIT_TIMEOUT_MS = prev;
      }
    },
  );

  test(
    "R4: an abandoned newSession that rejects after early-settle journals NO spurious stale_rendezvous_cancel",
    async () => {
      await withSandboxAsync(async (cwd) => {
        const prev = process.env.FORGE_UNIT_TIMEOUT_MS;
        process.env.FORGE_UNIT_TIMEOUT_MS = "60000";
        try {
          const s = new ForgeAutoSession();
          s.cwd = cwd;
          let rejectFirst: (e: Error) => void = () => {};
          const firstNs = new Promise<{ cancelled: boolean }>((_res, rej) => {
            rejectFirst = (e) => rej(e);
          });
          let call = 0;
          s.cmdCtx = {
            abort() {
              // The abandoned first turn unwinds by REJECTING post-abort.
              setTimeout(() => rejectFirst(new Error("aborted turn unwind")), 30);
            },
            async newSession() {
              call++;
              if (call === 1) return await firstNs;
              // The SECOND unit's rendezvous stays ARMED (pending) for a while —
              // it delivers only LATER. This keeps a live arm present at the
              // moment the abandoned first turn rejects, which is exactly the
              // window where an unguarded/unserialized late cancel would target
              // the WRONG (already re-armed) rendezvous and journal a spurious
              // stale cancel.
              setTimeout(() => {
                deliverUnitResult({ status: "done", summary: "second", artifacts: [] });
              }, 40);
              return { cancelled: false };
            },
          } as never;

          // First unit delivers mid-turn → early-settle; its residual turn then
          // rejects late while the NEXT unit is being dispatched.
          setTimeout(() => deliverUnitResult({ status: "done", summary: "first", artifacts: [] }), 10);

          const first = await dispatchUnitViaNewSession(s, U1, "P1");
          assert.equal(first.kind === "result" && first.result.summary, "first");

          const second = await dispatchUnitViaNewSession(s, U2, "P2");
          assert.equal(second.kind === "result" && second.result.summary, "second");

          // Let any late continuation of the abandoned turn flush.
          await new Promise((r) => setTimeout(r, 60));

          const stale = readEvents(cwd).filter((e) => e.kind === "stale_rendezvous_cancel");
          assert.equal(
            stale.length,
            0,
            "no spurious stale_rendezvous_cancel for the unit that actually completed (FORGE2-S01-ACCEPTANCE #6)",
          );
        } finally {
          if (prev === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
          else process.env.FORGE_UNIT_TIMEOUT_MS = prev;
        }
      });
    },
  );
});

// ── E2E-4 (T06): structured terminal reason at each exit point ────────────────

describe("runForgeLoop — E2E-4 structured terminal (T06)", () => {
  test("happy path returns { reason: 'complete' }", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01"]), outcome: done("planned") },
        { outcome: done("t01") },
        ...completionSteps(),
      ]);
      const terminal = await runForgeLoop(makeSession(cwd), { cwd, driver });
      assert.equal(terminal.reason, "complete");
    });
  });

  test("a blocked unit returns { reason: 'blocked' }", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      const driver = fakeDriver(cwd, [
        { outcome: { kind: "result", result: { status: "blocked", summary: "need human", artifacts: [], reason: "ambíguo" } } },
      ]);
      const terminal = await runForgeLoop(makeSession(cwd), { cwd, driver });
      assert.equal(terminal.reason, "blocked");
      assert.match(terminal.message ?? "", /human|bloq|ambíguo/i);
    });
  });

  test("retry exhausted (partial×2) returns { reason: 'paused' }", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      const partial: UnitOutcome = { kind: "result", result: { status: "partial", summary: "nope", artifacts: [] } };
      const driver = fakeDriver(cwd, [{ outcome: partial }, { outcome: partial }]);
      const terminal = await runForgeLoop(makeSession(cwd), { cwd, driver });
      assert.equal(terminal.reason, "paused");
    });
  });

  test("resume guard (STATE already blocked) returns { reason: 'blocked' } without dispatch", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID, units: [{ id: "T01", type: "task", status: "blocked", slice: "S01" }] }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      const driver = fakeDriver(cwd, []);
      const terminal = await runForgeLoop(makeSession(cwd), { cwd, driver });
      assert.equal(terminal.reason, "blocked");
      assert.equal(driver.units.length, 0, "the durable-blocked unit is never re-dispatched");
    });
  });

  test("resume guard (STATE already partial) returns { reason: 'paused' }", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID, units: [{ id: "T01", type: "task", status: "partial", slice: "S01" }] }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      const driver = fakeDriver(cwd, []);
      const terminal = await runForgeLoop(makeSession(cwd), { cwd, driver });
      assert.equal(terminal.reason, "paused");
      assert.equal(driver.units.length, 0);
    });
  });

  test("once: a single successful unit returns { reason: 'complete' }", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01"]), outcome: done("planned") },
      ]);
      const terminal = await runForgeLoop(makeSession(cwd), { cwd, driver }, { once: true });
      assert.equal(terminal.reason, "complete");
      assert.equal(driver.units.length, 1, "exactly one unit ran under once");
    });
  });
});

// ── S03/T02: real review wiring through the loop ────────────────────────────
describe("runForgeLoop — S03 review dialectic wiring", () => {
  test("/forge next writes a task-scoped review after a successful task", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      const calls: string[] = [];
      const reviewDispatcher: ReviewDispatcher = {
        async dispatch(prompt) {
          calls.push(prompt);
          return "NO_FLAGS";
        },
      };
      const driver = fakeDriver(cwd, [{ outcome: done("task complete") }]);
      const terminal = await runForgeLoop(
        makeSession(cwd),
        { cwd, driver, reviewDispatcher },
        { once: true },
      );
      assert.equal(terminal.reason, "complete");
      assert.ok(existsSync(join(milestoneDir(cwd), "slices", "S01", "tasks", "T01", "T01-REVIEW.md")));
      assert.equal(readEvents(cwd).filter((event) => event.kind === "review").length, 1);
      assert.equal(calls.length, 0, "empty sandbox diff uses the review stub without a worker turn");
    });
  });
});

// ── C3 (S05): review hooks fire ONCE per unit, not per retry ─────────────────
describe("runForgeLoop — review hook is gated to the first dispatch (C3)", () => {
  test("a retried complete-slice emits the review event / notify exactly once", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]); // already planned ⇒ first unit is execute-task

      const notes: string[] = [];
      const driver = fakeDriver(cwd, [
        // T01 done → slice ready for complete-slice.
        { outcome: done("t01") },
        // complete-slice #1: reports done but writes NO S01-SUMMARY → D-S03-1
        // guard downgrades to partial → retry (re-derives the SAME complete-slice).
        { outcome: done("no summary yet") },
        // complete-slice #2 (the retry): writes the SUMMARY → done.
        { onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)), outcome: done("slice summary written") },
        // complete-milestone.
        { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary written") },
      ]);

      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: (m) => notes.push(m) });

      // complete-slice was dispatched TWICE (original + retry) …
      const completeSliceDispatches = driver.units.filter(
        (u) => u.type === "complete-slice",
      ).length;
      assert.equal(completeSliceDispatches, 2, "complete-slice was retried once");

      // … but the review hook fired only on the FIRST dispatch: exactly one
      // `review` event and exactly one deferral notify (not one per attempt).
      const reviewEvents = readEvents(cwd).filter((e) => e.kind === "review");
      assert.equal(
        reviewEvents.length,
        1,
        "review event emitted once per unit, not per retry",
      );
      const reviewNotes = notes.filter((m) => /Review S01/.test(m));
      assert.equal(reviewNotes.length, 1, "review deferral notify fired once, not per retry");
    });
  });
});

// ── S02/T02 — reviewer_not_author violation signal on the dispatch call-site ─

/**
 * M-20260711135806-wiring-multi-llm / S02 / T02 — the loop's own dispatch
 * block (`resolveModelForRole` call ~line 983) must not swallow T01's
 * `violation: "reviewer_not_author"` marker as an ordinary "no per-unit
 * model": it notifies the operator via the loop's own `notify` channel
 * (`notifyReviewerNotAuthorViolation`) distinctly from the generic
 * `on_missing_pool: "block"` BLOCKED (no marker, no notify) and from a normal
 * degrade (role.ts's own console.warn, not a `notify` call).
 *
 * Honesty note (T02-PLAN step 5, "fake do seam"): no production `NextUnit`
 * type resolves as `reviewer`/`advocate` (`roleForUnit` has no entry for
 * either — S04 decisão B), so `runForgeLoop`'s own call to
 * `resolveModelForRole` can never actually produce a `violation` marker
 * through a real dispatch today. The exported `notifyReviewerNotAuthor
 * Violation` helper is therefore exercised directly with a fake `notify`
 * collector — the same contract the real call-site invokes it under. The
 * second test proves the real call-site's non-regression across the FULL
 * happy-path run already exercised above: none of its notify calls ever
 * carry the violation text.
 */
describe("loop: reviewer_not_author violation signal (S02/T02)", () => {
  test("notifyReviewerNotAuthorViolation notifies at 'warning' level with a message distinct from the generic degrade warn", () => {
    const notes: Array<{ message: string; level?: string }> = [];
    notifyReviewerNotAuthorViolation((message, level) => notes.push({ message, level }), "S01/T01");

    assert.equal(notes.length, 1, "exactly one notify call");
    assert.equal(notes[0].level, "warning");
    assert.match(notes[0].message, /reviewer_not_author/, "message cites the violation by name");
    assert.match(notes[0].message, /S01\/T01/, "message cites the dispatch key");
    assert.doesNotMatch(
      notes[0].message,
      /degrading to pool-of-one/,
      "must not read like the generic degrade warn",
    );
  });

  test("non-regression: the full happy-path run never notifies a reviewer_not_author violation", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      const notes: string[] = [];
      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01", "T02"]), outcome: done("planned") },
        { outcome: done("t01") },
        { outcome: done("t02") },
        ...completionSteps(),
      ]);

      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: (m) => notes.push(m) });

      assert.equal(readStateDoc(cwd).phase, "complete");
      assert.ok(
        !notes.some((m) => /reviewer_not_author/.test(m)),
        "roleForUnit never returns reviewer/advocate on the real dispatch path — the violation notify can never fire",
      );
      const kinds = readEvents(cwd).map((e) => e.kind);
      assert.ok(
        !kinds.includes("reviewer_not_author_violation"),
        "the dedicated driver-side journal kind is also never emitted on this path",
      );
    });
  });
});

// ── S09/T03: rank_reason + domain on unit_dispatched ────────────────────────

/**
 * `.gsd/models.md` routing `executor` to two pools, in declared order — same
 * fenceless shape `domain-routing-e2e.test.ts` already proves `readModelsConfig`
 * accepts (`auto/models-config.ts`).
 */
function writeExecutorTwoPoolConfig(cwd: string, firstPoolRef: string, secondPoolRef: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    `pools:\n  claude-exec:\n    - ${firstPoolRef}\n  gpt:\n    - ${secondPoolRef}\n\nroles:\n  executor:\n    - claude-exec\n    - gpt\n`,
  );
}

/**
 * `.gsd/CAPABILITIES.md` in the locked pipe-table format
 * (FORGE2-CAPABILITIES-FORMAT.md §2) — refs VERBATIM, byte-identical to
 * `models.md`'s pool refs (same FI `domain-routing-e2e.test.ts` documents).
 */
function writeCapabilitiesMatrix(cwd: string, rows: Array<[string, string, string]>): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  const body = rows.map(([d, m, s]) => `| ${d} | ${m} | ${s} |`).join("\n");
  writeFileSync(
    join(cwd, ".gsd", "CAPABILITIES.md"),
    `| domain | model | score |\n| --- | --- | --- |\n${body}\n`,
  );
}

/**
 * Through-the-driver proof (`runForgeLoop → resolveDispatchAuthor →
 * resolveModelForRole` reading REAL `.gsd/models.md`/`.gsd/CAPABILITIES.md`
 * off disk, fake driver only for the worker outcome) that `unit_dispatched`
 * carries the T01/T02 cross-pool judgment's audit trail — `rank_reason`
 * ADDITIVE and matching `role.test.ts`'s worked example (terra 0.90 beats
 * sonnet 0.65 despite sonnet's earlier pool position), and `domain` closing
 * the addendum §6 cosmetic gap — with a byte-identity companion proving both
 * fields stay ABSENT (never `""`/`"null"`) when the task declares no
 * `domain:` hint at all (the guard path never even reads CAPABILITIES.md).
 */
describe("runForgeLoop — S09/T03: rank_reason + domain on unit_dispatched", () => {
  const SONNET = "claude-code/claude-sonnet-5";
  const TERRA = "openai-codex/gpt-5.6-terra";

  test("cross-pool judgment decided: unit_dispatched carries rank_reason + domain, terra (2nd pool) wins on capability", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeExecutorTwoPoolConfig(cwd, SONNET, TERRA);
      writeCapabilitiesMatrix(cwd, [
        ["infra", SONNET, "0.65"],
        ["infra", TERRA, "0.90"],
      ]);

      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01"], "domain: infra\n"), outcome: done("planned") },
        { outcome: done("t01") },
        ...completionSteps(),
      ]);

      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: () => {} });

      const dispatched = readEvents(cwd).find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for T01 exists in the journal");
      assert.equal(dispatched!.model, TERRA, "capability (not pool order) picked the winner");
      assert.equal(dispatched!.domain, "infra");
      assert.equal(typeof dispatched!.rank_reason, "string");
      assert.match(dispatched!.rank_reason as string, /^capability:infra/);
      assert.match(dispatched!.rank_reason as string, new RegExp(TERRA.replace(/[/.]/g, "\\$&")));
    });
  });

  test("byte-identity: no `domain:` hint on the task -> rank_reason/domain both ABSENT from unit_dispatched", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      // Same two-pool config + matrix as the judgment scenario above — the
      // ONLY difference is the task plan carries no `domain:` frontmatter,
      // so `domainHintForUnit` degrades to `undefined` and the seam never
      // even reads CAPABILITIES.md (S03 guard, reused unchanged by S09).
      writeExecutorTwoPoolConfig(cwd, SONNET, TERRA);
      writeCapabilitiesMatrix(cwd, [
        ["infra", SONNET, "0.65"],
        ["infra", TERRA, "0.90"],
      ]);

      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01"]), outcome: done("planned") },
        { outcome: done("t01") },
        ...completionSteps(),
      ]);

      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: () => {} });

      const dispatched = readEvents(cwd).find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for T01 exists in the journal");
      assert.equal(dispatched!.model, SONNET, "no domain hint -> legacy pool-order walk, first pool wins");
      assert.equal("rank_reason" in dispatched!, false, "rank_reason must be ABSENT, never \"\"");
      assert.equal("domain" in dispatched!, false, "domain must be ABSENT, never \"\"");
    });
  });
});
