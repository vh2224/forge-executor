/**
 * `auto/loop.ts` advisory-gate hook — integration test with a scripted FAKE
 * driver (S04/T05, D-S04-1).
 *
 * Proves the loop runs the STRICTLY advisory gates IN-PROCESS right after a
 * `plan-slice: done`, WITHOUT ever letting them alter the dispatch flow:
 *   - `S##-PLAN-CHECK.md` + `S##-SECURITY.md` land on disk;
 *   - a `.gsd/checker/<slice>.md` fragment row is written for a warn/fail dimension;
 *   - `plan_check` + `plan_gate` events are journaled;
 *   - the loop ADVANCES to execute-task EVEN when the plan scores `fail > 0`
 *     (advisory — the gate never blocks/re-dispatches/downgrades);
 *   - a gate that THROWS is swallowed best-effort and the loop still completes.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "forge-gates-test-"));
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

/**
 * Write an S01-PLAN.md that DECLARES T01+T02 in § Tasks, mentions security
 * keywords (auth/login → non-empty security scan), and two task plans that share
 * a DUPLICATE `expected_output` path — forcing the plan-checker's
 * `expected_output_realistic` dimension to score `fail` (so fail > 0 and the loop
 * must still advance, D-S04-1).
 */
function writePlanWithFail(cwd: string): void {
  const slicesDir = join(milestoneDir(cwd), "slices", "S01");
  mkdirSync(slicesDir, { recursive: true });
  writeFileSync(
    join(slicesDir, "S01-PLAN.md"),
    `---\nid: S01\nmilestone: ${MID}\ntitle: "Primeira slice"\n---\n\n# S01 plan — auth login flow\n\n## Tasks\n\n- T01\n- T02\n`,
  );
  for (const t of ["T01", "T02"]) {
    mkdirSync(join(slicesDir, "tasks", t), { recursive: true });
    writeFileSync(
      join(slicesDir, "tasks", t, `${t}-PLAN.md`),
      // S06 (D-S06-1): valid must_haves so the loop's enforcing guard passes the
      // task through — this suite exercises the S04 plan-slice hook, not enforcing.
      `---\nid: ${t}\nslice: S01\ntitle: "Task ${t}"\nmust_haves:\n  truths:\n    - "task ${t} does its thing"\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/dup.ts\n---\n\n# ${t}\n\n## Goal\nImplement auth login handling.\n`,
    );
  }
}

/**
 * S01 — write an `M-toy-CONTEXT.md` carrying the real bancada clause
 * (`detectFrontmatterRequirement`'s target: an obligation word, then `domain`,
 * then `effort`, on one line). Mirrors the live phrasing in this milestone's
 * own `M-20260712170458-cockpit-v2-CONTEXT.md`.
 */
function writeContextWithFrontmatterRequirement(cwd: string): void {
  writeFileSync(
    join(milestoneDir(cwd), `${MID}-CONTEXT.md`),
    `# Toy milestone — context\n\nTodos os detectores valem; o planner DEVE emitir \`domain:\`/\`effort:\` em todo T##-PLAN.\n`,
  );
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

function completionSteps(): Step[] {
  return [
    { onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)), outcome: done("slice summary") },
    { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary") },
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

describe("runForgeLoop — S04 advisory gates hook (D-S04-1)", () => {
  test("after plan-slice: done the hook writes artifacts + fragment + events, and the loop advances despite fail>0", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      const driver = fakeDriver(cwd, [
        // plan-slice: the planner writes the fail-scoring plan (dup expected_output).
        { onDispatch: (c) => writePlanWithFail(c), outcome: done("planned") },
        { outcome: done("t01") },
        { outcome: done("t02") },
        ...completionSteps(),
      ]);

      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver });

      // ── artifacts ──
      const planCheck = join(milestoneDir(cwd), "slices", "S01", "S01-PLAN-CHECK.md");
      const security = join(milestoneDir(cwd), "slices", "S01", "S01-SECURITY.md");
      assert.ok(existsSync(planCheck), "S01-PLAN-CHECK.md written by the advisory hook");
      assert.ok(existsSync(security), "S01-SECURITY.md written by the advisory hook");
      const fragment = join(cwd, ".gsd", "checker", MID, "S01.md");
      assert.ok(existsSync(fragment), ".gsd/checker/<mid>/S01.md fragment written for a warn/fail dimension");

      // ── the fail is real (duplicate expected_output) ──
      const checkBody = readFileSync(planCheck, "utf-8");
      assert.match(checkBody, /expected_output_realistic \| fail/, "the plan genuinely scored a fail dimension");

      // ── events ──
      const events = readEvents(cwd);
      const planCheckEv = events.find((e) => e.kind === "plan_check");
      const planGateEv = events.find((e) => e.kind === "plan_gate");
      assert.ok(planCheckEv, "plan_check event journaled");
      assert.ok(planGateEv, "plan_gate event journaled");
      assert.equal(planGateEv?.status, "skipped", "plan_gate outcome is skipped (D-S04-6)");
      assert.match(String(planCheckEv?.summary), /fail=/, "plan_check summary carries the counts");

      // ── the loop ADVANCED to execute-task regardless of fail>0 (advisory) ──
      assert.deepEqual(
        driver.units.map(label),
        ["plan:S01", "task:T01", "task:T02", "complete-slice:S01", "complete-milestone:M-toy"],
        "fail>0 does NOT block: the loop advanced straight to execute-task and completed",
      );
      assert.equal(term.reason, "complete", "the milestone completed normally — the gate is lateral");
    });
  });

  test("a gate that THROWS is swallowed best-effort — the loop still advances and completes", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);

      const driver = fakeDriver(cwd, [
        {
          onDispatch: (c) => {
            writePlanWithFail(c);
            // Sabotage the checker dir: pre-create `.gsd/checker` as a NON-writable
            // file-shaped path so writeCheckerFragment throws mid-hook. The hook's
            // try/catch must swallow it and the loop must still advance.
            const checkerParent = join(c, ".gsd");
            mkdirSync(checkerParent, { recursive: true });
            writeFileSync(join(checkerParent, "checker"), "not a directory");
          },
          outcome: done("planned"),
        },
        { outcome: done("t01") },
        { outcome: done("t02") },
        ...completionSteps(),
      ]);

      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      assert.deepEqual(
        driver.units.map(label),
        ["plan:S01", "task:T01", "task:T02", "complete-slice:S01", "complete-milestone:M-toy"],
        "a throwing gate never blocks — the loop advanced and completed unchanged",
      );
      assert.equal(term.reason, "complete", "best-effort: the gate failure is swallowed, milestone completes");
    });
  });
});

describe("runForgeLoop — S01 frontmatter_compliance notify (D-S04-1 lateral)", () => {
  test("CONTEXT requires domain/effort + non-conforming tasks: notify warning, scorecard row, CHECKER fragment — loop still advances", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeContextWithFrontmatterRequirement(cwd);

      const driver = fakeDriver(cwd, [
        // T01/T02 in writePlanWithFail never set `domain:`/`effort:` — both
        // are non-conforming once the CONTEXT clause requires them.
        { onDispatch: (c) => writePlanWithFail(c), outcome: done("planned") },
        { outcome: done("t01") },
        { outcome: done("t02") },
        ...completionSteps(),
      ]);

      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      // ── notify: warning level, names the dimension + verdict ──
      const frontmatterNote = notes.find(([m]) => /frontmatter/i.test(m));
      assert.ok(frontmatterNote, "a notify mentioning frontmatter was emitted");
      assert.equal(frontmatterNote?.[1], "warning", "the frontmatter notify is level 'warning'");
      assert.match(frontmatterNote![0], /frontmatter_compliance (warn|fail)/, "notify message carries the verdict");

      // ── S##-PLAN-CHECK.md row ──
      const planCheck = join(milestoneDir(cwd), "slices", "S01", "S01-PLAN-CHECK.md");
      const checkBody = readFileSync(planCheck, "utf-8");
      assert.match(checkBody, /frontmatter_compliance \| (warn|fail)/, "frontmatter_compliance row is in the scorecard");

      // ── CHECKER fragment row (mechanism from loop (c), asserted here per T02) ──
      const fragment = join(cwd, ".gsd", "checker", MID, "S01.md");
      assert.ok(existsSync(fragment), ".gsd/checker/<mid>/S01.md fragment written");
      const fragmentBody = readFileSync(fragment, "utf-8");
      assert.match(fragmentBody, /dimension: frontmatter_compliance/, "frontmatter_compliance fragment row written");

      // ── advisory: warn/fail on the dimension never blocks/re-dispatches ──
      assert.deepEqual(
        driver.units.map(label),
        ["plan:S01", "task:T01", "task:T02", "complete-slice:S01", "complete-milestone:M-toy"],
        "warn/fail on frontmatter_compliance does NOT alter the loop's dispatch flow",
      );
      assert.equal(term.reason, "complete", "the milestone completed normally — the notify is lateral");
    });
  });

  test("CONTEXT has no frontmatter requirement: zero new footprint — no notify, no dimension row, 12 dimensions, loop unchanged", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      // Deliberately no `M-toy-CONTEXT.md` — no clause anywhere for
      // detectFrontmatterRequirement to match, so the 13th dimension never
      // enters `planResult.dimensions` (D-S04-1 byte-identical contract).

      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writePlanWithFail(c), outcome: done("planned") },
        { outcome: done("t01") },
        { outcome: done("t02") },
        ...completionSteps(),
      ]);

      const notes: Array<[string, string | undefined]> = [];
      const s = makeSession(cwd);
      const term = await runForgeLoop(s, { cwd, driver, notify: (m, l) => notes.push([m, l]) });

      // ── zero frontmatter footprint in notifies ──
      assert.equal(
        notes.filter(([m]) => /frontmatter/i.test(m)).length,
        0,
        "no frontmatter notify is emitted without a CONTEXT requirement",
      );

      // ── zero frontmatter footprint in the scorecard: exactly 12 dimensions ──
      const planCheck = join(milestoneDir(cwd), "slices", "S01", "S01-PLAN-CHECK.md");
      const checkBody = readFileSync(planCheck, "utf-8");
      assert.doesNotMatch(checkBody, /frontmatter_compliance/, "no frontmatter_compliance row in the scorecard");
      assert.match(checkBody, /Scores 12 locked dimensions\./, "exactly 12 dimensions scored — no conditional 13th");

      // ── zero frontmatter footprint in the CHECKER fragment ──
      const fragment = join(cwd, ".gsd", "checker", MID, "S01.md");
      if (existsSync(fragment)) {
        const fragmentBody = readFileSync(fragment, "utf-8");
        assert.doesNotMatch(fragmentBody, /frontmatter_compliance/, "no frontmatter_compliance fragment row");
      }

      // ── advisory: the loop advances identically regardless of the CONTEXT clause ──
      assert.deepEqual(
        driver.units.map(label),
        ["plan:S01", "task:T01", "task:T02", "complete-slice:S01", "complete-milestone:M-toy"],
        "the loop's dispatch flow is unchanged whether or not the requirement is present",
      );
      assert.equal(term.reason, "complete", "the milestone completed normally");
    });
  });
});
