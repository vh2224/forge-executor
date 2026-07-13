import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatMilestoneFinale } from "../ui/finale.ts";
import { renderReview, writeReview, applyDecision, type ReviewArtifactMeta } from "../review/artifact.ts";
import type { ResolveReviewResult, ResolvedReviewItem } from "../review/resolve.ts";

/** One journal line, matching `state/store.ts` JSONL-append format. */
function ev(o: Record<string, unknown>): string {
  return JSON.stringify(o) + "\n";
}

/** Bare `.gsd/` skeleton (STATE + ROADMAP + S01/T01 plans) shared by the S06/T03 suite-line cases below. */
function writeBaseFixture(dir: string, mid: string): void {
  const mdir = join(dir, ".gsd", "milestones", mid);
  mkdirSync(join(mdir, "slices", "S01", "tasks", "T01"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "forge"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "STATE.md"),
    ["# STATE", "", "```yaml", `milestone: ${mid}`, "phase: complete", "units:", "  - id: S01", "    type: slice", "    status: done", "```", ""].join("\n"),
  );
  writeFileSync(
    join(mdir, `${mid}-ROADMAP.md`),
    [`# ${mid} — Toy`, "", "## Slices", "", "| ID | Nome | Risk | Depends | Status |", "|----|------|------|---------|--------|", "| S01 | Toy slice | low | — | done |", ""].join("\n"),
  );
  writeFileSync(
    join(mdir, "slices", "S01", "S01-PLAN.md"),
    ["# S01 plan", "", "| ID | Task |", "|----|------|", "| T01 | do it |", ""].join("\n"),
  );
  writeFileSync(
    join(mdir, "slices", "S01", "tasks", "T01", "T01-PLAN.md"),
    "---\ntitle: do it\n---\n# T01\n",
  );
}

describe("milestone finale", () => {
  test("never throws on a bare directory (no .gsd at all)", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-finale-"));
    try {
      const out = formatMilestoneFinale(dir, "M-toy");
      assert.match(out, /MILESTONE COMPLETO/);
      assert.match(out, /M-toy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renders counts + G1 authorship from snapshot and journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-finale-"));
    try {
      const mid = "M-toy-finale";
      const mdir = join(dir, ".gsd", "milestones", mid);
      mkdirSync(join(mdir, "slices", "S01", "tasks", "T01"), { recursive: true });
      mkdirSync(join(dir, ".gsd", "forge"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "STATE.md"),
        ["# STATE", "", "```yaml", `milestone: ${mid}`, "phase: complete", "units:", "  - id: S01", "    type: slice", "    status: done", "```", ""].join("\n"),
      );
      writeFileSync(
        join(mdir, `${mid}-ROADMAP.md`),
        [`# ${mid} — Toy`, "", "## Slices", "", "| ID | Nome | Risk | Depends | Status |", "|----|------|------|---------|--------|", "| S01 | Toy slice | low | — | done |", ""].join("\n"),
      );
      writeFileSync(
        join(mdir, "slices", "S01", "S01-PLAN.md"),
        ["# S01 plan", "", "| ID | Task |", "|----|------|", "| T01 | do it |", ""].join("\n"),
      );
      writeFileSync(
        join(mdir, "slices", "S01", "tasks", "T01", "T01-PLAN.md"),
        "---\ntitle: do it\n---\n# T01\n",
      );
      const ev = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
      writeFileSync(
        join(dir, ".gsd", "forge", "events.jsonl"),
        ev({ ts: "2026-07-11T10:00:00Z", kind: "unit_dispatched", unit: "S01/T01", agent: "forge-loop", milestone: mid, status: "dispatched", summary: "" }) +
          ev({ ts: "2026-07-11T10:05:00Z", kind: "unit_result", unit: "S01/T01", agent: "forge-loop", milestone: mid, status: "done", summary: "did it", model: "claude-code/claude-sonnet-5", provider: "claude-code" }),
      );

      const out = formatMilestoneFinale(dir, mid);
      assert.match(out, /1\/1 slices/);
      assert.match(out, /1 unidades concluídas/);
      assert.match(out, /claude-code\/claude-sonnet-5 ×1/);
      assert.match(out, /5m00s/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renders the review digest between stats and the LEDGER line when a slice has a pending item", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-finale-"));
    try {
      const mid = "M-toy-finale";
      const mdir = join(dir, ".gsd", "milestones", mid);
      mkdirSync(join(mdir, "slices", "S01", "tasks", "T01"), { recursive: true });
      mkdirSync(join(dir, ".gsd", "forge"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "STATE.md"),
        ["# STATE", "", "```yaml", `milestone: ${mid}`, "phase: complete", "units:", "  - id: S01", "    type: slice", "    status: done", "```", ""].join("\n"),
      );
      writeFileSync(
        join(mdir, `${mid}-ROADMAP.md`),
        [`# ${mid} — Toy`, "", "## Slices", "", "| ID | Nome | Risk | Depends | Status |", "|----|------|------|---------|--------|", "| S01 | Toy slice | low | — | done |", ""].join("\n"),
      );
      writeFileSync(
        join(mdir, "slices", "S01", "S01-PLAN.md"),
        ["# S01 plan", "", "| ID | Task |", "|----|------|", "| T01 | do it |", ""].join("\n"),
      );
      writeFileSync(
        join(mdir, "slices", "S01", "tasks", "T01", "T01-PLAN.md"),
        "---\ntitle: do it\n---\n# T01\n",
      );

      // Pending review item in S01, deferred to the milestone-final triage.
      const reviewMeta: ReviewArtifactMeta = {
        milestoneId: mid,
        slice: "S01",
        sliceTitle: "Toy slice",
        reviewedOn: "2026-07-12",
        rounds: 1,
      };
      const reviewItem: ResolvedReviewItem = {
        id: "R1",
        pathLine: "src/toy.ts:1",
        severity: "high",
        claim: "toy claim",
        suggestedFix: "toy fix",
        challenge: "real?",
        defense: { verdict: "refuted", rationale: "defense" },
        rebuttal: { verdict: "maintained", rationale: "rebuttal" },
        resolution: "open",
      };
      const reviewResult: ResolveReviewResult = {
        noFlags: false,
        items: [reviewItem],
        counts: { resolved: 0, conceded: 0, open: 1 },
        warnings: [],
      };
      const md = renderReview(reviewMeta, reviewResult);
      const written = writeReview(dir, mid, "S01", md);
      applyDecision(written.path, "R1", "deferido → triagem no fim da milestone");

      const out = formatMilestoneFinale(dir, mid);
      assert.match(out, /⚖ 1 aberta\(s\)/);
      assert.match(out, /R1 \(S01\): toy claim/);
      assert.match(out, /S01-REVIEW\.md/);

      // The digest sits between the stats block and the LEDGER close-out line.
      const digestIdx = out.indexOf("⚖ 1 aberta(s)");
      const ledgerIdx = out.indexOf("📒 LEDGER.md");
      assert.ok(digestIdx > 0 && digestIdx < ledgerIdx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // S06/T03 — advisory suite line, sourced from the journal's `suite_result`
  // event (T02's contract 2). Additive: no event → no line.

  test("suite line: red status with counts renders '⚠ suíte: N reds (M passed)'", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-finale-"));
    try {
      const mid = "M-toy-finale";
      writeBaseFixture(dir, mid);
      writeFileSync(
        join(dir, ".gsd", "forge", "events.jsonl"),
        ev({ ts: "2026-07-11T10:00:00Z", kind: "unit_result", unit: "S01/T01", agent: "forge-loop", milestone: mid, status: "done", summary: "did it" }) +
          ev({
            ts: "2026-07-11T10:06:00Z",
            kind: "suite_result",
            unit: "complete-milestone",
            agent: "loop",
            milestone: mid,
            status: "red",
            summary: "suíte: 1699 passed, 2 failed (pnpm run test:unit)",
            suite_passed: 1699,
            suite_failed: 2,
          }),
      );

      const out = formatMilestoneFinale(dir, mid);
      assert.match(out, / ⚠ suíte: 2 reds \(1699 passed\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("suite line: green status with counts renders '✓ suíte verde · M passed'", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-finale-"));
    try {
      const mid = "M-toy-finale";
      writeBaseFixture(dir, mid);
      writeFileSync(
        join(dir, ".gsd", "forge", "events.jsonl"),
        ev({ ts: "2026-07-11T10:00:00Z", kind: "unit_result", unit: "S01/T01", agent: "forge-loop", milestone: mid, status: "done", summary: "did it" }) +
          ev({
            ts: "2026-07-11T10:06:00Z",
            kind: "suite_result",
            unit: "complete-milestone",
            agent: "loop",
            milestone: mid,
            status: "green",
            summary: "suíte: 1699 passed (pnpm run test:unit)",
            suite_passed: 1699,
          }),
      );

      const out = formatMilestoneFinale(dir, mid);
      assert.match(out, / ✓ suíte verde · 1699 passed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("suite line: skipped status renders '⚠ suíte: não executada (skipped)'", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-finale-"));
    try {
      const mid = "M-toy-finale";
      writeBaseFixture(dir, mid);
      writeFileSync(
        join(dir, ".gsd", "forge", "events.jsonl"),
        ev({ ts: "2026-07-11T10:00:00Z", kind: "unit_result", unit: "S01/T01", agent: "forge-loop", milestone: mid, status: "done", summary: "did it" }) +
          ev({
            ts: "2026-07-11T10:06:00Z",
            kind: "suite_result",
            unit: "complete-milestone",
            agent: "loop",
            milestone: mid,
            status: "skipped",
            summary: "suíte: completer não reportou resultado no SUMMARY",
          }),
      );

      const out = formatMilestoneFinale(dir, mid);
      assert.match(out, / ⚠ suíte: não executada \(skipped\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no suite_result event -> output is byte-identical to the pre-S06 rendering (additive contract)", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-finale-"));
    try {
      const mid = "M-toy-finale";
      writeBaseFixture(dir, mid);
      const journalPath = join(dir, ".gsd", "forge", "events.jsonl");
      writeFileSync(
        journalPath,
        ev({ ts: "2026-07-11T10:00:00Z", kind: "unit_result", unit: "S01/T01", agent: "forge-loop", milestone: mid, status: "done", summary: "did it" }),
      );

      const withoutSuite = formatMilestoneFinale(dir, mid);
      assert.doesNotMatch(withoutSuite, /suíte/, "no suite_result event -> no suite line at all");

      // Append a suite_result event to the SAME journal — the only diff
      // between the two renders must be the inserted suite line, proving the
      // no-event path never mutates anything else in the banner.
      writeFileSync(
        journalPath,
        readFileSync(journalPath, "utf-8") +
          ev({
            // Same ts as the sole unit_result above — keeps the journal's
            // first/last span at zero so the appended event only ever adds
            // the suite line, not a `· Nm00s` span change too.
            ts: "2026-07-11T10:00:00Z",
            kind: "suite_result",
            unit: "complete-milestone",
            agent: "loop",
            milestone: mid,
            status: "green",
            summary: "suíte: 1699 passed (pnpm run test:unit)",
            suite_passed: 1699,
          }),
      );
      const withSuite = formatMilestoneFinale(dir, mid);
      const suiteLine = " ✓ suíte verde · 1699 passed";
      assert.match(withSuite, new RegExp(suiteLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(
        withSuite
          .split("\n")
          .filter((l) => l !== suiteLine)
          .join("\n"),
        withoutSuite,
        "removing exactly the suite line from the with-event render reproduces the no-event render byte-for-byte",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
