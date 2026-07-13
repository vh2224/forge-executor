import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseState, parseRoadmap, parsePlan, parseSummary } from "../state/parse.ts";
import { serializeState } from "../state/serialize.ts";
import type { StateDoc } from "../state/types.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-parse-roundtrip-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Resolved via process.cwd() — the gate/test runner always executes from the
// repo root. Avoids fragile relative-hop counting between dev (src/) and
// compiled (dist-test/src/) execution contexts, which differ in depth.
const M0_ROOT = join(process.cwd(), ".gsd", "milestones", "M-20260708005233-bootstrap-harness-nu");

function copyFixture(srcParts: string[], dir: string, fileName: string): string {
  const src = join(M0_ROOT, ...srcParts);
  const dst = join(dir, fileName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(dst, readFileSync(src, "utf-8"));
  return dst;
}

// ── parseState / serializeState round-trip ───────────────────────────────────

describe("parseState(serializeState(x)) round-trip", () => {
  test("minimal StateDoc (milestone only)", () => {
    const x: StateDoc = { milestone: "M-20260708200551-extensao-forge-loop" };
    assert.deepStrictEqual(parseState(serializeState(x)), x);
  });

  test("StateDoc with next_action and current_slice, no units", () => {
    const x: StateDoc = {
      milestone: "M-20260708200551-extensao-forge-loop",
      phase: "execute",
      current_slice: "S02",
      next_action: "Run T03 gate",
    };
    assert.deepStrictEqual(parseState(serializeState(x)), x);
  });

  test("StateDoc with empty units array", () => {
    const x: StateDoc = {
      milestone: "M-1",
      units: [],
    };
    assert.deepStrictEqual(parseState(serializeState(x)), x);
  });

  test("StateDoc with populated units (slice + task)", () => {
    const x: StateDoc = {
      milestone: "M-20260708200551-extensao-forge-loop",
      phase: "execute",
      current_slice: "S02",
      next_action: "Dispatch T04",
      units: [
        { id: "S01", type: "slice", status: "done" },
        { id: "T01", type: "task", status: "done" },
        { id: "T04", type: "task", status: "pending" },
      ],
    };
    assert.deepStrictEqual(parseState(serializeState(x)), x);
  });

  test("next_action containing a colon round-trips (quoting)", () => {
    const x: StateDoc = {
      milestone: "M-1",
      next_action: "Run: node scripts/verify-pi-patches.cjs",
    };
    assert.deepStrictEqual(parseState(serializeState(x)), x);
  });

  test("next_action containing both a double-quote and a backslash round-trips (R2)", () => {
    const x: StateDoc = {
      milestone: "M-1",
      next_action: 'He said "hi": path C:\\x',
    };
    assert.deepStrictEqual(parseState(serializeState(x)), x);
  });
});

// ── Read-compat (A6) — real M0 artifacts, copied into mkdtemp fixtures ───────

describe("read-compat parsing of real M0 artifacts (A6)", () => {
  test("parseRoadmap parses the real M0 ROADMAP slice table (>=5 slices)", () => {
    withSandbox((dir) => {
      const dst = copyFixture(
        ["M-20260708005233-bootstrap-harness-nu-ROADMAP.md"],
        dir,
        "ROADMAP.md",
      );
      const content = readFileSync(dst, "utf-8");
      const slices = parseRoadmap(content);
      assert.equal(Array.isArray(slices), true);
      assert.ok(slices.length >= 5, `expected >=5 slices, got ${slices.length}`);
      for (const s of slices) {
        assert.equal(typeof s.id, "string");
        assert.equal(typeof s.name, "string");
        assert.equal(typeof s.risk, "string");
        assert.equal(Array.isArray(s.depends), true);
        assert.equal(typeof s.status, "string");
      }
      const s01 = slices.find((s) => s.id === "S01");
      assert.ok(s01, "S01 row present");
      assert.equal(s01!.status, "done");

      // S02 has bold-wrapped risk (**high**) — must be unwrapped
      const s02 = slices.find((s) => s.id === "S02");
      assert.ok(s02, "S02 row present");
      assert.equal(s02!.risk, "high");
    });
  });

  test("parsePlan parses a real M0 T##-PLAN with must_haves without throwing", () => {
    withSandbox((dir) => {
      const dst = copyFixture(
        ["slices", "S01", "tasks", "T03", "T03-PLAN.md"],
        dir,
        "T03-PLAN.md",
      );
      const content = readFileSync(dst, "utf-8");
      const plan = parsePlan(content);
      assert.equal(plan.id, "T03");
      assert.equal(plan.slice, "S01");
      assert.equal(Array.isArray(plan.depends), true);
      assert.ok(plan.mustHaves, "mustHaves present");
      assert.ok(Array.isArray(plan.mustHaves!.truths));
      assert.ok(plan.mustHaves!.truths.length > 0);
    });
  });

  test("parsePlan parses a real M0 S##-PLAN (no frontmatter) without throwing", () => {
    withSandbox((dir) => {
      const dst = copyFixture(["slices", "S01", "S01-PLAN.md"], dir, "S01-PLAN.md");
      const content = readFileSync(dst, "utf-8");
      const plan = parsePlan(content);
      assert.equal(typeof plan.id, "string");
      assert.equal(Array.isArray(plan.depends), true);
    });
  });

  test("parseSummary parses a real M0 S##-SUMMARY with non-empty provides/key_files", () => {
    withSandbox((dir) => {
      const dst = copyFixture(["slices", "S01", "S01-SUMMARY.md"], dir, "S01-SUMMARY.md");
      const content = readFileSync(dst, "utf-8");
      const summary = parseSummary(content);
      assert.equal(summary.id, "S01");
      assert.equal(Array.isArray(summary.provides), true);
      assert.ok(summary.provides.length > 0);
      assert.equal(Array.isArray(summary.key_files), true);
      assert.ok(summary.key_files.length > 0);
    });
  });
});
