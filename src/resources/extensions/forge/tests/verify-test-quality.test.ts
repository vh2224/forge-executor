import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  isTestFile,
  detectPatternSets,
  auditTestQuality,
  TEST_QUALITY_REGEXES,
} from "../verify/test-quality.ts";
import type { Artifact } from "../state/must-haves.ts";

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    path: "src/foo.test.ts",
    provides: "foo test",
    min_lines: 3,
    ...over,
  };
}

// ── isTestFile ───────────────────────────────────────────────────────────────

describe("isTestFile", () => {
  test("matches *.test.ts / *.test.js / *.test.tsx", () => {
    assert.equal(isTestFile("src/foo.test.ts"), true);
    assert.equal(isTestFile("src/foo.test.js"), true);
    assert.equal(isTestFile("src/foo.test.tsx"), true);
    assert.equal(isTestFile("src/foo.test.mjs"), true);
  });

  test("matches *.spec.ts", () => {
    assert.equal(isTestFile("src/foo.spec.ts"), true);
  });

  test("matches paths inside __tests__/", () => {
    assert.equal(isTestFile("src/__tests__/foo.ts"), true);
    assert.equal(isTestFile("src\\__tests__\\foo.ts"), true);
  });

  test("returns false for non-test paths", () => {
    assert.equal(isTestFile("src/foo.ts"), false);
    assert.equal(isTestFile("src/footest.ts"), false);
    assert.equal(isTestFile("src/tests-helper.ts"), false);
  });
});

// ── detectPatternSets ─────────────────────────────────────────────────────────

describe("detectPatternSets", () => {
  test("recognises node:test runner import as node set (D-S06-3)", () => {
    // NB: node:test's own `test(...)` call shape is textually indistinguishable
    // from a bare jest/mocha `test(...)` call, so a file that imports node:test
    // AND calls test(...) legitimately triggers both signals — this mirrors the
    // 1.0 heuristic (ambiguity is resolved by running both sets, never under-run).
    const content = `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("x", () => { assert.equal(1, 1); });\n`;
    assert.deepEqual(detectPatternSets(content), ["both", "jest", "node"]);
  });

  test("node:test import alone (no test()/it()/describe() call) is node-only", () => {
    const content = `import { test as nodeTest } from "node:test";\nimport assert from "node:assert/strict";\nnodeTest("x", () => { assert.equal(1, 1); });\n`;
    assert.deepEqual(detectPatternSets(content), ["both", "node"]);
  });

  test("recognises legacy require('assert') as node set", () => {
    const content = `const assert = require('assert');\nassert.equal(1, 1);\n`;
    assert.deepEqual(detectPatternSets(content), ["both", "node"]);
  });

  test("recognises jest expect/it/describe as jest set", () => {
    const content = `describe("x", () => { it("y", () => { expect(1).toBe(1); }); });\n`;
    assert.deepEqual(detectPatternSets(content), ["both", "jest"]);
  });

  test("runs both sets when signals for both present", () => {
    const content = `import { test } from "node:test";\ndescribe("x", () => { expect(1).toBe(1); });\n`;
    assert.deepEqual(detectPatternSets(content), ["both", "jest", "node"]);
  });

  test("ambiguous content (no clear signal) runs all sets", () => {
    const content = `const x = 1;\n`;
    assert.deepEqual(detectPatternSets(content), ["both", "jest", "node"]);
  });
});

// ── auditTestQuality — reasons ────────────────────────────────────────────────

describe("auditTestQuality", () => {
  test("node:test file with assert.equal is pass:true (no no-assertion)", () => {
    const content = [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      '',
      'test("adds numbers", () => {',
      '  assert.equal(1 + 1, 2);',
      '});',
      '',
    ].join("\n");
    const result = auditTestQuality(content, artifact());
    assert.equal(result.pass, true);
    assert.deepEqual(result.flags, []);
  });

  test("file with zero assertions produces no-assertion", () => {
    const content = [
      'import { test } from "node:test";',
      '',
      'test("does nothing useful", () => {',
      '  const x = 1;',
      '});',
      '',
    ].join("\n");
    const result = auditTestQuality(content, artifact());
    assert.equal(result.pass, false);
    assert.equal(result.flags.length, 1);
    assert.equal(result.flags[0].reason, "no-assertion");
    assert.equal(result.flags[0].level, "test-quality");
    assert.equal(result.flags[0].path, "src/foo.test.ts");
  });

  test("test.skip produces disabled-test", () => {
    const content = [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      '',
      'test.skip("skipped case", () => {',
      '  assert.equal(1, 1);',
      '});',
      '',
    ].join("\n");
    const result = auditTestQuality(content, artifact());
    assert.equal(result.pass, false);
    const reasons = result.flags.map((f) => f.reason);
    assert.ok(reasons.includes("disabled-test"));
    const flag = result.flags.find((f) => f.reason === "disabled-test");
    assert.equal(flag?.regex_name, "disabled_test_skip_todo");
    assert.equal(flag?.line_number, 4);
  });

  test("it.skip / xit / describe.skip all produce disabled-test", () => {
    for (const line of [
      'it.skip("x", () => { assert.equal(1, 1); });',
      'xit("x", () => { assert.equal(1, 1); });',
      'describe.skip("x", () => { assert.equal(1, 1); });',
    ]) {
      const content = `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${line}\n`;
      const result = auditTestQuality(content, artifact());
      assert.equal(result.pass, false);
      assert.ok(result.flags.some((f) => f.reason === "disabled-test"));
    }
  });

  test("assert(true) circular-free weak-assertion produces weak-assertion (node set)", () => {
    const content = [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      '',
      'test("weak", () => {',
      '  assert(true);',
      '});',
      '',
    ].join("\n");
    const result = auditTestQuality(content, artifact());
    assert.equal(result.pass, false);
    const flag = result.flags.find((f) => f.reason === "weak-assertion");
    assert.ok(flag);
    assert.equal(flag?.regex_name, "weak_assertion_node_assert_true");
  });

  test("expect(true).toBe(true) produces weak-assertion (jest set)", () => {
    const content = [
      'describe("x", () => {',
      '  it("weak", () => {',
      '    expect(true).toBe(true);',
      '  });',
      '});',
      '',
    ].join("\n");
    const result = auditTestQuality(content, artifact());
    assert.equal(result.pass, false);
    const flag = result.flags.find((f) => f.reason === "weak-assertion");
    assert.ok(flag);
    assert.equal(flag?.regex_name, "weak_assertion_jest_literal");
  });

  test("assert(x, x) / assert.strictEqual(x, x) produces circular-assertion (node set)", () => {
    const content = [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      '',
      'test("circular", () => {',
      '  const x = 1;',
      '  assert.strictEqual(x, x);',
      '});',
      '',
    ].join("\n");
    const result = auditTestQuality(content, artifact());
    assert.equal(result.pass, false);
    const flag = result.flags.find((f) => f.reason === "circular-assertion");
    assert.ok(flag);
    assert.equal(flag?.regex_name, "circular_assertion_node_strictequal");
  });

  test("assert(x === x) produces circular-assertion (identity, node set)", () => {
    const content = [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      '',
      'test("circular identity", () => {',
      '  const x = 1;',
      '  assert(x === x);',
      '});',
      '',
    ].join("\n");
    const result = auditTestQuality(content, artifact());
    assert.equal(result.pass, false);
    const flag = result.flags.find((f) => f.reason === "circular-assertion");
    assert.ok(flag);
    assert.equal(flag?.regex_name, "circular_assertion_node_identity");
  });

  test("expect(x).toBe(x) produces circular-assertion (jest set)", () => {
    const content = [
      'describe("x", () => {',
      '  it("circular", () => {',
      '    const x = 1;',
      '    expect(x).toBe(x);',
      '  });',
      '});',
      '',
    ].join("\n");
    const result = auditTestQuality(content, artifact());
    assert.equal(result.pass, false);
    const flag = result.flags.find((f) => f.reason === "circular-assertion");
    assert.ok(flag);
    assert.equal(flag?.regex_name, "circular_assertion_jest");
  });

  test("node set does not evaluate jest-only regexes when set is dominated by node", () => {
    // node:test import aliased away from the literal `test(` call shape so only
    // the node signal fires — verify node-only files stay clean when there is
    // no weak/circular node pattern (jest regexes never evaluated).
    const content = [
      'import { test as nodeTest } from "node:test";',
      'import assert from "node:assert/strict";',
      '',
      'nodeTest("clean", () => {',
      '  assert.equal(2 + 2, 4);',
      '});',
      '',
    ].join("\n");
    assert.deepEqual(detectPatternSets(content), ["both", "node"]);
    const result = auditTestQuality(content, artifact());
    assert.equal(result.pass, true);
  });

  test("TEST_QUALITY_REGEXES precedence order: disabled-test before weak/circular", () => {
    const names = TEST_QUALITY_REGEXES.map((r) => r.name);
    const disabledIdx = names.findIndex((n) => n.startsWith("disabled_test"));
    const weakIdx = names.findIndex((n) => n.startsWith("weak_assertion"));
    const circularIdx = names.findIndex((n) => n.startsWith("circular_assertion"));
    assert.ok(disabledIdx < weakIdx);
    assert.ok(weakIdx < circularIdx);
  });

  test("audit-error path never throws (advisory, pass:true) on catastrophic input tolerated", () => {
    // auditTestQuality is defensive; a normal string never throws, so this
    // documents the contract: pass must always be a boolean, flags an array.
    const result = auditTestQuality("assert.equal(1,1);", artifact());
    assert.equal(typeof result.pass, "boolean");
    assert.ok(Array.isArray(result.flags));
  });
});
