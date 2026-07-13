import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decayFactor,
  scoreFact,
  selectMemoryFacts,
  promotableFacts,
  renderAutoMemory,
  loadRankedMemory,
  composeProjectMemory,
  renderProjectMemoryBlock,
  DEFAULT_CAP,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_PROMOTION_THRESHOLD,
} from "../memory/memory-rank.ts";
import { writeMemoryFragment, type MemoryFact, type MemoryFragment } from "../memory/memory-store.ts";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-memory-rank-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fact(overrides: Partial<MemoryFact>): MemoryFact {
  return {
    id: "f1",
    fact: "some fact",
    confidence: 1,
    hits: 1,
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("decayFactor", () => {
  test("is 1 at age 0", () => {
    assert.equal(decayFactor(0, 30), 1);
  });

  test("is 0.5 when ageDays === halfLifeDays", () => {
    assert.equal(decayFactor(30, 30), 0.5);
  });

  test("is monotonically decreasing as age grows", () => {
    const a = decayFactor(0, 30);
    const b = decayFactor(10, 30);
    const c = decayFactor(30, 30);
    const d = decayFactor(90, 30);
    assert.ok(a > b);
    assert.ok(b > c);
    assert.ok(c > d);
  });

  test("clamps negative ageDays to 0 (decayFactor === 1)", () => {
    assert.equal(decayFactor(-5, 30), 1);
  });

  test("defaults halfLifeDays to DEFAULT_HALF_LIFE_DAYS", () => {
    assert.equal(decayFactor(DEFAULT_HALF_LIFE_DAYS), 0.5);
  });
});

describe("scoreFact", () => {
  test("invalid/missing created_at treats age as 0 (no decay)", () => {
    const now = Date.now();
    const f = fact({ confidence: 2, hits: 3, created_at: "not-a-date" });
    assert.equal(scoreFact(f, now), 2 * 3 * 1);
  });

  test("hits is floored at 1 even when 0", () => {
    const now = Date.now();
    const f = fact({ confidence: 2, hits: 0, created_at: new Date(now).toISOString() });
    assert.equal(scoreFact(f, now), 2 * 1 * 1);
  });
});

describe("selectMemoryFacts", () => {
  test("ranks a fresh fact above an old one of the same confidence x hits", () => {
    const now = Date.parse("2026-01-31T00:00:00.000Z");
    const fresh = fact({ id: "b-fresh", confidence: 1, hits: 1, created_at: "2026-01-31T00:00:00.000Z" });
    const old = fact({ id: "a-old", confidence: 1, hits: 1, created_at: "2025-01-01T00:00:00.000Z" });
    const result = selectMemoryFacts([{ unit_id: "u1", facts: [old, fresh] }], { now });
    assert.deepEqual(
      result.map((f) => f.id),
      ["b-fresh", "a-old"],
    );
  });

  test("ties break by id.localeCompare ascending (deterministic)", () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const b = fact({ id: "b", confidence: 1, hits: 1, created_at: iso });
    const a = fact({ id: "a", confidence: 1, hits: 1, created_at: iso });
    const result = selectMemoryFacts([{ unit_id: "u1", facts: [b, a] }], { now });
    assert.deepEqual(
      result.map((f) => f.id),
      ["a", "b"],
    );
  });

  test("respects cap: more than 50 facts truncates to 50 (default)", () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const facts: MemoryFact[] = [];
    for (let i = 0; i < 60; i++) {
      facts.push(fact({ id: `f${String(i).padStart(2, "0")}`, confidence: 1, hits: 1, created_at: iso }));
    }
    const result = selectMemoryFacts([{ unit_id: "u1", facts }], { now });
    assert.equal(result.length, DEFAULT_CAP);
  });

  test("custom cap is honored", () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const facts: MemoryFact[] = [
      fact({ id: "a", created_at: iso }),
      fact({ id: "b", created_at: iso }),
      fact({ id: "c", created_at: iso }),
    ];
    const result = selectMemoryFacts([{ unit_id: "u1", facts }], { now, cap: 2 });
    assert.equal(result.length, 2);
  });

  test("flattens across multiple fragments", () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const frags: MemoryFragment[] = [
      { unit_id: "u1", facts: [fact({ id: "a", created_at: iso })] },
      { unit_id: "u2", facts: [fact({ id: "b", created_at: iso })] },
    ];
    const result = selectMemoryFacts(frags, { now });
    assert.equal(result.length, 2);
  });
});

describe("promotableFacts", () => {
  test("filters by hits >= threshold (default)", () => {
    const facts = [fact({ id: "a", hits: 3 }), fact({ id: "b", hits: 2 }), fact({ id: "c", hits: 5 })];
    const result = promotableFacts(facts);
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((f) => f.id),
      ["a", "c"],
    );
    assert.equal(DEFAULT_PROMOTION_THRESHOLD, 3);
  });

  test("custom threshold", () => {
    const facts = [fact({ id: "a", hits: 1 }), fact({ id: "b", hits: 5 })];
    const result = promotableFacts(facts, 5);
    assert.deepEqual(
      result.map((f) => f.id),
      ["b"],
    );
  });
});

describe("renderAutoMemory", () => {
  test("is byte-identical across two calls with the same input", () => {
    const selected = [fact({ id: "a", fact: "Fact A", hits: 3 })];
    const promoted = promotableFacts(selected);
    const out1 = renderAutoMemory(selected, promoted);
    const out2 = renderAutoMemory(selected, promoted);
    assert.equal(out1, out2);
  });

  test("header-only when zero facts", () => {
    const out = renderAutoMemory([], []);
    assert.match(out, /^# Forge Auto-Memory/);
    assert.match(out, /_No memory yet\._/);
    assert.doesNotMatch(out, /Elegíveis/);
  });

  test("never prints score or created_at/timestamp", () => {
    const selected = [fact({ id: "a", fact: "Some fact text", confidence: 0.9, hits: 4, created_at: "2026-01-01T00:00:00.000Z" })];
    const out = renderAutoMemory(selected, promotableFacts(selected));
    assert.ok(out.includes("Some fact text"));
    assert.ok(!out.includes("2026-01-01"));
    assert.ok(!out.includes("0.9"));
  });

  test("lists promoted facts under the elegibility section, or _nenhuma_ when empty", () => {
    const low = fact({ id: "a", fact: "Low hits fact", hits: 1 });
    const outEmpty = renderAutoMemory([low], promotableFacts([low]));
    assert.match(outEmpty, /_nenhuma_/);

    const high = fact({ id: "b", fact: "High hits fact", hits: 10 });
    const outFilled = renderAutoMemory([high], promotableFacts([high]));
    assert.ok(outFilled.includes("High hits fact"));
  });
});

describe("loadRankedMemory / composeProjectMemory", () => {
  test("composeProjectMemory returns empty string when store is empty", () => {
    withSandbox((cwd) => {
      const now = Date.now();
      assert.equal(composeProjectMemory(cwd, { now }), "");
    });
  });

  test("composeProjectMemory returns a block with the fact once a fragment is written", () => {
    withSandbox((cwd) => {
      const now = Date.parse("2026-02-01T00:00:00.000Z");
      writeMemoryFragment(cwd, {
        unit_id: "T01",
        facts: [fact({ id: "x", fact: "Learned something durable", created_at: "2026-01-31T00:00:00.000Z" })],
      });
      const block = composeProjectMemory(cwd, { now });
      assert.match(block, /^## Project Memory/);
      assert.ok(block.includes("Learned something durable"));
    });
  });

  test("loadRankedMemory skips unreadable fragments and never throws", () => {
    withSandbox((cwd) => {
      const result = loadRankedMemory(cwd, { now: Date.now() });
      assert.deepEqual(result, { selected: [], promoted: [] });
    });
  });
});

describe("renderProjectMemoryBlock — single source of truth (S07-REVIEW R2)", () => {
  test("empty selected renders empty string", () => {
    assert.equal(renderProjectMemoryBlock([]), "");
  });

  test("matches composeProjectMemory byte-for-byte for the same store state", () => {
    withSandbox((cwd) => {
      const now = Date.parse("2026-02-01T00:00:00.000Z");
      writeMemoryFragment(cwd, {
        unit_id: "T01",
        facts: [
          fact({ id: "x", fact: "Learned something durable", created_at: "2026-01-31T00:00:00.000Z" }),
          fact({ id: "y", fact: "Another durable fact", created_at: "2026-01-30T00:00:00.000Z" }),
        ],
      });
      const { selected } = loadRankedMemory(cwd, { now });
      const viaRenderer = renderProjectMemoryBlock(selected);
      const viaCompose = composeProjectMemory(cwd, { now });
      assert.equal(viaRenderer, viaCompose);
      assert.ok(viaRenderer.length > 0);
    });
  });
});
