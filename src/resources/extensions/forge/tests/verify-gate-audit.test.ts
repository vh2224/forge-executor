import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { enforceMustHaves } from "../verify/must-haves-gate.ts";
import { auditFiles, renderFileAudit } from "../verify/file-audit.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_PLAN = `---
id: T01
slice: S01
milestone: M001
title: "Example"
must_haves:
  truths:
    - "Something is true."
  artifacts:
    - path: "src/example.ts"
      provides: "example()"
      min_lines: 10
      stub_patterns: ["TODO"]
  key_links:
    - from: "src/example.ts"
      to: "src/other.ts"
      via: "import"
expected_output:
  - src/example.ts
---

# T01: Example
`;

const LEGACY_PLAN = `---
id: T01
slice: S01
milestone: M001
title: "Legacy plan, no must_haves block"
---

# T01: Legacy

Free-text task description, no structured must_haves.
`;

const MALFORMED_PLAN = `---
id: T01
slice: S01
milestone: M001
title: "Malformed — artifact missing path"
must_haves:
  truths:
    - "Something is true."
  artifacts:
    - provides: "example()"
      min_lines: 10
  key_links: []
expected_output: []
---

# T01: Malformed
`;

// ── enforceMustHaves ──────────────────────────────────────────────────────────

describe("enforceMustHaves", () => {
  test("returns {ok:true} for a valid structured plan", () => {
    const result = enforceMustHaves(VALID_PLAN);
    assert.deepEqual(result, { ok: true });
  });

  test("returns {ok:false, reason:'legacy'} for a plan without must_haves", () => {
    const result = enforceMustHaves(LEGACY_PLAN);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "legacy");
    }
  });

  test("returns {ok:false, reason:'malformed', detail} for a present-but-invalid schema, never throws", () => {
    assert.doesNotThrow(() => enforceMustHaves(MALFORMED_PLAN));
    const result = enforceMustHaves(MALFORMED_PLAN);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "malformed");
      assert.ok(typeof result.detail === "string" && result.detail.length > 0);
      assert.match(result.detail, /path/);
    }
  });

  test("never throws on empty string input", () => {
    assert.doesNotThrow(() => enforceMustHaves(""));
    const result = enforceMustHaves("");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "legacy");
    }
  });

  test("never throws on garbage input with a must_haves key but broken nesting", () => {
    const garbage = `---\nmust_haves:\n  artifacts:\n    - path: 42\n---\n`;
    assert.doesNotThrow(() => enforceMustHaves(garbage));
    const result = enforceMustHaves(garbage);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "malformed");
    }
  });
});

// ── auditFiles ────────────────────────────────────────────────────────────────

describe("auditFiles", () => {
  test("returns empty missing/unexpected when expected and changed match exactly", () => {
    const result = auditFiles(["a.ts", "b.ts"], ["a.ts", "b.ts"]);
    assert.deepEqual(result, { missing: [], unexpected: [] });
  });

  test("detects missing (declared but not written)", () => {
    const result = auditFiles(["a.ts", "b.ts"], ["a.ts"]);
    assert.deepEqual(result.missing, ["b.ts"]);
    assert.deepEqual(result.unexpected, []);
  });

  test("detects unexpected (written but not declared)", () => {
    const result = auditFiles(["a.ts"], ["a.ts", "c.ts"]);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unexpected, ["c.ts"]);
  });

  test("partial overlap produces both missing and unexpected", () => {
    const result = auditFiles(["a.ts", "b.ts"], ["b.ts", "c.ts"]);
    assert.deepEqual(result.missing, ["a.ts"]);
    assert.deepEqual(result.unexpected, ["c.ts"]);
  });

  test("dedups and sorts both expected and changed deterministically", () => {
    const result = auditFiles(
      ["z.ts", "a.ts", "a.ts", "m.ts"],
      ["m.ts", "z.ts", "z.ts", "b.ts"],
    );
    assert.deepEqual(result.missing, ["a.ts"]);
    assert.deepEqual(result.unexpected, ["b.ts"]);
  });

  test("empty expected and empty changed yields empty result", () => {
    const result = auditFiles([], []);
    assert.deepEqual(result, { missing: [], unexpected: [] });
  });

  test("is deterministic across repeated calls with the same input", () => {
    const expected = ["x.ts", "a.ts"];
    const changed = ["y.ts", "a.ts"];
    const r1 = auditFiles(expected, changed);
    const r2 = auditFiles(expected, changed);
    assert.deepEqual(r1, r2);
  });
});

// ── renderFileAudit ───────────────────────────────────────────────────────────

describe("renderFileAudit", () => {
  test("renders a one-line summary with zero counts when both lists are empty", () => {
    const out = renderFileAudit({ missing: [], unexpected: [] });
    assert.equal(out, "file-audit: 0 missing, 0 unexpected");
  });

  test("includes missing and unexpected lists in the render", () => {
    const out = renderFileAudit({ missing: ["a.ts"], unexpected: ["b.ts"] });
    assert.match(out, /file-audit: 1 missing, 1 unexpected/);
    assert.match(out, /missing:/);
    assert.match(out, /- a\.ts/);
    assert.match(out, /unexpected:/);
    assert.match(out, /- b\.ts/);
  });

  test("is pure — no embedded date, and identical input always renders identically", () => {
    const result = { missing: ["a.ts"], unexpected: ["b.ts"] };
    const r1 = renderFileAudit(result);
    const r2 = renderFileAudit(result);
    assert.equal(r1, r2);
    assert.doesNotMatch(r1, /\d{4}-\d{2}-\d{2}/);
  });
});
