/**
 * `auto/replay.ts` — the resume-time journal replay (M1R-3 / M2-D3).
 *
 * The I/O orchestrator that mirrors `auto/snapshot.ts`'s discipline: it is the
 * ONLY place the resume path touches disk, keeping the detector
 * (`detectUnreconciledResults`) 100% pure. On every `/forge auto` resume the
 * loop calls `replayJournalOnResume` exactly ONCE before its first iteration.
 *
 * The kill-9 window it repairs: the loop journals `unit_result:done`
 * (`appendEvent`) and THEN flips STATE (`updateState`). A crash between the two
 * leaves a journaled `done` with STATE still showing the unit pending. On the
 * next launch the replay re-applies the SAME atomic mutator through the
 * single-writer `updateState` (D3), so STATE reflects the completed unit — and
 * it NEVER re-dispatches the unit (M2-D3: the driver is never called here). When
 * STATE already agrees with the journal, `detectUnreconciledResults` returns an
 * empty list and this is a total no-op (no `updateState`, no event).
 */

import { readSnapshot } from "./snapshot.js";
import { detectUnreconciledResults, detectUnreconciledPauses } from "./housekeeping.js";
import { readEvents, updateState, appendEvent, unitSlice, type ForgeEvent } from "../state/index.js";

/**
 * Reconcile any journaled-but-not-flipped `unit_result:done` into STATE on
 * resume. Reads the snapshot + journal, and for each unreconciled result
 * re-applies its mutator via ONE `updateState` and journals a
 * `unit_result_replayed` audit marker (best-effort). Never re-dispatches; a
 * no-op when STATE is already consistent with the journal.
 */
export function replayJournalOnResume(cwd: string): void {
  const snapshot = readSnapshot(cwd);
  // Scope the journal to the ACTIVE milestone before any detector runs. The
  // journal file is repo-global and unit keys ("S01", "T01") COLLIDE across
  // milestones — without this filter, a fresh milestone inherits the previous
  // milestone's done/blocked units via replay (seen live 2026-07-10: the
  // forge-merge M3's S01 arrived pre-"done" from the ceremony milestone's S01,
  // so deriveNextUnit skipped straight to S02, whose worker correctly
  // self-blocked on the unplanned dependency). Events predating the
  // `milestone` field (undefined) are conservatively excluded — they cannot
  // be attributed, and replaying them cross-milestone is the exact failure
  // this guards against.
  const events = readEvents(cwd).filter(
    (ev) => ev.milestone === snapshot.milestoneId,
  );
  // R3 (M2/S02 review): reconcile BOTH journaled-but-unpersisted completions
  // (`done`) AND journaled-but-unpersisted PAUSES (blocked/partial). The latter
  // repairs the crash window between the pause journal and the STATE persist so
  // resume re-pauses (via the T05 guard) instead of re-dispatching the paused
  // unit from a zeroed budget. `done` reconciliations are applied first; a unit
  // that later completed cannot also appear as an unreconciled pause (the pause
  // detector honors the trailing terminal per key).
  const pending = [
    ...detectUnreconciledResults(snapshot, events),
    ...detectUnreconciledPauses(snapshot, events),
  ];
  if (pending.length === 0) return; // total no-op: STATE already consistent

  for (const { unit, mutator, key, status } of pending) {
    // Single-writer (D3): re-apply the recovered flip through the store.
    updateState(cwd, mutator);

    // Audit marker so a resume that repaired STATE is distinguishable in the
    // journal from a normal dispatch — never a re-dispatch of the unit.
    const event: ForgeEvent = {
      ts: new Date().toISOString(),
      kind: "unit_result_replayed",
      unit: key,
      agent: "forge-loop",
      milestone: snapshot.milestoneId,
      status,
      summary: `Replay de retomada: resultado (${status}) journalado de ${unit.type} (${key}) reaplicado ao STATE sem re-despacho.`,
      slice: unitSlice(unit),
    };
    if (unit.type === "execute-task") event.task = unit.task;
    appendEvent(cwd, event);
  }
}
