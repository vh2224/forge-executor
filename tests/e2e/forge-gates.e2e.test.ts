/**
 * Forge advisory gates — end-to-end acceptance (S04 / T06).
 *
 * Proves, against the REAL `runForgeLoop` in-process (the same injectable
 * `SessionDriver` seam `forge-loop.e2e.test.ts` uses — S03/T06's declared
 * fallback), that the S04 advisory hook (`runAdvisoryGates`, `auto/loop.ts`,
 * T05) behaves exactly as D-S04-1 locks it down:
 *
 *   1. after a `plan-slice: done` that passes the M1R-2 guard, the artifacts
 *      the gates own (`S##-PLAN-CHECK.md`, `S##-SECURITY.md`, the per-slice
 *      CHECKER fragment) land on disk, and the `plan_check`/`plan_gate`
 *      events are journaled;
 *   2. a DELIBERATELY weak plan (fail>0 on the plan-checker scorecard) NEVER
 *      blocks or re-dispatches the loop — it advances straight to
 *      `execute-task` and completes the slice/milestone exactly like the
 *      S03 happy path (advisory-first, D-S04-1);
 *   3. `.gsd/CHECKER.md` is reconstructed by `rebuildProjections` (invoked
 *      from the existing `runMilestoneClose` at complete-milestone, D-S04-4)
 *      from the fragment the hook wrote, and a second rebuild is byte-
 *      identical (idempotent, mirrors the LEDGER/DECISIONS guarantee of S03);
 *   4. a gate that THROWS mid-hook (the CHECKER fragment write sabotaged by
 *      replacing `.gsd/checker` with a plain file) is swallowed — the loop
 *      still completes, with the swallow surfaced only as an `info`
 *      notification, never a crash/pause (best-effort, D-S04-1).
 *
 * Isolation: every test runs against `createTmpProject` — NEVER the live
 * `.gsd/` of this repo, mirroring every sibling e2e in this directory.
 *
 * ── RUNNER (mirrors forge-loop.e2e.test.ts) ─────────────────────────────────
 * Self-registers the `.js`→`.ts` source resolver hook BEFORE any static import
 * of the forge extension source (which uses ESM `.js` specifiers over `.ts`
 * files), then pulls the hook-dependent modules in via dynamic `import()`. Runs
 * correctly under both `pnpm run test:e2e` (plain glob) and
 * `pnpm run test:e2e:forge` (dedicated runner, also preloads the hook).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTmpProject } from "./_shared/tmp-project.ts";

import type { NextUnit } from "../../src/resources/extensions/forge/state/dispatch.ts";
import type { UnitOutcome } from "../../src/resources/extensions/forge/worker/rendezvous.ts";
import type { SessionDriver } from "../../src/resources/extensions/forge/auto/loop.ts";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			(specifier.startsWith("./") || specifier.startsWith("../")) &&
			specifier.endsWith(".js") &&
			context.parentURL?.startsWith("file:")
		) {
			try {
				const jsPath = fileURLToPath(new URL(specifier, context.parentURL));
				if (!existsSync(jsPath) && existsSync(jsPath.slice(0, -3) + ".ts")) {
					return nextResolve(pathToFileURL(jsPath.slice(0, -3) + ".ts").href, context);
				}
			} catch {
				/* fall through to the default resolver */
			}
		}
		return nextResolve(specifier, context);
	},
});

const {
	TOY_MILESTONE_ID,
	TOY_SLICE_ID,
	journalKinds,
	readState,
	writeMilestoneSummary,
	writeSliceSummary,
	writeToyMilestone,
	writeWeakSlicePlanArtifacts,
	assertGateArtifacts,
	planCheckPath,
	securityPath,
	checkerFragmentPathFor,
	checkerProjectionPath,
	readCheckerProjection,
} = await import("./_shared/forge-fixture.ts");
const { runForgeLoop } = await import("../../src/resources/extensions/forge/auto/loop.ts");
const { ForgeAutoSession } = await import("../../src/resources/extensions/forge/auto/session.ts");
const { rebuildProjections } = await import("../../src/resources/extensions/forge/state/merger.ts");

// ── scripted fake worker (mirrors forge-loop.e2e.test.ts) ───────────────────

interface Step {
	onDispatch?: (dir: string, unit: NextUnit, prompt: string) => void;
	outcome: UnitOutcome;
}

function scriptedDriver(dir: string, steps: Step[]): SessionDriver & { prompts: string[]; units: NextUnit[] } {
	const prompts: string[] = [];
	const units: NextUnit[] = [];
	let i = 0;
	return {
		prompts,
		units,
		async dispatch(unit, prompt) {
			const step = steps[i++];
			assert.ok(step, `scripted driver ran out of steps at dispatch #${i} (unit ${JSON.stringify(unit)})`);
			prompts.push(prompt);
			units.push(unit);
			step.onDispatch?.(dir, unit, prompt);
			return step.outcome;
		},
	};
}

function doneOutcome(summary = "ok"): UnitOutcome {
	return { kind: "result", result: { status: "done", summary, artifacts: [] } };
}

function writeTaskSummary(dir: string, task: string): void {
	const taskDir = join(dir, ".gsd", "milestones", TOY_MILESTONE_ID, "slices", TOY_SLICE_ID, "tasks", task);
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(join(taskDir, `${task}-SUMMARY.md`), `---\nid: ${task}\n---\n\n# ${task} done\n`);
}

function completionSteps(): Step[] {
	return [
		{ onDispatch: (d) => writeSliceSummary(d), outcome: doneOutcome("closed S01") },
		{ onDispatch: (d) => writeMilestoneSummary(d), outcome: doneOutcome("closed milestone") },
	];
}

function makeSession(dir: string) {
	const s = new ForgeAutoSession();
	s.active = true;
	s.cwd = dir;
	return s;
}

// ── acceptance #1 — artifacts land, fail>0 never blocks, CHECKER rebuilt ────

describe("forge-gates e2e (in-process driver) — advisory artifacts, never blocking", () => {
	test("a deliberately weak plan-slice produces fail>0 on the scorecard, yet the loop advances to execute-task and completes", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		writeToyMilestone(dir);

		// Declares T01+T02 under `## Tasks` but only materializes T01, with an
		// EMPTY `## Goal` — guarantees >=2 completeness gaps ⇒ scoreCompleteness
		// returns `fail` (countToVerdict(2) === "fail"), so counts.fail > 0.
		const driver = scriptedDriver(dir, [
			{
				onDispatch: (d) => writeWeakSlicePlanArtifacts(d, ["T01", "T02"], ["T01"]),
				outcome: doneOutcome("planned S01 (weak)"),
			},
			// Only T01 is on disk as a real task — that is the only unit the loop
			// derives next; the declared-but-absent T02 was never materialized.
			{ onDispatch: (d) => writeTaskSummary(d, "T01"), outcome: doneOutcome("did T01") },
			...completionSteps(),
		]);

		const terminal = await runForgeLoop(makeSession(dir), { cwd: dir, driver });

		// (e) — the fail>0 scorecard NEVER paused/blocked/re-dispatched the loop;
		// it drove straight through to a clean completion, same shape as the
		// S03 happy path.
		assert.equal(terminal.reason, "complete", "fail>0 on the plan-check scorecard never blocks the loop (D-S04-1)");

		assert.deepEqual(
			driver.units.map((u) => (u.type === "execute-task" ? `task:${u.task}` : u.type)),
			["plan-slice", "task:T01", "complete-slice", "complete-milestone"],
			"the loop advanced straight to execute-task and completion — no re-dispatch of plan-slice",
		);

		const state = readState(dir);
		assert.equal(state.phase, "complete", "milestone flipped to complete despite fail>0");

		// (a)+(b)+(c) — the three advisory artifacts exist on disk.
		assertGateArtifacts(dir, TOY_SLICE_ID);

		const planCheck = readFileSync(planCheckPath(dir, TOY_SLICE_ID), "utf8");
		assert.match(planCheck, /## Dimensions/, "PLAN-CHECK has the Dimensions table");
		assert.match(
			planCheck,
			/\| # \| Dimension \| Verdict \| Justification \|/,
			"PLAN-CHECK table header present",
		);
		const dimensionRows = [...planCheck.matchAll(/^\|\s*\d+\s*\|/gm)];
		assert.equal(dimensionRows.length, 10, "PLAN-CHECK scores exactly the 10 locked dimensions");
		assert.match(planCheck, /## Summary/, "PLAN-CHECK has a Summary section");
		const failMatch = planCheck.match(/\*\*fail:\*\*\s*(\d+)/);
		assert.ok(failMatch, "Summary reports a fail count");
		assert.ok(Number(failMatch![1]) > 0, `expected fail>0 on the deliberately weak plan, got ${failMatch![1]}`);

		assert.ok(existsSync(securityPath(dir, TOY_SLICE_ID)), "S01-SECURITY.md written");
		assert.ok(existsSync(checkerFragmentPathFor(dir, TOY_SLICE_ID)), ".gsd/checker/S01.md fragment written");

		// (d) — plan_check / plan_gate events journaled.
		const kinds = journalKinds(dir);
		assert.ok(kinds.includes("plan_check"), "plan_check event journaled");
		assert.ok(kinds.includes("plan_gate"), "plan_gate event journaled (outcome:skipped, D-S04-6)");

		// (f) — .gsd/CHECKER.md reconstructed by the milestone-close's
		// rebuildProjections, and idempotent on a second rebuild.
		const first = readCheckerProjection(dir);
		assert.ok(first, ".gsd/CHECKER.md rebuilt from the checker-memory fragment at complete-milestone");
		assert.match(first!, new RegExp(TOY_SLICE_ID), "CHECKER.md mentions the slice the fragment was written for");

		rebuildProjections(dir, TOY_MILESTONE_ID);
		const second = readCheckerProjection(dir);
		assert.equal(second, first, "a second rebuildProjections is byte-identical (idempotent, mirrors LEDGER/DECISIONS)");
	});
});

// ── acceptance #2 — a gate that THROWS is swallowed, loop still completes ───

describe("forge-gates e2e (in-process driver) — a throwing gate is swallowed", () => {
	test("sabotaging the CHECKER fragment path (file instead of dir) is swallowed best-effort; the loop still completes", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		writeToyMilestone(dir);

		// Sabotage BEFORE the plan-slice dispatch: `.gsd/checker` is a plain FILE,
		// not a directory, so `writeCheckerFragment`'s mkdir/write throws the
		// moment the hook tries to feed a warn/fail dimension into it. Weak plan
		// guarantees >=1 warn/fail dimension so the sabotaged write path fires.
		const gsd = join(dir, ".gsd");
		mkdirSync(gsd, { recursive: true });
		writeFileSync(join(gsd, "checker"), "not a directory\n", "utf8");

		const notes: Array<[string, string | undefined]> = [];
		const driver = scriptedDriver(dir, [
			{
				onDispatch: (d) => writeWeakSlicePlanArtifacts(d, ["T01", "T02"], ["T01"]),
				outcome: doneOutcome("planned S01 (weak, sabotaged checker path)"),
			},
			{ onDispatch: (d) => writeTaskSummary(d, "T01"), outcome: doneOutcome("did T01") },
			...completionSteps(),
		]);

		const terminal = await runForgeLoop(makeSession(dir), {
			cwd: dir,
			driver,
			notify: (m, l) => notes.push([m, l]),
		});

		// The throw never escapes runAdvisoryGates: the loop drives to completion
		// exactly like the happy/weak-plan paths above — a gate bug can never
		// crash or pause `/forge auto` (D-S04-1 best-effort invariant).
		assert.equal(terminal.reason, "complete", "a throwing gate never blocks/crashes the loop — it still completes");
		const state = readState(dir);
		assert.equal(state.phase, "complete", "milestone still flips to complete despite the sabotaged gate");

		// The swallow is surfaced ONLY as a soft info notification (never a
		// warning/error that would suggest the loop degraded), matching the
		// exact `runAdvisoryGates` catch-branch wording.
		assert.ok(
			notes.some(([m, level]) => level === "info" && /Gates advisory ignorados/.test(m)),
			`expected an info notification for the swallowed gate throw, got notes=${JSON.stringify(notes)}`,
		);

		// The sabotaged `.gsd/checker` path stayed a file (the throw aborted
		// before any recovery attempt) — the loop never tried to "fix" it either.
		assert.ok(existsSync(join(gsd, "checker")), "sabotaged .gsd/checker path untouched by the loop");

		t.after(() => {
			try {
				rmSync(join(gsd, "checker"), { force: true });
			} catch {
				/* best-effort cleanup */
			}
		});
	});
});
