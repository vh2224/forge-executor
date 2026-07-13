import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { writeLedgerFragment, type LedgerEntry } from "../state/ledger.ts";
import { writeDecisionFragment, type DecisionFragment } from "../state/decisions.ts";
import { writeCheckerFragment } from "../gates/checker-memory.ts";
import { rebuildProjections } from "../state/merger.ts";
import { writeMemoryFragment, type MemoryFragment } from "../memory/memory-store.ts";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-merger-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ledgerEntry(id: string, completed_at: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    title: `Milestone ${id}`,
    completed_at,
    slices: ["S01 — one"],
    key_files: ["src/a.ts"],
    key_decisions: ["Decided something"],
    body: "Body.",
    ...overrides,
  };
}

function decisionFragment(unit_id: string, rows: DecisionFragment["decisions"]): DecisionFragment {
  return { unit_id, decisions: rows, body: "" };
}

const LEDGER_MD = (cwd: string) => join(cwd, ".gsd", "LEDGER.md");
const DECISIONS_MD = (cwd: string) => join(cwd, ".gsd", "DECISIONS.md");
const CHECKER_MD = (cwd: string) => join(cwd, ".gsd", "CHECKER.md");
const AUTO_MEMORY_MD = (cwd: string) => join(cwd, ".gsd", "AUTO-MEMORY.md");

const FIXED_NOW = Date.parse("2026-02-01T00:00:00Z");

/** Milestone id threaded into the milestone-namespaced checker store (R2). */
const MID = "M-20260101000000-a";

describe("rebuildProjections — LEDGER.md", () => {
  test("renders fragments ordered by completed_at ascending", () => {
    withSandbox((cwd) => {
      writeLedgerFragment(cwd, ledgerEntry("M-20260102000000-b", "2026-02-01T00:00:00Z"));
      writeLedgerFragment(cwd, ledgerEntry("M-20260101000000-a", "2026-01-01T00:00:00Z"));

      const res = rebuildProjections(cwd);
      assert.equal(res.ledger, 2);
      assert.deepEqual(res.errors, []);

      const out = readFileSync(LEDGER_MD(cwd), "utf-8");
      const aIdx = out.indexOf("M-20260101000000-a");
      const bIdx = out.indexOf("M-20260102000000-b");
      assert.ok(aIdx > 0 && bIdx > 0);
      assert.ok(aIdx < bIdx, "earlier completed_at appears first");
      assert.ok(out.includes("**Slices:** S01 — one"));
    });
  });
});

describe("rebuildProjections — DECISIONS.md", () => {
  test("renders the | ID | Decision | Rationale | Date | table, dedup by ID, sorted by date", () => {
    withSandbox((cwd) => {
      writeDecisionFragment(
        cwd,
        decisionFragment("M-20260101000000-a", [
          { id: "D2", decision: "Use temp+rename", rationale: "atomic", date: "2026-01-02" },
          { id: "D1", decision: "Single writer", rationale: "no lock", date: "2026-01-01" },
        ]),
      );
      writeDecisionFragment(
        cwd,
        decisionFragment("M-20260102000000-b", [
          // Duplicate ID D1 — must be deduped (first occurrence wins).
          { id: "D1", decision: "DUPLICATE", rationale: "dup", date: "2026-01-05" },
          { id: "D3", decision: "Fragment stores", rationale: "durable", date: "2026-01-03" },
        ]),
      );

      const res = rebuildProjections(cwd);
      assert.equal(res.decisions, 3, "3 unique decisions (D1 deduped)");

      const out = readFileSync(DECISIONS_MD(cwd), "utf-8");
      assert.ok(out.includes("| ID | Decision | Rationale | Date |"));
      // Dedup: DUPLICATE row must not appear.
      assert.ok(!out.includes("DUPLICATE"));
      // Sorted by date ascending: D1(01) < D2(02) < D3(03).
      const d1 = out.indexOf("| D1 |");
      const d2 = out.indexOf("| D2 |");
      const d3 = out.indexOf("| D3 |");
      assert.ok(d1 < d2 && d2 < d3, "rows sorted by date");
    });
  });
});

describe("rebuildProjections — idempotency & no-op", () => {
  test("running twice produces byte-identical projections", () => {
    withSandbox((cwd) => {
      writeLedgerFragment(cwd, ledgerEntry("M-20260101000000-a", "2026-01-01T00:00:00Z"));
      writeDecisionFragment(
        cwd,
        decisionFragment("M-20260101000000-a", [
          { id: "D1", decision: "x", rationale: "y", date: "2026-01-01" },
        ]),
      );
      writeCheckerFragment(cwd, MID, "S01", { dimension: "coverage", verdict: "gap", note: "n" });

      rebuildProjections(cwd, MID);
      const ledger1 = readFileSync(LEDGER_MD(cwd), "utf-8");
      const decisions1 = readFileSync(DECISIONS_MD(cwd), "utf-8");
      const checker1 = readFileSync(CHECKER_MD(cwd), "utf-8");

      rebuildProjections(cwd, MID);
      const ledger2 = readFileSync(LEDGER_MD(cwd), "utf-8");
      const decisions2 = readFileSync(DECISIONS_MD(cwd), "utf-8");
      const checker2 = readFileSync(CHECKER_MD(cwd), "utf-8");

      assert.equal(ledger1, ledger2);
      assert.equal(decisions1, decisions2);
      assert.equal(checker1, checker2);
    });
  });

  test("zero fragments is a safe no-op (no throw, empty projections)", () => {
    withSandbox((cwd) => {
      const res = rebuildProjections(cwd);
      assert.equal(res.ledger, 0);
      assert.equal(res.decisions, 0);
      assert.equal(res.checker, 0);
      assert.deepEqual(res.errors, []);
      assert.ok(existsSync(LEDGER_MD(cwd)));
      assert.ok(existsSync(DECISIONS_MD(cwd)));
      assert.ok(existsSync(CHECKER_MD(cwd)));
      assert.ok(readFileSync(LEDGER_MD(cwd), "utf-8").includes("_No completed milestones yet._"));
      assert.ok(readFileSync(CHECKER_MD(cwd), "utf-8").includes("_No recurring checker findings yet._"));

      // Rerun over zero fragments is still byte-identical.
      const ledger1 = readFileSync(LEDGER_MD(cwd), "utf-8");
      const checker1 = readFileSync(CHECKER_MD(cwd), "utf-8");
      rebuildProjections(cwd);
      assert.equal(readFileSync(LEDGER_MD(cwd), "utf-8"), ledger1);
      assert.equal(readFileSync(CHECKER_MD(cwd), "utf-8"), checker1);
    });
  });
});

describe("rebuildProjections — CHECKER.md", () => {
  test("renders fragments ordered by slice ascending, tolerates synthetic slice ids, never regresses ledger/decisions", () => {
    withSandbox((cwd) => {
      writeLedgerFragment(cwd, ledgerEntry("M-20260101000000-a", "2026-01-01T00:00:00Z"));
      writeDecisionFragment(
        cwd,
        decisionFragment("M-20260101000000-a", [
          { id: "D1", decision: "x", rationale: "y", date: "2026-01-01" },
        ]),
      );
      writeCheckerFragment(cwd, MID, "S02", { dimension: "coverage", verdict: "gap", note: "second slice" });
      writeCheckerFragment(cwd, MID, "S01", { dimension: "security", verdict: "ok", note: "first slice" });
      // Synthetic/non-canonical id — must not throw and must appear in the projection.
      writeCheckerFragment(cwd, MID, "synthetic-xyz", { dimension: "d", verdict: "v", note: "synthetic" });

      const res = rebuildProjections(cwd, MID);
      assert.equal(res.checker, 3);
      assert.equal(res.ledger, 1, "ledger untouched by checker projection");
      assert.equal(res.decisions, 1, "decisions untouched by checker projection");
      assert.deepEqual(res.errors, []);

      const out = readFileSync(CHECKER_MD(cwd), "utf-8");
      const s01Idx = out.indexOf("## S01");
      const s02Idx = out.indexOf("## S02");
      const synIdx = out.indexOf("## synthetic-xyz");
      assert.ok(s01Idx > 0 && s02Idx > 0 && synIdx > 0);
      assert.ok(s01Idx < s02Idx, "S01 sorts before S02");
      assert.ok(out.includes("first slice"));
      assert.ok(out.includes("second slice"));
      assert.ok(out.includes("synthetic"));

      // Ledger/decisions projections still intact after the checker rebuild.
      const ledgerOut = readFileSync(LEDGER_MD(cwd), "utf-8");
      const decisionsOut = readFileSync(DECISIONS_MD(cwd), "utf-8");
      assert.ok(ledgerOut.includes("M-20260101000000-a"));
      assert.ok(decisionsOut.includes("| D1 |"));
    });
  });

  test("a well-formed checker store rebuilds with zero errors", () => {
    withSandbox((cwd) => {
      writeCheckerFragment(cwd, MID, "S01", { dimension: "d", verdict: "v", note: "ok" });
      const res = rebuildProjections(cwd, MID);
      assert.deepEqual(res.errors, []);
      assert.equal(res.checker, 1);
    });
  });
});

describe("rebuildProjections — AUTO-MEMORY.md", () => {
  test("renders ranked facts, recent before old, and reports res.memory", () => {
    withSandbox((cwd) => {
      const oldFragment: MemoryFragment = {
        unit_id: "T-old-unit",
        facts: [
          {
            id: "fact-old",
            fact: "An old fact learned long ago",
            confidence: 0.9,
            hits: 1,
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      };
      const recentFragment: MemoryFragment = {
        unit_id: "T-recent-unit",
        facts: [
          {
            id: "fact-recent",
            fact: "A fresh fact just learned",
            confidence: 0.9,
            hits: 1,
            created_at: "2026-01-31T00:00:00Z",
          },
        ],
      };
      writeMemoryFragment(cwd, oldFragment);
      writeMemoryFragment(cwd, recentFragment);

      const res = rebuildProjections(cwd, MID, FIXED_NOW);
      assert.equal(res.memory, 2);
      assert.deepEqual(res.errors, []);

      assert.ok(existsSync(AUTO_MEMORY_MD(cwd)));
      const out = readFileSync(AUTO_MEMORY_MD(cwd), "utf-8");
      const recentIdx = out.indexOf("A fresh fact just learned");
      const oldIdx = out.indexOf("An old fact learned long ago");
      assert.ok(recentIdx > 0 && oldIdx > 0);
      assert.ok(recentIdx < oldIdx, "the less-decayed (recent) fact ranks before the older one");
    });
  });

  test("idempotency: two rebuilds with the SAME now produce byte-identical AUTO-MEMORY.md", () => {
    withSandbox((cwd) => {
      writeMemoryFragment(cwd, {
        unit_id: "T-fact-a",
        facts: [
          { id: "fa", fact: "Fact A", confidence: 0.8, hits: 2, created_at: "2026-01-15T00:00:00Z" },
        ],
      });
      writeMemoryFragment(cwd, {
        unit_id: "T-fact-b",
        facts: [
          { id: "fb", fact: "Fact B", confidence: 0.6, hits: 1, created_at: "2026-01-20T00:00:00Z" },
        ],
      });

      rebuildProjections(cwd, MID, FIXED_NOW);
      const memory1 = readFileSync(AUTO_MEMORY_MD(cwd), "utf-8");

      rebuildProjections(cwd, MID, FIXED_NOW);
      const memory2 = readFileSync(AUTO_MEMORY_MD(cwd), "utf-8");

      assert.equal(memory1, memory2);
    });
  });

  test("zero memory fragments → header-only, never throws", () => {
    withSandbox((cwd) => {
      const res = rebuildProjections(cwd, MID, FIXED_NOW);
      assert.equal(res.memory, 0);
      assert.deepEqual(res.errors, []);
      assert.ok(existsSync(AUTO_MEMORY_MD(cwd)));
      const out = readFileSync(AUTO_MEMORY_MD(cwd), "utf-8");
      assert.ok(out.includes("_No memory yet._"));
    });
  });

  test("a malformed memory fragment is skipped without aborting the rebuild", () => {
    withSandbox((cwd) => {
      writeLedgerFragment(cwd, ledgerEntry("M-20260101000000-a", "2026-01-01T00:00:00Z"));
      writeDecisionFragment(
        cwd,
        decisionFragment("M-20260101000000-a", [
          { id: "D1", decision: "x", rationale: "y", date: "2026-01-01" },
        ]),
      );
      writeCheckerFragment(cwd, MID, "S01", { dimension: "d", verdict: "v", note: "ok" });
      writeMemoryFragment(cwd, {
        unit_id: "T-good",
        facts: [
          { id: "fg", fact: "A good fact", confidence: 0.9, hits: 1, created_at: "2026-01-25T00:00:00Z" },
        ],
      });

      // Hand-written malformed fragment — not valid MEMORY fragment shape.
      const memDir = join(cwd, ".gsd", "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "T-malformed.md"), "not a valid fragment at all\n", "utf-8");

      const res = rebuildProjections(cwd, MID, FIXED_NOW);
      // Rebuild completes without throwing; the malformed fragment degrades to
      // an empty facts list (parseMemoryFragment never throws) rather than
      // aborting the whole rebuild.
      assert.equal(res.memory, 1);
      assert.deepEqual(res.errors, []);

      assert.ok(existsSync(AUTO_MEMORY_MD(cwd)));
      const memOut = readFileSync(AUTO_MEMORY_MD(cwd), "utf-8");
      assert.ok(memOut.includes("A good fact"));

      // Other projections stay intact.
      assert.equal(res.ledger, 1);
      assert.equal(res.decisions, 1);
      assert.equal(res.checker, 1);
      const ledgerOut = readFileSync(LEDGER_MD(cwd), "utf-8");
      const decisionsOut = readFileSync(DECISIONS_MD(cwd), "utf-8");
      const checkerOut = readFileSync(CHECKER_MD(cwd), "utf-8");
      assert.ok(ledgerOut.includes("M-20260101000000-a"));
      assert.ok(decisionsOut.includes("| D1 |"));
      assert.ok(checkerOut.includes("## S01"));
    });
  });
});
