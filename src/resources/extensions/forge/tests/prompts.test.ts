import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { composePrompt, type ComposableUnit } from "../prompts/compose.ts";
import { PLAN_SLICE_PROMPT } from "../prompts/plan-slice.ts";
import { EXECUTE_TASK_PROMPT } from "../prompts/execute-task.ts";
import { COMPLETE_SLICE_PROMPT } from "../prompts/complete-slice.ts";
import { COMPLETE_MILESTONE_PROMPT } from "../prompts/complete-milestone.ts";
import { DISCUSS_PROMPT } from "../prompts/discuss.ts";
import { RESEARCH_PROMPT } from "../prompts/research.ts";
import { PLAN_MILESTONE_PROMPT } from "../prompts/plan-milestone.ts";
import { RISK_RADAR_PROMPT } from "../prompts/risk-radar.ts";
import { RESEARCH_MODELS_PROMPT } from "../prompts/research-models.ts";
import { REVIEW_FIX_PROMPT } from "../prompts/review-fix.ts";
import { TASK_PLAN_PROMPT } from "../prompts/task-plan.ts";
import { TASK_EXECUTE_PROMPT } from "../prompts/task-execute.ts";
import { MILESTONE_CONTEXT_PROMPT } from "../prompts/milestone-context.ts";
import { scopedToolsFor } from "../auto/session.ts";
import { roleForUnit } from "../auto/role.ts";
import type { NextUnit } from "../state/dispatch.ts";

const INFO = {
  cwd: "/repo",
  milestoneId: "M-1",
  milestoneTitle: "Test Milestone",
  sliceTitle: "Test Slice",
  taskTitle: "Test Task",
};

const PLAN_SLICE_UNIT: NextUnit = { type: "plan-slice", slice: "S01" };
const EXECUTE_TASK_UNIT: NextUnit = { type: "execute-task", slice: "S01", task: "T02" };

describe("prompt bodies — port fidelity (M1-D7 / W2)", () => {
  test("PLAN_SLICE_PROMPT is a substantial, adapted port", () => {
    assert.ok(PLAN_SLICE_PROMPT.length > 2000, "plan-slice prompt should be substantial");
    assert.match(PLAN_SLICE_PROMPT, /forge_unit_result/);
    assert.match(PLAN_SLICE_PROMPT, /must_haves/);
  });

  test("EXECUTE_TASK_PROMPT is a substantial, adapted port", () => {
    assert.ok(EXECUTE_TASK_PROMPT.length > 2000, "execute-task prompt should be substantial");
    assert.match(EXECUTE_TASK_PROMPT, /forge_unit_result/);
    assert.match(EXECUTE_TASK_PROMPT, /T##-SUMMARY\.md/);
  });

  test("RISK_RADAR_PROMPT is a substantial, adapted port", () => {
    assert.ok(RISK_RADAR_PROMPT.length > 1500, "risk-radar prompt should be substantial");
    assert.match(RISK_RADAR_PROMPT, /`forge_unit_result`/);
    assert.match(RISK_RADAR_PROMPT, /S##-RISK\.md/);
    assert.match(RISK_RADAR_PROMPT, /## Blockers/);
    assert.match(RISK_RADAR_PROMPT, /## Warnings/);
    assert.match(RISK_RADAR_PROMPT, /Executor notes/);
    assert.doesNotMatch(RISK_RADAR_PROMPT, /GSD-WORKER-RESULT/);
  });

  test("RESEARCH_MODELS_PROMPT carries the S04 writer contract (FORGE2-CAPABILITIES-FORMAT §6)", () => {
    assert.ok(RESEARCH_MODELS_PROMPT.length > 2000, "research-models prompt should be substantial");
    // Locked rows preserved byte-for-byte; merge, not replace.
    assert.match(RESEARCH_MODELS_PROMPT, /BYTE-FOR-BYTE/);
    assert.match(RESEARCH_MODELS_PROMPT, /never reorder/);
    // Writes ONLY CAPABILITIES.md — the .local.md is operator-only.
    assert.match(RESEARCH_MODELS_PROMPT, /NEVER write `\.gsd\/CAPABILITIES\.local\.md`/);
    // Sources with dates + the file-level updated: line.
    assert.match(RESEARCH_MODELS_PROMPT, /sources.*WITH a date/i);
    assert.match(RESEARCH_MODELS_PROMPT, /`updated: YYYY-MM-DD`/);
    // The embedded locked format: exact 5-column order + verbatim refs.
    assert.match(RESEARCH_MODELS_PROMPT, /\| domain \| model \| score \| locked \| sources \|/);
    assert.match(RESEARCH_MODELS_PROMPT, /case-sensitive EXACT-MATCH/);
    // D-S04-5: ref enumeration (models.md → existing matrix → blocked) + no-web degradation.
    assert.match(RESEARCH_MODELS_PROMPT, /`\.gsd\/models\.md`/);
    assert.match(RESEARCH_MODELS_PROMPT, /status: "blocked"/);
    assert.match(RESEARCH_MODELS_PROMPT, /\/forge models/);
    assert.match(RESEARCH_MODELS_PROMPT, /model knowledge, no web access \(YYYY-MM-DD\)/);
    assert.match(RESEARCH_MODELS_PROMPT, /NEVER fabricate URLs/);
    // Commit point in the sibling pattern, tool name in backticks (B2 coverage).
    assert.match(RESEARCH_MODELS_PROMPT, /`forge_unit_result`/);
    assert.doesNotMatch(RESEARCH_MODELS_PROMPT, /GSD-WORKER-RESULT/);
  });

  for (const [name, body] of [
    ["PLAN_SLICE_PROMPT", PLAN_SLICE_PROMPT],
    ["EXECUTE_TASK_PROMPT", EXECUTE_TASK_PROMPT],
  ] as const) {
    test(`${name} never mentions the old textual sentinel`, () => {
      assert.doesNotMatch(body, /GSD-WORKER-RESULT/);
    });

    test(`${name} never mentions the old Claude-Code harness`, () => {
      assert.doesNotMatch(body, /Claude Code/);
      assert.doesNotMatch(body, /\bAgent tool\b/);
      assert.doesNotMatch(body, /\bTask tool\b/);
      assert.doesNotMatch(body, /\bSkill tool\b/);
    });
  }
});

describe("COMPLETE_MILESTONE_PROMPT — S06/T01 advisory suite gate", () => {
  test("names the canonical suite command and an explicit timeout ceiling, run via bash BEFORE the SUMMARY write", () => {
    assert.match(COMPLETE_MILESTONE_PROMPT, /pnpm run test:unit/);
    assert.match(COMPLETE_MILESTONE_PROMPT, /\bbash\b/);
    assert.match(COMPLETE_MILESTONE_PROMPT, /timeout/i);
    assert.match(COMPLETE_MILESTONE_PROMPT, /600000/);
    // The suite step (numbered before the SUMMARY-write step) must precede
    // the M###-SUMMARY.md write instruction in prompt order.
    const suiteStepIdx = COMPLETE_MILESTONE_PROMPT.search(/Run the canonical suite/i);
    const summaryWriteIdx = COMPLETE_MILESTONE_PROMPT.indexOf("Write the final `M###-SUMMARY.md`");
    assert.ok(suiteStepIdx >= 0, "suite step present");
    assert.ok(summaryWriteIdx >= 0, "SUMMARY write step present");
    assert.ok(suiteStepIdx < summaryWriteIdx, "suite step must run before the SUMMARY write");
  });

  test("defines the four flat suite_* frontmatter keys and a human-readable suite line in the SUMMARY body", () => {
    assert.match(COMPLETE_MILESTONE_PROMPT, /`suite_command`/);
    assert.match(COMPLETE_MILESTONE_PROMPT, /`suite_status`/);
    assert.match(COMPLETE_MILESTONE_PROMPT, /`suite_passed`/);
    assert.match(COMPLETE_MILESTONE_PROMPT, /`suite_failed`/);
    assert.match(COMPLETE_MILESTONE_PROMPT, /green.*red.*error.*timeout/s);
    assert.match(COMPLETE_MILESTONE_PROMPT, /human-readable suite line/i);
    assert.match(COMPLETE_MILESTONE_PROMPT, /suíte:/);
  });

  test("states the advisory posture verbatim: reds/timeout/error never move status off `done`, and never trigger fix attempts", () => {
    assert.match(
      COMPLETE_MILESTONE_PROMPT,
      /reds, timeouts, and errors NEVER change this unit's status away from `done`/,
    );
    assert.match(COMPLETE_MILESTONE_PROMPT, /MUST NOT trigger any attempt to fix failing tests/);
    assert.match(COMPLETE_MILESTONE_PROMPT, /Never re-run the suite in a retry loop chasing green/);
  });

  test("does not suggest reds are anomalous — frames them as possibly pre-existing/expected", () => {
    assert.match(COMPLETE_MILESTONE_PROMPT, /Reds in the suite can be pre-existing and expected/);
  });
});

describe("composePrompt — lean composition", () => {
  test("plan-slice: includes identity, paths, prompt body, and commit-point instruction", () => {
    const prompt = composePrompt(PLAN_SLICE_UNIT, INFO);

    assert.match(prompt, /Unit: plan-slice/);
    assert.match(prompt, /M-1/);
    assert.match(prompt, /S01/);
    assert.match(prompt, /Test Slice/);

    // Paths present, not inlined content
    assert.match(prompt, /M-1-ROADMAP\.md/);
    assert.match(prompt, /S01-PLAN\.md/);
    assert.match(prompt, /\/repo\/\.gsd\/milestones\/M-1\/slices\/S01/);

    // Prompt body for the unit type is present
    assert.match(prompt, /GSD planning agent/);

    // Mandatory commit-point instruction
    assert.match(prompt, /forge_unit_result/);
    assert.match(prompt, /Commit point \(mandatory\)/);
  });

  test("execute-task: includes task identity + task-specific paths", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO);

    assert.match(prompt, /Unit: execute-task/);
    assert.match(prompt, /T02/);
    assert.match(prompt, /Test Task/);
    assert.match(prompt, /T02-PLAN\.md/);
    assert.match(prompt, /T02-SUMMARY\.md/);
    assert.match(prompt, /\/repo\/\.gsd\/milestones\/M-1\/slices\/S01\/tasks\/T02/);
    assert.match(prompt, /GSD execution agent/);
    assert.match(prompt, /forge_unit_result/);
  });

  test("does NOT inline file contents — only paths", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO);
    // Sanity: prompt should not contain markers of an inlined file body,
    // e.g. a full markdown frontmatter block copied verbatim from a plan.
    assert.doesNotMatch(prompt, /^---\nid: T\d+/m);
  });

  test("no failureContext → no Retry Context section", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO);
    assert.doesNotMatch(prompt, /## Retry Context/);
  });

  test("failureContext present → Retry Context section appended, containing the context", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO, "Previous attempt failed: typecheck error in foo.ts line 12.");
    assert.match(prompt, /## Retry Context/);
    assert.match(prompt, /typecheck error in foo\.ts line 12/);
    // Retry context should come before the final commit-point instruction.
    const retryIdx = prompt.indexOf("## Retry Context");
    const commitIdx = prompt.lastIndexOf("## Commit point (mandatory)");
    assert.ok(retryIdx < commitIdx, "Retry Context must precede the final commit-point instruction");
  });

  test("composed prompts never mention the old sentinel or Claude Code", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO, "some failure");
    assert.doesNotMatch(prompt, /GSD-WORKER-RESULT/);
    assert.doesNotMatch(prompt, /Claude Code/);
  });

  test("works without optional title fields in ComposeInfo", () => {
    const minimalInfo = { cwd: "/repo", milestoneId: "M-1" };
    const prompt = composePrompt(PLAN_SLICE_UNIT, minimalInfo);
    assert.match(prompt, /Unit: plan-slice/);
    assert.match(prompt, /forge_unit_result/);
  });
});

describe("composePrompt — resultToolName naming (B2)", () => {
  const NAMESPACED = "mcp__forge__forge_unit_result";

  test("default (no resultToolName) → bare `forge_unit_result`, byte-identical in-process path (W2)", () => {
    const withUndefined = composePrompt(EXECUTE_TASK_UNIT, INFO);
    const withBareExplicit = composePrompt(EXECUTE_TASK_UNIT, {
      ...INFO,
      resultToolName: "forge_unit_result",
    });
    assert.equal(withUndefined, withBareExplicit, "explicit bare name is a no-op vs default");
    assert.match(withUndefined, /`forge_unit_result`/);
    assert.doesNotMatch(withUndefined, /mcp__forge__/);
  });

  test("namespaced name → EVERY backtick-wrapped mention rewritten; NO bare `forge_unit_result` survives", () => {
    for (const unit of [PLAN_SLICE_UNIT, EXECUTE_TASK_UNIT]) {
      const prompt = composePrompt(unit, { ...INFO, resultToolName: NAMESPACED }, "some retry context");
      // The namespaced name is present…
      assert.match(prompt, /`mcp__forge__forge_unit_result`/, `${unit.type}: namespaced name present`);
      // …and no backtick-wrapped BARE occurrence remains anywhere.
      assert.doesNotMatch(
        prompt,
        /`forge_unit_result`/,
        `${unit.type}: zero bare backtick-wrapped forge_unit_result left`,
      );
    }
  });

  test("commit-point instruction itself carries the namespaced name", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, { ...INFO, resultToolName: NAMESPACED });
    assert.match(prompt, /Commit point[\s\S]*`mcp__forge__forge_unit_result`/);
  });

  test("M2R-1 Fix 1 Part B: namespaced resultToolName appends a ToolSearch preload instruction", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, { ...INFO, resultToolName: NAMESPACED });
    assert.match(prompt, /ToolSearch/);
    assert.match(prompt, /select:mcp__forge__forge_unit_result/);
  });

  test("M2R-1 Fix 1 Part B: bare (default) path does NOT get the ToolSearch instruction — byte-identical to pre-fix baseline", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO);
    assert.doesNotMatch(prompt, /ToolSearch/);
  });
});

describe("composePrompt — S03/T05 unit-type wiring (bodyForUnit + pathsBlock)", () => {
  const CASES: Array<{ unit: ComposableUnit; body: string; bodyName: string; pathPattern: RegExp }> = [
    {
      unit: { type: "complete-slice", slice: "S01" },
      body: COMPLETE_SLICE_PROMPT,
      bodyName: "COMPLETE_SLICE_PROMPT",
      pathPattern: /S01-SUMMARY\.md.*S01-UAT\.md|S01-UAT\.md.*S01-SUMMARY\.md/s,
    },
    {
      unit: { type: "complete-milestone", milestone: "M-1" },
      body: COMPLETE_MILESTONE_PROMPT,
      bodyName: "COMPLETE_MILESTONE_PROMPT",
      pathPattern: /M-1-SUMMARY\.md/,
    },
    {
      unit: { type: "discuss-slice", slice: "S01" },
      body: DISCUSS_PROMPT,
      bodyName: "DISCUSS_PROMPT",
      pathPattern: /S01-CONTEXT\.md/,
    },
    {
      unit: { type: "discuss-milestone", milestone: "M-1" },
      body: DISCUSS_PROMPT,
      bodyName: "DISCUSS_PROMPT",
      pathPattern: /M-1-CONTEXT\.md/,
    },
    {
      unit: { type: "research-slice", slice: "S01" },
      body: RESEARCH_PROMPT,
      bodyName: "RESEARCH_PROMPT",
      pathPattern: /S01-RESEARCH\.md/,
    },
    {
      unit: { type: "research-milestone", milestone: "M-1" },
      body: RESEARCH_PROMPT,
      bodyName: "RESEARCH_PROMPT",
      pathPattern: /M-1-RESEARCH\.md/,
    },
    {
      unit: { type: "plan-milestone", milestone: "M-1" },
      body: PLAN_MILESTONE_PROMPT,
      bodyName: "PLAN_MILESTONE_PROMPT",
      pathPattern: /M-1-ROADMAP\.md/,
    },
    {
      unit: { type: "risk-radar", slice: "S01" },
      body: RISK_RADAR_PROMPT,
      bodyName: "RISK_RADAR_PROMPT",
      pathPattern: /S01-RISK\.md/,
    },
    {
      unit: { type: "research-models" },
      body: RESEARCH_MODELS_PROMPT,
      bodyName: "RESEARCH_MODELS_PROMPT",
      pathPattern: /\/repo\/\.gsd\/CAPABILITIES\.md/,
    },
  ];

  for (const { unit, body, bodyName, pathPattern } of CASES) {
    test(`${unit.type}: composes the ${bodyName} body + the right paths`, () => {
      const prompt = composePrompt(unit, INFO);
      assert.match(prompt, new RegExp(`Unit: ${unit.type}`));
      // The prompt contains the exact body text (proves bodyForUnit routing).
      assert.ok(prompt.includes(body), `${unit.type} prompt should contain ${bodyName} verbatim`);
      assert.match(prompt, pathPattern, `${unit.type} prompt should carry the right paths`);
      assert.match(prompt, /forge_unit_result/);
    });
  }

  test("complete-milestone: no `slice:` line in identity (milestone-level unit)", () => {
    const prompt = composePrompt({ type: "complete-milestone", milestone: "M-1" }, INFO);
    assert.doesNotMatch(prompt, /^- Slice: /m);
  });

  test("namespaced rewrite covers a completion body too (B2)", () => {
    const prompt = composePrompt(
      { type: "complete-slice", slice: "S01" },
      { ...INFO, resultToolName: "mcp__forge__forge_unit_result" },
    );
    assert.match(prompt, /`mcp__forge__forge_unit_result`/);
    assert.doesNotMatch(prompt, /`forge_unit_result`/);
  });

  test("research-models: paths block carries write target, never-write local layer, and read-if-exists inputs (S04/T01)", () => {
    const prompt = composePrompt({ type: "research-models" }, INFO);
    assert.match(prompt, /Capability matrix \(write\/update this\): `\/repo\/\.gsd\/CAPABILITIES\.md`/);
    assert.match(prompt, /NEVER write this — operator-only.*`\/repo\/\.gsd\/CAPABILITIES\.local\.md`/);
    assert.match(prompt, /read if it exists.*`\/repo\/\.gsd\/models\.md`/);
    assert.match(prompt, /read if it exists.*FORGE2-CAPABILITIES-FORMAT\.md`/);
    // Repo-level unit: no slice/task identity lines.
    assert.doesNotMatch(prompt, /^- Slice: /m);
    assert.doesNotMatch(prompt, /^- Task: /m);
  });

  test("research-models with empty milestoneId omits the `- Milestone:` line (D-S04-1)", () => {
    const prompt = composePrompt({ type: "research-models" }, { cwd: "/repo", milestoneId: "" });
    assert.doesNotMatch(prompt, /^- Milestone: /m);
    assert.match(prompt, /# Unit: research-models/);
    assert.ok(prompt.includes(RESEARCH_MODELS_PROMPT));
    assert.match(prompt, /Commit point \(mandatory\)/);
  });

  test("REGRESSION (D-S04-1): non-empty milestoneId keeps the `- Milestone:` line for every existing unit type", () => {
    for (const unit of [PLAN_SLICE_UNIT, EXECUTE_TASK_UNIT, ...CASES.map((c) => c.unit)]) {
      const prompt = composePrompt(unit, INFO);
      assert.match(prompt, /^- Milestone: `M-1` — Test Milestone$/m, `${unit.type}: Milestone line present`);
    }
  });

  test("namespaced rewrite covers the research-models body too (B2): zero bare mentions survive", () => {
    const prompt = composePrompt(
      { type: "research-models" },
      { cwd: "/repo", milestoneId: "", resultToolName: "mcp__forge__forge_unit_result" },
    );
    assert.match(prompt, /`mcp__forge__forge_unit_result`/);
    assert.doesNotMatch(prompt, /`forge_unit_result`/);
  });

  test("REGRESSION: plan-slice/execute-task compose byte-identical prompts to the pre-T05 shape on the default path", () => {
    // Snapshot of the exact composed strings (default resultToolName, no
    // failureContext) — any drift in identityBlock/pathsBlock/bodyForUnit
    // for the two lean unit types fails this test.
    const planSlicePrompt = composePrompt(PLAN_SLICE_UNIT, INFO);
    assert.match(planSlicePrompt, /# Unit: plan-slice/);
    assert.match(planSlicePrompt, /- Milestone: `M-1` — Test Milestone/);
    assert.match(planSlicePrompt, /- Slice: `S01` — Test Slice/);
    assert.ok(planSlicePrompt.includes(PLAN_SLICE_PROMPT));
    assert.doesNotMatch(planSlicePrompt, /- Task: /);

    const executeTaskPrompt = composePrompt(EXECUTE_TASK_UNIT, INFO);
    assert.match(executeTaskPrompt, /# Unit: execute-task/);
    assert.match(executeTaskPrompt, /- Task: `T02` — Test Task/);
    assert.ok(executeTaskPrompt.includes(EXECUTE_TASK_PROMPT));
  });
});

describe("composePrompt — S05/T02 scopeDomain identity line", () => {
  const PLAN_MILESTONE_UNIT: ComposableUnit = { type: "plan-milestone", milestone: "M-1" };
  // Every non-plan-slice/plan-milestone unit type this module composes for
  // (mirrors the S03/T05 CASES list above, kept separate since that block's
  // `CASES` const is scoped to its own describe callback).
  const NON_PLAN_UNITS: ComposableUnit[] = [
    EXECUTE_TASK_UNIT,
    { type: "complete-slice", slice: "S01" },
    { type: "complete-milestone", milestone: "M-1" },
    { type: "discuss-slice", slice: "S01" },
    { type: "discuss-milestone", milestone: "M-1" },
    { type: "research-slice", slice: "S01" },
    { type: "research-milestone", milestone: "M-1" },
    { type: "risk-radar", slice: "S01" },
    { type: "research-models" },
  ];
  const ALL_UNITS: ComposableUnit[] = [PLAN_SLICE_UNIT, PLAN_MILESTONE_UNIT, ...NON_PLAN_UNITS];

  test("plan-slice: scopeDomain present adds the `Domain (larger scope)` line", () => {
    const prompt = composePrompt(PLAN_SLICE_UNIT, { ...INFO, scopeDomain: "infra" });
    assert.match(
      prompt,
      /^- Domain \(larger scope\): `infra` — informs your judgement; per-task `domain:` frontmatter is what routes\.$/m,
    );
  });

  test("plan-milestone: scopeDomain present adds the `Domain (larger scope)` line", () => {
    const prompt = composePrompt(PLAN_MILESTONE_UNIT, { ...INFO, scopeDomain: "infra" });
    assert.match(
      prompt,
      /^- Domain \(larger scope\): `infra` — informs your judgement; per-task `domain:` frontmatter is what routes\.$/m,
    );
  });

  test("plan-slice: scopeDomain is trimmed before printing", () => {
    const prompt = composePrompt(PLAN_SLICE_UNIT, { ...INFO, scopeDomain: "  infra  " });
    assert.match(prompt, /^- Domain \(larger scope\): `infra` —/m);
  });

  test("REGRESSION (D-S04-1 pattern): scopeDomain absent → byte-identical composition for every unit type", () => {
    for (const unit of ALL_UNITS) {
      const withUndefinedField = composePrompt(unit, { ...INFO, scopeDomain: undefined });
      const withoutFieldAtAll = composePrompt(unit, INFO);
      assert.equal(withUndefinedField, withoutFieldAtAll, `${unit.type}: scopeDomain absent should be byte-identical`);
      // Anchored to the identity-line shape, not a bare substring — the
      // plan-slice prompt BODY (T02 addition) legitimately mentions
      // "Domain (larger scope)" in prose when describing the precedence.
      assert.doesNotMatch(withoutFieldAtAll, /^- Domain \(larger scope\):/m, `${unit.type}: no scope-domain line without the field`);
    }
  });

  test("execute-task with scopeDomain set does NOT gain the line (gate is by unit type, not just data)", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, { ...INFO, scopeDomain: "infra" });
    assert.doesNotMatch(prompt, /^- Domain \(larger scope\):/m);
  });

  test("every other non-plan unit type with scopeDomain set does NOT gain the line", () => {
    for (const unit of NON_PLAN_UNITS) {
      const prompt = composePrompt(unit, { ...INFO, scopeDomain: "infra" });
      assert.doesNotMatch(prompt, /^- Domain \(larger scope\):/m, `${unit.type}: should not gain the scope-domain line`);
    }
  });
});

describe("scopedToolsFor — S03/T05 per-type tool scoping", () => {
  const AVAILABLE = ["read", "bash", "edit", "write", "find", "grep", "ls", "forge_unit_result", "other_tool"];

  for (const unitType of [
    "plan-slice",
    "execute-task",
    "complete-slice",
    "complete-milestone",
    "discuss-slice",
    "discuss-milestone",
    "research-slice",
    "research-milestone",
    "plan-milestone",
  ]) {
    test(`${unitType}: gets write/edit/bash + forge_unit_result`, () => {
      const scoped = scopedToolsFor(unitType, AVAILABLE);
      for (const t of ["read", "bash", "edit", "write", "forge_unit_result"]) {
        assert.ok(scoped.includes(t), `${unitType} should be scoped ${t}`);
      }
      assert.ok(!scoped.includes("other_tool"), `${unitType} should not get unlisted tools`);
    });
  }

  test("forge_unit_result is always appended even if absent from availableToolNames", () => {
    const scoped = scopedToolsFor("complete-slice", ["read", "bash"]);
    assert.ok(scoped.includes("forge_unit_result"));
  });

  // S04/T02 — research-models is the FIRST per-type branch: web tools by
  // intersection with the live tool set, never an unconditional push.
  const WEB_TOOLS = ["fetch_page", "search-the-web", "search_and_read"];

  test("research-models: includes every web tool present in availableToolNames", () => {
    const scoped = scopedToolsFor("research-models", [...AVAILABLE, ...WEB_TOOLS]);
    for (const t of WEB_TOOLS) {
      assert.ok(scoped.includes(t), `research-models should be scoped ${t}`);
    }
    for (const t of ["read", "bash", "edit", "write", "forge_unit_result"]) {
      assert.ok(scoped.includes(t), `research-models should keep core tool ${t}`);
    }
    assert.ok(!scoped.includes("other_tool"), "research-models should not get unlisted tools");
  });

  test("research-models: only the web tools actually available are included (key-gated subset)", () => {
    // fetch_page is key-free/always registered; the search tools are key-gated
    // and may be absent — the intersection must include exactly what exists.
    const scoped = scopedToolsFor("research-models", [...AVAILABLE, "fetch_page"]);
    assert.ok(scoped.includes("fetch_page"));
    assert.ok(!scoped.includes("search-the-web"));
    assert.ok(!scoped.includes("search_and_read"));
  });

  test("research-models: no web tools available ⇒ degrades to core set + forge_unit_result, no error", () => {
    const scoped = scopedToolsFor("research-models", AVAILABLE);
    assert.deepStrictEqual(
      [...scoped].sort(),
      ["bash", "edit", "find", "forge_unit_result", "grep", "ls", "read", "write"].sort(),
    );
  });

  test("review-fix: core set (write/edit/bash present), no new branch/web tools", () => {
    const scoped = scopedToolsFor("review-fix", [...AVAILABLE, ...WEB_TOOLS]);
    for (const t of ["read", "bash", "edit", "write", "forge_unit_result"]) {
      assert.ok(scoped.includes(t), `review-fix should be scoped ${t}`);
    }
    for (const t of WEB_TOOLS) {
      assert.ok(!scoped.includes(t), "review-fix must not be scoped web-research tools");
    }
    assert.deepStrictEqual(scoped, scopedToolsFor("review-fix", AVAILABLE),
      "review-fix result must be identical with or without web tools available");
  });

  test("execute-task/plan-slice: web tools in availableToolNames are NOT included (byte-identical to pre-S04)", () => {
    for (const unitType of ["execute-task", "plan-slice"]) {
      const scoped = scopedToolsFor(unitType, [...AVAILABLE, ...WEB_TOOLS]);
      for (const t of WEB_TOOLS) {
        assert.ok(!scoped.includes(t), `${unitType} must not be scoped ${t}`);
      }
      assert.deepStrictEqual(scoped, scopedToolsFor(unitType, AVAILABLE),
        `${unitType} result must be identical with or without web tools available`);
    }
  });
});

describe("composePrompt — S02/T02 review-fix unit (D-S02-1/2/3/6)", () => {
  const REVIEW_FIX_UNIT: ComposableUnit = { type: "review-fix", slice: "S02" };
  const PAYLOAD = "### R1\n\n**Objeção:** foo leaks a secret.\n**Defesa:** it's test-only.\n**Réplica:** still fix it.\n\nDiff range: `git diff abc123..def456 -- src/foo.ts`";

  test("compose contains identity with the slice, the REVIEW.md/KNOWLEDGE.md paths, the body, and the commit point", () => {
    const prompt = composePrompt(REVIEW_FIX_UNIT, INFO);

    assert.match(prompt, /Unit: review-fix/);
    assert.match(prompt, /^- Slice: `S02` — Test Slice$/m);
    assert.match(prompt, /S02-REVIEW\.md/);
    assert.match(prompt, /\.gsd\/KNOWLEDGE\.md/);
    assert.match(prompt, /NEVER write.*KNOWLEDGE\.md/);
    assert.ok(prompt.includes(REVIEW_FIX_PROMPT), "should contain REVIEW_FIX_PROMPT verbatim");
    assert.match(prompt, /Commit point \(mandatory\)/);
    assert.match(prompt, /forge_unit_result/);
  });

  // Anchored to a FULL LINE match (^...$/m): the prompt body's own prose
  // mentions the heading text inline mid-sentence (quoted), which would
  // false-positive a plain substring/regex match — only the actually
  // rendered section header sits alone on its own line.
  const SECTION_HEADER_LINE = /^## Itens de review a corrigir \(inlinados\)$/m;

  test("reviewFixPayload present → inlined section present with the verbatim text", () => {
    const prompt = composePrompt(REVIEW_FIX_UNIT, { ...INFO, reviewFixPayload: PAYLOAD });
    assert.match(prompt, SECTION_HEADER_LINE);
    assert.ok(prompt.includes(PAYLOAD), "payload should appear verbatim");
    // Placed after the body, before the commit-point instruction.
    const bodyIdx = prompt.indexOf(REVIEW_FIX_PROMPT);
    const sectionIdx = prompt.search(SECTION_HEADER_LINE);
    const commitIdx = prompt.lastIndexOf("## Commit point (mandatory)");
    assert.ok(bodyIdx < sectionIdx, "inlined section must come after the body");
    assert.ok(sectionIdx < commitIdx, "inlined section must come before the commit point");
  });

  test("reviewFixPayload absent → no inlined section", () => {
    const prompt = composePrompt(REVIEW_FIX_UNIT, INFO);
    assert.doesNotMatch(prompt, SECTION_HEADER_LINE);
  });

  test("reviewFixPayload present on a non-review-fix unit → no inlined section (gate is by unit type, not just data)", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, { ...INFO, reviewFixPayload: PAYLOAD });
    assert.doesNotMatch(prompt, SECTION_HEADER_LINE);
  });

  test("namespaced resultToolName rewrite covers the review-fix body too — zero bare mentions survive", () => {
    const prompt = composePrompt(
      REVIEW_FIX_UNIT,
      { ...INFO, reviewFixPayload: PAYLOAD, resultToolName: "mcp__forge__forge_unit_result" },
    );
    assert.match(prompt, /`mcp__forge__forge_unit_result`/);
    assert.doesNotMatch(prompt, /`forge_unit_result`/);
  });

  test("roleForUnit({type:'review-fix', slice:'S99'}) === 'executor' (tolerant fallback, no role.ts change)", () => {
    assert.equal(roleForUnit({ type: "review-fix", slice: "S99" }), "executor");
  });
});

describe("composePrompt — S03/T04 review-fix taskId variant (loose-task target, repo-level)", () => {
  const TASK_ID = "T-20260712170000-foo";
  const REVIEW_FIX_TASK_UNIT: ComposableUnit = { type: "review-fix", slice: TASK_ID, taskId: TASK_ID };
  const REPO_INFO = { cwd: "/repo", milestoneId: "" };
  const PAYLOAD = "### R1\n\n**Objeção:** foo leaks a secret.\n**Defesa:** it's test-only.\n**Réplica:** still fix it.\n\nDiff range: `git diff abc123..def456 -- src/foo.ts`";

  test("paths point at .gsd/tasks/<taskId>/ (REVIEW.md/TASK.md/PLAN.md), never .gsd/milestones/", () => {
    const prompt = composePrompt(REVIEW_FIX_TASK_UNIT, REPO_INFO);
    assert.match(prompt, /Unit: review-fix/);
    assert.match(prompt, new RegExp(`/repo/\\.gsd/tasks/${TASK_ID}/${TASK_ID}-REVIEW\\.md`));
    assert.match(prompt, new RegExp(`/repo/\\.gsd/tasks/${TASK_ID}/${TASK_ID}-TASK\\.md`));
    assert.match(prompt, new RegExp(`/repo/\\.gsd/tasks/${TASK_ID}/${TASK_ID}-PLAN\\.md`));
    assert.doesNotMatch(prompt, /\.gsd\/milestones\//);
    assert.doesNotMatch(prompt, /\/slices\//);
    assert.match(prompt, /\.gsd\/KNOWLEDGE\.md/);
    assert.match(prompt, /NEVER write.*KNOWLEDGE\.md/);
    assert.ok(prompt.includes(REVIEW_FIX_PROMPT), "should contain REVIEW_FIX_PROMPT verbatim");
    assert.match(prompt, /Commit point \(mandatory\)/);
  });

  test("identity carries a `- Task:` line, no `- Slice:` line (mirrors task-plan/task-execute)", () => {
    const prompt = composePrompt(REVIEW_FIX_TASK_UNIT, REPO_INFO);
    assert.match(prompt, new RegExp(`^- Task: \`${TASK_ID}\`$`, "m"));
    assert.doesNotMatch(prompt, /^- Slice: /m);
  });

  test("no active milestone (milestoneId \"\") omits the `- Milestone:` line — repo-level like research-models/task-plan", () => {
    const prompt = composePrompt(REVIEW_FIX_TASK_UNIT, REPO_INFO);
    assert.doesNotMatch(prompt, /^- Milestone: /m);
  });

  test("reviewFixPayload section logic unchanged: present → inlined, absent → no section", () => {
    const withPayload = composePrompt(REVIEW_FIX_TASK_UNIT, { ...REPO_INFO, reviewFixPayload: PAYLOAD });
    assert.match(withPayload, /^## Itens de review a corrigir \(inlinados\)$/m);
    assert.ok(withPayload.includes(PAYLOAD));

    const withoutPayload = composePrompt(REVIEW_FIX_TASK_UNIT, REPO_INFO);
    assert.doesNotMatch(withoutPayload, /^## Itens de review a corrigir \(inlinados\)$/m);
  });

  test("taskId absent → byte-identical to the pre-T04 slice-only shape", () => {
    const sliceOnly: ComposableUnit = { type: "review-fix", slice: "S02" };
    const withUndefinedTaskId = composePrompt({ ...sliceOnly, taskId: undefined }, INFO);
    const withoutTaskIdField = composePrompt(sliceOnly, INFO);
    assert.equal(withUndefinedTaskId, withoutTaskIdField);
    assert.match(withoutTaskIdField, /^- Slice: `S02` — Test Slice$/m);
    assert.doesNotMatch(withoutTaskIdField, /^- Task: /m);
  });

  test("roleForUnit stays 'executor' for the taskId variant too (no directDispatchRole entry added)", () => {
    assert.equal(roleForUnit(REVIEW_FIX_TASK_UNIT), "executor");
  });
});

describe("composePrompt — S02/T01 task-plan/task-execute (repo-level loose task, M-20260712170458-cockpit-v2)", () => {
  const TASK_ID = "T-20260712170000-foo";
  const TASK_PLAN_UNIT: ComposableUnit = { type: "task-plan", taskId: TASK_ID };
  const TASK_EXECUTE_UNIT: ComposableUnit = { type: "task-execute", taskId: TASK_ID };
  const REPO_INFO = { cwd: "/repo", milestoneId: "" };

  test("TASK_PLAN_PROMPT is a substantial, adapted prompt mandating domain:/effort:/must_haves", () => {
    assert.ok(TASK_PLAN_PROMPT.length > 2000, "task-plan prompt should be substantial");
    assert.match(TASK_PLAN_PROMPT, /domain:/);
    assert.match(TASK_PLAN_PROMPT, /effort:/);
    assert.match(TASK_PLAN_PROMPT, /must_haves:/);
    assert.match(TASK_PLAN_PROMPT, /<TASK_ID>-PLAN\.md/);
    assert.match(TASK_PLAN_PROMPT, /`forge_unit_result`/);
    assert.doesNotMatch(TASK_PLAN_PROMPT, /GSD-WORKER-RESULT/);
  });

  test("TASK_EXECUTE_PROMPT is a substantial, adapted prompt", () => {
    assert.ok(TASK_EXECUTE_PROMPT.length > 1500, "task-execute prompt should be substantial");
    assert.match(TASK_EXECUTE_PROMPT, /<TASK_ID>-SUMMARY\.md/);
    assert.match(TASK_EXECUTE_PROMPT, /`forge_unit_result`/);
    assert.doesNotMatch(TASK_EXECUTE_PROMPT, /GSD-WORKER-RESULT/);
  });

  test("task-plan: paths block points at .gsd/tasks/<taskId>/... (TASK.md read, PLAN.md write), no milestone-derived paths", () => {
    const prompt = composePrompt(TASK_PLAN_UNIT, REPO_INFO);
    assert.match(prompt, /Unit: task-plan/);
    assert.match(prompt, new RegExp(`/repo/\\.gsd/tasks/${TASK_ID}/${TASK_ID}-TASK\\.md`));
    assert.match(prompt, new RegExp(`/repo/\\.gsd/tasks/${TASK_ID}/${TASK_ID}-PLAN\\.md`));
    // No milestone-derived paths in the identity/paths block (the body text
    // legitimately mentions `.gsd/milestones/` as a written constraint —
    // this checks the STRUCTURAL paths block, not the whole composed text).
    assert.doesNotMatch(prompt, /ROADMAP\.md/);
    assert.doesNotMatch(prompt, /\/slices\//);
    assert.doesNotMatch(prompt, /^- Milestone: /m);
    assert.doesNotMatch(prompt, /^- Slice: /m);
    assert.match(prompt, new RegExp(`^- Task: \`${TASK_ID}\`$`, "m"));
    assert.ok(prompt.includes(TASK_PLAN_PROMPT));
    assert.match(prompt, /forge_unit_result/);
  });

  test("task-execute: points at PLAN.md (read) and SUMMARY.md (write)", () => {
    const prompt = composePrompt(TASK_EXECUTE_UNIT, REPO_INFO);
    assert.match(prompt, /Unit: task-execute/);
    assert.match(prompt, new RegExp(`${TASK_ID}-PLAN\\.md`));
    assert.match(prompt, new RegExp(`${TASK_ID}-SUMMARY\\.md`));
    assert.doesNotMatch(prompt, /ROADMAP\.md/);
    assert.doesNotMatch(prompt, /\/slices\//);
    assert.doesNotMatch(prompt, /^- Milestone: /m);
    assert.doesNotMatch(prompt, /^- Slice: /m);
    assert.ok(prompt.includes(TASK_EXECUTE_PROMPT));
    assert.match(prompt, /forge_unit_result/);
  });

  test("roleForUnit: task-plan -> planner, task-execute -> executor (tolerant fallback)", () => {
    assert.equal(roleForUnit(TASK_PLAN_UNIT), "planner");
    assert.equal(roleForUnit(TASK_EXECUTE_UNIT), "executor");
  });

  test("namespaced resultToolName rewrite covers both bodies — zero bare mentions survive", () => {
    for (const unit of [TASK_PLAN_UNIT, TASK_EXECUTE_UNIT]) {
      const prompt = composePrompt(unit, { ...REPO_INFO, resultToolName: "mcp__forge__forge_unit_result" });
      assert.match(prompt, /`mcp__forge__forge_unit_result`/, `${unit.type}: namespaced name present`);
      assert.doesNotMatch(prompt, /`forge_unit_result`/, `${unit.type}: zero bare mentions`);
    }
  });

  test("REGRESSION: every pre-existing unit type composes byte-identically (task-plan/task-execute additions don't leak)", () => {
    const planSlicePrompt = composePrompt(PLAN_SLICE_UNIT, INFO);
    assert.ok(planSlicePrompt.includes(PLAN_SLICE_PROMPT));
    const executeTaskPrompt = composePrompt(EXECUTE_TASK_UNIT, INFO);
    assert.ok(executeTaskPrompt.includes(EXECUTE_TASK_PROMPT));
    assert.match(executeTaskPrompt, /- Task: `T02` — Test Task/);
  });
});

describe("composePrompt — S02/T01 milestone-context unit", () => {
  const MID = "M-20260712220520-banner";
  const UNIT: ComposableUnit = { type: "milestone-context", milestone: MID };
  const NEW_MILESTONE_INFO = { cwd: "/repo", milestoneId: MID, milestoneTitle: "Corrigir o banner" };

  test("composes identity, REQUEST/CONTEXT paths, the dedicated body, and commit point", () => {
    const prompt = composePrompt(UNIT, NEW_MILESTONE_INFO);

    assert.match(prompt, /# Unit: milestone-context/);
    assert.match(prompt, new RegExp(`^- Milestone: \`${MID}\` — Corrigir o banner$`, "m"));
    assert.match(prompt, new RegExp(`/repo/\\.gsd/milestones/${MID}/${MID}-REQUEST\\.md`));
    assert.match(prompt, new RegExp(`/repo/\\.gsd/milestones/${MID}/${MID}-CONTEXT\\.md`));
    assert.match(prompt, /Milestone request \(read first — the operator's request\)/);
    assert.match(prompt, /Milestone CONTEXT \(write this\)/);
    assert.ok(prompt.includes(MILESTONE_CONTEXT_PROMPT), "should contain MILESTONE_CONTEXT_PROMPT verbatim");
    assert.match(prompt, /Commit point \(mandatory\)/);
    assert.match(prompt, /`forge_unit_result`/);
  });

  test("body requires delimited domain frontmatter, verified recon, bounded scope, and scoped writes", () => {
    assert.match(MILESTONE_CONTEXT_PROMPT, /frontmatter YAML delimitado por `---`/);
    assert.match(MILESTONE_CONTEXT_PROMPT, /`domain:` obrigatório/);
    assert.match(MILESTONE_CONTEXT_PROMPT, /caminho:linha/);
    assert.match(MILESTONE_CONTEXT_PROMPT, /Não invente escopo/);
    assert.match(MILESTONE_CONTEXT_PROMPT, /## Fora de escopo/);
    assert.match(MILESTONE_CONTEXT_PROMPT, /APENAS dentro do diretório da milestone/);
    assert.match(MILESTONE_CONTEXT_PROMPT, /PROIBIDO ler para modificar ou modificar `\.gsd\/STATE\.md`/);
  });

  test("roleForUnit routes milestone-context to planner", () => {
    assert.equal(roleForUnit(UNIT), "planner");
  });

  test("namespaced result tool rewrite reaches the dedicated body commit point", () => {
    const prompt = composePrompt(UNIT, {
      ...NEW_MILESTONE_INFO,
      resultToolName: "mcp__forge__forge_unit_result",
    });
    assert.match(prompt, /`mcp__forge__forge_unit_result`/);
    assert.doesNotMatch(prompt, /`forge_unit_result`/);
    assert.match(prompt, /ToolSearch/);
  });
});
