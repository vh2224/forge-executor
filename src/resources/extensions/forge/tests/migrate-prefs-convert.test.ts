/**
 * Forge migrate — coverage for `prefs-convert.ts` (S02/T03): the nested1x →
 * flat 2.0 converter (`unit_models`/`ids` field-by-field extraction, verbatim
 * pass-through of already-flat values via the real `parsePrefsBlock`, and
 * structural WARN-listing of every other unrecognized nested block), the
 * legacy-layer read-only redirect, in-place conversion for the other layers,
 * idempotency, and a real-fixture regression against
 * `~/.claude/forge-agent-prefs.md`.
 *
 * Same isolated-home discipline as `prefs.test.ts`: both `HOME` and
 * `FORGE_HOME` are sandboxed to a `mkdtemp` dir (saved/restored in `finally`)
 * so a real `~/.claude/forge-agent-prefs.md` or `~/.forge/prefs.md` on the
 * machine running these tests never contaminates the synthetic cases.
 *
 * NOTE on the real-fixture assertions below: the live `~/.claude/forge-agent-
 * prefs.md` on this machine (read once, copied into a sandbox, never written
 * to) does NOT contain the exact model IDs a prior planning session's notes
 * assumed (no `claude-fable-5`, no `claude-sonnet-5` — this file uses
 * `claude-sonnet-4-6` throughout) and does not carry `review:`/`plan_gate:`
 * keys at all (it carries `plan_check:` instead, a different, still-nested
 * key). This test asserts against what the live file actually contains,
 * confirmed by direct inspection this session — see T03-SUMMARY.md
 * `## Deviations`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  extractUnitModels,
  extractIdsFormat,
  extractNestedMappingKeys,
  buildConvertedContent,
  computePrefsConversion,
  applyPrefsConversion,
} from "../migrate/prefs-convert.ts";
import { gsdHome } from "../../shared/compat/gsd-home.ts";

function withIsolatedHome<T>(fn: (fakeHome: string) => T): T {
  const fakeHome = mkdtempSync(join(tmpdir(), "forge-migrate-prefs-convert-home-"));
  const prevHome = process.env.HOME;
  const prevForgeHome = process.env.FORGE_HOME;
  process.env.HOME = fakeHome;
  process.env.FORGE_HOME = join(fakeHome, ".forge");
  try {
    return fn(fakeHome);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevForgeHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevForgeHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-migrate-prefs-convert-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeLegacyPrefs(fakeHome: string, content: string): string {
  const dir = join(fakeHome, ".claude");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "forge-agent-prefs.md");
  writeFileSync(path, content, "utf-8");
  return path;
}

function writeRepoPrefs(cwd: string, content: string): string {
  const dir = join(cwd, ".gsd");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "prefs.md");
  writeFileSync(path, content, "utf-8");
  return path;
}

// `classifyPrefsLayout` (S01/T02) only classifies content as `nested1x` when it
// carries an actual 1.0 signal (`## Phase → Agent Routing`, a `| Phase |
// Agent |` table row, or a fenced block with `skip_discuss:`) — a `##
// Phase → Agent Routing` header is included below purely so this fixture is
// classified `nested1x` by the real (reused, not reimplemented) classifier,
// exactly like every layer `computePrefsConversion` is asked to handle.
const SYNTHETIC_NESTED1X = [
  "## Phase → Agent Routing",
  "",
  "| Phase | Agent | Model ID | Alias |",
  "|-------|-------|----------|-------|",
  "| execute-task | forge-executor | claude-sonnet-5 | sonnet |",
  "",
  "## Modelos disponíveis",
  "",
  "| Alias | Model ID | Uso |",
  "|-------|----------|-----|",
  "| `sonnet` | `claude-sonnet-5` | padrão |",
  "| `haiku` | `claude-haiku-4-5-20251001` | leve |",
  "",
  "```",
  "tier_models:",
  "  light:    claude-haiku-4-5-20251001",
  "  standard: claude-sonnet-5",
  "```",
  "",
  "ids:",
  "  format: sequential",
  "",
  "auto_commit: true",
  "",
  "forge_isolation:",
  "  mode: shared",
  "",
].join("\n");

// ── extractUnitModels ────────────────────────────────────────────────────────

describe("extractUnitModels", () => {
  test("unites the alias table and the tier_models block, deduped, order of first appearance", () => {
    const models = extractUnitModels(SYNTHETIC_NESTED1X);
    assert.deepEqual(models, ["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  });

  test("handles a quoted tier_models value and strips the trailing comment", () => {
    const raw = ["```", "tier_models:", '  heavy:    "claude-opus-4-8[1m]"   # deepest reasoning', "```"].join(
      "\n",
    );
    assert.deepEqual(extractUnitModels(raw), ["claude-opus-4-8[1m]"]);
  });

  test("no 'Modelos disponíveis' section and no tier_models block → empty array", () => {
    assert.deepEqual(extractUnitModels("## Something Else\n\nprose only\n"), []);
  });
});

// ── extractIdsFormat ─────────────────────────────────────────────────────────

describe("extractIdsFormat", () => {
  test("extracts the format value from a nested ids: block", () => {
    assert.equal(extractIdsFormat("ids:\n  format: sequential\n"), "sequential");
  });

  test("returns null when there is no ids: block", () => {
    assert.equal(extractIdsFormat("auto_commit: true\n"), null);
  });
});

// ── extractNestedMappingKeys ─────────────────────────────────────────────────

describe("extractNestedMappingKeys", () => {
  test("flags a key: block whose indented lines are NOT a dash-list", () => {
    const keys = extractNestedMappingKeys("forge_isolation:\n  mode: shared\n  auto_pull_main: true\n");
    assert.deepEqual(keys, ["forge_isolation"]);
  });

  test("does NOT flag a key: block whose indented lines ARE a dash-list (parsePrefsBlock reads it fine)", () => {
    const keys = extractNestedMappingKeys("unit_models:\n  - sonnet\n  - haiku\n");
    assert.deepEqual(keys, []);
  });

  test("excludes tier_models and ids — handled field-by-field, never double-warned", () => {
    const keys = extractNestedMappingKeys("tier_models:\n  light: haiku\nids:\n  format: sequential\n");
    assert.deepEqual(keys, []);
  });

  test("a bare key: with nothing following (no indented lines at all) is not flagged", () => {
    const keys = extractNestedMappingKeys("empty_key:\nauto_commit: true\n");
    assert.deepEqual(keys, []);
  });
});

// ── buildConvertedContent ────────────────────────────────────────────────────

describe("buildConvertedContent", () => {
  test("models/tier_models are WARN-only (no unit_models guesswork), ids flattens, auto_commit passes through", () => {
    // External-review fix (2026-07-11): `unit_models` has zero consumers — the
    // real per-unit keys are unit_model_plan_slice/execute_task, and deriving
    // them from a 1.0 phase-routing table would be guesswork. WARN instead.
    const { content, warnedKeys } = buildConvertedContent(SYNTHETIC_NESTED1X, "legacy ~/.claude");
    assert.doesNotMatch(content, /unit_models:/);
    assert.match(content, /^ids: sequential$/m);
    assert.match(content, /^auto_commit: true$/m);
    assert.deepEqual([...warnedKeys].sort(), ["forge_isolation", "tier_models"]);
    assert.match(content, /## WARN — chaves 1\.0 sem conversão automática/);
    assert.match(content, /- forge_isolation:/);
    assert.match(content, /- tier_models:/);
  });

  test("a warned key present in PREFS_KEY_MAP uses its .note instead of the generic text", () => {
    const raw = "evidence:\n  mode: lenient\n";
    const { content } = buildConvertedContent(raw, "repo");
    assert.match(content, /- evidence: PostToolUse evidence-log settings have no 2\.0 equivalent yet\./);
  });
});

// ── computePrefsConversion — legacy layer redirects, others convert in-place ─

describe("computePrefsConversion", () => {
  test("legacy ~/.claude nested1x → targetPath redirects to gsdHome()/prefs.md, source untouched", () => {
    withIsolatedHome((fakeHome) => {
      withSandbox((cwd) => {
        const legacyPath = writeLegacyPrefs(fakeHome, SYNTHETIC_NESTED1X);
        const before = readFileSync(legacyPath, "utf-8");

        const plans = computePrefsConversion(cwd);
        const legacyPlan = plans.find((p) => p.sourceLabel === "legacy ~/.claude");
        assert.ok(legacyPlan, "expected a plan for the legacy ~/.claude layer");
        assert.notEqual(legacyPlan!.targetPath, legacyPlan!.sourcePath);
        assert.equal(legacyPlan!.targetPath, join(gsdHome(), "prefs.md"));
        assert.equal(legacyPlan!.targetLabel, "user (gsdHome)");
        assert.deepEqual([...legacyPlan!.warnedKeys].sort(), ["forge_isolation", "tier_models"]);
        assert.doesNotMatch(legacyPlan!.content, /unit_models:/);
        assert.match(legacyPlan!.content, /^ids: sequential$/m);

        // computing a plan never writes — source must be byte-identical.
        assert.equal(readFileSync(legacyPath, "utf-8"), before);
      });
    });
  });

  test("repo (.gsd/prefs.md) nested1x → targetPath === sourcePath (in-place)", () => {
    withIsolatedHome(() => {
      withSandbox((cwd) => {
        const repoPath = writeRepoPrefs(cwd, SYNTHETIC_NESTED1X);
        const plans = computePrefsConversion(cwd);
        const repoPlan = plans.find((p) => p.sourceLabel === "repo");
        assert.ok(repoPlan, "expected a plan for the repo layer");
        assert.equal(repoPlan!.targetPath, repoPlan!.sourcePath);
        assert.equal(repoPlan!.targetPath, repoPath);
      });
    });
  });
});

// ── applyPrefsConversion — writes via writeFileAtomic, idempotent ───────────

describe("applyPrefsConversion", () => {
  test("REFUSES to write the legacy layer outside cwd (skipped: outside-cwd) — report-only plan", () => {
    // External-review CRITICAL (2026-07-11): a --apply on a project fixture
    // wrote the operator's REAL ~/.forge/prefs.md — outside the migration
    // target, outside the backup. --apply is cwd-scoped: out-of-cwd targets
    // become report-only plans.
    withIsolatedHome((fakeHome) => {
      withSandbox((cwd) => {
        const legacyPath = writeLegacyPrefs(fakeHome, SYNTHETIC_NESTED1X);
        const beforeSource = readFileSync(legacyPath, "utf-8");

        const plans = applyPrefsConversion(cwd);
        const legacyPlan = plans.find((p) => p.sourceLabel === "legacy ~/.claude");
        assert.ok(legacyPlan);
        assert.equal(legacyPlan!.skipped, "outside-cwd");
        assert.ok(!existsSync(legacyPlan!.targetPath), "out-of-cwd target must NOT be written");

        // source (documented read-only) must remain untouched.
        assert.equal(readFileSync(legacyPath, "utf-8"), beforeSource);
      });
    });
  });

  test("repo layer converts in-place: the .gsd/prefs.md file itself is overwritten with flat content", () => {
    withIsolatedHome(() => {
      withSandbox((cwd) => {
        const repoPath = writeRepoPrefs(cwd, SYNTHETIC_NESTED1X);
        applyPrefsConversion(cwd);
        const after = readFileSync(repoPath, "utf-8");
        assert.doesNotMatch(after, /unit_models:/);
        assert.match(after, /^ids: sequential$/m);
        assert.match(after, /- tier_models:/);
      });
    });
  });

  test("idempotent: calling applyPrefsConversion twice never duplicates warnedKeys or grows the file", () => {
    withIsolatedHome((fakeHome) => {
      withSandbox((cwd) => {
        writeLegacyPrefs(fakeHome, SYNTHETIC_NESTED1X);
        writeRepoPrefs(cwd, SYNTHETIC_NESTED1X);

        const firstPlans = applyPrefsConversion(cwd);
        const firstLegacy = firstPlans.find((p) => p.sourceLabel === "legacy ~/.claude")!;
        const firstRepo = firstPlans.find((p) => p.sourceLabel === "repo")!;
        assert.equal(firstLegacy.skipped, "outside-cwd");
        assert.ok(!existsSync(firstLegacy.targetPath));
        const firstRepoWritten = readFileSync(firstRepo.targetPath, "utf-8");

        const secondPlans = applyPrefsConversion(cwd);
        const secondLegacy = secondPlans.find((p) => p.sourceLabel === "legacy ~/.claude")!;
        const secondRepoPlan = secondPlans.find((p) => p.sourceLabel === "repo");

        // legacy stays report-only on every run — never written, stable WARNs.
        assert.equal(secondLegacy.skipped, "outside-cwd");
        assert.ok(!existsSync(secondLegacy.targetPath));
        assert.deepEqual(secondLegacy.warnedKeys, firstLegacy.warnedKeys);

        // the repo layer, once converted in-place, is now flat 2.0-native —
        // classifyPrefsLayout no longer reports it as nested1x, so the second
        // call produces no plan for it at all (no reconversion, no growth).
        assert.equal(secondRepoPlan, undefined);
        assert.equal(readFileSync(firstRepo.targetPath, "utf-8"), firstRepoWritten);
      });
    });
  });
});

// ── Real fixture: this machine's live ~/.claude/forge-agent-prefs.md ───────

const FORGE_AGENT_PREFS = join(homedir(), ".claude", "forge-agent-prefs.md");
const FORGE_AGENT_PREFS_SKIP = "~/.claude/forge-agent-prefs.md não existe nesta máquina";

describe(
  "computePrefsConversion — real fixture (~/.claude/forge-agent-prefs.md)",
  { skip: !existsSync(FORGE_AGENT_PREFS) && FORGE_AGENT_PREFS_SKIP },
  () => {
    test("legacy layer redirects to gsdHome()/prefs.md; unit_models/ids extracted; several nested blocks WARN", () => {
      let liveContent: string;
      try {
        liveContent = readFileSync(FORGE_AGENT_PREFS, "utf-8");
      } catch {
        return; // race with the skip guard above — bail out honestly, no assertion
      }

      withIsolatedHome((fakeHome) => {
        withSandbox((cwd) => {
          writeLegacyPrefs(fakeHome, liveContent);

          const plans = computePrefsConversion(cwd);
          const legacyPlan = plans.find((p) => p.sourceLabel === "legacy ~/.claude");
          assert.ok(legacyPlan, "expected a plan for the legacy ~/.claude layer");
          assert.equal(legacyPlan!.targetPath, join(gsdHome(), "prefs.md"));

          // The live fixture on this machine documents claude-opus-4-8[1m]
          // (alias table + tier_models "heavy"/"max"), claude-sonnet-4-6
          // (alias table + tier_models "standard"), and
          // claude-haiku-4-5-20251001 (alias table + tier_models "light") —
          // proving both extractors ran and their union deduped correctly.
          // models/tier_models are WARN-only now (external-review 2026-07-11)
          // — no unit_models emission, the model ids must NOT be written.
          assert.ok(!legacyPlan!.content.includes("unit_models:"), "no unit_models guesswork");
          // The live fixture's model catalog is a markdown TABLE (## Modelos
          // disponíveis), not a `models:` yaml key — only tier_models exists
          // as a block there.
          assert.ok(legacyPlan!.warnedKeys.includes("tier_models"), "expected warnedKeys to include tier_models");

          assert.match(legacyPlan!.content, /^ids: sequential$/m);

          // Structurally-nested blocks with no dash-list and no field-by-field
          // extractor genuinely present in the live fixture — WARN-listed.
          for (const key of ["evidence", "forge_isolation", "retry", "plan_check", "checker_memory"]) {
            assert.ok(legacyPlan!.warnedKeys.includes(key), `expected warnedKeys to include ${key}`);
          }

          // milestone_cleanup is a FLAT single-line key in the live fixture
          // (`milestone_cleanup: archive`), not a nested block — it passes
          // through like any other flat value, per parsePrefsBlock's existing
          // (reused, not reimplemented) behavior; it must NOT appear in
          // warnedKeys.
          assert.ok(!legacyPlan!.warnedKeys.includes("milestone_cleanup"));
        });
      });
    });
  },
);
