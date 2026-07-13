/**
 * `auto/loop.ts` S06 verify wiring — integration test with a scripted FAKE driver
 * (S06/T06, D-S06-1 enforcing + D-S06-4/5 advisory).
 *
 * Proves:
 *   (a) a present-but-LEGACY `T##-PLAN.md` (no `must_haves:` block) BLOCKS the
 *       execute-task PRE-dispatch: the loop journals `must_haves_gate:blocked`,
 *       persists `blocked`, returns `{reason:"blocked"}`, and NEVER calls the driver
 *       for that task;
 *   (b) a MALFORMED `must_haves:` schema blocks identically;
 *   (c) a VALID plan dispatches normally (the enforcing guard is transparent);
 *   (d) `runVerifyGate` on a `complete-slice` writes `S##-VERIFICATION.md` and journals
 *       `verify` + `file_audit` WITHOUT altering the dispatch outcome;
 *   (e) an IO error (absent plan) NEVER blocks — the task dispatches;
 *   (f) a throw inside the verify gate is swallowed best-effort (the loop still completes).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForgeLoop, type SessionDriver } from "../auto/loop.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { updateState, readState } from "../state/store.ts";
import type { StateDoc } from "../state/types.ts";
import type { NextUnit } from "../state/dispatch.ts";
import { unitSlice } from "../state/dispatch.ts";
import type { UnitOutcome } from "../worker/rendezvous.ts";

const MID = "M-toy";

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-verify-int-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function milestoneDir(cwd: string): string {
  return join(cwd, ".gsd", "milestones", MID);
}

function writeRoadmap(cwd: string): void {
  writeFileSync(
    join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
    `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | pending |\n`,
  );
}

/** A T01-PLAN.md body with the given (already-indented) frontmatter tail. */
function taskPlanBody(mustHavesFm: string): string {
  return `---\nid: T01\nslice: S01\ntitle: "Task T01"\n${mustHavesFm}---\n\n# T01\n\n## Goal\nImplement it.\n`;
}

const LEGACY_TASK = taskPlanBody(""); // no must_haves: block at all
const MALFORMED_TASK = taskPlanBody("must_haves:\n  truths: notanarray\n");
const VALID_TASK = taskPlanBody(
  'must_haves:\n  truths:\n    - "does the thing"\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/out.ts\n',
);

/**
 * Write S01-PLAN.md declaring T01 in § Tasks, plus a single T01-PLAN.md whose
 * frontmatter is controlled by `taskFm`. The plan-slice: done then makes the loop
 * derive execute-task T01 (planned + 1 task).
 */
function writePlan(cwd: string, taskPlan: string): void {
  const slicesDir = join(milestoneDir(cwd), "slices", "S01");
  mkdirSync(join(slicesDir, "tasks", "T01"), { recursive: true });
  writeFileSync(
    join(slicesDir, "S01-PLAN.md"),
    `---\nid: S01\nmilestone: ${MID}\ntitle: "Primeira slice"\n---\n\n# S01 plan\n\n## Tasks\n\n- T01\n`,
  );
  writeFileSync(join(slicesDir, "tasks", "T01", "T01-PLAN.md"), taskPlan);
}

function writeSliceSummary(cwd: string, slice = "S01"): void {
  writeFileSync(join(milestoneDir(cwd), "slices", slice, `${slice}-SUMMARY.md`), `# ${slice} summary\n`);
}

function writeMilestoneSummary(cwd: string): void {
  writeFileSync(join(milestoneDir(cwd), `${MID}-SUMMARY.md`), `# ${MID} summary\n`);
}

function done(summary = "ok"): UnitOutcome {
  return { kind: "result", result: { status: "done", summary, artifacts: [] } };
}

interface Step {
  onDispatch?: (cwd: string, unit: NextUnit, prompt: string) => void;
  outcome: UnitOutcome;
}

function fakeDriver(cwd: string, steps: Step[]): SessionDriver & { units: NextUnit[] } {
  const units: NextUnit[] = [];
  let i = 0;
  return {
    units,
    async dispatch(unit: NextUnit, prompt: string): Promise<UnitOutcome> {
      const step = steps[i++];
      assert.ok(step, `fake driver ran out of scripted steps at dispatch #${i}`);
      units.push(unit);
      step.onDispatch?.(cwd, unit, prompt);
      return step.outcome;
    },
  };
}

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function makeSession(cwd: string): ForgeAutoSession {
  const s = new ForgeAutoSession();
  s.active = true;
  s.cwd = cwd;
  return s;
}

function label(u: NextUnit): string {
  if (u.type === "execute-task") return `task:${u.task}`;
  if (u.type === "complete-slice") return `complete-slice:${u.slice}`;
  if (u.type === "complete-milestone") return `complete-milestone:${u.milestone}`;
  return `plan:${unitSlice(u)}`;
}

function bootstrap(cwd: string): void {
  updateState(cwd, () => ({ milestone: MID }) as StateDoc);
  mkdirSync(milestoneDir(cwd), { recursive: true });
  writeRoadmap(cwd);
}

describe("runForgeLoop — S06 enforcing must-haves gate (D-S06-1)", () => {
  test("(a) a LEGACY execute-task plan BLOCKS pre-dispatch — no driver call, blocked terminal, gate event", async () => {
    await withSandboxAsync(async (cwd) => {
      bootstrap(cwd);
      const driver = fakeDriver(cwd, [
        // plan-slice writes a legacy T01-PLAN.md; execute-task must NOT dispatch after.
        { onDispatch: (c) => writePlan(c, LEGACY_TASK), outcome: done("planned") },
      ]);

      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver });

      assert.deepEqual(
        driver.units.map(label),
        ["plan:S01"],
        "the driver was NEVER called for execute-task T01 — the enforcing guard blocked pre-dispatch",
      );
      assert.equal(term.reason, "blocked", "the loop returns a blocked terminal");

      const events = readEvents(cwd);
      const gate = events.find((e) => e.kind === "must_haves_gate");
      assert.ok(gate, "a must_haves_gate event was journaled");
      assert.equal(gate?.status, "blocked", "the gate event is blocked");
      assert.equal(gate?.task, "T01", "the gate event names the blocked task");
      assert.match(String(gate?.summary), /legacy/, "the summary cites the legacy reason");

      // durable STATE persisted blocked (M1R-4 parity).
      const state = readState(cwd);
      const taskUnit = (state.units ?? []).find((u) => u.type === "task" && u.id === "T01");
      assert.equal(taskUnit?.status, "blocked", "STATE persisted the task as blocked via applyUnitResult");
    });
  });

  test("(b) a MALFORMED must_haves schema BLOCKS identically", async () => {
    await withSandboxAsync(async (cwd) => {
      bootstrap(cwd);
      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writePlan(c, MALFORMED_TASK), outcome: done("planned") },
      ]);

      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver });

      assert.deepEqual(driver.units.map(label), ["plan:S01"], "malformed plan → no execute-task dispatch");
      assert.equal(term.reason, "blocked");
      const gate = readEvents(cwd).find((e) => e.kind === "must_haves_gate");
      assert.ok(gate, "must_haves_gate journaled");
      assert.match(String(gate?.summary), /malformed/, "summary cites the malformed reason");
    });
  });

  test("(c) a VALID plan dispatches normally — the enforcing guard is transparent", async () => {
    await withSandboxAsync(async (cwd) => {
      bootstrap(cwd);
      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writePlan(c, VALID_TASK), outcome: done("planned") },
        { outcome: done("t01") },
        { onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)), outcome: done("slice summary") },
        { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary") },
      ]);

      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver });

      assert.deepEqual(
        driver.units.map(label),
        ["plan:S01", "task:T01", "complete-slice:S01", "complete-milestone:M-toy"],
        "a valid must_haves schema does NOT block — the loop ran to completion",
      );
      assert.equal(term.reason, "complete");
      assert.equal(
        readEvents(cwd).find((e) => e.kind === "must_haves_gate"),
        undefined,
        "no must_haves_gate event for a valid plan",
      );
    });
  });

  test("(e) an ABSENT plan (IO error) NEVER blocks — the task dispatches", async () => {
    await withSandboxAsync(async (cwd) => {
      bootstrap(cwd);
      const driver = fakeDriver(cwd, [
        {
          // plan-slice writes S01-PLAN.md declaring T01, but DELETES the T01-PLAN.md
          // so the enforcing read hits an IO error — which must NOT block.
          onDispatch: (c) => {
            writePlan(c, VALID_TASK);
            rmSync(join(milestoneDir(c), "slices", "S01", "tasks", "T01", "T01-PLAN.md"));
          },
          outcome: done("planned"),
        },
        { outcome: done("t01") },
        { onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)), outcome: done("slice summary") },
        { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary") },
      ]);

      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver });

      assert.ok(
        driver.units.map(label).includes("task:T01"),
        "an IO error (missing plan file) does NOT block — the task was dispatched",
      );
      assert.equal(term.reason, "complete");
      assert.equal(
        readEvents(cwd).find((e) => e.kind === "must_haves_gate"),
        undefined,
        "no gate event on an IO error — only present-but-invalid blocks",
      );
    });
  });
});

describe("runForgeLoop — S06 advisory verify gate (D-S06-4/5)", () => {
  test("(d) runVerifyGate writes S##-VERIFICATION.md and journals verify + file_audit without altering the outcome", async () => {
    await withSandboxAsync(async (cwd) => {
      bootstrap(cwd);
      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writePlan(c, VALID_TASK), outcome: done("planned") },
        { outcome: done("t01") },
        { onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)), outcome: done("slice summary") },
        { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary") },
      ]);

      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver });

      const verificationMd = join(milestoneDir(cwd), "slices", "S01", "S01-VERIFICATION.md");
      assert.ok(existsSync(verificationMd), "S01-VERIFICATION.md was written by runVerifyGate");

      const events = readEvents(cwd);
      const verifyEv = events.find((e) => e.kind === "verify");
      const fileAuditEv = events.find((e) => e.kind === "file_audit");
      assert.ok(verifyEv, "a verify event was journaled");
      assert.ok(fileAuditEv, "a file_audit event was journaled");
      assert.match(String(verifyEv?.summary), /rows=/, "verify summary carries the counts");
      assert.match(String(fileAuditEv?.summary), /missing=/, "file_audit summary carries the sets");

      // the advisory gate is LATERAL — the loop completed exactly as it would without it.
      assert.deepEqual(driver.units.map(label), [
        "plan:S01",
        "task:T01",
        "complete-slice:S01",
        "complete-milestone:M-toy",
      ]);
      assert.equal(term.reason, "complete", "the verify gate never blocks/mutates the outcome");
    });
  });

  test("(f) a throw inside the verify gate is swallowed best-effort — the loop still completes", async () => {
    await withSandboxAsync(async (cwd) => {
      bootstrap(cwd);
      const driver = fakeDriver(cwd, [
        {
          onDispatch: (c) => {
            writePlan(c, VALID_TASK);
            // Sabotage the VERIFICATION target: pre-create the slice's output PATH as a
            // directory so writeVerification's atomic rename throws mid-gate. The gate's
            // try/catch must swallow it and the loop must still complete.
            mkdirSync(join(milestoneDir(c), "slices", "S01", "S01-VERIFICATION.md"), {
              recursive: true,
            });
          },
          outcome: done("planned"),
        },
        { outcome: done("t01") },
        { onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)), outcome: done("slice summary") },
        { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary") },
      ]);

      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      assert.deepEqual(
        driver.units.map(label),
        ["plan:S01", "task:T01", "complete-slice:S01", "complete-milestone:M-toy"],
        "a throwing verify gate never blocks — the loop advanced and completed unchanged",
      );
      assert.equal(term.reason, "complete", "best-effort: the verify failure is swallowed, milestone completes");
    });
  });
});
