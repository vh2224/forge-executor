/**
 * Forge — COMPLETE-MILESTONE acceptance on the REAL BINARY (S04 / T04).
 *
 * ── What this proves (milestone acceptance #1 + #4) ──────────────────────────
 * A toy milestone of 1 slice + 3 tasks is driven end-to-end by `/forge auto` on
 * the REAL built binary (`GSD_SMOKE_BINARY`), in a fresh `mkdtemp` git repo —
 * NEVER the live `.gsd/` of this repo (a forge 1.0 runtime manages it; writing
 * there corrupts live state). A fake MODEL (`GSD_FAKE_LLM_TRANSCRIPT`) scripts
 * the worker turns; nothing else is faked — the whole production path runs:
 * slash-command routing → `runAuto` → `runForgeLoop` → `dispatchUnitViaNewSession`
 * → real `ctx.newSession()` → the fresh worker session's turn → the real
 * `forge_unit_result` commit point → STATE/journal housekeeping → the next unit.
 *
 * The worker's `execute-task` turns run a real `git commit` via bash BEFORE
 * emitting `forge_unit_result`, so the commits in `git log` are REAL and come
 * from the worker, not from the loop (D3 — the loop never commits). That is the
 * substance of acceptance #1.
 *
 * ── Why this is deterministic now (the W4 note is closed by T01) ─────────────
 * S03/T06 documented `gsd --print "/forge auto"` as NON-deterministic: the
 * worker turn's `withSession` was DEAD CODE on the real `newSession` path, so
 * whether the worker turn fired (and whether control returned to the loop)
 * varied across harness builds. S04/T01 fixed the root cause
 * (`AgentSessionNavigationModule.newSession` now invokes `withSession`), which
 * stabilizes the print-mode loop: the full 3-task run completes identically on
 * every invocation. This suite therefore asserts the FULL done-path on the real
 * binary — the coverage S03 explicitly escalated to S04.
 *
 * ── RUNNER ───────────────────────────────────────────────────────────────────
 * The binary is spawned as a child (unaffected by any in-process hook). But the
 * assertion helpers in `_shared/forge-fixture.ts` import the forge state parser
 * SOURCE, whose ESM `.js` specifiers over `.ts` files bare
 * `--experimental-strip-types` does not rewrite. We self-register a `.js`→`.ts`
 * resolver hook FIRST and pull the fixture module in via dynamic import, so this
 * file runs under both the plain `test:e2e`/`test:ci` glob and the dedicated
 * `test:e2e:forge` runner.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTmpProject } from "./_shared/tmp-project.ts";
import { writeTranscript, type TranscriptTurn } from "./_shared/fake-llm.ts";
import { gsdSync } from "./_shared/spawn.ts";

// ── self-registered `.js`→`.ts` source resolver (see the RUNNER note above) ──
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

/** Skip (never a silent false-green) when the built binary is not present. */
function binaryAvailable(): { ok: boolean; reason?: string } {
	const bin = process.env.GSD_SMOKE_BINARY;
	if (!bin) return { ok: false, reason: "GSD_SMOKE_BINARY not set; build with `pnpm run build:pi` and re-export." };
	if (!existsSync(bin)) return { ok: false, reason: `binary not found at ${bin}` };
	return { ok: true };
}

const REL_BASE = `.gsd/milestones/${TOY_MILESTONE_ID}/slices/${TOY_SLICE_ID}`;

function taskPlan(taskId: string): string {
	// A MINIMAL VALID `must_haves:` block so the S06 enforcing gate (D-S06-1)
	// treats the plan as non-legacy and dispatches it — the plan text is
	// otherwise unchanged. Mirrors the schema forge-loop.e2e.test.ts uses.
	return `---\nid: ${taskId}\nslice: ${TOY_SLICE_ID}\nmilestone: ${TOY_MILESTONE_ID}\ntitle: "Task ${taskId}"\nmust_haves:\n  truths:\n    - "does the thing"\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/out.ts\n---\n\n# ${taskId}\n`;
}

function slicePlan(): string {
	return `---\nid: ${TOY_SLICE_ID}\nmilestone: ${TOY_MILESTONE_ID}\ntitle: "Primeira slice"\n---\n\n# ${TOY_SLICE_ID}\n`;
}

/**
 * The worker transcript that drives the whole milestone. Global cursor: the fake
 * provider replays turns sequentially across every `newSession`, so the turns
 * are ordered exactly as the units run (plan-slice, then T01/T02/T03).
 *
 *   plan-slice S01 → write S01-PLAN + 3 task plans, then forge_unit_result
 *   execute-task T0x → `git add -A && git commit` (a REAL commit, acceptance #1),
 *                      then forge_unit_result done
 */
function milestoneTranscript(): TranscriptTurn[] {
	const turns: TranscriptTurn[] = [
		// ── plan-slice S01: author the slice + the three task plans on disk ──
		{
			turn: 1,
			emit: {
				kind: "tool_use",
				calls: [
					{ name: "write", input: { path: `${REL_BASE}/${TOY_SLICE_ID}-PLAN.md`, content: slicePlan() } },
					...TOY_TASK_IDS.map((t) => ({
						name: "write",
						input: { path: `${REL_BASE}/tasks/${t}/${t}-PLAN.md`, content: taskPlan(t) },
					})),
				],
			},
		},
		{
			turn: 2,
			emit: {
				kind: "tool_use",
				calls: [
					{
						name: "forge_unit_result",
						input: { status: "done", summary: "planned S01", artifacts: [`${REL_BASE}/${TOY_SLICE_ID}-PLAN.md`] },
					},
				],
			},
		},
	];

	// ── execute-task T01/T02/T03: a REAL git commit, then the commit point ──
	let n = 3;
	for (const t of TOY_TASK_IDS) {
		const summaryPath = `${REL_BASE}/tasks/${t}/${t}-SUMMARY.md`;
		turns.push({
			turn: n++,
			emit: {
				kind: "tool_use",
				calls: [
					{
						name: "bash",
						input: {
							command:
								`mkdir -p ${REL_BASE}/tasks/${t} && ` +
								`printf '%s' '---\\nid: ${t}\\n---\\n\\n# ${t} done\\n' > ${summaryPath} && ` +
								`git add -A && git commit -q -m "feat(${TOY_SLICE_ID}/${t}): done" && echo COMMITTED_${t}`,
						},
					},
				],
			},
		});
		turns.push({
			turn: n++,
			emit: {
				kind: "tool_use",
				calls: [{ name: "forge_unit_result", input: { status: "done", summary: `did ${t}`, artifacts: [summaryPath] } }],
			},
		});
	}

	// ── complete-slice S01 (D-S03-1): write S01-SUMMARY, then the commit point ──
	// A completion unit's FIRST worker turn must be a real tool call (bash), not a
	// bare `forge_unit_result` (the MCP result tool is only reachable after the
	// first round-trip). The SUMMARY is the artifact the loop gates the slice flip
	// on; without it the loop downgrades the unit to `partial` and never completes.
	turns.push({
		turn: n++,
		emit: {
			kind: "tool_use",
			calls: [
				{
					name: "bash",
					input: {
						command:
							`printf '%s' '---\\nid: ${TOY_SLICE_ID}\\nstatus: done\\n---\\n\\n# ${TOY_SLICE_ID} summary\\n' ` +
							`> ${REL_BASE}/${TOY_SLICE_ID}-SUMMARY.md && echo SLICE_CLOSED`,
					},
				},
			],
		},
	});
	turns.push({
		turn: n++,
		emit: {
			kind: "tool_use",
			calls: [{ name: "forge_unit_result", input: { status: "done", summary: "closed S01", artifacts: [] } }],
		},
	});

	// ── complete-milestone (D-S03-2): write <mid>-SUMMARY + a LEDGER fragment; the
	// loop's `runMilestoneClose` then rebuilds LEDGER.md/DECISIONS.md ──
	const MID_DIR = `.gsd/milestones/${TOY_MILESTONE_ID}`;
	turns.push({
		turn: n++,
		emit: {
			kind: "tool_use",
			calls: [
				{
					name: "bash",
					input: {
						command:
							`printf '%s' '---\\nid: ${TOY_MILESTONE_ID}\\nstatus: done\\n---\\n\\n# milestone summary\\n' ` +
							`> ${MID_DIR}/${TOY_MILESTONE_ID}-SUMMARY.md && ` +
							`mkdir -p .gsd/ledger && ` +
							`printf '%s' '---\\nid: ${TOY_MILESTONE_ID}\\ntitle: "Toy"\\ncompleted_at: 2026-07-10T00:00:00Z\\nslices: []\\nkey_files: []\\nkey_decisions: []\\n---\\n\\n# ${TOY_MILESTONE_ID}\\n' ` +
							`> .gsd/ledger/${TOY_MILESTONE_ID}.md && echo MILESTONE_CLOSED`,
					},
				},
			],
		},
	});
	turns.push({
		turn: n++,
		emit: {
			kind: "tool_use",
			calls: [{ name: "forge_unit_result", input: { status: "done", summary: "closed milestone", artifacts: [] } }],
		},
	});

	// Cushion turns: tolerate any extra model call the print-mode agent loop
	// might take after a `forge_unit_result` (never load-bearing — the run has
	// already reached `phase: complete` by the time these could be consumed).
	for (let i = 0; i < 4; i++) turns.push({ turn: n++, emit: { kind: "text", text: "spare" } });
	return turns;
}

describe("forge complete-milestone e2e (real binary /forge auto)", () => {
	const avail = binaryAvailable();
	const skipReason = avail.ok ? null : avail.reason;

	test(
		"drives plan-slice → execute-task×3 to completion with REAL git commits + correct STATE/journal",
		{ skip: skipReason ?? false },
		(t) => {
			const project = createTmpProject({ git: true });
			t.after(project.cleanup);
			const dir = project.dir;
			writeToyMilestone(dir);

			const transcript = writeTranscript(milestoneTranscript());

			// A generous spawn cap; the per-unit worker timeout bounds each unit so
			// a regression fails LOUDLY instead of hanging (B4).
			const result = gsdSync(["--print", "/forge auto", "--model", "gsd-fake-model", "--mode", "text"], {
				cwd: dir,
				timeoutMs: 120_000,
				env: {
					GSD_FAKE_LLM_TRANSCRIPT: transcript,
					GSD_TOOL_APPROVAL: "auto",
					FORGE_UNIT_TIMEOUT_MS: "20000",
				},
			});

			assert.equal(
				result.code,
				0,
				`expected a clean exit, got code=${result.code} signal=${result.signal}. stderr=${result.stderrClean.slice(-1200)}`,
			);

			// ── acceptance #1: the worker's bash turns produced REAL commits ──
			const log = readGitLog(dir);
			for (const task of TOY_TASK_IDS) {
				assert.ok(
					log.includes(`feat(${TOY_SLICE_ID}/${task}): done`),
					`expected a real commit for ${task} in git log, got ${JSON.stringify(log)}. ` +
						`Real commits come from the worker's git turns (D3 — the loop never commits). stderr=${result.stderrClean.slice(-600)}`,
				);
			}

			// ── STATE: milestone complete, slice + all three tasks done ──
			const state = readState(dir);
			assert.equal(state.phase, "complete", "milestone flipped to complete");
			assert.ok(
				state.units?.some((u) => u.type === "milestone" && u.status === "done"),
				"milestone unit done",
			);
			assert.ok(
				state.units?.some((u) => u.type === "slice" && u.id === TOY_SLICE_ID && u.status === "done"),
				"slice done",
			);
			for (const task of TOY_TASK_IDS) {
				assert.ok(
					state.units?.some((u) => u.type === "task" && u.id === task && u.status === "done"),
					`task ${task} done in STATE`,
				);
			}

			// ── journal: dispatched→result per unit, in derived order (acc. #4) —
			// now INCLUDING the two dispatched completion units (D-S03-1) ──
			assert.deepEqual(
				journalUnitFlow(dir),
				[
					"unit_dispatched:plan/S01",
					"unit_result:plan/S01",
					"unit_dispatched:S01/T01",
					"unit_result:S01/T01",
					"unit_dispatched:S01/T02",
					"unit_result:S01/T02",
					"unit_dispatched:S01/T03",
					"unit_result:S01/T03",
					"unit_dispatched:complete/S01",
					"unit_result:complete/S01",
					`unit_dispatched:complete/${TOY_MILESTONE_ID}`,
					`unit_result:complete/${TOY_MILESTONE_ID}`,
				],
				"events.jsonl records plan-slice + 3 execute-task + complete-slice + complete-milestone, each a dispatched→result pair, in order",
			);

			// ── `.gsd/` artifacts the workers authored exist on disk ──
			const base = join(dir, REL_BASE);
			assert.ok(existsSync(join(base, `${TOY_SLICE_ID}-PLAN.md`)), "S01-PLAN.md written by the plan-slice worker");
			for (const task of TOY_TASK_IDS) {
				assert.ok(existsSync(join(base, "tasks", task, `${task}-SUMMARY.md`)), `${task}-SUMMARY.md written`);
			}
			assert.ok(existsSync(join(base, `${TOY_SLICE_ID}-SUMMARY.md`)), "S01-SUMMARY.md written by the complete-slice worker");
			assert.ok(
				existsSync(join(dir, ".gsd", "milestones", TOY_MILESTONE_ID, `${TOY_MILESTONE_ID}-SUMMARY.md`)),
				"<mid>-SUMMARY.md written by the complete-milestone worker",
			);
			// ── the milestone-close rebuilt the global projections in-process (D-S03-2) ──
			assert.ok(projectionsExist(dir), ".gsd/LEDGER.md AND .gsd/DECISIONS.md rebuilt after the milestone close");
		},
	);
});
