import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCapabilities, capabilityFor } from "../auto/capability-matrix.ts";

/**
 * Doc↔parser contract test: the canonical example in
 * `docs/forge/FORGE2-CAPABILITIES-FORMAT.md` §Exemplo canônico is read
 * from the REAL doc on disk and parsed with the REAL `parseCapabilities`
 * from T01. If the doc's example and the parser's behavior ever diverge
 * silently, this gate goes red — editing either side requires keeping
 * the other honest.
 */

/**
 * Walks up from this test file until the repo root (marked by
 * `pnpm-workspace.yaml`), so the test resolves the doc identically
 * whether it runs from `src/` (strip-types runner) or a compiled tree.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("repo root (pnpm-workspace.yaml) not found above test file");
    }
    dir = parent;
  }
  return dir;
}

const DOC_PATH = join(repoRoot(), "docs", "forge", "FORGE2-CAPABILITIES-FORMAT.md");

/**
 * Extracts the FIRST fenced block after the canonical-example heading —
 * the extraction contract stated in the doc itself ("este é o PRIMEIRO
 * bloco fenced após este heading").
 */
function canonicalExample(doc: string): string {
  const headingAt = doc.search(/^## .*Exemplo canônico.*$/mu);
  assert.notEqual(headingAt, -1, "doc must contain the '## … Exemplo canônico' heading");
  const afterHeading = doc.slice(headingAt);
  const fenced = afterHeading.match(/^```[^\n]*\n([\s\S]*?)^```/mu);
  assert.ok(fenced, "doc must contain a fenced block after the canonical-example heading");
  return fenced[1];
}

describe("FORGE2-CAPABILITIES-FORMAT.md — doc↔parser contract", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const example = canonicalExample(doc);
  const matrix = parseCapabilities(example);

  test("canonical example parses to the expected shape: 3 domains × 2 refs", () => {
    assert.deepEqual(Object.keys(matrix.domains).sort(), ["docs", "frontend", "infra"]);
    for (const domain of Object.keys(matrix.domains)) {
      assert.equal(
        Object.keys(matrix.domains[domain]).length,
        2,
        `domain "${domain}" must have exactly 2 refs`,
      );
    }
  });

  test("file-level `updated:` metadata is captured", () => {
    assert.equal(matrix.updated, "2026-07-12");
  });

  test("scores land verbatim on the expected cells", () => {
    assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].score, 0.95);
    assert.equal(matrix.domains.infra["openai/gpt-5.5"].score, 0.85);
    assert.equal(matrix.domains.frontend["openai/gpt-5.5"].score, 0.9);
    assert.equal(matrix.domains.docs["openai/gpt-5-mini"].score, 0.6);
  });

  test("the locked row survives parse with locked === true; all others are false", () => {
    const lockedEntry = matrix.domains.frontend["claude-code/claude-sonnet-5"];
    assert.equal(lockedEntry.locked, true);
    assert.equal(lockedEntry.score, 0.8);

    const unlockedCount = Object.values(matrix.domains)
      .flatMap((entries) => Object.values(entries))
      .filter((entry) => !entry.locked).length;
    assert.equal(unlockedCount, 5, "exactly one row of the 6 is locked");
  });

  test("sources are preserved verbatim, URL + embedded date", () => {
    assert.equal(
      matrix.domains.infra["claude-code/claude-opus-4-8"].sources,
      "https://exemplo.dev/bench/opus-infra (2026-07-10)",
    );
    assert.equal(
      matrix.domains.frontend["claude-code/claude-sonnet-5"].sources,
      "curadoria manual do operador (2026-07-11)",
    );
  });

  test("capabilityFor resolves a score from the example and degrades unknowns to undefined", () => {
    assert.equal(capabilityFor(matrix, "infra", "claude-code/claude-opus-4-8"), 0.95);
    // Domain is lowercased at lookup time (D-S02-3).
    assert.equal(capabilityFor(matrix, "INFRA", "claude-code/claude-opus-4-8"), 0.95);
    // Unknown domain / unknown ref ⇒ undefined ⇒ "no effect on the rank".
    assert.equal(capabilityFor(matrix, "security", "claude-code/claude-opus-4-8"), undefined);
    assert.equal(capabilityFor(matrix, "infra", "openai/gpt-5-mini"), undefined);
  });

  test("the canonical example parses clean — zero named warns", () => {
    const original = console.warn;
    const messages: string[] = [];
    console.warn = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      parseCapabilities(example);
    } finally {
      console.warn = original;
    }
    assert.deepEqual(messages, []);
  });
});
