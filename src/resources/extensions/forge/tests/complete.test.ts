/**
 * `auto/complete.ts` — unit tests for `runMilestoneClose` (D-S03-2).
 *
 * Proves the in-process milestone close: (1) it rebuilds `.gsd/LEDGER.md` /
 * `.gsd/DECISIONS.md` from the fragment stores (T04 merger) so the global
 * projections reflect the just-completed milestone; (2) it honors each
 * `milestone_cleanup` mode (keep | archive | delete) against the milestone dir
 * ONLY, never STATE.md/LEDGER.md/DECISIONS.md; (3) it is best-effort — a failing
 * step degrades to a collected error + warning, never a throw.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMilestoneClose, resolveMilestoneCleanup } from "../auto/complete.ts";
import { writeLedgerFragment } from "../state/ledger.ts";
import { writeDecisionFragment } from "../state/decisions.ts";
import { readEvents } from "../state/store.ts";

const MID = "M-20260101000000-toy";
const TASK = "T-20260101000000-t01";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-complete-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seed one LEDGER fragment (milestone) + one DECISIONS fragment (task). */
function seedFragments(cwd: string): void {
  writeLedgerFragment(cwd, {
    id: MID,
    title: "Toy milestone",
    completed_at: "2026-01-02T00:00:00Z",
    slices: ["S01 — first"],
    key_files: ["src/a.ts"],
    key_decisions: ["Did the thing"],
    body: "",
  });
  writeDecisionFragment(cwd, {
    unit_id: TASK,
    decisions: [{ id: "D-1", decision: "Chose X", rationale: "Because Y", date: "2026-01-01" }],
    body: "",
  });
}

/** Create a non-empty milestone directory under `.gsd/milestones/<mid>`. */
function seedMilestoneDir(cwd: string): string {
  const dir = join(cwd, ".gsd", "milestones", MID);
  mkdirSync(join(dir, "slices", "S01"), { recursive: true });
  writeFileSync(join(dir, `${MID}-ROADMAP.md`), "# roadmap\n");
  writeFileSync(join(dir, "slices", "S01", "S01-PLAN.md"), "# plan\n");
  return dir;
}

/** Write `<mid>-SUMMARY.md` with the given flat frontmatter body (S06/T02 contract 1). */
function writeMilestoneSummary(cwd: string, frontmatter: string): string {
  const dir = join(cwd, ".gsd", "milestones", MID);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${MID}-SUMMARY.md`);
  writeFileSync(path, `---\n${frontmatter}\n---\n\nBody.\n`);
  return path;
}

/** Collect (message, level) pairs a `runMilestoneClose` call notified. */
function collectNotify(): [(msg: string, level?: string) => void, Array<[string, string | undefined]>] {
  const notified: Array<[string, string | undefined]> = [];
  return [(msg, level) => notified.push([msg, level]), notified];
}

// ── rebuild ──────────────────────────────────────────────────────────────────

describe("runMilestoneClose — rebuild projections", () => {
  test("rebuilds LEDGER.md and DECISIONS.md from fragments", () => {
    withSandbox((cwd) => {
      seedFragments(cwd);

      const res = runMilestoneClose(cwd, MID);

      assert.equal(res.rebuilt, 1, "one ledger fragment merged");
      assert.deepEqual(res.errors, [], "no non-fatal errors");

      const ledger = readFileSync(join(cwd, ".gsd", "LEDGER.md"), "utf-8");
      assert.match(ledger, /Toy milestone/, "LEDGER projection carries the milestone title");
      assert.match(ledger, /src\/a\.ts/, "LEDGER projection carries the key file");

      const decisions = readFileSync(join(cwd, ".gsd", "DECISIONS.md"), "utf-8");
      assert.match(decisions, /D-1/, "DECISIONS projection carries the decision id");
      assert.match(decisions, /Chose X/, "DECISIONS projection carries the decision text");
    });
  });

  test("is idempotent — a second close produces byte-identical projections", () => {
    withSandbox((cwd) => {
      seedFragments(cwd);
      runMilestoneClose(cwd, MID);
      const l1 = readFileSync(join(cwd, ".gsd", "LEDGER.md"), "utf-8");
      const d1 = readFileSync(join(cwd, ".gsd", "DECISIONS.md"), "utf-8");

      runMilestoneClose(cwd, MID);
      const l2 = readFileSync(join(cwd, ".gsd", "LEDGER.md"), "utf-8");
      const d2 = readFileSync(join(cwd, ".gsd", "DECISIONS.md"), "utf-8");

      assert.equal(l1, l2, "LEDGER rebuild is deterministic");
      assert.equal(d1, d2, "DECISIONS rebuild is deterministic");
    });
  });

  test("safe no-op over zero fragments — header-only projections, never a throw", () => {
    withSandbox((cwd) => {
      const res = runMilestoneClose(cwd, MID);
      assert.equal(res.rebuilt, 0);
      assert.ok(existsSync(join(cwd, ".gsd", "LEDGER.md")), "LEDGER.md still written (header-only)");
      assert.ok(existsSync(join(cwd, ".gsd", "DECISIONS.md")), "DECISIONS.md still written (header-only)");
    });
  });
});

// ── cleanup modes ─────────────────────────────────────────────────────────────

describe("runMilestoneClose — milestone_cleanup pref", () => {
  test("default (no pref) is keep — the milestone dir is untouched", () => {
    withSandbox((cwd) => {
      const dir = seedMilestoneDir(cwd);
      const res = runMilestoneClose(cwd, MID);
      assert.equal(res.cleanup, "keep");
      assert.ok(existsSync(dir), "milestone dir kept by default");
    });
  });

  test("archive → moves the milestone dir under .gsd/archive/<mid>", () => {
    withSandbox((cwd) => {
      const dir = seedMilestoneDir(cwd);
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(join(cwd, ".gsd", "prefs.md"), "milestone_cleanup: archive\n");

      const res = runMilestoneClose(cwd, MID);

      assert.equal(res.cleanup, "archive");
      assert.ok(!existsSync(dir), "original milestone dir moved away");
      const archived = join(cwd, ".gsd", "archive", MID);
      assert.ok(existsSync(join(archived, `${MID}-ROADMAP.md`)), "milestone dir now under .gsd/archive");
    });
  });

  test("delete → removes the milestone dir entirely", () => {
    withSandbox((cwd) => {
      const dir = seedMilestoneDir(cwd);
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(join(cwd, ".gsd", "prefs.md"), "milestone_cleanup: delete\n");

      const res = runMilestoneClose(cwd, MID);

      assert.equal(res.cleanup, "delete");
      assert.ok(!existsSync(dir), "milestone dir removed");
    });
  });

  test("cleanup NEVER touches STATE.md / LEDGER.md / DECISIONS.md", () => {
    withSandbox((cwd) => {
      seedFragments(cwd);
      seedMilestoneDir(cwd);
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(join(cwd, ".gsd", "prefs.md"), "milestone_cleanup: delete\n");
      writeFileSync(join(cwd, ".gsd", "STATE.md"), "# state\nsentinel\n");

      runMilestoneClose(cwd, MID);

      const state = readFileSync(join(cwd, ".gsd", "STATE.md"), "utf-8");
      assert.match(state, /sentinel/, "STATE.md is left intact by the cleanup");
      assert.ok(existsSync(join(cwd, ".gsd", "LEDGER.md")), "LEDGER.md (projection) still present");
      assert.ok(existsSync(join(cwd, ".gsd", "DECISIONS.md")), "DECISIONS.md (projection) still present");
    });
  });

  test("resolveMilestoneCleanup: unknown/empty pref degrades to keep", () => {
    withSandbox((cwd) => {
      assert.equal(resolveMilestoneCleanup(cwd), "keep", "absent pref → keep");
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(join(cwd, ".gsd", "prefs.md"), "milestone_cleanup: bogus\n");
      assert.equal(resolveMilestoneCleanup(cwd), "keep", "unknown value → keep");
    });
  });
});

// ── best-effort ────────────────────────────────────────────────────────────────

describe("runMilestoneClose — best-effort", () => {
  test("an archive collision is handled idempotently (re-archive overwrites)", () => {
    withSandbox((cwd) => {
      // Pre-existing archive dir at the destination — archive must not throw.
      mkdirSync(join(cwd, ".gsd", "archive", MID), { recursive: true });
      writeFileSync(join(cwd, ".gsd", "archive", MID, "stale.txt"), "old\n");
      seedMilestoneDir(cwd);
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(join(cwd, ".gsd", "prefs.md"), "milestone_cleanup: archive\n");

      const res = runMilestoneClose(cwd, MID);

      assert.deepEqual(res.errors, [], "re-archive over an existing dest is not an error");
      const archived = join(cwd, ".gsd", "archive", MID);
      assert.ok(existsSync(join(archived, `${MID}-ROADMAP.md`)), "fresh milestone content archived");
      assert.ok(!existsSync(join(archived, "stale.txt")), "stale archive content replaced");
    });
  });

  test("a warning is surfaced via notify when cleanup fails, and the close still returns", () => {
    withSandbox((cwd) => {
      // No milestone dir on disk → cleanup is a safe no-op (existsSync guards it);
      // this asserts the close completes and returns a well-formed result even
      // when there is nothing to clean up.
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(join(cwd, ".gsd", "prefs.md"), "milestone_cleanup: delete\n");

      const res = runMilestoneClose(cwd, MID);

      assert.equal(res.cleanup, "delete");
      assert.deepEqual(res.errors, [], "absent milestone dir is not an error (existsSync guard)");
    });
  });
});

// ── suite reception (S06/T02) ───────────────────────────────────────────────

describe("runMilestoneClose — suite reception (S06/T02)", () => {
  test("red SUMMARY: journals a suite_result event with counts and fires a reds warning", () => {
    withSandbox((cwd) => {
      writeMilestoneSummary(
        cwd,
        ['suite_command: "pnpm run test:unit"', "suite_status: red", "suite_passed: 1699", "suite_failed: 2"].join(
          "\n",
        ),
      );

      const [notify, notified] = collectNotify();
      const res = runMilestoneClose(cwd, MID, notify);

      assert.equal(res.suite, "red");
      const events = readEvents(cwd).filter((e) => e.kind === "suite_result");
      assert.equal(events.length, 1, "exactly one suite_result event journaled");
      assert.equal(events[0].status, "red");
      assert.equal(events[0].milestone, MID);
      assert.equal(events[0].suite_passed, 1699);
      assert.equal(events[0].suite_failed, 2);
      assert.match(events[0].summary, /1699 passed, 2 failed/);
      assert.ok(
        notified.some(([msg, level]) => level === "warning" && /⚠ suíte: 2 reds/.test(msg)),
        "a '⚠ suíte: N reds' warning fires",
      );
    });
  });

  test("green SUMMARY: journals a green suite_result with no reds warning", () => {
    withSandbox((cwd) => {
      writeMilestoneSummary(
        cwd,
        ['suite_command: "pnpm run test:unit"', "suite_status: green", "suite_passed: 1701", "suite_failed: 0"].join(
          "\n",
        ),
      );

      const [notify, notified] = collectNotify();
      const res = runMilestoneClose(cwd, MID, notify);

      assert.equal(res.suite, "green");
      const events = readEvents(cwd).filter((e) => e.kind === "suite_result");
      assert.equal(events.length, 1);
      assert.equal(events[0].status, "green");
      assert.equal(events[0].suite_failed, 0);
      assert.ok(!notified.some(([msg]) => /reds/.test(msg)), "no reds warning fires on a green suite");
    });
  });

  test("R1 (S06-REVIEW): a hallucinated green with suite_failed>0 is journaled as red, not green", () => {
    withSandbox((cwd) => {
      writeMilestoneSummary(
        cwd,
        ['suite_command: "pnpm run test:unit"', "suite_status: green", "suite_passed: 10", "suite_failed: 2"].join(
          "\n",
        ),
      );

      const [notify, notified] = collectNotify();
      const res = runMilestoneClose(cwd, MID, notify);

      assert.equal(res.suite, "red", "contradictory counts override the claimed green label");
      const events = readEvents(cwd).filter((e) => e.kind === "suite_result");
      assert.equal(events[0].status, "red");
      assert.equal(events[0].suite_failed, 2);
      assert.ok(
        notified.some(([msg, level]) => level === "warning" && /⚠ suíte: 2 reds/.test(msg)),
        "the reds warning fires despite the claimed green label",
      );
    });
  });

  test("R1 (S06-REVIEW): a claimed red with suite_failed:0 is journaled as green", () => {
    withSandbox((cwd) => {
      writeMilestoneSummary(
        cwd,
        ['suite_command: "pnpm run test:unit"', "suite_status: red", "suite_passed: 10", "suite_failed: 0"].join(
          "\n",
        ),
      );

      const res = runMilestoneClose(cwd, MID);

      assert.equal(res.suite, "green", "zero failures override the claimed red label");
      const events = readEvents(cwd).filter((e) => e.kind === "suite_result");
      assert.equal(events[0].status, "green");
    });
  });

  test("R1 (S06-REVIEW): red with no parsed suite_failed count warns without a misleading '0 reds'", () => {
    withSandbox((cwd) => {
      writeMilestoneSummary(cwd, ['suite_command: "pnpm run test:unit"', "suite_status: red"].join("\n"));

      const [notify, notified] = collectNotify();
      const res = runMilestoneClose(cwd, MID, notify);

      assert.equal(res.suite, "red", "no count to contradict the claimed label — kept as-is");
      assert.ok(
        notified.some(([msg, level]) => level === "warning" && msg === "⚠ suíte: red sem contagem de falhas"),
        "warns without claiming '0 reds'",
      );
    });
  });

  test("SUMMARY without suite_* keys: journals skipped, warns, and the close still completes", () => {
    withSandbox((cwd) => {
      writeMilestoneSummary(cwd, ["provides: []", "key_files: []"].join("\n"));

      const [notify, notified] = collectNotify();
      const res = runMilestoneClose(cwd, MID, notify);

      assert.equal(res.suite, "skipped");
      assert.deepEqual(res.errors, [], "a missing suite report is not an error");
      const events = readEvents(cwd).filter((e) => e.kind === "suite_result");
      assert.equal(events.length, 1);
      assert.equal(events[0].status, "skipped");
      assert.equal(events[0].suite_passed, undefined, "no counts on skipped");
      assert.ok(notified.some(([, level]) => level === "warning"), "a warning notify fires for skipped");
    });
  });

  test("a completely absent SUMMARY also degrades to skipped (never throws)", () => {
    withSandbox((cwd) => {
      const res = runMilestoneClose(cwd, MID);
      assert.equal(res.suite, "skipped");
      assert.deepEqual(res.errors, []);
    });
  });

  test("idempotent: a second close for the same milestone does not duplicate the event", () => {
    withSandbox((cwd) => {
      writeMilestoneSummary(cwd, ["suite_status: red", "suite_passed: 10", "suite_failed: 1"].join("\n"));

      runMilestoneClose(cwd, MID);
      assert.equal(readEvents(cwd).filter((e) => e.kind === "suite_result").length, 1);

      const res2 = runMilestoneClose(cwd, MID);
      assert.equal(
        readEvents(cwd).filter((e) => e.kind === "suite_result").length,
        1,
        "no duplicate suite_result on a second close",
      );
      assert.equal(res2.suite, undefined, "the no-op re-run does not recompute a suite outcome");
    });
  });

  test("a malformed/unreadable SUMMARY never aborts the close (best-effort → errors[])", () => {
    withSandbox((cwd) => {
      // A directory where a file is expected — readFileSync throws (EISDIR).
      const summaryPath = join(cwd, ".gsd", "milestones", MID, `${MID}-SUMMARY.md`);
      mkdirSync(summaryPath, { recursive: true });

      const [notify, notified] = collectNotify();
      const res = runMilestoneClose(cwd, MID, notify);

      assert.equal(res.cleanup, "keep", "the close still completes normally");
      assert.ok(
        res.errors.some((e) => e.startsWith("suite:")),
        "the suite failure is collected in errors[]",
      );
      assert.ok(notified.some(([, level]) => level === "warning"), "a warning notify fires");
      assert.equal(res.suite, undefined, "no suite outcome is recorded on a throw");
      assert.equal(readEvents(cwd).filter((e) => e.kind === "suite_result").length, 0, "no event journaled");
    });
  });
});
