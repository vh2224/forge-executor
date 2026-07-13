/**
 * `auto/loop.ts` — the deterministic S03 dispatch loop.
 *
 * One iteration = read the on-disk snapshot → derive the next unit → (if none,
 * reconcile completion and finish) → compose a lean prompt → dispatch it via an
 * INJECTABLE `SessionDriver` → fold the outcome through the pure failure
 * taxonomy → journal + (on success) apply the single atomic STATE mutator →
 * continue / retry / pause.
 *
 * ── Injectable driver seam (the key architectural choice) ───────────────────
 * The loop NEVER touches `pi`/`ctx` or `newSession`. All session interaction is
 * behind `SessionDriver.dispatch` (B3: no stale handles leak in here). The
 * production driver is `auto/driver.ts`; tests inject a scripted fake driver, so
 * the whole derive→compose→dispatch→housekeep decision path is exercised with
 * zero harness — and the T06 e2e only has to prove the thin real driver.
 *
 * ── Single-writer (D3) + atomicity (B5) ─────────────────────────────────────
 * Every STATE mutation goes through the S02 store's `updateState`, and a unit's
 * result is applied through EXACTLY ONE `updateState` call with the single
 * atomic mutator from `applyUnitResult` (B5.1). When `deriveNextUnit` returns
 * null, `reconcileCompletion` (B5.2) repairs a stuck-complete milestone rather
 * than exiting silently.
 */

import { readSnapshot, type ForgeSnapshot } from "./snapshot.js";
import {
  applyUnitResult,
  decideNextAction,
  persistedUnitStatus,
  reconcileCompletion,
  type ForgeLoopEvent,
  type UnitResult,
} from "./housekeeping.js";
import { composePrompt, type ComposeInfo } from "../prompts/compose.js";
import { scopeDomainFor } from "./scope-domain.js";
import { loadRankedMemory, renderProjectMemoryBlock } from "../memory/memory-rank.js";
import {
  appendEvent,
  deriveNextUnit,
  familyOf,
  sliceComplete,
  unitSlice,
  updateState,
  type NextUnit,
} from "../state/index.js";
import type { UnitOutcome } from "../worker/rendezvous.js";
import { effectiveModelFor, resolveUnitResultToolName, type ForgeAutoSession } from "./session.js";
import { resolveDispatchAuthor } from "./driver.js";
import type { ResolvedEffort } from "./effort.js";
import { replayJournalOnResume } from "./replay.js";
import { runMilestoneClose } from "./complete.js";
import {
  checkPlan,
  writePlanCheck,
  scanSecurity,
  writeSecurityChecklist,
  writeCheckerFragment,
} from "../gates/index.js";
import {
  readReviewPrefs,
  reviewArtifactPath,
  collectPendingReviewItems,
  runReviewDialectic,
  productionReviewDispatcher,
  type ReviewDispatcher,
} from "../review/index.js";
import { authorFamilyForSlice } from "./reviewer-independence.js";
import { readEvents } from "../state/store.js";
import {
  enforceMustHaves,
  runSliceVerification,
  renderVerification,
  writeVerification,
  auditFiles,
  collectExpectedOutputs,
} from "../verify/index.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** Severity levels for `notify`, matching the harness UI. */
export type NotifyLevel = "info" | "warning" | "error" | "success";

/**
 * E2E-4 (T06): the structured terminal reason a `runForgeLoop` returns.
 *
 * The loop no longer exits `void` — every point where it flips `s.active=false`
 * and breaks now attributes WHY it stopped, so the caller (`runAuto`) can map the
 * terminal to an `--print`/headless exit code (a non-`complete` reason → exit ≠ 0)
 * WITHOUT reaching into `pi`/`ctx` or coupling to the journal.
 *
 * - `complete`   — nothing left to derive (milestone reconciled/done), or a
 *                  `once` unit finished successfully.
 * - `paused`     — a retry budget was exhausted, or a resumed unit was already
 *                  `partial` in STATE (needs a human, but not a hard block).
 * - `blocked`    — a unit returned `blocked` (or was already `blocked` in STATE).
 * - `ceiling`    — the global iteration ceiling was hit (runaway replan guard).
 * - `no_progress`— N consecutive iterations made no real forward progress.
 */
export type LoopTerminalReason = "complete" | "paused" | "blocked" | "ceiling" | "no_progress";

/** The structured result of a `runForgeLoop` run (E2E-4). */
export interface LoopTerminal {
  reason: LoopTerminalReason;
  message?: string;
}

/**
 * The one seam the loop dispatches through. The production implementation
 * (`auto/driver.ts`) runs the unit in a fresh `newSession`; tests inject a
 * scripted fake. Either way the loop only ever sees a resolved `UnitOutcome`.
 */
export interface SessionDriver {
  dispatch(unit: NextUnit, prompt: string): Promise<UnitOutcome>;
}

/** Everything the loop needs that is not on the container. `notify` is optional. */
export interface LoopDeps {
  cwd: string;
  driver: SessionDriver;
  notify?: (message: string, level?: NotifyLevel) => void;
  /** Injectable review seam; omitted legacy callers retain deferred behavior. */
  reviewDispatcher?: ReviewDispatcher;
  /** Whether an operator can act on ask_in_auto: pause notifications. */
  interactive?: boolean;
}

/** `once: true` runs exactly ONE unit to a terminal action (the `/forge next` base). */
export interface LoopOptions {
  once?: boolean;
}

/** Stable per-unit key used for the retry tally and journal `unit` field. */
function unitKey(unit: NextUnit): string {
  switch (unit.type) {
    case "execute-task":
      return `${unit.slice}/${unit.task}`;
    case "complete-slice":
      return `complete/${unit.slice}`;
    case "complete-milestone":
      return `complete/${unit.milestone}`;
    default:
      // plan-slice (the only remaining variant).
      return `plan/${unitSlice(unit)}`;
  }
}

/**
 * The durable SUMMARY a completion unit owes on `done`. `complete-slice` writes
 * `slices/<slice>/<slice>-SUMMARY.md`; `complete-milestone` writes
 * `<mid>-SUMMARY.md`. Returns the absolute path to check, or `undefined` for a
 * non-completion unit (no SUMMARY guard applies).
 */
function completionSummaryPath(cwd: string, milestoneId: string, unit: NextUnit): string | undefined {
  const milestoneDir = join(cwd, ".gsd", "milestones", milestoneId);
  if (unit.type === "complete-slice") {
    return join(milestoneDir, "slices", unit.slice, `${unit.slice}-SUMMARY.md`);
  }
  if (unit.type === "complete-milestone") {
    return join(milestoneDir, `${milestoneId}-SUMMARY.md`);
  }
  return undefined;
}

/**
 * "G1 do git" (fix batch pós-M6): best-effort HEAD SHA stamped on unit
 * lifecycle events (`unit_dispatched`/`unit_result`/`unit_timeout`) so the
 * exact commit range of a slice/milestone is derivable in ANY isolation mode —
 * including commits straight onto main, where merge-base==HEAD blinded the
 * review diff (M6 ceremony finding #1). Never throws; omitted without git.
 */
function stampUnitSha(cwd: string, ev: ForgeLoopEvent): ForgeLoopEvent {
  if (ev.kind === "unit_dispatched" || ev.kind === "unit_result" || ev.kind === "unit_timeout") {
    try {
      const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      if (sha) ev.sha = sha;
    } catch {
      /* best-effort — repos sem git ficam sem o campo */
    }
  }
  return ev;
}

/** Normalize a driver outcome into the pure taxonomy's `UnitResult` (timeout folded in). */
function outcomeToResult(outcome: UnitOutcome): UnitResult {
  if (outcome.kind === "timeout") {
    return { status: "timeout", reason: "Worker não emitiu forge_unit_result antes do timeout." };
  }
  const { status, summary, reason } = outcome.result;
  return { status, summary, reason };
}

/**
 * Build the `unit_dispatched` journal event emitted BEFORE each dispatch.
 * `author` (G1/T01) is the effective `{ provider, model }` resolved by the
 * caller via the `resolveModelForRole` seam (config role×pool) — populated
 * only when at least one field is known, never as `""`/`"null"`. `family` is
 * re-derived here via `familyOf` rather than reused from the seam's own
 * `family` field — identical result (single derivation site), avoids growing
 * this helper's parameter shape.
 */
function dispatchedEvent(
  snap: ForgeSnapshot,
  unit: NextUnit,
  key: string,
  author?: { provider: string | null; model: string | null },
  effort?: ResolvedEffort | null,
  rank?: { rankReason?: string; domain?: string } | null,
): ForgeLoopEvent {
  const ev: ForgeLoopEvent = {
    ts: new Date().toISOString(),
    kind: "unit_dispatched",
    unit: key,
    agent: "forge-loop",
    milestone: snap.milestoneId,
    status: "dispatched",
    summary: `Dispatch de ${unit.type} (${key}).`,
    slice: unitSlice(unit),
  };
  if (unit.type === "execute-task") ev.task = unit.task;
  if (author?.model || author?.provider) {
    if (author.model) ev.model = author.model;
    if (author.provider) ev.provider = author.provider;
    ev.family = familyOf(author.model ?? author.provider!);
  }
  // S01 effort axis (D-S01-3): the dispatched event carries the RESOLVED
  // effort — what the loop decided pre-dispatch — never the applied one
  // (that belongs to the result, token-gated). Fields stay absent (never
  // ""/"null") when no effort config resolved: byte-identity.
  if (effort) {
    ev.effort = effort.level;
    ev.effort_reason = effort.reason;
  }
  // S09/T03 (addendum §6): `rank_reason`/`domain` are additive and present
  // ONLY when `resolveDispatchAuthor` published them on the container (the
  // cross-pool judgment branch decided this dispatch's authorship) — same
  // absent-not-empty-string byte-identity guard as `effort` above.
  if (rank?.rankReason) {
    ev.rank_reason = rank.rankReason;
    if (rank.domain) ev.domain = rank.domain;
  }
  return ev;
}

/**
 * S02/T02: the loop's own operator-facing signal for a `resolveModelForRole`
 * BLOCKED-by-violation resolve (`resolved.violation === "reviewer_not_author"`,
 * T01's marker) — reuses the loop's existing `notify` channel (same one
 * `must_haves_gate`/gates-advisory warnings already use) rather than a second
 * journal write; `driver.ts`'s `journalReviewerNotAuthorViolation` is the
 * single dedicated-event journal signal for the same violation (one journal
 * write + one notify, never a duplicate of either). Exported so the contract
 * is unit-testable directly (T02-PLAN step 5 "fake do seam") — no production
 * unit-type resolves as reviewer/advocate yet (`roleForUnit` has no entry for
 * either, S04 decisão B), so this never fires through a real dispatch today.
 */
export function notifyReviewerNotAuthorViolation(
  notify: (message: string, level?: NotifyLevel) => void,
  key: string,
): void {
  notify(
    `VIOLAÇÃO reviewer_not_author no dispatch de ${key} — resolução BLOCKED, nenhum modelo de autoria aplicado (não é o degrade genérico).`,
    "warning",
  );
}

/**
 * Derive `{ model, provider, family }` from a flat `provider/model-id` ref
 * (e.g. `s.appliedUnitModel`) — same split-at-first-`/` convention as
 * `resolveModelForRole`'s winner branch and `effectiveModelFor`'s per-unit
 * pref branch. `familyOf` stays the single family-derivation site.
 */
function authorFromRef(ref: string): { model: string; provider: string; family: string } {
  const slash = ref.indexOf("/");
  const provider = slash > 0 ? ref.slice(0, slash) : ref;
  return { model: ref, provider, family: familyOf(ref) };
}

/** Keep operator notifications best-effort: a broken renderer must not stop the loop. */
function notifySafely(notify: (message: string, level?: NotifyLevel) => void, message: string, level: NotifyLevel): void {
  try {
    notify(message, level);
  } catch {
    // Transcript rendering is advisory and must never affect loop state.
  }
}

/** Format the two transcript boundary signals from the same stable unit key. */
export function formatUnitBoundary(
  unit: NextUnit,
  model: string,
  elapsedMs?: number,
  status?: string,
): string {
  const key = unitKey(unit);
  if (elapsedMs === undefined) return `▶ ${key} · ${unit.type} · ${model || "unknown"}`;
  return `✓ ${key} · ${status ?? "unknown"} · ${Math.max(0, elapsedMs)}ms`;
}

/** Emit the persistent pause marker while retaining the original reason. */
export function notifyLoopPaused(
  notify: (message: string, level?: NotifyLevel) => void,
  reason: string,
): void {
  const sanitized = reason.replace(/[\r\n]+/g, " ").trim() || "motivo não informado";
  notifySafely(notify, `⏸ PAUSADO (${sanitized}) — retome com /forge auto`, "warning");
}

/** Assemble the lean `composePrompt` context from a snapshot + unit. */
function composeInfoFor(
  snap: ForgeSnapshot,
  unit: NextUnit,
  s: ForgeAutoSession,
  dispatchAuthorRef?: string,
): ComposeInfo {
  return {
    cwd: snap.cwd,
    milestoneId: snap.milestoneId,
    milestoneTitle: snap.titles.milestone,
    sliceTitle: snap.titles.slice[unitSlice(unit)],
    taskTitle: unit.type === "execute-task" ? snap.titles.task[`${unitSlice(unit)}/${unit.task}`] : undefined,
    // B2: namespaced tool name only when the unit's effective provider is
    // claude-code (externalCli). Bare `forge_unit_result` on every other path.
    resultToolName: resolveUnitResultToolName(s, unit),
    dispatchAuthorRef,
    // S05/T02 (D-S05-C): best-effort pre-resolution — the reader never
    // throws, so no try/catch is needed to keep dispatch immune. Only
    // `plan-slice` has a production call-site here; `plan-milestone` is
    // compose-level-only (S05-PLAN Notes §2, deferred until its dispatch
    // front-end exists).
    scopeDomain: unit.type === "plan-slice" ? scopeDomainFor(snap.cwd, snap.milestoneId, unitSlice(unit) || undefined) : undefined,
  };
}

/**
 * S04 (D-S04-1) — the STRICTLY advisory, best-effort gate hook the loop runs
 * IN-PROCESS right after a `plan-slice: done` that passed the M1R-2 guard (a
 * parseable, task-bearing PLAN on disk) and BEFORE the loop decides the next
 * action. It is deliberately LATERAL to the dispatch flow:
 *
 *   (a) `checkPlan` + `writePlanCheck` → `S##-PLAN-CHECK.md` (10-dimension scorecard);
 *   (b) `scanSecurity` + `writeSecurityChecklist` → `S##-SECURITY.md`;
 *   (c) each warn/fail plan-checker dimension → a CHECKER fragment row (`writeCheckerFragment`);
 *   (d) a `plan_check` event (pass/warn/fail counts) + a `plan_gate` event (outcome:skipped);
 *   (e) a warn/fail `frontmatter_compliance` verdict (S01, conditional dimension —
 *       only present when the CONTEXT declares the requirement) → a pt-BR
 *       `notify(..., "warning")`, same best-effort try/catch as everything above.
 *
 * D-S04-1 invariants, all enforced by the caller and this body:
 *   - NEVER mutates `result`/`decision`, NEVER re-dispatches, NEVER blocks — a
 *     `fail > 0` scorecard leaves the loop's flow byte-identical to no hook.
 *   - The WHOLE body is wrapped in try/catch: any throw from a gate is swallowed
 *     (best-effort), so a gate bug can never crash `/forge auto`.
 *   - Never runs the CHECKER projection inline (that is the merger's job at
 *     `runMilestoneClose`); it only WRITES the per-slice fragment (D-S04-6:
 *     `plan_gate:skipped` is journal parity — the interactive handshake is M3).
 *
 * NOTE: the caller already re-read the snapshot for the M1R-2 guard, but this
 * helper reads the plan text itself (small, local) to keep it self-contained and
 * decoupled from that read's lifetime.
 */
function runAdvisoryGates(
  cwd: string,
  milestoneId: string,
  sliceId: string,
  notify: (message: string, level?: NotifyLevel) => void,
): void {
  try {
    // (a) plan-checker scorecard.
    const planResult = checkPlan(cwd, milestoneId, sliceId);
    if (planResult.status === "done") {
      writePlanCheck(cwd, milestoneId, sliceId, planResult);
    }

    // (b) security skeleton — scans the raw S##-PLAN.md text.
    const planPath = join(cwd, ".gsd", "milestones", milestoneId, "slices", sliceId, `${sliceId}-PLAN.md`);
    let planText = "";
    try {
      planText = readFileSync(planPath, "utf-8");
    } catch {
      planText = "";
    }
    const scan = scanSecurity(planText);
    writeSecurityChecklist(cwd, milestoneId, sliceId, scan);

    // (c) feed each warn/fail dimension into the per-slice CHECKER fragment.
    for (const dim of planResult.dimensions) {
      if (dim.verdict === "warn" || dim.verdict === "fail") {
        writeCheckerFragment(cwd, milestoneId, sliceId, {
          dimension: dim.name,
          verdict: dim.verdict,
          note: dim.justification,
        });
      }
    }

    // (e) S01: surface a warn/fail frontmatter_compliance verdict as a
    // notify — the dimension only appears in planResult.dimensions when the
    // CONTEXT requirement was detected (checkPlan's conditional 13th).
    const frontmatterDim = planResult.dimensions.find((dim) => dim.name === "frontmatter_compliance");
    if (frontmatterDim && (frontmatterDim.verdict === "warn" || frontmatterDim.verdict === "fail")) {
      notify(
        `Plan-check ${sliceId}: frontmatter_compliance ${frontmatterDim.verdict} — ${frontmatterDim.justification}`,
        "warning",
      );
    }

    // (d) journal the advisory outcome — plan_check (counts) + plan_gate (skipped).
    const counts = planResult.counts;
    const planCheckEvent: ForgeLoopEvent = {
      ts: new Date().toISOString(),
      kind: "plan_check",
      unit: `plan/${sliceId}`,
      agent: "forge-loop",
      milestone: milestoneId,
      status: planResult.status,
      slice: sliceId,
      summary: `plan-check advisory: pass=${counts.pass} warn=${counts.warn} fail=${counts.fail} (risk=${scan.riskLevel}).`,
    };
    appendEvent(cwd, planCheckEvent);

    const planGateEvent: ForgeLoopEvent = {
      ts: new Date().toISOString(),
      kind: "plan_gate",
      unit: `plan/${sliceId}`,
      agent: "forge-loop",
      milestone: milestoneId,
      status: "skipped",
      slice: sliceId,
      summary: `plan-gate outcome:skipped mode:auto — advisory only (D-S04-6: interactive handshake deferred to M3).`,
    };
    appendEvent(cwd, planGateEvent);
  } catch (err) {
    // D-S04-1: STRICTLY advisory best-effort — swallow ANY gate/journal failure.
    // A gate bug must never block/crash the loop; surface a soft note and move on.
    const message = err instanceof Error ? err.message : String(err);
    notify(`Gates advisory ignorados (best-effort): ${message}`, "info");
  }
}

/**
 * S05 (D-S05-1/D-S05-3) — the STRICTLY advisory native-review footprint, run
 * BEFORE a `complete-slice` unit is dispatched. It wires the review MACHINE
 * state (idempotence + posture + journal parity) but NEVER dispatches the
 * challenger/advocate agents — that dialectic orchestration lives in the
 * orchestrator (M3). In the deterministic auto loop the posture is inert:
 *
 *   (a) prefs `mode: disabled`  → silence (no event).
 *   (b) `S##-REVIEW.md` present → idempotent no-op: emit `review:present`
 *       (best-effort count extraction from the `**Outcome:**` header) WITHOUT
 *       rewriting the artifact (Step 0a idempotence).
 *   (c) artifact absent         → auto posture is `ask_in_auto: defer`: emit
 *       `review:skipped` + a one-line notify, then let the loop dispatch
 *       complete-slice unchanged.
 *
 * Best-effort like `runAdvisoryGates`: a throw is swallowed to a soft note —
 * the review NEVER blocks the dispatch (W3) and NEVER mutates STATE/budget.
 */
async function runReviewGate(
  s: ForgeAutoSession,
  deps: LoopDeps,
  milestoneId: string,
  sliceId: string,
  sliceTitle: string,
  unit: NextUnit,
  notify: (message: string, level?: NotifyLevel) => void,
): Promise<void> {
  const { cwd } = deps;
  try {
    const prefs = readReviewPrefs(cwd);
    // (a) explicitly disabled — no footprint at all.
    if (prefs.mode === "disabled") return;

    const artifactPath = reviewArtifactPath(cwd, milestoneId, sliceId);
    if (existsSync(artifactPath)) {
      // (b) idempotence: the artifact already exists — do NOT rewrite. Extract
      // the resolved/conceded/open counts from the header when parseable.
      let counts = "";
      try {
        const text = readFileSync(artifactPath, "utf-8");
        const m = text.match(/\*\*Outcome:\*\*[ \t]*(.+)/);
        if (m) counts = ` (${m[1].trim()})`;
      } catch {
        counts = "";
      }
      const presentEvent: ForgeLoopEvent = {
        ts: new Date().toISOString(),
        kind: "review",
        unit: `review/${sliceId}`,
        agent: "forge-loop",
        milestone: milestoneId,
        status: "present",
        slice: sliceId,
        summary: `review present: ${sliceId}-REVIEW.md já existe — idempotente, sem reescrita${counts}.`,
      };
      appendEvent(cwd, presentEvent);
      return;
    }

    // (c) absent — dispatch the real dialectic when the caller supplies the
    // seam. Legacy callers without a session-bound dispatcher retain the old
    // deferral footprint exactly, which keeps this gate lateral and additive.
    const dispatcher = deps.reviewDispatcher ?? (s.cmdCtx ? productionReviewDispatcher(s.cmdCtx) : undefined);
    if (!dispatcher) {
      const skippedEvent: ForgeLoopEvent = {
        ts: new Date().toISOString(),
        kind: "review",
        unit: `review/${sliceId}`,
        agent: "forge-loop",
        milestone: milestoneId,
        status: "skipped",
        slice: sliceId,
        summary: `review skipped: ${sliceId} deferido (ask_in_auto: defer — dialética via orquestrador/M3).`,
      };
      appendEvent(cwd, skippedEvent);
      notify(`⚖ Review ${sliceId}: deferido (ask_in_auto: defer — dialética via orquestrador/M3)`, "info");
      return;
    }

    const authorFamily = authorFamilyForSlice(readEvents(cwd), sliceId);
    const result = await runReviewDialectic({
      cwd,
      milestoneId,
      slice: sliceId,
      sliceTitle,
      unit,
      ctxForResolve: { session: s },
      dispatcher,
      reviewedOn: new Date().toISOString().slice(0, 10),
      rounds: prefs.rounds,
      authorFamily,
      domain: scopeDomainFor(cwd, milestoneId, sliceId),
    });
    const { resolved, conceded, open } = result.result.counts;
    const status = result.result.noFlags && result.warnings.length > 0
      ? "stub"
      : `${resolved} resolved · ${conceded} conceded · ${open} open`;
    appendEvent(cwd, {
      ts: new Date().toISOString(),
      kind: "review",
      unit: `review/${sliceId}`,
      agent: "forge-loop",
      milestone: milestoneId,
      status,
      slice: sliceId,
      summary: `review dialético ${sliceId}: ${status}.`,
    });
    if (open > 0) {
      const message = `⚖ Review ${sliceId}: ${open} item(ns) OPEN — decisão humana pendente.`;
      notify(message, prefs.askInAuto === "pause" && deps.interactive ? "warning" : "info");
    }
  } catch (err) {
    // D-S05-3: STRICTLY advisory — swallow ANY failure. The review never blocks.
    const message = err instanceof Error ? err.message : String(err);
    notify(`Review advisory ignorado (best-effort): ${message}`, "info");
  }
}

/** Run the standalone-task review used by `/forge next`; always best-effort. */
async function runTaskReviewGate(
  s: ForgeAutoSession,
  deps: LoopDeps,
  milestoneId: string,
  unit: Extract<NextUnit, { type: "execute-task" }>,
  notify: (message: string, level?: NotifyLevel) => void,
): Promise<void> {
  try {
    const prefs = readReviewPrefs(deps.cwd);
    if (prefs.mode === "disabled") return;
    const dispatcher = deps.reviewDispatcher ?? (s.cmdCtx ? productionReviewDispatcher(s.cmdCtx) : undefined);
    if (!dispatcher) return;
    const authorFamily = authorFamilyForSlice(readEvents(deps.cwd), unit.slice);
    const writePath = join(
      deps.cwd,
      ".gsd",
      "milestones",
      milestoneId,
      "slices",
      unit.slice,
      "tasks",
      unit.task,
      `${unit.task}-REVIEW.md`,
    );
    const result = await runReviewDialectic({
      cwd: deps.cwd,
      milestoneId,
      slice: unit.slice,
      sliceTitle: unit.slice,
      unit,
      ctxForResolve: { session: s },
      dispatcher,
      reviewedOn: new Date().toISOString().slice(0, 10),
      rounds: prefs.rounds,
      authorFamily,
      artifactTarget: { writePath },
      domain: scopeDomainFor(deps.cwd, milestoneId, unit.slice),
    });
    const { resolved, conceded, open } = result.result.counts;
    appendEvent(deps.cwd, {
      ts: new Date().toISOString(),
      kind: "review",
      unit: `review/${unit.slice}/${unit.task}`,
      agent: "forge-loop",
      milestone: milestoneId,
      status: result.warnings.length > 0 && result.result.noFlags ? "stub" : `${resolved} resolved · ${conceded} conceded · ${open} open`,
      slice: unit.slice,
      task: unit.task,
      summary: `review dialético ${unit.slice}/${unit.task} concluído.`,
    });
    if (open > 0) notify(`⚖ Review ${unit.slice}/${unit.task}: ${open} item(ns) OPEN — decisão humana pendente.`, "info");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notify(`Review advisory ignorado (best-effort): ${message}`, "info");
  }
}

/**
 * S05 (D-S05-1/D-S05-3) — the milestone-final review triage collect, run BEFORE
 * a `complete-milestone` unit is dispatched. It calls `collectPendingReviewItems`
 * (deferred/open items written back across the milestone's slices) and journals
 * a `review_triage` event — `deferred` with a count (>0) or `none`. It NEVER
 * prompts, NEVER blocks, and NEVER mutates STATE/budget: the interactive triage
 * is the orchestrator's (M3). Best-effort like the gate above.
 */
function runReviewTriage(
  cwd: string,
  milestoneId: string,
  notify: (message: string, level?: NotifyLevel) => void,
): void {
  try {
    const prefs = readReviewPrefs(cwd);
    if (prefs.mode === "disabled") return;

    const pending = collectPendingReviewItems(cwd, milestoneId);
    const n = pending.length;
    if (n > 0) {
      const deferredEvent: ForgeLoopEvent = {
        ts: new Date().toISOString(),
        kind: "review_triage",
        unit: `review_triage/${milestoneId}`,
        agent: "forge-loop",
        milestone: milestoneId,
        status: "deferred",
        summary: `review triage: ${n} item(ns) pendente(s) deferido(s) para triagem do orquestrador (M3).`,
      };
      appendEvent(cwd, deferredEvent);
      notify(
        `⚖ Triagem de review: ${n} item(ns) pendente(s) — deferido(s) ao orquestrador (M3).`,
        "info",
      );
      return;
    }

    const noneEvent: ForgeLoopEvent = {
      ts: new Date().toISOString(),
      kind: "review_triage",
      unit: `review_triage/${milestoneId}`,
      agent: "forge-loop",
      milestone: milestoneId,
      status: "none",
      summary: "review triage: nenhum item de review pendente.",
    };
    appendEvent(cwd, noneEvent);
  } catch (err) {
    // D-S05-3: STRICTLY advisory — swallow ANY failure. The triage never blocks.
    const message = err instanceof Error ? err.message : String(err);
    notify(`Triagem de review ignorada (best-effort): ${message}`, "info");
  }
}

/**
 * S06 (D-S06-1) — the ONE ENFORCING anti-hallucination guard. Run PRE-dispatch of
 * an `execute-task`, it reads the unit's `T##-PLAN.md` and runs `enforceMustHaves`
 * on the raw text. The decision is deliberately narrow:
 *
 *   - read FAILS (IO — file absent/unreadable) → returns `null`: NEVER blocks. A
 *     missing plan is not a schema violation; we do not invent a block over absence
 *     (mirrors the enforceMustHaves signature contract — it only ever judges text).
 *   - read succeeds AND `enforceMustHaves(text).ok === false` (present-but-legacy or
 *     malformed) → returns the block descriptor: the loop journals `must_haves_gate:
 *     blocked`, persists `blocked` via `applyUnitResult`, and returns `{reason:
 *     "blocked"}` WITHOUT calling the driver — the SAME shape as the M1R-4 resume
 *     guard (loop.ts).
 *   - read succeeds AND the plan is valid → returns `null`: the dispatch proceeds
 *     byte-identically to no guard.
 *
 * This is the ONLY new block path S06 introduces; everything else (verify/file-audit/
 * evidence) is lateral best-effort.
 */
function enforceExecuteTaskPlan(
  cwd: string,
  milestoneId: string,
  slice: string,
  task: string,
): { message: string } | null {
  const planPath = join(
    cwd,
    ".gsd",
    "milestones",
    milestoneId,
    "slices",
    slice,
    "tasks",
    task,
    `${task}-PLAN.md`,
  );
  let planText: string;
  try {
    planText = readFileSync(planPath, "utf-8");
  } catch {
    // IO error (absent/unreadable) — NEVER blocks (D-S06-1). Only present-but-invalid blocks.
    return null;
  }
  const verdict = enforceMustHaves(planText);
  if (verdict.ok) return null;
  const detail =
    verdict.reason === "malformed" && verdict.detail ? `: ${verdict.detail}` : "";
  return {
    message: `Plano ${task}-PLAN.md ${verdict.reason} (must_haves ausente/inválido${detail}) — dispatch bloqueado até correção do schema.`,
  };
}

/**
 * S06 (D-S06-4/5) — the STRICTLY advisory, best-effort verify hook, run BEFORE a
 * `complete-slice` unit is dispatched (right after `runReviewGate`). It is LATERAL
 * to the flow — it NEVER mutates `result`/`decision`, NEVER re-dispatches, NEVER
 * blocks:
 *
 *   (a) `runSliceVerification` → `renderVerification` (native `generated_at` passed
 *       by THIS caller, never inside the pure renderer) → `writeVerification` writes
 *       `S##-VERIFICATION.md` atomically/idempotently;
 *   (b) `collectExpectedOutputs` (declared) + `git diff --name-only` (best-effort —
 *       swallowed if git fails, degrading to the declared-but-missing-on-disk check)
 *       → `auditFiles`;
 *   (c) a `verify` event (row/legacy/malformed counts) + a `file_audit` event
 *       (missing/unexpected counts).
 *
 * The WHOLE body is wrapped in try/catch: any throw is swallowed to a soft note —
 * a verify bug can never crash/block `/forge auto` (D-S06-4).
 */
function runVerifyGate(
  cwd: string,
  milestoneId: string,
  sliceId: string,
  notify: (message: string, level?: NotifyLevel) => void,
): void {
  try {
    // (a) native slice verification → render → atomic idempotent write.
    const result = runSliceVerification(cwd, milestoneId, sliceId);
    const md = renderVerification(result, { generated_at: new Date().toISOString() });
    writeVerification(cwd, milestoneId, sliceId, md);

    // (b) file-audit: declared expected_output vs the working-tree diff (best-effort).
    const expected = collectExpectedOutputs(cwd, milestoneId, sliceId);
    let changed: string[] = [];
    try {
      const out = execFileSync("git", ["-C", cwd, "diff", "--name-only"], {
        encoding: "utf-8",
      });
      changed = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    } catch {
      // git unavailable / not a repo — degrade to declared-but-missing only.
      changed = [];
    }
    const audit = auditFiles(expected, changed);

    // (c) journal the advisory outcomes — verify (counts) + file_audit (sets).
    const verifyEvent: ForgeLoopEvent = {
      ts: new Date().toISOString(),
      kind: "verify",
      unit: `verify/${sliceId}`,
      agent: "forge-loop",
      milestone: milestoneId,
      status: "done",
      slice: sliceId,
      summary: `verify advisory: rows=${result.rows.length} legacy=${result.legacy_count} malformed=${result.malformed_count} errors=${result.error_count}.`,
    };
    appendEvent(cwd, verifyEvent);

    const fileAuditEvent: ForgeLoopEvent = {
      ts: new Date().toISOString(),
      kind: "file_audit",
      unit: `file_audit/${sliceId}`,
      agent: "forge-loop",
      milestone: milestoneId,
      status: "done",
      slice: sliceId,
      summary: `file-audit advisory: expected=${expected.length} changed=${changed.length} missing=${audit.missing.length} unexpected=${audit.unexpected.length}.`,
    };
    appendEvent(cwd, fileAuditEvent);
  } catch (err) {
    // D-S06-4: STRICTLY advisory best-effort — swallow ANY verify/journal failure.
    const message = err instanceof Error ? err.message : String(err);
    notify(`Verify advisory ignorado (best-effort): ${message}`, "info");
  }
}

/**
 * Run the dispatch loop until there is nothing left to do, a unit blocks, a
 * retry is exhausted, or (`once`) a single unit reaches a terminal action.
 *
 * The container `s` supplies liveness (`s.active`) and the per-unit retry tally;
 * `deps` supplies the working dir, the injectable driver, and an optional
 * notifier. The loop is the SINGLE STATE writer (D3) and applies each unit
 * result through exactly one `updateState` (B5.1).
 */
export async function runForgeLoop(
  s: ForgeAutoSession,
  deps: LoopDeps,
  opts: LoopOptions = {},
): Promise<LoopTerminal> {
  const notify = deps.notify ?? (() => {});
  // M1R-3 (M2-D3): reconcile any journaled `unit_result:done` that a kill-9 left
  // un-flipped in STATE — ONCE, before the first iteration. Re-applies the
  // recovered mutator via the single-writer; NEVER re-dispatches. No-op on a
  // clean resume, so a normal run is unaffected.
  replayJournalOnResume(deps.cwd);
  let failureContext: string | undefined;
  // E2E-3 (T05): a retry's `unit_retry` event is DEFERRED, not journaled eagerly.
  // We hold it here across the iteration boundary and, after the NEXT derive,
  // journal `unit_retry` when the same unit is re-dispatched or `unit_readvanced`
  // when on-disk progress advanced the loop to a different unit (journal fidelity:
  // never claim a re-dispatch that did not happen).
  let pendingRetry: { key: string; retryEvent: ForgeLoopEvent } | undefined;
  // M1R-2: teto global de iterações — sem ele, um `plan-slice: done` que
  // nunca produz progresso real (PLAN ausente/vazio) faz o loop re-derivar a
  // MESMA unidade indefinidamente (replan infinito). O teto escala com o
  // tamanho conhecido do trabalho, com um piso de 32.
  let iterations = 0;
  // R3 (review-fix, operator-approved refactor): guarda SECUNDÁRIA e
  // INDEPENDENTE do teto acima. `maxIterations` é recomputado live a cada
  // iteração a partir de `knownTasks`/`unplanned` — um `plan-slice: done`
  // adversarial que passa o guard M1R-2 (>=1 task) mas com tasks bogus/
  // padded infla `knownTasks` e empurra o teto para sempre mais longe, exatamente
  // o artefato que M1R-2 deveria bound. Este guard NÃO depende do teto: rastreia
  // progresso real via um Set (no processo, imune a manipulação em disco) de
  // chaves de unidade que já completaram (`continue`) alguma vez; se
  // `NO_PROGRESS_LIMIT` iterações consecutivas passam sem uma unidade NOVA
  // completar, pausa com `loop_no_progress` — nunca completa.
  const completedUnitKeys = new Set<string>();
  let noProgressStreak = 0;
  const NO_PROGRESS_LIMIT = 8;

  try {
    while (s.active) {
      // R1 (review-fix): clear the per-unit dispatch hints left over from the
      // PREVIOUS iteration BEFORE composing this unit's prompt. `pendingUnitModel`
      // (and `pendingUnitType`) are only (re)set inside the driver's
      // `dispatchUnitViaNewSession`, which runs AFTER `composePrompt` below — and
      // were previously reset only in the outer `finally`, never between
      // iterations. So a stale value from unit N survived into
      // `effectiveProviderFor` when resolving the tool name for unit N+1: a
      // per-type model override on N with no override on N+1 mis-resolved N+1's
      // provider, picking the wrong bare/namespaced `forge_unit_result` name
      // against the SDK-side `allowedTools` → the worker called an unregistered
      // tool → silent timeout. Resetting here makes the compose read the LIVE
      // provider of N+1, never N's stale hint.
      s.pendingUnitType = null;
      s.pendingUnitModel = null;
      s.pendingUnitModelToken = null;
      s.resolvedDispatchAuthor = null;
      // G1/T01: same R1 hazard as the two resets above — `appliedUnitModel` is
      // only (re)set by the `session_start` hook post-dispatch, so a stale
      // value from unit N would otherwise survive into N+1's result authorship
      // if the hook never ran for N+1 (e.g. an early failure before dispatch).
      s.appliedUnitModel = null;
      s.appliedUnitModelToken = null;
      // S01 effort axis: same R1 hazard as the resets above —
      // `resolvedDispatchEffort` is only re-published by `resolveDispatchAuthor`
      // below, and `appliedUnitEffort` only by the `session_start` hook
      // post-dispatch, so stale values from unit N would otherwise survive
      // into N+1's journal (dispatched and result respectively).
      s.resolvedDispatchEffort = null;
      s.appliedUnitEffort = null;
      s.appliedUnitEffortToken = null;

      const snap = readSnapshot(deps.cwd);

      const knownTasks = Object.values(snap.plans).reduce((n, p) => n + p.tasks.length, 0);
      const unplanned = snap.roadmap.filter((sl) => !snap.plans[sl.id]?.planned).length;
      const maxIterations = Math.max(32, 4 * (knownTasks + unplanned) + 8);
      if (iterations >= maxIterations) {
        const ceilingEvent: ForgeLoopEvent = {
          ts: new Date().toISOString(),
          kind: "loop_ceiling_reached",
          unit: "",
          agent: "forge-loop",
          milestone: snap.milestoneId,
          status: "paused",
          summary: `Teto de iterações (${maxIterations}) atingido — loop pausado.`,
        };
        appendEvent(deps.cwd, ceilingEvent);
        notifyLoopPaused(notify, `Teto de iterações (${maxIterations}) atingido`);
        s.active = false;
        return { reason: "ceiling", message: `Teto de iterações (${maxIterations}) atingido.` };
      }
      iterations++;

      // R3: independent, additive guard — checked at the SAME point as the
      // ceiling, using the streak accumulated by the PREVIOUS iterations'
      // outcomes (updated below, after each dispatch's decision).
      if (noProgressStreak >= NO_PROGRESS_LIMIT) {
        const noProgressEvent: ForgeLoopEvent = {
          ts: new Date().toISOString(),
          kind: "loop_no_progress",
          unit: "",
          agent: "forge-loop",
          milestone: snap.milestoneId,
          status: "paused",
          summary: `${NO_PROGRESS_LIMIT} iterações consecutivas sem progresso real — loop pausado.`,
        };
        appendEvent(deps.cwd, noProgressEvent);
        notifyLoopPaused(notify, `${NO_PROGRESS_LIMIT} iterações consecutivas sem progresso real`);
        s.active = false;
        return {
          reason: "no_progress",
          message: `${NO_PROGRESS_LIMIT} iterações consecutivas sem progresso real.`,
        };
      }

      // R4 (M2/S02 review): `deriveNextUnit` throws on a GENUINE dependency
      // deadlock (real cycle / dep id absent from the roadmap). `runAuto`
      // (forge-command.ts) wraps this loop in a try/finally with NO catch, so an
      // uncaught throw here crashes `/forge auto` instead of the structured
      // LoopTerminal T06 introduced. Convert the deadlock into a structured
      // `blocked` pause — a human must resolve the cycle before resuming. (A
      // merely stuck/non-cyclic slice no longer throws: deriveNextUnit returns
      // null for it and reconcileCompletion degrades it below.)
      let unit: NextUnit | null;
      try {
        // Pass `milestoneSummaryWritten` so the derive matches the gate
        // `reconcileCompletion` uses: once the `<mid>-SUMMARY.md` is on disk,
        // `complete-milestone` is NOT re-emitted — the flip-lost-after-summary
        // kill-9 window falls through to null and is repaired by reconcile
        // (B5.2), never re-dispatched.
        unit = deriveNextUnit(snap.state, snap.roadmap, snap.plans, {
          milestoneSummaryWritten: snap.milestoneSummaryWritten,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const deadlockEvent: ForgeLoopEvent = {
          ts: new Date().toISOString(),
          kind: "loop_paused",
          unit: "",
          agent: "forge-loop",
          milestone: snap.milestoneId,
          status: "blocked",
          summary: message,
        };
        appendEvent(deps.cwd, deadlockEvent);
        notifyLoopPaused(notify, message);
        s.active = false;
        return { reason: "blocked", message };
      }

      // E2E-3: materialize the DEFERRED retry event now that we know what the
      // re-derive produced. Same unit re-dispatched → the honest `unit_retry`;
      // a different unit (or nothing) → `unit_readvanced` (on-disk progress moved
      // the loop forward, so an eager `unit_retry` would have lied).
      if (pendingRetry) {
        const advanced = unit === null || unitKey(unit) !== pendingRetry.key;
        const retryJournalEvent: ForgeLoopEvent = advanced
          ? {
              ...pendingRetry.retryEvent,
              kind: "unit_readvanced",
              summary: `Re-derivou e avançou (progresso em disco honrado) após retry de ${pendingRetry.key}.`,
            }
          : pendingRetry.retryEvent;
        appendEvent(deps.cwd, retryJournalEvent);
        pendingRetry = undefined;
      }

      // ── Nothing left to derive: reconcile completion, never exit silently (B5.2) ──
      if (unit === null) {
        const rec = reconcileCompletion(snap);
        if (rec) {
          // B5.1 — apply the recovered flip through the single writer, journal it.
          updateState(deps.cwd, rec.mutator);
          appendEvent(deps.cwd, rec.event);
          if (rec.kind === "slice") {
            // R1 (S03 review-fix): a SLICE-level kill-9 window was repaired (its
            // `S##-SUMMARY.md` was on disk but the flip was lost). The milestone is
            // NOT complete — do NOT exit with a false `complete`. Re-derive so any
            // slice that was blocked on this one now unblocks and gets dispatched.
            notify(`Slice ${rec.event.slice ?? ""} reconciliado na retomada — retomando o loop.`, "info");
            continue;
          }
          // R2 (S03 review-fix): a MILESTONE-level reconcile is the kill-9 tail of
          // `complete-milestone` (flip lost after the SUMMARY landed). The direct
          // dispatch path (below) runs `runMilestoneClose`; this reconcile path must
          // ALSO run it, or LEDGER.md/DECISIONS.md are never rebuilt and the cleanup
          // pref is never applied on this recovery path. Best-effort (never throws).
          runMilestoneClose(deps.cwd, snap.milestoneId, notify);
          notify("Milestone reconciliado e marcado como concluído.", "success");
          s.active = false;
          return { reason: "complete" };
        }

        // M2R-6: `deriveNextUnit` returning null (and no reconcile to apply) is
        // "complete" ONLY when every roadmap slice is GENUINELY done. If a slice
        // is still `running`/`pending`, this is a STUCK loop (e.g. plans written
        // to the wrong path so derive can't find the next unit) — not milestone
        // completion. Exiting 0 here would be a silent false success (seen live
        // in the A1 run). Pause instead, mirroring the deadlock/ceiling pause
        // shape so `/forge auto --print` surfaces a non-zero exit.
        const unfinished = snap.roadmap.find((sl) => !sliceComplete(sl, snap.state));
        if (unfinished) {
          const message = `Loop travado: slice ${unfinished.id} (${unfinished.status}) ainda não concluído, mas deriveNextUnit não encontrou próxima unidade — planos de task ausentes ou em path errado?`;
          const stuckEvent: ForgeLoopEvent = {
            ts: new Date().toISOString(),
            kind: "loop_stuck",
            unit: "",
            agent: "forge-loop",
            milestone: snap.milestoneId,
            slice: unfinished.id,
            status: "blocked",
            summary: message,
          };
          appendEvent(deps.cwd, stuckEvent);
          notifyLoopPaused(notify, message);
          s.active = false;
          return { reason: "blocked", message };
        }

        // M2R-3 (review-fix): a resume that finds the milestone ALREADY complete
        // in STATE (no reconcile mutator to apply above) is exactly the tail of
        // the crash window this loop's `complete-milestone: done` branch closes
        // below (STATE flip persisted, but the process died BEFORE
        // `runMilestoneClose` rebuilt LEDGER.md/DECISIONS.md/CHECKER/AUTO-MEMORY
        // or applied the cleanup pref). Without this call, that resume silently
        // reports `complete` with stale/empty projections and NEVER retries the
        // rebuild. `runMilestoneClose` is idempotent (state/merger.ts) and
        // best-effort (never throws), so calling it unconditionally here is safe
        // on every "genuinely nothing left to do" resume — a clean prior close
        // simply rebuilds byte-identical projections.
        runMilestoneClose(deps.cwd, snap.milestoneId, notify);
        notify("Nada a fazer — milestone concluído.", "success");
        s.active = false;
        return { reason: "complete" };
      }

      // ── M1R-4 resume guard: a unit already blocked/partial in STATE re-pauses ──
      // A unit whose DURABLE STATE reads `blocked` (or `partial` with its retry
      // budget already spent in a prior session) must NOT be re-dispatched from
      // scratch on a re-`/forge auto`: the in-memory `s.retryCount` is born zeroed
      // in a fresh process, so honoring the on-disk status is what keeps a human's
      // intervention decision from silently "renascendo" as a fresh retry. The loop
      // re-pauses immediately WITHOUT calling the driver. Resuming requires the
      // operator to clear the status in STATE (consistent with 1.0 semantics). This
      // never fires for `running`/`done`/`pending` — the normal dispatch flow.
      const persisted = persistedUnitStatus(snap.state, unit);
      if (persisted === "blocked" || persisted === "partial") {
        const guardKey = unitKey(unit);
        const repauseEvent: ForgeLoopEvent = {
          ts: new Date().toISOString(),
          kind: "loop_paused",
          unit: guardKey,
          agent: "forge-loop",
          milestone: snap.milestoneId,
          status: persisted,
          summary: `Unidade ${guardKey} já ${persisted} no STATE — retomada exige intervenção humana; loop re-pausado sem re-dispatch.`,
          slice: unitSlice(unit),
        };
        if (unit.type === "execute-task") repauseEvent.task = unit.task;
        appendEvent(deps.cwd, repauseEvent);
        notifyLoopPaused(
          notify,
          `Unidade ${guardKey} já ${persisted} no STATE — intervenção humana necessária antes de retomar`,
        );
        s.active = false;
        // A durable `blocked` is a hard block; a durable `partial` is a softer
        // pause (retry budget already spent). Both need a human, but the exit
        // code the caller derives distinguishes them.
        return {
          reason: persisted === "blocked" ? "blocked" : "paused",
          message: `Unidade ${guardKey} já ${persisted} no STATE — retomada exige intervenção humana.`,
        };
      }

      s.currentUnit = unit;
      s.onUnitChange?.(unit);
      const key = unitKey(unit);
      const reviewAttempts = s.retryCount.get(key) ?? 0;

      // S07 (T02/T04): best-effort project-memory injection. A single store
      // read (`loadRankedMemory`) feeds BOTH the composed prompt section and
      // the advisory footprint's fact count below, avoiding a double read.
      // A throw (unreadable/corrupt store) never blocks dispatch — swallow
      // to an empty selection, same posture as `runReviewGate`/`runVerifyGate`.
      let memoryFactCount = 0;
      let projectMemory = "";
      try {
        const { selected } = loadRankedMemory(deps.cwd, {});
        memoryFactCount = selected.length;
        projectMemory = renderProjectMemoryBlock(selected);
      } catch {
        memoryFactCount = 0;
        projectMemory = "";
      }

      // Resolve the dispatch author BEFORE composing the worker prompt. The
      // same value is journaled below, so `executed_by` can copy the header
      // instead of guessing from the subprocess's self-perception.
      const nowMs = Date.now();
      const resolved = resolveDispatchAuthor(s, unit, nowMs);
      // S01 effort axis: capture the effort published by the SAME resolve call
      // — journaled on the dispatched event below (resolved value, D-S01-3)
      // and reused as the result's `effort_reason` audit trail. (The `as`
      // re-widens past the per-iteration reset's `null` narrowing — the write
      // happened inside `resolveDispatchAuthor`, invisible to TS flow analysis.)
      const resolvedEffort = s.resolvedDispatchEffort as ForgeAutoSession["resolvedDispatchEffort"];
      // S09/T03: mirror of `resolvedEffort` above — reads the rank audit
      // trail `resolveDispatchAuthor` published on the container (the SAME
      // resolve call), consumed synchronously by `dispatchedEvent` below.
      const resolvedRank = s.resolvedDispatchAuthor as ForgeAutoSession["resolvedDispatchAuthor"];
      if (resolved.violation === "reviewer_not_author") {
        notifyReviewerNotAuthorViolation(notify, key);
      }
      // Degenerate journal fidelity: when no per-unit model resolves, the
      // worker still runs on the LIVE session model. This is informational
      // only; pendingUnitModel remains null and session_start cannot re-apply it.
      const dispatchAuthor = resolved.model
        ? resolved
        : (() => {
            const live = effectiveModelFor(s, unit);
            const ref = live.model ?? live.provider;
            return {
              model: live.model,
              provider: live.provider,
              family: ref ? familyOf(ref) : null,
              ...(resolved.violation ? { violation: resolved.violation } : {}),
            };
          })();
      const dispatchAuthorRef = dispatchAuthor.model ?? dispatchAuthor.provider ?? undefined;
      const prompt = composePrompt(
        unit,
        composeInfoFor(snap, unit, s, dispatchAuthorRef),
        failureContext,
        projectMemory,
      );

      // S07 (T04): STRICTLY advisory memory footprint — mirrors runReviewGate/
      // runVerifyGate's posture. Gated on the FIRST dispatch of the unit only
      // (C3/S05 lesson: an ungated hook would re-emit on every retry). The
      // native loop ONLY injects the pre-ranked memory computed above; fact
      // EXTRACTION from unit summaries happens out-of-process, in the
      // orchestrator (the `forge-memory` agent, light tier) — this event's
      // summary makes that split explicit in the journal. Best-effort:
      // never touches `result`/`decision`, never blocks the dispatch.
      if (reviewAttempts === 0) {
        try {
          const memoryEvent: ForgeLoopEvent = {
            ts: new Date().toISOString(),
            kind: "memory",
            unit: key,
            agent: "forge-loop",
            milestone: snap.milestoneId,
            status: memoryFactCount > 0 ? "injected" : "skipped",
            summary:
              memoryFactCount > 0
                ? `memory: ${memoryFactCount} fact(s) injetados no prompt — extração de facts via orquestrador (agente forge-memory, tier leve), o footprint nativo só injeta.`
                : `memory: nenhum fact no store — nada injetado. Extração de facts via orquestrador (agente forge-memory, tier leve), o footprint nativo só injeta.`,
            slice: unitSlice(unit),
          };
          if (unit.type === "execute-task") memoryEvent.task = unit.task;
          appendEvent(deps.cwd, memoryEvent);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          notify(`Memory advisory ignorado (best-effort): ${message}`, "info");
        }
      }

      // S05 (D-S05-1/D-S05-3): STRICTLY advisory native-review footprint, run
      // BEFORE the completion unit is dispatched. LATERAL to the flow — it never
      // touches `result`/`decision`, never mutates STATE/budget, and is
      // self-contained best-effort: the review NEVER blocks/re-dispatches the
      // loop (W3). It only wires the review MACHINE (idempotence/posture/journal
      // parity); the challenger/advocate dialectic orchestration is M3.
      // C3 (S05): gate the hooks on the FIRST dispatch of the unit only. The
      // retry path (`decision.action==="retry"` → `continue`) re-derives the
      // SAME unit without mutating STATE, so an ungated hook would re-emit the
      // review/review_triage event AND re-`notify()` on every attempt. The
      // in-process retry budget (`s.retryCount`) is the authoritative
      // first-dispatch signal: absent/0 on the initial pass, ≥1 on every retry.
      // (`reviewAttempts` computed above, reused here.)
      if (reviewAttempts === 0) {
        if (unit.type === "execute-task") {
          // S06 (D-S06-1): the ONE ENFORCING guard — a present-but-legacy/malformed
          // T##-PLAN.md blocks the unit WITHOUT dispatch (an IO error never blocks).
          // Mirrors the M1R-4 resume guard: journal `must_haves_gate:blocked`, persist
          // `blocked` via the single writer, return `{reason:"blocked"}` before the driver.
          const block = enforceExecuteTaskPlan(deps.cwd, snap.milestoneId, unit.slice, unit.task);
          if (block) {
            const gateEvent: ForgeLoopEvent = {
              ts: new Date().toISOString(),
              kind: "must_haves_gate",
              unit: key,
              agent: "forge-loop",
              milestone: snap.milestoneId,
              status: "blocked",
              summary: block.message,
              slice: unitSlice(unit),
              task: unit.task,
            };
            appendEvent(deps.cwd, gateEvent);
            updateState(
              deps.cwd,
              applyUnitResult(snap, unit, { status: "blocked", reason: block.message }),
            );
            notifyLoopPaused(notify, block.message);
            s.active = false;
            return { reason: "blocked", message: block.message };
          }
        } else if (unit.type === "complete-slice") {
          await runReviewGate(
            s,
            deps,
            snap.milestoneId,
            unit.slice,
            snap.titles.slice[unit.slice] ?? unit.slice,
            unit,
            notify,
          );
          // S06 (D-S06-4/5): STRICTLY advisory verify + file-audit, run AFTER the
          // review gate and BEFORE dispatch. Best-effort, never blocks/mutates the flow.
          runVerifyGate(deps.cwd, snap.milestoneId, unit.slice, notify);
        } else if (unit.type === "complete-milestone") {
          runReviewTriage(deps.cwd, snap.milestoneId, notify);
        }
      }

      // Journal the dispatch BEFORE handing off to the driver. The author was
      // resolved once above and is the exact value already exposed in the
      // prompt header.
      const dispatchStartedAt = Date.now();
      notifySafely(
        notify,
        formatUnitBoundary(unit, dispatchAuthor.model ?? dispatchAuthor.provider ?? "unknown"),
        "info",
      );
      appendEvent(
        deps.cwd,
        stampUnitSha(
          deps.cwd,
          dispatchedEvent(snap, unit, key, dispatchAuthor, resolvedEffort, resolvedRank),
        ),
      );

      const outcome = await deps.driver.dispatch(unit, prompt);
      let result = outcomeToResult(outcome);

      // G1/T01 Parte B: the RESULT event's authorship prefers the model the
      // `session_start` hook DE FATO applied (`s.appliedUnitModel`, published
      // post-dispatch on the fresh `pi` — the hook is the only writer that
      // knows whether `setModel` succeeded), falling back to the pre-dispatch
      // `resolved` (Parte A) when nothing was applied (no per-unit override,
      // or `setModel` failed and the hook nulled it out). Read now — AFTER
      // `await driver.dispatch` settles, BEFORE any reset clears it (B3).
      const appliedModel =
        s.appliedUnitModelToken === s.currentRendezvousToken ? s.appliedUnitModel : null;
      const resultAuthor = appliedModel ? authorFromRef(appliedModel) : dispatchAuthor;
      // S01 effort axis (D-S01-3, same G1 discipline as `appliedModel` above):
      // the RESULT/timeout event's effort is the one the hook DE FATO applied
      // — token-gated, so a stale application from an older dispatch can never
      // claim this unit's result. When nothing was applied (no config, stale
      // token, or `setThinkingLevel` failed) the result carries NO effort
      // fields — unlike authorship there is no fallback to the resolved value.
      // (The `as` re-widens to the field's declared type: the per-iteration
      // resets above narrow `s.appliedUnitEffort` to `null` in TS's view, but
      // the hook re-writes it through the module singleton during the awaited
      // dispatch — invisible to control-flow analysis.)
      const appliedEffort =
        s.appliedUnitEffortToken === s.currentRendezvousToken
          ? (s.appliedUnitEffort as ForgeAutoSession["appliedUnitEffort"])
          : null;

      // M1R-2: a `plan-slice: done` only counts if it left behind a
      // parseable, task-bearing PLAN — otherwise `deriveNextUnit` keeps
      // returning the SAME plan-slice next iteration (replan infinito) or a
      // 0-task PLAN never flips the slice (false milestone-complete, F4).
      // Downgrade to a synthetic failure that consumes a normal retry (see
      // T-PLAN § Nota de reconciliação: `partial`, not `blocked`, so the
      // taxonomy retries once before pausing, per the brief's acceptance
      // criteria for regressions (a)/(b)).
      if (unit.type === "plan-slice" && result.status === "done") {
        const after = readSnapshot(deps.cwd);
        const info = after.plans[unit.slice];
        const ok = !!info && info.planned && info.tasks.length >= 1;
        if (!ok) {
          result = {
            status: "partial",
            summary: result.summary ?? "",
            reason: "plan-slice done sem PLAN parseável/com tasks",
          };
        } else {
          // S04 (D-S04-1): the plan passed the M1R-2 guard — run the STRICTLY
          // advisory gate hook IN-PROCESS. LATERAL to the flow: it never touches
          // `result`/`decision`, is best-effort (self-contained try/catch), and a
          // `fail > 0` scorecard leaves the loop's next action byte-identical.
          runAdvisoryGates(deps.cwd, snap.milestoneId, unit.slice, notify);
        }
      }

      // D-S03-1 guard (analogous to the plan-slice M1R-2 guard above): a
      // completion unit only counts as `done` if it actually left its DURABLE
      // artifact — the `S##-SUMMARY.md` (complete-slice) or `<mid>-SUMMARY.md`
      // (complete-milestone). Without the SUMMARY, flipping the slice/milestone
      // would lose the record the completer owes (and `deriveNextUnit`, which
      // gates on SUMMARY existence, would re-emit the same completion unit next
      // iteration → replan loop). Downgrade to `partial` so the taxonomy retries
      // once then pauses — NEVER flip/complete without the SUMMARY.
      if (
        (unit.type === "complete-slice" || unit.type === "complete-milestone") &&
        result.status === "done"
      ) {
        const summaryPath = completionSummaryPath(deps.cwd, snap.milestoneId, unit);
        if (summaryPath && !existsSync(summaryPath)) {
          result = {
            status: "partial",
            summary: result.summary ?? "",
            reason:
              unit.type === "complete-slice"
                ? "complete-slice done sem S##-SUMMARY.md"
                : "complete-milestone done sem <mid>-SUMMARY.md",
          };
        }
      }

      notifySafely(
        notify,
        formatUnitBoundary(unit, "", Date.now() - dispatchStartedAt, result.status),
        "success",
      );

      const attempts = s.retryCount.get(key) ?? 0;
      // G1/T01: reuse `resultAuthor` computed above — the RESULT event's
      // authorship (applied model, falling back to resolved) — never
      // `resolved` directly, so the journal's result reflects what actually
      // ran. Guard preserved: fields stay absent (not `""`/`"null"`) when
      // nothing is known, since `resultAuthor` (either branch) already
      // carries that invariant.
      const decision = decideNextAction(result, attempts, {
        milestone: snap.milestoneId,
        unit: key,
        slice: unitSlice(unit),
        task: unit.type === "execute-task" ? unit.task : undefined,
        model: resultAuthor.model ?? undefined,
        provider: resultAuthor.provider ?? undefined,
        family: resultAuthor.family ?? undefined,
        // S01 effort axis: absent entirely when nothing was applied (D-S01-3)
        // — `makeEvent` copies under `if`, so no `effort*` key reaches the
        // journal on the no-config/stale/failed paths. `effortReason` comes
        // from the RESOLUTION (the applied level's audit trail lives there;
        // `appliedEffort` only knows the effective level and the clamp).
        ...(appliedEffort
          ? {
              effort: appliedEffort.level,
              effortReason: resolvedEffort?.reason,
              effortClamped: appliedEffort.clamped ?? undefined,
            }
          : {}),
      });

      // R3 (M2/S02 review): for continue/retry, journal the decision events
      // up-front as before. For a PAUSE, DEFER journaling until AFTER STATE is
      // persisted (see the pause branch below) — otherwise a crash in the window
      // between the pause journal and the STATE write leaves journal=paused /
      // STATE=pending, and resume (which reads STATE) re-dispatches the paused
      // unit from a zeroed budget. Persisting first makes the window safe: a
      // crash before the persist leaves STATE with no terminal AND no pause
      // journal (clean re-derive), and a crash after leaves both consistent.
      if (decision.action !== "pause") {
        for (const ev of decision.events) appendEvent(deps.cwd, stampUnitSha(deps.cwd, ev));
      }

      // R3: update the no-progress streak. Genuine forward progress is a
      // `continue` for a unit KEY never seen completing before (tracked
      // in-process — immune to on-disk padding/duplication). Anything else
      // (a repeat completion, a retry, a pause) does not reset the streak.
      if (decision.action === "continue" && !completedUnitKeys.has(key)) {
        completedUnitKeys.add(key);
        noProgressStreak = 0;
      } else {
        noProgressStreak++;
      }

      if (decision.action === "continue") {
        // Standalone `/forge next` reviews the successful task after its result
        // is journaled (authorship is therefore available to the independence
        // resolver), but before the loop returns to the caller. Auto mode keeps
        // the per-slice gate above and never emits per-task reviews.
        if (opts.once && unit.type === "execute-task" && result.status === "done") {
          await runTaskReviewGate(s, deps, snap.milestoneId, unit, notify);
        }
        // B5.1 — ONE updateState with the single atomic mutator. Never two.
        updateState(deps.cwd, applyUnitResult(snap, unit, result));
        s.retryCount.delete(key);
        failureContext = undefined;
        // D-S03-2: a `complete-milestone: done` is the milestone's terminal step.
        // The STATE flip is now persisted (above); run the in-process close —
        // rebuild LEDGER.md/DECISIONS.md + apply the cleanup pref — EXACTLY ONCE,
        // best-effort (it never throws), then finish. `deriveNextUnit` only emits
        // complete-milestone as the last unit, so the loop is genuinely done.
        if (unit.type === "complete-milestone") {
          runMilestoneClose(deps.cwd, snap.milestoneId, notify);
          notify("Milestone concluído — projeções reconstruídas.", "success");
          s.active = false;
          return { reason: "complete" };
        }
        if (opts.once) {
          // `/forge next`: one unit reached a terminal SUCCESS — a clean stop.
          s.active = false;
          return { reason: "complete" };
        }
        continue;
      }

      if (decision.action === "retry") {
        // The unit is re-dispatched with the failure context threaded in. `once`
        // still runs "one unit" — the retry is part of that same unit. E2E-3: the
        // `unit_retry` event is DEFERRED (held here) and journaled only after the
        // NEXT derive, where the loop knows whether it re-dispatched the same unit
        // (→ `unit_retry`) or on-disk progress advanced it (→ `unit_readvanced`).
        s.retryCount.set(key, attempts + 1);
        failureContext = decision.failureContext;
        if (decision.retryEvent) pendingRetry = { key, retryEvent: decision.retryEvent };
        continue;
      }

      // pause — blocked unit, or retry exhausted. Needs a human.
      // M1R-4: persist the terminal status into STATE via the SINGLE writer so a
      // re-`/forge auto` (and `/forge status`, which reads STATE) sees the pause
      // instead of a pending unit that would re-dispatch from a zeroed budget.
      // `applyUnitResult` already returns the correct non-done mutator; timeout is
      // folded to `partial` (a valid `UnitStatus`; `timeout` is not one).
      const persistResult =
        result.status === "timeout" ? { ...result, status: "partial" as const } : result;
      // R3: persist the terminal status into STATE BEFORE journaling the pause
      // events (deferred at the top of the loop). Now the durable STATE carries
      // the blocked/partial status the moment the journal records the pause, so a
      // resume's T05 guard (persistedUnitStatus) re-pauses instead of
      // re-dispatching. A crash between this write and the journal below is
      // harmless: STATE already reflects the terminal.
      updateState(deps.cwd, applyUnitResult(snap, unit, persistResult));
      for (const ev of decision.events) appendEvent(deps.cwd, stampUnitSha(deps.cwd, ev));
      const reason =
        result.status === "blocked"
          ? result.reason ?? "Unidade bloqueada — intervenção humana necessária."
          : "Retry esgotado — loop pausado.";
      notifyLoopPaused(notify, reason);
      s.active = false;
      // A driver-reported `blocked` is a hard block; anything else here is a
      // retry-exhausted pause. The `return` still runs the cleanup `finally`.
      return {
        reason: result.status === "blocked" ? "blocked" : "paused",
        message: reason,
      };
    }
  } finally {
    s.currentUnit = null;
    s.pendingUnitType = null;
    s.pendingUnitModel = null;
    s.pendingUnitModelToken = null;
    s.resolvedDispatchAuthor = null;
    s.appliedUnitModel = null;
    s.appliedUnitModelToken = null;
    // S01 effort axis: mirror of the model-field teardown above — no
    // per-dispatch effort state survives the loop (matters for direct
    // `loopRunner` callers/tests that never reach `runAuto`'s `reset()`).
    s.pendingUnitEffort = null;
    s.pendingUnitEffortToken = null;
    s.resolvedDispatchEffort = null;
    s.appliedUnitEffort = null;
    s.appliedUnitEffortToken = null;
    // T02 queue-widget hookup: publish "loop idle" so the footer status is
    // cleared on finish/pause/throw — no orphaned status survives the loop.
    s.onUnitChange?.(null);
  }
  // The while only ever exits via a `return` above; this is the fallback for a
  // loop entered with `s.active` already false (nothing dispatched) — a no-op
  // completion.
  return { reason: "complete" };
}
