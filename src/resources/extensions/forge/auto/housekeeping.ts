/**
 * `auto/housekeeping.ts` — the deterministic, 100% PURE brain of the S03 loop.
 *
 * It never touches the filesystem and never imports `@gsd/*`: every function
 * here returns a pure `StateDoc → StateDoc` mutator and/or a list of journal
 * events for the loop (T04) to apply via the S02 store's single-writer
 * `updateState` / `appendEvent`. That purity is what makes the kill-9
 * atomicity property (B5) and the failure taxonomy exhaustively unit-testable
 * without the harness.
 *
 * ── D-S03-1 — the flip model migrates to the completion units ────────────────
 * S03 moves the STATE flip point off the WORK units and onto the COMPLETION
 * units. `applyUnitResult` now:
 *   - execute-task done → marks ONLY the task done (the slice stays `running`);
 *   - complete-slice done → flips the slice to done (ONE mutator, milestone
 *     untouched);
 *   - complete-milestone done → marks the milestone complete (ONE mutator).
 * `deriveNextUnit` (T01) emits `complete-slice` once a slice's tasks are all done
 * and its `S##-SUMMARY.md` is absent, and `complete-milestone` once every slice is
 * done and the `<mid>-SUMMARY.md` is absent — so completion is an explicit,
 * dispatchable step, never a silent side effect of the last task.
 *
 * ── B5 — kill-9 atomicity (two defenses, both mandatory) ────────────────────
 *  1. Every `applyUnitResult` consequence is ONE pure `StateDoc → StateDoc`
 *     mutator applied through ONE `updateState` (one atomic temp+rename). A
 *     `kill -9` therefore leaves either the pre-state or the fully-flipped
 *     post-state — never a corrupt intermediate. Each completion flip is a
 *     single upsert, so this holds trivially for the migrated model.
 *  2. `reconcileCompletion` is the resume-time safety net for the ONE window the
 *     dispatch cannot re-derive out of: the `<mid>-SUMMARY.md` is on disk (so
 *     `complete-milestone` is no longer emitted) yet the milestone flip was lost
 *     to a crash. It returns the flip mutator plus a `milestone_complete` journal
 *     event — the loop never exits silently. When the SUMMARY is NOT yet written,
 *     `deriveNextUnit` re-emits `complete-milestone` and reconcile is never
 *     reached (it only acts when derive is null).
 */

import {
  deriveNextUnit,
  unitSlice,
  type StateDoc,
  type StateUnit,
  type ForgeEvent,
  type NextUnit,
} from "../state/index.js";
import type { ForgeSnapshot } from "./snapshot.js";
import { unitKeyOf } from "../worker/unit-key.js";

// ── Loop event taxonomy ──────────────────────────────────────────────────────
//
// `ForgeEvent` (S02) is a closed interface with no event-kind discriminator, so
// — per T03-PLAN step 1 — we EXTEND it here (never editing `state/`) with a
// `kind` tag. A `ForgeLoopEvent` is assignable to `ForgeEvent`, so it flows
// straight into the store's `appendEvent`.

export type ForgeEventKind =
  | "unit_dispatched"
  | "unit_result"
  | "unit_timeout"
  | "unit_retry"
  // Operator clearing marker appended by `/forge unblock` — a trailing
  // unblock beats an earlier journaled pause in `detectUnreconciledPauses`
  // (the durable half of the M1R-4 guard's "operator clears" contract).
  | "unit_unblocked"
  | "milestone_complete"
  // R1 (S03 review-fix) — resume-time repair of a SLICE-level kill-9 window: the
  // `complete-slice` completer wrote `S##-SUMMARY.md` but its STATE flip was lost
  // before the loop's `updateState`. Reconcile/replay flipped that slice to `done`
  // WITHOUT re-dispatching. Distinct from `milestone_complete` (the slice, not the
  // milestone, was repaired — the loop must keep running, not report complete).
  | "slice_complete"
  | "loop_paused"
  | "stale_rendezvous_delivery"
  | "stale_rendezvous_cancel"
  | "loop_ceiling_reached"
  | "loop_no_progress"
  // M2R-6 (review-fix) — `deriveNextUnit` returned null with a roadmap slice
  // still `running`/`pending` (not genuinely complete). Distinct from
  // `loop_paused` (deadlock/blocked-unit re-pause): this marks a derive that
  // came up EMPTY while work visibly remains — e.g. task plans written to the
  // wrong path — so the loop pauses instead of falsely reporting `complete`.
  | "loop_stuck"
  // M1R-3 — audit marker for a resume-time replay: a journaled `unit_result:done`
  // whose STATE flip was lost to a kill-9 has been re-applied (never re-dispatched).
  | "unit_result_replayed"
  // E2E-3 (T05) — journal-fidelity marker: after a retry, the loop re-derived and
  // ADVANCED to a DIFFERENT unit (on-disk progress honored) instead of re-dispatching
  // the same one. Emitted by the loop AFTER the post-retry derive, in place of the
  // `unit_retry` that would otherwise lie "Re-dispatch da mesma unidade".
  | "unit_readvanced"
  // S04 (T05) — ADDITIVE advisory-gate markers, journaled by the loop's
  // best-effort hook AFTER a plan-slice: done that passed the M1R-2 guard.
  // `plan_check` carries the plan-checker's pass/warn/fail counts; `plan_gate`
  // records the native gate outcome (always `skipped` in the deterministic loop
  // — the interactive handshake lives in the orchestrator/M3, per D-S04-6).
  // Both are STRICTLY advisory (D-S04-1): readers ignore unknown kinds, and the
  // loop never branches on them — they never block/re-dispatch/downgrade.
  | "plan_check"
  | "plan_gate"
  // S05 (T05) — ADDITIVE native-review markers, journaled by the loop's
  // best-effort review hook BEFORE a completion unit is dispatched. `review`
  // records the per-slice review posture pre-complete-slice (`present` when the
  // idempotent `S##-REVIEW.md` already exists, `skipped` when absent — auto
  // posture is `ask_in_auto: defer`, the dialectic orchestration is M3, per
  // D-S05-1); `review_triage` records the milestone-final pending-item collect
  // pre-complete-milestone (`deferred` with a count, or `none`). BOTH are
  // STRICTLY advisory (D-S05-3): the review NEVER blocks/mutates the loop, and
  // readers ignore unknown kinds — parity journaling only.
  | "review"
  | "review_triage"
  // S06 (T06) — ADDITIVE anti-hallucination markers. `must_haves_gate` is the ONE
  // ENFORCING kind: journaled `blocked` by the loop's pre-dispatch guard when an
  // `execute-task`'s `T##-PLAN.md` is present-but-legacy/malformed (D-S06-1) — the
  // only new block path S06 introduces. `verify`/`file_audit`/`evidence` are STRICTLY
  // advisory (D-S06-4/5/6): `verify` carries the native slice-verification counts and
  // `file_audit` the expected-vs-changed missing/unexpected sets (both journaled
  // best-effort by `runVerifyGate` pre-complete-slice); `evidence` is the per-unit
  // `tool_execution_end` trail appended by the `runAuto` subscription. All three
  // never block/mutate the loop, and readers ignore unknown kinds — parity only.
  | "must_haves_gate"
  | "verify"
  | "file_audit"
  | "evidence"
  // S07 (T04) — ADDITIVE advisory memory-footprint marker, journaled at the
  // pre-dispatch site (first attempt only, gated same as `review`). `status`
  // is `injected` (with a fact count in the summary) when the ranked
  // project-memory store yielded facts for the composed prompt, else
  // `skipped`. STRICTLY advisory (parity with `review`/`verify`): the loop
  // NEVER blocks/mutates `result`/`decision` on this event — the native
  // footprint only INJECTS pre-ranked memory; fact EXTRACTION from unit
  // summaries happens out-of-process, in the orchestrator (the
  // `forge-memory` agent, light tier).
  | "memory"
  // M-20260711135806-wiring-multi-llm / S02 / T02 — the call-site's dedicated
  // signal for a `resolveModelForRole` BLOCKED-by-violation resolve
  // (`violation: "reviewer_not_author"`, T01's marker). Journaled by
  // `driver.ts`'s `journalReviewerNotAuthorViolation` (best-effort, mirrors
  // `stale_rendezvous_cancel`) so the violation is never swallowed as an
  // ordinary "no per-unit model" (`pendingUnitModel = null` → session runs on
  // baseline silently). Distinct from the generic `on_missing_pool: "block"`
  // BLOCKED (no `violation` marker, never journals this kind) and from a
  // normal degrade (`unit_dispatched` with no `model`/`provider`/`family`).
  // INERT today: no production unit-type resolves as reviewer/advocate
  // (`roleForUnit` has no entry for either — S04 decisão B), so this kind
  // never appears on the real dispatch path yet.
  | "reviewer_not_author_violation"
  // S06 (T02) — ADDITIVE advisory suite-gate marker. `runMilestoneClose`
  // (`auto/complete.ts`, D-S03-2) parses the completer's flat `suite_*`
  // frontmatter off `<mid>-SUMMARY.md` (contract 1, S06-PLAN) and projects it
  // here (contract 2) BEFORE the milestone-cleanup step — cleanup can
  // move/delete the milestone dir the SUMMARY lives in, so this must run
  // first (D-S06v2-1). `status` mirrors `suite_status` (green/red/error/
  // timeout) or is `skipped` when the completer reported no suite result at
  // all. STRICTLY advisory (same regime as `plan_check`/`review`/`verify`,
  // D-S04-1): the loop NEVER branches on it, readers ignore unknown kinds —
  // parity journaling only.
  | "suite_result";

export interface ForgeLoopEvent extends ForgeEvent {
  kind: ForgeEventKind;
  /**
   * M2R-5 (review-fix) — discriminator for a `unit_result` (or folded
   * `unit_timeout`) event with a non-done status: does this terminal mean the
   * loop is about to RETRY the same unit (still has budget), or is it a genuine
   * PAUSE for a human? Without this, `detectUnreconciledPauses` cannot tell a
   * kill-9 during a legitimate retry from a kill-9 during a real pause — both
   * journal an identical-shaped `unit_result:partial` event. Set ONLY at the
   * loop-decision point (`decideNextAction`) where the choice is actually made;
   * absent on `done` events (never ambiguous) and on any journal line written
   * before this fix. `detectUnreconciledPauses` treats a MISSING `decision` on
   * a non-done terminal as `"pause"` — the conservative, human-safety default
   * that preserves pre-fix behavior for old journals.
   */
  decision?: "retry" | "pause";
}

/** Normalized terminal status for a dispatched unit (timeout folded in). */
export type UnitResultStatus = "done" | "partial" | "blocked" | "timeout";

/** The minimal result shape the taxonomy needs (superset of `UnitResultPayload`). */
export interface UnitResult {
  status: UnitResultStatus;
  summary?: string;
  reason?: string;
}

/** At most this many retries per unit per run (B4 policy: whole-unit, once). */
export const MAX_RETRIES = 1;

// ── unit upsert helpers (pure) ───────────────────────────────────────────────

/** Return a fresh StateDoc with `unit` upserted into `units` (never mutates). */
function upsertUnit(state: StateDoc, unit: StateUnit): StateDoc {
  const units = state.units ? [...state.units] : [];
  // Task entries are slice-qualified (task ids collide across slices); a
  // legacy unqualified task entry with the same id is UPGRADED in place by the
  // qualified write rather than duplicated.
  const idx = units.findIndex(
    (u) =>
      u.id === unit.id &&
      u.type === unit.type &&
      (unit.type !== "task" || u.slice === unit.slice || u.slice === undefined),
  );
  if (idx >= 0) {
    units[idx] = unit;
  } else {
    units.push(unit);
  }
  return { ...state, units };
}

/** Mark the milestone complete: set `phase: "complete"` + a milestone unit. */
function markMilestoneComplete(state: StateDoc, milestoneId: string): StateDoc {
  const flipped = upsertUnit(state, { id: milestoneId, type: "milestone", status: "done" });
  return { ...flipped, phase: "complete" };
}

/**
 * Is the milestone already recorded as complete? True when EITHER the derived
 * `phase` reads "complete" OR a milestone unit is done — belt and suspenders so
 * the reconciliation net never fires on an already-complete STATE.
 */
export function milestoneComplete(state: StateDoc, milestoneId: string): boolean {
  if (state.phase === "complete") return true;
  return state.units?.some(
    (u) => u.type === "milestone" && u.status === "done" && (milestoneId === "" || u.id === milestoneId),
  ) ?? false;
}

/**
 * M2R-4 (review-fix): the SINGLE source of truth for "what does STATE durably
 * say about this unit RIGHT NOW", shared by the loop's M1R-4 resume guard
 * (`auto/loop.ts`) and this module's replay-detector idempotency check
 * (`isPauseReflected` below). Before this fix the loop kept its OWN copy that
 * only ever looked at a `task`-type unit for `execute-task` and fell back to a
 * `slice`-type unit keyed by `unitSlice(unit)` for everything else — which
 * silently resolved to `""` (no match) for `complete-milestone`, since
 * `unitSlice` returns `""` for milestone-level units. One shared function keyed
 * on the unit's OWN level (task / slice / milestone) closes that gap for all
 * three completion-unit types, not just `execute-task`.
 */
export function persistedUnitStatus(state: StateDoc, unit: NextUnit): string | undefined {
  const units = state.units ?? [];
  if (unit.type === "execute-task") {
    // STRICT slice match: an unqualified legacy task entry cannot be
    // attributed to any specific slice, and treating it as a match is the
    // exact cross-slice contamination this fix removes.
    return units.find(
      (u) => u.type === "task" && u.id === unit.task && u.slice === unit.slice,
    )?.status;
  }
  if (unit.type === "complete-milestone") {
    return units.find((u) => u.type === "milestone" && u.id === unit.milestone)?.status;
  }
  return units.find((u) => u.type === "slice" && u.id === unitSlice(unit))?.status;
}

// ── B5.1 — the single atomic mutator (D-S03-1 flip model) ────────────────────

/**
 * The single, atomic consequence of a unit result (B5.1).
 *
 * Returns ONE pure `StateDoc → StateDoc` mutator — NEVER two — that the loop
 * applies through exactly ONE `updateState`. Under the D-S03-1 model the STATE
 * flip lives on the COMPLETION units, not on the work units:
 *
 *  - plan-slice `done`: records the slice unit as `running` (in-progress). The
 *    next iteration's `readSnapshot` discovers the freshly-written tasks.
 *  - execute-task `done`/`partial`/`blocked`: records ONLY the task's status.
 *    Even the LAST task of a slice no longer flips the slice — the slice stays
 *    `running` until `complete-slice` runs (D-S03-1). No milestone side effect.
 *  - complete-slice `done`: flips the slice to done in a single upsert (the
 *    milestone is never touched here — only `complete-milestone` closes it).
 *  - complete-milestone `done`: marks the milestone complete (`phase: complete`
 *    + a done milestone unit) in a single mutator.
 *  - any completion `partial`/`blocked`: M2R-4 (review-fix) — records the
 *    pause on the unit's OWN level (a `slice`-type unit for plan-slice/
 *    complete-slice, a `milestone`-type unit for complete-milestone) instead of
 *    the prior identity no-op. Before this fix a `blocked`/`partial` on any
 *    non-`execute-task` unit type evaporated on restart: the resume guard
 *    (`persistedUnitStatus`) is inert without a durable marker, the in-memory
 *    retry budget is reborn zeroed in a fresh process, and the human signal is
 *    lost. Every unit type now gets the same durable-pause treatment.
 */
export function applyUnitResult(
  _snapshot: ForgeSnapshot,
  unit: NextUnit,
  result: UnitResult,
): (state: StateDoc) => StateDoc {
  if (unit.type === "plan-slice") {
    // A successful plan advances the slice to in-progress; a pause (blocked/
    // partial) durably records the pause on the same slice unit (M2R-4) so the
    // resume guard re-pauses instead of re-planning from a zeroed budget.
    const status: StateUnit["status"] =
      result.status === "done" ? "running" : (result.status as StateUnit["status"]);
    return (state) => upsertUnit(state, { id: unit.slice, type: "slice", status });
  }

  if (unit.type === "execute-task") {
    // D-S03-1: a task result records ONLY the task status — never the slice or
    // milestone. The last task of a slice leaves the slice `running`; the flip is
    // now the exclusive job of the `complete-slice` unit.
    const taskStatus: StateUnit["status"] =
      result.status === "done" ? "done" : (result.status as StateUnit["status"]);
    return (state) =>
      upsertUnit(state, { id: unit.task, type: "task", status: taskStatus, slice: unit.slice });
  }

  if (unit.type === "complete-slice") {
    // The slice flip migrated here (D-S03-1). A pause (blocked/partial) durably
    // records the pause on the same slice unit (M2R-4) — the flip only happens
    // on `done`.
    const status: StateUnit["status"] =
      result.status === "done" ? "done" : (result.status as StateUnit["status"]);
    return (state) => upsertUnit(state, { id: unit.slice, type: "slice", status });
  }

  if (unit.type === "complete-milestone") {
    // The milestone close migrated here (D-S03-1) — the ONLY unit that marks the
    // milestone complete. A pause (blocked/partial) durably records the pause on
    // a `milestone`-type unit (M2R-4) instead of the prior identity no-op —
    // `milestoneComplete` only reads `status === "done"`, so this never
    // false-flips the milestone.
    if (result.status !== "done") {
      return (state) =>
        upsertUnit(state, { id: unit.milestone, type: "milestone", status: result.status as StateUnit["status"] });
    }
    return (state) => markMilestoneComplete(state, unit.milestone);
  }

  // Exhaustive over `NextUnit`; identity keeps the return total.
  return (state) => state;
}

// ── B5.2 — resume-time reconciliation ────────────────────────────────────────

/** The mutator + event a reconciliation produces, or `null` when none is needed. */
export interface Reconciliation {
  mutator: (state: StateDoc) => StateDoc;
  event: ForgeLoopEvent;
  /**
   * R1 (S03 review-fix): WHICH level this reconciliation repaired.
   *  - `"milestone"`: the milestone flip was lost — the loop applies the mutator,
   *    runs the milestone close, and finishes (`reason: complete`).
   *  - `"slice"`: a slice-level kill-9 window was repaired (its `S##-SUMMARY.md`
   *    is on disk but the flip was lost). The milestone is NOT complete — the loop
   *    applies the mutator and KEEPS RUNNING so downstream slices unblock.
   */
  kind: "slice" | "milestone";
}

/**
 * Resume-time safety net (B5.2). Detects the forbidden intermediate — all work
 * derives to `null` yet the milestone is not marked complete — and returns the
 * deterministic flip mutator plus a `milestone_complete` journal event. Returns
 * `null` when the state is consistent (work remains, or already complete), so
 * the loop only ever repairs a genuinely stuck-complete milestone.
 *
 * D-S03-1 invariant: with the flip migrated onto the completion units,
 * `deriveNextUnit` re-emits `complete-slice`/`complete-milestone` whenever a
 * slice/milestone is done-but-unflipped AND its SUMMARY is still absent — so in
 * that (common) case `next !== null` and this net stays dormant. It fires ONLY
 * for the one window dispatch cannot re-derive out of: the `<mid>-SUMMARY.md` is
 * already on disk (so `complete-milestone` is no longer emitted — hence the
 * `milestoneSummaryWritten` fed to the derive below) yet the milestone flip was
 * lost to a crash. That is the genuine kill-9 tail of the completion unit.
 */
export function reconcileCompletion(snapshot: ForgeSnapshot): Reconciliation | null {
  const next = deriveNextUnit(snapshot.state, snapshot.roadmap, snapshot.plans, {
    milestoneSummaryWritten: snapshot.milestoneSummaryWritten,
  });
  if (next !== null) return null;
  if (milestoneComplete(snapshot.state, snapshot.milestoneId)) return null;

  const units = snapshot.state.units ?? [];

  // R1 (S03 review-fix) — SLICE-level kill-9 window, opened by D-S03-1 (the flip
  // migrated onto the completion units). The `complete-slice` completer writes
  // `S##-SUMMARY.md` as its OWN file-write, BEFORE the loop's `updateState` flip —
  // a non-atomic two-step. A `kill -9` between them leaves the SUMMARY on disk (so
  // `deriveNextUnit` no longer emits `complete-slice`) yet the slice STATE unit
  // still `running` — derive degrades to null and, WITHOUT this branch, the
  // milestone-running F4 guard below would reconcile to a FALSE milestone-complete
  // (the exact hazard the review caught). Repair the precise window: a slice whose
  // `S##-SUMMARY.md` exists on disk (`summaryWritten`) but whose STATE unit is not
  // yet `done`. Flip THAT slice to `done` in a single atomic upsert — mirroring
  // `applyUnitResult`'s `complete-slice` flip. This MUST run BEFORE the F4 guards,
  // which stay intact for the genuine "slice running WITHOUT summary" case (a
  // half-flipped plan-slice, never a completed-but-unflipped one).
  for (const [sliceId, info] of Object.entries(snapshot.plans)) {
    if (!info.summaryWritten) continue;
    const su = units.find((u) => u.type === "slice" && u.id === sliceId);
    if (su && su.status === "done") continue; // already flipped — not this window
    return {
      kind: "slice",
      mutator: (state) => upsertUnit(state, { id: sliceId, type: "slice", status: "done" }),
      event: {
        ts: new Date().toISOString(),
        kind: "slice_complete",
        unit: `complete/${sliceId}`,
        agent: "forge-loop",
        milestone: snapshot.milestoneId,
        slice: sliceId,
        status: "complete",
        summary: `Reconciliação de retomada: ${sliceId}-SUMMARY.md em disco mas o slice não foi virado — slice ${sliceId} marcado done (flip perdido no kill-9).`,
      },
    };
  }

  // M1R-2 (F4, 2nd door): a slice still `running` (e.g. a plan-slice that
  // reported `done` without ever producing a parseable/task-bearing PLAN, so
  // `deriveNextUnit` degrades to null while the slice sits half-flipped)
  // must never be reconciled to a false milestone-complete.
  if (units.some((u) => u.type === "slice" && u.status === "running")) {
    return null;
  }

  // M1R-2 (F4 variant): a slice with a PLAN on disk (`planned: true`) but
  // ZERO tasks parsed from it can never flip to done via `applyUnitResult`
  // (there is no last task to trigger the flip) — `deriveNextUnit` simply
  // falls through it as neither plannable nor executable. Left unguarded,
  // that silently reconciles to a false milestone-complete. Never reconcile
  // while such a slice exists.
  if (Object.values(snapshot.plans).some((p) => p.planned && p.tasks.length === 0)) {
    return null;
  }

  return {
    kind: "milestone",
    mutator: (state) => markMilestoneComplete(state, snapshot.milestoneId),
    event: {
      ts: new Date().toISOString(),
      kind: "milestone_complete",
      unit: snapshot.milestoneId,
      agent: "forge-loop",
      milestone: snapshot.milestoneId,
      status: "complete",
      summary: "Reconciliação de retomada: tasks concluídas mas status não virado — milestone marcado complete.",
    },
  };
}

// ── M1R-3 — resume-time journal replay detector (PURE) ───────────────────────

/** One unreconciled result: the reconstructed unit + the mutator to re-apply. */
export interface UnreconciledResult {
  unit: NextUnit;
  mutator: (state: StateDoc) => StateDoc;
  /** Stable unit key (`slice/task` | `plan/slice`) — shared with the loop's. */
  key: string;
  /** The terminal status being re-applied (`done` for completions; blocked/partial for pauses — R3). */
  status: "done" | "blocked" | "partial";
}

/**
 * Reconstruct the `NextUnit` a journaled result belongs to.
 *
 * R1 (S03 review-fix): the loop journals a result's `unit` field as the STABLE
 * unit key (`auto/loop.ts` `unitKey` / `worker/unit-key.ts` `unitKeyOf`):
 * `<slice>/<task>` for execute-task, `complete/<slice>` for complete-slice,
 * `complete/<milestone>` for complete-milestone, `plan/<slice>` for plan-slice.
 * Before this fix a `complete-slice` result (carries `slice`, no `task`) was
 * MISCLASSIFIED as `plan-slice` — so `isResultReflected` treated it as already
 * reflected (any slice unit present) and the replay silently SKIPPED the lost
 * `complete-slice`/`complete-milestone` flip. We now key off the `complete/`
 * prefix to reconstruct the correct completion unit, so the replay path repairs
 * the SLICE-level (and milestone-level) kill-9 window too, not just reconcile.
 */
function unitFromEvent(ev: ForgeEvent): NextUnit | null {
  const key = ev.unit ?? "";
  if (key.startsWith("complete/")) {
    // A completion unit. `ev.slice` present ⇒ complete-slice (the loop sets
    // `slice` only when `unitSlice(unit)` is non-empty, i.e. never for a
    // milestone); absent ⇒ complete-milestone (id lives in the key tail).
    if (ev.slice) return { type: "complete-slice", slice: ev.slice };
    return { type: "complete-milestone", milestone: key.slice("complete/".length) };
  }
  if (!ev.slice) return null;
  if (ev.task) return { type: "execute-task", slice: ev.slice, task: ev.task };
  return { type: "plan-slice", slice: ev.slice };
}

/**
 * Is a unit's `done` result ALREADY reflected in the snapshot's STATE? — the
 * idempotency test that keeps replay a no-op once the flip has landed.
 *  - execute-task: the task unit is `done` in STATE.
 *  - complete-slice: the slice unit is `done` in STATE (D-S03-1 flip).
 *  - complete-milestone: the milestone is complete in STATE (D-S03-1 flip).
 *  - plan-slice: `applyUnitResult` records the slice as `running` (in-progress),
 *    so any slice unit already present (running or done) means the result landed.
 */
function isResultReflected(snapshot: ForgeSnapshot, unit: NextUnit): boolean {
  const units = snapshot.state.units ?? [];
  if (unit.type === "execute-task") {
    return units.some((u) => u.type === "task" && u.id === unit.task && u.status === "done");
  }
  if (unit.type === "complete-slice") {
    return units.some((u) => u.type === "slice" && u.id === unit.slice && u.status === "done");
  }
  if (unit.type === "complete-milestone") {
    return milestoneComplete(snapshot.state, unit.milestone);
  }
  // plan-slice: any slice unit present (running or done) means the plan landed.
  return units.some((u) => u.type === "slice" && u.id === unitSlice(unit));
}

/**
 * PURE resume-time replay detector (M1R-3 / M2-D3). Given the on-disk snapshot
 * and the journal, find every `unit_result` (or folded `unit_timeout`) with
 * status `done` whose STATE flip is MISSING — the exact kill-9 window between
 * the loop's `appendEvent` and its `updateState`. For each, return the
 * reconstructed `NextUnit` and the `applyUnitResult` mutator the loop
 * (`auto/replay.ts`) must re-apply via ONE `updateState`.
 *
 * Idempotent by two mechanisms: only the LAST `done` event per unit key is
 * considered (the tail wins), and a unit already reflected in STATE is skipped —
 * so a journal consistent with STATE yields `[]` (a total no-op). This function
 * performs NO I/O and NEVER re-dispatches; it only produces mutators.
 */
export function detectUnreconciledResults(
  snapshot: ForgeSnapshot,
  events: readonly ForgeEvent[],
): UnreconciledResult[] {
  // Keep the last `done` result per unit key (tail wins).
  const lastDoneByKey = new Map<string, { unit: NextUnit; key: string }>();
  for (const ev of events) {
    if (ev.kind !== "unit_result" && ev.kind !== "unit_timeout") continue;
    if (ev.status !== "done") continue;
    const unit = unitFromEvent(ev);
    if (!unit) continue;
    const key = unitKeyOf(unit);
    lastDoneByKey.set(key, { unit, key });
  }

  const out: UnreconciledResult[] = [];
  for (const { unit, key } of lastDoneByKey.values()) {
    if (isResultReflected(snapshot, unit)) continue; // already flipped — no-op
    out.push({ unit, key, status: "done", mutator: applyUnitResult(snapshot, unit, { status: "done" }) });
  }
  return out;
}

/**
 * Is a unit's NON-done terminal (blocked/partial) already reflected in STATE?
 * M2R-4 (review-fix): every unit type now carries a durable non-done status
 * (via `applyUnitResult`) — delegates to the shared `persistedUnitStatus` (the
 * same lookup the loop's M1R-4 resume guard uses) so replay's idempotency
 * check and the guard never drift apart.
 */
function isPauseReflected(snapshot: ForgeSnapshot, unit: NextUnit, status: string): boolean {
  return persistedUnitStatus(snapshot.state, unit) === status;
}

/**
 * R3 (M2/S02 review) — resume-time replay for a PAUSE that never reached STATE.
 *
 * The loop journals the pause events (`unit_result:blocked|partial` + `loop_paused`)
 * and persists the terminal into STATE. A crash in the OLD write-order (journal
 * before persist) left journal=paused / STATE=pending, and `detectUnreconciledResults`
 * only replays `done` — so resume re-dispatched the paused unit from a zeroed
 * budget, discarding the human-intervention signal. This detector complements the
 * loop's write-order fix: it re-applies the LAST non-done terminal (blocked/partial;
 * `timeout` folded to `partial`, mirroring the loop) that the journal recorded but
 * STATE is missing, so the T05 guard (`persistedUnitStatus`) re-pauses on resume.
 *
 * PURE and idempotent, exactly like `detectUnreconciledResults`: only the LAST
 * terminal per unit key is considered, a `done` tail overrides an earlier pause
 * (the unit later completed — no pause to restore), and a terminal already
 * reflected in STATE is skipped. Never re-dispatches; only produces mutators.
 *
 * M2R-5 (review-fix): a non-done terminal is ambiguous on its own — it can mean
 * the loop chose to RETRY the unit (still had budget) or to PAUSE for a human.
 * Both journal an identically-shaped `unit_result:partial` event, so without a
 * discriminator a kill-9 mid-retry was indistinguishable from a kill-9 mid-pause
 * and got re-paused either way. `decideNextAction` now tags every non-done
 * `unit_result`/`unit_timeout` with `decision: "retry" | "pause"` at the exact
 * point the choice is made — this detector only re-applies the LAST terminal
 * whose `decision` is `"pause"` (or ABSENT, the conservative back-compat
 * default for journals written before this fix — see the `ForgeLoopEvent`
 * doc-comment). A `decision: "retry"` terminal is skipped entirely: STATE was
 * never flipped for it, so `deriveNextUnit` naturally re-dispatches the same
 * unit on resume — exactly the "resume RE-TRIES, does NOT pause" behavior the
 * fix requires.
 */
export function detectUnreconciledPauses(
  snapshot: ForgeSnapshot,
  events: readonly ForgeEvent[],
): UnreconciledResult[] {
  // Track the LAST terminal (any status) per unit key — a trailing `done` must
  // win so a unit that paused then completed is NOT re-paused.
  const lastTerminalByKey = new Map<
    string,
    { unit: NextUnit; key: string; status: string; decision?: string }
  >();
  for (const ev of events) {
    // `unit_unblocked` is the OPERATOR's durable clearing marker (appended by
    // `/forge unblock`): a trailing unblock must win over an earlier journaled
    // pause, or the pause-replay net re-applies the blocked status the human
    // just cleared and the M1R-4 guard re-pauses forever (catch-22 found live
    // on the first production blocked unit, 2026-07-10 — the designed
    // "operator clears STATE" path was defeated by this very detector).
    if (ev.kind !== "unit_result" && ev.kind !== "unit_timeout" && ev.kind !== "unit_unblocked") continue;
    const unit = unitFromEvent(ev);
    if (!unit) continue;
    if (ev.kind === "unit_unblocked") {
      lastTerminalByKey.set(unitKeyOf(unit), { unit, key: unitKeyOf(unit), status: "unblocked" });
      continue;
    }
    const status = ev.status;
    if (status !== "done" && status !== "blocked" && status !== "partial" && status !== "timeout") {
      continue;
    }
    const decision = (ev as ForgeLoopEvent).decision;
    lastTerminalByKey.set(unitKeyOf(unit), { unit, key: unitKeyOf(unit), status, decision });
  }

  const out: UnreconciledResult[] = [];
  for (const { unit, key, status, decision } of lastTerminalByKey.values()) {
    if (status === "done") continue; // completions are handled by detectUnreconciledResults
    if (status === "unblocked") continue; // operator cleared — never re-pause
    // M2R-5: `decision: "retry"` means the journaled terminal is mid-retry, not
    // a pause — never re-pause it. Missing `decision` (pre-fix journal) or an
    // explicit `"pause"` both fall through to the conservative re-pause path.
    if (decision === "retry") continue;
    // Fold `timeout` to `partial`, mirroring the loop's pause persist.
    const folded = status === "timeout" ? "partial" : (status as "blocked" | "partial");
    if (isPauseReflected(snapshot, unit, folded)) continue; // already durable — no-op
    out.push({ unit, key, status: folded, mutator: applyUnitResult(snapshot, unit, { status: folded }) });
  }
  return out;
}

// ── B4 — failure taxonomy ────────────────────────────────────────────────────

/** What the loop should do next, plus the events to journal. */
export type LoopAction = "continue" | "retry" | "pause";

export interface Decision {
  action: LoopAction;
  events: ForgeLoopEvent[];
  /** Failure context to append to the retry re-dispatch prompt (retry only). */
  failureContext?: string;
  /**
   * E2E-3 (T05): the pre-built `unit_retry` event for a `retry` action, DEFERRED
   * rather than journaled eagerly. The taxonomy no longer knows whether the next
   * derive will re-dispatch the SAME unit or advance to a different one — only the
   * loop does, AFTER it re-derives. So the loop holds this event and materializes
   * either `unit_retry` (same unit re-dispatched) or `unit_readvanced` (progress on
   * disk moved it forward). Present on `retry` only; `events` carries just the
   * result event so a retry-that-advances never lies with an eager `unit_retry`.
   */
  retryEvent?: ForgeLoopEvent;
}

/**
 * Optional metadata to make journal events well-formed (unit/slice/task ids).
 * `model`/`provider`/`family` (G1) carry the authorship of the model that ran
 * the unit — derived ONCE in the loop (via `effectiveModelFor` + `familyOf`)
 * and threaded through here; `makeEvent` only copies, it never re-derives.
 */
export interface DecideContext {
  milestone?: string;
  unit?: string;
  slice?: string;
  task?: string;
  ts?: string;
  model?: string;
  provider?: string;
  family?: string;
  /**
   * S01 effort axis (D-S01-3): the effort authorship of the unit — derived
   * ONCE in the loop (applied post-clamp level + provenance + clamp record)
   * and threaded through here; `makeEvent` only copies, it never re-derives.
   */
  effort?: string;
  effortReason?: string;
  effortClamped?: string;
}

function makeEvent(
  kind: ForgeEventKind,
  status: string,
  summary: string,
  ctx: DecideContext,
  decision?: "retry" | "pause",
): ForgeLoopEvent {
  const ev: ForgeLoopEvent = {
    ts: ctx.ts ?? new Date().toISOString(),
    kind,
    unit: ctx.unit ?? "",
    agent: "forge-loop",
    milestone: ctx.milestone ?? "",
    status,
    summary,
  };
  if (ctx.slice) ev.slice = ctx.slice;
  if (ctx.task) ev.task = ctx.task;
  if (decision) ev.decision = decision;
  if (ctx.model) ev.model = ctx.model;
  if (ctx.provider) ev.provider = ctx.provider;
  if (ctx.family) ev.family = ctx.family;
  if (ctx.effort) ev.effort = ctx.effort;
  if (ctx.effortReason) ev.effort_reason = ctx.effortReason;
  if (ctx.effortClamped) ev.effort_clamped = ctx.effortClamped;
  return ev;
}

/**
 * Pure failure taxonomy (B4):
 *   - `done`            → continue (journal `unit_result`).
 *   - `partial`/`timeout` → retry while `attempts < MAX_RETRIES`, else pause.
 *   - `blocked`         → pause immediately (needs a human).
 *
 * `attempts` is the number of times THIS unit has already been dispatched-and-
 * failed in the current run (0 on the first failure). Returns the action plus
 * the `ForgeLoopEvent`s the loop must journal, and — for a retry — the
 * `failureContext` to thread into `composePrompt`.
 */
export function decideNextAction(result: UnitResult, attempts: number, ctx: DecideContext = {}): Decision {
  const summary = result.summary ?? "";

  if (result.status === "done") {
    return { action: "continue", events: [makeEvent("unit_result", "done", summary, ctx)] };
  }

  if (result.status === "blocked") {
    return {
      action: "pause",
      events: [
        makeEvent("unit_result", "blocked", summary, ctx, "pause"),
        makeEvent("loop_paused", "blocked", result.reason ?? "Unidade bloqueada — intervenção humana necessária.", ctx),
      ],
    };
  }

  // partial | timeout
  const isTimeout = result.status === "timeout";

  if (attempts < MAX_RETRIES) {
    // M2R-5: this terminal is a RETRY, not a pause — tag the journaled result
    // event `decision: "retry"` so `detectUnreconciledPauses` never re-pauses a
    // kill-9 that landed mid-retry.
    const resultEvent = isTimeout
      ? makeEvent("unit_timeout", "timeout", result.reason ?? "Unidade estourou o timeout.", ctx, "retry")
      : makeEvent("unit_result", "partial", summary, ctx, "retry");
    const failureContext = [summary, result.reason].filter(Boolean).join(" — ") ||
      (isTimeout ? "A tentativa anterior estourou o timeout sem emitir resultado." : "A tentativa anterior não concluiu.");
    // E2E-3: DO NOT journal `unit_retry` eagerly here — at this point the taxonomy
    // cannot know whether the loop's next derive will re-dispatch the SAME unit or
    // advance to a different one (on-disk progress). We hand the pre-built retry
    // event back as `retryEvent`; the loop journals `unit_retry` (same unit) or
    // `unit_readvanced` (advanced) AFTER it re-derives. `events` carries only the
    // result event so the journal never lies with an eager retry that never happened.
    return {
      action: "retry",
      events: [resultEvent],
      failureContext,
      retryEvent: makeEvent("unit_retry", result.status, `Re-dispatch da unidade (tentativa ${attempts + 2}).`, ctx),
    };
  }

  // Retry budget exhausted — this terminal IS a genuine pause.
  const exhaustedEvent = isTimeout
    ? makeEvent("unit_timeout", "timeout", result.reason ?? "Unidade estourou o timeout.", ctx, "pause")
    : makeEvent("unit_result", "partial", summary, ctx, "pause");
  return {
    action: "pause",
    events: [exhaustedEvent, makeEvent("loop_paused", result.status, "Retry esgotado — loop pausado.", ctx)],
  };
}
