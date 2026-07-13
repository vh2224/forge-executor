import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleForUnit } from "../auto/role.ts";
import { detectUnreconciledPauses, detectUnreconciledResults } from "../auto/housekeeping.ts";
import { replayJournalOnResume } from "../auto/replay.ts";
import type { ForgeSnapshot } from "../auto/snapshot.ts";
import { appendEvent, readEvents, updateState } from "../state/store.ts";
import type { ForgeEvent, StateDoc } from "../state/types.ts";

const MID = "M-plan-milestone";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), "forge-plan-milestone-replay-test-"));
  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function snapshotOf(state: StateDoc): ForgeSnapshot {
  return {
    cwd: "/nonexistent",
    milestoneId: MID,
    state,
    roadmap: [],
    plans: {},
    milestoneSummaryWritten: false,
    titles: { slice: {}, task: {} },
  };
}

function planMilestoneEvent(kind: "unit_dispatched" | "unit_result"): ForgeEvent {
  return {
    ts: "2026-07-12T00:00:00.000Z",
    kind,
    unit: "plan-milestone",
    agent: "forge-command",
    milestone: MID,
    status: kind === "unit_result" ? "done" : "dispatched",
    summary: "Planejamento da milestone despachado.",
  };
}

describe("plan-milestone journal tolerance", () => {
  test("routes the direct plan-milestone dispatch to planner", () => {
    assert.equal(roleForUnit({ type: "plan-milestone", milestone: "M-x" }), "planner");
  });

  test("detectors ignore plan-milestone events without slice or task", () => {
    const events = [planMilestoneEvent("unit_dispatched"), planMilestoneEvent("unit_result")];
    const snapshot = snapshotOf({ milestone: MID, units: [] });

    assert.deepEqual(detectUnreconciledResults(snapshot, events), []);
    assert.deepEqual(detectUnreconciledPauses(snapshot, events), []);
  });

  test("a plan-milestone result with an accidental slice is reconstructed as plan-slice", () => {
    const accidentalSliceEvent: ForgeEvent = {
      ...planMilestoneEvent("unit_result"),
      slice: "S01",
    };

    const results = detectUnreconciledResults(snapshotOf({ milestone: MID, units: [] }), [accidentalSliceEvent]);

    assert.equal(results.length, 1, "slice makes the replay net reconstruct a unit");
    assert.deepEqual(results[0].unit, { type: "plan-slice", slice: "S01" });
  });

  test("replay is a total STATE no-op for well-formed plan-milestone journal events", () => {
    withSandbox((cwd) => {
      updateState(cwd, () => ({ milestone: MID, phase: "plan", units: [] }));
      appendEvent(cwd, planMilestoneEvent("unit_dispatched"));
      appendEvent(cwd, planMilestoneEvent("unit_result"));

      const statePath = join(cwd, ".gsd", "STATE.md");
      const stateBefore = readFileSync(statePath, "utf-8");

      replayJournalOnResume(cwd);

      assert.equal(readFileSync(statePath, "utf-8"), stateBefore, "STATE bytes stay identical");
      assert.equal(
        readEvents(cwd).filter((event) => event.kind === "unit_result_replayed").length,
        0,
        "a total no-op appends no replay audit event",
      );
    });
  });
});
