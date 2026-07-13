import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayJournalOnResume } from "../auto/replay.ts";
import { readState, updateState, appendEvent, readEvents } from "../state/store.ts";
import type { StateDoc, ForgeEvent } from "../state/types.ts";

// Every test runs inside a fresh mkdtemp sandbox as `cwd`. The store/snapshot
// resolve `<cwd>/.gsd/...`, so nothing here can touch the live repo `.gsd/`
// (runtime state of the forge 1.0 orchestrator managing this work).
function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-replay-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MID = "M-toy";

/** Write the real on-disk milestone layout for a 1-slice / 1-task toy. */
function writeToyLayout(cwd: string, state: StateDoc): void {
  updateState(cwd, () => state);

  const milestoneDir = join(cwd, ".gsd", "milestones", MID);
  const slicesDir = join(milestoneDir, "slices", "S01");
  mkdirSync(join(slicesDir, "tasks", "T01"), { recursive: true });

  writeFileSync(
    join(milestoneDir, `${MID}-ROADMAP.md`),
    `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | pending |\n`,
  );
  writeFileSync(
    join(slicesDir, "S01-PLAN.md"),
    `---\nid: S01\nmilestone: ${MID}\ntitle: "Primeira slice"\n---\n\n# S01 plan\n`,
  );
  writeFileSync(
    join(slicesDir, "tasks", "T01", "T01-PLAN.md"),
    `---\nid: T01\nslice: S01\ntitle: "Task um"\n---\n\n# T01\n`,
  );
}

/** A journaled `unit_result:done` exactly as the loop appends it. */
function doneEvent(slice: string, task: string): ForgeEvent {
  return {
    ts: "2026-07-08T00:00:00Z",
    kind: "unit_result",
    unit: `${slice}/${task}`,
    agent: "forge-loop",
    milestone: MID,
    status: "done",
    summary: "T01 pronto",
    slice,
    task,
  };
}

/** A journaled `unit_result:<status>` pause exactly as the loop appends it. */
function pauseEvent(slice: string, task: string, status: "blocked" | "partial"): ForgeEvent {
  return {
    ts: "2026-07-08T00:00:00Z",
    kind: "unit_result",
    unit: `${slice}/${task}`,
    agent: "forge-loop",
    milestone: MID,
    status,
    summary: `T01 ${status}`,
    slice,
    task,
  };
}

describe("replayJournalOnResume — R3 (kill-9 pause window)", () => {
  test("re-applies a journaled blocked whose STATE persist never landed (resume re-pauses, not re-dispatch)", () => {
    withSandbox((cwd) => {
      // Crash in the OLD write-order window: the loop journaled `unit_result:blocked`
      // (+ loop_paused) but crashed before persisting the terminal into STATE —
      // STATE has NO T01 unit (reads pending). Without the R3 replay the resume
      // guard would see `pending` and re-dispatch from a zeroed budget.
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, pauseEvent("S01", "T01", "blocked"));

      replayJournalOnResume(cwd);

      // STATE now carries the durable `blocked` terminal → the T05 resume guard
      // (persistedUnitStatus) re-pauses instead of re-dispatching.
      const state = readState(cwd);
      assert.equal(
        state.units?.find((u) => u.id === "T01" && u.type === "task")?.status,
        "blocked",
        "T01 blocked terminal recovered into STATE by replay",
      );

      const replayed = readEvents(cwd).filter((e) => e.kind === "unit_result_replayed");
      assert.equal(replayed.length, 1, "one unit_result_replayed event journaled");
      assert.equal(replayed[0].status, "blocked", "audit marker carries the recovered status");
    });
  });

  test("re-applies a journaled partial whose STATE persist never landed (resume re-pauses, not re-dispatch)", () => {
    // Mirrors the blocked case above: `detectUnreconciledPauses` treats
    // blocked/partial symmetrically (housekeeping.ts:475-502), but no prior
    // test exercised the `partial` branch specifically — this closes that gap.
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, pauseEvent("S01", "T01", "partial"));

      replayJournalOnResume(cwd);

      const state = readState(cwd);
      assert.equal(
        state.units?.find((u) => u.id === "T01" && u.type === "task")?.status,
        "partial",
        "T01 partial terminal recovered into STATE by replay",
      );

      const replayed = readEvents(cwd).filter((e) => e.kind === "unit_result_replayed");
      assert.equal(replayed.length, 1, "one unit_result_replayed event journaled");
      assert.equal(replayed[0].status, "partial", "audit marker carries the recovered status");
    });
  });

  test("a pause followed by a later done does NOT re-pause (trailing terminal wins)", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, pauseEvent("S01", "T01", "blocked"));
      appendEvent(cwd, doneEvent("S01", "T01"));

      replayJournalOnResume(cwd);

      const state = readState(cwd);
      assert.equal(
        state.units?.find((u) => u.id === "T01" && u.type === "task")?.status,
        "done",
        "the trailing done wins — the earlier pause must not linger as blocked",
      );
    });
  });

  test("no-op when the blocked terminal is already durable in STATE", () => {
    withSandbox((cwd) => {
      // Slice-qualified, matching what the loop's own persist now writes
      // (task ids collide across slices — 2026-07-11 fix).
      writeToyLayout(cwd, { milestone: MID, units: [{ id: "T01", type: "task", status: "blocked", slice: "S01" }] });
      appendEvent(cwd, pauseEvent("S01", "T01", "blocked"));

      replayJournalOnResume(cwd);

      const replayed = readEvents(cwd).filter((e) => e.kind === "unit_result_replayed");
      assert.equal(replayed.length, 0, "already-reflected pause → total no-op");
    });
  });
});

describe("replayJournalOnResume — M2R-5 (partial-retry vs partial-pause discriminator)", () => {
  test("a kill-9 during a legitimate retry (decision:retry) does NOT re-pause on resume", () => {
    withSandbox((cwd) => {
      // A kill-9 landed right after the loop journaled the retry's `unit_result:
      // partial` (tagged decision:"retry" by decideNextAction) but before the
      // NEXT dispatch. STATE never carried a terminal for T01 (retries never
      // persist a terminal — only exhausted pauses do). Resume must NOT treat
      // this as a pause: `deriveNextUnit` naturally re-dispatches T01.
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, { ...pauseEvent("S01", "T01", "partial"), decision: "retry" } as ForgeEvent);

      replayJournalOnResume(cwd);

      const state = readState(cwd);
      assert.equal(
        state.units?.find((u) => u.id === "T01" && u.type === "task")?.status,
        undefined,
        "a retry-decision terminal must never be persisted as a pause",
      );
      const replayed = readEvents(cwd).filter((e) => e.kind === "unit_result_replayed");
      assert.equal(replayed.length, 0, "no pause reconciliation for a mid-retry kill-9");
    });
  });

  test("a genuine pause (decision:pause) still re-pauses on resume", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, { ...pauseEvent("S01", "T01", "partial"), decision: "pause" } as ForgeEvent);

      replayJournalOnResume(cwd);

      const state = readState(cwd);
      assert.equal(
        state.units?.find((u) => u.id === "T01" && u.type === "task")?.status,
        "partial",
        "an explicit decision:pause terminal is recovered into STATE as a pause",
      );
      const replayed = readEvents(cwd).filter((e) => e.kind === "unit_result_replayed");
      assert.equal(replayed.length, 1, "one pause reconciliation for the genuine pause");
    });
  });

  test("back-compat: an old journal entry with no decision field still resolves to the conservative pause default", () => {
    withSandbox((cwd) => {
      // Pre-fix journal — `pauseEvent` carries no `decision` field at all. Must
      // parse without throwing and preserve today's human-safety default: a
      // non-done terminal with a missing discriminator is treated as a pause.
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, pauseEvent("S01", "T01", "partial"));
      assert.equal("decision" in pauseEvent("S01", "T01", "partial"), false);

      replayJournalOnResume(cwd);

      const state = readState(cwd);
      assert.equal(
        state.units?.find((u) => u.id === "T01" && u.type === "task")?.status,
        "partial",
        "a missing decision field falls back to the conservative pause default",
      );
      const replayed = readEvents(cwd).filter((e) => e.kind === "unit_result_replayed");
      assert.equal(replayed.length, 1, "back-compat journal still re-pauses");
    });
  });

  test("a retry followed by a later pause (retry exhausted) re-pauses (trailing terminal wins)", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, { ...pauseEvent("S01", "T01", "partial"), decision: "retry" } as ForgeEvent);
      appendEvent(cwd, { ...pauseEvent("S01", "T01", "partial"), decision: "pause" } as ForgeEvent);

      replayJournalOnResume(cwd);

      const state = readState(cwd);
      assert.equal(
        state.units?.find((u) => u.id === "T01" && u.type === "task")?.status,
        "partial",
        "the trailing exhausted-retry pause wins over the earlier mid-retry terminal",
      );
    });
  });
});

describe("replayJournalOnResume — M1R-3 (kill-9 A3)", () => {
  test("re-applies a journaled done with STATE still pending, without re-dispatch", () => {
    withSandbox((cwd) => {
      // The kill-9 window: the loop journaled `unit_result:done` for T01 but
      // crashed before its `updateState` — STATE has NO T01 unit (pending).
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, doneEvent("S01", "T01"));

      // Resume: replay reconciles STATE from the journal.
      replayJournalOnResume(cwd);

      // STATE now reflects the completed task — the flip was recovered.
      const state = readState(cwd);
      assert.equal(
        state.units?.find((u) => u.id === "T01" && u.type === "task")?.status,
        "done",
        "T01 flipped to done by replay",
      );

      // An audit marker was journaled for the reconciliation.
      const replayed = readEvents(cwd).filter((e) => e.kind === "unit_result_replayed");
      assert.equal(replayed.length, 1, "one unit_result_replayed event journaled");
      assert.equal(replayed[0].unit, "S01/T01");
      assert.equal(replayed[0].task, "T01");
    });
  });

  test("no-op when STATE already agrees with the journal (no write, no event)", () => {
    withSandbox((cwd) => {
      // STATE already shows T01 done — the flip landed before the crash.
      writeToyLayout(cwd, { milestone: MID, units: [{ id: "T01", type: "task", status: "done" }] });
      appendEvent(cwd, doneEvent("S01", "T01"));

      const journalBefore = existsSync(join(cwd, ".gsd", "forge", "events.jsonl"))
        ? readEvents(cwd).length
        : 0;

      replayJournalOnResume(cwd);

      // No new events, STATE unchanged — a total no-op.
      const eventsAfter = readEvents(cwd);
      assert.equal(eventsAfter.length, journalBefore, "no new journal event on a clean resume");
      assert.equal(eventsAfter.filter((e) => e.kind === "unit_result_replayed").length, 0);
      assert.equal(
        readState(cwd).units?.find((u) => u.id === "T01")?.status,
        "done",
        "STATE untouched",
      );
    });
  });

  test("no journal at all → no-op (fresh resume never throws)", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      assert.doesNotThrow(() => replayJournalOnResume(cwd));
      assert.equal(existsSync(join(cwd, ".gsd", "forge", "events.jsonl")), false);
    });
  });

  test("cross-milestone journal entries are NEVER replayed (unit keys collide across milestones)", () => {
    withSandbox((cwd) => {
      // The repo-global journal holds a PREVIOUS milestone's done + blocked
      // results whose unit keys (S01/T01) collide with the fresh milestone's.
      // Seen live 2026-07-10: the ceremony milestone's S01:done leaked into
      // the next milestone's STATE via replay, so deriveNextUnit skipped S01.
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, { ...doneEvent("S01", "T01"), milestone: "M-previous" } as ForgeEvent);
      appendEvent(cwd, { ...pauseEvent("S02", "T01", "blocked"), milestone: "M-previous" } as ForgeEvent);

      replayJournalOnResume(cwd);

      const state = readState(cwd);
      assert.deepEqual(state.units, [], "foreign-milestone results must not contaminate a fresh STATE");
      const replayed = readEvents(cwd).filter((e) => e.kind === "unit_result_replayed");
      assert.equal(replayed.length, 0, "no replay marker for foreign-milestone events");
    });
  });

  test("a trailing unit_unblocked clears an earlier journaled pause (operator unblock is durable)", () => {
    withSandbox((cwd) => {
      // The catch-22 found live 2026-07-10: operator clears STATE, but the
      // pause-replay net re-applies the journaled blocked. The /forge unblock
      // marker must win as the trailing terminal for the key.
      writeToyLayout(cwd, { milestone: MID, units: [] });
      appendEvent(cwd, pauseEvent("S01", "T01", "blocked"));
      appendEvent(cwd, {
        ts: "2026-07-08T00:00:01Z",
        kind: "unit_unblocked",
        unit: "S01/T01",
        agent: "forge-operator",
        milestone: MID,
        status: "unblocked",
        summary: "Operador desbloqueou S01/T01.",
        slice: "S01",
        task: "T01",
      } as ForgeEvent);

      replayJournalOnResume(cwd);

      assert.deepEqual(readState(cwd).units, [], "a cleared pause must NOT be re-applied by replay");
    });
  });

  test("events with NO milestone attribution are conservatively excluded from replay", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      const ev = doneEvent("S01", "T01") as unknown as Record<string, unknown>;
      delete ev.milestone;
      appendEvent(cwd, ev as unknown as ForgeEvent);

      replayJournalOnResume(cwd);

      assert.deepEqual(readState(cwd).units, [], "unattributable events must not be replayed");
    });
  });
});
