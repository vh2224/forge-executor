import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCapabilities,
  readCapabilities,
  capabilityFor,
  capabilitySources,
  emptyCapabilities,
  type CapabilityMatrix,
} from "../auto/capability-matrix.ts";

/** Swaps `console.warn` for a collector for the duration of `fn`, restores it after. */
function captureWarnings(fn: () => void): string[] {
  const original = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return messages;
}

function withScratchDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-capability-matrix-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Happy-path table: 2 domains × 2 refs, with sources, locked and updated. */
const FULL_TABLE = `
updated: 2026-07-11

| domain | model | score | locked | sources |
|--------|-------|-------|--------|---------|
| infra | claude-code/claude-opus-4-8 | 0.9 | locked | https://example.com/bench (2026-07-11) |
| infra | openai/gpt-5.5 | 0.8 | | |
| frontend | claude-code/claude-sonnet-5 | 0.7 | | https://example.com/fe (2026-07-10) |
| frontend | openai/gpt-5-mini | 0.55 | yes | |
`;

describe("parseCapabilities", () => {
  test("parses the happy-path table: 2 domains × 2 refs, scores, locked, sources", () => {
    const matrix = parseCapabilities(FULL_TABLE);

    assert.deepEqual(Object.keys(matrix.domains).sort(), ["frontend", "infra"]);
    assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].score, 0.9);
    assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].locked, true);
    assert.equal(
      matrix.domains.infra["claude-code/claude-opus-4-8"].sources,
      "https://example.com/bench (2026-07-11)",
    );
    assert.equal(matrix.domains.infra["openai/gpt-5.5"].score, 0.8);
    assert.equal(matrix.domains.infra["openai/gpt-5.5"].locked, false);
    assert.equal(matrix.domains.infra["openai/gpt-5.5"].sources, undefined);
    assert.equal(matrix.domains.frontend["claude-code/claude-sonnet-5"].score, 0.7);
    assert.equal(matrix.domains.frontend["openai/gpt-5-mini"].score, 0.55);
    assert.equal(matrix.domains.frontend["openai/gpt-5-mini"].locked, true);
  });

  test("header and separator rows fall out silently — zero warnings on the happy path", () => {
    const warnings = captureWarnings(() => {
      parseCapabilities(FULL_TABLE);
    });
    assert.deepEqual(warnings, []);
  });

  test("captures the file-level `updated:` metadata line outside the table", () => {
    const matrix = parseCapabilities(FULL_TABLE);
    assert.equal(matrix.updated, "2026-07-11");
  });

  test("numeric score out of [0,1] warns (named) and skips; non-numeric score skips SILENTLY", () => {
    const raw = `
| infra | claude-code/claude-opus-4-8 | 1.5 | | |
| infra | openai/gpt-5.5 | abc | | |
| infra | openai/gpt-5-mini | -0.1 | | |
| infra | claude-code/claude-sonnet-5 | 0.6 | | |
`;
    let matrix!: CapabilityMatrix;
    const warnings = captureWarnings(() => {
      matrix = parseCapabilities(raw);
    });
    assert.ok(warnings.some((w) => w.includes("out of [0,1]") && w.includes('"1.5"')));
    assert.ok(warnings.some((w) => w.includes("out of [0,1]") && w.includes('"-0.1"')));
    // the non-numeric "abc" row must NOT have warned — silent tolerance path.
    assert.ok(!warnings.some((w) => w.includes("abc")));
    assert.equal(warnings.length, 2);
    // only the valid row became an entry.
    assert.deepEqual(Object.keys(matrix.domains.infra), ["claude-code/claude-sonnet-5"]);
    assert.equal(matrix.domains.infra["claude-code/claude-sonnet-5"].score, 0.6);
  });

  test("boundary scores 0 and 1 are accepted (inclusive range)", () => {
    const raw = `
| infra | a/zero | 0 | | |
| infra | a/one | 1 | | |
`;
    const matrix = parseCapabilities(raw);
    assert.equal(matrix.domains.infra["a/zero"].score, 0);
    assert.equal(matrix.domains.infra["a/one"].score, 1);
  });

  test("locked truthy variants — locked/true/yes case-insensitive; anything else is false", () => {
    const raw = `
| infra | a/locked | 0.5 | locked | |
| infra | a/true | 0.5 | TRUE | |
| infra | a/yes | 0.5 | Yes | |
| infra | a/no | 0.5 | no | |
| infra | a/empty | 0.5 | | |
| infra | a/other | 0.5 | 1 | |
`;
    const matrix = parseCapabilities(raw);
    assert.equal(matrix.domains.infra["a/locked"].locked, true);
    assert.equal(matrix.domains.infra["a/true"].locked, true);
    assert.equal(matrix.domains.infra["a/yes"].locked, true);
    assert.equal(matrix.domains.infra["a/no"].locked, false);
    assert.equal(matrix.domains.infra["a/empty"].locked, false);
    assert.equal(matrix.domains.infra["a/other"].locked, false);
  });

  test("domain is lowercased at parse time; ref is kept verbatim (D-S02-3)", () => {
    const raw = "| INFRA | Claude-Code/Claude-Opus-4-8 | 0.9 | | |";
    const matrix = parseCapabilities(raw);
    assert.deepEqual(Object.keys(matrix.domains), ["infra"]);
    assert.deepEqual(Object.keys(matrix.domains.infra), ["Claude-Code/Claude-Opus-4-8"]);
    assert.equal(matrix.domains.infra["Claude-Code/Claude-Opus-4-8"].domain, "infra");
  });

  test("duplicate (domain, ref) in the same raw warns (named) and applies last-wins", () => {
    const raw = `
| infra | claude-code/claude-opus-4-8 | 0.9 | locked | |
| infra | claude-code/claude-opus-4-8 | 0.4 | | |
`;
    let matrix!: CapabilityMatrix;
    const warnings = captureWarnings(() => {
      matrix = parseCapabilities(raw);
    });
    assert.ok(
      warnings.some(
        (w) =>
          w.includes("duplicate entry") &&
          w.includes('"infra"') &&
          w.includes('"claude-code/claude-opus-4-8"'),
      ),
    );
    assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].score, 0.4);
    assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].locked, false);
  });

  test("malformed ref (not provider/model-id) warns (named) but the entry is PRESERVED", () => {
    const raw = `
| infra | gpt-5 | 0.5 | | |
| infra | openai/ | 0.5 | | |
| infra | a/b/c | 0.5 | | |
`;
    let matrix!: CapabilityMatrix;
    const warnings = captureWarnings(() => {
      matrix = parseCapabilities(raw);
    });
    for (const ref of ["gpt-5", "openai/", "a/b/c"]) {
      assert.ok(
        warnings.some((w) => w.includes("malformed ref") && w.includes(`"${ref}"`)),
        `expected a malformed-ref WARN for "${ref}"`,
      );
      assert.ok(ref in matrix.domains.infra, `expected "${ref}" preserved in the matrix`);
    }
    assert.equal(matrix.domains.infra["gpt-5"].score, 0.5);
  });

  test("empty and garbage raw degrade to an empty matrix, never throw", () => {
    assert.doesNotThrow(() => parseCapabilities(""));
    assert.deepEqual(parseCapabilities(""), emptyCapabilities());
    const garbage = "not a table\n:::: |||| ::::\n| too | few |\nscore: what\n";
    assert.doesNotThrow(() => parseCapabilities(garbage));
    assert.deepEqual(parseCapabilities(garbage), emptyCapabilities());
  });

  test("fenced and non-fenced tables both parse identically (line-based tolerance)", () => {
    const bare = "| infra | claude-code/claude-opus-4-8 | 0.9 | locked | |";
    const fenced = ["```", bare, "```"].join("\n");
    const fromBare = parseCapabilities(bare);
    const fromFenced = parseCapabilities(fenced);
    assert.deepEqual(fromBare, fromFenced);
    assert.equal(fromFenced.domains.infra["claude-code/claude-opus-4-8"].score, 0.9);
  });
});

describe("capabilitySources", () => {
  test("returns the 2 project-scope layers, repo then local", () => {
    withScratchDir((dir) => {
      const sources = capabilitySources(dir);
      assert.equal(sources.length, 2);
      assert.equal(sources[0].label, "repo");
      assert.equal(sources[0].path, join(dir, ".gsd", "CAPABILITIES.md"));
      assert.equal(sources[1].label, "local");
      assert.equal(sources[1].path, join(dir, ".gsd", "CAPABILITIES.local.md"));
    });
  });
});

describe("readCapabilities — cascade (demo ROADMAP §S02)", () => {
  test("no layer exists ⇒ empty matrix, never throws", () => {
    withScratchDir((dir) => {
      assert.doesNotThrow(() => readCapabilities(dir));
      assert.deepEqual(readCapabilities(dir), emptyCapabilities());
    });
  });

  test("only the repo layer exists ⇒ its entries pass through", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.md"), FULL_TABLE);
      const matrix = readCapabilities(dir);
      assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].score, 0.9);
      assert.equal(matrix.domains.frontend["openai/gpt-5-mini"].score, 0.55);
      assert.equal(matrix.updated, "2026-07-11");
    });
  });

  test("local.md overrides the repo score for the same (domain, ref); unmentioned keys pass intact", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.md"), FULL_TABLE);
      writeFileSync(
        join(dir, ".gsd", "CAPABILITIES.local.md"),
        [
          "| infra | claude-code/claude-opus-4-8 | 0.3 | | operator judgment |",
          "| backend | openai/gpt-5.5 | 0.65 | | |",
        ].join("\n"),
      );
      const matrix = readCapabilities(dir);
      // local overwrites the shared key...
      assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].score, 0.3);
      assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].sources, "operator judgment");
      // ...repo-only keys pass through untouched...
      assert.equal(matrix.domains.infra["openai/gpt-5.5"].score, 0.8);
      assert.equal(matrix.domains.frontend["claude-code/claude-sonnet-5"].score, 0.7);
      // ...and local-only keys enter the merge.
      assert.equal(matrix.domains.backend["openai/gpt-5.5"].score, 0.65);
    });
  });

  test("cross-layer override emits NO warn (D-S02-4 — designed usage path)", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "CAPABILITIES.md"),
        "| infra | claude-code/claude-opus-4-8 | 0.9 | locked | |",
      );
      writeFileSync(
        join(dir, ".gsd", "CAPABILITIES.local.md"),
        "| infra | claude-code/claude-opus-4-8 | 0.3 | | |",
      );
      let matrix!: CapabilityMatrix;
      const warnings = captureWarnings(() => {
        matrix = readCapabilities(dir);
      });
      assert.deepEqual(warnings, []);
      assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].score, 0.3);
    });
  });

  test("locked from the repo layer survives the merge when local does not mention the row", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "CAPABILITIES.md"),
        [
          "| infra | claude-code/claude-opus-4-8 | 0.9 | locked | |",
          "| infra | openai/gpt-5.5 | 0.8 | | |",
        ].join("\n"),
      );
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.local.md"), "| infra | openai/gpt-5.5 | 0.4 | | |");
      const matrix = readCapabilities(dir);
      // locked row untouched by local: flag queryable post-merge (S04 write contract).
      assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].locked, true);
      assert.equal(matrix.domains.infra["claude-code/claude-opus-4-8"].score, 0.9);
      assert.equal(matrix.domains.infra["openai/gpt-5.5"].score, 0.4);
    });
  });

  test("locked set by the local layer is also queryable on the merged matrix", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.md"), "| infra | openai/gpt-5.5 | 0.8 | | |");
      writeFileSync(
        join(dir, ".gsd", "CAPABILITIES.local.md"),
        "| infra | openai/gpt-5.5 | 0.85 | locked | |",
      );
      const matrix = readCapabilities(dir);
      assert.equal(matrix.domains.infra["openai/gpt-5.5"].locked, true);
      assert.equal(matrix.domains.infra["openai/gpt-5.5"].score, 0.85);
    });
  });

  test("`updated` of the last layer that declares it wins; otherwise the earlier one passes through", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.md"), "updated: 2026-07-01\n");
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.local.md"), "updated: 2026-07-11\n");
      assert.equal(readCapabilities(dir).updated, "2026-07-11");
    });
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.md"), "updated: 2026-07-01\n");
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.local.md"), "| infra | a/b | 0.5 | | |");
      assert.equal(readCapabilities(dir).updated, "2026-07-01");
    });
  });

  test("an unreadable layer (directory in place of a file) degrades without throwing", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd", "CAPABILITIES.md"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.local.md"), "| infra | a/b | 0.5 | | |");
      assert.doesNotThrow(() => readCapabilities(dir));
      const matrix = readCapabilities(dir);
      assert.equal(matrix.domains.infra["a/b"].score, 0.5);
    });
  });

  test("missing local layer ⇒ repo passes through alone", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.md"), "| infra | a/b | 0.5 | | |");
      const matrix = readCapabilities(dir);
      assert.deepEqual(Object.keys(matrix.domains), ["infra"]);
      assert.equal(matrix.domains.infra["a/b"].score, 0.5);
    });
  });
});

describe("capabilityFor — pure lookup, degrades to undefined", () => {
  const matrix = parseCapabilities(FULL_TABLE);

  test("exact hit returns the merged score", () => {
    assert.equal(capabilityFor(matrix, "infra", "claude-code/claude-opus-4-8"), 0.9);
    assert.equal(capabilityFor(matrix, "frontend", "openai/gpt-5-mini"), 0.55);
  });

  test("domain lookup is case-insensitive (lowercased both sides)", () => {
    assert.equal(capabilityFor(matrix, "INFRA", "claude-code/claude-opus-4-8"), 0.9);
    assert.equal(capabilityFor(matrix, "Frontend", "claude-code/claude-sonnet-5"), 0.7);
  });

  test("unknown domain ⇒ undefined (no effect on the rank)", () => {
    assert.equal(capabilityFor(matrix, "backend", "claude-code/claude-opus-4-8"), undefined);
  });

  test("unknown ref ⇒ undefined; ref is exact-match, NOT case-normalized", () => {
    assert.equal(capabilityFor(matrix, "infra", "openai/gpt-9000"), undefined);
    assert.equal(capabilityFor(matrix, "infra", "CLAUDE-CODE/CLAUDE-OPUS-4-8"), undefined);
  });

  test("empty matrix ⇒ undefined, never throws", () => {
    assert.doesNotThrow(() => capabilityFor(emptyCapabilities(), "infra", "a/b"));
    assert.equal(capabilityFor(emptyCapabilities(), "infra", "a/b"), undefined);
  });

  test("lookup after a cascade read returns the LOCAL-layer score (end-to-end demo)", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "CAPABILITIES.md"), FULL_TABLE);
      writeFileSync(
        join(dir, ".gsd", "CAPABILITIES.local.md"),
        "| infra | claude-code/claude-opus-4-8 | 0.25 | | |",
      );
      const merged = readCapabilities(dir);
      assert.equal(capabilityFor(merged, "infra", "claude-code/claude-opus-4-8"), 0.25);
      assert.equal(capabilityFor(merged, "infra", "openai/gpt-5.5"), 0.8);
      assert.equal(capabilityFor(merged, "infra", "unknown/model"), undefined);
    });
  });
});
