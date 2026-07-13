import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseModelsConfig,
  readModelsConfig,
  modelsConfigSources,
  type ModelsConfig,
} from "../auto/models-config.ts";

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

const FULL_SHAPE = `
models:
  pools:
    claude: [claude-code/claude-opus-4-8, claude-code/claude-sonnet-5]
    gpt: [openai/gpt-5.5, openai/gpt-5-mini]
  roles:
    planner: [claude, gpt]      # listas ORDENADAS de nomes de pool candidatos
    executor: [claude, gpt]
    completer: [claude]
    reviewer: [gpt]             # aceito e preservado, mas SÓ consumido a partir de S04
  constraints:
    reviewer_not_author: family # aceito e preservado; filtro runtime é S04 (não S03)
    on_missing_pool: degrade+warn   # ou "block"
`;

function withScratchDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-models-config-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("parseModelsConfig", () => {
  test("parses the full locked shape from a fenced yaml block", () => {
    const raw = ["```yaml", FULL_SHAPE.trim(), "```"].join("\n");
    const config = parseModelsConfig(raw);

    assert.deepEqual(config.pools.claude, [
      "claude-code/claude-opus-4-8",
      "claude-code/claude-sonnet-5",
    ]);
    assert.deepEqual(config.pools.gpt, ["openai/gpt-5.5", "openai/gpt-5-mini"]);
    assert.deepEqual(config.roles.planner, ["claude", "gpt"]);
    assert.deepEqual(config.roles.executor, ["claude", "gpt"]);
    assert.deepEqual(config.roles.completer, ["claude"]);
    assert.equal(config.constraints.on_missing_pool, "degrade+warn");
  });

  test("parses without a fence too (whole body treated as the block)", () => {
    const config = parseModelsConfig(FULL_SHAPE);
    assert.deepEqual(config.pools.claude, [
      "claude-code/claude-opus-4-8",
      "claude-code/claude-sonnet-5",
    ]);
  });

  test("reviewer role and reviewer_not_author constraint survive parsing verbatim (forward-compat S04)", () => {
    const config = parseModelsConfig(FULL_SHAPE);
    assert.deepEqual(config.roles.reviewer, ["gpt"]);
    assert.equal(config.constraints.reviewer_not_author, "family");
  });

  test("accepts dash-list pools/roles in addition to inline lists", () => {
    const raw = `
models:
  pools:
    claude:
      - claude-code/claude-opus-4-8
      - claude-code/claude-sonnet-5
  roles:
    planner:
      - claude
`;
    const config = parseModelsConfig(raw);
    assert.deepEqual(config.pools.claude, [
      "claude-code/claude-opus-4-8",
      "claude-code/claude-sonnet-5",
    ]);
    assert.deepEqual(config.roles.planner, ["claude"]);
  });

  test("malformed yaml degrades to an empty config, never throws", () => {
    const raw = "models:\n  pools:\n    : [\n  roles roles roles\n\tconstraints ???\n";
    assert.doesNotThrow(() => parseModelsConfig(raw));
    const config = parseModelsConfig(raw);
    assert.deepEqual(config, { pools: {}, roles: {}, constraints: {} });
  });

  test("empty string degrades to an empty config", () => {
    const config = parseModelsConfig("");
    assert.deepEqual(config, { pools: {}, roles: {}, constraints: {} });
  });

  test("S01/R1: an explicit empty list (`name: []`) is preserved as `[]`, not dropped", () => {
    const raw = `
models:
  roles:
    researcher: []
`;
    const config = parseModelsConfig(raw);
    assert.ok("researcher" in config.roles, "researcher key must be present, not absent");
    assert.deepEqual(config.roles.researcher, []);
  });

  test("S01/R1: a `name:` key with no dash-lines under it is preserved as `[]`, not dropped", () => {
    const raw = `
models:
  pools:
    claude: [claude-code/claude-opus-4-8]
  roles:
    researcher:
    executor: [claude]
`;
    const config = parseModelsConfig(raw);
    assert.ok("researcher" in config.roles, "researcher key must be present, not absent");
    assert.deepEqual(config.roles.researcher, []);
    assert.deepEqual(config.roles.executor, ["claude"]);
  });

  test("lines outside the closed shape are ignored, tolerant like parsePrefsBlock", () => {
    const raw = `
some_unrelated_key: value
models:
  pools:
    claude: [claude-code/claude-opus-4-8]
  extra_junk_section:
    whatever: true
  roles:
    planner: [claude]
`;
    const config = parseModelsConfig(raw);
    assert.deepEqual(config.pools.claude, ["claude-code/claude-opus-4-8"]);
    assert.deepEqual(config.roles.planner, ["claude"]);
  });
});

describe("modelsConfigSources", () => {
  test("returns the 2 project-scope layers, repo then local", () => {
    withScratchDir((dir) => {
      const sources = modelsConfigSources(dir);
      assert.equal(sources.length, 2);
      assert.equal(sources[0].label, "repo");
      assert.equal(sources[0].path, join(dir, ".gsd", "models.md"));
      assert.equal(sources[1].label, "local");
      assert.equal(sources[1].path, join(dir, ".gsd", "models.local.md"));
    });
  });
});

describe("readModelsConfig", () => {
  test("missing files degrade to an empty config, never throws", () => {
    withScratchDir((dir) => {
      assert.doesNotThrow(() => readModelsConfig(dir));
      const config = readModelsConfig(dir);
      assert.deepEqual(config, { pools: {}, roles: {}, constraints: {} });
    });
  });

  test("reads .gsd/models.md when only the repo layer exists", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "models.md"),
        ["```yaml", "models:", "  pools:", "    claude: [claude-code/claude-opus-4-8]", "```"].join(
          "\n",
        ),
      );
      const config = readModelsConfig(dir);
      assert.deepEqual(config.pools.claude, ["claude-code/claude-opus-4-8"]);
    });
  });

  test("models.local.md wins over models.md (last-wins, shallow per key)", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "models.md"),
        [
          "```yaml",
          "models:",
          "  pools:",
          "    claude: [claude-code/claude-opus-4-8]",
          "    gpt: [openai/gpt-5-mini]",
          "```",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, ".gsd", "models.local.md"),
        ["```yaml", "models:", "  pools:", "    claude: [claude-code/claude-sonnet-5]", "```"].join(
          "\n",
        ),
      );
      const config = readModelsConfig(dir);
      // local overwrites the `claude` key...
      assert.deepEqual(config.pools.claude, ["claude-code/claude-sonnet-5"]);
      // ...but leaves `gpt` (only set by the repo layer) untouched.
      assert.deepEqual(config.pools.gpt, ["openai/gpt-5-mini"]);
    });
  });

  test("an unreadable layer (directory in place of a file) degrades without throwing", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd", "models.md"), { recursive: true });
      assert.doesNotThrow(() => readModelsConfig(dir));
    });
  });

  test("reviewer role and reviewer_not_author constraint survive the full cascade read", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "models.md"), ["```yaml", FULL_SHAPE.trim(), "```"].join("\n"));
      const config = readModelsConfig(dir);
      assert.deepEqual(config.roles.reviewer, ["gpt"]);
      assert.equal(config.constraints.reviewer_not_author, "family");
    });
  });
});

describe("parseModelsConfig — named diagnostic WARNs (S06/T01, additive, never throw)", () => {
  test("happy path (FULL_SHAPE) emits zero warnings", () => {
    const raw = ["```yaml", FULL_SHAPE.trim(), "```"].join("\n");
    const warnings = captureWarnings(() => {
      parseModelsConfig(raw);
    });
    assert.deepEqual(warnings, []);
  });

  test("duplicate pool key within the same block emits a named WARN, last-wins unchanged", () => {
    const raw = `
models:
  pools:
    claude: [claude-code/claude-opus-4-8]
    claude: [claude-code/claude-sonnet-5]
`;
    let config!: ModelsConfig;
    const warnings = captureWarnings(() => {
      config = parseModelsConfig(raw);
    });
    assert.ok(warnings.some((w) => w.includes('duplicate key "claude"') && w.includes("pools")));
    assert.deepEqual(config.pools.claude, ["claude-code/claude-sonnet-5"]);
  });

  test("duplicate role key within the same block emits a named WARN, last-wins unchanged", () => {
    const raw = `
models:
  pools:
    claude: [claude-code/claude-opus-4-8]
    gpt: [openai/gpt-5.5]
  roles:
    planner: [claude]
    planner: [gpt]
`;
    let config!: ModelsConfig;
    const warnings = captureWarnings(() => {
      config = parseModelsConfig(raw);
    });
    assert.ok(warnings.some((w) => w.includes('duplicate key "planner"') && w.includes("roles")));
    assert.deepEqual(config.roles.planner, ["gpt"]);
  });

  test("malformed pool refs emit named WARNs but remain in the config (diagnose, don't filter)", () => {
    const raw = `
models:
  pools:
    bad: [gpt-5, openai/, /gpt, a/b/c]
`;
    let config!: ModelsConfig;
    const warnings = captureWarnings(() => {
      config = parseModelsConfig(raw);
    });
    for (const ref of ["gpt-5", "openai/", "/gpt", "a/b/c"]) {
      assert.ok(
        warnings.some((w) => w.includes("malformed pool ref") && w.includes(`"${ref}"`)),
        `expected a malformed-ref WARN for "${ref}"`,
      );
    }
    assert.deepEqual(config.pools.bad, ["gpt-5", "openai/", "/gpt", "a/b/c"]);
  });

  test("well-formed refs (single non-empty prefix/suffix around one /) emit no malformed-ref WARN", () => {
    const raw = `
models:
  pools:
    ok: [claude-code/claude-opus-4-8, openai/gpt-5.5]
`;
    const warnings = captureWarnings(() => {
      parseModelsConfig(raw);
    });
    assert.deepEqual(warnings, []);
  });

  test("role referencing a pool that doesn't exist emits a named WARN, ref preserved verbatim", () => {
    const raw = `
models:
  pools:
    claude: [claude-code/claude-opus-4-8]
  roles:
    reviewer: [gpt]
`;
    let config!: ModelsConfig;
    const warnings = captureWarnings(() => {
      config = parseModelsConfig(raw);
    });
    assert.ok(warnings.some((w) => w.includes('role "reviewer"') && w.includes('undefined pool "gpt"')));
    assert.deepEqual(config.roles.reviewer, ["gpt"]);
  });

  test("case mismatch (GPT vs pool gpt) is diagnosed as pool-inexistent, NOT normalized", () => {
    const raw = `
models:
  pools:
    gpt: [openai/gpt-5.5]
  roles:
    planner: [GPT]
`;
    let config!: ModelsConfig;
    const warnings = captureWarnings(() => {
      config = parseModelsConfig(raw);
    });
    assert.ok(warnings.some((w) => w.includes('role "planner"') && w.includes('undefined pool "GPT"')));
    // case preserved on both sides — no collapse of GPT -> gpt anywhere in the config.
    assert.deepEqual(config.pools.gpt, ["openai/gpt-5.5"]);
    assert.deepEqual(config.roles.planner, ["GPT"]);
  });

  test("malformed yaml still degrades to an empty config and emits no warnings", () => {
    const raw = "models:\n  pools:\n    : [\n  roles roles roles\n\tconstraints ???\n";
    const warnings = captureWarnings(() => {
      const config = parseModelsConfig(raw);
      assert.deepEqual(config, { pools: {}, roles: {}, constraints: {} });
    });
    assert.deepEqual(warnings, []);
  });
});

describe("readModelsConfig — named diagnostic WARNs on the cascade (S06/T01)", () => {
  test("happy path cascade (single well-formed repo layer) emits zero warnings", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "models.md"), ["```yaml", FULL_SHAPE.trim(), "```"].join("\n"));
      const warnings = captureWarnings(() => {
        readModelsConfig(dir);
      });
      assert.deepEqual(warnings, []);
    });
  });

  test("Prettier multiline bracket shapes parse — format-on-save must never empty a pool (incident 2026-07-12)", () => {
    // Shape 1: `key:` with the bracket block on following lines (what
    // Prettier produces for a long flow sequence). Shape 2: `key: [` opening
    // on the same line, items spilling. Both silently parsed as [] before.
    const raw = [
      "```yaml",
      "models:",
      "  pools:",
      "    planners:",
      "      [",
      "        claude-code/claude-fable-5,",
      "        openai-codex/gpt-5.6-sol,",
      "      ]",
      "    executors: [claude-code/claude-sonnet-5,",
      "      openai-codex/gpt-5.6-terra]",
      "    reviewers: [openai-codex/gpt-5.6-terra]",
      "  roles:",
      "    planner: [planners]",
      "    executor: [executors]",
      "```",
    ].join("\n");
    const config = parseModelsConfig(raw);
    assert.deepEqual(config.pools.planners, ["claude-code/claude-fable-5", "openai-codex/gpt-5.6-sol"]);
    assert.deepEqual(config.pools.executors, ["claude-code/claude-sonnet-5", "openai-codex/gpt-5.6-terra"]);
    assert.deepEqual(config.pools.reviewers, ["openai-codex/gpt-5.6-terra"], "inline shape unchanged");
    assert.deepEqual(config.roles.planner, ["planners"]);
  });

  test("S05/R1: an unterminated multiline `key: [` stops at the sibling `roles:` header instead of swallowing it", () => {
    // A hand-edited models.md with a missing `]` used to have the openBracket
    // accumulation loop scan for the FIRST `]` anywhere in the file, crossing
    // the `roles:` section boundary and absorbing it into the `gpt` pool,
    // silently dropping role config. It must now stop at the dedent and warn.
    const raw = [
      "```yaml",
      "models:",
      "  pools:",
      "    gpt: [",
      "      openai/gpt-5.5,",
      "  roles:",
      "    planner: [gpt]",
      "```",
    ].join("\n");
    let config!: ModelsConfig;
    const warnings = captureWarnings(() => {
      config = parseModelsConfig(raw);
    });
    assert.deepEqual(config.roles.planner, ["gpt"], "sibling roles: section must survive, not be swallowed");
    assert.ok(
      warnings.some((w) => w.includes("unterminated")),
      "must warn about the unterminated list instead of silently mangling the pool",
    );
  });

  test("cross-layer override is the SANCTIONED cascade — silent merge, local layer wins", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "models.md"),
        ["```yaml", "models:", "  pools:", "    claude: [claude-code/claude-opus-4-8]", "```"].join("\n"),
      );
      writeFileSync(
        join(dir, ".gsd", "models.local.md"),
        ["```yaml", "models:", "  pools:", "    claude: [claude-code/claude-sonnet-5]", "```"].join("\n"),
      );
      let config!: ModelsConfig;
      const warnings = captureWarnings(() => {
        config = readModelsConfig(dir);
      });
      // Operator report 2026-07-12: this warn fired on EVERY config read for a
      // perfectly-configured cascade (models.local.md overriding a role) and
      // read as an error. Cross-layer last-wins is the mechanism, not a bug —
      // only intra-file duplicates warn (covered above).
      assert.equal(
        warnings.filter((w) => w.includes("duplicate key")).length,
        0,
        "sanctioned cascade override must not warn",
      );
      assert.deepEqual(config.pools.claude, ["claude-code/claude-sonnet-5"]);
    });
  });

  test("role and its pool split across layers do NOT false-positive (validation runs once, on the merge)", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "models.md"),
        ["```yaml", "models:", "  pools:", "    claude: [claude-code/claude-opus-4-8]", "```"].join("\n"),
      );
      writeFileSync(
        join(dir, ".gsd", "models.local.md"),
        ["```yaml", "models:", "  roles:", "    planner: [claude]", "```"].join("\n"),
      );
      let config!: ModelsConfig;
      const warnings = captureWarnings(() => {
        config = readModelsConfig(dir);
      });
      assert.deepEqual(warnings, []);
      assert.deepEqual(config.roles.planner, ["claude"]);
    });
  });

  test("S01/R1: models.local.md can clear a repo-level role pool with an explicit empty list", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "models.md"),
        [
          "```yaml",
          "models:",
          "  pools:",
          "    grok-pool: [xai/grok-4]",
          "  roles:",
          "    researcher: [grok-pool]",
          "```",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, ".gsd", "models.local.md"),
        ["```yaml", "models:", "  roles:", "    researcher: []", "```"].join("\n"),
      );
      const config = readModelsConfig(dir);
      assert.deepEqual(config.roles.researcher, [], "local layer's explicit [] must win over repo's pool list");
    });
  });

  test("role→pool validation runs on the merged cascade result and catches a genuinely undefined pool", () => {
    withScratchDir((dir) => {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "models.md"),
        ["```yaml", "models:", "  roles:", "    reviewer: [gpt]", "```"].join("\n"),
      );
      const warnings = captureWarnings(() => {
        readModelsConfig(dir);
      });
      assert.ok(warnings.some((w) => w.includes('role "reviewer"') && w.includes('undefined pool "gpt"')));
    });
  });
});
