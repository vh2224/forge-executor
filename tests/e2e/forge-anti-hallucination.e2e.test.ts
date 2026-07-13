/**
 * Forge anti-hallucination — end-to-end acceptance (S06 / T07).
 *
 * Proves, against the REAL `runForgeLoop` in-process (the injectable
 * `SessionDriver` seam every sibling forge e2e uses) and the REAL bootstrap
 * evidence subscription (`registerEvidenceCapture`), the two invariants the S06
 * verify wiring (T06) locks down:
 *
 *   ENFORCING (the ONE new block path, D-S06-1) —
 *   1. a present-but-LEGACY `T##-PLAN.md` (no `must_haves:` block) BLOCKS the
 *      execute-task PRE-dispatch: the loop returns `{reason:"blocked"}`, journals
 *      `must_haves_gate`, persists the task `blocked`, and the fake driver is
 *      NEVER called for that unit;
 *   2. a MALFORMED `must_haves:` schema blocks identically;
 *   3. a VALID `must_haves:` plan is TRANSPARENT — the loop dispatches and drives
 *      the slice/milestone to completion exactly like the happy path.
 *
 *   ADVISORY (never blocks / mutes / re-dispatches, D-S06-4/5/6) —
 *   4. on `complete-slice`, `runVerifyGate` writes `S##-VERIFICATION.md` natively
 *      and journals `verify` + `file_audit`, WITHOUT altering the slice outcome;
 *   5. a `tool_execution_end` on a FRESH post-`newSession` instance's `pi`
 *      produces one `evidence` journal event attributed to the CURRENT unit;
 *   6. a THROW inside the verify gate (VERIFICATION target sabotaged to a dir) is
 *      swallowed best-effort — the loop still completes, no crash / no pause.
 *
 * ── fail-before / pass-after ────────────────────────────────────────────────
 * This regression is NEW at T07. Were the T06 wiring absent, #1/#2 would let the
 * execute-task dispatch through (driver called, `reason:"complete"`, no gate
 * event) → assertions fail; #4 would find no `S##-VERIFICATION.md` / no
 * `verify`/`file_audit` events → fail; #5 would journal no `evidence` event →
 * fail. With the wiring in place the whole file is green.
 *
 * Isolation: every test runs against `createTmpProject` + `writeToyMilestone` —
 * NEVER the live `.gsd/` of this repo, mirroring every sibling e2e.
 *
 * ── RUNNER (mirrors forge-loop.e2e.test.ts) ─────────────────────────────────
 * Self-registers the `.js`→`.ts` source resolver hook BEFORE any dynamic import
 * of the forge extension source (which uses ESM `.js` specifiers over `.ts`
 * files), then pulls the hook-dependent modules in via dynamic `import()`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
} = await import("./_shared/forge-fixture.ts");
const { runForgeLoop } = await import("../../src/resources/extensions/forge/auto/loop.ts");
const { ForgeAutoSession } = await import("../../src/resources/extensions/forge/auto/session.ts");

// ── scripted fake worker (mirrors forge-loop.e2e.test.ts) ───────────────────

interface Step {
	onDispatch?: (dir: string, unit: NextUnit, prompt: string) => void;
	outcome: UnitOutcome;
}

function scriptedDriver(dir: string, steps: Step[]): SessionDriver & { units: NextUnit[] } {
	const units: NextUnit[] = [];
	let i = 0;
	return {
		units,
		async dispatch(unit, prompt) {
			const step = steps[i++];
			assert.ok(step, `scripted driver ran out of steps at dispatch #${i} (unit ${JSON.stringify(unit)})`);
			units.push(unit);
			step.onDispatch?.(dir, unit, prompt);
			return step.outcome;
		},
	};
}

function doneOutcome(summary = "ok"): UnitOutcome {
	return { kind: "result", result: { status: "done", summary, artifacts: [] } };
}

function makeSession(dir: string) {
	const s = new ForgeAutoSession();
	s.active = true;
	s.cwd = dir;
	return s;
}

function label(u: NextUnit): string {
	if (u.type === "execute-task") return `task:${u.task}`;
	if (u.type === "complete-slice") return `complete-slice:${u.slice}`;
	if (u.type === "complete-milestone") return `complete-milestone:${u.milestone}`;
	return `plan:${u.slice}`;
}

// ── task-plan fixtures (the enforcing gate reads the frontmatter) ────────────

/** A T01-PLAN.md body with the given (already-indented) frontmatter tail. */
function taskPlanBody(mustHavesFm: string): string {
	return `---\nid: T01\nslice: ${TOY_SLICE_ID}\nmilestone: ${TOY_MILESTONE_ID}\ntitle: "Task T01"\n${mustHavesFm}---\n\n# T01\n\n## Goal\nImplement it.\n`;
}

const LEGACY_TASK = taskPlanBody(""); // no must_haves: block at all — legacy
const MALFORMED_TASK = taskPlanBody("must_haves:\n  truths: notanarray\n"); // truths not a list
const VALID_TASK = taskPlanBody(
	'must_haves:\n  truths:\n    - "does the thing"\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/out.ts\n',
);

/**
 * The plan-slice worker: write S01-PLAN.md declaring T01 under `## Tasks`, plus
 * a single T01-PLAN.md whose frontmatter is controlled by `taskPlan`. After
 * `plan-slice: done`, the loop derives execute-task T01 (planned + 1 task).
 */
function writeSlicePlan(dir: string, taskPlan: string): void {
	const sliceDir = join(dir, ".gsd", "milestones", TOY_MILESTONE_ID, "slices", TOY_SLICE_ID);
	mkdirSync(join(sliceDir, "tasks", "T01"), { recursive: true });
	writeFileSync(
		join(sliceDir, `${TOY_SLICE_ID}-PLAN.md`),
		`---\nid: ${TOY_SLICE_ID}\nmilestone: ${TOY_MILESTONE_ID}\ntitle: "Primeira slice"\n---\n\n# ${TOY_SLICE_ID} plan\n\n## Tasks\n\n- T01\n`,
	);
	writeFileSync(join(sliceDir, "tasks", "T01", "T01-PLAN.md"), taskPlan);
}

/** The two completion steps that close a valid slice + its milestone. */
function completionSteps(): Step[] {
	return [
		{ onDispatch: (d, u) => writeSliceSummary(d, u.type === "complete-slice" ? u.slice : TOY_SLICE_ID), outcome: doneOutcome("closed S01") },
		{ onDispatch: (d) => writeMilestoneSummary(d), outcome: doneOutcome("closed milestone") },
	];
}

// ── ENFORCING #1/#2 — a present-but-invalid plan BLOCKS pre-dispatch ─────────

describe("forge anti-hallucination e2e — enforcing must-haves gate BLOCKS (D-S06-1)", () => {
	test("a LEGACY execute-task plan blocks pre-dispatch: no driver call, blocked terminal, gate event, STATE blocked", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;
		writeToyMilestone(dir);

		// plan-slice writes a LEGACY T01-PLAN.md; execute-task must NOT dispatch after.
		const driver = scriptedDriver(dir, [
			{ onDispatch: (d) => writeSlicePlan(d, LEGACY_TASK), outcome: doneOutcome("planned S01") },
		]);

		const terminal = await runForgeLoop(makeSession(dir), { cwd: dir, driver });

		assert.deepEqual(
			driver.units.map(label),
			["plan:S01"],
			"the driver was NEVER called for execute-task T01 — the enforcing guard blocked pre-dispatch",
		);
		assert.equal(terminal.reason, "blocked", "the loop returns a blocked terminal");

		const gate = readJournal(dir).find((e) => e.kind === "must_haves_gate");
		assert.ok(gate, "a must_haves_gate event was journaled");
		assert.equal(gate?.status, "blocked", "the gate event is blocked");
		assert.equal(gate?.task, "T01", "the gate event names the blocked task");
		assert.match(String(gate?.summary), /legacy/, "the summary cites the legacy reason");

		const state = readState(dir);
		const taskUnit = (state.units ?? []).find((u) => u.type === "task" && u.id === "T01");
		assert.equal(taskUnit?.status, "blocked", "STATE persisted the task as blocked via applyUnitResult");
		assert.notEqual(state.phase, "complete", "a blocked task never completes the milestone");
	});

	test("a MALFORMED must_haves schema blocks identically — no dispatch, blocked terminal, gate event", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;
		writeToyMilestone(dir);

		const driver = scriptedDriver(dir, [
			{ onDispatch: (d) => writeSlicePlan(d, MALFORMED_TASK), outcome: doneOutcome("planned S01") },
		]);

		const terminal = await runForgeLoop(makeSession(dir), { cwd: dir, driver });

		assert.deepEqual(driver.units.map(label), ["plan:S01"], "malformed plan → no execute-task dispatch");
		assert.equal(terminal.reason, "blocked", "the malformed plan blocks the loop");
		const gate = readJournal(dir).find((e) => e.kind === "must_haves_gate");
		assert.ok(gate, "must_haves_gate journaled for the malformed plan");
		assert.match(String(gate?.summary), /malformed/, "the summary cites the malformed reason");
	});
});

// ── ENFORCING #3 — a VALID plan is transparent, the slice completes ──────────

describe("forge anti-hallucination e2e — a VALID plan dispatches + completes", () => {
	test("a valid must_haves schema is transparent: the loop drives plan → task → complete", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;
		writeToyMilestone(dir);

		const driver = scriptedDriver(dir, [
			{ onDispatch: (d) => writeSlicePlan(d, VALID_TASK), outcome: doneOutcome("planned S01") },
			{ outcome: doneOutcome("did T01") },
			...completionSteps(),
		]);

		const terminal = await runForgeLoop(makeSession(dir), { cwd: dir, driver });

		assert.deepEqual(
			driver.units.map(label),
			["plan:S01", "task:T01", "complete-slice:S01", `complete-milestone:${TOY_MILESTONE_ID}`],
			"a valid must_haves schema does NOT block — the loop ran to completion",
		);
		assert.equal(terminal.reason, "complete", "the enforcing guard is transparent for a valid plan");
		assert.equal(
			readJournal(dir).find((e) => e.kind === "must_haves_gate"),
			undefined,
			"no must_haves_gate event for a valid plan",
		);

		const state = readState(dir);
		assert.equal(state.phase, "complete", "milestone flipped to complete");
	});
});

// ── ADVISORY #4/#6 — verify gate writes VERIFICATION, never blocks ───────────

describe("forge anti-hallucination e2e — advisory verify gate NEVER blocks (D-S06-4/5)", () => {
	test("runVerifyGate writes S##-VERIFICATION.md + journals verify/file_audit without altering the outcome", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;
		writeToyMilestone(dir);

		const driver = scriptedDriver(dir, [
			{ onDispatch: (d) => writeSlicePlan(d, VALID_TASK), outcome: doneOutcome("planned S01") },
			{ outcome: doneOutcome("did T01") },
			...completionSteps(),
		]);

		const terminal = await runForgeLoop(makeSession(dir), { cwd: dir, driver });

		const verificationMd = join(dir, ".gsd", "milestones", TOY_MILESTONE_ID, "slices", TOY_SLICE_ID, `${TOY_SLICE_ID}-VERIFICATION.md`);
		assert.ok(existsSync(verificationMd), "S01-VERIFICATION.md was written natively by runVerifyGate");

		const kinds = journalKinds(dir);
		assert.ok(kinds.includes("verify"), "a verify event was journaled");
		assert.ok(kinds.includes("file_audit"), "a file_audit event was journaled");

		// the advisory gate is LATERAL — the loop completed exactly like the valid path above.
		assert.deepEqual(driver.units.map(label), [
			"plan:S01",
			"task:T01",
			"complete-slice:S01",
			`complete-milestone:${TOY_MILESTONE_ID}`,
		]);
		assert.equal(terminal.reason, "complete", "the verify gate never blocks/mutates the outcome");
	});

	test("a THROW inside the verify gate (VERIFICATION target sabotaged to a dir) is swallowed — the loop still completes", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;
		writeToyMilestone(dir);

		const driver = scriptedDriver(dir, [
			{
				onDispatch: (d) => {
					writeSlicePlan(d, VALID_TASK);
					// Sabotage: pre-create the VERIFICATION output PATH as a directory so
					// writeVerification's atomic rename throws mid-gate. The gate's
					// try/catch must swallow it and the loop must still complete.
					mkdirSync(
						join(d, ".gsd", "milestones", TOY_MILESTONE_ID, "slices", TOY_SLICE_ID, `${TOY_SLICE_ID}-VERIFICATION.md`),
						{ recursive: true },
					);
				},
				outcome: doneOutcome("planned S01 (sabotaged verify target)"),
			},
			{ outcome: doneOutcome("did T01") },
			...completionSteps(),
		]);

		const notes: Array<[string, string | undefined]> = [];
		const terminal = await runForgeLoop(makeSession(dir), { cwd: dir, driver, notify: (m, l) => notes.push([m, l]) });

		assert.deepEqual(
			driver.units.map(label),
			["plan:S01", "task:T01", "complete-slice:S01", `complete-milestone:${TOY_MILESTONE_ID}`],
			"a throwing verify gate never blocks — the loop advanced and completed unchanged",
		);
		assert.equal(terminal.reason, "complete", "best-effort: the verify failure is swallowed, milestone completes");
		const state = readState(dir);
		assert.equal(state.phase, "complete", "milestone still flips to complete despite the sabotaged gate");
	});
});

// ── ADVISORY #5 — tool_execution_end → one evidence event for the unit ───────

describe("forge anti-hallucination e2e — evidence subscription attributes to the current unit (D-S06-6)", () => {
	/**
	 * S06 R2 review-fix regression: exercises the REAL `newSession` swap, not a
	 * fakePi pre-injected before `runAuto`. The evidence subscription MUST live on
	 * the fresh post-swap instance's own `pi` (`registerEvidenceCapture` in the
	 * bootstrap), because that is the only handle that observes the worker's
	 * `tool_execution_end` events. The old wiring subscribed once at runAuto entry
	 * on the pre-loop handle → captured NOTHING after the first swap.
	 *
	 * fail-before / pass-after: with the runAuto-entry subscription (pre-fix), the
	 * fresh `pi` created by the swap has NO listener → 0 evidence events → the
	 * `equal(1)` assertion fails. With the bootstrap subscription (post-fix), the
	 * fresh `pi` carries the listener → exactly 1 evidence event, keyed to the
	 * unit in flight.
	 */
	test("a tool_execution_end on a FRESH post-newSession pi journals exactly one evidence event keyed to the in-flight unit", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;
		writeToyMilestone(dir);

		const { registerForgeExtension } = await import(
			"../../src/resources/extensions/forge/bootstrap/register-extension.ts"
		);
		const { getForgeAutoSession } = await import("../../src/resources/extensions/forge/auto/session.ts");

		// The process-wide singleton the bootstrap subscription reads. Prime it as an
		// active loop with a unit in flight and the toy milestone id — exactly the
		// state `runAuto` publishes before dispatching.
		const s = getForgeAutoSession();
		s.reset();
		s.active = true;
		s.cwd = dir;
		s.milestoneId = TOY_MILESTONE_ID;
		s.currentUnit = { type: "execute-task", slice: TOY_SLICE_ID, task: "T01" };
		t.after(() => s.reset());

		// A minimal `pi` facade with ONLY the seams the bootstrap registrations
		// touch. Each `registerForgeExtension(pi)` call models one instance — a
		// FRESH `pi` after a `newSession` swap re-runs the whole bootstrap.
		function makeFakePi() {
			const handlers: Record<string, ((ev: { toolName: string; isError: boolean }) => void) | undefined> = {};
			return {
				on(event: string, cb: (ev: { toolName: string; isError: boolean }) => void) {
					handlers[event] = cb;
				},
				emit(event: string, ev: { toolName: string; isError: boolean }) {
					handlers[event]?.(ev);
				},
				// no-op seams the other bootstrap registrations may call
				registerCommand() {},
				registerTool() {},
				registerShortcut() {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools() {},
				async setModel() {},
			};
		}

		// Instance #1 (interactive session, pre-swap): register the bootstrap.
		const pi1 = makeFakePi();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		registerForgeExtension(pi1 as any);

		// The swap: `newSession` tears down instance #1 and re-runs the bootstrap on
		// a brand-new `pi2`. The worker's tool_execution_end fires on THIS handle.
		const pi2 = makeFakePi();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		registerForgeExtension(pi2 as any);

		// The worker turn emits on the FRESH instance's pi — never pi1.
		pi2.emit("tool_execution_end", { toolName: "write", isError: false });

		const evidence = readJournal(dir).filter((e) => e.kind === "evidence");
		assert.equal(
			evidence.length,
			1,
			"exactly one evidence event was journaled — the FRESH post-swap pi carried the subscription (R2)",
		);
		assert.equal(evidence[0]?.unit, `${TOY_SLICE_ID}/T01`, "the evidence event is keyed to the in-flight execute-task unit");
		assert.equal(evidence[0]?.status, "ok", "a non-error tool end journals status ok");
		assert.match(String(evidence[0]?.summary), /write/, "the summary cites the tool name");
	});
});
