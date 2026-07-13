/**
 * Forge migrate — coverage for `classifyRoadmapLayout`/`parseRoadmap1x` (T01).
 *
 * Same one-shot-copy sandbox discipline as `migrate-state-layout.test.ts` /
 * `migrate-prefs-layout.test.ts`: real fixtures (`~/Documents/dev/forge-agent/
 * .gsd/milestones/M002` and `M003`, plus this repo's own live
 * `<mid>-ROADMAP.md`) are each read AT MOST once, copied into a `mkdtemp`
 * sandbox, and only the sandbox copy is asserted against — never the
 * original, never mutated.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { classifyRoadmapLayout, parseRoadmap1x } from "../migrate/roadmap-layout.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-migrate-roadmap-layout-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRoadmap(cwd: string, milestoneId: string, content: string): void {
  const dir = join(cwd, ".gsd", "milestones", milestoneId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${milestoneId}-ROADMAP.md`), content);
}

const PROSE_1X_FIXTURE = [
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
  "Conteúdo que não deve ser escaneado.",
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

// ── classifyRoadmapLayout — synthetic ────────────────────────────────────────

describe("classifyRoadmapLayout — synthetic", () => {
  test("absent — no <mid>-ROADMAP.md at all", () => {
    withSandbox((dir) => {
      const finding = classifyRoadmapLayout(dir, "M999");
      assert.equal(finding.kind, "absent");
      assert.ok(finding.detail.length > 0);
    });
  });

  test("twoPointZero — \"## Slices\" pipe table recognized by parseRoadmap", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", PIPE_TABLE_2X_FIXTURE);
      const finding = classifyRoadmapLayout(dir, "M999");
      assert.equal(finding.kind, "twoPointZero");
    });
  });

  test("prose1x — \"## Slices\" checkbox+bold prose, no pipe table", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", PROSE_1X_FIXTURE);
      const finding = classifyRoadmapLayout(dir, "M999");
      assert.equal(finding.kind, "prose1x");
    });
  });

  test("unknown — file exists but matches neither shape, never throws", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", "conteúdo completamente aleatório sem forma reconhecível\n");
      const finding = classifyRoadmapLayout(dir, "M999");
      assert.equal(finding.kind, "unknown");
    });
  });

  test("unknown — \"## Slices\" header present but empty body, never throws", () => {
    withSandbox((dir) => {
      writeRoadmap(dir, "M999", "## Slices\n\n## Notes\n\nsem nada aqui\n");
      const finding = classifyRoadmapLayout(dir, "M999");
      assert.equal(finding.kind, "unknown");
    });
  });
});

// ── parseRoadmap1x — synthetic ───────────────────────────────────────────────

describe("parseRoadmap1x — synthetic", () => {
  test("extracts id/name/risk/depends/done in order of appearance", () => {
    const slices = parseRoadmap1x(PROSE_1X_FIXTURE);
    assert.equal(slices.length, 3);

    assert.deepEqual(slices[0], {
      id: "S01",
      name: "Spec compartilhada",
      risk: "high",
      depends: [],
      done: true,
    });
    assert.deepEqual(slices[1], {
      id: "S02",
      name: "Wiring",
      risk: "medium",
      depends: ["S01"],
      done: false,
    });
    assert.deepEqual(slices[2], {
      id: "S03",
      name: "Multi-depends",
      risk: "low",
      depends: ["S01", "S02"],
      done: false,
    });
  });

  test("no \"## Slices\" section → []", () => {
    assert.deepEqual(parseRoadmap1x("# Título\n\nsem seção de slices aqui\n"), []);
  });

  test("stops scanning at the next \"## \" header", () => {
    const raw = [
      "## Slices",
      "- [x] **S01: A** `risk:high` `depends:[]`",
      "## Boundary Map",
      "- [x] **S99: Não é slice** `risk:high` `depends:[]`",
    ].join("\n");
    const slices = parseRoadmap1x(raw);
    assert.equal(slices.length, 1);
    assert.equal(slices[0].id, "S01");
  });

  test("line missing risk/depends tags is skipped, not fatal — parse continues", () => {
    const raw = [
      "## Slices",
      "- [x] **S01: Sem tags** malformado",
      "- [ ] **S02: Válida** `risk:low` `depends:[]`",
    ].join("\n");
    const slices = parseRoadmap1x(raw);
    assert.equal(slices.length, 1);
    assert.equal(slices[0].id, "S02");
  });

  test("never throws on garbage input", () => {
    assert.doesNotThrow(() => parseRoadmap1x(""));
    assert.doesNotThrow(() => parseRoadmap1x("## Slices\n- [] not a real checkbox\n"));
  });
});

// ── Real fixture: forge-agent 1.0's M002 (all done) / M003 (none done) ──────

const FORGE_AGENT_ROOT = join(homedir(), "Documents", "dev", "forge-agent");
const M002_ROADMAP = join(FORGE_AGENT_ROOT, ".gsd", "milestones", "M002", "M002-ROADMAP.md");
const M003_ROADMAP = join(FORGE_AGENT_ROOT, ".gsd", "milestones", "M003", "M003-ROADMAP.md");

const FORGE_AGENT_SKIP =
  "~/Documents/dev/forge-agent não existe nesta máquina — projeto 1.0 separado, " +
  "fixture só disponível no workspace de desenvolvimento que o tem clonado";

describe("classifyRoadmapLayout/parseRoadmap1x — real fixture (forge-agent 1.0 M002, all done)", {
  skip: !existsSync(M002_ROADMAP) && FORGE_AGENT_SKIP,
}, () => {
  test("one-shot copy of M002-ROADMAP.md classifies as prose1x, 4 slices all done:true", () => {
    let liveContent: string;
    try {
      liveContent = readFileSync(M002_ROADMAP, "utf-8");
    } catch {
      return; // race with the skip guard above — bail out honestly, no assertion
    }

    withSandbox((dir) => {
      writeRoadmap(dir, "M002", liveContent);
      const finding = classifyRoadmapLayout(dir, "M002");
      assert.equal(finding.kind, "prose1x");

      const slices = parseRoadmap1x(liveContent);
      assert.equal(slices.length, 4);
      assert.ok(slices.every((s) => s.done === true), "expected all M002 slices done:true");
      assert.deepEqual(
        slices.map((s) => s.id),
        ["S01", "S02", "S03", "S04"],
      );
    });
  });
});

describe("classifyRoadmapLayout/parseRoadmap1x — real fixture (forge-agent 1.0 M003, none done)", {
  skip: !existsSync(M003_ROADMAP) && FORGE_AGENT_SKIP,
}, () => {
  test("one-shot copy of M003-ROADMAP.md classifies as prose1x, 4 slices all done:false", () => {
    let liveContent: string;
    try {
      liveContent = readFileSync(M003_ROADMAP, "utf-8");
    } catch {
      return;
    }

    withSandbox((dir) => {
      writeRoadmap(dir, "M003", liveContent);
      const finding = classifyRoadmapLayout(dir, "M003");
      assert.equal(finding.kind, "prose1x");

      const slices = parseRoadmap1x(liveContent);
      assert.equal(slices.length, 4);
      assert.ok(slices.every((s) => s.done === false), "expected all M003 slices done:false");
      assert.deepEqual(
        slices.map((s) => s.id),
        ["S01", "S02", "S03", "S04"],
      );
    });
  });
});

// ── Bonus real-data case: THIS repo's own 2.0-native ROADMAP.md ─────────────

describe("classifyRoadmapLayout — real fixture (this repo's live 2.0-native ROADMAP.md)", () => {
  test("one-shot copy of this milestone's <mid>-ROADMAP.md classifies as twoPointZero", () => {
    const milestoneId = "M-20260710225229-forge-merge";
    const livePath = join(
      process.cwd(),
      ".gsd",
      "milestones",
      milestoneId,
      `${milestoneId}-ROADMAP.md`,
    );

    let liveContent: string;
    try {
      liveContent = readFileSync(livePath, "utf-8");
    } catch {
      return; // fresh clone / no live .gsd — nothing to assert here
    }

    withSandbox((dir) => {
      writeRoadmap(dir, milestoneId, liveContent);
      const finding = classifyRoadmapLayout(dir, milestoneId);
      assert.equal(finding.kind, "twoPointZero");
    });
  });
});
