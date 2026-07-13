import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot } from "../auto/snapshot.ts";
import { updateState } from "../state/store.ts";
import type { StateDoc } from "../state/types.ts";

// Every test runs inside a fresh mkdtemp sandbox as `cwd`. `readSnapshot`
// resolves `<cwd>/.gsd/...`, so nothing here can touch the live repo `.gsd/`.
function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-snapshot-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MID = "M-toy";

/** Write the real on-disk milestone layout for a 1-slice / 2-task toy. */
function writeToyLayout(cwd: string, state: StateDoc): void {
  updateState(cwd, () => state);

  const milestoneDir = join(cwd, ".gsd", "milestones", MID);
  const slicesDir = join(milestoneDir, "slices", "S01");
  mkdirSync(join(slicesDir, "tasks", "T01"), { recursive: true });
  mkdirSync(join(slicesDir, "tasks", "T02"), { recursive: true });

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
  writeFileSync(
    join(slicesDir, "tasks", "T02", "T02-PLAN.md"),
    `---\nid: T02\nslice: S01\ntitle: "Task dois"\n---\n\n# T02\n`,
  );
}

describe("readSnapshot", () => {
  test("reads STATE + ROADMAP + plans and overlays task status from STATE units", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, {
        milestone: MID,
        units: [{ id: "T01", type: "task", status: "done", slice: "S01" }],
      });

      const snap = readSnapshot(cwd);

      assert.equal(snap.milestoneId, MID);
      assert.equal(snap.roadmap.length, 1);
      assert.equal(snap.roadmap[0].id, "S01");

      const s01 = snap.plans.S01;
      assert.ok(s01, "S01 plan info present");
      assert.equal(s01.planned, true, "S01-PLAN.md exists ⇒ planned");
      assert.deepEqual(
        s01.tasks,
        [
          { id: "T01", status: "done" }, // overlaid from the STATE unit
          { id: "T02", status: "pending" }, // no unit ⇒ default pending
        ],
        "task status is overlaid from STATE, PLAN files never rewritten",
      );

      assert.equal(snap.titles.milestone, "Toy milestone");
      assert.equal(snap.titles.slice.S01, "Primeira slice");
      assert.equal(snap.titles.task["S01/T01"], "Task um");
      assert.equal(snap.titles.task["S01/T02"], "Task dois");
    });
  });

  test("STATE unit is authoritative — a done task overlays a plan with no unit as pending", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      const snap = readSnapshot(cwd);
      assert.deepEqual(snap.plans.S01.tasks, [
        { id: "T01", status: "pending" },
        { id: "T02", status: "pending" },
      ]);
    });
  });

  test("degrades to empty defaults when the milestone tree is missing (first run)", () => {
    withSandbox((cwd) => {
      // STATE names a milestone but no ROADMAP/plans exist yet.
      updateState(cwd, () => ({ milestone: MID }));
      const snap = readSnapshot(cwd);
      assert.equal(snap.milestoneId, MID);
      assert.deepEqual(snap.roadmap, []);
      assert.deepEqual(snap.plans, {});
      assert.equal(snap.titles.milestone, undefined);
    });
  });

  test("degrades to a bare snapshot when STATE has no milestone at all", () => {
    withSandbox((cwd) => {
      const snap = readSnapshot(cwd);
      assert.equal(snap.milestoneId, "");
      assert.deepEqual(snap.roadmap, []);
      assert.deepEqual(snap.plans, {});
    });
  });

  test("summaryWritten and milestoneSummaryWritten degrade to false when the SUMMARY files are absent", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      const snap = readSnapshot(cwd);
      assert.equal(snap.plans.S01.summaryWritten, false, "no S01-SUMMARY.md ⇒ false");
      assert.equal(snap.milestoneSummaryWritten, false, "no <mid>-SUMMARY.md ⇒ false");
    });
  });

  test("summaryWritten is true once S##-SUMMARY.md exists on disk", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      const slicesDir = join(cwd, ".gsd", "milestones", MID, "slices", "S01");
      writeFileSync(join(slicesDir, "S01-SUMMARY.md"), `---\nid: S01\n---\n# done\n`);

      const snap = readSnapshot(cwd);
      assert.equal(snap.plans.S01.summaryWritten, true);
      assert.equal(snap.milestoneSummaryWritten, false, "milestone SUMMARY still absent");
    });
  });

  test("milestoneSummaryWritten is true once <mid>-SUMMARY.md exists on disk", () => {
    withSandbox((cwd) => {
      writeToyLayout(cwd, { milestone: MID, units: [] });
      const milestoneDir = join(cwd, ".gsd", "milestones", MID);
      writeFileSync(join(milestoneDir, `${MID}-SUMMARY.md`), `---\nid: ${MID}\n---\n# done\n`);

      const snap = readSnapshot(cwd);
      assert.equal(snap.milestoneSummaryWritten, true);
      assert.equal(snap.plans.S01.summaryWritten, false, "slice SUMMARY still absent");
    });
  });

  test("bare snapshot (no milestone) reports milestoneSummaryWritten=false", () => {
    withSandbox((cwd) => {
      const snap = readSnapshot(cwd);
      assert.equal(snap.milestoneSummaryWritten, false);
    });
  });

  test("slice with a plan but no tasks directory yields planned=true, tasks=[]", () => {
    withSandbox((cwd) => {
      updateState(cwd, () => ({ milestone: MID }));
      const milestoneDir = join(cwd, ".gsd", "milestones", MID);
      const slicesDir = join(milestoneDir, "slices", "S01");
      mkdirSync(slicesDir, { recursive: true });
      writeFileSync(
        join(milestoneDir, `${MID}-ROADMAP.md`),
        `# M\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | s | med | — | pending |\n`,
      );
      writeFileSync(join(slicesDir, "S01-PLAN.md"), `---\nid: S01\n---\n# plan\n`);

      const snap = readSnapshot(cwd);
      assert.equal(snap.plans.S01.planned, true);
      assert.deepEqual(snap.plans.S01.tasks, []);
    });
  });
});

test("snapshot overlay is slice-qualified — S01's done tasks never mark S02's same-id tasks as executed", () => {
  // Live M3/S02 incident (2026-07-11): the overlay's bare-id lookup let S01's
  // stamped done T01 satisfy S02/T01, so derive dispatched S02/T05 first.
  withSandbox((cwd) => {
    const mid = "M-x";
    const mdir = join(cwd, ".gsd", "milestones", mid);
    for (const sl of ["S01", "S02"]) {
      mkdirSync(join(mdir, "slices", sl, "tasks", "T01"), { recursive: true });
      writeFileSync(
        join(mdir, "slices", sl, `${sl}-PLAN.md`),
        `---\nid: ${sl}\n---\n# plan\n`,
      );
      writeFileSync(
        join(mdir, "slices", sl, "tasks", "T01", "T01-PLAN.md"),
        `---\nid: T01\nslice: ${sl}\nmilestone: ${mid}\ntitle: "t"\n---\n# T01\n`,
      );
    }
    writeFileSync(
      join(mdir, `${mid}-ROADMAP.md`),
      `# M\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | a | low | — | done |\n| S02 | b | low | S01 | pending |\n`,
    );
    writeFileSync(
      join(cwd, ".gsd", "STATE.md"),
      "# STATE\n\n```yaml\nmilestone: " + mid + "\nunits:\n  - id: S01\n    type: slice\n    status: done\n  - id: T01\n    type: task\n    status: done\n    slice: S01\n```\n",
    );
    const snap = readSnapshot(cwd);
    assert.equal(snap.plans["S01"].tasks[0].status, "done", "S01/T01 keeps its own done");
    assert.equal(snap.plans["S02"].tasks[0].status, "pending", "S02/T01 must NOT inherit S01's done");
  });
});

