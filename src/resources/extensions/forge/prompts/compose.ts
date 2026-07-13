/**
 * `composePrompt` — the lean prompt compositor for the S03 dispatch loop.
 *
 * LEAN by design (D-prompt of the ROADMAP, S03-PLAN § T02 step 4): this
 * module never inlines file contents. It only assembles the unit's
 * identity, the absolute/relative PATHS of the artifacts the worker needs
 * (ROADMAP, S##-PLAN.md, T##-PLAN.md, the SUMMARYs directory), the prompt
 * body for the unit's type (imported from the per-type prompt modules), an
 * optional `## Retry Context` section (B4 — consumed by the T04 retry
 * re-dispatch), and the final instruction to emit `forge_unit_result` as
 * the worker's last action. The worker reads everything else itself, via
 * its own `read`/`bash` tools.
 *
 * Layout note (RESEARCH Pitfall 2): the REAL on-disk layout is
 * `.gsd/milestones/<mid>/slices/S##/tasks/T##/` — never the legacy
 * `phases/` shape from the old GSD-WORKFLOW.
 */

import { join } from "node:path";
import type { NextUnit } from "../state/index.js";
import { PLAN_SLICE_PROMPT } from "./plan-slice.js";
import { EXECUTE_TASK_PROMPT } from "./execute-task.js";
import { COMPLETE_SLICE_PROMPT } from "./complete-slice.js";
import { COMPLETE_MILESTONE_PROMPT } from "./complete-milestone.js";
import { DISCUSS_PROMPT } from "./discuss.js";
import { RESEARCH_PROMPT } from "./research.js";
import { PLAN_MILESTONE_PROMPT } from "./plan-milestone.js";
import { RISK_RADAR_PROMPT } from "./risk-radar.js";
import { RESEARCH_MODELS_PROMPT } from "./research-models.js";
import { REVIEW_FIX_PROMPT } from "./review-fix.js";
import { TASK_PLAN_PROMPT } from "./task-plan.js";
import { TASK_EXECUTE_PROMPT } from "./task-execute.js";
import { MILESTONE_CONTEXT_PROMPT } from "./milestone-context.js";

/**
 * The full set of unit types `composePrompt` can compose a body for — a
 * SUPERSET of `NextUnit` (the `deriveNextUnit`/S03 auto-loop dispatch
 * table, `state/dispatch.ts`). `discuss-slice`/`discuss-milestone`/
 * `research-slice`/`research-milestone`/`plan-milestone` are dispatchable
 * THROUGH THIS FUNCTION (D-S03-4) but `deriveNextUnit` never auto-triggers
 * them in `/forge auto`. `plan-milestone`'s M7 debt is PAID
 * (`M-20260712220520-nascimento-milestone`): it now has a shipped dispatch
 * front-end, `commands/milestone-command.ts` (`/forge milestone start
 * <MID>`) — see `docs/forge/FORGE2-MILESTONE-BIRTH.md` for the full birth →
 * lapidação → start → auto-ready cycle. `discuss-slice`/`discuss-milestone`/
 * `research-slice`/`research-milestone` remain reachable only from an
 * interactive front-end (future milestone) or a direct dispatch (e.g. S04's
 * risk-radar for `research-slice`). Kept as a LOCAL type here rather than
 * folded into `NextUnit` so the auto-loop's exhaustive dispatch switch stays untouched
 * by this deferred wiring — this is a documented deferral (S03-PLAN §
 * D-S03-4), not a silent scope reduction. `risk-radar` (S04/T04, D-S04-5)
 * follows the identical deferral pattern: dispatchable through this
 * function, never auto-triggered by `deriveNextUnit`. `research-models`
 * (M-capacidade-esforco S04, D-S04-1) follows it too, and is additionally
 * REPO-LEVEL: no slice/milestone binding — the capability matrix
 * (`.gsd/CAPABILITIES.md`) is repo state, and the unit is invocable with
 * no active milestone (`info.milestoneId === ""` omits the Milestone
 * identity line). `review-fix` (S02/T02, D-S02-1) follows the identical
 * deferral pattern and is additionally MILESTONE-BOUND (unlike
 * `research-models`): it requires an active milestone in `.gsd/STATE.md`
 * (the review artifacts it fixes live under that milestone's slices) and is
 * dispatched ONLY by `/forge fix` (T03) — `deriveNextUnit` never sees it.
 * `review-fix`'s optional `taskId` (cockpit-v2 S03/T04) targets a loose
 * task's own review instead: `pathsBlock` points at
 * `.gsd/tasks/<taskId>/<taskId>-REVIEW.md` and `identityBlock` prints a
 * `- Task:` line (no `- Slice:` line) instead of the milestone-slice shape —
 * repo-level like `research-models`/`task-plan`/`task-execute`, reachable
 * with no active milestone. Absent `taskId` stays byte-identical to the
 * pre-T04 slice-only shape.
 * `task-plan`/`task-execute` (S02/T01 do M-20260712170458-cockpit-v2) follow
 * the identical deferral pattern and are additionally REPO-LEVEL like
 * `research-models` (no slice/milestone binding — `milestoneId ""` at the
 * call site omits the Milestone identity line): they are `/forge task
 * "<descrição>"`'s planner/executor phases for a loose task living at
 * `.gsd/tasks/<taskId>/`, never a `.gsd/milestones/` slice. `task-plan`
 * carries a `directDispatchRole` entry (→ `planner`); `task-execute`
 * deliberately does NOT (S02-PLAN Interpretation Decision 4) — it falls
 * through to the tolerant `"executor"` fallback, which is the role it needs.
 * `milestone-context` (M-nascimento/S02) follows the same direct-dispatch
 * deferral but is MILESTONE-DIR-BOUND and PRE-STATE: it is invocable without
 * an active milestone, and its `milestone` is the newly reserved MID whose
 * directory is the worker's only permitted write boundary.
 */
export type ComposableUnit =
  | NextUnit
  | { type: "discuss-slice"; slice: string }
  | { type: "discuss-milestone"; milestone: string }
  | { type: "research-slice"; slice: string }
  | { type: "research-milestone"; milestone: string }
  | { type: "plan-milestone"; milestone: string }
  | { type: "milestone-context"; milestone: string }
  | { type: "risk-radar"; slice: string }
  | { type: "research-models" }
  | { type: "review-fix"; slice: string; taskId?: string }
  | { type: "task-plan"; taskId: string }
  | { type: "task-execute"; taskId: string };

/** Minimal identity/context info the loop has on hand when dispatching a unit. */
export interface ComposeInfo {
  cwd: string;
  milestoneId: string;
  milestoneTitle?: string;
  sliceTitle?: string;
  taskTitle?: string;
  /**
   * The name of the result-commit tool the worker must call (B2). Defaults to
   * the bare `forge_unit_result` (in-process / fake / interactive paths); the
   * loop passes the namespaced `mcp__forge__forge_unit_result` only when the
   * unit's effective provider is `claude-code` (externalCli / SDK MCP bridge).
   * When set to a namespaced name, EVERY mention of `forge_unit_result` in the
   * composed prompt (body + commit point) is rewritten to it.
   */
  resultToolName?: string;
  /**
   * The model/provider resolved by the dispatch loop for this unit. Workers
   * must copy this fact into `executed_by`; omitted for paths without a
   * dispatch-authority resolution.
   */
  dispatchAuthorRef?: string;
  /**
   * The scope-level `domain:` hint (S05, `auto/scope-domain.ts`'s
   * `scopeDomainFor`), pre-resolved by the caller — `composePrompt` never
   * does I/O (D-S05-C). Surfaces as an identity-line hint for `plan-slice`/
   * `plan-milestone` ONLY (D-S05-D: conditional on the data, not the unit
   * type gate itself — but only these two unit types are wired to print it).
   * It INFORMS judgement; the per-task `domain:` frontmatter on T##-PLAN
   * remains the only input the rank reads (D-S05-B). Absent/empty → no line,
   * byte-identical to pre-S05 output (D-S04-1 pattern).
   */
  scopeDomain?: string;
  /**
   * The review items the operator chose for a `review-fix` dispatch (S02/T02,
   * D-S02-2): the item claims, their FULL dialogue (Objeção/Defesa/Réplica)
   * verbatim, and the diff-range command — assembled by the caller (`/forge
   * fix`, T03) as a single string; `composePrompt` never reads
   * `S##-REVIEW.md` itself (lean/no-I/O stays true). Rendered as its own
   * `## Itens de review a corrigir (inlinados)` section ONLY when non-empty
   * AND `unit.type === "review-fix"` — absent/empty ⇒ no section, byte-
   * identical output for every other unit type (D-S04-1 conditional-field
   * pattern).
   */
  reviewFixPayload?: string;
}

/** The default (bare) result-commit tool name embedded in the prompt bodies. */
const DEFAULT_RESULT_TOOL_NAME = "forge_unit_result";

/**
 * The slice id of `unit`, or "" for milestone-level units (`complete-milestone`,
 * `*-milestone`, `plan-milestone`) and for a `review-fix` targeting a loose
 * task (S03/T04) — that variant's `slice` field carries the TASK_ID (it feeds
 * the journal/diff-scope helpers), but the identity block renders it via the
 * `- Task:` line below instead, mirroring `task-plan`/`task-execute`.
 */
function composableSlice(unit: ComposableUnit): string {
  if (unit.type === "review-fix" && unit.taskId) return "";
  return "slice" in unit ? unit.slice : "";
}

/** Paths block: absolute paths to the artifacts the worker must read/write via its own tools. */
function pathsBlock(unit: ComposableUnit, info: ComposeInfo): string {
  const milestoneDir = join(info.cwd, ".gsd", "milestones", info.milestoneId);
  const roadmapPath = join(milestoneDir, `${info.milestoneId}-ROADMAP.md`);
  const slicesDir = join(milestoneDir, "slices");

  switch (unit.type) {
    case "plan-slice": {
      const sliceDir = join(slicesDir, unit.slice);
      const slicePlanPath = join(sliceDir, `${unit.slice}-PLAN.md`);
      const tasksDir = join(sliceDir, "tasks");
      // Real-provider planners default to a flat layout unless the canonical
      // per-task path is spelled out (A1 evidence 2026-07-10: three real runs
      // wrote slices/S##/T##-PLAN.md flat and deriveNextUnit found no tasks).
      return [
        `- ROADMAP: \`${roadmapPath}\``,
        `- Slice plan (write this): \`${slicePlanPath}\``,
        `- Task plans — one per task, EXACTLY this layout (the dispatcher reads ONLY here): \`${join(tasksDir, "T01", "T01-PLAN.md")}\`, \`${join(tasksDir, "T02", "T02-PLAN.md")}\`, … (NEVER directly under the slice dir)`,
      ].join("\n");
    }
    case "execute-task": {
      const sliceDir = join(slicesDir, unit.slice);
      const slicePlanPath = join(sliceDir, `${unit.slice}-PLAN.md`);
      const tasksDir = join(sliceDir, "tasks");
      const taskDir = join(tasksDir, unit.task);
      const taskPlanPath = join(taskDir, `${unit.task}-PLAN.md`);
      const taskSummaryPath = join(taskDir, `${unit.task}-SUMMARY.md`);
      return [
        `- ROADMAP: \`${roadmapPath}\``,
        `- Slice plan: \`${slicePlanPath}\``,
        `- Tasks directory (prior T##-SUMMARY.md files live here, one subdir per task): \`${tasksDir}\``,
        `- Task plan (read this fully first): \`${taskPlanPath}\``,
        `- Task summary (write this when done): \`${taskSummaryPath}\``,
      ].join("\n");
    }
    case "complete-slice": {
      const sliceDir = join(slicesDir, unit.slice);
      const slicePlanPath = join(sliceDir, `${unit.slice}-PLAN.md`);
      const tasksDir = join(sliceDir, "tasks");
      const sliceSummaryPath = join(sliceDir, `${unit.slice}-SUMMARY.md`);
      const sliceUatPath = join(sliceDir, `${unit.slice}-UAT.md`);
      return [
        `- Slice plan: \`${slicePlanPath}\``,
        `- Tasks directory (read every T##-SUMMARY.md here first): \`${tasksDir}\``,
        `- Slice summary (write this): \`${sliceSummaryPath}\``,
        `- Slice UAT script (write this): \`${sliceUatPath}\``,
      ].join("\n");
    }
    case "complete-milestone": {
      const milestoneSummaryPath = join(milestoneDir, `${info.milestoneId}-SUMMARY.md`);
      const ledgerFragmentPath = join(info.cwd, ".gsd", "ledger", `${info.milestoneId}.md`);
      return [
        `- ROADMAP: \`${roadmapPath}\``,
        `- Slices directory (read every S##-SUMMARY.md here, one subdir per slice): \`${slicesDir}\``,
        `- Milestone summary (write this, accumulated): \`${milestoneSummaryPath}\``,
        `- LEDGER fragment (write this): \`${ledgerFragmentPath}\``,
      ].join("\n");
    }
    case "discuss-slice": {
      const sliceDir = join(slicesDir, unit.slice);
      const contextPath = join(sliceDir, `${unit.slice}-CONTEXT.md`);
      return [
        `- ROADMAP: \`${roadmapPath}\``,
        `- Slice CONTEXT (write this): \`${contextPath}\``,
      ].join("\n");
    }
    case "discuss-milestone": {
      const contextPath = join(milestoneDir, `${info.milestoneId}-CONTEXT.md`);
      return [
        `- ROADMAP: \`${roadmapPath}\``,
        `- Milestone CONTEXT (write this): \`${contextPath}\``,
      ].join("\n");
    }
    case "research-slice": {
      const sliceDir = join(slicesDir, unit.slice);
      const researchPath = join(sliceDir, `${unit.slice}-RESEARCH.md`);
      return [
        `- ROADMAP: \`${roadmapPath}\``,
        `- Slice RESEARCH (write this): \`${researchPath}\``,
      ].join("\n");
    }
    case "research-milestone": {
      const researchPath = join(milestoneDir, `${info.milestoneId}-RESEARCH.md`);
      return [
        `- ROADMAP: \`${roadmapPath}\``,
        `- Milestone RESEARCH (write this): \`${researchPath}\``,
      ].join("\n");
    }
    case "plan-milestone": {
      const contextPath = join(milestoneDir, `${info.milestoneId}-CONTEXT.md`);
      return [
        `- Milestone CONTEXT (read, if it exists): \`${contextPath}\``,
        `- ROADMAP (write this): \`${roadmapPath}\``,
      ].join("\n");
    }
    case "milestone-context": {
      const requestPath = join(milestoneDir, `${info.milestoneId}-REQUEST.md`);
      const contextPath = join(milestoneDir, `${info.milestoneId}-CONTEXT.md`);
      return [
        `- Milestone request (read first — the operator's request): \`${requestPath}\``,
        `- Milestone CONTEXT (write this): \`${contextPath}\``,
      ].join("\n");
    }
    case "risk-radar": {
      const sliceDir = join(slicesDir, unit.slice);
      const slicePlanPath = join(sliceDir, `${unit.slice}-PLAN.md`);
      const sliceContextPath = join(sliceDir, `${unit.slice}-CONTEXT.md`);
      const sliceRiskPath = join(sliceDir, `${unit.slice}-RISK.md`);
      return [
        `- ROADMAP: \`${roadmapPath}\``,
        `- Slice plan: \`${slicePlanPath}\``,
        `- Slice CONTEXT (read, if it exists): \`${sliceContextPath}\``,
        `- Slice risk card (write this): \`${sliceRiskPath}\``,
      ].join("\n");
    }
    case "research-models": {
      // Repo-level unit (D-S04-1): none of the milestone-derived paths above
      // apply — the capability matrix lives directly under `.gsd/`.
      const capabilitiesPath = join(info.cwd, ".gsd", "CAPABILITIES.md");
      const capabilitiesLocalPath = join(info.cwd, ".gsd", "CAPABILITIES.local.md");
      const modelsConfigPath = join(info.cwd, ".gsd", "models.md");
      const formatDocPath = join(info.cwd, "docs", "forge", "FORGE2-CAPABILITIES-FORMAT.md");
      return [
        `- Capability matrix (write/update this): \`${capabilitiesPath}\``,
        `- Operator overrides (NEVER write this — operator-only): \`${capabilitiesLocalPath}\``,
        `- Routing pools (read if it exists — the operator's routed refs): \`${modelsConfigPath}\``,
        `- Format contract (read if it exists — the durable format contract): \`${formatDocPath}\``,
      ].join("\n");
    }
    case "review-fix": {
      const knowledgePath = join(info.cwd, ".gsd", "KNOWLEDGE.md");
      if (unit.taskId) {
        // Loose-task target (S03/T04): repo-level, no milestone/slice binding —
        // paths point at the task's own store under `.gsd/tasks/<taskId>/`.
        const taskDir = join(info.cwd, ".gsd", "tasks", unit.taskId);
        const taskReviewPath = join(taskDir, `${unit.taskId}-REVIEW.md`);
        const taskDescriptorPath = join(taskDir, `${unit.taskId}-TASK.md`);
        const taskPlanPath = join(taskDir, `${unit.taskId}-PLAN.md`);
        return [
          `- Task REVIEW (read — fonte dos itens; the items you fix are inlined in the prompt below, do not re-derive them from this file): \`${taskReviewPath}\``,
          `- Task descriptor (context): \`${taskDescriptorPath}\``,
          `- Task plan (context): \`${taskPlanPath}\``,
          `- KNOWLEDGE (NEVER write — o comando faz o write-back): \`${knowledgePath}\``,
        ].join("\n");
      }
      const sliceDir = join(slicesDir, unit.slice);
      const sliceReviewPath = join(sliceDir, `${unit.slice}-REVIEW.md`);
      return [
        `- Slice REVIEW (read — fonte dos itens; the items you fix are inlined in the prompt below, do not re-derive them from this file): \`${sliceReviewPath}\``,
        `- Slice directory: \`${sliceDir}\``,
        `- KNOWLEDGE (NEVER write — o comando faz o write-back): \`${knowledgePath}\``,
      ].join("\n");
    }
    case "task-plan": {
      // Repo-level unit, no milestone/slice binding: the loose task lives
      // directly under `.gsd/tasks/<taskId>/` — none of the milestoneDir/
      // roadmapPath/slicesDir derived above apply.
      const taskDir = join(info.cwd, ".gsd", "tasks", unit.taskId);
      const taskDescriptorPath = join(taskDir, `${unit.taskId}-TASK.md`);
      const taskPlanPath = join(taskDir, `${unit.taskId}-PLAN.md`);
      return [
        `- Task descriptor (read first — the operator's request): \`${taskDescriptorPath}\``,
        `- Task plan (write this): \`${taskPlanPath}\``,
      ].join("\n");
    }
    case "task-execute": {
      const taskDir = join(info.cwd, ".gsd", "tasks", unit.taskId);
      const taskDescriptorPath = join(taskDir, `${unit.taskId}-TASK.md`);
      const taskPlanPath = join(taskDir, `${unit.taskId}-PLAN.md`);
      const taskSummaryPath = join(taskDir, `${unit.taskId}-SUMMARY.md`);
      return [
        `- Task descriptor (read): \`${taskDescriptorPath}\``,
        `- Task plan (read fully first): \`${taskPlanPath}\``,
        `- Task summary (write this when done): \`${taskSummaryPath}\``,
      ].join("\n");
    }
    default: {
      const exhaustive: never = unit;
      throw new Error(`composePrompt: unhandled unit type in pathsBlock: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Identity header: which unit, in which slice/milestone, with any titles the loop already knows. */
function identityBlock(unit: ComposableUnit, info: ComposeInfo): string {
  const lines = [`# Unit: ${unit.type}`, ""];
  // D-S04-1: the Milestone line is CONDITIONAL on a non-empty milestoneId —
  // repo-level units (research-models) are invocable with no active
  // milestone. Every existing caller always passes a non-empty id, so their
  // output stays byte-identical.
  if (info.milestoneId) {
    lines.push(`- Milestone: \`${info.milestoneId}\`${info.milestoneTitle ? ` — ${info.milestoneTitle}` : ""}`);
  }
  const slice = composableSlice(unit);
  if (slice) {
    lines.push(`- Slice: \`${slice}\`${info.sliceTitle ? ` — ${info.sliceTitle}` : ""}`);
  }
  // D-S05-D: gated on unit type (plan-slice/plan-milestone only) AND a
  // non-empty value — no other unit type's prompt changes in this slice.
  if ((unit.type === "plan-slice" || unit.type === "plan-milestone") && info.scopeDomain?.trim()) {
    lines.push(`- Domain (larger scope): \`${info.scopeDomain.trim()}\` — informs your judgement; per-task \`domain:\` frontmatter is what routes.`);
  }
  if (unit.type === "execute-task") {
    lines.push(`- Task: \`${unit.task}\`${info.taskTitle ? ` — ${info.taskTitle}` : ""}`);
  }
  if (unit.type === "task-plan" || unit.type === "task-execute") {
    lines.push(`- Task: \`${unit.taskId}\`${info.taskTitle ? ` — ${info.taskTitle}` : ""}`);
  }
  if (unit.type === "review-fix" && unit.taskId) {
    lines.push(`- Task: \`${unit.taskId}\`${info.taskTitle ? ` — ${info.taskTitle}` : ""}`);
  }
  const dispatchAuthorRef = info.dispatchAuthorRef?.trim();
  if (dispatchAuthorRef) {
    lines.push(`- You are running as: \`${dispatchAuthorRef}\` (copy this exact value into \`executed_by\`)`);
  }
  lines.push("", "## Artifacts to read (via your own tools — this prompt does not inline them)", "", pathsBlock(unit, info));
  return lines.join("\n");
}

/** The prompt body for the unit's type. */
function bodyForUnit(unit: ComposableUnit): string {
  switch (unit.type) {
    case "plan-slice":
      return PLAN_SLICE_PROMPT;
    case "execute-task":
      return EXECUTE_TASK_PROMPT;
    case "complete-slice":
      return COMPLETE_SLICE_PROMPT;
    case "complete-milestone":
      return COMPLETE_MILESTONE_PROMPT;
    case "discuss-slice":
    case "discuss-milestone":
      return DISCUSS_PROMPT;
    case "research-slice":
    case "research-milestone":
      return RESEARCH_PROMPT;
    case "plan-milestone":
      return PLAN_MILESTONE_PROMPT;
    case "milestone-context":
      return MILESTONE_CONTEXT_PROMPT;
    case "risk-radar":
      return RISK_RADAR_PROMPT;
    case "research-models":
      return RESEARCH_MODELS_PROMPT;
    case "review-fix":
      return REVIEW_FIX_PROMPT;
    case "task-plan":
      return TASK_PLAN_PROMPT;
    case "task-execute":
      return TASK_EXECUTE_PROMPT;
    default: {
      const exhaustive: never = unit;
      throw new Error(`composePrompt: unhandled unit type in bodyForUnit: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The mandatory closing instruction — the single commit point (M1-D2). */
const COMMIT_POINT_INSTRUCTION = `## Commit point (mandatory)

When you are done — whether the unit succeeded, partially succeeded, or is blocked — you MUST call the \`forge_unit_result\` tool as your VERY LAST action. This is the only commit point this loop recognizes; no other final-answer format is read.`;

/**
 * Build the lean worker prompt for `unit`. `failureContext`, when present
 * (retry re-dispatch, B4), is appended as a `## Retry Context` section
 * right before the final commit-point instruction so the worker sees it
 * last, closest to its own turn. `projectMemory`, when present (S07-T02/T04),
 * is appended right after `failureContext` (or right after the body when
 * there is no retry context) and before the commit-point instruction — it
 * already arrives with its own `## Project Memory` header (see
 * `composeProjectMemory`), so it is pushed verbatim. Absent/empty →
 * no section is added (byte-identical to the pre-S07 output).
 * `info.reviewFixPayload` (S02/T02, D-S02-2) is appended right after the
 * body — before retry context/project memory/commit point — as its own
 * `## Itens de review a corrigir (inlinados)` section, ONLY when non-empty
 * AND `unit.type === "review-fix"`; absent/empty ⇒ no section (byte-
 * identical for every other unit type and for review-fix with no payload).
 */
export function composePrompt(unit: ComposableUnit, info: ComposeInfo, failureContext?: string, projectMemory?: string): string {
  const sections = [identityBlock(unit, info), bodyForUnit(unit)];

  if (unit.type === "review-fix" && info.reviewFixPayload?.trim()) {
    sections.push(`## Itens de review a corrigir (inlinados)\n\n${info.reviewFixPayload}`);
  }

  if (failureContext) {
    sections.push(`## Retry Context\n\nThe previous attempt at this unit did not complete successfully. Use this context to avoid repeating the same mistake:\n\n${failureContext}`);
  }

  if (projectMemory && projectMemory.trim()) {
    sections.push(projectMemory.trim());
  }

  sections.push(COMMIT_POINT_INSTRUCTION);

  const composed = sections.join("\n\n");

  // B2: rewrite every backtick-wrapped mention of the bare tool name to the
  // resolved name. The prompt bodies and the commit-point instruction ALWAYS
  // wrap the tool name in backticks, so a single `replaceAll` over the
  // composed text covers every occurrence (chosen over a per-body template
  // for being the least invasive to the existing prompt text). No-op when
  // the name is the default → the in-process/fake path is byte-identical.
  const toolName = info.resultToolName ?? DEFAULT_RESULT_TOOL_NAME;
  if (toolName !== DEFAULT_RESULT_TOOL_NAME) {
    const rewritten = composed.replaceAll(`\`${DEFAULT_RESULT_TOOL_NAME}\``, `\`${toolName}\``);
    // M2R-1 Fix 1 Part B (belt-and-suspenders, provider-agnostic): on the
    // claude-code real-provider path the tool is namespaced (`mcp__...`) and
    // the subprocess `claude` may surface it as a DEFERRED/searchable tool
    // when tool-search mode is active (high MCP tool count). Tell the worker
    // to preload its schema via `ToolSearch` before calling it. Guarded on
    // the namespaced prefix so the bare/in-process/fake/interactive path
    // (DEFAULT_RESULT_TOOL_NAME) stays byte-identical to today.
    if (toolName.startsWith("mcp__")) {
      return `${rewritten}\n\nIf \`${toolName}\` is not immediately available in your tool list, it may be deferred/searchable — first call \`ToolSearch\` with \`select:${toolName}\` to load its schema, then call it.`;
    }
    return rewritten;
  }
  return composed;
}
