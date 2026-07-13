import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasStructuredMustHaves, parseMustHaves } from "../state/must-haves.ts";

// Helper: build a minimal valid plan frontmatter string + body
function mkPlan(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n# Task\n`;
}

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-must-haves-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("hasStructuredMustHaves", () => {
  test("legacy plan (no must_haves) → false", () => {
    const plan = `---\nid: T01\ndescription: "old plan"\n---\n# Task\n`;
    assert.equal(hasStructuredMustHaves(plan), false);
  });

  test("structured plan (must_haves at column 0) → true", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
    assert.equal(hasStructuredMustHaves(plan), true);
  });

  test("no frontmatter at all → false", () => {
    assert.equal(hasStructuredMustHaves("# Just a heading\n\nNo frontmatter here.\n"), false);
  });
});

describe("parseMustHaves — valid shapes", () => {
  test("legacy plan → throws pre-check error", () => {
    const plan = `---\nid: T01\n---\n# Task\n`;
    assert.throws(() => parseMustHaves(plan), /plan is legacy/);
  });

  test("full canonical plan (all block form)", () => {
    const plan = mkPlan(`id: T01
description: "test task"
must_haves:
  truths:
    - "it compiles"
    - "tests pass"
  artifacts:
    - path: "scripts/foo.js"
      provides: "main script"
      min_lines: 50
      stub_patterns:
        - "TODO"
        - "FIXME"
    - path: "scripts/foo.test.js"
      provides: "test suite"
      min_lines: 100
  key_links:
    - from: "scripts/foo.test.js"
      to: "scripts/foo.js"
      via: "require('./foo')"
expected_output:
  - scripts/foo.js
  - scripts/foo.test.js`);
    const r = parseMustHaves(plan);
    assert.deepEqual(r.truths, ["it compiles", "tests pass"]);
    assert.equal(r.artifacts.length, 2);
    assert.deepEqual(r.artifacts[0].stub_patterns, ["TODO", "FIXME"]);
    assert.equal(r.artifacts[1].stub_patterns, undefined);
    assert.equal(r.key_links.length, 1);
    assert.deepEqual(r.expected_output, ["scripts/foo.js", "scripts/foo.test.js"]);
  });

  test("inline empty arrays (truths/key_links/artifacts/expected_output: [])", () => {
    const plan = mkPlan(`must_haves:
  truths: []
  artifacts: []
  key_links: []
expected_output: []`);
    const r = parseMustHaves(plan);
    assert.deepEqual(r.truths, []);
    assert.deepEqual(r.artifacts, []);
    assert.deepEqual(r.key_links, []);
    assert.deepEqual(r.expected_output, []);
  });

  test("inline non-empty arrays (truths: [a, b])", () => {
    const plan = mkPlan(`must_haves:
  truths: [first truth, second truth]
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: [scripts/foo.js, scripts/bar.js]`);
    const r = parseMustHaves(plan);
    assert.deepEqual(r.truths, ["first truth", "second truth"]);
    assert.deepEqual(r.expected_output, ["scripts/foo.js", "scripts/bar.js"]);
  });

  test("stub_patterns inline in artifact", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns: ["TODO", "FIXME"]
  key_links: []
expected_output: []`);
    const r = parseMustHaves(plan);
    assert.deepEqual(r.artifacts[0].stub_patterns, ["TODO", "FIXME"]);
  });

  test("min_lines is parsed as a number", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 42
  key_links: []
expected_output: []`);
    const r = parseMustHaves(plan);
    assert.equal(r.artifacts[0].min_lines, 42);
    assert.equal(typeof r.artifacts[0].min_lines, "number");
  });

  test("expected_output block form", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output:
  - scripts/foo.js
  - scripts/bar.js`);
    const r = parseMustHaves(plan);
    assert.deepEqual(r.expected_output, ["scripts/foo.js", "scripts/bar.js"]);
  });
});

describe("parseMustHaves — block-sequence edge cases", () => {
  test("stub_patterns block form under a single artifact", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO"
        - "FIXME"
  key_links: []
expected_output: []`);
    const r = parseMustHaves(plan);
    assert.equal(r.artifacts.length, 1);
    assert.deepEqual(r.artifacts[0].stub_patterns, ["TODO", "FIXME"]);
  });

  test("stub_patterns block form across 2 artifacts (not merged)", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/a.js"
      provides: "a"
      min_lines: 5
      stub_patterns:
        - "TODO"
    - path: "scripts/b.js"
      provides: "b"
      min_lines: 5
      stub_patterns:
        - "FIXME"
        - "NOT_IMPLEMENTED"
  key_links: []
expected_output: []`);
    const r = parseMustHaves(plan);
    assert.equal(r.artifacts.length, 2);
    assert.deepEqual(r.artifacts[0].stub_patterns, ["TODO"]);
    assert.deepEqual(r.artifacts[1].stub_patterns, ["FIXME", "NOT_IMPLEMENTED"]);
  });

  test("HIGH: stub_patterns item with colon is not mis-parsed as a new artifact", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO: fix this"
        - "FIXME: later"
  key_links: []
expected_output: []`);
    const r = parseMustHaves(plan);
    assert.equal(r.artifacts.length, 1, `expected 1 artifact, got ${r.artifacts.length}`);
    assert.deepEqual(r.artifacts[0].stub_patterns, ["TODO: fix this", "FIXME: later"]);
    assert.equal(r.artifacts[0].path, "scripts/foo.js");
  });

  test("MEDIUM: seq-dash at equal indent to pending field closes pending cleanly", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "works"
  artifacts:
    - path: "src/a.js"
      provides: "a"
      min_lines: 5
      stub_patterns:
        - "TODO"
    - path: "src/b.js"
      provides: "b"
      min_lines: 5
  key_links: []
expected_output: []`);
    const r = parseMustHaves(plan);
    assert.equal(r.artifacts.length, 2);
    assert.deepEqual(r.artifacts[0].stub_patterns, ["TODO"]);
    assert.equal(r.artifacts[1].path, "src/b.js");
    assert.equal(r.artifacts[1].stub_patterns, undefined);
  });

  test("comment line inside stub_patterns block does not close pending state", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO"
        # this is a comment
        - "FIXME"
  key_links: []
expected_output: []`);
    const r = parseMustHaves(plan);
    assert.deepEqual(r.artifacts[0].stub_patterns, ["TODO", "FIXME"]);
  });
});

describe("parseMustHaves — malformed shapes throw", () => {
  test("must_haves empty block → throws", () => {
    const plan = mkPlan(`must_haves:\nexpected_output: []`);
    assert.throws(() => parseMustHaves(plan), /malformed must_haves schema/);
  });

  test("artifact without path → throws", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
    assert.throws(() => parseMustHaves(plan), /malformed must_haves schema.*path.*required/);
  });

  test("artifact without min_lines → throws", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
  key_links: []
expected_output: []`);
    assert.throws(() => parseMustHaves(plan), /malformed must_haves schema.*min_lines.*required/);
  });

  test("key_link without via → throws", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links:
    - from: "a.js"
      to: "b.js"
expected_output: []`);
    assert.throws(() => parseMustHaves(plan), /malformed must_haves schema.*via.*required/);
  });

  test("stub_patterns as a plain string scalar → throws", () => {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns: "not-an-array"
  key_links: []
expected_output: []`);
    assert.throws(() => parseMustHaves(plan), /malformed must_haves schema.*stub_patterns.*must be an array/);
  });
});

describe("parseMustHaves — real M0 fixture round-trip (A6)", () => {
  test("parses .../S01/tasks/T03/T03-PLAN.md without throwing", () => {
    // Copy the live fixture into a mkdtemp sandbox — never read the live .gsd/ at test time.
    withSandbox((dir) => {
      // Resolved via process.cwd() — the gate/test runner always executes from the
      // repo root. Avoids fragile relative-hop counting between dev (src/) and
      // compiled (dist-test/src/) execution contexts, which differ in depth.
      const repoRoot = process.cwd();
      const fixtureSrc = join(
        repoRoot,
        ".gsd",
        "milestones",
        "M-20260708005233-bootstrap-harness-nu",
        "slices",
        "S01",
        "tasks",
        "T03",
        "T03-PLAN.md",
      );
      const fixtureDst = join(dir, "T03-PLAN.md");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fixtureDst, readFileSync(fixtureSrc, "utf-8"));

      const content = readFileSync(fixtureDst, "utf-8");
      assert.equal(hasStructuredMustHaves(content), true);

      const r = parseMustHaves(content);
      assert.equal(Array.isArray(r.truths), true);
      assert.ok(r.truths.length > 0, "expected at least one truth");
      assert.equal(Array.isArray(r.artifacts), true);
      assert.ok(r.artifacts.length > 0, "expected at least one artifact");
      assert.equal(r.artifacts[0].path, "docs/forge/FORGE2-M0-WORKFLOW-TRIAGE.md");
      assert.equal(r.artifacts[0].min_lines, 30);
      assert.deepEqual(r.key_links, []);
      assert.deepEqual(r.expected_output, [
        "docs/forge/FORGE2-M0-WORKFLOW-TRIAGE.md",
        ".github/workflows/npm-publish.yml",
      ]);
    });
  });
});
