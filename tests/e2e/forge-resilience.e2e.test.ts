/**
 * Forge — KILL-9 RESILIENCE acceptance on the REAL BINARY (S04 / T04).
 *
 * ── What this proves (milestone acceptance #2) ───────────────────────────────
 * A `/forge auto` run on the real binary is `SIGKILL`ed (kill -9) in the MIDDLE
 * of a unit — no graceful shutdown, no `finally`, the process just dies. A fresh
 * binary is then relaunched against the SAME fixture with NO human intervention
 * and NO edits to `.gsd/`. The loop resumes from the persisted STATE: it never
 * re-runs the units already marked done, re-dispatches the interrupted unit, and
 * drives the milestone to completion.
 *
 * The safety net is S03's atomic STATE flip (B5.1 — one `updateState` per unit)
 * + `deriveNextUnit`/`reconcileCompletion`: because a unit's result is applied
 * in a single atomic write, a kill can only ever leave STATE either fully-before
 * or fully-after a unit — never half-applied — so `deriveNextUnit` on the fresh
 * process always derives the correct next unit from disk.
 *
 * ── Determinism of the kill point ────────────────────────────────────────────
 * The first run's `execute-task T01` turn runs a long `sleep` before it would
 * commit, so the process is reliably parked INSIDE T01 (plan-slice already done
 * and persisted, T01 dispatched but NOT done) when we poll the journal, see the
 * `unit_dispatched:S01/T01` event, and `SIGKILL`. The relaunch uses a fresh
 * transcript (the fake provider's cursor is per-process) that drives the
 * remaining tasks; `deriveNextUnit` — reading the persisted STATE — starts it at
 * T01, exactly the unit that was interrupted.
 *
 * Runs in CI with the fake provider (this is the S04 gate). Isolation: a
 * `mkdtemp` git repo, NEVER the live `.gsd/`. See forge-milestone.e2e.test.ts
 * for the RUNNER note (`.js`→`.ts` hook) and the W4/T01 determinism history.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTmpProject } from "./_shared/tmp-project.ts";
import { writeTranscript, type TranscriptTurn } from "./_shared/fake-llm.ts";
import { gsdAsync } from "./_shared/spawn.ts";

// ── self-registered `.js`→`.ts` source resolver (see forge-milestone RUNNER note) ──
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
	TOY_TASK_IDS,
	journalUnitFlow,
	projectionsExist,
	readGitLog,
	readState,
	writeToyMilestone,
} = await import("./_shared/forge-fixture.ts");

function binaryAvailable(): { ok: boolean; reason?: string } {
	const bin = process.env.GSD_SMOKE_BINARY;
	if (!bin) return { ok: false, reason: "GSD_SMOKE_BINARY not set; build with `pnpm run build:pi` and re-export." };
	if (!existsSync(bin)) return { ok: false, reason: `binary not found at ${bin}` };
	return { ok: true };
}

const REL_BASE = `.gsd/milestones/${TOY_MILESTONE_ID}/slices/${TOY_SLICE_ID}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function taskPlan(taskId: string): string {
	// A MINIMAL VALID `must_haves:` block so the S06 enforcing gate (D-S06-1)
	// treats the plan as non-legacy and dispatches it — the plan text is
	// otherwise unchanged. Mirrors the schema forge-loop.e2e.test.ts uses.
	return `---\nid: ${taskId}\nslice: ${TOY_SLICE_ID}\nmilestone: ${TOY_MILESTONE_ID}\ntitle: "Task ${taskId}"\nmust_haves:\n  truths:\n    - "does the thing"\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/out.ts\n---\n\n# ${taskId}\n`;
}

/** Turn: real commit for a task (writes its summary, then `git commit`). */
function commitTurn(turn: number, taskId: string): TranscriptTurn {
	const summaryPath = `${REL_BASE}/tasks/${taskId}/${taskId}-SUMMARY.md`;
	return {
		turn,
		emit: {
			kind: "tool_use",
			calls: [
				{
					name: "bash",
					input: {
						command:
							`mkdir -p ${REL_BASE}/tasks/${taskId} && ` +
							`printf '%s' '# ${taskId} done' > ${summaryPath} && ` +
							`git add -A && git commit -q -m "feat(${TOY_SLICE_ID}/${taskId}): done" && echo COMMITTED_${taskId}`,
					},
				},
			],
		},
	};
}

function resultTurn(turn: number, summary: string): TranscriptTurn {
	return { turn, emit: { kind: "tool_use", calls: [{ name: "forge_unit_result", input: { status: "done", summary, artifacts: [] } }] } };
}

/**
 * The completion units that close the slice + milestone under the S03 flow
 * (D-S03-1). Appended after the last execute-task so a `/forge auto` run reaches
 * `phase: complete` the NEW way: `complete-slice` writes `S##-SUMMARY.md` (its
 * `done` gate + slice flip), then `complete-milestone` writes `<mid>-SUMMARY.md`
 * + a LEDGER fragment, after which the loop's `runMilestoneClose` rebuilds the
 * global projections. Each unit's FIRST turn is a real `bash` (the MCP result
 * tool is only reachable after the first round-trip). Returns 4 turns starting
 * at `start`.
 */
function completionTurns(start: number): TranscriptTurn[] {
	const MID_DIR = `.gsd/milestones/${TOY_MILESTONE_ID}`;
	return [
		{
			turn: start,
			emit: {
				kind: "tool_use",
				calls: [
					{
						name: "bash",
						input: {
							command:
								`printf '%s' '# ${TOY_SLICE_ID} summary' > ${REL_BASE}/${TOY_SLICE_ID}-SUMMARY.md && echo SLICE_CLOSED`,
						},
					},
				],
			},
		},
		resultTurn(start + 1, "closed S01"),
		{
			turn: start + 2,
			emit: {
				kind: "tool_use",
				calls: [
					{
						name: "bash",
						input: {
							command:
								`printf '%s' '# milestone summary' > ${MID_DIR}/${TOY_MILESTONE_ID}-SUMMARY.md && ` +
								`mkdir -p .gsd/ledger && ` +
								`printf '%s' '---\\nid: ${TOY_MILESTONE_ID}\\ntitle: "Toy"\\ncompleted_at: 2026-07-10T00:00:00Z\\nslices: []\\nkey_files: []\\nkey_decisions: []\\n---\\n\\n# ${TOY_MILESTONE_ID}\\n' ` +
								`> .gsd/ledger/${TOY_MILESTONE_ID}.md && echo MILESTONE_CLOSED`,
						},
					},
				],
			},
		},
		resultTurn(start + 3, "closed milestone"),
	];
}

/** A harmless `bash` warm-up turn (see the warm-up note on `blockedTailTranscript`). */
function bashTurn(turn: number, echo: string): TranscriptTurn {
	return { turn, emit: { kind: "tool_use", calls: [{ name: "bash", input: { command: `echo ${echo}` } }] } };
}

/** Turn: the worker reports the unit BLOCKED (needs a human) — the loop pauses. */
function blockedResultTurn(turn: number, reason: string): TranscriptTurn {
	return {
		turn,
		emit: { kind: "tool_use", calls: [{ name: "forge_unit_result", input: { status: "blocked", summary: reason, artifacts: [], reason } }] },
	};
}

// ── E2E-4 fixtures: a SINGLE remaining unit ──────────────────────────────────
// The exit-code cases drive a milestone that is ALREADY planned on disk with
// T01/T02 persisted done in STATE, so `/forge auto` has EXACTLY ONE unit left
// (T03). A single-unit run sidesteps the multi-unit `forge_unit_result`
// early-settle timing (whose residual worker turn can consume the next unit's
// first transcript turn on a slow host) — the terminal reason (and thus the
// exit code) is what we assert, so one deterministic unit is all we need.

/** Write S01-PLAN.md + all three T0x-PLAN.md so the slice reads `planned` from disk. */
function plantSlicePlan(dir: string): void {
	const base = `${dir}/${REL_BASE}`;
	mkdirSync(base, { recursive: true });
	writeFileSync(
		`${base}/${TOY_SLICE_ID}-PLAN.md`,
		`---\nid: ${TOY_SLICE_ID}\nmilestone: ${TOY_MILESTONE_ID}\ntitle: "Primeira slice"\n---\n\n# plan\n`,
	);
	for (const t of TOY_TASK_IDS) {
		mkdirSync(`${base}/tasks/${t}`, { recursive: true });
		writeFileSync(`${base}/tasks/${t}/${t}-PLAN.md`, taskPlan(t));
	}
}

/** Persist STATE with T01/T02 done so only T03 remains for `/forge auto`. */
function plantStateT03Pending(dir: string): void {
	const body = [
		"# STATE",
		"",
		"```yaml",
		`milestone: ${TOY_MILESTONE_ID}`,
		"phase: executing",
		`current_slice: ${TOY_SLICE_ID}`,
		"units:",
		// Slice-qualified entries (M3 strict match, snapshot.ts unitStatus):
		// an unqualified legacy task entry is deliberately invisible to the
		// dispatcher — planting the pre-M3 format here made T01/T02 look
		// pending, re-dispatched T01 against a T03-scripted transcript, and
		// desynced the whole run (found 2026-07-11 via the S07/T03 gate).
		"  - id: T01",
		"    type: task",
		"    status: done",
		`    slice: ${TOY_SLICE_ID}`,
		"  - id: T02",
		"    type: task",
		"    status: done",
		`    slice: ${TOY_SLICE_ID}`,
		"```",
		"",
	].join("\n");
	writeFileSync(`${dir}/.gsd/STATE.md`, body, "utf8");
}

/**
 * T03 warms up with a no-op `bash`, then reports BLOCKED → the loop pauses with a
 * structured `blocked` terminal (E2E-4).
 *
 * NB: a unit's FIRST worker turn must be a real tool call (`bash`), NOT a bare
 * `forge_unit_result` — the MCP result tool is only reachably registered after
 * the first round-trip, so a result-on-turn-one silently stalls into a timeout.
 */
function blockedTailTranscript(): TranscriptTurn[] {
	return [
		bashTurn(1, "T03_WARMUP"),
		blockedResultTurn(2, "T03 precisa de decisão humana"),
		...Array.from({ length: 4 }, (_, i) => ({ turn: 3 + i, emit: { kind: "text" as const, text: "spare" } })),
	];
}

/** T03 commits + reports done → the completion units close slice + milestone → complete. */
function completeTailTranscript(): TranscriptTurn[] {
	return [
		commitTurn(1, "T03"),
		resultTurn(2, "did T03"),
		...completionTurns(3),
		...Array.from({ length: 4 }, (_, i) => ({ turn: 7 + i, emit: { kind: "text" as const, text: "spare" } })),
	];
}

/**
 * Run-1 transcript: plan-slice completes and persists, then T01 parks on a long
 * `sleep` (killed before it can commit or emit its result).
 */
function firstRunTranscript(): TranscriptTurn[] {
	return [
		{
			turn: 1,
			emit: {
				kind: "tool_use",
				calls: [
					{
						name: "write",
						input: { path: `${REL_BASE}/${TOY_SLICE_ID}-PLAN.md`, content: taskPlan(TOY_SLICE_ID) },
					},
					...TOY_TASK_IDS.map((t) => ({
						name: "write",
						input: { path: `${REL_BASE}/tasks/${t}/${t}-PLAN.md`, content: taskPlan(t) },
					})),
				],
			},
		},
		resultTurn(2, "planned S01"),
		// T01 parks here — long enough to reliably catch + SIGKILL mid-unit.
		{ turn: 3, emit: { kind: "tool_use", calls: [{ name: "bash", input: { command: "sleep 45 && echo LATE" } }] } },
		resultTurn(4, "T01 late"),
	];
}

/** Relaunch transcript (fresh cursor): drives the remaining tasks T01→T03, then the completion units. */
function relaunchTranscript(): TranscriptTurn[] {
	const turns: TranscriptTurn[] = [];
	let n = 1;
	for (const t of TOY_TASK_IDS) {
		turns.push(commitTurn(n++, t));
		turns.push(resultTurn(n++, `did ${t}`));
	}
	turns.push(...completionTurns(n));
	n += 4;
	for (let i = 0; i < 4; i++) turns.push({ turn: n++, emit: { kind: "text", text: "spare" } });
	return turns;
}

describe("forge kill-9 resilience e2e (real binary, resume from STATE)", () => {
	const avail = binaryAvailable();
	const skipReason = avail.ok ? null : avail.reason;

	test(
		"SIGKILL mid-unit → relaunch resumes from STATE (no re-run of done units) and completes the milestone",
		{ skip: skipReason ?? false },
		async (t) => {
			const project = createTmpProject({ git: true });
			t.after(project.cleanup);
			const dir = project.dir;
			writeToyMilestone(dir);

			const env = { GSD_FAKE_LLM_TRANSCRIPT: "", GSD_TOOL_APPROVAL: "auto", FORGE_UNIT_TIMEOUT_MS: "60000" };
			const launch = (transcriptPath: string) =>
				gsdAsync(["--print", "/forge auto", "--model", "gsd-fake-model", "--mode", "text"], {
					cwd: dir,
					env: { ...env, GSD_FAKE_LLM_TRANSCRIPT: transcriptPath },
				});

			// ── run 1: park inside T01, then kill -9 ──
			const first = launch(writeTranscript(firstRunTranscript()));
			t.after(() => first.kill().catch(() => {}));

			let killed = false;
			for (let i = 0; i < 200; i++) {
				await sleep(100);
				if (journalUnitFlow(dir).includes("unit_dispatched:S01/T01")) {
					first.child.kill("SIGKILL");
					killed = true;
					break;
				}
				if (first.child.exitCode !== null) break;
			}
			const firstExit = await first.done();
			assert.ok(killed, "reached the T01 dispatch and issued SIGKILL before the unit completed");
			assert.equal(firstExit.signal, "SIGKILL", `first run was killed by SIGKILL (got signal=${firstExit.signal} code=${firstExit.code})`);

			// Mid-unit invariant: plan/S01 done + T01 dispatched, but T01 NOT done.
			const flowAtKill = journalUnitFlow(dir);
			assert.ok(flowAtKill.includes("unit_result:plan/S01"), "plan/S01 completed + persisted before the kill");
			assert.ok(!flowAtKill.includes("unit_result:S01/T01"), "T01 was interrupted (no result) — a true mid-unit kill");
			const stateAtKill = readState(dir);
			assert.ok(
				!stateAtKill.units?.some((u) => u.type === "task" && u.id === "T01" && u.status === "done"),
				"T01 not marked done in STATE at the kill point",
			);
			assert.notEqual(stateAtKill.phase, "complete", "milestone not complete at the kill point");

			// ── relaunch: no edits, resume from STATE, drive to completion ──
			const second = launch(writeTranscript(relaunchTranscript()));
			t.after(() => second.kill().catch(() => {}));
			const secondExit = await second.done();
			assert.equal(
				secondExit.code,
				0,
				`relaunch exited cleanly, got code=${secondExit.code} signal=${secondExit.signal}. stderr=${second.stderr().slice(-1000)}`,
			);

			// ── STATE: the resumed run drove the milestone to complete (via the
			// completion units) and rebuilt the global projections in-process ──
			const state = readState(dir);
			assert.equal(state.phase, "complete", "milestone complete after the kill-9 + relaunch");
			assert.ok(projectionsExist(dir), ".gsd/LEDGER.md AND .gsd/DECISIONS.md rebuilt after the resumed milestone close");
			assert.ok(state.units?.some((u) => u.type === "milestone" && u.status === "done"), "milestone unit done");
			assert.ok(state.units?.some((u) => u.type === "slice" && u.id === TOY_SLICE_ID && u.status === "done"), "slice done");
			for (const task of TOY_TASK_IDS) {
				assert.ok(state.units?.some((u) => u.type === "task" && u.id === task && u.status === "done"), `task ${task} done`);
			}

			// ── acceptance: the resumed run produced REAL commits for all 3 tasks ──
			const log = readGitLog(dir);
			for (const task of TOY_TASK_IDS) {
				assert.ok(
					log.includes(`feat(${TOY_SLICE_ID}/${task}): done`),
					`expected a real commit for ${task} after relaunch, got ${JSON.stringify(log)}`,
				);
			}

			// ── idempotent resume: T01 dispatched twice (killed attempt + resume),
			//    but exactly ONE result per task — no done unit was ever re-run. ──
			const flow = journalUnitFlow(dir);
			assert.equal(
				flow.filter((f) => f === "unit_dispatched:S01/T01").length,
				2,
				"T01 was dispatched twice: the interrupted attempt + the resume",
			);
			for (const task of TOY_TASK_IDS) {
				assert.equal(
					flow.filter((f) => f === `unit_result:S01/${task}`).length,
					1,
					`exactly one unit_result for ${task} across both runs (done units are never re-run)`,
				);
			}
		},
	);
});

// ── E2E-4 (T06): --print exit code reflects the structured loop terminal ──────
describe("forge --print /forge auto exit code e2e (real binary, structured terminal)", () => {
	const avail = binaryAvailable();
	const skipReason = avail.ok ? null : avail.reason;

	const env = { GSD_FAKE_LLM_TRANSCRIPT: "", GSD_TOOL_APPROVAL: "auto", FORGE_UNIT_TIMEOUT_MS: "60000" };
	const launch = (dir: string, transcriptPath: string) =>
		gsdAsync(["--print", "/forge auto", "--model", "gsd-fake-model", "--mode", "text"], {
			cwd: dir,
			env: { ...env, GSD_FAKE_LLM_TRANSCRIPT: transcriptPath },
		});

	test(
		'a blocked unit makes --print "/forge auto" exit with a NON-ZERO code',
		{ skip: skipReason ?? false },
		async (t) => {
			const project = createTmpProject({ git: true });
			t.after(project.cleanup);
			writeToyMilestone(project.dir);
			plantSlicePlan(project.dir);
			plantStateT03Pending(project.dir);

			const run = launch(project.dir, writeTranscript(blockedTailTranscript()));
			t.after(() => run.kill().catch(() => {}));
			const exit = await run.done();

			// Not killed by a signal — a clean, natural drain with a non-zero code.
			assert.equal(exit.signal, null, `exited naturally (no signal), got signal=${exit.signal}`);
			assert.notEqual(exit.code, 0, `blocked /forge auto exits non-zero, got code=${exit.code}. stderr=${run.stderr().slice(-800)}`);

			// The loop really ran + paused on the blocked unit (not some other failure).
			const flow = journalUnitFlow(project.dir);
			assert.ok(flow.includes("unit_dispatched:S01/T03"), "T03 was dispatched");
			assert.notEqual(readState(project.dir).phase, "complete", "milestone did not complete");
		},
	);

	test(
		'a completing milestone makes --print "/forge auto" exit 0',
		{ skip: skipReason ?? false },
		async (t) => {
			const project = createTmpProject({ git: true });
			t.after(project.cleanup);
			writeToyMilestone(project.dir);
			plantSlicePlan(project.dir);
			plantStateT03Pending(project.dir);

			const run = launch(project.dir, writeTranscript(completeTailTranscript()));
			t.after(() => run.kill().catch(() => {}));
			const exit = await run.done();

			assert.equal(exit.code, 0, `complete /forge auto exits 0, got code=${exit.code}. stderr=${run.stderr().slice(-800)}`);
			assert.equal(readState(project.dir).phase, "complete", "milestone completed");
		},
	);
});
