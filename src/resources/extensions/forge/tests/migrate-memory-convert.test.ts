/**
 * Forge migrate — coverage for `memory-convert.ts` (S02/T05): parsing the 1.0
 * facts+stats shape (block-scalar AND inline values), the mem_id join for
 * `hits`, the category/source_unit text prefix, `.json` exclusion, and the
 * real write path via `writeMemoryFragment`.
 *
 * Same one-shot-copy discipline as `migrate-fragment-store.test.ts` (T03):
 * the live `~/Documents/dev/forge-agent/.gsd/memory/M002.md` fixture (a
 * separate 1.0 project) is read AT MOST once, copied into a `mkdtemp`
 * sandbox, and only the sandbox copy is asserted against. Skips honestly
 * when the fixture is absent from this machine instead of red-falsing.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  parseLegacyMemoryFragment,
  convertLegacyMemory,
  computeMemoryConversion,
  applyMemoryConversion,
} from "../migrate/memory-convert.ts";
import { parseMemoryFragment, serializeMemoryFragment, type MemoryFragment } from "../memory/memory-store.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-migrate-memory-convert-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeMemoryFile(cwd: string, fileName: string, content: string): void {
  const dir = join(cwd, ".gsd", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), content);
}

const SYNTHETIC_LEGACY = [
  "---",
  "facts:",
  "  - mem_id: MEM001",
  "    category: gotcha",
  "    text: usa pnpm workspaces",
  "    created_at: 2026-01-01",
  "    source_unit: research-milestone/M001",
  "    confidence_base: |",
  "      0.9",
  "  - mem_id: MEM002",
  "    category: convention",
  "    text: prefere commits pequenos",
  "    created_at: 2026-01-02",
  "    source_unit: research-milestone/M001",
  "    confidence_base: 0.5",
  "stats:",
  "  - kind: seed",
  "    mem_id: MEM001",
  "    ts: 2026-01-01T00:00:00Z",
  "    confidence_base: 0.9",
  "    hits: 3",
  "unit_id: M001",
  "---",
  "",
].join("\n");

// ── parseLegacyMemoryFragment — synthetic ────────────────────────────────────

describe("parseLegacyMemoryFragment", () => {
  test("parses both facts:/stats: blocks, unit_id, block-scalar AND inline values", () => {
    const { unitId, facts, stats } = parseLegacyMemoryFragment(SYNTHETIC_LEGACY);
    assert.equal(unitId, "M001");
    assert.equal(facts.length, 2);
    assert.equal(facts[0].mem_id, "MEM001");
    assert.equal(facts[0].confidence_base, "0.9"); // block-scalar
    assert.equal(facts[1].mem_id, "MEM002");
    assert.equal(facts[1].confidence_base, "0.5"); // inline
    assert.equal(stats.length, 1);
    assert.equal(stats[0].mem_id, "MEM001");
    assert.equal(stats[0].hits, "3");
  });

  test("no fenced header → empty facts/stats, never throws", () => {
    const { unitId, facts, stats } = parseLegacyMemoryFragment("# not a fragment\n");
    assert.equal(unitId, "");
    assert.deepEqual(facts, []);
    assert.deepEqual(stats, []);
  });
});

// ── convertLegacyMemory — join, hits default, category/source_unit prefix ───

describe("convertLegacyMemory", () => {
  test("joins fact.mem_id with stats by mem_id — hits from matched stat, hits:0 when unmatched, confidence + prefix preserved", () => {
    const { facts, stats } = parseLegacyMemoryFragment(SYNTHETIC_LEGACY);
    const fragment = convertLegacyMemory("M001", facts, stats);

    assert.equal(fragment.unit_id, "M001");
    assert.equal(fragment.facts.length, 2);
    assert.equal(fragment.facts[0].hits, 3);
    assert.equal(fragment.facts[1].hits, 0);
    assert.equal(fragment.facts[0].confidence, 0.9);
    assert.ok(fragment.facts[0].fact.startsWith("[category: gotcha | source_unit: research-milestone/M001]"));
    assert.ok(fragment.facts[1].fact.startsWith("[category: convention | source_unit: research-milestone/M001]"));
  });

  test("multiple stats rows sharing a mem_id — LAST one wins (append-log convention)", () => {
    const facts = [
      { mem_id: "MEM001", category: "gotcha", text: "algo", created_at: "2026-01-01", source_unit: "u", confidence_base: "0.5" },
    ];
    const stats = [
      { mem_id: "MEM001", hits: "1" },
      { mem_id: "MEM001", hits: "5" },
    ];
    const fragment = convertLegacyMemory("M001", facts, stats);
    assert.equal(fragment.facts[0].hits, 5);
  });

  test("empty category/source_unit still emit the prefix (predictable/parseable format)", () => {
    const facts = [
      { mem_id: "MEM001", category: "", text: "algo", created_at: "2026-01-01", source_unit: "", confidence_base: "0.5" },
    ];
    const fragment = convertLegacyMemory("M001", facts, []);
    assert.equal(fragment.facts[0].fact, "[category:  | source_unit: ] algo");
  });
});

// ── computeMemoryConversion — synthetic ──────────────────────────────────────

describe("computeMemoryConversion", () => {
  test("missing .gsd/memory/ → [] (never throws)", () => {
    withSandbox((dir) => {
      assert.deepEqual(computeMemoryConversion(dir), []);
    });
  });

  test("1.0-shape .md → converted with unitId from filename", () => {
    withSandbox((dir) => {
      writeMemoryFile(dir, "M001.md", SYNTHETIC_LEGACY);
      const results = computeMemoryConversion(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].unitId, "M001");
      assert.equal(results[0].fragment.facts.length, 2);
    });
  });

  test(".json file is NEVER treated as a conversion source, even with a facts:/mem_id-shaped body", () => {
    withSandbox((dir) => {
      const jsonContent = JSON.stringify({ unit_id: "M001", facts: [{ mem_id: "MEM001" }] }, null, 2) + "\n";
      writeMemoryFile(dir, "M001.json", jsonContent);
      const results = computeMemoryConversion(dir);
      assert.deepEqual(results, []);
    });
  });

  test("already 2.0-native fragment (id/fact/confidence/hits/created_at, no stats: block) → skipped", () => {
    withSandbox((dir) => {
      const fragment: MemoryFragment = {
        unit_id: "M001",
        facts: [{ id: "MEM001", fact: "algo", confidence: 0.9, hits: 1, created_at: "2026-01-01" }],
      };
      writeMemoryFile(dir, "M001.md", serializeMemoryFragment(fragment));
      assert.deepEqual(computeMemoryConversion(dir), []);
    });
  });

  test("unrecognized-shape .md content → skipped", () => {
    withSandbox((dir) => {
      writeMemoryFile(dir, "solto.md", "# Not a fragment\n\nsome prose.\n");
      assert.deepEqual(computeMemoryConversion(dir), []);
    });
  });
});

// ── applyMemoryConversion — real write + round-trip ──────────────────────────

describe("applyMemoryConversion", () => {
  test("writes via writeMemoryFragment — round-trips through the real 2.0 parser with all 5 fields matching", () => {
    withSandbox((dir) => {
      writeMemoryFile(dir, "M001.md", SYNTHETIC_LEGACY);
      const results = applyMemoryConversion(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].created, true);

      const raw = readFileSync(results[0].path, "utf-8");
      const reparsed = parseMemoryFragment(raw);
      assert.equal(reparsed.unit_id, "M001");
      assert.equal(reparsed.facts.length, 2);
      assert.equal(reparsed.facts[0].id, "MEM001");
      assert.ok(reparsed.facts[0].fact.startsWith("[category: gotcha | source_unit: research-milestone/M001]"));
      assert.equal(reparsed.facts[0].confidence, 0.9);
      assert.equal(reparsed.facts[0].hits, 3);
      assert.equal(reparsed.facts[0].created_at, "2026-01-01");
      assert.equal(reparsed.facts[1].id, "MEM002");
      assert.equal(reparsed.facts[1].hits, 0);
    });
  });
});

// ── Real fixture: forge-agent 1.0's live memory/M002.md ─────────────────────

const FORGE_AGENT_ROOT = join(homedir(), "Documents", "dev", "forge-agent");
const FORGE_AGENT_M002_MEMORY = join(FORGE_AGENT_ROOT, ".gsd", "memory", "M002.md");
const FORGE_AGENT_SKIP =
  "~/Documents/dev/forge-agent não existe nesta máquina — projeto 1.0 separado, fixture só disponível no " +
  "workspace de desenvolvimento que o tem clonado";

describe("computeMemoryConversion — real fixture (forge-agent 1.0 memory/M002.md)", {
  skip: !existsSync(FORGE_AGENT_M002_MEMORY) && FORGE_AGENT_SKIP,
}, () => {
  test("one-shot copy converts to exactly 4 MemoryFact (MEM001..MEM004), hits:0 (all seed stats), no empty fact", () => {
    let liveContent: string;
    try {
      liveContent = readFileSync(FORGE_AGENT_M002_MEMORY, "utf-8");
    } catch {
      return;
    }

    withSandbox((dir) => {
      writeMemoryFile(dir, "M002.md", liveContent);
      const results = computeMemoryConversion(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].unitId, "M002");

      const { facts } = results[0].fragment;
      assert.equal(facts.length, 4);
      const ids = facts.map((f) => f.id).sort();
      assert.deepEqual(ids, ["MEM001", "MEM002", "MEM003", "MEM004"]);
      for (const fact of facts) {
        assert.equal(fact.hits, 0);
        assert.ok(fact.fact.length > 0);
        assert.ok(fact.fact.startsWith("[category:"));
      }
    });
  });
});
