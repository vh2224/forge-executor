import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlan, writePlanCheck, detectFrontmatterRequirement, DIMENSION_NAMES, type Verdict } from "../gates/plan-checker.ts";

// ── Fixture harness ─────────────────────────────────────────────────────────
//
// Every test builds a synthetic milestone/slice tree under a fresh mkdtemp
// sandbox — nothing here touches the live repo `.gsd/`.

const MID = "M-20260101000000-example";
const SID = "S01";

// Real-file calibration for `detectFrontmatterRequirement` (T01-PLAN §Steps 2):
// resolved via process.cwd() since the gate/test runner always executes from
// the repo root. `.gsd/` is gitignored (forge 1.0's live runtime state), so a
// fresh clone won't have this file — skip honestly rather than red-falsing
// (same discipline as `gsd-history-operation.test.ts`).
const REAL_MID = "M-20260712170458-cockpit-v2";
const REAL_CONTEXT_PATH = join(process.cwd(), ".gsd", "milestones", REAL_MID, `${REAL_MID}-CONTEXT.md`);
const REAL_CONTEXT_SKIP_MSG =
  "CONTEXT real da milestone ausente (.gsd/ é gitignored) — teste só roda no workspace de desenvolvimento";
function realMilestoneContextAvailable(): boolean {
  return existsSync(REAL_CONTEXT_PATH);
}

interface TaskSpec {
  id: string;
  depends?: string[];
  expected_output?: string[];
  goal?: string; // omit → no ## Goal section
  legacy?: boolean; // legacy → free-text must_haves (no structured block)
  invalidMustHaves?: boolean; // structured but malformed
  truths?: string[];
  steps?: string;
  domain?: string; // frontmatter `domain:` value (omit → key absent)
  effort?: string; // frontmatter `effort:` value (omit → key absent)
}

interface SliceSpec {
  omitPlan?: boolean;
  planTasksSection?: string; // overrides § Tasks body
  acceptance?: string[]; // § Acceptance Criteria bullets
  outOfScope?: string[]; // § Out of Scope bullets
  deferrals?: string[]; // § Deferrals bullets
  tasks: TaskSpec[];
  risk?: string; // S##-RISK.md body
  mContext?: string; // M###-CONTEXT.md body
  sContext?: string; // S##-CONTEXT.md body
}

function structuredMustHaves(spec: TaskSpec): string {
  if (spec.legacy) {
    // legacy free-text — no structured `must_haves:` key
    return `must_haves_text: "do the thing well"\n`;
  }
  if (spec.invalidMustHaves) {
    // structured but artifacts[0].min_lines missing → parseMustHaves throws
    return [
      `must_haves:`,
      `  truths:`,
      ...(spec.truths ?? ["it works"]).map((t) => `    - "${t}"`),
      `  artifacts:`,
      `    - path: "src/x.ts"`,
      `      provides: "x"`,
      `  key_links: []`,
      `expected_output:`,
      ...(spec.expected_output ?? ["src/x.ts"]).map((p) => `  - "${p}"`),
    ].join("\n") + "\n";
  }
  return [
    `must_haves:`,
    `  truths:`,
    ...(spec.truths ?? ["it works"]).map((t) => `    - "${t}"`),
    `  artifacts:`,
    `    - path: "src/x.ts"`,
    `      provides: "x"`,
    `      min_lines: 10`,
    `  key_links: []`,
    `expected_output:`,
    ...(spec.expected_output ?? ["src/x.ts"]).map((p) => `  - "${p}"`),
  ].join("\n") + "\n";
}

function taskPlanContent(spec: TaskSpec): string {
  const depends = spec.depends ?? [];
  const fm = [
    `---`,
    `id: ${spec.id}`,
    `slice: ${SID}`,
    ...(spec.domain !== undefined ? [`domain: ${spec.domain}`] : []),
    ...(spec.effort !== undefined ? [`effort: ${spec.effort}`] : []),
    `depends: [${depends.join(", ")}]`,
    ...(spec.expected_output ? [`expected_output: [${spec.expected_output.map((p) => `"${p}"`).join(", ")}]`] : []),
    structuredMustHaves(spec).trimEnd(),
    `---`,
    ``,
    `# ${spec.id}`,
    ``,
    ...(spec.goal !== undefined ? [`## Goal`, spec.goal, ``] : []),
    `## Steps`,
    spec.steps ?? "1. do it",
    ``,
    `## Standards`,
    `- clean`,
  ];
  return fm.join("\n");
}

function buildSlice(cwd: string, spec: SliceSpec): void {
  const sliceDir = join(cwd, ".gsd", "milestones", MID, "slices", SID);
  const mDir = join(cwd, ".gsd", "milestones", MID);
  mkdirSync(sliceDir, { recursive: true });

  if (!spec.omitPlan) {
    const tasksBody =
      spec.planTasksSection ??
      spec.tasks.map((t) => `- [ ] **${t.id}** — does ${t.id}`).join("\n");
    const planParts = [
      `---`,
      `id: ${SID}`,
      `milestone: ${MID}`,
      `---`,
      ``,
      `# ${SID}`,
      ``,
      `## Tasks`,
      ``,
      tasksBody,
      ``,
    ];
    if (spec.acceptance) {
      planParts.push(`## Acceptance Criteria`, ``, ...spec.acceptance.map((a) => `- ${a}`), ``);
    }
    if (spec.outOfScope) {
      planParts.push(`## Out of Scope`, ``, ...spec.outOfScope.map((o) => `- ${o}`), ``);
    }
    if (spec.deferrals) {
      planParts.push(`## Deferrals`, ``, ...spec.deferrals.map((d) => `- ${d}`), ``);
    }
    writeFileSync(join(sliceDir, `${SID}-PLAN.md`), planParts.join("\n"));
  }

  for (const t of spec.tasks) {
    const tDir = join(sliceDir, "tasks", t.id);
    mkdirSync(tDir, { recursive: true });
    // A missing-plan task is declared in § Tasks but its file is absent.
    if ((t as TaskSpec & { omitFile?: boolean }).omitFile) continue;
    writeFileSync(join(tDir, `${t.id}-PLAN.md`), taskPlanContent(t));
  }

  if (spec.risk) writeFileSync(join(sliceDir, `${SID}-RISK.md`), spec.risk);
  if (spec.mContext) writeFileSync(join(mDir, `${MID}-CONTEXT.md`), spec.mContext);
  if (spec.sContext) writeFileSync(join(sliceDir, `${SID}-CONTEXT.md`), spec.sContext);
}

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-plan-check-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function dim(result: ReturnType<typeof checkPlan>, name: string): Verdict {
  const d = result.dimensions.find((x) => x.name === name);
  assert.ok(d, `dimension ${name} present`);
  return d!.verdict;
}

// ── Structural invariants ───────────────────────────────────────────────────

describe("checkPlan — structural invariants", () => {
  test("scores exactly the first 12 LOCKED dimensions in order (no frontmatter requirement in CONTEXT)", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "build x" }] });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(r.status, "done");
      // The 13th LOCKED name (frontmatter_compliance) is conditional — this
      // fixture has no mContext/sContext, so the requirement is absent and
      // the result stays at exactly the first 12 names, byte-identical.
      assert.deepEqual(r.dimensions.map((d) => d.name), DIMENSION_NAMES.slice(0, 12));
    });
  });

  test("counts always sum to exactly 12", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [
          { id: "T01", goal: "a", depends: ["T02"] }, // back-edge (T02 after T01) + unresolved-ordering
          { id: "T02", legacy: true },
        ],
      });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(r.counts.pass + r.counts.warn + r.counts.fail, 12);
    });
  });
});

// ── The one blocking condition ──────────────────────────────────────────────

describe("checkPlan — blocked", () => {
  test("missing S##-PLAN.md → blocked, scope_exceeded, no dimensions", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { omitPlan: true, tasks: [{ id: "T01", goal: "x" }] });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(r.status, "blocked");
      assert.equal(r.blocker_class, "scope_exceeded");
      assert.equal(r.dimensions.length, 0);
    });
  });

  test("missing optional inputs degrade to pass, never throw", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "x" }] });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(dim(r, "risk_coverage"), "pass");
      assert.equal(dim(r, "decisions_honored"), "pass");
      assert.equal(dim(r, "acceptance_observable"), "pass");
    });
  });
});

// ── Per-dimension pass/warn/fail ────────────────────────────────────────────

describe("dimension: completeness", () => {
  test("pass — all declared tasks have plan + goal", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }, { id: "T02", goal: "b" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "completeness"), "pass");
    });
  });
  test("warn — one task missing ## Goal", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }, { id: "T02" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "completeness"), "warn");
    });
  });
  test("fail — two tasks missing ## Goal", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01" }, { id: "T02" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "completeness"), "fail");
    });
  });
});

describe("dimension: must_haves_wellformed + legacy_schema_detect (C13)", () => {
  test("pass — all structured & valid", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }] });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(dim(r, "must_haves_wellformed"), "pass");
      assert.equal(dim(r, "legacy_schema_detect"), "pass");
    });
  });
  test("legacy task → BOTH dimensions warn, NEVER fail (C13)", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }, { id: "T02", goal: "b", legacy: true }] });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(dim(r, "must_haves_wellformed"), "warn");
      assert.equal(dim(r, "legacy_schema_detect"), "warn");
    });
  });
  test("legacy_schema_detect is never fail even with many legacy tasks", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [
          { id: "T01", goal: "a", legacy: true },
          { id: "T02", goal: "b", legacy: true },
          { id: "T03", goal: "c", legacy: true },
        ],
      });
      assert.notEqual(dim(checkPlan(cwd, MID, SID), "legacy_schema_detect"), "fail");
    });
  });
  test("fail — non-legacy task with malformed must_haves", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a", invalidMustHaves: true }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "must_haves_wellformed"), "fail");
    });
  });
});

describe("dimension: ordering", () => {
  test("pass — depends respected", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }, { id: "T02", goal: "b", depends: ["T01"] }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "ordering"), "pass");
    });
  });
  test("fail — back-dependency", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a", depends: ["T02"] }, { id: "T02", goal: "b" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "ordering"), "fail");
    });
  });
  test("warn — no declared order in § Tasks", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { planTasksSection: "TBD — no task ids here", tasks: [{ id: "T01", goal: "a" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "ordering"), "warn");
    });
  });
});

describe("dimension: dependencies", () => {
  test("pass — all resolve", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }, { id: "T02", goal: "b", depends: ["T01"] }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "dependencies"), "pass");
    });
  });
  test("warn — one unresolved dep", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a", depends: ["T99"] }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "dependencies"), "warn");
    });
  });
  test("fail — two unresolved deps", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a", depends: ["T98", "T99"] }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "dependencies"), "fail");
    });
  });
});

describe("dimension: risk_coverage", () => {
  test("pass — no risk file", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "risk_coverage"), "pass");
    });
  });
  test("pass — risk mitigated by a task step keyword", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        risk: "- concurrency race in the writer path",
        tasks: [{ id: "T01", goal: "a", steps: "1. serialize the concurrency writer path" }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "risk_coverage"), "pass");
    });
  });
  test("warn/fail — uncovered risks", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        risk: "- undocumented telemetry leakage\n- broken migration rollback path",
        tasks: [{ id: "T01", goal: "a", steps: "1. unrelated work" }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "risk_coverage"), "fail");
    });
  });
});

describe("dimension: acceptance_observable", () => {
  test("pass — observable criteria", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        acceptance: ["Run `pnpm test` and confirm green", "Grep src/x.ts for the export"],
        tasks: [{ id: "T01", goal: "a" }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "acceptance_observable"), "pass");
    });
  });
  test("fail — two vague criteria", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        acceptance: ["the plan feels complete", "quality is good overall"],
        tasks: [{ id: "T01", goal: "a" }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "acceptance_observable"), "fail");
    });
  });
});

describe("dimension: scope_alignment", () => {
  test("pass — no out-of-scope section", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "scope_alignment"), "pass");
    });
  });
  test("warn — one task references an out-of-scope capability", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        outOfScope: ["**telemetry** dashboards are deferred"],
        tasks: [{ id: "T01", goal: "wire up telemetry collection", truths: ["exposes telemetry"] }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "scope_alignment"), "warn");
    });
  });
});

describe("dimension: decisions_honored", () => {
  test("pass — no context decisions", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "decisions_honored"), "pass");
    });
  });
  test("warn — one task contradicts a prohibition decision", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        sContext: `# ctx\n\n## Decisions\n\n- The agent must NUNCA shellout to external scripts.\n`,
        tasks: [{ id: "T01", goal: "a", steps: "1. shellout to forge-must-haves.js" }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "decisions_honored"), "warn");
    });
  });
});

describe("dimension: expected_output_realistic", () => {
  test("pass — clean paths", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [{ id: "T01", goal: "a", expected_output: ["src/a.ts"] }, { id: "T02", goal: "b", expected_output: ["src/b.ts"] }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "expected_output_realistic"), "pass");
    });
  });
  test("fail — duplicate path across tasks", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [{ id: "T01", goal: "a", expected_output: ["src/dup.ts"] }, { id: "T02", goal: "b", expected_output: ["src/dup.ts"] }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "expected_output_realistic"), "fail");
    });
  });
  test("warn — one absolute path", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a", expected_output: ["/etc/x.ts"] }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "expected_output_realistic"), "warn");
    });
  });
});

describe("dimension: through_the_driver (S08)", () => {
  test("pass — dispatch claim backed by dispatchUnitViaNewSession referent", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [
          {
            id: "T01",
            goal: "a",
            truths: ["dispatches production work through the driver"],
            steps: "1. exercise dispatchUnitViaNewSession end to end",
          },
        ],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "through_the_driver"), "pass");
    });
  });

  test("pass — claim is backed by a referent in the same task", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [{
          id: "T01",
          goal: "a",
          truths: ["dispatches production work"],
          steps: "1. run the dispatchUnitViaNewSession e2e test",
        }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "through_the_driver"), "pass");
    });
  });

  test("pass — claim is backed by a referent in a depended-on task", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [
          { id: "T01", depends: ["T02"], goal: "a", truths: ["dispatches production work"] },
          { id: "T02", goal: "test seam", steps: "1. run dispatchUnitViaNewSession e2e" },
        ],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "through_the_driver"), "pass");
    });
  });

  test("warn — unrelated sibling referent does not back a claim", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [
          { id: "T01", goal: "a", truths: ["dispatches production work"] },
          { id: "T02", goal: "unrelated test", steps: "1. run unrelated -e2e.test fixture" },
        ],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "through_the_driver"), "warn");
    });
  });

  test("warn — one task claims dispatch with no through-the-driver referent anywhere", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [{ id: "T01", goal: "a", truths: ["dispatches production work"] }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "through_the_driver"), "warn");
    });
  });

  test("fail — two tasks claim dispatch with no through-the-driver referent anywhere", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        tasks: [
          { id: "T01", goal: "a", truths: ["dispatches production work"] },
          { id: "T02", goal: "b", truths: ["unit_result reflects the real driver"] },
        ],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "through_the_driver"), "fail");
    });
  });

  test("pass — no production-dispatch claim at all (not applicable)", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "build a widget", truths: ["it works"] }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "through_the_driver"), "pass");
    });
  });
});

describe("dimension: scope_drop", () => {
  const dropped = "## Achado durante a execução — S01 deve implementar probe cego\n\nO probe cego precisa ser validado.";

  test("fail — addressed addendum has no task coverage or deferral", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { mContext: dropped, tasks: [{ id: "T01", goal: "build unrelated work" }] });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(dim(r, "scope_drop"), "fail");
      assert.equal(r.status, "done");
    });
  });

  test("pass — addendum addressed to another slice", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { mContext: dropped.replace("S01", "S07"), tasks: [{ id: "T01", goal: "build unrelated work" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "scope_drop"), "pass");
    });
  });

  test("pass — subject is covered by a task Goal/truth", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { mContext: dropped, tasks: [{ id: "T01", goal: "implementar probe precisa validado validation" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "scope_drop"), "pass");
    });
  });

  test("pass — subject is explicitly deferred", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { mContext: dropped, deferrals: ["implementar probe precisa validado deferred to the next slice"], tasks: [{ id: "T01", goal: "build unrelated work" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "scope_drop"), "pass");
    });
  });

  test("pass — no marked addendum is not applicable", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { mContext: "## Context\n\nOrdinary background text.", tasks: [{ id: "T01", goal: "build x" }] });
      assert.equal(dim(checkPlan(cwd, MID, SID), "scope_drop"), "pass");
    });
  });
});

describe("dimension: frontmatter_compliance", () => {
  // Same shape as the real calibration text (T01-PLAN §Steps 2): an
  // obligation word, then `domain`, then `effort`, on one line.
  const REQUIRES_FRONTMATTER = "todo T##-PLAN DEVE emitir `domain:` e `effort:`\n";
  const NO_REQUIREMENT = "## Context\n\nOrdinary background text about the milestone, nothing about frontmatter.\n";

  test("dimension absent when requirement not detected — not scored at all", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { mContext: NO_REQUIREMENT, tasks: [{ id: "T01", goal: "a" }] });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(r.dimensions.length, 12);
      assert.ok(!r.dimensions.some((d) => d.name === "frontmatter_compliance"));
    });
  });

  test("pass — requirement present, all tasks emit domain: and a valid effort:", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        mContext: REQUIRES_FRONTMATTER,
        tasks: [
          { id: "T01", goal: "a", domain: "infra", effort: "medium" },
          { id: "T02", goal: "b", domain: "infra", effort: "high" },
        ],
      });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(r.dimensions.length, 13);
      assert.equal(dim(r, "frontmatter_compliance"), "pass");
    });
  });

  test("warn — one task missing domain:", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        mContext: REQUIRES_FRONTMATTER,
        tasks: [
          { id: "T01", goal: "a", effort: "medium" },
          { id: "T02", goal: "b", domain: "infra", effort: "high" },
        ],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "frontmatter_compliance"), "warn");
    });
  });

  test("fail — two tasks bad (missing domain and/or effort)", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        mContext: REQUIRES_FRONTMATTER,
        tasks: [
          { id: "T01", goal: "a" }, // no domain, no effort
          { id: "T02", goal: "b", domain: "infra" }, // no effort
        ],
      });
      const r = checkPlan(cwd, MID, SID);
      assert.equal(dim(r, "frontmatter_compliance"), "fail");
    });
  });

  test("effort: outside EFFORT_LEVELS counts as non-conforming", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        mContext: REQUIRES_FRONTMATTER,
        tasks: [{ id: "T01", goal: "a", domain: "infra", effort: "medium-high" }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "frontmatter_compliance"), "warn");
    });
  });

  test("domain: is presence/non-empty only — any non-empty value passes (open vocabulary, D-S03-4)", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        mContext: REQUIRES_FRONTMATTER,
        tasks: [{ id: "T01", goal: "a", domain: "whatever-domain-nobody-declared", effort: "low" }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "frontmatter_compliance"), "pass");
    });
  });

  test("sContext requirement is also honored (OR with mContext)", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, {
        sContext: REQUIRES_FRONTMATTER,
        tasks: [{ id: "T01", goal: "a" }],
      });
      assert.equal(dim(checkPlan(cwd, MID, SID), "frontmatter_compliance"), "warn");
    });
  });

  test("requirement absent → writePlanCheck header stays byte-identical (12 locked dimensions)", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { mContext: NO_REQUIREMENT, tasks: [{ id: "T01", goal: "a" }] });
      const r = checkPlan(cwd, MID, SID);
      const out = readFileSync(writePlanCheck(cwd, MID, SID, r), "utf-8");
      assert.match(out, /Scores 12 locked dimensions\./);
      const rows = out.split("\n").filter((l) => /^\| \d+ \|/.test(l));
      assert.equal(rows.length, 12);
    });
  });

  describe("detectFrontmatterRequirement", () => {
    test("true for the real CONTEXT text of this milestone", { skip: !realMilestoneContextAvailable() && REAL_CONTEXT_SKIP_MSG }, () => {
      const text = readFileSync(REAL_CONTEXT_PATH, "utf-8");
      assert.equal(detectFrontmatterRequirement(text), true);
    });

    test("false for a CONTEXT with no requirement clause", () => {
      assert.equal(detectFrontmatterRequirement(NO_REQUIREMENT), false);
    });

    test("false for empty text", () => {
      assert.equal(detectFrontmatterRequirement(""), false);
    });
  });
});

// ── writePlanCheck artefact ─────────────────────────────────────────────────

describe("writePlanCheck — LOCKED shape + idempotency", () => {
  function stripTimestamp(s: string): string {
    return s.replace(/^generated_at: .*/m, "generated_at: <ts>");
  }

  test("writes LOCKED shape: 12 rows, summary sums to 12", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }] });
      const r = checkPlan(cwd, MID, SID);
      const path = writePlanCheck(cwd, MID, SID, r);
      const out = readFileSync(path, "utf-8");
      assert.match(out, /^id: S01$/m);
      assert.match(out, /^mode: advisory$/m);
      const rows = out.split("\n").filter((l) => /^\| \d+ \|/.test(l));
      assert.equal(rows.length, 12);
      assert.match(out, new RegExp(`- \\*\\*pass:\\*\\* ${r.counts.pass}`));
    });
  });

  test("Advisory Notes present only when fail > 0", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }] });
      const clean = checkPlan(cwd, MID, SID);
      const cleanOut = readFileSync(writePlanCheck(cwd, MID, SID, clean), "utf-8");
      assert.equal(clean.counts.fail, 0);
      assert.doesNotMatch(cleanOut, /## Advisory Notes/);

      buildSlice(cwd, { tasks: [{ id: "T01", depends: ["T98", "T99"], goal: "a" }] });
      const failing = checkPlan(cwd, MID, SID);
      const failOut = readFileSync(writePlanCheck(cwd, MID, SID, failing), "utf-8");
      assert.ok(failing.counts.fail > 0);
      assert.match(failOut, /## Advisory Notes/);
    });
  });

  test("idempotent — re-run is byte-identical except generated_at", () => {
    withSandbox((cwd) => {
      buildSlice(cwd, { tasks: [{ id: "T01", goal: "a" }, { id: "T02", goal: "b", depends: ["T01"] }] });
      const r = checkPlan(cwd, MID, SID);
      const a = readFileSync(writePlanCheck(cwd, MID, SID, r), "utf-8");
      const b = readFileSync(writePlanCheck(cwd, MID, SID, checkPlan(cwd, MID, SID)), "utf-8");
      assert.equal(stripTimestamp(a), stripTimestamp(b));
    });
  });
});
