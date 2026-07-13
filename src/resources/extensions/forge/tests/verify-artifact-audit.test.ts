import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verifyArtifact,
  checkExists,
  checkSubstantive,
  checkWired,
  walkImports,
  extractImports,
  resolveSpec,
  DEFAULT_STUB_REGEXES,
  IMPORT_PATTERNS,
  SUPPORTED_EXTENSIONS,
  JS_TS_EXTENSIONS,
} from "../verify/artifact-audit.ts";
import type { Artifact, MustHaves } from "../state/must-haves.ts";

// ── Fixture sandbox ───────────────────────────────────────────────────────────

const roots: string[] = [];

function mkRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-artifact-audit-"));
  roots.push(dir);
  return dir;
}

function writeFile(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

after(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    path: "src/foo.ts",
    provides: "foo",
    min_lines: 3,
    ...over,
  };
}

// ── Constants integrity ───────────────────────────────────────────────────────

describe("locked constants", () => {
  test("DEFAULT_STUB_REGEXES names + order are locked", () => {
    assert.deepEqual(
      DEFAULT_STUB_REGEXES.map((r) => r.name),
      [
        "empty_function_body",
        "return_null_function",
        "jsx_placeholder_onclick",
        "jsx_placeholder_return_div",
      ],
    );
  });

  test("IMPORT_PATTERNS names are locked and all /g", () => {
    assert.deepEqual(
      IMPORT_PATTERNS.map((p) => p.name),
      ["import_from", "require_call", "export_from", "export_star"],
    );
    for (const p of IMPORT_PATTERNS) assert.ok(p.regex.global);
  });

  test("extension sets", () => {
    assert.deepEqual(SUPPORTED_EXTENSIONS, [
      ".js",
      ".ts",
      ".tsx",
      ".jsx",
      ".mjs",
      ".cjs",
    ]);
    assert.ok(JS_TS_EXTENSIONS.has(".tsx"));
    assert.ok(!JS_TS_EXTENSIONS.has(".md"));
  });
});

// ── Level 1: Exists ───────────────────────────────────────────────────────────

describe("checkExists", () => {
  test("file_not_found for missing artifact (fail)", () => {
    const root = mkRoot();
    const r = checkExists("missing.ts", root);
    assert.equal(r.pass, false);
    assert.equal(r.flag?.reason, "file_not_found");
    assert.equal(r.flag?.level, "exists");
  });

  test("file_empty for single blank line (fail)", () => {
    const root = mkRoot();
    writeFile(root, "empty.ts", "   ");
    const r = checkExists("empty.ts", root);
    assert.equal(r.pass, false);
    assert.equal(r.flag?.reason, "file_empty");
  });

  test("pass with content and lineCount (pass)", () => {
    const root = mkRoot();
    writeFile(root, "ok.ts", "a\nb\nc");
    const r = checkExists("ok.ts", root);
    assert.equal(r.pass, true);
    assert.equal(r.lineCount, 3);
    assert.equal(r.content, "a\nb\nc");
  });
});

// ── Level 2: Substantive ──────────────────────────────────────────────────────

describe("checkSubstantive", () => {
  test("below_min_lines (fail) with actual/expected", () => {
    const r = checkSubstantive("a\nb", 2, artifact({ min_lines: 5 }));
    assert.equal(r.pass, false);
    assert.equal(r.flags?.[0].reason, "below_min_lines");
    assert.equal(r.flags?.[0].actual, 2);
    assert.equal(r.flags?.[0].expected, 5);
  });

  test("clean substantive file (pass)", () => {
    const content = "export function real(x: number) {\n  return x + 1;\n}\n";
    const r = checkSubstantive(content, 3, artifact());
    assert.equal(r.pass, true);
  });

  test("stub: empty_function_body (fail, named)", () => {
    const content = "line\nfunction stub() {}\nmore\nmore2";
    const r = checkSubstantive(content, 4, artifact({ min_lines: 1 }));
    assert.equal(r.pass, false);
    assert.equal(r.flags?.[0].regex_name, "empty_function_body");
    assert.equal(r.flags?.[0].line_number, 2);
  });

  test("stub: return_null_function (fail, named)", () => {
    const content = "a\n  return null;\nb";
    const r = checkSubstantive(content, 3, artifact({ min_lines: 1 }));
    assert.equal(r.pass, false);
    assert.equal(r.flags?.[0].regex_name, "return_null_function");
  });

  test("stub: jsx_placeholder_onclick (fail, named)", () => {
    const content = "a\n<button onClick={() => {}} />\nb";
    const r = checkSubstantive(content, 3, artifact({ min_lines: 1 }));
    assert.equal(r.pass, false);
    assert.equal(r.flags?.[0].regex_name, "jsx_placeholder_onclick");
  });

  test("stub: jsx_placeholder_return_div (fail, named)", () => {
    const content = "a\n  return <div />;\nb";
    const r = checkSubstantive(content, 3, artifact({ min_lines: 1 }));
    assert.equal(r.pass, false);
    assert.equal(r.flags?.[0].regex_name, "jsx_placeholder_return_div");
  });

  test("stub_patterns:[] disables detection (pass)", () => {
    const content = "a\n  return null;\nb";
    const r = checkSubstantive(
      content,
      3,
      artifact({ min_lines: 1, stub_patterns: [] }),
    );
    assert.equal(r.pass, true);
  });

  test("invalid-regex stub pattern falls back to LITERAL match — never aborts the gate (live 2026-07-12: 'todo(')", () => {
    const content = "a\n// todo( implementar depois\nb";
    const r = checkSubstantive(
      content,
      3,
      artifact({ min_lines: 1, stub_patterns: ["todo("] }),
    );
    assert.equal(r.pass, false, "the literal fallback still flags the stub line");
    assert.equal(r.flags?.[0].regex_name, "custom_stub_0_literal");
  });

  test("stub_patterns: string[] appends to defaults (fail on custom + default)", () => {
    const content = "a\nBANNED_TOKEN here\nb";
    const r = checkSubstantive(
      content,
      3,
      artifact({ min_lines: 1, stub_patterns: ["BANNED_TOKEN"] }),
    );
    assert.equal(r.pass, false);
    assert.equal(r.flags?.[0].regex_name, "custom_stub_0");
    // defaults still active alongside the custom extra
    const content2 = "a\n  return null;\nb";
    const r2 = checkSubstantive(
      content2,
      3,
      artifact({ min_lines: 1, stub_patterns: ["BANNED_TOKEN"] }),
    );
    assert.equal(r2.pass, false);
    assert.equal(r2.flags?.[0].regex_name, "return_null_function");
  });

  test("precedence: empty_function_body wins over return_null on a line", () => {
    // a line that could match multiple — first-match-per-line semantics
    const content = "x\nconst f = () => {}\ny";
    const r = checkSubstantive(content, 3, artifact({ min_lines: 1 }));
    assert.equal(r.flags?.[0].regex_name, "empty_function_body");
  });
});

// ── Import walker helpers ─────────────────────────────────────────────────────

describe("extractImports / resolveSpec", () => {
  test("extractImports finds all four pattern kinds with line numbers", () => {
    const content = [
      "import { a } from './a.js';",
      "const b = require('./b.js');",
      "export { c } from './c.js';",
      "export * from './d.js';",
    ].join("\n");
    const imps = extractImports(content);
    const names = new Set(imps.map((i) => i.pattern_name));
    // Faithful 1.0 union semantics: all patterns run; `export *` also matches
    // export_from, so both fire on the barrel line.
    assert.ok(names.has("import_from"));
    assert.ok(names.has("require_call"));
    assert.ok(names.has("export_from"));
    assert.ok(names.has("export_star"));
    const importFrom = imps.find((i) => i.pattern_name === "import_from");
    assert.equal(importFrom?.line_number, 1);
    assert.equal(importFrom?.spec, "./a.js");
  });

  test("resolveSpec returns null for bare specs", () => {
    const root = mkRoot();
    const importer = writeFile(root, "x.ts", "");
    assert.equal(resolveSpec(importer, "node:fs"), null);
    assert.equal(resolveSpec(importer, "some-pkg"), null);
  });

  test("resolveSpec resolves relative spec to existing file", () => {
    const root = mkRoot();
    const importer = writeFile(root, "dir/x.ts", "");
    const target = writeFile(root, "dir/y.ts", "export const y = 1;");
    // Extensionless spec resolves via base + SUPPORTED_EXTENSIONS (faithful 1.0).
    const resolved = resolveSpec(importer, "./y");
    assert.equal(resolved, target);
    // A `.js` spec pointing at a `.ts` file does NOT resolve (heuristic parity).
    assert.equal(resolveSpec(importer, "./y.js"), null);
  });
});

// ── Level 3: Wired (walkImports four outcomes) ────────────────────────────────

describe("checkWired / walkImports", () => {
  test("skipped for non-JS/TS artifact", () => {
    const root = mkRoot();
    const r = checkWired(artifact({ path: "doc.md" }), true, [], root);
    assert.equal(r.wired, "skipped");
    assert.equal(r.flag?.reason, "non_js_ts_repo");
  });

  test("found → wired true (depth 1)", () => {
    const root = mkRoot();
    const target = writeFile(root, "target.ts", "export const t = 1;");
    const peer = writeFile(root, "peer.ts", "import { t } from './target';");
    const r = walkImports(target, [peer], { cwd: root, depth: 2 });
    assert.equal(r.found, true);
    assert.equal(r.depth_reached, 1);

    const cw = checkWired(
      artifact({ path: "target.ts" }),
      false,
      [peer],
      root,
    );
    assert.equal(cw.wired, true);
  });

  test("no references → wired false", () => {
    const root = mkRoot();
    const target = writeFile(root, "target.ts", "export const t = 1;");
    const peer = writeFile(root, "peer.ts", "import fs from 'node:fs';");
    const r = walkImports(target, [peer], { cwd: root, depth: 2 });
    assert.equal(r.found, false);
    assert.equal(r.approximate, false);
    assert.equal(r.reason, "no_references_found");

    const cw = checkWired(artifact({ path: "target.ts" }), false, [peer], root);
    assert.equal(cw.wired, false);
    assert.equal(cw.flag?.reason, "no_references_found");
  });

  test("depth limit → approximate", () => {
    const root = mkRoot();
    const target = writeFile(root, "target.ts", "export const t = 1;");
    // peer -> mid (hop1 -> hop2), mid does NOT import target; target sits at hop3
    const mid = writeFile(root, "mid.ts", "export const m = 1;");
    const peer = writeFile(root, "peer.ts", "import { m } from './mid';");
    const r = walkImports(target, [peer], { cwd: root, depth: 2 });
    assert.equal(r.found, false);
    assert.equal(r.approximate, true);
    assert.equal(r.reason, "depth_limit");

    const cw = checkWired(artifact({ path: "target.ts" }), false, [peer], root);
    assert.equal(cw.wired, "approximate");
    assert.equal(cw.flag?.reason, "depth_limit");
    // silence unused
    void mid;
  });
});

// ── verifyArtifact orchestration + short-circuit ─────────────────────────────

describe("verifyArtifact", () => {
  test("legacy for null must-haves", () => {
    const r = verifyArtifact(null, [], { cwd: process.cwd() });
    assert.equal(r.legacy, true);
    assert.equal(r.rows[0].flags[0].reason, "legacy_schema");
  });

  test("short-circuit: exists fail → substantive & wired null", () => {
    const root = mkRoot();
    const mh: MustHaves = {
      truths: [],
      artifacts: [artifact({ path: "gone.ts" })],
      key_links: [],
      expected_output: [],
    };
    const r = verifyArtifact(mh, [], { cwd: root });
    assert.equal(r.rows[0].exists, false);
    assert.equal(r.rows[0].substantive, null);
    assert.equal(r.rows[0].wired, null);
  });

  test("short-circuit: substantive fail → wired null", () => {
    const root = mkRoot();
    writeFile(root, "small.ts", "a\nb");
    const mh: MustHaves = {
      truths: [],
      artifacts: [artifact({ path: "small.ts", min_lines: 50 })],
      key_links: [],
      expected_output: [],
    };
    const r = verifyArtifact(mh, [], { cwd: root });
    assert.equal(r.rows[0].exists, true);
    assert.equal(r.rows[0].substantive, false);
    assert.equal(r.rows[0].wired, null);
  });

  test("full pass: exists+substantive+wired true", () => {
    const root = mkRoot();
    writeFile(
      root,
      "mod.ts",
      "export function real(n: number) {\n  return n * 2;\n}\n",
    );
    writeFile(root, "consumer.ts", "import { real } from './mod';");
    const mh: MustHaves = {
      truths: [],
      artifacts: [artifact({ path: "mod.ts", min_lines: 1 })],
      key_links: [],
      expected_output: [],
    };
    const r = verifyArtifact(mh, ["consumer.ts"], { cwd: root });
    assert.equal(r.rows[0].exists, true);
    assert.equal(r.rows[0].substantive, true);
    assert.equal(r.rows[0].wired, true);
    assert.equal(r.rows[0].test_quality, undefined);
  });

  test("Level 4 injection point runs only when supplied + isTestFile true", () => {
    const root = mkRoot();
    writeFile(root, "a.test.ts", "export const t = 1;\nconst x = 2;\n");
    const mh: MustHaves = {
      truths: [],
      artifacts: [artifact({ path: "a.test.ts", min_lines: 1 })],
      key_links: [],
      expected_output: [],
    };
    let called = false;
    const r = verifyArtifact(mh, [], {
      cwd: root,
      isTestFile: (p) => p.endsWith(".test.ts"),
      auditTestQuality: () => {
        called = true;
        return { pass: true, flags: [] };
      },
    });
    assert.equal(called, true);
    assert.equal(r.rows[0].test_quality, true);
  });
});
