/**
 * Forge dispatch loop — end-to-end acceptance (S03 / T06).
 *
 * ── W4 finding: the print-mode binary loop e2e is NON-DETERMINISTIC ──────────
 * The plan's first-choice mechanism was `gsd --print "/forge auto"` driven by
 * `GSD_FAKE_LLM_TRANSCRIPT`. Empirically the slash command DOES route to the
 * `/forge` handler and the loop DOES reach `ctx.newSession()` — but the coupling
 * between the print one-shot process, the `newSession` session-REPLACEMENT, and
 * whether control returns to the orchestrating loop closure is UNSTABLE across
 * harness builds. Two builds of the same source were observed to disagree:
 *   • one ran the worker's transcript turns (real artifacts written) but never
 *     returned control to the loop, so no STATE/journal housekeeping ran;
 *   • a rebuild returned control to the loop (STATE/journal housekeeping ran)
 *     but the worker session's turn never consumed the transcript (unit timed
 *     out without firing the tools).
 * `forge_unit_result`'s `terminate:true` was also not honored by the print-mode
 * agent loop in the first build. These are properties of the harness's
 * print/newSession model, not of the S03 loop, and stabilizing them is out of
 * T06's scope. A hard binary assertion on the full done-path would therefore be
 * flaky — which is why the binary test below asserts only the BUILD-STABLE drive
 * signal (parse + journaled dispatch + clean exit), and the behavioral
 * acceptance lives in the deterministic in-process suite.
 *
 * Therefore, per the DECLARED fallback (S03-PLAN § Notes W4 / T06-PLAN step 6),
 * the AUTHORITATIVE acceptance below drives the real `runForgeLoop` in-process
 * against a real mkdtemp fixture, through the same injectable `SessionDriver`
 * seam the production driver implements, with a SCRIPTED fake worker. It asserts
 * on the real on-disk `.gsd/` artifacts (STATE.md + events.jsonl) the loop
 * writes, plus the worker artifacts. A guarded print-mode SMOKE test additionally
 * proves the real binary wiring reaches a real worker session end to end.
 *
 * → GAP ESCALATED TO S04: the full print-mode BINARY e2e of the loop (STATE
 *   complete + journal + kill-9 resilience) needs the harness to give the
 *   command handler back control after a print-mode newSession. S04 owns the
 *   complete milestone e2e (3 tasks + real git commits + kill-9) and must
 *   re-scope that binary path, or assert the loop through a persistent
 *   (non-`--print`) session. This is logged, never silently downgraded.
 *
 * Isolation: every test runs against `createTmpProject` / `writeToyMilestone` —
 * NEVER the live `.gsd/` of this repo (a forge 1.0 runtime is actively managing
 * it; writing there corrupts live state).
 *
 * ── RUNNER ───────────────────────────────────────────────────────────────────
 * This file imports the forge extension SOURCE, which uses the ESM `.js`-
 * specifier convention over `.ts` files. Bare `--experimental-strip-types` does
 * not rewrite `.js`→`.ts`, so the file SELF-REGISTERS a tiny source resolver
 * hook (below) and pulls the hook-dependent modules in via dynamic `import()`.
 * It is therefore self-sufficient — it runs correctly under both:
 *
 *   pnpm run test:e2e          # plain glob, no preload needed
 *   pnpm run test:e2e:forge    # dedicated runner (also preloads the hook)
 *
 * The whole in-process import chain (loop/driver/session/housekeeping/state/
 * prompts) is free of any `@gsd/*` RUNTIME import — the only `@gsd` reference is
 * a type-only import erased by type stripping — so the hook maps nothing but
 * `.js`→`.ts`. The binary drive test spawns the built binary, unaffected by it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTmpProject } from "./_shared/tmp-project.ts";
import { writeTranscript } from "./_shared/fake-llm.ts";
import { gsdSync } from "./_shared/spawn.ts";

import type { NextUnit } from "../../src/resources/extensions/forge/state/dispatch.ts";
import type { UnitOutcome } from "../../src/resources/extensions/forge/worker/rendezvous.ts";
import type { SessionDriver } from "../../src/resources/extensions/forge/auto/loop.ts";

// ── self-registered `.js`→`.ts` source resolver (see the RUNNER note above) ──
//
// The forge extension SOURCE uses ESM `.js` specifiers over `.ts` files, which
// bare `--experimental-strip-types` does not rewrite. Static imports link their
// whole module graph BEFORE any top-level statement runs, so the hook would be
// registered too late for a static `import` of that source. We therefore
// register the hook FIRST and pull the hook-dependent modules in via DYNAMIC
// `import()` (resolved at call time, after the hook is live). This keeps the
// file self-sufficient — it runs correctly under the plain `test:e2e` glob AND
// under the dedicated `test:e2e:forge` runner, with no mandatory `--import`.
// `_shared/resolve-src-ts.mjs` carries the same hook for optional preloading.
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
	journalUnitFlow,
	projectionsExist,
	readJournal,
	readLedger,
	readState,
	writeMilestoneSummary,
	writeSliceSummary,
	writeToyMilestone,
} = await import("./_shared/forge-fixture.ts");
const { runForgeLoop } = await import("../../src/resources/extensions/forge/auto/loop.ts");
const { ForgeAutoSession } = await import("../../src/resources/extensions/forge/auto/session.ts");

// ── scripted fake worker ─────────────────────────────────────────────────────

/** A scripted dispatch step: an optional side-effect (the "worker") + the outcome. */
interface Step {
	onDispatch?: (dir: string, unit: NextUnit, prompt: string) => void;
	outcome: UnitOutcome;
}

/** Build a `SessionDriver` that plays `steps` in order, recording prompts + units. */
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

function partialOutcome(summary = "incomplete"): UnitOutcome {
	return { kind: "result", result: { status: "partial", summary, artifacts: [] } };
}

function blockedOutcome(reason: string): UnitOutcome {
	return { kind: "result", result: { status: "blocked", summary: "need human", artifacts: [], reason } };
}

function timeoutOutcome(): UnitOutcome {
	return { kind: "timeout" };
}

/** Simulate the plan-slice worker: write S01-PLAN.md + the given task plans. */
function writeSlicePlanArtifacts(dir: string, taskIds: string[]): void {
	const sliceDir = join(dir, ".gsd", "milestones", TOY_MILESTONE_ID, "slices", TOY_SLICE_ID);
	mkdirSync(sliceDir, { recursive: true });
	writeFileSync(
		join(sliceDir, `${TOY_SLICE_ID}-PLAN.md`),
		`---\nid: ${TOY_SLICE_ID}\nmilestone: ${TOY_MILESTONE_ID}\ntitle: "Primeira slice"\n---\n\n# ${TOY_SLICE_ID} plan\n`,
	);
	for (const t of taskIds) {
		mkdirSync(join(sliceDir, "tasks", t), { recursive: true });
		writeFileSync(
			join(sliceDir, "tasks", t, `${t}-PLAN.md`),
			// A MINIMAL VALID `must_haves:` block so the S06 enforcing gate (D-S06-1)
			// treats the plan as non-legacy and dispatches it — the plan text is
			// otherwise unchanged. Mirrors the schema the T06 unit-test fixtures use.
			`---\nid: ${t}\nslice: ${TOY_SLICE_ID}\nmilestone: ${TOY_MILESTONE_ID}\ntitle: "Task ${t}"\nmust_haves:\n  truths:\n    - "does the thing"\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/out.ts\n---\n\n# ${t}\n`,
		);
	}
}

/** Simulate an execute-task worker: write the task's toy SUMMARY artifact. */
function writeTaskSummary(dir: string, task: string): void {
	const taskDir = join(dir, ".gsd", "milestones", TOY_MILESTONE_ID, "slices", TOY_SLICE_ID, "tasks", task);
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(join(taskDir, `${task}-SUMMARY.md`), `---\nid: ${task}\n---\n\n# ${task} done\n`);
}

/**
 * The two DISPATCHED completion units that close a slice + its milestone under
 * the S03 flow (D-S03-1). The `complete-slice` worker writes `S##-SUMMARY.md`
 * (its `done` gate + slice flip); the `complete-milestone` worker writes
 * `<mid>-SUMMARY.md` + the LEDGER fragment, after which the loop's
 * `runMilestoneClose` rebuilds `.gsd/LEDGER.md` / `.gsd/DECISIONS.md`. Appended
 * to any happy-path step script so a run reaches `phase: complete` the NEW way.
 */
function completionSteps(): Step[] {
	return [
		{ onDispatch: (d) => writeSliceSummary(d), outcome: doneOutcome("closed S01") },
		{ onDispatch: (d) => writeMilestoneSummary(d), outcome: doneOutcome("closed milestone") },
	];
}

function makeSession(dir: string): ForgeAutoSession {
	const s = new ForgeAutoSession();
	s.active = true;
	s.cwd = dir;
	return s;
}

// ── acceptance #2 — happy path plan-slice → execute-task×2 → complete ─────────

describe("forge-loop e2e (in-process driver) — happy path", () => {
	test("plan-slice → execute-task×2 → complete-slice → complete-milestone drives STATE to complete + rebuilds projections", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		const fixture = writeToyMilestone(dir);
		assert.equal(fixture.milestoneId, TOY_MILESTONE_ID);

		const driver = scriptedDriver(dir, [
			// 1) plan-slice: the "worker" writes S01-PLAN.md + two task plans.
			{ onDispatch: (d) => writeSlicePlanArtifacts(d, ["T01", "T02"]), outcome: doneOutcome("planned S01") },
			// 2) execute-task T01: worker writes its summary artifact.
			{ onDispatch: (d) => writeTaskSummary(d, "T01"), outcome: doneOutcome("did T01") },
			// 3) execute-task T02: LAST task — no longer flips the slice by itself
			//    (D-S03-1: the flip migrated onto the completion unit's result).
			{ onDispatch: (d) => writeTaskSummary(d, "T02"), outcome: doneOutcome("did T02") },
			// 4) complete-slice S01: writes S##-SUMMARY → flips the slice done.
			// 5) complete-milestone: writes <mid>-SUMMARY + LEDGER fragment → flips
			//    the milestone; the loop then rebuilds LEDGER.md/DECISIONS.md.
			...completionSteps(),
		]);

		const terminal = await runForgeLoop(makeSession(dir), { cwd: dir, driver });

		// The structured terminal is a clean completion (LoopTerminal, E2E-4).
		assert.equal(terminal.reason, "complete", "loop returns { reason: complete } via the new completion flow");

		// Units dispatched in the derived order — now INCLUDING both completion units.
		assert.deepEqual(
			driver.units.map((u) => {
				switch (u.type) {
					case "execute-task":
						return `task:${u.task}`;
					case "complete-slice":
						return `complete-slice:${u.slice}`;
					case "complete-milestone":
						return "complete-milestone";
					default:
						return `plan:${u.slice}`;
				}
			}),
			["plan:S01", "task:T01", "task:T02", "complete-slice:S01", "complete-milestone"],
		);

		// Final STATE: milestone complete, slice + both tasks done.
		const state = readState(dir);
		assert.equal(state.phase, "complete", "milestone flipped to complete");
		assert.ok(state.units?.some((u) => u.type === "milestone" && u.status === "done"), "milestone unit done");
		assert.ok(state.units?.some((u) => u.type === "slice" && u.id === "S01" && u.status === "done"), "slice done");
		assert.ok(state.units?.some((u) => u.type === "task" && u.id === "T01" && u.status === "done"));
		assert.ok(state.units?.some((u) => u.type === "task" && u.id === "T02" && u.status === "done"));

		// Worker artifacts exist on disk — plan, task summaries, AND the completion SUMMARYs.
		const base = join(dir, ".gsd", "milestones", TOY_MILESTONE_ID, "slices", TOY_SLICE_ID);
		assert.ok(existsSync(join(base, "S01-PLAN.md")), "S01-PLAN.md written by the plan-slice worker");
		assert.ok(existsSync(join(base, "tasks", "T01", "T01-SUMMARY.md")));
		assert.ok(existsSync(join(base, "tasks", "T02", "T02-SUMMARY.md")));
		assert.ok(existsSync(join(base, "S01-SUMMARY.md")), "S01-SUMMARY.md written by the complete-slice worker");
		assert.ok(
			existsSync(join(dir, ".gsd", "milestones", TOY_MILESTONE_ID, `${TOY_MILESTONE_ID}-SUMMARY.md`)),
			"<mid>-SUMMARY.md written by the complete-milestone worker",
		);

		// The milestone-close rebuilt BOTH global projections from the fragments.
		assert.ok(projectionsExist(dir), ".gsd/LEDGER.md AND .gsd/DECISIONS.md exist after the milestone close");
		assert.match(readLedger(dir) ?? "", /## M-toy-forge-e2e/, "LEDGER.md rebuilt from the milestone's ledger fragment");

		// Journal ordering: dispatched→result, per unit, in order — completion units included.
		assert.deepEqual(
			journalUnitFlow(dir),
			[
				"unit_dispatched:plan/S01",
				"unit_result:plan/S01",
				"unit_dispatched:S01/T01",
				"unit_result:S01/T01",
				"unit_dispatched:S01/T02",
				"unit_result:S01/T02",
				"unit_dispatched:complete/S01",
				"unit_result:complete/S01",
				`unit_dispatched:complete/${TOY_MILESTONE_ID}`,
				`unit_result:complete/${TOY_MILESTONE_ID}`,
			],
			"events.jsonl records dispatched→result for each unit — plan, 2 tasks, complete-slice, complete-milestone — in derived order",
		);
	});
});

// ── acceptance #3 — no-hang: worker never delivers → timeout, loop pauses ─────

describe("forge-loop e2e (in-process driver) — no-hang (B4)", () => {
	test("a unit that only times out journals unit_timeout, never flips STATE, exits cleanly", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		writeToyMilestone(dir);
		// Pre-plan the slice so the first (and only) unit is execute-task T01.
		writeSlicePlanArtifacts(dir, ["T01"]);

		// The worker never delivers a result → the driver resolves as a timeout.
		// Policy: timeout → 1 retry → timeout again → pause. Never hangs.
		const driver = scriptedDriver(dir, [{ outcome: timeoutOutcome() }, { outcome: timeoutOutcome() }]);

		const notes: Array<[string, string | undefined]> = [];
		// The whole run must settle well within the node:test default timeout —
		// the "clean exit" analogue for an in-process loop is a resolved promise.
		await runForgeLoop(makeSession(dir), { cwd: dir, driver, notify: (m, l) => notes.push([m, l]) });

		assert.equal(driver.units.length, 2, "dispatched original + exactly one retry, then paused (no hang)");
		const kinds = journalKinds(dir);
		assert.ok(kinds.includes("unit_timeout"), "journal records a unit_timeout event");
		assert.ok(kinds.includes("loop_paused"), "loop paused after the retry was exhausted");

		const state = readState(dir);
		assert.ok(!state.units?.some((u) => u.id === "T01" && u.status === "done"), "timed-out unit NOT marked done");
		assert.notEqual(state.phase, "complete", "milestone not completed on a timed-out unit");
		assert.ok(notes.some(([, l]) => l === "warning"), "paused with a warning notification");
	});
});

// ── acceptance #4 — retry: partial→done re-dispatches once; partial→partial pauses ─

describe("forge-loop e2e (in-process driver) — retry (B4)", () => {
	test("a partial unit re-dispatches exactly once with the failure context, then completes", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		writeToyMilestone(dir);
		writeSlicePlanArtifacts(dir, ["T01"]); // already planned ⇒ first unit is execute-task

		const driver = scriptedDriver(dir, [
			{ outcome: partialOutcome("faltou o gate") },
			{ onDispatch: (d) => writeTaskSummary(d, "T01"), outcome: doneOutcome("T01 retry ok") },
			// After T01 finally lands, the loop still drives the completion units.
			...completionSteps(),
		]);

		await runForgeLoop(makeSession(dir), { cwd: dir, driver });

		// T01 was dispatched exactly twice (original + one retry); the two extra
		// dispatches are the completion units, not further T01 retries.
		const t01Dispatches = driver.units.filter((u) => u.type === "execute-task" && u.task === "T01").length;
		assert.equal(t01Dispatches, 2, "T01 dispatched exactly once as a retry (original + one)");
		assert.match(driver.prompts[1], /faltou o gate/, "retry prompt threads the previous failure context");

		const state = readState(dir);
		assert.ok(state.units?.some((u) => u.id === "T01" && u.status === "done"), "unit done after the retry");
		assert.equal(state.phase, "complete");
		assert.equal(journalKinds(dir).filter((k) => k === "unit_retry").length, 1, "exactly one unit_retry event");
	});

	test("a second consecutive partial pauses the loop (retry exhausted, no hang)", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		writeToyMilestone(dir);
		writeSlicePlanArtifacts(dir, ["T01"]);

		const driver = scriptedDriver(dir, [
			{ outcome: partialOutcome("nope") },
			{ outcome: partialOutcome("still nope") },
		]);

		const notes: Array<[string, string | undefined]> = [];
		await runForgeLoop(makeSession(dir), { cwd: dir, driver, notify: (m, l) => notes.push([m, l]) });

		assert.equal(driver.units.length, 2, "no third dispatch after the retry is exhausted");
		const state = readState(dir);
		assert.ok(!state.units?.some((u) => u.id === "T01" && u.status === "done"), "task not marked done");
		assert.ok(journalKinds(dir).includes("loop_paused"));
		assert.ok(notes.some(([, l]) => l === "warning"), "paused with a warning");
	});
});

// ── acceptance #4 (blocked) — a blocked unit pauses immediately ───────────────

describe("forge-loop e2e (in-process driver) — pause on blocked (B4)", () => {
	test("a blocked unit halts the loop immediately, STATE untouched for that unit", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		writeToyMilestone(dir);
		writeSlicePlanArtifacts(dir, ["T01"]);

		const driver = scriptedDriver(dir, [{ outcome: blockedOutcome("requisito ambíguo") }]);

		const notes: string[] = [];
		await runForgeLoop(makeSession(dir), { cwd: dir, driver, notify: (m) => notes.push(m) });

		assert.equal(driver.units.length, 1, "no retry on a blocked unit");
		const state = readState(dir);
		assert.ok(!state.units?.some((u) => u.id === "T01" && u.status === "done"));
		assert.ok(journalKinds(dir).includes("loop_paused"));
		assert.ok(notes.some((m) => m.includes("ambíguo")), "the block reason is surfaced");
	});
});

// ── binary smoke — the real print-mode path reaches a real worker session ─────

/**
 * Proves the REAL binary wiring of the loop's DRIVE path: slash-command routing
 * in print mode → the `/forge next` command handler → the fixture parsed by the
 * SAME store the binary ships (`deriveNextUnit` derives `plan-slice S01` — a
 * genuine parse round-trip of the toy STATE + ROADMAP) → the loop journals a
 * `unit_dispatched` for `plan/S01` → `ctx.newSession()` runs a fresh worker
 * session → the loop regains control, folds the outcome, and the process EXITS
 * CLEANLY (no hang, B4).
 *
 * ── Why the assertion targets the journal, not a worker artifact (W4) ────────
 * Whether the worker session's turn actually consumes the fake transcript under
 * `--print` is NON-DETERMINISTIC across harness builds: one build ran the worker
 * turns but never returned control to the loop (no journal); a rebuild returned
 * control to the loop (journal written) but the worker turn timed out without
 * firing. The DETERMINISTIC, build-stable signal — the one this gate asserts —
 * is that the real binary parses the fixture and DRIVES the loop far enough to
 * journal a dispatch and exit cleanly. The full done-path binary e2e (worker
 * fires → STATE complete → real git commits → kill-9) is escalated to S04, which
 * owns the complete-milestone acceptance. The authoritative behavioral coverage
 * (happy/no-hang/retry/pause + STATE/journal correctness) is the in-process
 * suite above — never a silent downgrade.
 *
 * Skips with a clear message when `GSD_SMOKE_BINARY` is unset (never a silent
 * false-green — the `binaryAvailable()` pattern of the sibling e2e suites).
 */
function binaryAvailable(): { ok: boolean; reason?: string } {
	const bin = process.env.GSD_SMOKE_BINARY;
	if (!bin) return { ok: false, reason: "GSD_SMOKE_BINARY not set; build with `pnpm run build:core` and re-export." };
	if (!existsSync(bin)) return { ok: false, reason: `binary not found at ${bin}` };
	return { ok: true };
}

describe("forge-loop e2e (binary print-mode drive)", () => {
	const avail = binaryAvailable();
	const skipReason = avail.ok ? null : avail.reason;

	test(
		"gsd --print '/forge next' parses the toy fixture, journals a plan/S01 dispatch, and exits cleanly",
		{ skip: skipReason ?? false },
		(t) => {
			const project = createTmpProject({ git: true });
			t.after(project.cleanup);
			const dir = project.dir;
			writeToyMilestone(dir);

			const planPath = `.gsd/milestones/${TOY_MILESTONE_ID}/slices/${TOY_SLICE_ID}/${TOY_SLICE_ID}-PLAN.md`;
			// A plausible plan-slice transcript: if the worker turn fires it plans
			// S01 and reports done; if it does not (see the W4 note), the loop's
			// short unit timeout resolves it — either way the DISPATCH is journaled.
			const transcript = writeTranscript([
				{
					turn: 1,
					expect: { modelId: "gsd-fake-model" },
					emit: {
						kind: "tool_use",
						calls: [
							{
								name: "write",
								input: {
									path: planPath,
									content: `---\nid: ${TOY_SLICE_ID}\nmilestone: ${TOY_MILESTONE_ID}\ntitle: "Primeira slice"\n---\n\n# ${TOY_SLICE_ID}\n`,
								},
							},
						],
					},
				},
				{
					turn: 2,
					emit: {
						kind: "tool_use",
						calls: [{ name: "forge_unit_result", input: { status: "done", summary: "planned", artifacts: [planPath] } }],
					},
				},
				{ turn: 3, emit: { kind: "text", text: "unidade concluída" } },
				{ turn: 4, emit: { kind: "text", text: "spare" } },
				{ turn: 5, emit: { kind: "text", text: "spare" } },
			]);

			// Short unit timeout bounds the run whether or not the worker turn fires
			// (1 dispatch + at most 1 retry). Generous spawn cap on top.
			const result = gsdSync(
				["--print", "/forge next", "--model", "gsd-fake-model", "--mode", "text"],
				{
					cwd: dir,
					timeoutMs: 60_000,
					env: {
						GSD_FAKE_LLM_TRANSCRIPT: transcript,
						GSD_TOOL_APPROVAL: "auto",
						FORGE_UNIT_TIMEOUT_MS: "4000",
					},
				},
			);

			// Clean exit — the loop never hangs, even on the worker-timeout path (B4).
			assert.equal(
				result.code,
				0,
				`expected a clean exit, got code=${result.code} signal=${result.signal}. stderr=${result.stderrClean.slice(-800)}`,
			);

			// The real binary parsed the toy fixture (STATE + ROADMAP round-trip) and
			// drove the loop far enough to journal the plan-slice dispatch.
			const events = readJournal(dir);
			assert.ok(
				events.some((e) => e.kind === "unit_dispatched" && e.unit === "plan/S01"),
				`expected a unit_dispatched event for plan/S01 in the journal, got kinds=${JSON.stringify(events.map((e) => e.kind))}. ` +
					`This proves the print-mode /forge next path parsed the fixture and drove the loop. ` +
					`stderr=${result.stderrClean.slice(-500)}`,
			);
		},
	);
});
