/**
 * Forge test-quality — level-4 test-quality audit (disabled / weak / circular /
 * no-assertion), TS estrito ESM port of `forge-agent/scripts/forge-verifier.js:519-748`.
 *
 * Applies ONLY to test files declared in must_haves.artifacts/expected_output.
 * Non-test artifacts are never audited (decision locked #4, D-S06-3).
 *
 * Exports:
 *   isTestFile(artifactPath) → boolean — true for *.test.* / *.spec.* / __tests__/
 *   TEST_QUALITY_REGEXES — ordered registry { name, regex, description, pattern_set }
 *     pattern_set: 'jest' | 'node' | 'both'
 *     Precedence order: disabled-test → weak-assertion → circular-assertion
 *   detectPatternSets(content) → string[] — dominant pattern set(s) to run
 *     Adapted for this repo's `node:test` runner (D-S06-3): recognises
 *     `import ... from "node:test"` / `from "node:assert"` in addition to the
 *     1.0 `require('assert')`/`process.exit` node-set signals.
 *   auditTestQuality(content, artifact) → { pass, flags } — level-4 audit
 *
 * PURE module: no I/O, no `@gsd/*` runtime import, no import from the condemned
 * `gsd/` tree. Only builtin string/regex operations.
 *
 * MEM004: line-scoped regexes use [ \t] not \s; `\Z` does not exist in JS.
 */

import type { Artifact } from "../state/must-haves.js";

// ── Result shapes ───────────────────────────────────────────────────────────

export interface TestQualityFlag {
  level: "test-quality";
  reason: string;
  regex_name?: string;
  line_number?: number;
  matched_text?: string;
  path: string;
  error?: string;
}

export interface TestQualityResult {
  pass: boolean;
  flags: TestQualityFlag[];
}

// ── isTestFile ───────────────────────────────────────────────────────────────

/**
 * Returns true when the given artifact path is a test file.
 * Matches *.test.<ext>, *.spec.<ext>, or anything inside __tests__/.
 */
export function isTestFile(artifactPath: string): boolean {
  const normalised = artifactPath.replace(/\\/g, "/");
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalised) ||
    normalised.includes("/__tests__/")
  );
}

// ── TEST_QUALITY_REGEXES ─────────────────────────────────────────────────────

export interface TestQualityRegex {
  name: string;
  regex: RegExp;
  description: string;
  pattern_set: "jest" | "node" | "both";
}

/**
 * Registry of test-quality patterns.
 * Evaluated in precedence order: disabled-test → weak-assertion → circular-assertion.
 * Each regex is applied line-by-line (line-scoped).
 */
export const TEST_QUALITY_REGEXES: readonly TestQualityRegex[] = [
  // ── disabled-test (both) ──────────────────────────────────────────────────
  {
    name: "disabled_test_skip_todo",
    // Matches it.skip, test.skip, describe.skip, it.todo, test.todo, describe.todo
    regex: /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/,
    description: "Test skipped or marked todo via .skip/.todo",
    pattern_set: "both",
  },
  {
    name: "disabled_test_xit_xdescribe",
    // Matches xit( and xdescribe( (legacy mocha/jest xunit-style skips)
    regex: /\b(?:xit|xdescribe)\s*\(/,
    description: "Test skipped via xit() or xdescribe()",
    pattern_set: "both",
  },
  // ── weak-assertion (jest) ─────────────────────────────────────────────────
  {
    name: "weak_assertion_jest_literal",
    // Matches expect(true|false|1|0).toBe(true|false|1|0) — literal tautologies
    regex:
      /expect\([ \t]*(?:true|false|1|0)[ \t]*\)\.(?:toBe|toEqual)\([ \t]*(?:true|false|1|0)[ \t]*\)/,
    description:
      "expect(literal).toBe(literal) — assertion always passes; no real coverage",
    pattern_set: "jest",
  },
  // ── weak-assertion (node) ─────────────────────────────────────────────────
  {
    name: "weak_assertion_node_assert_true",
    // Matches assert(true) or assert(1) — trivially true assertions
    regex: /\bassert\([ \t]*(?:true|1)[ \t]*\)/,
    description:
      "assert(true) or assert(1) — assertion always passes; no real coverage",
    pattern_set: "node",
  },
  {
    name: "weak_assertion_node_assert_ok_true",
    // Matches assert.ok(true)
    regex: /\bassert\.ok\([ \t]*true[ \t]*\)/,
    description: "assert.ok(true) — assertion always passes; no real coverage",
    pattern_set: "node",
  },
  // ── circular-assertion (jest) ─────────────────────────────────────────────
  {
    name: "circular_assertion_jest",
    // Matches expect(varName).toBe(varName) or .toEqual(varName) — same variable both sides
    regex:
      /expect\([ \t]*([A-Za-z_$][\w$]*)[ \t]*\)\.(?:toBe|toEqual)\([ \t]*\1[ \t]*\)/,
    description:
      "expect(x).toBe(x) — circular assertion; variable compared against itself",
    pattern_set: "jest",
  },
  // ── circular-assertion (node) ─────────────────────────────────────────────
  {
    name: "circular_assertion_node_strictequal",
    // Matches assert.strictEqual(x, x) or assert(x, x)
    regex: /\bassert(?:\.strictEqual)?\([ \t]*([A-Za-z_$][\w$]*)[ \t]*,[ \t]*\1[ \t]*\)/,
    description: "assert(x, x) or assert.strictEqual(x, x) — circular assertion",
    pattern_set: "node",
  },
  {
    name: "circular_assertion_node_identity",
    // Matches assert(x === x) — identity tautology in assert condition
    regex: /\bassert\([ \t]*([A-Za-z_$][\w$]*)[ \t]*===[ \t]*\1[ \t]*\)/,
    description: "assert(x === x) — circular identity assertion",
    pattern_set: "node",
  },
];

// ── detectPatternSets ─────────────────────────────────────────────────────────

/**
 * Detect the dominant pattern set(s) from file content.
 *
 * D-S06-3 adaptation for this repo's `node:test` runner: the `node` signal is
 * detected from `import ... from "node:test"` / `from "node:assert"` (this
 * repo's convention) IN ADDITION to the 1.0 `require('assert')`/`process.exit`
 * signals — not a replacement, a superset.
 *
 * Returns an array always starting with 'both'; 'jest'/'node' appended when
 * their signal is present. Ambiguous (no clear signal) → run all sets.
 */
export function detectPatternSets(content: string): string[] {
  const hasNode =
    /require\s*\(\s*['"]assert['"]\s*\)/.test(content) ||
    /process\.exit\s*\(/.test(content) ||
    /from\s+['"]node:test['"]/.test(content) ||
    /from\s+['"]node:assert(?:\/strict)?['"]/.test(content) ||
    /require\s*\(\s*['"]node:assert['"]\s*\)/.test(content);
  const hasJest =
    /\bexpect\s*\(/.test(content) || /\b(?:it|test|describe)\s*\(/.test(content);

  if (hasNode && hasJest) return ["both", "jest", "node"];
  if (hasNode) return ["both", "node"];
  if (hasJest) return ["both", "jest"];
  // Ambiguous (no clear signal) — run all
  return ["both", "jest", "node"];
}

// ── auditTestQuality ─────────────────────────────────────────────────────────

/**
 * Level-4 audit: test-quality analysis.
 *
 * Applies to test files only. Detects:
 *   - no-assertion:       file has zero expect()/assert() calls
 *   - disabled-test:      it.skip / xit / it.todo / describe.skip
 *   - weak-assertion:     expect(true).toBe(true) / assert(true)
 *   - circular-assertion: expect(x).toBe(x) / assert(x, x)
 *
 * Short-circuit: first matching regex per line wins (same as checkSubstantive).
 * Advisory — never throws; audit errors are reported as a safe flag with pass:true.
 */
export function auditTestQuality(
  content: string,
  artifact: Artifact,
): TestQualityResult {
  try {
    const artifactPath = artifact && artifact.path ? artifact.path : "<unknown>";
    const flags: TestQualityFlag[] = [];

    // ── No-assertion check (whole-file, runs before line scan) ───────────────
    const hasAnyAssertion =
      /\bexpect\s*\(/.test(content) || /\bassert\s*[.(]/.test(content);
    if (!hasAnyAssertion) {
      return {
        pass: false,
        flags: [
          { level: "test-quality", reason: "no-assertion", path: artifactPath },
        ],
      };
    }

    // ── Detect active pattern sets ────────────────────────────────────────────
    const activeSets = detectPatternSets(content);
    const activeRegexes = TEST_QUALITY_REGEXES.filter((r) =>
      activeSets.includes(r.pattern_set),
    );

    // ── Line-by-line scan — first match per line wins ─────────────────────────
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { name, regex } of activeRegexes) {
        // Reset stateful regexes (none here use /g, but defensive)
        regex.lastIndex = 0;
        if (regex.test(line)) {
          // Map regex name to canonical reason
          let reason: string;
          if (name.startsWith("disabled_test")) {
            reason = "disabled-test";
          } else if (name.startsWith("weak_assertion")) {
            reason = "weak-assertion";
          } else if (name.startsWith("circular_assertion")) {
            reason = "circular-assertion";
          } else {
            reason = name;
          }
          flags.push({
            level: "test-quality",
            reason,
            regex_name: name,
            line_number: i + 1,
            matched_text: line.trim(),
            path: artifactPath,
          });
          break; // first match wins for this line
        }
      }
    }

    return { pass: flags.length === 0, flags };
  } catch (err) {
    // Advisory — never throws; returns a safe audit-error flag
    const artifactPath = artifact && artifact.path ? artifact.path : "<unknown>";
    return {
      pass: true,
      flags: [
        {
          level: "test-quality",
          reason: "audit-error",
          error: err instanceof Error ? err.message : String(err),
          path: artifactPath,
        },
      ],
    };
  }
}
