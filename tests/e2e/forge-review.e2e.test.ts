/**
 * Forge review — advisory native footprint end-to-end acceptance (S05 / T06).
 *
 * Proves, against the REAL `runForgeLoop` in-process (same injectable
 * `SessionDriver` seam `forge-loop.e2e.test.ts` / `forge-gates.e2e.test.ts`
 * use), that `runReviewGate`/`runReviewTriage` (`auto/loop.ts`, T05) behave
 * exactly as D-S05-3 locks it down — the review MACHINE is strictly advisory,
 * NEVER blocking the deterministic auto loop:
 *
 *   (a) SKIPPED — no `S##-REVIEW.md` on disk before `complete-slice`: the
 *       loop journals `review:skipped` (auto posture `ask_in_auto: defer`)
 *       and still drives straight through to `{reason: complete}`; the final
 *       `review_triage` is `none` (nothing pending).
 *   (b) PRESENT + TRIAGE deferred — an artifact seeded with 1 open-deferred
 *       + 1 conceded-without-fix item: the loop journals `review:present`
 *       (idempotent, no rewrite) then, before `complete-milestone`,
 *       `review_triage:deferred` with `pending == 2` — and the milestone
 *       still COMPLETES despite the pending items (advisory-first, W3).
 *   (c) SABOTAGE — the review artifact PATH is a directory instead of a
 *       file (mirrors `forge-gates.e2e.test.ts`'s CHECKER-fragment sabotage):
 *       the hook swallows the read failure best-effort and the loop still
 *       completes — no unhandled rejection, no pause.
 *
 * Isolation: every test runs against `createTmpProject` — NEVER the live
 * `.gsd/` of this repo, mirroring every sibling e2e in this directory.
 *
 * ── RUNNER (mirrors forge-gates.e2e.test.ts) ────────────────────────────────
 * Self-registers the `.js`→`.ts` source resolver hook BEFORE any static import
 * of the forge extension source, then pulls the hook-dependent modules in via
 * dynamic `import()`. Runs correctly under both `pnpm run test:e2e` (plain
 * glob) and `pnpm run test:e2e:forge` (dedicated runner, also preloads the
 * hook).
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
	readJournal,
	readState,
	writeMilestoneSummary,
	writeSliceSummary,
	writeToyMilestone,
	writeWeakSlicePlanArtifacts,
	writeReviewArtifact,
	reviewArtifactPathFor,
} = await import("./_shared/forge-fixture.ts");
const { runForgeLoop } = await import("../../src/resources/extensions/forge/auto/loop.ts");
const { ForgeAutoSession } = await import("../../src/resources/extensions/forge/auto/session.ts");
const { collectPendingReviewItems } = await import("../../src/resources/extensions/forge/review/artifact.ts");

// ── scripted fake worker (mirrors forge-gates.e2e.test.ts) ──────────────────

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

/** plan-slice → execute-task(T01) → complete-slice → complete-milestone, the shared 4-unit script. */
function fullLoopSteps(): Step[] {
	return [
		{
			onDispatch: (d) => writeWeakSlicePlanArtifacts(d, ["T01"], ["T01"]),
			outcome: doneOutcome("planned S01"),
		},
		{ onDispatch: (d) => writeTaskSummary(d, "T01"), outcome: doneOutcome("did T01") },
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

// ── scenario (a) — no artifact: review:skipped, triage:none, loop completes ─

describe("forge-review e2e (in-process driver) — skipped (no artifact) never blocks", () => {
	test("no S##-REVIEW.md on disk ⇒ review:skipped, review_triage:none, loop still completes", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		writeToyMilestone(dir);
		assert.ok(!existsSync(reviewArtifactPathFor(dir)), "sanity: no review artifact pre-seeded");

		const driver = scriptedDriver(dir, fullLoopSteps());
		const terminal = await runForgeLoop(makeSession(dir), { cwd: dir, driver });

		assert.equal(terminal.reason, "complete", "no review artifact never blocks the loop (D-S05-3/W3)");
		assert.deepEqual(
			driver.units.map((u) => (u.type === "execute-task" ? `task:${u.task}` : u.type)),
			["plan-slice", "task:T01", "complete-slice", "complete-milestone"],
			"the loop drove straight through — no re-dispatch caused by the review hooks",
		);

		const state = readState(dir);
		assert.equal(state.phase, "complete", "milestone flipped to complete with the review artifact absent");

		const kinds = journalKinds(dir);
		assert.ok(kinds.includes("review"), "review event journaled before complete-slice");
		assert.ok(kinds.includes("review_triage"), "review_triage event journaled before complete-milestone");

		const events = readJournal(dir);
		const reviewEvent = events.find((e) => e.kind === "review");
		assert.equal(reviewEvent?.status, "skipped", "absent artifact ⇒ outcome skipped (auto posture ask_in_auto: defer)");
		assert.equal(reviewEvent?.slice, TOY_SLICE_ID, "the skipped event names the slice it deferred");

		const triageEvent = events.find((e) => e.kind === "review_triage");
		assert.equal(triageEvent?.status, "none", "nothing pending to triage when no artifact was ever written");

		// Ordering: review precedes complete-slice's unit_dispatched; review_triage
		// precedes complete-milestone's unit_dispatched — proving the hooks fire
		// BEFORE the unit they guard, never after (lateral to the dispatch, W3).
		const reviewIdx = events.findIndex((e) => e.kind === "review");
		const csDispatchIdx = events.findIndex(
			(e) => e.kind === "unit_dispatched" && String(e.unit) === `complete/${TOY_SLICE_ID}`,
		);
		assert.ok(reviewIdx >= 0 && csDispatchIdx >= 0 && reviewIdx < csDispatchIdx, "review fires before complete-slice dispatch");

		const triageIdx = events.findIndex((e) => e.kind === "review_triage");
		const cmDispatchIdx = events.findIndex(
			(e) => e.kind === "unit_dispatched" && String(e.unit) === `complete/${TOY_MILESTONE_ID}`,
		);
		assert.ok(
			triageIdx >= 0 && cmDispatchIdx >= 0 && triageIdx < cmDispatchIdx,
			"review_triage fires before complete-milestone dispatch",
		);
	});
});

// ── scenario (b) — present + pending triage, milestone completes anyway ─────

describe("forge-review e2e (in-process driver) — present + deferred triage never blocks", () => {
	test("a seeded artifact with 1 open-deferred + 1 conceded-no-fix ⇒ present + triage deferred(2), milestone completes", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		writeToyMilestone(dir);
		const seeded = writeReviewArtifact(dir, TOY_MILESTONE_ID, TOY_SLICE_ID, {
			openDeferred: 1,
			concededNoFix: 1,
		});
		assert.equal(seeded.openIds.length, 1);
		assert.equal(seeded.concededIds.length, 1);
		assert.ok(existsSync(seeded.path), "seeded S##-REVIEW.md exists before the loop runs");

		// Round-trip proof: the fixture's write-backs are recognized by the SAME
		// grammar `collectPendingReviewItems` reads (D-S05-4 round-trip).
		const preRun = collectPendingReviewItems(dir, TOY_MILESTONE_ID);
		assert.equal(preRun.length, 2, "fixture↔grammar round-trip: 2 pending items collected before the loop even runs");
		assert.ok(preRun.some((it) => it.status === "open"), "the open-deferred item round-trips as status open");
		assert.ok(preRun.some((it) => it.status === "conceded-sem-fix"), "the conceded-no-fix item round-trips as conceded-sem-fix");

		const rawBefore = readFileSync(seeded.path, "utf8");

		const driver = scriptedDriver(dir, fullLoopSteps());
		const terminal = await runForgeLoop(makeSession(dir), { cwd: dir, driver });

		assert.equal(terminal.reason, "complete", "pending review items never block the loop (D-S05-3/W3)");
		const state = readState(dir);
		assert.equal(state.phase, "complete", "milestone completes despite 2 pending review items");

		const events = readJournal(dir);
		const reviewEvent = events.find((e) => e.kind === "review");
		assert.equal(reviewEvent?.status, "present", "existing artifact ⇒ outcome present (idempotent, no rewrite)");
		assert.match(String(reviewEvent?.summary ?? ""), /idempotente, sem reescrita/, "the present event names the idempotence guarantee");

		const triageEvent = events.find((e) => e.kind === "review_triage");
		assert.equal(triageEvent?.status, "deferred", "2 pending items ⇒ triage outcome deferred");
		assert.match(String(triageEvent?.summary ?? ""), /2 item/, "the triage summary carries the pending count");

		// Idempotence proof: runReviewGate's present branch NEVER rewrites the
		// artifact (Step 0a) — byte-identical before/after the whole loop ran.
		const rawAfter = readFileSync(seeded.path, "utf8");
		assert.equal(rawAfter, rawBefore, "the review artifact is byte-identical after the loop — present branch never rewrites (D-S04-R1 parity)");
	});
});

// ── scenario (c) — sabotage: artifact path is a directory, swallowed ────────

describe("forge-review e2e (in-process driver) — a sabotaged review path is swallowed", () => {
	test("S##-REVIEW.md as a DIRECTORY (unreadable) is swallowed best-effort; the loop still completes", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		writeToyMilestone(dir);

		// Sabotage BEFORE any dispatch: the review artifact PATH is a directory,
		// not a file — `runReviewGate`'s `readFileSync` on it throws EISDIR, an
		// error the hook is built to swallow (best-effort, mirrors the CHECKER
		// fragment sabotage in forge-gates.e2e.test.ts).
		const path = reviewArtifactPathFor(dir);
		mkdirSync(path, { recursive: true });
		t.after(() => {
			try {
				rmSync(path, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		});

		const notes: Array<[string, string | undefined]> = [];
		const driver = scriptedDriver(dir, fullLoopSteps());

		const terminal = await runForgeLoop(makeSession(dir), {
			cwd: dir,
			driver,
			notify: (m, l) => notes.push([m, l]),
		});

		// No unhandled rejection escaped the sabotage: the loop drove straight
		// through to completion exactly like the happy/present paths above.
		assert.equal(terminal.reason, "complete", "a sabotaged (unreadable) review path never blocks/crashes the loop");
		const state = readState(dir);
		assert.equal(state.phase, "complete", "milestone still flips to complete despite the sabotaged review path");

		assert.deepEqual(
			driver.units.map((u) => (u.type === "execute-task" ? `task:${u.task}` : u.type)),
			["plan-slice", "task:T01", "complete-slice", "complete-milestone"],
			"the loop advanced through every unit unchanged — the sabotage never re-dispatched anything",
		);

		// The hook still journals SOME outcome for the slice (existsSync sees the
		// directory) — it just never crashes trying to read it.
		const events = readJournal(dir);
		const reviewEvent = events.find((e) => e.kind === "review");
		assert.ok(reviewEvent, "the review hook still journals an event even when the artifact path is unreadable");

		// The sabotaged path stayed a directory — the loop never tried to "fix" it.
		assert.ok(existsSync(path) && !existsSync(join(path, "..", `${TOY_SLICE_ID}-REVIEW.md.tmp`)), "sabotaged path left untouched");
	});
});
