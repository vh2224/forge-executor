/**
 * Forge migrate — coverage for `classifyPrefsShape`/`classifyPrefsLayout`/
 * `PREFS_KEY_MAP` (T02).
 *
 * Same one-shot-copy sandbox discipline as `migrate-state-layout.test.ts`
 * (T01) / `gsd-history-operation.test.ts`: real fixtures are read AT MOST
 * once, copied into a `mkdtemp` sandbox, and only the sandbox copy is
 * asserted against.
 *
 * NOTE: `prefsSources(cwd)` includes two layers anchored to the REAL home
 * directory (`~/.claude/forge-agent-prefs.md`, `gsdHome()/prefs.md`) that are
 * NOT sandboxable by passing a fake `cwd` — `classifyPrefsLayout(dir)` will
 * still pick those up if they exist on the machine running the test. Tests
 * below only assert on the "repo" (`.gsd/prefs.md`) and "local"
 * (`.gsd/prefs.local.md`) findings — the two layers anchored to `cwd` — by
 * filtering findings on their source path, never by asserting the full
 * findings array length.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { classifyPrefsShape, classifyPrefsLayout, PREFS_KEY_MAP } from "../migrate/prefs-layout.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-migrate-prefs-layout-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRepoPrefs(cwd: string, content: string): void {
  const gsdDir = join(cwd, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "prefs.md"), content);
}

function writeLocalPrefs(cwd: string, content: string): void {
  const gsdDir = join(cwd, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "prefs.local.md"), content);
}

function findingFor(findings: ReturnType<typeof classifyPrefsLayout>, suffix: string) {
  return findings.find((f) => f.source.endsWith(suffix));
}

const REPO_SUFFIX = join(".gsd", "prefs.md");
const LOCAL_SUFFIX = join(".gsd", "prefs.local.md");

// ── classifyPrefsShape — synthetic ───────────────────────────────────────────

describe("classifyPrefsShape — synthetic", () => {
  test("empty — blank/whitespace-only content", () => {
    assert.equal(classifyPrefsShape(""), "empty");
    assert.equal(classifyPrefsShape("   \n\t\n  "), "empty");
  });

  test("flat — plain key: value lines", () => {
    const raw = ["unit_models:", "  - sonnet", "  - haiku", "unit_timeout_ms: 120000"].join("\n");
    assert.equal(classifyPrefsShape(raw), "flat");
  });

  test("flat — key: value wrapped in a ```yaml fence plus trailing ## prose (real 2.0 shape)", () => {
    const raw = [
      "# Forge Agent — prefs",
      "",
      "```yaml",
      "ids:",
      "  format: timestamp",
      "unit_timeout_ms: 120000",
      "```",
      "",
      "## Notas para o orquestrador",
      "- alguma nota qualquer",
      "",
    ].join("\n");
    assert.equal(classifyPrefsShape(raw), "flat");
  });

  test("nested1x — `## Phase → Agent Routing` header present", () => {
    const raw = [
      "## Phase → Agent Routing",
      "",
      "| Phase | Agent | Model ID | Alias |",
      "|-------|-------|----------|-------|",
      "| execute-task | forge-executor | claude-sonnet-5 | sonnet |",
    ].join("\n");
    assert.equal(classifyPrefsShape(raw), "nested1x");
  });

  test("nested1x — markdown table row `| Phase | Agent |` without the header text", () => {
    const raw = ["some prose", "| Phase | Agent | Model ID | Alias |", "|---|---|---|---|"].join("\n");
    assert.equal(classifyPrefsShape(raw), "nested1x");
  });

  test("nested1x — fenced block containing skip_discuss:", () => {
    const raw = ["## Phase Skip Rules", "", "```", "skip_discuss: false", "skip_research: false", "```"].join(
      "\n",
    );
    assert.equal(classifyPrefsShape(raw), "nested1x");
  });

  test("unknown — ambiguous content: no key:value line, no 1.0 markers, never throws", () => {
    const raw = ["## Random Notes", "", "| A | B |", "|---|---|", "| 1 | 2 |", "", "Just prose here."].join(
      "\n",
    );
    assert.equal(classifyPrefsShape(raw), "unknown");
  });
});

// ── PREFS_KEY_MAP — static coverage ──────────────────────────────────────────

describe("PREFS_KEY_MAP — required entries", () => {
  function targetFor(legacyKey: string): string | null | undefined {
    return PREFS_KEY_MAP.find((m) => m.legacyKey === legacyKey)?.targetKey;
  }

  test("models/tier_models map to unit_models", () => {
    assert.equal(targetFor("models"), "unit_models");
    assert.equal(targetFor("tier_models"), "unit_models");
  });

  test("ids.format maps directly to ids.format", () => {
    assert.equal(targetFor("ids.format"), "ids.format");
  });

  test("review/plan_gate/evidence/milestone_cleanup have no equivalent (targetKey null)", () => {
    assert.equal(targetFor("review"), null);
    assert.equal(targetFor("plan_gate"), null);
    assert.equal(targetFor("evidence"), null);
    assert.equal(targetFor("milestone_cleanup"), null);
  });
});

// ── classifyPrefsLayout — synthetic (repo/local layers only) ────────────────

describe("classifyPrefsLayout — synthetic", () => {
  test("no repo/local prefs written → no repo/local finding present", () => {
    withSandbox((dir) => {
      const findings = classifyPrefsLayout(dir);
      assert.equal(findingFor(findings, REPO_SUFFIX), undefined);
      assert.equal(findingFor(findings, LOCAL_SUFFIX), undefined);
    });
  });

  test("repo layer flat → shape flat, zero unmapped", () => {
    withSandbox((dir) => {
      writeRepoPrefs(dir, "unit_models:\n  - sonnet\nunit_timeout_ms: 120000\n");
      const findings = classifyPrefsLayout(dir);
      const repo = findingFor(findings, REPO_SUFFIX);
      assert.ok(repo, "expected a finding for the repo layer");
      assert.equal(repo!.shape, "flat");
      assert.deepEqual(repo!.unmapped, []);
    });
  });

  test("repo layer nested1x with a loose evidence: key → shape nested1x, unmapped includes evidence", () => {
    withSandbox((dir) => {
      writeRepoPrefs(
        dir,
        [
          "## Phase → Agent Routing",
          "",
          "| Phase | Agent | Model ID | Alias |",
          "|-------|-------|----------|-------|",
          "| execute-task | forge-executor | claude-sonnet-5 | sonnet |",
          "",
          "evidence:",
          "  mode: lenient",
        ].join("\n"),
      );
      const findings = classifyPrefsLayout(dir);
      const repo = findingFor(findings, REPO_SUFFIX);
      assert.ok(repo, "expected a finding for the repo layer");
      assert.equal(repo!.shape, "nested1x");
      assert.ok(repo!.unmapped.includes("evidence"));
    });
  });

  test("repo (flat) + local (nested1x) layers classified independently", () => {
    withSandbox((dir) => {
      writeRepoPrefs(dir, "unit_models:\n  - sonnet\n");
      writeLocalPrefs(
        dir,
        ["## Phase → Agent Routing", "| Phase | Agent |", "|---|---|", "plan_gate:", "  interactive: always"].join(
          "\n",
        ),
      );
      const findings = classifyPrefsLayout(dir);
      const repo = findingFor(findings, REPO_SUFFIX);
      const local = findingFor(findings, LOCAL_SUFFIX);
      assert.ok(repo && local, "expected findings for both repo and local layers");
      assert.equal(repo!.shape, "flat");
      assert.equal(local!.shape, "nested1x");
      assert.ok(local!.unmapped.includes("plan_gate"));
    });
  });
});

// ── Real fixture 1: forge-agent 1.0's live forge-agent-prefs.md (nested1x) ──

const FORGE_AGENT_PREFS = join(homedir(), "Documents", "dev", "forge-agent", "forge-agent-prefs.md");
const FORGE_AGENT_SKIP =
  "~/Documents/dev/forge-agent não existe nesta máquina — projeto 1.0 separado, " +
  "fixture só disponível no workspace de desenvolvimento que o tem clonado";

describe(
  "classifyPrefsLayout — real fixture (forge-agent 1.0 forge-agent-prefs.md)",
  { skip: !existsSync(FORGE_AGENT_PREFS) && FORGE_AGENT_SKIP },
  () => {
    test("one-shot copy classifies as nested1x with evidence/plan_gate/milestone_cleanup unmapped", () => {
      let liveContent: string;
      try {
        liveContent = readFileSync(FORGE_AGENT_PREFS, "utf-8");
      } catch {
        return; // race with the skip guard above — bail out honestly, no assertion
      }

      withSandbox((dir) => {
        writeRepoPrefs(dir, liveContent);
        const findings = classifyPrefsLayout(dir);
        const repo = findingFor(findings, REPO_SUFFIX);
        assert.ok(repo, "expected a finding for the repo layer");
        assert.equal(repo!.shape, "nested1x");
        assert.ok(repo!.unmapped.includes("evidence"));
        assert.ok(repo!.unmapped.includes("plan_gate"));
        assert.ok(repo!.unmapped.includes("milestone_cleanup"));
        assert.ok(repo!.unmapped.includes("review"));
      });
    });
  },
);

// ── Real fixture 2: this repo's live .gsd/claude-agent-prefs.md (flat) ─────

const REPO_PREFS = join(process.cwd(), ".gsd", "claude-agent-prefs.md");

describe(
  "classifyPrefsLayout — real fixture (this repo's live .gsd/claude-agent-prefs.md)",
  { skip: !existsSync(REPO_PREFS) && "este repo não tem .gsd/claude-agent-prefs.md nesta checkout" },
  () => {
    test("one-shot copy classifies as flat with zero unmapped keys", () => {
      let liveContent: string;
      try {
        liveContent = readFileSync(REPO_PREFS, "utf-8");
      } catch {
        return;
      }

      withSandbox((dir) => {
        writeRepoPrefs(dir, liveContent);
        const findings = classifyPrefsLayout(dir);
        const repo = findingFor(findings, REPO_SUFFIX);
        assert.ok(repo, "expected a finding for the repo layer");
        assert.equal(repo!.shape, "flat");
        assert.deepEqual(repo!.unmapped, []);
      });
    });
  },
);
