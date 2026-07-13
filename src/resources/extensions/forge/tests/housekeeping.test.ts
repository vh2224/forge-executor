import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUnitResult,
  reconcileCompletion,
  decideNextAction,
  milestoneComplete,
  detectUnreconciledResults,
  MAX_RETRIES,
  type UnitResult,
} from "../auto/housekeeping.ts";
import { readSnapshot, type ForgeSnapshot } from "../auto/snapshot.ts";
import { readState, updateState, appendEvent } from "../state/store.ts";
import { deriveNextUnit } from "../state/dispatch.ts";
import type { StateDoc, RoadmapSlice, ForgeEvent } from "../state/types.ts";
import type { PlansBySlice } from "../state/dispatch.ts";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-housekeeping-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MID = "M-toy";

/** Build an in-memory snapshot (no disk) for the pure-mutator tests. */
function snapshotOf(state: StateDoc, roadmap: RoadmapSlice[], plans: PlansBySlice): ForgeSnapshot {
  return { cwd: "/nonexistent", milestoneId: MID, state, roadmap, plans, milestoneSummaryWritten: false, titles: { slice: {}, task: {} } };
}

const ONE_SLICE: RoadmapSlice[] = [
  { id: "S01", name: "s", risk: "med", depends: [], status: "pending" },
];

// ── B5.1 — atomic single-mutator flip of the terminal task ───────────────────

describe("applyUnitResult — B5.1 atomicity (D-S03-1 flip model)", () => {
  test("the LAST task done flips ONLY the task — slice stays running, milestone untouched", () => {
    withSandbox((cwd) => {
      // Pre-state: T01 done, T02 pending, slice already `running` (set by plan-slice).
      const preState: StateDoc = {
        milestone: MID,
        units: [
          { id: "S01", type: "slice", status: "running" },
          { id: "T01", type: "task", status: "done" },
        ],
      };
      updateState(cwd, () => preState);

      const plans: PlansBySlice = {
        S01: {
          planned: true,
          summaryWritten: false,
          tasks: [
            { id: "T01", status: "done" },
            { id: "T02", status: "pending" },
          ],
        },
      };
      const snap = snapshotOf(readState(cwd), ONE_SLICE, plans);

      const result: UnitResult = { status: "done", summary: "T02 pronto" };
      const mutator = applyUnitResult(snap, { type: "execute-task", slice: "S01", task: "T02" }, result);

      // B5.1: exactly ONE mutator is returned — never two separate writes.
      assert.equal(typeof mutator, "function");
      const written = updateState(cwd, mutator);

      // D-S03-1: the last task done marks ONLY the task. The slice does NOT flip
      // (the flip is now owned by `complete-slice`); the milestone is untouched.
      const t02 = written.units?.find((u) => u.id === "T02" && u.type === "task");
      const s01 = written.units?.find((u) => u.id === "S01" && u.type === "slice");
      const ms = written.units?.find((u) => u.type === "milestone");
      assert.equal(t02?.status, "done", "task flipped");
      assert.equal(s01?.status, "running", "slice NOT flipped — complete-slice owns it now");
      assert.equal(ms, undefined, "milestone NOT flipped by a task result");
      assert.equal(written.phase, undefined);

      // Dispatch now emits `complete-slice` (all tasks done, no S01-SUMMARY yet):
      // completion is an explicit, dispatchable step, not a silent side effect.
      const after: PlansBySlice = {
        S01: { planned: true, summaryWritten: false, tasks: [{ id: "T01", status: "done" }, { id: "T02", status: "done" }] },
      };
      assert.deepStrictEqual(deriveNextUnit(readState(cwd), ONE_SLICE, after), {
        type: "complete-slice",
        slice: "S01",
      });
    });
  });

  test("complete-slice done flips the slice to done in ONE mutator — milestone untouched", () => {
    withSandbox((cwd) => {
      const preState: StateDoc = {
        milestone: MID,
        units: [
          { id: "S01", type: "slice", status: "running" },
          { id: "T01", type: "task", status: "done" },
        ],
      };
      updateState(cwd, () => preState);
      const snap = snapshotOf(readState(cwd), ONE_SLICE, {
        S01: { planned: true, summaryWritten: true, tasks: [{ id: "T01", status: "done" }] },
      });

      const mutator = applyUnitResult(snap, { type: "complete-slice", slice: "S01" }, { status: "done" });
      assert.equal(typeof mutator, "function");
      const written = updateState(cwd, mutator);

      assert.equal(written.units?.find((u) => u.type === "slice" && u.id === "S01")?.status, "done");
      assert.equal(written.units?.find((u) => u.type === "milestone"), undefined, "milestone not touched by complete-slice");
      assert.equal(written.phase, undefined);
    });
  });

  test("M2R-4: complete-slice non-done persists the pause on the slice unit (no done flip)", () => {
    const snap = snapshotOf({ milestone: MID, units: [{ id: "S01", type: "slice", status: "running" }] }, ONE_SLICE, {});
    for (const status of ["partial", "blocked"] as const) {
      const mutator = applyUnitResult(snap, { type: "complete-slice", slice: "S01" }, { status });
      const next = mutator({ milestone: MID, units: [{ id: "S01", type: "slice", status: "running" }] });
      assert.equal(
        next.units?.find((u) => u.type === "slice")?.status,
        status,
        "the pause is durably recorded — never flips to done",
      );
    }
  });

  test("complete-milestone done marks the milestone complete in ONE mutator", () => {
    withSandbox((cwd) => {
      const preState: StateDoc = {
        milestone: MID,
        units: [{ id: "S01", type: "slice", status: "done" }],
      };
      updateState(cwd, () => preState);
      const snap = snapshotOf(readState(cwd), ONE_SLICE, {
        S01: { planned: true, summaryWritten: true, tasks: [{ id: "T01", status: "done" }] },
      });

      const mutator = applyUnitResult(snap, { type: "complete-milestone", milestone: MID }, { status: "done" });
      assert.equal(typeof mutator, "function");
      const written = updateState(cwd, mutator);

      assert.equal(written.phase, "complete");
      assert.equal(written.units?.find((u) => u.type === "milestone")?.status, "done");
      assert.ok(milestoneComplete(readState(cwd), MID));
    });
  });

  test("M2R-4: complete-milestone non-done persists the pause on a milestone unit (no phase flip)", () => {
    const snap = snapshotOf({ milestone: MID, units: [{ id: "S01", type: "slice", status: "done" }] }, ONE_SLICE, {});
    for (const status of ["partial", "blocked"] as const) {
      const mutator = applyUnitResult(snap, { type: "complete-milestone", milestone: MID }, { status });
      const next = mutator({ milestone: MID, units: [{ id: "S01", type: "slice", status: "done" }] });
      assert.equal(next.phase, undefined, "phase never flips to complete on a pause");
      assert.equal(
        next.units?.find((u) => u.type === "milestone")?.status,
        status,
        "the pause is durably recorded on the milestone unit",
      );
      assert.equal(milestoneComplete(next, MID), false, "milestoneComplete stays false — only 'done' counts");
    }
  });

  test("complete-slice flip is idempotent — re-applying on an already-done slice is a no-op (kill-9 replay)", () => {
    const snap = snapshotOf({ milestone: MID, units: [] }, ONE_SLICE, {});
    const mutator = applyUnitResult(snap, { type: "complete-slice", slice: "S01" }, { status: "done" });
    const once = mutator({ milestone: MID, units: [{ id: "S01", type: "slice", status: "running" }] });
    const twice = mutator(once);
    assert.deepStrictEqual(twice, once, "second apply changes nothing");
    assert.equal(twice.units?.filter((u) => u.type === "slice" && u.id === "S01").length, 1, "no duplicate unit");
    assert.equal(twice.units?.find((u) => u.type === "slice")?.status, "done");
  });

  test("complete-milestone flip is idempotent — re-applying on a complete milestone is a no-op (kill-9 replay)", () => {
    const snap = snapshotOf({ milestone: MID, units: [] }, ONE_SLICE, {});
    const mutator = applyUnitResult(snap, { type: "complete-milestone", milestone: MID }, { status: "done" });
    const once = mutator({ milestone: MID, units: [{ id: "S01", type: "slice", status: "done" }] });
    const twice = mutator(once);
    assert.deepStrictEqual(twice, once, "second apply changes nothing");
    assert.equal(twice.phase, "complete");
    assert.equal(twice.units?.filter((u) => u.type === "milestone").length, 1, "no duplicate milestone unit");
    assert.ok(milestoneComplete(twice, MID));
  });

  test("a NON-terminal task done flips only the task, never the slice", () => {
    const plans: PlansBySlice = {
      S01: { planned: true, tasks: [{ id: "T01", status: "pending" }, { id: "T02", status: "pending" }] },
    };
    const snap = snapshotOf({ milestone: MID, units: [] }, ONE_SLICE, plans);
    const mutator = applyUnitResult(snap, { type: "execute-task", slice: "S01", task: "T01" }, { status: "done" });
    const next = mutator({ milestone: MID, units: [] });

    assert.equal(next.units?.find((u) => u.id === "T01")?.status, "done");
    assert.equal(next.units?.find((u) => u.type === "slice"), undefined, "slice not flipped — T02 still pending");
    assert.equal(next.phase, undefined, "milestone not flipped");
  });

  test("execute-task partial/blocked records the status without any flip", () => {
    const plans: PlansBySlice = { S01: { planned: true, tasks: [{ id: "T01", status: "pending" }] } };
    const snap = snapshotOf({ milestone: MID, units: [] }, ONE_SLICE, plans);

    for (const status of ["partial", "blocked"] as const) {
      const mutator = applyUnitResult(snap, { type: "execute-task", slice: "S01", task: "T01" }, { status });
      const next = mutator({ milestone: MID, units: [] });
      assert.equal(next.units?.find((u) => u.id === "T01")?.status, status);
      assert.equal(next.units?.find((u) => u.type === "slice"), undefined);
    }
  });

  test("plan-slice done records the slice as in-progress (running)", () => {
    const snap = snapshotOf({ milestone: MID }, ONE_SLICE, {});
    const mutator = applyUnitResult(snap, { type: "plan-slice", slice: "S01" }, { status: "done" });
    const next = mutator({ milestone: MID });
    assert.equal(next.units?.find((u) => u.id === "S01" && u.type === "slice")?.status, "running");
  });

  test("M2R-4: plan-slice non-done persists the pause on the slice unit (not identity)", () => {
    const snap = snapshotOf({ milestone: MID }, ONE_SLICE, {});
    for (const status of ["partial", "blocked"] as const) {
      const mutator = applyUnitResult(snap, { type: "plan-slice", slice: "S01" }, { status });
      const next = mutator({ milestone: MID });
      assert.equal(
        next.units?.find((u) => u.id === "S01" && u.type === "slice")?.status,
        status,
        "the pause is durably recorded — no longer an identity no-op",
      );
    }
  });
});

// ── B5.2 — kill-9 resume reconciliation (acceptance #1 of S03-PLAN) ───────────

/**
 * Write the toy on-disk layout in the FORBIDDEN intermediate state, under the
 * D-S03-1 flip model. The single window dispatch cannot re-derive out of: the
 * slice is done in STATE, BOTH the S01-SUMMARY and the `<mid>-SUMMARY` are on
 * disk (so `complete-slice` and `complete-milestone` are no longer emitted), yet
 * the milestone flip was lost to a crash between `complete-milestone`'s journal
 * append and its `updateState`.
 */
function writeCrashLayout(cwd: string): void {
  updateState(cwd, () => ({
    milestone: MID,
    units: [
      { id: "T01", type: "task", status: "done" },
      { id: "T02", type: "task", status: "done" },
      { id: "S01", type: "slice", status: "done" },
    ],
  }));

  const milestoneDir = join(cwd, ".gsd", "milestones", MID);
  const slicesDir = join(milestoneDir, "slices", "S01");
  mkdirSync(join(slicesDir, "tasks", "T01"), { recursive: true });
  mkdirSync(join(slicesDir, "tasks", "T02"), { recursive: true });
  writeFileSync(
    join(milestoneDir, `${MID}-ROADMAP.md`),
    `# M\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | s | med | — | pending |\n`,
  );
  writeFileSync(join(slicesDir, "S01-PLAN.md"), `---\nid: S01\n---\n# plan\n`);
  writeFileSync(join(slicesDir, "tasks", "T01", "T01-PLAN.md"), `---\nid: T01\n---\n# T01\n`);
  writeFileSync(join(slicesDir, "tasks", "T02", "T02-PLAN.md"), `---\nid: T02\n---\n# T02\n`);
  // Completion artifacts already written → dispatch no longer emits the units.
  writeFileSync(join(slicesDir, "S01-SUMMARY.md"), `---\nid: S01\n---\n# summary\n`);
  writeFileSync(join(milestoneDir, `${MID}-SUMMARY.md`), `---\nid: ${MID}\n---\n# milestone summary\n`);
}

describe("reconcileCompletion — B5.2 kill-9 resume", () => {
  test("crash state (tasks done, status not flipped) → resume repairs + journals milestone_complete", () => {
    withSandbox((cwd) => {
      writeCrashLayout(cwd);

      // Resume: read the snapshot from disk as the real loop would.
      const snap = readSnapshot(cwd);

      // Dispatch derives null (all slices done AND the milestone SUMMARY exists,
      // so `complete-milestone` is no longer emitted) but STATE is NOT complete —
      // the exact silent-skip hazard B5 guards against under D-S03-1.
      assert.equal(
        deriveNextUnit(snap.state, snap.roadmap, snap.plans, {
          milestoneSummaryWritten: snap.milestoneSummaryWritten,
        }),
        null,
      );
      assert.equal(milestoneComplete(snap.state, MID), false);

      const recon = reconcileCompletion(snap);
      assert.ok(recon, "reconciliation fires on the crash state");

      // Apply the flip through the single writer and journal the event.
      const written = updateState(cwd, recon!.mutator);
      appendEvent(cwd, recon!.event);

      assert.equal(written.phase, "complete");
      assert.ok(milestoneComplete(written, MID));
      assert.equal(recon!.event.kind, "milestone_complete");

      const journal = readFileSync(join(cwd, ".gsd", "forge", "events.jsonl"), "utf-8");
      const line = JSON.parse(journal.trim());
      assert.equal(line.kind, "milestone_complete");
      assert.equal(line.milestone, MID);
    });
  });

  test("returns null when work remains (no false completion)", () => {
    const plans: PlansBySlice = { S01: { planned: true, tasks: [{ id: "T01", status: "pending" }] } };
    const snap = snapshotOf({ milestone: MID, units: [] }, ONE_SLICE, plans);
    assert.equal(reconcileCompletion(snap), null);
  });

  test("returns null when the milestone is already marked complete", () => {
    const state: StateDoc = { milestone: MID, phase: "complete", units: [] };
    const snap = snapshotOf(state, ONE_SLICE, { S01: { planned: true, tasks: [{ id: "T01", status: "done" }] } });
    assert.equal(reconcileCompletion(snap), null);
  });
});

// ── R1 (S03 review-fix) — SLICE-level kill-9 reconcile ───────────────────────

describe("reconcileCompletion — R1 slice-level kill-9 (S03 review-fix)", () => {
  // S01 → S02 (S02 depends on S01). The window: S01's tasks are all done and its
  // S01-SUMMARY.md is on disk, but the slice flip was lost — STATE reads S01
  // `running`. deriveNextUnit degrades to null (S02 is blocked on the unflipped
  // S01), and WITHOUT the slice branch reconcile would falsely complete the
  // milestone. The fix reconciles THAT slice to done so S02 unblocks.
  const TWO_SLICES: RoadmapSlice[] = [
    { id: "S01", name: "s1", risk: "med", depends: [], status: "pending" },
    { id: "S02", name: "s2", risk: "med", depends: ["S01"], status: "pending" },
  ];

  function crashSnap(): ForgeSnapshot {
    return snapshotOf(
      {
        milestone: MID,
        units: [
          { id: "T01", type: "task", status: "done" },
          { id: "S01", type: "slice", status: "running" }, // flip lost
        ],
      },
      TWO_SLICES,
      {
        S01: { planned: true, summaryWritten: true, tasks: [{ id: "T01", status: "done" }] },
        S02: { planned: true, summaryWritten: false, tasks: [{ id: "T02", status: "pending" }] },
      },
    );
  }

  test("summary on disk + slice running → reconcile flips THAT slice done (kind: slice), never a false milestone-complete", () => {
    const snap = crashSnap();

    // Pre-condition: derive is null (S02 blocked on the unflipped S01) and the
    // milestone is NOT complete — the exact silent-skip hazard R1 caught.
    assert.equal(
      deriveNextUnit(snap.state, snap.roadmap, snap.plans, { milestoneSummaryWritten: false }),
      null,
    );
    assert.equal(milestoneComplete(snap.state, MID), false);

    const recon = reconcileCompletion(snap);
    assert.ok(recon, "reconciliation fires on the slice-level crash window");
    assert.equal(recon!.kind, "slice", "repairs the SLICE, not the milestone");
    assert.equal(recon!.event.kind, "slice_complete");
    assert.equal(recon!.event.slice, "S01");

    // The mutator flips ONLY S01 to done — the milestone is NOT completed.
    const flipped = recon!.mutator(snap.state);
    assert.equal(flipped.units?.find((u) => u.type === "slice" && u.id === "S01")?.status, "done");
    assert.equal(flipped.phase, undefined, "milestone NOT flipped by a slice reconcile");
    assert.equal(milestoneComplete(flipped, MID), false);

    // And after the flip, S02 unblocks: derive now dispatches its pending task.
    const next = deriveNextUnit(flipped, snap.roadmap, {
      S01: { planned: true, summaryWritten: true, tasks: [{ id: "T01", status: "done" }] },
      S02: { planned: true, summaryWritten: false, tasks: [{ id: "T02", status: "pending" }] },
    });
    assert.deepStrictEqual(next, { type: "execute-task", slice: "S02", task: "T02" });
  });

  test("F4 preserved: a slice running WITHOUT its summary is NOT reconciled (returns null)", () => {
    const snap = snapshotOf(
      { milestone: MID, units: [{ id: "S01", type: "slice", status: "running" }] },
      ONE_SLICE,
      { S01: { planned: true, summaryWritten: false, tasks: [{ id: "T01", status: "done" }] } },
    );
    // No summary on disk → the slice branch skips it and the F4 guard returns null
    // (never a false milestone-complete for a genuinely half-flipped slice).
    assert.equal(reconcileCompletion(snap), null);
  });
});

// ── B4 — failure taxonomy (exhaustive table) ─────────────────────────────────

describe("decideNextAction — failure taxonomy", () => {
  const ctx = { milestone: MID, unit: "T01", slice: "S01", task: "T01" };

  test("done → continue, journals unit_result", () => {
    const d = decideNextAction({ status: "done", summary: "ok" }, 0, ctx);
    assert.equal(d.action, "continue");
    assert.deepEqual(d.events.map((e) => e.kind), ["unit_result"]);
    assert.equal(d.failureContext, undefined);
  });

  test("partial, attempts<max → retry with failureContext; unit_retry is DEFERRED (E2E-3)", () => {
    const d = decideNextAction({ status: "partial", summary: "meia coisa", reason: "faltou X" }, 0, ctx);
    assert.equal(d.action, "retry");
    assert.equal(MAX_RETRIES, 1);
    // E2E-3: the taxonomy no longer journals `unit_retry` eagerly — `events`
    // carries only the result event; the retry marker is handed back deferred so
    // the loop can pick `unit_retry` vs `unit_readvanced` after it re-derives.
    assert.deepEqual(d.events.map((e) => e.kind), ["unit_result"]);
    assert.equal(d.retryEvent?.kind, "unit_retry");
    assert.match(d.retryEvent?.summary ?? "", /tentativa 2/);
    assert.ok(d.failureContext && d.failureContext.includes("faltou X"));
  });

  test("partial, attempts==max → pause with loop_paused", () => {
    const d = decideNextAction({ status: "partial", summary: "de novo" }, MAX_RETRIES, ctx);
    assert.equal(d.action, "pause");
    assert.deepEqual(d.events.map((e) => e.kind), ["unit_result", "loop_paused"]);
  });

  test("timeout, attempts<max → retry, journals unit_timeout (not unit_result); unit_retry deferred", () => {
    const d = decideNextAction({ status: "timeout" }, 0, ctx);
    assert.equal(d.action, "retry");
    // E2E-3: only the result event is eager; the retry marker is deferred.
    assert.deepEqual(d.events.map((e) => e.kind), ["unit_timeout"]);
    assert.equal(d.retryEvent?.kind, "unit_retry");
    assert.ok(d.failureContext && d.failureContext.length > 0);
  });

  test("timeout, attempts==max → pause", () => {
    const d = decideNextAction({ status: "timeout" }, 1, ctx);
    assert.equal(d.action, "pause");
    assert.deepEqual(d.events.map((e) => e.kind), ["unit_timeout", "loop_paused"]);
  });

  test("blocked → pause immediately regardless of attempts", () => {
    for (const attempts of [0, 1, 5]) {
      const d = decideNextAction({ status: "blocked", reason: "precisa humano" }, attempts, ctx);
      assert.equal(d.action, "pause");
      assert.deepEqual(d.events.map((e) => e.kind), ["unit_result", "loop_paused"]);
    }
  });

  test("events carry the unit/slice/task context", () => {
    const d = decideNextAction({ status: "done" }, 0, ctx);
    assert.equal(d.events[0].unit, "T01");
    assert.equal(d.events[0].slice, "S01");
    assert.equal(d.events[0].milestone, MID);
  });

  // M2R-5 — decision discriminator on the journaled unit_result/unit_timeout.
  test("partial, attempts<max (retry) → unit_result tagged decision:retry", () => {
    const d = decideNextAction({ status: "partial", summary: "meia coisa" }, 0, ctx);
    assert.equal(d.events[0].decision, "retry");
  });

  test("timeout, attempts<max (retry) → unit_timeout tagged decision:retry", () => {
    const d = decideNextAction({ status: "timeout" }, 0, ctx);
    assert.equal(d.events[0].decision, "retry");
  });

  test("partial, attempts==max (pause) → unit_result tagged decision:pause", () => {
    const d = decideNextAction({ status: "partial", summary: "de novo" }, MAX_RETRIES, ctx);
    assert.equal(d.events[0].decision, "pause");
  });

  test("timeout, attempts==max (pause) → unit_timeout tagged decision:pause", () => {
    const d = decideNextAction({ status: "timeout" }, 1, ctx);
    assert.equal(d.events[0].decision, "pause");
  });

  test("blocked → unit_result tagged decision:pause", () => {
    const d = decideNextAction({ status: "blocked", reason: "precisa humano" }, 0, ctx);
    assert.equal(d.events[0].decision, "pause");
  });

  // S01 effort axis — makeEvent copies effort authorship from the ctx, never re-derives.
  test("ctx with effort fields → every journaled event carries them (S01)", () => {
    const effortCtx = {
      ...ctx,
      effort: "medium",
      effortReason: "task-frontmatter; capped high→medium by effort_max",
      effortClamped: "high→medium",
    };
    const d = decideNextAction({ status: "partial", summary: "meia coisa" }, 0, effortCtx);
    for (const ev of [...d.events, d.retryEvent!]) {
      assert.equal(ev.effort, "medium");
      assert.equal(ev.effort_reason, "task-frontmatter; capped high→medium by effort_max");
      assert.equal(ev.effort_clamped, "high→medium");
    }
  });

  test("ctx without effort fields → events carry NO effort keys (byte-identity, S01)", () => {
    const d = decideNextAction({ status: "done", summary: "ok" }, 0, ctx);
    const ev = d.events[0];
    assert.equal("effort" in ev, false);
    assert.equal("effort_reason" in ev, false);
    assert.equal("effort_clamped" in ev, false);
  });

  test("effort without clamp → effort_clamped key absent (S01)", () => {
    const d = decideNextAction(
      { status: "done", summary: "ok" },
      0,
      { ...ctx, effort: "high", effortReason: "role-default:executor" },
    );
    const ev = d.events[0];
    assert.equal(ev.effort, "high");
    assert.equal(ev.effort_reason, "role-default:executor");
    assert.equal("effort_clamped" in ev, false);
  });
});

// ── M1R-3 — detectUnreconciledResults (pure resume-time replay detector) ──────

describe("detectUnreconciledResults — M1R-3", () => {
  function doneEvent(slice: string, task?: string): ForgeEvent {
    const ev: ForgeEvent = {
      ts: "2026-07-08T00:00:00Z",
      kind: "unit_result",
      unit: task ? `${slice}/${task}` : `plan/${slice}`,
      agent: "forge-loop",
      milestone: MID,
      status: "done",
      summary: "done",
      slice,
    };
    if (task) ev.task = task;
    return ev;
  }

  test("a journaled execute-task done with NO STATE flip yields one replay item", () => {
    const plans: PlansBySlice = {
      S01: { planned: true, tasks: [{ id: "T01", status: "pending" }] },
    };
    // STATE has no T01 unit — the kill-9 window (journaled done, STATE pending).
    const snap = snapshotOf({ milestone: MID, units: [] }, ONE_SLICE, plans);

    const items = detectUnreconciledResults(snap, [doneEvent("S01", "T01")]);
    assert.equal(items.length, 1);
    assert.equal(items[0].key, "S01/T01");
    assert.deepStrictEqual(items[0].unit, { type: "execute-task", slice: "S01", task: "T01" });
    // The mutator flips the task done when applied.
    const next = items[0].mutator({ milestone: MID, units: [] });
    assert.equal(next.units?.find((u) => u.id === "T01" && u.type === "task")?.status, "done");
  });

  test("a done already reflected in STATE yields zero items (idempotent no-op)", () => {
    const plans: PlansBySlice = {
      S01: { planned: true, tasks: [{ id: "T01", status: "done" }] },
    };
    const snap = snapshotOf(
      { milestone: MID, units: [{ id: "T01", type: "task", status: "done" }] },
      ONE_SLICE,
      plans,
    );
    assert.deepStrictEqual(detectUnreconciledResults(snap, [doneEvent("S01", "T01")]), []);
  });

  test("only the LAST done per unit key is considered (tail wins, still one item)", () => {
    const plans: PlansBySlice = {
      S01: { planned: true, tasks: [{ id: "T01", status: "pending" }] },
    };
    const snap = snapshotOf({ milestone: MID, units: [] }, ONE_SLICE, plans);
    const items = detectUnreconciledResults(snap, [doneEvent("S01", "T01"), doneEvent("S01", "T01")]);
    assert.equal(items.length, 1);
  });

  test("multiple distinct unreconciled units each produce an item", () => {
    const plans: PlansBySlice = {
      S01: { planned: true, tasks: [{ id: "T01", status: "pending" }, { id: "T02", status: "pending" }] },
    };
    const snap = snapshotOf({ milestone: MID, units: [] }, ONE_SLICE, plans);
    const items = detectUnreconciledResults(snap, [doneEvent("S01", "T01"), doneEvent("S01", "T02")]);
    assert.deepStrictEqual(items.map((i) => i.key).sort(), ["S01/T01", "S01/T02"]);
  });

  test("non-done and non-result events are ignored", () => {
    const plans: PlansBySlice = {
      S01: { planned: true, tasks: [{ id: "T01", status: "pending" }] },
    };
    const snap = snapshotOf({ milestone: MID, units: [] }, ONE_SLICE, plans);
    const dispatched: ForgeEvent = { ...doneEvent("S01", "T01"), kind: "unit_dispatched", status: "dispatched" };
    const partial: ForgeEvent = { ...doneEvent("S01", "T01"), status: "partial" };
    assert.deepStrictEqual(detectUnreconciledResults(snap, [dispatched, partial]), []);
  });

  // R1 (S03 review-fix) — the REPLAY half: a journaled `complete-slice done` whose
  // flip was lost must be reconstructed as a complete-slice unit (not a plan-slice)
  // so the replay repairs the slice-level kill-9 window. Before the fix the event
  // (carries `slice`, no `task`) was misclassified as plan-slice and treated as
  // already-reflected (a slice unit is present) → SILENTLY skipped.
  test("a journaled complete-slice done with the slice still running yields a slice flip (not misclassified as plan-slice)", () => {
    const completeSliceEvent: ForgeEvent = {
      ts: "2026-07-08T00:00:00Z",
      kind: "unit_result",
      unit: "complete/S01", // the loop's unitKey for complete-slice
      agent: "forge-loop",
      milestone: MID,
      status: "done",
      summary: "slice summary written",
      slice: "S01",
    };
    // STATE: the slice is still `running` (flip lost) — a plan-slice reflection
    // test would call this "already reflected" and skip it. The correct
    // complete-slice reconstruction sees the slice is NOT done → one replay item.
    const snap = snapshotOf(
      { milestone: MID, units: [{ id: "S01", type: "slice", status: "running" }] },
      ONE_SLICE,
      { S01: { planned: true, summaryWritten: true, tasks: [{ id: "T01", status: "done" }] } },
    );

    const items = detectUnreconciledResults(snap, [completeSliceEvent]);
    assert.equal(items.length, 1, "the lost complete-slice flip is detected, not skipped");
    assert.equal(items[0].key, "complete/S01");
    assert.deepStrictEqual(items[0].unit, { type: "complete-slice", slice: "S01" });
    // The mutator flips the slice to done.
    const next = items[0].mutator(snap.state);
    assert.equal(next.units?.find((u) => u.type === "slice" && u.id === "S01")?.status, "done");
  });

  test("a complete-slice done already reflected (slice done in STATE) is an idempotent no-op", () => {
    const ev: ForgeEvent = {
      ts: "2026-07-08T00:00:00Z",
      kind: "unit_result",
      unit: "complete/S01",
      agent: "forge-loop",
      milestone: MID,
      status: "done",
      summary: "s",
      slice: "S01",
    };
    const snap = snapshotOf(
      { milestone: MID, units: [{ id: "S01", type: "slice", status: "done" }] },
      ONE_SLICE,
      { S01: { planned: true, summaryWritten: true, tasks: [{ id: "T01", status: "done" }] } },
    );
    assert.deepStrictEqual(detectUnreconciledResults(snap, [ev]), []);
  });
});
