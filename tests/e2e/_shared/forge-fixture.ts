/**
 * Forge loop e2e — toy-milestone fixture + assertion helpers.
 *
 * `writeToyMilestone(dir)` lays down a MINIMAL but REAL forge-state tree under
 * a fixture directory (never the live `.gsd/` of this repo — the e2e always
 * runs against a `createTmpProject` sandbox): a 2.0-format STATE.md (a fenced
 * ```yaml block, NOT frontmatter — Pitfall 3), a ROADMAP with a single pending
 * slice, and the `slices/S01/` directory the dispatch expects. The layout is
 * exactly what the S02 store's `parseState` / `parseRoadmap` consume, so
 * `deriveNextUnit` derives `plan-slice S01` as the first unit on a fresh tree.
 *
 * The helper deliberately writes NO S##-PLAN.md / task plans: producing those
 * is the plan-slice worker's job, driven by the fake transcript in the e2e.
 * That is what makes the e2e prove the loop end to end rather than a pre-baked
 * happy path.
 *
 * Assertion helpers (`readStateRaw`, `readState`, `readJournal`) read the
 * artifacts the loop writes so the e2e can assert on final STATE + journal
 * ordering with typed access, reusing the store's own parser.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseRoadmap, parseState } from "../../../src/resources/extensions/forge/state/parse.ts";
import type { StateDoc } from "../../../src/resources/extensions/forge/state/types.ts";
import {
	applyConcededFix,
	applyDecision,
	renderReview,
	reviewArtifactPath,
	writeReview,
	type ReviewArtifactMeta,
} from "../../../src/resources/extensions/forge/review/artifact.ts";
import { resolveReview, type ReviewObjection, type ReviewVerdict } from "../../../src/resources/extensions/forge/review/resolve.ts";

/** The toy milestone id used across the forge-loop e2e. */
export const TOY_MILESTONE_ID = "M-toy-forge-e2e";

/** The single slice id the toy milestone ships with. */
export const TOY_SLICE_ID = "S01";

/**
 * The canonical 1-slice / 3-task scenario the S04 acceptance e2e drives (T01,
 * T02, T03). The toy fixture writes NO task plans — the plan-slice worker turn
 * authors `T0x-PLAN.md` under `slices/S01/tasks/`, and each `execute-task` unit
 * completes one of these in order. Exported so the milestone + resilience e2e
 * share one source of truth for the expected unit sequence.
 */
export const TOY_TASK_IDS = ["T01", "T02", "T03"] as const;

export interface ToyMilestone {
	/** The milestone id written into STATE.md and the milestones/<id>/ path. */
	milestoneId: string;
	/** Absolute path to `.gsd/milestones/<milestoneId>`. */
	milestoneDir: string;
	/** Absolute path to `.gsd/STATE.md`. */
	statePath: string;
}

function gsdDir(dir: string): string {
	return join(dir, ".gsd");
}

/** The 2.0 STATE.md body — a fenced ```yaml block, NEVER frontmatter (Pitfall 3). */
function toyStateMd(milestoneId: string): string {
	return [
		"# STATE",
		"",
		"```yaml",
		`milestone: ${milestoneId}`,
		"phase: executing",
		`current_slice: ${TOY_SLICE_ID}`,
		"units: []",
		"```",
		"",
	].join("\n");
}

/** A ROADMAP with a single pending slice, in the "## Slices" table shape parseRoadmap reads. */
function toyRoadmapMd(): string {
	return [
		"# Toy milestone (forge-loop e2e)",
		"",
		"## Slices",
		"",
		"| ID | Nome | Risk | Depends | Status |",
		"|----|------|------|---------|--------|",
		`| ${TOY_SLICE_ID} | Primeira slice | low | — | pending |`,
		"",
	].join("\n");
}

/**
 * Write a minimal, REAL toy milestone under `dir/.gsd`. Returns the ids/paths
 * the caller needs to drive and assert the loop. Idempotent — safe to call on a
 * fresh sandbox dir.
 *
 * Round-trip guaranteed: the STATE.md and ROADMAP.md written here parse cleanly
 * through the S02 store (`assertToyMilestoneParses` proves it), so the fixture
 * can never silently drift from what the dispatch loop actually reads.
 */
export function writeToyMilestone(dir: string): ToyMilestone {
	const milestoneId = TOY_MILESTONE_ID;
	const milestoneDir = join(gsdDir(dir), "milestones", milestoneId);
	const sliceDir = join(milestoneDir, "slices", TOY_SLICE_ID);
	mkdirSync(sliceDir, { recursive: true });

	const statePath = join(gsdDir(dir), "STATE.md");
	writeFileSync(statePath, toyStateMd(milestoneId), "utf8");
	writeFileSync(join(milestoneDir, `${milestoneId}-ROADMAP.md`), toyRoadmapMd(), "utf8");

	const fixture: ToyMilestone = { milestoneId, milestoneDir, statePath };
	assertToyMilestoneParses(dir, fixture);
	return fixture;
}

/**
 * Smoke-assert that the freshly written fixture parses through the SAME store
 * parsers the loop uses. Throws (never returns false) so a drifted fixture
 * fails the test at setup time instead of surfacing as a confusing loop bug.
 */
export function assertToyMilestoneParses(dir: string, fixture: ToyMilestone): void {
	const state = parseState(readFileSync(fixture.statePath, "utf8"));
	if (state.milestone !== fixture.milestoneId) {
		throw new Error(
			`toy fixture STATE.md did not round-trip: expected milestone=${fixture.milestoneId}, got ${state.milestone}`,
		);
	}
	const roadmap = parseRoadmap(
		readFileSync(join(fixture.milestoneDir, `${fixture.milestoneId}-ROADMAP.md`), "utf8"),
	);
	if (roadmap.length !== 1 || roadmap[0].id !== TOY_SLICE_ID) {
		throw new Error(
			`toy fixture ROADMAP did not round-trip: expected 1 slice ${TOY_SLICE_ID}, got ${JSON.stringify(roadmap.map((s) => s.id))}`,
		);
	}
}

// ── completion-flow helpers (S03/T07) ────────────────────────────────────────
//
// The S03 loop dispatches `complete-slice` and `complete-milestone` as REAL
// units driven to a fresh worker (D-S03-1). Each owes a DURABLE artifact on
// `done`, gated by the loop (loop.ts `completionSummaryPath`) and the dispatch
// (dispatch.ts `summaryWritten` / `milestoneSummaryWritten`):
//   • complete-slice     → `slices/<slice>/<slice>-SUMMARY.md`
//   • complete-milestone → `<mid>-SUMMARY.md` (+ a LEDGER fragment the loop's
//     `runMilestoneClose` rebuilds into `.gsd/LEDGER.md`)
// These helpers write those exact artifacts so a scripted/fake worker turn can
// honor the new flow, shared across every forge loop e2e (never duplicated
// per-file). The frontmatter is the minimal-but-valid shape the loop guards
// only for EXISTENCE — the completer's rich synthesis is out of the e2e's scope.

/**
 * Write a slice's `S##-SUMMARY.md` — the durable artifact `complete-slice` owes
 * on `done`. Its existence is what lets the loop flip the slice (loop.ts guard)
 * and stops `deriveNextUnit` from re-emitting the same completion unit. Returns
 * the absolute path written.
 */
export function writeSliceSummary(
	dir: string,
	sliceId: string = TOY_SLICE_ID,
	milestoneId: string = TOY_MILESTONE_ID,
): string {
	const sliceDir = join(gsdDir(dir), "milestones", milestoneId, "slices", sliceId);
	mkdirSync(sliceDir, { recursive: true });
	const path = join(sliceDir, `${sliceId}-SUMMARY.md`);
	writeFileSync(
		path,
		`---\nid: ${sliceId}\nmilestone: ${milestoneId}\nstatus: done\n---\n\n# ${sliceId} summary\n`,
		"utf8",
	);
	return path;
}

/**
 * Write a LEDGER fragment for the milestone at `.gsd/ledger/<mid>.md` in the
 * inline-array shape `state/ledger.ts` parses (and `state/merger.ts` rebuilds
 * into `.gsd/LEDGER.md`). Written directly (not via `writeLedgerFragment`) so
 * the toy milestone id — which is not a canonical timestamp id — is accepted:
 * `listLedgerFragments` keys off the filename, never `isValid`. Returns the path.
 */
export function writeLedgerFragment(dir: string, milestoneId: string = TOY_MILESTONE_ID): string {
	const ledgerDir = join(gsdDir(dir), "ledger");
	mkdirSync(ledgerDir, { recursive: true });
	const path = join(ledgerDir, `${milestoneId}.md`);
	writeFileSync(
		path,
		[
			"---",
			`id: ${milestoneId}`,
			'title: "Toy milestone (forge-loop e2e)"',
			"completed_at: 2026-07-10T00:00:00Z",
			`slices: ["${TOY_SLICE_ID} — Primeira slice"]`,
			"key_files: []",
			"key_decisions: []",
			"---",
			"",
			`# ${milestoneId}`,
			"",
		].join("\n"),
		"utf8",
	);
	return path;
}

/**
 * Write the milestone's `<mid>-SUMMARY.md` — the durable artifact
 * `complete-milestone` owes on `done` — plus (unless `ledgerFragment: false`)
 * the LEDGER fragment the loop's `runMilestoneClose` rebuilds. Returns the
 * SUMMARY path.
 */
export function writeMilestoneSummary(
	dir: string,
	milestoneId: string = TOY_MILESTONE_ID,
	opts: { ledgerFragment?: boolean } = {},
): string {
	const milestoneDir = join(gsdDir(dir), "milestones", milestoneId);
	mkdirSync(milestoneDir, { recursive: true });
	const path = join(milestoneDir, `${milestoneId}-SUMMARY.md`);
	writeFileSync(path, `---\nid: ${milestoneId}\nstatus: done\n---\n\n# ${milestoneId} summary\n`, "utf8");
	if (opts.ledgerFragment !== false) writeLedgerFragment(dir, milestoneId);
	return path;
}

/** Absolute path to the rebuilt global `.gsd/LEDGER.md` projection. */
export function ledgerPath(dir: string): string {
	return join(gsdDir(dir), "LEDGER.md");
}

/** Absolute path to the rebuilt global `.gsd/DECISIONS.md` projection. */
export function decisionsPath(dir: string): string {
	return join(gsdDir(dir), "DECISIONS.md");
}

/** Read `.gsd/LEDGER.md`, or `null` when the milestone-close never rebuilt it. */
export function readLedger(dir: string): string | null {
	const p = ledgerPath(dir);
	return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Read `.gsd/DECISIONS.md`, or `null` when the milestone-close never rebuilt it. */
export function readDecisions(dir: string): string | null {
	const p = decisionsPath(dir);
	return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** True once the milestone-close rebuilt BOTH global projections on disk. */
export function projectionsExist(dir: string): boolean {
	return existsSync(ledgerPath(dir)) && existsSync(decisionsPath(dir));
}

/** Read the raw STATE.md text (for substring assertions / debugging dumps). */
export function readStateRaw(dir: string): string {
	return readFileSync(join(gsdDir(dir), "STATE.md"), "utf8");
}

/** Parse the current STATE.md into a typed `StateDoc` via the store's own parser. */
export function readState(dir: string): StateDoc {
	return parseState(readStateRaw(dir));
}

/** Read + parse the append-only journal, or `[]` when it does not exist yet. */
export function readJournal(dir: string): Array<Record<string, unknown>> {
	const path = join(gsdDir(dir), "forge", "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The ordered list of journal event `kind`s — the loop's audit trail. */
export function journalKinds(dir: string): string[] {
	return readJournal(dir).map((e) => String(e.kind));
}

/**
 * `${kind}:${unit}` pairs for the dispatch-relevant journal events, in order.
 * The e2e asserts on this to prove the loop drove `plan/S01` → the 3 tasks in
 * sequence (a `unit_dispatched`→`unit_result` pair per unit).
 */
export function journalUnitFlow(dir: string): string[] {
	return readJournal(dir)
		.filter((e) => e.kind === "unit_dispatched" || e.kind === "unit_result")
		.map((e) => `${String(e.kind)}:${String(e.unit)}`);
}

/**
 * The oneline commit subjects of the fixture repo, newest first. Used to assert
 * the REAL git commits the worker's bash turns produced (acceptance #1) — the
 * loop itself never commits (D3), so these can only come from the worker.
 */
export function readGitLog(dir: string): string[] {
	const out = execFileSync("git", ["log", "--pretty=%s"], { cwd: dir, encoding: "utf8" });
	return out.split("\n").filter((l) => l.trim().length > 0);
}

// ── gate-artifact helpers (S04/T06) ─────────────────────────────────────────
//
// Additive to the completion helpers above — NEVER touch them. Support the
// `forge-gates.e2e.test.ts` acceptance: assert the advisory artifacts the S04
// `runAdvisoryGates` hook (auto/loop.ts, T05) writes right after a
// `plan-slice: done` that passed the M1R-2 guard, WITHOUT importing the gate
// modules' internal writers — pure path/existence/shape helpers over the
// SAME on-disk locations `gates/plan-checker.ts` / `gates/security.ts` /
// `gates/checker-memory.ts` / `state/merger.ts` use.

/** Absolute path to the slice's `S##-PLAN-CHECK.md` advisory scorecard. */
export function planCheckPath(dir: string, sliceId: string, milestoneId: string = TOY_MILESTONE_ID): string {
	return join(gsdDir(dir), "milestones", milestoneId, "slices", sliceId, `${sliceId}-PLAN-CHECK.md`);
}

/** Absolute path to the slice's `S##-SECURITY.md` advisory checklist. */
export function securityPath(dir: string, sliceId: string, milestoneId: string = TOY_MILESTONE_ID): string {
	return join(gsdDir(dir), "milestones", milestoneId, "slices", sliceId, `${sliceId}-SECURITY.md`);
}

/** Absolute path to the per-slice CHECKER fragment (`.gsd/checker/<mid>/<slice>.md`). */
export function checkerFragmentPathFor(
	dir: string,
	sliceId: string,
	milestoneId: string = TOY_MILESTONE_ID,
): string {
	return join(gsdDir(dir), "checker", milestoneId, `${sliceId}.md`);
}

/** Absolute path to the rebuilt global `.gsd/CHECKER.md` projection. */
export function checkerProjectionPath(dir: string): string {
	return join(gsdDir(dir), "CHECKER.md");
}

/** Read `.gsd/CHECKER.md`, or `null` when the milestone-close never rebuilt it. */
export function readCheckerProjection(dir: string): string | null {
	const p = checkerProjectionPath(dir);
	return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/**
 * Assert the three per-slice advisory artifacts + the CHECKER fragment exist
 * on disk after `runAdvisoryGates` ran for `sliceId`. Throws with a clear
 * message naming the missing path(s) — never returns a bare boolean, so a
 * gate regression fails the test at the exact assertion site.
 */
export function assertGateArtifacts(dir: string, sliceId: string, milestoneId: string = TOY_MILESTONE_ID): void {
	const missing: string[] = [];
	if (!existsSync(planCheckPath(dir, sliceId, milestoneId))) missing.push(`${sliceId}-PLAN-CHECK.md`);
	if (!existsSync(securityPath(dir, sliceId, milestoneId))) missing.push(`${sliceId}-SECURITY.md`);
	if (!existsSync(checkerFragmentPathFor(dir, sliceId, milestoneId)))
		missing.push(`.gsd/checker/${milestoneId}/${sliceId}.md`);
	if (missing.length > 0) {
		throw new Error(`assertGateArtifacts: missing advisory artifact(s): ${missing.join(", ")}`);
	}
}

/**
 * Write a DELIBERATELY weak `S##-PLAN.md` + task-plan tree that the native
 * plan-checker (`gates/plan-checker.ts` `scoreCompleteness`) scores `fail`
 * (>=2 completeness gaps): the slice plan DECLARES every id in `declaredIds`
 * under `## Tasks`, but only `materializedIds` get an actual `T##-PLAN.md` on
 * disk, each with an EMPTY `## Goal` section. Every declared-but-unmaterialized
 * id is a "no plan file" gap; every materialized one is an "empty ## Goal" gap
 * — guaranteed `gaps.length >= 2` regardless of which ids are chosen, so
 * `checkPlan` returns `counts.fail > 0` deterministically. Mirrors
 * `writeSlicePlanArtifacts` (S03/T06) but intentionally starves completeness
 * instead of satisfying it — proves the D-S04-1 advisory-first posture (a weak
 * plan must NEVER block/re-dispatch the loop).
 */
export function writeWeakSlicePlanArtifacts(
	dir: string,
	declaredIds: string[],
	materializedIds: string[],
	sliceId: string = TOY_SLICE_ID,
	milestoneId: string = TOY_MILESTONE_ID,
): void {
	const sliceDir = join(gsdDir(dir), "milestones", milestoneId, "slices", sliceId);
	mkdirSync(sliceDir, { recursive: true });
	const tasksList = declaredIds.map((id) => `- **${id}** — toy weak task (${id})`).join("\n");
	writeFileSync(
		join(sliceDir, `${sliceId}-PLAN.md`),
		`---\nid: ${sliceId}\nmilestone: ${milestoneId}\ntitle: "Weak slice"\n---\n\n# ${sliceId} plan\n\n## Tasks\n\n${tasksList}\n`,
		"utf8",
	);
	for (const id of materializedIds) {
		const taskDir = join(sliceDir, "tasks", id);
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, `${id}-PLAN.md`),
			// A MINIMAL VALID `must_haves:` block so the S06 enforcing gate (D-S06-1)
			// treats the plan as non-legacy and DISPATCHES it — the plan stays
			// deliberately WEAK for the advisory plan-checker (the `## Goal` section
			// is still empty, so `scoreCompleteness` keeps counting its gaps). The
			// must_haves block lives in the frontmatter and never fills the Goal gap.
			`---\nid: ${id}\nslice: ${sliceId}\nmilestone: ${milestoneId}\ntitle: "Weak ${id}"\nmust_haves:\n  truths:\n    - "does the thing"\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/out.ts\n---\n\n## Goal\n\n`,
			"utf8",
		);
	}
}

// ── review-artifact helpers (S05/T06) ───────────────────────────────────────
//
// Additive to every helper above — NEVER touch them. Support the
// `forge-review.e2e.test.ts` acceptance: seed a REAL `S##-REVIEW.md` through
// the SAME grammar `review/artifact.ts` owns (`resolveReview` → `renderReview`
// → `writeReview`, then the exact write-back functions `applyDecision` /
// `applyConcededFix`) — never duplicating the render/parse strings, so the
// fixture can never silently drift from what the native review module writes
// and `collectPendingReviewItems` later reads (round-trip proof, D-S05-4).
//
// The ONE literal that must be duplicated here is the "deferido → triagem no
// fim da milestone" decision marker `applyDecision` stamps on an OPEN item:
// `review/artifact.ts`'s `DECISION_DEFERRED` constant is private (by design —
// it is grammar, not API), and `applyDecision` takes the decision TEXT as an
// argument rather than a fixed enum. The `conceded-sem-fix` write-back needs
// NO duplication: `applyConcededFix(path, id, "failed")` already stamps the
// module's own `CORRECTION_FAILED` constant internally.

/** The exact Step 7b marker `collectPendingReviewItems` recognizes for a deferred OPEN item. */
const OPEN_DEFERRED_DECISION = "deferido → triagem no fim da milestone";

/** Options for {@link writeReviewArtifact} — counts of each pending posture to seed. */
export interface WriteReviewArtifactOpts {
	sliceTitle?: string;
	/** Number of OPEN objections, write-backed with the deferred marker (Step 7b). */
	openDeferred?: number;
	/** Number of CONCEDED objections whose fix write-back is stamped "failed" (Step 7a). */
	concededNoFix?: number;
	/** Number of objections the rebuttal withdraws (RESOLVED — no pending action). */
	resolved?: number;
	reviewedOn?: string;
	rounds?: number;
}

/** Absolute path to `slices/<S##>/<S##>-REVIEW.md`, delegating to the artifact module's own builder. */
export function reviewArtifactPathFor(
	dir: string,
	sliceId: string = TOY_SLICE_ID,
	milestoneId: string = TOY_MILESTONE_ID,
): string {
	return reviewArtifactPath(dir, milestoneId, sliceId);
}

/**
 * Seed a valid `S##-REVIEW.md` on disk, driving the REAL `resolveReview` →
 * `renderReview` → `writeReview` pipeline (never hand-rolled markdown), then
 * applying the exact write-backs (`applyDecision`/`applyConcededFix`) that
 * put `openDeferred` items into the "deferred to triage" posture and
 * `concededNoFix` items into the "fix failed, deferred to triage" posture —
 * both of which `collectPendingReviewItems` (Step 9.1) is built to recognize.
 * `resolved` items (rebuttal withdrawn) are seeded for parity but never
 * write-backed (RESOLVED items carry no pending action).
 *
 * Ids are synthetic `R1`, `R2`, ... (tolerant of the S03/T07 gotcha: this
 * writes the artifact path directly via `writeReview`, with no `isValid()`
 * gate). Returns the artifact path plus the ids seeded into each posture, so
 * the e2e can assert on both the rendered artifact and the collected items.
 */
export function writeReviewArtifact(
	dir: string,
	milestoneId: string = TOY_MILESTONE_ID,
	sliceId: string = TOY_SLICE_ID,
	opts: WriteReviewArtifactOpts = {},
): { path: string; openIds: string[]; concededIds: string[]; resolvedIds: string[] } {
	const openN = opts.openDeferred ?? 0;
	const concededN = opts.concededNoFix ?? 0;
	const resolvedN = opts.resolved ?? 0;

	const objections: ReviewObjection[] = [];
	const defenseVerdicts: ReviewVerdict<"refuted" | "conceded" | "open">[] = [];
	const rebuttalRound: ReviewVerdict<"maintained" | "withdrawn" | "conceded">[] = [];
	const openIds: string[] = [];
	const concededIds: string[] = [];
	const resolvedIds: string[] = [];

	let n = 0;
	for (let i = 0; i < openN; i++) {
		n++;
		const id = `R${n}`;
		openIds.push(id);
		objections.push({
			id,
			pathLine: `toy/${id}.ts:1`,
			severity: "high",
			claim: `objeção aberta ${id}`,
			suggestedFix: "n/a",
			challenge: "ainda em disputa?",
		});
		defenseVerdicts.push({ id, verdict: "refuted", rationale: "defesa mantida" });
		rebuttalRound.push({ id, verdict: "maintained", rationale: "reviewer mantém" });
	}
	for (let i = 0; i < concededN; i++) {
		n++;
		const id = `R${n}`;
		concededIds.push(id);
		objections.push({
			id,
			pathLine: `toy/${id}.ts:1`,
			severity: "medium",
			claim: `objeção concedida ${id}`,
			suggestedFix: "aplicar fix",
			challenge: "procede?",
		});
		defenseVerdicts.push({ id, verdict: "conceded", rationale: "advocate concede" });
		rebuttalRound.push({ id, verdict: "maintained", rationale: "n/a (conceded já decide)" });
	}
	for (let i = 0; i < resolvedN; i++) {
		n++;
		const id = `R${n}`;
		resolvedIds.push(id);
		objections.push({
			id,
			pathLine: `toy/${id}.ts:1`,
			severity: "low",
			claim: `objeção resolvida ${id}`,
			suggestedFix: "n/a",
			challenge: "ok?",
		});
		defenseVerdicts.push({ id, verdict: "refuted", rationale: "defesa" });
		rebuttalRound.push({ id, verdict: "withdrawn", rationale: "reviewer recua" });
	}

	const rounds = opts.rounds ?? 1;
	const result = resolveReview(objections, defenseVerdicts, [rebuttalRound], rounds);
	const meta: ReviewArtifactMeta = {
		milestoneId,
		slice: sliceId,
		sliceTitle: opts.sliceTitle ?? "Toy review slice",
		reviewedOn: opts.reviewedOn ?? "2026-07-10",
		rounds,
	};
	const content = renderReview(meta, result);
	const { path } = writeReview(dir, milestoneId, sliceId, content);

	for (const id of openIds) applyDecision(path, id, OPEN_DEFERRED_DECISION);
	for (const id of concededIds) applyConcededFix(path, id, "failed");

	return { path, openIds, concededIds, resolvedIds };
}
