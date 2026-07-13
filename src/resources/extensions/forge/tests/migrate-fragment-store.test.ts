/**
 * Forge migrate — coverage for `classifyFragmentStore`/`findOrphanArtifacts`
 * (T03).
 *
 * Same one-shot-copy discipline as `migrate-state-layout.test.ts` (T01) /
 * `migrate-prefs-layout.test.ts` (T02): the live `.gsd/` of THIS repo and the
 * live `~/Documents/dev/forge-agent/.gsd/` (separate 1.0 project) are each
 * read AT MOST once, copied into a `mkdtemp` sandbox, and only the sandbox
 * copy is asserted against. Real fixtures that live outside this dev
 * workspace skip honestly instead of red-falsing.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { classifyFragmentStore, findOrphanArtifacts } from "../migrate/fragment-store.ts";
import { serializeDecisionFragment, type DecisionFragment } from "../state/decisions.ts";
import { serializeLedgerFragment, type LedgerEntry } from "../state/ledger.ts";
import { serializeMemoryFragment, type MemoryFragment } from "../memory/memory-store.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-migrate-fragment-store-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFragment(cwd: string, store: "decisions" | "ledger" | "memory", fileName: string, content: string): void {
  const dir = join(cwd, ".gsd", store);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), content);
}

function writeMilestoneDir(cwd: string, name: string): void {
  mkdirSync(join(cwd, ".gsd", "milestones", name), { recursive: true });
}

function writeTaskDir(cwd: string, name: string): void {
  mkdirSync(join(cwd, ".gsd", "tasks", name), { recursive: true });
}

// ── classifyFragmentStore — decisions — synthetic ────────────────────────────

describe("classifyFragmentStore — decisions — synthetic", () => {
  test("missing .gsd/decisions/ → files: [] (never throws)", () => {
    withSandbox((dir) => {
      const finding = classifyFragmentStore(dir, "decisions");
      assert.deepEqual(finding.files, []);
    });
  });

  test("2.0-native fragment (id/decision/rationale/date) → compatible:true", () => {
    withSandbox((dir) => {
      const fragment: DecisionFragment = {
        unit_id: "M-20260101000000-teste",
        decisions: [{ id: "D1", decision: "algo", rationale: "porque sim", date: "2026-01-01" }],
        body: "",
      };
      writeFragment(dir, "decisions", "M-20260101000000-teste.md", serializeDecisionFragment(fragment));
      const finding = classifyFragmentStore(dir, "decisions");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, true);
    });
  });

  test("1.0-shape fragment (when/scope/choice/revisable) → compatible:false citing 1.0 keys", () => {
    withSandbox((dir) => {
      const content = [
        "---",
        "decisions:",
        "  - when: 2026-06-20",
        "    scope: milestone",
        "    decision: Trigger do handshake",
        "    choice: sempre",
        "    rationale: controle > velocidade",
        "    revisable: |",
        "      yes",
        "unit_id: M001",
        "---",
        "",
      ].join("\n");
      writeFragment(dir, "decisions", "M001.md", content);
      const finding = classifyFragmentStore(dir, "decisions");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, false);
      assert.match(finding.files[0].detail, /when|scope|choice|revisable/);
    });
  });

  test("non-fragment content (no fenced header) → compatible:false", () => {
    withSandbox((dir) => {
      writeFragment(dir, "decisions", "solto.md", "# Not a fragment\n\n| a | b |\n|---|---|\n");
      const finding = classifyFragmentStore(dir, "decisions");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, false);
    });
  });
});

// ── classifyFragmentStore — ledger — synthetic ───────────────────────────────

describe("classifyFragmentStore — ledger — synthetic", () => {
  test("missing .gsd/ledger/ → files: [] (never throws)", () => {
    withSandbox((dir) => {
      const finding = classifyFragmentStore(dir, "ledger");
      assert.deepEqual(finding.files, []);
    });
  });

  test("2.0-native fragment (id/title/completed_at/...) → compatible:true", () => {
    withSandbox((dir) => {
      const entry: LedgerEntry = {
        id: "M-20260101000000-teste",
        title: "Teste",
        completed_at: "2026-01-01T00:00:00Z",
        slices: ["S01"],
        key_files: ["a.ts"],
        key_decisions: ["D1"],
        body: "",
      };
      writeFragment(dir, "ledger", "M-20260101000000-teste.md", serializeLedgerFragment(entry));
      const finding = classifyFragmentStore(dir, "ledger");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, true);
    });
  });

  test("fragment without id → compatible:false", () => {
    withSandbox((dir) => {
      writeFragment(dir, "ledger", "solto.md", "---\ntitle: sem id\n---\n");
      const finding = classifyFragmentStore(dir, "ledger");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, false);
    });
  });
});

// ── classifyFragmentStore — memory — synthetic ───────────────────────────────

describe("classifyFragmentStore — memory — synthetic", () => {
  test("missing .gsd/memory/ → files: [] (never throws)", () => {
    withSandbox((dir) => {
      const finding = classifyFragmentStore(dir, "memory");
      assert.deepEqual(finding.files, []);
    });
  });

  test("2.0-native fragment (id/fact/confidence/hits/created_at) → compatible:true", () => {
    withSandbox((dir) => {
      const fragment: MemoryFragment = {
        unit_id: "M-20260101000000-teste",
        facts: [{ id: "F1", fact: "usa pnpm workspaces", confidence: 0.9, hits: 1, created_at: "2026-01-01" }],
      };
      writeFragment(dir, "memory", "M-20260101000000-teste.md", serializeMemoryFragment(fragment));
      const finding = classifyFragmentStore(dir, "memory");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, true);
    });
  });

  test("1.0-shape .md fragment (mem_id/source_unit/confidence_base) → compatible:false", () => {
    withSandbox((dir) => {
      const content = [
        "---",
        "facts:",
        "  - mem_id: MEM001",
        "    category: gotcha",
        "    text: algo aprendido",
        "    created_at: 2026-01-01",
        "    source_unit: research-milestone/M001",
        "    confidence_base: 0.85",
        "unit_id: M001",
        "---",
        "",
      ].join("\n");
      writeFragment(dir, "memory", "M001.md", content);
      const finding = classifyFragmentStore(dir, "memory");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, false);
      assert.match(finding.files[0].detail, /mem_id|source_unit|confidence_base/);
    });
  });

  test(".json fragment → compatible:false on extension alone, detail cites scripts/forge-memory.js", () => {
    withSandbox((dir) => {
      const jsonContent = JSON.stringify({ unit_id: "S01", facts: [], stats: [] }, null, 2) + "\n";
      writeFragment(dir, "memory", "S01.json", jsonContent);
      const finding = classifyFragmentStore(dir, "memory");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, false);
      assert.match(finding.files[0].detail, /forge-memory\.js/);
      assert.match(finding.files[0].detail, /\.md/);
    });
  });
});

// ── findOrphanArtifacts — synthetic ──────────────────────────────────────────

describe("findOrphanArtifacts — synthetic", () => {
  test("missing .gsd/milestones/ → [] (never throws)", () => {
    withSandbox((dir) => {
      assert.deepEqual(findOrphanArtifacts(dir), []);
    });
  });

  test("loose S03 dir is an orphan, valid timestamp milestone dir is not", () => {
    withSandbox((dir) => {
      writeMilestoneDir(dir, "S03");
      writeMilestoneDir(dir, "M-20260101000000-teste");
      const findings = findOrphanArtifacts(dir);
      assert.equal(findings.length, 1);
      assert.ok(findings[0].path.endsWith(join("milestones", "S03")));
    });
  });

  test("legacy sequential milestone dir (M002) is NOT an orphan", () => {
    withSandbox((dir) => {
      writeMilestoneDir(dir, "M002");
      const findings = findOrphanArtifacts(dir);
      assert.deepEqual(findings, []);
    });
  });

  test("scans .gsd/tasks/ too, when present — orphan task dir flagged, valid one is not", () => {
    withSandbox((dir) => {
      writeTaskDir(dir, "TASK");
      writeTaskDir(dir, "T-20260101000000-teste");
      const findings = findOrphanArtifacts(dir);
      assert.equal(findings.length, 1);
      assert.ok(findings[0].path.endsWith(join("tasks", "TASK")));
    });
  });
});

// ── Real fixture 1: this repo's legacy-orphan.md (decisions) ────────────────

const LEGACY_ORPHAN = join(process.cwd(), ".gsd", "decisions", "legacy-orphan.md");

describe("classifyFragmentStore — real fixture (this repo's legacy-orphan.md)", {
  skip: !existsSync(LEGACY_ORPHAN) && "legacy-orphan.md ausente nesta máquina — fixture do histórico congelado deste repo",
}, () => {
  test("one-shot copy classifies as compatible:false — markdown table, not a fragment", () => {
    let liveContent: string;
    try {
      liveContent = readFileSync(LEGACY_ORPHAN, "utf-8");
    } catch {
      return;
    }

    withSandbox((dir) => {
      writeFragment(dir, "decisions", "legacy-orphan.md", liveContent);
      const finding = classifyFragmentStore(dir, "decisions");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, false);
    });
  });
});

// ── Real fixture 2: forge-agent 1.0's live decisions/M002.md ────────────────

const FORGE_AGENT_ROOT = join(homedir(), "Documents", "dev", "forge-agent");
const FORGE_AGENT_M002_DECISIONS = join(FORGE_AGENT_ROOT, ".gsd", "decisions", "M002.md");
const FORGE_AGENT_SKIP =
  "~/Documents/dev/forge-agent não existe nesta máquina — projeto 1.0 separado, fixture só disponível no " +
  "workspace de desenvolvimento que o tem clonado";

describe("classifyFragmentStore — real fixture (forge-agent 1.0 decisions/M002.md)", {
  skip: !existsSync(FORGE_AGENT_M002_DECISIONS) && FORGE_AGENT_SKIP,
}, () => {
  test("one-shot copy classifies as compatible:false citing 1.0 keys", () => {
    let liveContent: string;
    try {
      liveContent = readFileSync(FORGE_AGENT_M002_DECISIONS, "utf-8");
    } catch {
      return;
    }

    withSandbox((dir) => {
      writeFragment(dir, "decisions", "M002.md", liveContent);
      const finding = classifyFragmentStore(dir, "decisions");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, false);
      assert.match(finding.files[0].detail, /when|scope|choice|revisable/);
    });
  });
});

// ── Real fixture 3: forge-agent 1.0's orphan milestones/S03 ─────────────────

const FORGE_AGENT_S03 = join(FORGE_AGENT_ROOT, ".gsd", "milestones", "S03");

describe("findOrphanArtifacts — real fixture (forge-agent 1.0 milestones/S03)", {
  skip: !existsSync(FORGE_AGENT_S03) && FORGE_AGENT_SKIP,
}, () => {
  test("structurally-equivalent sandbox copy (loose S03 dir) is reported as orphan", () => {
    if (!existsSync(FORGE_AGENT_S03)) return;

    withSandbox((dir) => {
      writeMilestoneDir(dir, "S03");
      const findings = findOrphanArtifacts(dir);
      assert.equal(findings.length, 1);
      assert.ok(findings[0].path.endsWith(join("milestones", "S03")));
    });
  });
});

// ── Real fixture 4: this repo's live .gsd/memory/*.json ─────────────────────

const LIVE_MEMORY_JSON = join(process.cwd(), ".gsd", "memory", "S01.json");

describe("classifyFragmentStore — real fixture (this repo's live memory/S01.json)", {
  skip: !existsSync(LIVE_MEMORY_JSON) && "S01.json ausente nesta máquina — fixture do histórico congelado deste repo",
}, () => {
  test("one-shot copy of the real .json fragment classifies as compatible:false, reflecting the real production format", () => {
    let liveContent: string;
    try {
      liveContent = readFileSync(LIVE_MEMORY_JSON, "utf-8");
    } catch {
      return;
    }

    withSandbox((dir) => {
      writeFragment(dir, "memory", "S01.json", liveContent);
      const finding = classifyFragmentStore(dir, "memory");
      assert.equal(finding.files.length, 1);
      assert.equal(finding.files[0].compatible, false);
      assert.match(finding.files[0].detail, /forge-memory\.js/);
    });
  });
});
