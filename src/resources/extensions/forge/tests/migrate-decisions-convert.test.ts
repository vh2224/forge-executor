/**
 * Forge migrate — coverage for `decisions-convert.ts` (S02/T04): parsing the
 * 1.0 when/scope/choice/rationale/revisable shape (block-scalar AND inline
 * values in the same file), `id` synthesis, legacy-field preservation in the
 * 2.0 fragment body, shape-skip behavior, and the real write path via
 * `writeDecisionFragment`.
 *
 * Same one-shot-copy / skip-honest discipline as `migrate-memory-convert.test.ts`
 * (T05): the live `~/Documents/dev/forge-agent/.gsd/decisions/M002.md` fixture
 * (a separate 1.0 project) is read AT MOST once, copied into a `mkdtemp`
 * sandbox, and only the sandbox copy is asserted against. Skips honestly when
 * the fixture is absent from this machine instead of red-falsing.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  parseLegacyDecisionFragment,
  convertLegacyDecisions,
  computeDecisionsConversion,
  applyDecisionsConversion,
} from "../migrate/decisions-convert.ts";
import { parseDecisionFragment, serializeDecisionFragment, type DecisionFragment } from "../state/decisions.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-migrate-decisions-convert-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeDecisionsFile(cwd: string, fileName: string, content: string): void {
  const dir = join(cwd, ".gsd", "decisions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), content);
}

// Two decisions in the SAME file: first uses `revisable: |` (block-scalar),
// second uses `revisable: no` (inline) — proves the parser handles both forms
// for the same field simultaneously, per the real fixture's own mix.
const SYNTHETIC_LEGACY = [
  "---",
  "decisions:",
  "  - when: 2026-06-20",
  "    scope: milestone",
  "    decision: Trigger do handshake interativo",
  "    choice: Sempre que houver plano",
  "    rationale: Usuario priorizou controle",
  "    revisable: |",
  "      yes",
  "  - when: 2026-06-21",
  "    scope: task",
  "    decision: Local da spec do gate",
  "    choice: shared/forge-plan-gate.md",
  "    rationale: Espelha shared/forge-review.md",
  "    revisable: no",
  "unit_id: M100",
  "---",
  "",
].join("\n");

// ── parseLegacyDecisionFragment — synthetic ─────────────────────────────────

describe("parseLegacyDecisionFragment", () => {
  test("parses both rows, unit_id, block-scalar AND inline revisable values in the same file", () => {
    const { unitId, rows } = parseLegacyDecisionFragment(SYNTHETIC_LEGACY);
    assert.equal(unitId, "M100");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].when, "2026-06-20");
    assert.equal(rows[0].revisable, "yes"); // block-scalar
    assert.equal(rows[1].when, "2026-06-21");
    assert.equal(rows[1].revisable, "no"); // inline
    assert.equal(rows[0].decision, "Trigger do handshake interativo");
    assert.equal(rows[1].scope, "task");
  });

  test("unit_id AFTER the decisions: block is still picked up", () => {
    const { unitId } = parseLegacyDecisionFragment(SYNTHETIC_LEGACY);
    assert.equal(unitId, "M100");
  });

  test("no fenced header → empty rows, never throws", () => {
    const { unitId, rows } = parseLegacyDecisionFragment("# not a fragment\n");
    assert.equal(unitId, "");
    assert.deepEqual(rows, []);
  });
});

// ── convertLegacyDecisions — id synthesis + legacy-field body ───────────────

describe("convertLegacyDecisions", () => {
  test("synthesizes <unitId>-D<N> ids in appearance order, maps when→date, preserves scope/choice/revisable in body", () => {
    const { rows } = parseLegacyDecisionFragment(SYNTHETIC_LEGACY);
    const fragment = convertLegacyDecisions("M100", rows);

    assert.equal(fragment.unit_id, "M100");
    assert.equal(fragment.decisions.length, 2);
    assert.equal(fragment.decisions[0].id, "M100-D1");
    assert.equal(fragment.decisions[1].id, "M100-D2");
    assert.equal(fragment.decisions[0].date, "2026-06-20");
    assert.equal(fragment.decisions[0].decision, "Trigger do handshake interativo");
    assert.equal(fragment.decisions[0].rationale, "Usuario priorizou controle");

    assert.match(fragment.body, /## Legacy fields \(forge 1\.0\)/);
    assert.match(fragment.body, /### M100-D1[\s\S]*?- scope: milestone[\s\S]*?- choice: Sempre que houver plano[\s\S]*?- revisable: yes/);
    assert.match(fragment.body, /### M100-D2[\s\S]*?- scope: task[\s\S]*?- choice: shared\/forge-plan-gate\.md[\s\S]*?- revisable: no/);
  });
});

// ── computeDecisionsConversion — synthetic ──────────────────────────────────

describe("computeDecisionsConversion", () => {
  test("missing .gsd/decisions/ → [] (never throws)", () => {
    withSandbox((dir) => {
      assert.deepEqual(computeDecisionsConversion(dir), []);
    });
  });

  test("1.0-shape .md → converted with unitId from filename", () => {
    withSandbox((dir) => {
      writeDecisionsFile(dir, "M100.md", SYNTHETIC_LEGACY);
      const results = computeDecisionsConversion(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].unitId, "M100");
      assert.equal(results[0].fragment.decisions.length, 2);
    });
  });

  test("already 2.0-native fragment (id/decision/rationale/date) → skipped", () => {
    withSandbox((dir) => {
      const fragment: DecisionFragment = {
        unit_id: "M100",
        decisions: [{ id: "M100-D1", decision: "algo", rationale: "por que", date: "2026-01-01" }],
        body: "",
      };
      writeDecisionsFile(dir, "M100.md", serializeDecisionFragment(fragment));
      assert.deepEqual(computeDecisionsConversion(dir), []);
    });
  });

  test("unrecognized-shape .md content (loose markdown table, like legacy-orphan.md) → skipped, never throws, never produces a fragment", () => {
    withSandbox((dir) => {
      writeDecisionsFile(dir, "legacy-orphan.md", "# Not a fragment\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
      assert.deepEqual(computeDecisionsConversion(dir), []);
    });
  });
});

// ── applyDecisionsConversion — real write + round-trip ──────────────────────

describe("applyDecisionsConversion", () => {
  test("writes via writeDecisionFragment — round-trips through the real 2.0 parser with all 4 fields matching, body preserved", () => {
    withSandbox((dir) => {
      writeDecisionsFile(dir, "M100.md", SYNTHETIC_LEGACY);
      const results = applyDecisionsConversion(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].created, true);

      const raw = readFileSync(results[0].path, "utf-8");
      const reparsed = parseDecisionFragment(raw);
      assert.equal(reparsed.unit_id, "M100");
      assert.equal(reparsed.decisions.length, 2);
      assert.equal(reparsed.decisions[0].id, "M100-D1");
      assert.equal(reparsed.decisions[0].date, "2026-06-20");
      assert.equal(reparsed.decisions[0].decision, "Trigger do handshake interativo");
      assert.equal(reparsed.decisions[0].rationale, "Usuario priorizou controle");
      assert.equal(reparsed.decisions[1].id, "M100-D2");
      assert.match(reparsed.body, /## Legacy fields \(forge 1\.0\)/);
      assert.match(reparsed.body, /revisable: yes/);
      assert.match(reparsed.body, /revisable: no/);
    });
  });
});

// ── Real fixture: forge-agent 1.0's live decisions/M002.md ──────────────────

const FORGE_AGENT_ROOT = join(homedir(), "Documents", "dev", "forge-agent");
const FORGE_AGENT_M002_DECISIONS = join(FORGE_AGENT_ROOT, ".gsd", "decisions", "M002.md");
const FORGE_AGENT_SKIP =
  "~/Documents/dev/forge-agent não existe nesta máquina — projeto 1.0 separado, fixture só disponível no " +
  "workspace de desenvolvimento que o tem clonado";

describe(
  "computeDecisionsConversion — real fixture (forge-agent 1.0 decisions/M002.md)",
  { skip: !existsSync(FORGE_AGENT_M002_DECISIONS) && FORGE_AGENT_SKIP },
  () => {
    test("one-shot copy converts to exactly 6 DecisionRow (M002-D1..M002-D6), all revisable in block-scalar form, no empty decision/rationale", () => {
      let liveContent: string;
      try {
        liveContent = readFileSync(FORGE_AGENT_M002_DECISIONS, "utf-8");
      } catch {
        return;
      }

      withSandbox((dir) => {
        writeDecisionsFile(dir, "M002.md", liveContent);
        const results = computeDecisionsConversion(dir);
        assert.equal(results.length, 1);
        assert.equal(results[0].unitId, "M002");

        const { decisions } = results[0].fragment;
        assert.equal(decisions.length, 6);
        const ids = decisions.map((d) => d.id);
        assert.deepEqual(ids, ["M002-D1", "M002-D2", "M002-D3", "M002-D4", "M002-D5", "M002-D6"]);
        for (const row of decisions) {
          assert.ok(row.decision.length > 0);
          assert.ok(row.rationale.length > 0);
          assert.ok(row.date.length > 0);
        }
      });
    });
  },
);

test("a CONVERTED fragment (2.0 frontmatter + '## Legacy fields' body) is NEVER re-selected for conversion", () => {
  // Double-apply corruption caught live 2026-07-11: the preserved legacy-field
  // body section matched LEGACY_SIGNAL against the whole file, so run 2
  // re-parsed the converted fragment with the legacy parser and wiped dates
  // to "". The signal is now frontmatter-scoped.
  withSandbox((cwd) => {
    const dir = join(cwd, ".gsd", "decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "M001.md"),
      [
        "---",
        "unit_id: M001",
        "decisions:",
        "  - id: M001-D1",
        "    decision: algo",
        "    rationale: porque sim",
        "    date: 2026-06-10",
        "---",
        "",
        "## Legacy fields (forge 1.0)",
        "",
        "### M001-D1",
        "- scope: programa",
        "- choice: A",
        "- revisable: nao",
        "",
      ].join("\n"),
    );
    const results = computeDecisionsConversion(cwd);
    assert.deepEqual(results, [], "converted fragment must not be re-converted");
  });
});
