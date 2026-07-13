/**
 * Forge migrate — coverage for `roadmap-convert.ts` (S03/T02): the four
 * `RoadmapConvertAction`s (`noop-native`/`noop-absent`/`skip-unknown`/
 * `convert`), the round-trip through the REAL `state/parse.ts:parseRoadmap`,
 * byte-preservation of everything outside "## Slices", the `writeFileAtomic`
 * write gate (only `convert` touches disk), and idempotency.
 *
 * Same one-shot-copy / skip-honest discipline as `migrate-roadmap-layout.test.ts`
 * (T01): real fixtures (`~/Documents/dev/forge-agent/.gsd/milestones/M002`
 * and `M003`) are each read AT MOST once, copied into a `mkdtemp` sandbox,
 * and only the sandbox copy is asserted against — never the original, never
 * mutated.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { computeRoadmapConversion, applyRoadmapConversion } from "../migrate/roadmap-convert.ts";
import { parseRoadmap } from "../state/parse.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-migrate-roadmap-convert-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRoadmap(cwd: string, milestoneId: string, content: string): string {
  const dir = join(cwd, ".gsd", "milestones", milestoneId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${milestoneId}-ROADMAP.md`);
  writeFileSync(path, content, "utf-8");
  return path;
}

const PROSE_1X_FIXTURE = [
  "---",
  "id: M999",
  "title: \"Fixture sintética\"",
  "---",
  "",
  "# M999 — Fixture sintética",
  "",
  "## Vision",
  "",
  "Texto de vision que não deve ser tocado.",
  "",
  "## Slices",
  "",
  "- [x] **S01: Spec compartilhada** `risk:high` `depends:[]`",
  "  Descrição da slice 1.",
  "",
  "- [ ] **S02: Wiring** `risk:medium` `depends:[S01]`",
  "  Descrição da slice 2.",
  "",
  "- [ ] **S03: Multi-depends** `risk:low` `depends:[S01, S02]`",
  "  Descrição da slice 3.",
  "",
  "## Boundary Map",
  "",
  "Conteúdo de boundary map que também não deve ser tocado.",
  "",
  "## Notes",
  "",
  "Notas finais.",
  "",
].join("\n");

const PIPE_TABLE_2X_FIXTURE = [
  "## Slices",
  "",
  "| ID | Nome | Risk | Depends | Status |",
  "|----|------|------|---------|--------|",
  "| S01 | Detecção | med | — | pending |",
  "| S02 | Conversores | high | S01 | pending |",
  "",
].join("\n");

// ── computeRoadmapConversion — the four actions (synthetic) ─────────────────

describe("computeRoadmapConversion", () => {
  test("twoPointZero → noop-native, no newSlicesSection", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", PIPE_TABLE_2X_FIXTURE);
      const plan = computeRoadmapConversion(dir, "M999");
      assert.equal(plan.action, "noop-native");
      assert.equal(plan.newSlicesSection, undefined);
    });
  });

  test("absent → noop-absent", () => {
    withSandbox((dir) => {
      const plan = computeRoadmapConversion(dir, "M999");
      assert.equal(plan.action, "noop-absent");
      assert.equal(plan.newSlicesSection, undefined);
    });
  });

  test("unknown → skip-unknown, never writes", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", "conteúdo aleatório sem forma reconhecível\n");
      const plan = computeRoadmapConversion(dir, "M999");
      assert.equal(plan.action, "skip-unknown");
      assert.equal(plan.newSlicesSection, undefined);
    });
  });

  test("prose1x → convert, newSlicesSection is a pipe table with header + separator + 3 rows", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", PROSE_1X_FIXTURE);
      const plan = computeRoadmapConversion(dir, "M999");
      assert.equal(plan.action, "convert");
      assert.ok(plan.newSlicesSection);

      const lines = plan.newSlicesSection!.split("\n");
      assert.equal(lines[0], "## Slices");
      assert.equal(lines[2], "| ID | Nome | Risk | Depends | Status |");
      assert.match(lines[3], /^\|-+\|-+\|-+\|-+\|-+\|$/);
      assert.equal(lines.filter((l) => l.startsWith("| S")).length, 3);
    });
  });
});

// ── round-trip through the REAL parseRoadmap ─────────────────────────────────

describe("computeRoadmapConversion — round-trip via the real parseRoadmap", () => {
  test("converted table re-parses with the exact ids/risks/depends/status parseRoadmap1x extracted", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", PROSE_1X_FIXTURE);
      const plan = computeRoadmapConversion(dir, "M999");
      assert.equal(plan.action, "convert");

      const reparsed = parseRoadmap(plan.newSlicesSection!);
      assert.equal(reparsed.length, 3);

      assert.deepEqual(reparsed[0], { id: "S01", name: "Spec compartilhada", risk: "high", depends: [], status: "done" });
      assert.deepEqual(reparsed[1], { id: "S02", name: "Wiring", risk: "medium", depends: ["S01"], status: "pending" });
      assert.deepEqual(reparsed[2], {
        id: "S03",
        name: "Multi-depends",
        risk: "low",
        depends: ["S01", "S02"],
        status: "pending",
      });
    });
  });
});

// ── applyRoadmapConversion — write gate ──────────────────────────────────────

describe("applyRoadmapConversion", () => {
  test("action !== convert never touches disk (noop-native example)", () => {
    withSandbox((dir) => {
      const path = writeRoadmap(dir, "M999", PIPE_TABLE_2X_FIXTURE);
      const before = readFileSync(path, "utf-8");
      const result = applyRoadmapConversion(dir, "M999");
      assert.equal(result.written, false);
      assert.equal(readFileSync(path, "utf-8"), before);
    });
  });

  test("action !== convert never touches disk (absent example)", () => {
    withSandbox((dir) => {
      const result = applyRoadmapConversion(dir, "M999");
      assert.equal(result.written, false);
      assert.equal(existsSync(result.path), false);
    });
  });

  test("convert writes via writeFileAtomic, preserves everything outside \"## Slices\" byte-for-byte", () => {
    withSandbox((dir) => {
      const path = writeRoadmap(dir, "M999", PROSE_1X_FIXTURE);
      const result = applyRoadmapConversion(dir, "M999");
      assert.equal(result.written, true);
      assert.equal(result.path, path);

      const after = readFileSync(path, "utf-8");

      // Frontmatter, Vision, Boundary Map, Notes are all substrings of the
      // original PROSE_1X_FIXTURE — assert each survives verbatim.
      assert.ok(after.includes('id: M999\ntitle: "Fixture sintética"'));
      assert.ok(after.includes("## Vision\n\nTexto de vision que não deve ser tocado."));
      assert.ok(after.includes("## Boundary Map\n\nConteúdo de boundary map que também não deve ser tocado."));
      assert.ok(after.includes("## Notes\n\nNotas finais."));

      // "## Slices" section itself is now the pipe table, re-parseable.
      const reparsed = parseRoadmap(after);
      assert.equal(reparsed.length, 3);
      assert.deepEqual(reparsed.map((s) => s.id), ["S01", "S02", "S03"]);
      assert.deepEqual(reparsed.map((s) => s.status), ["done", "pending", "pending"]);

      // The prose checkbox lines are gone.
      assert.ok(!after.includes("- [x] **S01"));
      assert.ok(!after.includes("- [ ] **S02"));
    });
  });

  test("idempotent: applying twice in a row leaves the file unchanged the second time, second call is noop-native", () => {
    withSandbox((dir) => {
      const path = writeRoadmap(dir, "M999", PROSE_1X_FIXTURE);

      const first = applyRoadmapConversion(dir, "M999");
      assert.equal(first.written, true);
      const afterFirst = readFileSync(path, "utf-8");

      const secondPlan = computeRoadmapConversion(dir, "M999");
      assert.equal(secondPlan.action, "noop-native");

      const second = applyRoadmapConversion(dir, "M999");
      assert.equal(second.written, false);
      const afterSecond = readFileSync(path, "utf-8");
      assert.equal(afterSecond, afterFirst);
    });
  });
});

// ── Real fixture: forge-agent 1.0's M002 (all done) / M003 (none done) ──────

const FORGE_AGENT_ROOT = join(homedir(), "Documents", "dev", "forge-agent");
const M002_ROADMAP = join(FORGE_AGENT_ROOT, ".gsd", "milestones", "M002", "M002-ROADMAP.md");
const M003_ROADMAP = join(FORGE_AGENT_ROOT, ".gsd", "milestones", "M003", "M003-ROADMAP.md");

const FORGE_AGENT_SKIP =
  "~/Documents/dev/forge-agent não existe nesta máquina — projeto 1.0 separado, " +
  "fixture só disponível no workspace de desenvolvimento que o tem clonado";

describe(
  "applyRoadmapConversion — real fixture (forge-agent 1.0 M002, all done)",
  { skip: !existsSync(M002_ROADMAP) && FORGE_AGENT_SKIP },
  () => {
    test("one-shot copy of M002-ROADMAP.md converts to a 4-row table, all status:done, Vision/Boundary Map preserved", () => {
      let liveContent: string;
      try {
        liveContent = readFileSync(M002_ROADMAP, "utf-8");
      } catch {
        return; // race with the skip guard above — bail out honestly, no assertion
      }

      withSandbox((dir) => {
        const path = writeRoadmap(dir, "M002", liveContent);
        const beforeVisionIdx = liveContent.indexOf("## Vision");
        const beforeBoundaryIdx = liveContent.indexOf("## Boundary Map");
        assert.ok(beforeVisionIdx !== -1 && beforeBoundaryIdx !== -1, "fixture must have both sections to test preservation");
        const visionSnippet = liveContent.slice(beforeVisionIdx, liveContent.indexOf("## Slices"));
        const boundarySnippet = liveContent.slice(beforeBoundaryIdx, beforeBoundaryIdx + 200);

        const result = applyRoadmapConversion(dir, "M002");
        assert.equal(result.written, true);

        const after = readFileSync(path, "utf-8");
        assert.ok(after.includes(visionSnippet), "Vision section must be preserved byte-for-byte");
        assert.ok(after.includes(boundarySnippet), "Boundary Map section must be preserved byte-for-byte");

        const reparsed = parseRoadmap(after);
        assert.equal(reparsed.length, 4);
        assert.deepEqual(reparsed.map((s) => s.id), ["S01", "S02", "S03", "S04"]);
        assert.ok(reparsed.every((s) => s.status === "done"), "expected all M002 rows status:done");
      });
    });
  },
);

describe(
  "applyRoadmapConversion — real fixture (forge-agent 1.0 M003, none done)",
  { skip: !existsSync(M003_ROADMAP) && FORGE_AGENT_SKIP },
  () => {
    test("one-shot copy of M003-ROADMAP.md converts to a 4-row table, all status:pending", () => {
      let liveContent: string;
      try {
        liveContent = readFileSync(M003_ROADMAP, "utf-8");
      } catch {
        return;
      }

      withSandbox((dir) => {
        const path = writeRoadmap(dir, "M003", liveContent);
        const result = applyRoadmapConversion(dir, "M003");
        assert.equal(result.written, true);

        const after = readFileSync(path, "utf-8");
        const reparsed = parseRoadmap(after);
        assert.equal(reparsed.length, 4);
        assert.deepEqual(reparsed.map((s) => s.id), ["S01", "S02", "S03", "S04"]);
        assert.ok(reparsed.every((s) => s.status === "pending"), "expected all M003 rows status:pending");

        // Idempotency on real data too.
        const secondPlan = computeRoadmapConversion(dir, "M003");
        assert.equal(secondPlan.action, "noop-native");
      });
    });
  },
);
