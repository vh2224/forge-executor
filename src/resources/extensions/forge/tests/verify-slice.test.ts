import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverTaskPlans,
  aggregateMustHaves,
  runSliceVerification,
  renderVerification,
  writeVerification,
  collectExpectedOutputs,
  sliceDirOf,
  VERIFIER_VERSION,
} from "../verify/verify-slice.ts";

// ── Fixture sandbox ───────────────────────────────────────────────────────────

const roots: string[] = [];

function mkRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-verify-slice-"));
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

const MID = "M-test-milestone";
const SLICE = "S06";

/** Build a structured T##-PLAN.md with the given artifacts/expected_output. */
function structuredPlan(opts: {
  artifacts: { path: string; provides: string; min_lines: number; stub_patterns?: string[] }[];
  expected_output?: string[];
}): string {
  const artLines = opts.artifacts
    .map((a) => {
      const stub =
        a.stub_patterns !== undefined
          ? `\n      stub_patterns: [${a.stub_patterns.map((s) => `"${s}"`).join(", ")}]`
          : "";
      return `    - path: "${a.path}"\n      provides: "${a.provides}"\n      min_lines: ${a.min_lines}${stub}`;
    })
    .join("\n");
  const eo = (opts.expected_output ?? opts.artifacts.map((a) => a.path))
    .map((p) => `  - ${p}`)
    .join("\n");
  return `---
id: T01
must_haves:
  truths:
    - "does a thing"
  artifacts:
${artLines}
  key_links: []
expected_output:
${eo}
---

# Plan
`;
}

const LEGACY_PLAN = `---
id: T99
title: "legacy plan without structured must_haves"
---

# Legacy
`;

const MALFORMED_PLAN = `---
id: T50
must_haves:
  truths:
    - "ok"
  artifacts:
    - path: "src/x.ts"
      provides: "x"
  key_links: []
---

# Malformed (artifact missing min_lines)
`;

/** Set up a slice dir with a valid task (real substantive+wired artifact + a test),
 *  a legacy task, and a malformed task. Returns the cwd root. */
function makeSlice(): string {
  const root = mkRoot();
  const sliceDir = sliceDirOf(root, MID, SLICE);

  // T01 — valid: two artifacts that reference each other (wired ✓) + a weak test.
  writeFile(
    root,
    "src/mod.ts",
    `import { helper } from "./helper";\nexport function mod() {\n  return helper() + 1;\n}\n`,
  );
  writeFile(
    root,
    "src/helper.ts",
    `import { mod } from "./mod";\nexport function helper() {\n  return typeof mod === "function" ? 41 : 0;\n}\n`,
  );
  writeFile(
    root,
    "src/weak.test.ts",
    `import { test } from "node:test";\nimport assert from "node:assert";\ntest("weak", () => {\n  assert(true);\n});\n`,
  );
  writeFile(
    sliceDir,
    "tasks/T01/T01-PLAN.md",
    structuredPlan({
      artifacts: [
        { path: "src/mod.ts", provides: "mod", min_lines: 2 },
        { path: "src/helper.ts", provides: "helper", min_lines: 2 },
        { path: "src/weak.test.ts", provides: "weak test", min_lines: 2 },
      ],
      expected_output: ["src/mod.ts", "src/helper.ts", "src/weak.test.ts"],
    }),
  );

  // T02 — legacy plan (no structured must_haves).
  writeFile(sliceDir, "tasks/T02/T02-PLAN.md", LEGACY_PLAN);

  // T03 — malformed plan (artifact missing min_lines).
  writeFile(sliceDir, "tasks/T03/T03-PLAN.md", MALFORMED_PLAN);

  return root;
}

// ── discoverTaskPlans ────────────────────────────────────────────────────────

describe("discoverTaskPlans", () => {
  test("discovers T## dirs sorted; ignores non-T## entries", () => {
    const root = makeSlice();
    const sliceDir = sliceDirOf(root, MID, SLICE);
    mkdirSync(join(sliceDir, "tasks", "notes"), { recursive: true });
    const { plans, noTasksDir } = discoverTaskPlans(sliceDir);
    assert.equal(noTasksDir, false);
    assert.deepEqual(
      plans.map((p) => p.taskId),
      ["T01", "T02", "T03"],
    );
    assert.ok(plans[0].absPath.endsWith(join("T01", "T01-PLAN.md")));
  });

  test("missing tasks dir → noTasksDir true, empty plans", () => {
    const root = mkRoot();
    const { plans, noTasksDir } = discoverTaskPlans(sliceDirOf(root, MID, SLICE));
    assert.equal(noTasksDir, true);
    assert.deepEqual(plans, []);
  });
});

// ── aggregateMustHaves ───────────────────────────────────────────────────────

describe("aggregateMustHaves", () => {
  test("buckets structured / legacy / malformed / errors", () => {
    const root = makeSlice();
    const { plans } = discoverTaskPlans(sliceDirOf(root, MID, SLICE));
    // add a bogus plan ref that does not exist on disk → errors bucket
    plans.push({ taskId: "T77", absPath: join(root, "nope", "T77-PLAN.md") });
    const agg = aggregateMustHaves(plans);
    assert.deepEqual(agg.structured.map((s) => s.taskId), ["T01"]);
    assert.deepEqual(agg.legacy.map((l) => l.taskId), ["T02"]);
    assert.deepEqual(agg.malformed.map((m) => m.taskId), ["T03"]);
    assert.deepEqual(agg.errors.map((e) => e.taskId), ["T77"]);
    assert.match(agg.malformed[0].error, /min_lines/);
  });

  test("never throws on legacy/malformed", () => {
    const root = makeSlice();
    const { plans } = discoverTaskPlans(sliceDirOf(root, MID, SLICE));
    assert.doesNotThrow(() => aggregateMustHaves(plans));
  });
});

// ── runSliceVerification ─────────────────────────────────────────────────────

describe("runSliceVerification", () => {
  test("runs L1-4 over real artifacts + legacy/malformed skip rows", () => {
    const root = makeSlice();
    const result = runSliceVerification(root, MID, SLICE);

    assert.equal(result.legacy_count, 1);
    assert.equal(result.malformed_count, 1);
    assert.equal(result.slice, SLICE);
    assert.equal(result.milestone, MID);

    const byPath = new Map(result.rows.map((r) => [r.path, r]));

    // mod.ts: exists ✓, substantive ✓, wired ✓ (helper imports it)
    const mod = byPath.get("src/mod.ts");
    assert.ok(mod);
    assert.equal(mod.exists, true);
    assert.equal(mod.substantive, true);
    assert.equal(mod.wired, true);
    assert.equal(mod.sourceTask, "T01");

    // weak.test.ts: test-quality detected weak assertion → test_quality false
    const weak = byPath.get("src/weak.test.ts");
    assert.ok(weak);
    assert.equal(weak.test_quality, false);
    assert.ok(weak.flags.some((f) => f.reason === "weak-assertion"));

    // legacy + malformed → schema skip rows
    const legacyRow = result.rows.find((r) =>
      r.flags.some((f) => f.reason === "legacy_schema"),
    );
    assert.ok(legacyRow);
    assert.equal(legacyRow.sourceTask, "T02");
    const malformedRow = result.rows.find((r) =>
      r.flags.some((f) => f.reason === "malformed_schema"),
    );
    assert.ok(malformedRow);
    assert.equal(malformedRow.sourceTask, "T03");
  });

  test("substantive-fail (below_min_lines) and wired-fail detected", () => {
    const root = mkRoot();
    const sliceDir = sliceDirOf(root, MID, SLICE);
    // tiny artifact fails min_lines; isolated artifact has no referrers → wired ✗
    writeFile(root, "src/tiny.ts", `export const x = 1;\n`);
    writeFile(
      root,
      "src/lonely.ts",
      `export function lonely() {\n  return "no one imports me";\n}\n`,
    );
    writeFile(
      sliceDir,
      "tasks/T01/T01-PLAN.md",
      structuredPlan({
        artifacts: [
          { path: "src/tiny.ts", provides: "tiny", min_lines: 50 },
          { path: "src/lonely.ts", provides: "lonely", min_lines: 2 },
        ],
      }),
    );
    const result = runSliceVerification(root, MID, SLICE);
    const byPath = new Map(result.rows.map((r) => [r.path, r]));

    const tiny = byPath.get("src/tiny.ts");
    assert.ok(tiny);
    assert.equal(tiny.substantive, false);
    assert.ok(tiny.flags.some((f) => f.reason === "below_min_lines"));

    const lonely = byPath.get("src/lonely.ts");
    assert.ok(lonely);
    assert.equal(lonely.wired, false);
    assert.ok(lonely.flags.some((f) => f.reason === "no_references_found"));
  });

  test("clean slice → all green, no failing flags", () => {
    const root = mkRoot();
    const sliceDir = sliceDirOf(root, MID, SLICE);
    writeFile(
      root,
      "src/a.ts",
      `import { b } from "./b";\nexport function a() {\n  return b() + 1;\n}\n`,
    );
    writeFile(
      root,
      "src/b.ts",
      `import { a } from "./a";\nexport function b() {\n  return typeof a === "function" ? 2 : 0;\n}\n`,
    );
    writeFile(
      sliceDir,
      "tasks/T01/T01-PLAN.md",
      structuredPlan({
        artifacts: [
          { path: "src/a.ts", provides: "a", min_lines: 2 },
          { path: "src/b.ts", provides: "b", min_lines: 2 },
        ],
      }),
    );
    const result = runSliceVerification(root, MID, SLICE);
    for (const row of result.rows) {
      assert.equal(row.exists, true);
      assert.equal(row.substantive, true);
      assert.equal(row.wired, true);
      assert.equal(row.flags.length, 0);
    }
  });
});

// ── renderVerification (PURE / deterministic) ────────────────────────────────

describe("renderVerification", () => {
  test("deterministic: re-render with same input is byte-identical", () => {
    const root = makeSlice();
    const result = runSliceVerification(root, MID, SLICE);
    const opts = { generated_at: "2026-01-01T00:00:00.000Z" };
    const md1 = renderVerification(result, opts);
    const md2 = renderVerification(result, opts);
    assert.equal(md1, md2);
    assert.ok(md1.includes(`generated_at: ${opts.generated_at}`));
    assert.ok(md1.includes(`verifier_version: "${VERIFIER_VERSION}"`));
    assert.ok(md1.includes("Gerado nativamente por `forge/verify`"));
    assert.ok(md1.includes("## Artifact Audit"));
  });

  test("frontmatter carries legacy/malformed counts; Flags section present", () => {
    const root = makeSlice();
    const result = runSliceVerification(root, MID, SLICE);
    const md = renderVerification(result, {
      generated_at: "2026-01-01T00:00:00.000Z",
    });
    assert.ok(md.includes("legacy_count: 1"));
    assert.ok(md.includes("malformed_count: 1"));
    assert.ok(md.includes("## Flags"));
    // weak test surfaces a Test-quality narrative entry
    assert.ok(md.includes("weak-assertion"));
  });

  test("custom verifier_version is honored", () => {
    const root = makeSlice();
    const result = runSliceVerification(root, MID, SLICE);
    const md = renderVerification(result, {
      generated_at: "2026-01-01T00:00:00.000Z",
      verifier_version: "v-custom",
    });
    assert.ok(md.includes(`verifier_version: "v-custom"`));
  });
});

// ── writeVerification (ATOMIC / idempotent) ──────────────────────────────────

describe("writeVerification", () => {
  test("writes file then no-ops on byte-identical re-write", () => {
    const root = makeSlice();
    const result = runSliceVerification(root, MID, SLICE);
    const md = renderVerification(result, {
      generated_at: "2026-01-01T00:00:00.000Z",
    });

    const first = writeVerification(root, MID, SLICE, md);
    assert.equal(first.created, true);
    assert.ok(first.path.endsWith(join(SLICE, `${SLICE}-VERIFICATION.md`)));
    assert.equal(readFileSync(first.path, "utf-8"), md);

    const second = writeVerification(root, MID, SLICE, md);
    assert.equal(second.created, false);
    assert.equal(readFileSync(second.path, "utf-8"), md);

    // changed content → rewrite
    const changed = writeVerification(root, MID, SLICE, md + "\n<!-- x -->\n");
    assert.equal(changed.created, true);
  });
});

// ── collectExpectedOutputs ───────────────────────────────────────────────────

describe("collectExpectedOutputs", () => {
  test("dedup union across tasks, first-seen order", () => {
    const root = mkRoot();
    const sliceDir = sliceDirOf(root, MID, SLICE);
    writeFile(
      sliceDir,
      "tasks/T01/T01-PLAN.md",
      structuredPlan({
        artifacts: [{ path: "src/a.ts", provides: "a", min_lines: 2 }],
        expected_output: ["src/a.ts", "src/shared.ts"],
      }),
    );
    writeFile(
      sliceDir,
      "tasks/T02/T02-PLAN.md",
      structuredPlan({
        artifacts: [{ path: "src/b.ts", provides: "b", min_lines: 2 }],
        expected_output: ["src/shared.ts", "src/b.ts"],
      }),
    );
    // legacy + malformed contribute nothing, never throw
    writeFile(sliceDir, "tasks/T03/T03-PLAN.md", LEGACY_PLAN);
    writeFile(sliceDir, "tasks/T04/T04-PLAN.md", MALFORMED_PLAN);

    const eo = collectExpectedOutputs(root, MID, SLICE);
    assert.deepEqual(eo, ["src/a.ts", "src/shared.ts", "src/b.ts"]);
  });

  test("no tasks dir → empty array, never throws", () => {
    const root = mkRoot();
    assert.deepEqual(collectExpectedOutputs(root, MID, SLICE), []);
  });
});
