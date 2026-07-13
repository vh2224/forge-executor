/**
 * Forge review — prompt builders for the challenger/advocate/rebuttal
 * dialectic (D-S05-5 — plain parametric functions, NOT `ComposableUnit`: the
 * review phases are not units of the M3 orchestrator loop under decision B1/
 * opção-b, they are dispatched by whatever consumer owns the review gate).
 *
 * Source (rewritten in the forge namespace — never imported from the
 * condemned `gsd/` tree): `agents/forge-reviewer.md` (§ Output format —
 * challenge mode — and § Rebuttal mode) and `agents/forge-advocate.md`
 * (§ Output format — Defense) of forge-agent 1.0, plus the `objText`/
 * `defText` serializations of the `## Engine workflow` script in
 * `shared/forge-review.md` (the shape `parse.ts` — this task — and the
 * native T01 `resolveReview` truth table both consume).
 *
 * KEPT (native parity — instructions that survive the 2.0 context):
 *   - "execute DIFF_CMD from INSIDE WORKING_DIR" (cd to it first) — the diff
 *     target lives there, not in the agent's default cwd.
 *   - the output format each parser reads: `R#` ids assigned severity-then-
 *     order, `path:line`, claim, suggested fix, and a `challenge:` question
 *     for the challenger; `R#: verdict — rationale` lines for advocate
 *     defense and reviewer rebuttal.
 *   - NO_FLAGS (literal, case-insensitive) when the challenger finds nothing.
 *   - rebuttal-mode semantics: only re-litigate objections the advocate
 *     `refuted` or marked `open`; an advocate `conceded` objection is carried
 *     through unchanged (nothing to rebut).
 *
 * DROPPED / DEFERRED (belongs to the harness or the orchestrator, not this
 * module):
 *   - the Claude Code 1.0 tool list (`tools: Read, Bash, Grep, Glob`) and any
 *     `Task`/`Agent`/`Skill` framing — this harness's dispatch mechanics are
 *     out of scope for a prompt body.
 *   - the textual `---GSD-WORKER-RESULT---` sentinel — this milestone's
 *     commit point is a structured tool call (`forge_unit_result` / an
 *     equivalent), not a text block; dispatch/parsing of that result is the
 *     orchestrator's job (M3), not this module's.
 *   - `Workflow`-engine JS script variant (`## Engine workflow` in
 *     `shared/forge-review.md`) — not ported; the native path always talks
 *     to agents directly, there is no in-process "workflow tool" here.
 *
 * This module only builds prompt strings and serializes objections/verdicts
 * into the OBJECTIONS/DEFENSE blocks the prompts embed — it never dispatches
 * an agent itself (that is the orchestrator's job, deferred per D-S05-1).
 */

import type {
  ReviewObjection,
  ReviewVerdict,
  AdvocateVerdictKind,
  RebuttalVerdictKind,
} from "./resolve.js";

/** Parameters shared by every phase of the review dialectic. */
interface ReviewPromptBase {
  /** Absolute path to the project root the diff must be computed against. */
  workingDir: string;
  /** Label for context (e.g. `complete-slice/S05`, `task/T02`). */
  unit: string;
  /** Exact shell command that produces the diff under review. */
  diffCmd: string;
  /**
   * Best-effort scope-level domain (`scopeDomainFor`, S05) — informs which
   * review lens to pick; NEVER routes the rank (D-S05-B, that stays
   * per-task `domainHintForUnit` only). Absent ⇒ no `DOMAIN:` line, prompt
   * byte-identical to pre-S05 output (D-S05-D).
   */
  domain?: string;
}

/** Parameters for {@link advocatePrompt}. */
interface AdvocatePromptParams extends ReviewPromptBase {
  /** The challenger's objections, pre-rendered via {@link renderObjectionsText}. */
  objectionsText: string;
}

/** Parameters for {@link rebuttalPrompt}. */
interface RebuttalPromptParams extends ReviewPromptBase {
  /** The challenger's objections, pre-rendered via {@link renderObjectionsText}. */
  objectionsText: string;
  /** The advocate's per-objection verdicts, pre-rendered via {@link renderDefenseText}. */
  defenseText: string;
}

const DIFF_INSTRUCTION =
  "Execute DIFF_CMD from INSIDE WORKING_DIR (cd to it first) — the diff target lives there, not in your default cwd.";

/**
 * Challenge-mode prompt for the reviewer agent (forge-reviewer 1.0, default
 * mode — no `OBJECTIONS`/`DEFENSE` present). Scans the diff and returns
 * severity-bucketed objections with stable `R#` ids, or the literal
 * `NO_FLAGS` when nothing is worth flagging.
 */
export function challengerPrompt(params: ReviewPromptBase): string {
  const { workingDir, unit, diffCmd, domain } = params;
  const domainLine = domain ? `DOMAIN: ${domain} (larger-scope context — pick review lenses accordingly)\n` : "";
  return `You are an adversarial senior code reviewer. You read a diff and flag issues a careful reviewer would catch — idempotence bugs, error-path gaps, portability issues, null-safety holes, hidden races.

WORKING_DIR: ${workingDir}
UNIT: ${unit}
${domainLine}DIFF_CMD: ${diffCmd}

${DIFF_INSTRUCTION}

## Constraints
- Read-only. Never edit, write, or commit.
- Never return \`blocked\` — findings are advisory, even when severe.
- Do the work YOURSELF, in THIS session. NEVER delegate to subagents or agent-spawning tools (\`Agent\`, \`Task\`, \`subagent\`, background jobs) — a delegated answer never reaches this dialectic and counts as NO answer (S06 incident: the advocate "dispatched the forge-advocate agent" and every objection went undefended).
- NEVER call \`forge_unit_result\` or any \`mcp__forge__\` tool — this is not a unit of work; your FINAL PLAIN-TEXT message in the requested format IS the deliverable.
- \`bash\` is for INSPECTION only (git diff/show, grep, cat) — never mutate files or state.
- No generic best-practice lectures. Every finding must be traceable to a specific line in the diff.
- Omit buckets with zero findings. If nothing worth flagging → return the literal string \`NO_FLAGS\` alone.

## Workflow
1. Run DIFF_CMD as instructed above. Capture the unified diff.
2. If the diff is empty → return \`NO_FLAGS\`.
3. Read enough surrounding code to understand context for non-trivial hunks — do NOT review hunks in isolation when a call site or a sibling file would change the verdict. Budget: up to 5 reads.
4. Apply the matching lens for each file type touched (shell/scripts: idempotence, races, portability; TypeScript/JS: null safety, drift, error paths, exhaustive unions; CSS: cascade order, dark mode, reduced-motion; Python: exception specificity, mutable defaults; SQL/migrations: lock duration, backfill safety, reversibility; docs: consistency with code; any: unchecked return codes, magic numbers, boundary validation).
5. Rank findings by severity: Critical (breaks golden path, data loss, security exposure), High (breaks on plausible edge case, silent corruption, races), Medium (quality issue causing a future bug), Low/Nit (style, minor consistency).

## Output format

Return EXACTLY this shape. Omit buckets with zero findings. Assign every finding a stable id (\`R1\`, \`R2\`, … in severity-then-order sequence) and end each with a \`challenge:\` — the one question that decides whether the issue is real.

### Critical
- R1 \`path:line\` — issue — suggested fix: <the fix> — challenge: <the question that decides whether this is real>

### High
- R2 \`path:line\` — issue — suggested fix: <the fix> — challenge: <…>

### Medium
- R3 \`path:line\` — issue — suggested fix: <the fix> — challenge: <…>

### Low / Nit
- R4 \`path:line\` — issue — suggested fix: <the fix> — challenge: <…>

If no findings → return the single line \`NO_FLAGS\` (literal).

## Never
- Never recommend refactors outside the diff.
- Never repeat findings from different angles (one finding per issue).
- Never cite style preferences as Critical/High — linters handle style.
`;
}

/**
 * Defense prompt for the advocate agent (forge-advocate 1.0). Receives the
 * challenger's `OBJECTIONS` block and returns one verdict (`refuted` /
 * `conceded` / `open`) per objection id, in id order.
 */
export function advocatePrompt(params: AdvocatePromptParams): string {
  const { workingDir, unit, diffCmd, objectionsText, domain } = params;
  const domainLine = domain ? `DOMAIN: ${domain} (larger-scope context — pick review lenses accordingly)\n` : "";
  return `You are the engineer who wrote the code under review. A reviewer raised a set of objections against your diff. Your job is to answer each objection honestly — not to win, and not to roll over.

WORKING_DIR: ${workingDir}
UNIT: ${unit}
${domainLine}DIFF_CMD: ${diffCmd}

${DIFF_INSTRUCTION}

OBJECTIONS:
${objectionsText}

## Posture
- Conceding a real bug is a win, not a loss. If the objection is correct, say so plainly.
- Weak objections deserve a real defense: pre-existing issues, intentional scope, false positives, lint-owned issues, hunks read out of context — refute them with the specific reason, traceable to the code.
- A genuine tradeoff is neither: when the reviewer has a point AND your approach also has merit, mark it \`open\` and state the tension squarely.
- No new lectures. No adjacent cleanup. Answer ONLY the objections you were handed.

## Constraints
- Read-only. Never edit, write, or commit.
- Never return \`blocked\`. Your verdicts are advisory.
- Do the work YOURSELF, in THIS session. NEVER delegate to subagents or agent-spawning tools (\`Agent\`, \`Task\`, \`subagent\`, background jobs) — a delegated answer never reaches this dialectic and counts as NO answer (S06 incident: the advocate "dispatched the forge-advocate agent" and every objection went undefended).
- NEVER call \`forge_unit_result\` or any \`mcp__forge__\` tool — this is not a unit of work; your FINAL PLAIN-TEXT message in the requested format IS the deliverable.
- \`bash\` is for INSPECTION only (git diff/show, grep, cat) — never mutate files or state.
- Every verdict must be traceable to a specific line in the diff or to project intent.

## Workflow
1. Run DIFF_CMD as instructed above. Capture the unified diff.
2. Read enough surrounding code (budget up to 5 reads) to judge each objection in context.
3. For each objection \`R#\`, decide exactly one verdict: \`refuted\` (not a real problem — state the specific reason), \`conceded\` (the reviewer is right — say what should happen), or \`open\` (a genuine tradeoff — state both sides in one breath).
4. Do not invent objections the reviewer did not raise. If you were handed R1..Rn, return R1..Rn — no more, no fewer.

## Output format

Return EXACTLY this shape, one line per objection in id order:

### Defense
- R1: refuted — \`path:line\` — <specific reason this is not a real problem in this change>
- R2: conceded — \`path:line\` — <what is actually wrong and what should happen>
- R3: open — \`path:line\` — <the tradeoff: reviewer's point AND the counter-point, in one breath>

If OBJECTIONS is empty or the diff is empty → return the single line \`NO_OBJECTIONS\` (literal).

## Never
- Never concede just to be agreeable, and never refute just to defend your work.
- Never raise new issues, suggest refactors, or review hunks the reviewer did not flag.
`;
}

/**
 * Rebuttal-mode prompt for the reviewer agent (forge-reviewer 1.0
 * § Rebuttal mode — triggered by the presence of a `DEFENSE` block). Reacts
 * to the advocate's defense, objection by objection, and returns
 * `maintained` / `withdrawn` / `conceded` per objection id.
 */
export function rebuttalPrompt(params: RebuttalPromptParams): string {
  const { workingDir, unit, diffCmd, objectionsText, defenseText, domain } = params;
  const domainLine = domain ? `DOMAIN: ${domain} (larger-scope context — pick review lenses accordingly)\n` : "";
  return `You are the same adversarial senior code reviewer who raised the objections below. The advocate (the author) has answered them. Do NOT re-scan for new issues — react to the defense, objection by objection.

WORKING_DIR: ${workingDir}
UNIT: ${unit}
${domainLine}DIFF_CMD: ${diffCmd}

${DIFF_INSTRUCTION}

OBJECTIONS:
${objectionsText}

DEFENSE:
${defenseText}

## Rebuttal rules
- Only re-litigate objections the advocate \`refuted\` or marked \`open\`.
- Do the work YOURSELF, in THIS session. NEVER delegate to subagents or agent-spawning tools (\`Agent\`, \`Task\`, \`subagent\`, background jobs) — a delegated answer never reaches this dialectic and counts as NO answer (S06 incident: the advocate "dispatched the forge-advocate agent" and every objection went undefended).
- NEVER call \`forge_unit_result\` or any \`mcp__forge__\` tool — this is not a unit of work; your FINAL PLAIN-TEXT message in the requested format IS the deliverable.
- \`bash\` is for INSPECTION only (git diff/show, grep, cat) — never mutate files or state.
- An objection the advocate \`conceded\` is settled — you both agree it's a real problem, so there is nothing to rebut. Carry it through unchanged as \`conceded\`; do not "withdraw" a concession.
- For each remaining \`R#\`: \`maintained\` — the defense did not hold, give the one-line reason it fails; \`withdrawn\` — the defense is correct (pre-existing, intentional, false positive, missed context), drop the objection.
- Be intellectually honest: withdraw when you're wrong, hold firm when the defense is hand-waving.

## Output format

Return EXACTLY this shape, one line per original objection in id order:

### Rebuttal
- R1: conceded — (advocate conceded; carried through as an action item)
- R2: maintained — <why the defense fails>
- R3: withdrawn — <why the defense holds>
`;
}

/**
 * Deterministic serialization of the challenger's objections into the
 * `OBJECTIONS:` block the advocate/rebuttal prompts embed — the same shape
 * as the `objText` join of `shared/forge-review.md § Engine workflow`:
 * `R# \`path:line\` [severity] — claim — suggested fix: ... — challenge: ...`
 * one objection per line, in objection order (stable input order — the
 * caller is responsible for handing objections in severity-then-order id
 * sequence, matching how they were assigned).
 */
export function renderObjectionsText(objections: ReviewObjection[]): string {
  return objections
    .map(
      (o) =>
        `${o.id} \`${o.pathLine}\` [${o.severity}] — ${o.claim} — suggested fix: ${o.suggestedFix} — challenge: ${o.challenge}`,
    )
    .join("\n");
}

/**
 * Deterministic serialization of a set of per-objection verdicts (advocate
 * defense or reviewer rebuttal) into the `DEFENSE:` block — same shape as
 * `defText` in `shared/forge-review.md § Engine workflow`:
 * `R#: verdict — rationale`, one per line in verdict order. Accepts either
 * verdict kind (`AdvocateVerdictKind` for the defense text fed into the
 * rebuttal prompt, `RebuttalVerdictKind` for a rendered rebuttal record) —
 * the shape is identical, only the allowed vocabulary differs, and that
 * vocabulary is enforced by `parse.ts`, not by this renderer.
 */
export function renderDefenseText(
  verdicts: ReviewVerdict<AdvocateVerdictKind | RebuttalVerdictKind>[],
): string {
  return verdicts.map((v) => `${v.id}: ${v.verdict} — ${v.rationale}`).join("\n");
}
