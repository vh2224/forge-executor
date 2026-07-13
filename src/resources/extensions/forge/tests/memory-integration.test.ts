/**
 * End-to-end memory pipeline regression test (S07/T05) — the milestone
 * acceptance #5 guard: fragments written via `writeMemoryFragment` (S07/T01)
 * flow through `rebuildProjections` into `.gsd/AUTO-MEMORY.md` (S07/T03,
 * ranked/decayed/capped/promoted), and are injected into a composed worker
 * prompt via `composeProjectMemory`+`composePrompt` (S07/T02, S07/T04).
 *
 * This test does NOT exercise the agentic extraction step itself (that lives
 * in the orchestrator, outside this module boundary) — it simulates the
 * fragments an extractor would produce and exercises the entire native
 * machine downstream of that boundary: store -> merger -> projection ->
 * injection, including idempotency and the 50-fact cap.
 *
 * Sandbox-only (mkdtempSync/rmSync) — never touches the repo's real `.gsd`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemoryFragment, type MemoryFragment, type MemoryFact } from "../memory/memory-store.ts";
import { rebuildProjections } from "../state/merger.ts";
import { composeProjectMemory, DEFAULT_CAP, DEFAULT_PROMOTION_THRESHOLD } from "../memory/memory-rank.ts";
import { composePrompt, type ComposeInfo } from "../prompts/compose.ts";
import type { NextUnit } from "../state/index.ts";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-memory-integration-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const AUTO_MEMORY_MD = (cwd: string) => join(cwd, ".gsd", "AUTO-MEMORY.md");

/** Fixed clock — decay is `now`-relative, so idempotency requires a pinned `now`. */
const FIXED_NOW = Date.parse("2026-02-01T00:00:00Z");
const MID = "M-20260101000000-a";

/** Milliseconds-per-day helper for computing created_at relative to FIXED_NOW. */
const DAY = 86_400_000;

function isoOffsetDays(days: number): string {
  return new Date(FIXED_NOW - days * DAY).toISOString();
}

const RECENT_HIGH_HITS_FACT: MemoryFact = {
  id: "fact-recent-high-hits",
  fact: "Recent high-hits fact eligible for promotion",
  confidence: 0.9,
  hits: 5,
  created_at: isoOffsetDays(1),
};

// Same confidence x hits as the recent fact, but far older — must decay below it.
const OLD_SAME_WEIGHT_FACT: MemoryFact = {
  id: "fact-old-same-weight",
  fact: "Old fact with the same raw weight as the recent one",
  confidence: 0.9,
  hits: 5,
  created_at: isoOffsetDays(400),
};

// Below the promotion threshold (hits < DEFAULT_PROMOTION_THRESHOLD).
const LOW_HITS_FACT: MemoryFact = {
  id: "fact-low-hits",
  fact: "Low-hits fact not eligible for promotion",
  confidence: 0.9,
  hits: 1,
  created_at: isoOffsetDays(1),
};

function writeThreeFragments(cwd: string): void {
  writeMemoryFragment(cwd, { unit_id: "T-recent", facts: [RECENT_HIGH_HITS_FACT] });
  writeMemoryFragment(cwd, { unit_id: "T-old", facts: [OLD_SAME_WEIGHT_FACT] });
  writeMemoryFragment(cwd, { unit_id: "T-low", facts: [LOW_HITS_FACT] });
}

function executeTaskUnit(): NextUnit {
  return { type: "execute-task", slice: "S01", task: "T01" };
}

function composeInfo(cwd: string): ComposeInfo {
  return { cwd, milestoneId: MID };
}

describe("memory pipeline — store -> merger -> AUTO-MEMORY.md", () => {
  test("ranks recent-before-old and marks the high-hits fact eligible, not the low-hits one", () => {
    withSandbox((cwd) => {
      writeThreeFragments(cwd);

      const res = rebuildProjections(cwd, MID, FIXED_NOW);
      assert.equal(res.memory, 3);
      assert.deepEqual(res.errors, []);

      const out = readFileSync(AUTO_MEMORY_MD(cwd), "utf-8");

      const recentIdx = out.indexOf(RECENT_HIGH_HITS_FACT.fact);
      const oldIdx = out.indexOf(OLD_SAME_WEIGHT_FACT.fact);
      assert.ok(recentIdx > 0 && oldIdx > 0, "both facts appear in the projection");
      assert.ok(recentIdx < oldIdx, "recent fact ranks before the equally-weighted but decayed old fact");

      const eligibleHeader = `## Elegíveis para promoção (hits ≥ ${DEFAULT_PROMOTION_THRESHOLD})`;
      const eligibleIdx = out.indexOf(eligibleHeader);
      assert.ok(eligibleIdx > 0, "eligibility section header present");
      const eligibleSection = out.slice(eligibleIdx);

      assert.ok(eligibleSection.includes(RECENT_HIGH_HITS_FACT.fact), "high-hits fact listed as eligible");
      assert.ok(!eligibleSection.includes(LOW_HITS_FACT.fact), "low-hits fact NOT listed as eligible");
    });
  });

  test("idempotency: two rebuilds with the same FIXED_NOW produce byte-identical AUTO-MEMORY.md", () => {
    withSandbox((cwd) => {
      writeThreeFragments(cwd);

      rebuildProjections(cwd, MID, FIXED_NOW);
      const first = readFileSync(AUTO_MEMORY_MD(cwd), "utf-8");

      rebuildProjections(cwd, MID, FIXED_NOW);
      const second = readFileSync(AUTO_MEMORY_MD(cwd), "utf-8");

      assert.equal(first, second, "rebuild over the same fragments/now is byte-identical");
    });
  });

  test("cap: more than 50 facts in a single fragment yield at most 50 fact bullets in the projection", () => {
    withSandbox((cwd) => {
      const manyFacts: MemoryFact[] = Array.from({ length: 60 }, (_, i) => ({
        id: `fact-cap-${String(i).padStart(2, "0")}`,
        fact: `Cap-test fact number ${i}`,
        confidence: 0.5,
        hits: 1,
        created_at: isoOffsetDays(i),
      }));
      const fragment: MemoryFragment = { unit_id: "T-cap", facts: manyFacts };
      writeMemoryFragment(cwd, fragment);

      const res = rebuildProjections(cwd, MID, FIXED_NOW);
      assert.equal(res.memory, DEFAULT_CAP, "res.memory reports the capped, ranked fact count");

      const out = readFileSync(AUTO_MEMORY_MD(cwd), "utf-8");
      const eligibleHeaderIdx = out.indexOf("## Elegíveis para promoção");
      assert.ok(eligibleHeaderIdx > 0);
      const selectedSection = out.slice(0, eligibleHeaderIdx);
      const bulletCount = (selectedSection.match(/^- /gm) ?? []).length;
      assert.ok(bulletCount <= DEFAULT_CAP, `expected at most ${DEFAULT_CAP} fact bullets, got ${bulletCount}`);
    });
  });
});

describe("memory pipeline — injection into the composed prompt", () => {
  test("fail-before: empty sandbox yields no Project Memory block and no injected section", () => {
    withSandbox((cwd) => {
      const block = composeProjectMemory(cwd, { now: FIXED_NOW });
      assert.equal(block, "", "composeProjectMemory returns empty string for an empty store");

      const prompt = composePrompt(executeTaskUnit(), composeInfo(cwd));
      assert.ok(!prompt.includes("## Project Memory"), "no Project Memory section when nothing was passed");
    });
  });

  test("pass-after: a written fragment surfaces its fact text in the composed prompt", () => {
    withSandbox((cwd) => {
      writeMemoryFragment(cwd, { unit_id: "T-inject", facts: [RECENT_HIGH_HITS_FACT] });

      const block = composeProjectMemory(cwd, { now: FIXED_NOW });
      assert.ok(block.length > 0, "composeProjectMemory returns a non-empty block once a fragment exists");
      assert.ok(block.includes("## Project Memory"));
      assert.ok(block.includes(RECENT_HIGH_HITS_FACT.fact));

      const prompt = composePrompt(executeTaskUnit(), composeInfo(cwd), undefined, block);
      assert.ok(prompt.includes("## Project Memory"), "Project Memory section injected into the composed prompt");
      assert.ok(prompt.includes(RECENT_HIGH_HITS_FACT.fact), "the fact text itself reaches the composed prompt");
    });
  });
});
