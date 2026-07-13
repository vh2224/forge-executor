/**
 * `/forge task "<descrição>"` — a loose task outside any milestone (S02/T02
 * of `M-20260712170458-cockpit-v2`). It mints a `T-<ts>-<slug>` id
 * (`resolveTaskId`, `state/ids.ts` — REUSED, not reimplemented), creates
 * `.gsd/tasks/<TASK_ID>/<TASK_ID>-TASK.md` with the operator's request, then
 * dispatches the `task-plan` unit through the SAME production spine
 * `/forge research-models`/`/forge fix` use — guard de reentrância →
 * bootstrap do container → `resolveDispatchAuthor` → `composePrompt` →
 * `dispatchUnitViaNewSession` (S02-PLAN Interpretation Decision 3).
 *
 * `{ type: "task-plan", taskId }` (and its `task-execute` sibling) are
 * REPO-LEVEL like `research-models` (D-S04-1): no slice/milestone binding,
 * `deriveNextUnit` never sees either type — this command is the ONLY
 * dispatcher (fronteira dura, same family as D-S04-1/D-S02-1).
 * `milestoneId` is therefore BEST-EFFORT read-only, exactly like
 * `research-models-command.ts` — a missing/unreadable `.gsd/STATE.md`
 * degrades to `""`, never a hard failure, and `.gsd/STATE.md` is NEVER
 * written by this command.
 *
 * Journal is STRICTLY advisory, via kinds distinct from the loop's own
 * (S02-PLAN Interpretation Decision 5): `task_dispatched`/`task_result`, one
 * pair PER PHASE (`unit: "task-plan"` here; `task-execute` is T03's job),
 * never `unit_dispatched`/`unit_result` — those feed the pause-replay net
 * and the STATE unit view, both keyed off units `deriveNextUnit` actually
 * knows about. Best-effort — a journal write failure never blocks the
 * dispatch.
 *
 * The execute phase (S02/T03) is dispatched right after a `done` plan result
 * whose `<TASK_ID>-PLAN.md` actually landed on disk — otherwise the command
 * stops and tells the operator why (pt-BR), never dispatching execute on a
 * partial/blocked/timeout plan or a missing PLAN.md. Between the two phases
 * an ADVISORY frontmatter check (`checkTaskPlanFrontmatterAdvisory`, S01
 * consumption via `gates/plan-checker.ts`'s `scoreFrontmatterCompliance`)
 * warns on missing/invalid `domain:`/`effort:` but NEVER blocks the execute
 * dispatch (D-S04-1). After execute, `verifyTaskSummary` checks
 * `<TASK_ID>-SUMMARY.md` exists and is non-trivial (>10 lines) before the
 * outcome is reported clean — mirrors the `loop.ts` `complete-slice`/
 * `complete-milestone` D-S03-1 guard and the fix-command write-back-honesty
 * posture: never report success on unverified work.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { readState, appendEvent, resolveTaskId, readEvents, type ForgeEvent, type NextUnit } from "../state/index.js";
import { getForgeAutoSession, resolveUnitResultToolName, type ForgeAutoSession } from "../auto/session.js";
import { dispatchUnitViaNewSession, resolveDispatchAuthor } from "../auto/driver.js";
import { authorFamilyForTask } from "../auto/reviewer-independence.js";
import { readModelsConfig } from "../auto/models-config.js";
import type { ResolveModelCtx } from "../auto/role.js";
import { composePrompt, type ComposableUnit } from "../prompts/compose.js";
import { CredentialRotator } from "@forge/agent-core/credential-rotation.js";
import { isPrintHeadlessContext, restoreInteractiveSession } from "./forge-command.js";
import { splitFrontmatter, parseFrontmatterMap } from "../../shared/frontmatter.js";
import { scoreFrontmatterCompliance } from "../gates/plan-checker.js";
import { runReviewDialectic, productionReviewDispatcher, type ReviewDispatcher } from "../review/dispatch.js";
import { readReviewPrefs } from "../review/review-prefs.js";

/** Headless-aware output — same posture as `research-models-command.ts`'s `output()`. */
function output(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "success" = "info"): void {
  const ui = ctx.ui as { mode?: string } | undefined;
  const headless = !ctx.hasUI || process.env.GSD_HEADLESS === "1" || ui?.mode === "rpc" || ui?.mode === "headless";
  if (headless) {
    process.stdout.write(message + "\n");
    return;
  }
  // After a dispatch, the ORIGINAL command ctx is stale (B3) and its notify
  // dies silently — the post-dispatch report (the whole point of the command)
  // never reached the operator (finale-bug class, seen live on /forge fix S04
  // 2026-07-12: "n tem nada informativo"). Prefer the LIVE re-pointed cmdCtx,
  // fall back to the original, and NEVER drop a report — stderr as last resort.
  const live = getForgeAutoSession().cmdCtx ?? ctx;
  try {
    live.ui.notify(message, level);
  } catch {
    try {
      ctx.ui.notify(message, level);
    } catch {
      console.error(message);
    }
  }
}

const TASK_USAGE =
  '/forge task "<descrição>"  |  /forge task --list  |  /forge task --resume <ID>';

/** One task directory's derived state, for `--list` and resume gating. */
interface TaskEntry {
  id: string;
  status: "DONE" | "OPEN";
  hasPlan: boolean;
  hasSummary: boolean;
}

/**
 * Enumerate `.gsd/tasks/*` and derive each entry's completion state from the
 * SAME gates the command already enforces: a task is DONE only when its
 * `<ID>-SUMMARY.md` clears `verifyTaskSummary` (>10 non-blank lines) — anything
 * else is OPEN and resumable. Never throws: a missing `.gsd/tasks/` yields [].
 */
function listTaskEntries(cwd: string): TaskEntry[] {
  const tasksDir = join(cwd, ".gsd", "tasks");
  let names: string[];
  try {
    names = readdirSync(tasksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  names.sort();
  return names.map((id) => {
    const hasPlan = verifyTaskPlan(join(tasksDir, id, `${id}-PLAN.md`)).ok;
    const summaryCheck = verifyTaskSummary(cwd, id);
    return { id, status: summaryCheck.ok ? "DONE" : "OPEN", hasPlan, hasSummary: summaryCheck.ok };
  });
}

/**
 * Resolve an operator-typed task reference to an actual directory name. Accepts
 * the exact id (`TASK-148`, `T-2026…-slug`), a case-insensitive match, or a
 * bare/partial token (`148`) matched against the numeric tail of legacy
 * `TASK-###` ids or as a unique substring of any id. Returns the resolved id,
 * `null` when nothing matches, or `{ ambiguous }` when a token matches >1 task
 * (so the caller can list the candidates instead of guessing).
 */
function resolveExistingTaskId(
  cwd: string,
  needle: string,
): { id: string } | { ambiguous: string[] } | null {
  const entries = listTaskEntries(cwd).map((e) => e.id);
  if (entries.length === 0) return null;
  const raw = needle.trim();
  if (!raw) return null;

  // 1. Exact, then case-insensitive exact.
  if (entries.includes(raw)) return { id: raw };
  const ciExact = entries.filter((id) => id.toLowerCase() === raw.toLowerCase());
  if (ciExact.length === 1) return { id: ciExact[0] };

  // 2. Bare number → legacy TASK-### (with/without zero-pad) or numeric tail.
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    const numMatches = entries.filter((id) => {
      const m = id.match(/(?:^|[-_])0*(\d+)$/);
      return m ? parseInt(m[1], 10) === n : false;
    });
    if (numMatches.length === 1) return { id: numMatches[0] };
    if (numMatches.length > 1) return { ambiguous: numMatches };
  }

  // 3. Unique substring (case-insensitive) — covers a typed slug or prefix.
  const subMatches = entries.filter((id) => id.toLowerCase().includes(raw.toLowerCase()));
  if (subMatches.length === 1) return { id: subMatches[0] };
  if (subMatches.length > 1) return { ambiguous: subMatches };

  return null;
}

/**
 * Recover the original operator request from `<ID>-TASK.md`'s `## Descrição`
 * section (written by `writeTaskDescriptor`). Resume needs the desc for the
 * review phase's diff-scoping and for honest journaling. Falls back to the id
 * when the descriptor is missing/unreadable — resume must never hard-fail on a
 * cosmetic recovery.
 */
function recoverTaskDesc(cwd: string, id: string): string {
  const descriptorPath = join(cwd, ".gsd", "tasks", id, `${id}-TASK.md`);
  try {
    const text = readFileSync(descriptorPath, "utf-8");
    const marker = text.indexOf("## Descrição");
    if (marker >= 0) {
      const body = text
        .slice(text.indexOf("\n", marker) + 1)
        .trim();
      if (body) return body;
    }
  } catch {
    // fall through to the id
  }
  return id;
}

/** The outcome of one dispatched phase — either a delivered result or a synthetic timeout, plus the resolved TASK_ID. */
export interface TaskPhaseOutcome {
  taskId: string;
  status: string;
  summary: string;
  artifacts: string[];
}

/**
 * "G1 do git" (S03/T01), same pattern as `auto/loop.ts`'s `stampUnitSha`:
 * best-effort HEAD sha, undefined without git (never throws on its own —
 * callers already wrap journal writes in try/catch, this just adds one more
 * fallible read to that same envelope).
 */
function bestEffortHeadSha(cwd: string): string | undefined {
  try {
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort advisory dispatch marker (never throws — same posture as
 * `driver.ts`'s `journalStaleCancel`). `unit` is ALWAYS `"task-plan"`/
 * `"task-execute"` (the phase, not the TASK_ID) — the TASK_ID lives in
 * `summary` so a single `task_dispatched`/`task_result` pair per phase is
 * unambiguous per S02-PLAN Interpretation Decision 5. `task`/`sha` (S03/T01)
 * are stamped so `journalRangeDiffCmd` can derive the task's exact commit
 * range for the review dialectic — both are pre-existing additive
 * `ForgeEvent` fields, no type change.
 */
function journalDispatched(
  cwd: string,
  milestoneId: string,
  unit: "task-plan" | "task-execute",
  taskId: string,
  author: { model: string | null; provider: string | null; family: string | null },
): void {
  try {
    const ev: ForgeEvent = {
      ts: new Date().toISOString(),
      kind: "task_dispatched",
      unit,
      agent: "forge-command",
      milestone: milestoneId,
      task: taskId,
      status: "dispatched",
      summary: `Dispatch de ${unit} para ${taskId} via /forge task.`,
    };
    if (author.model) ev.model = author.model;
    if (author.provider) ev.provider = author.provider;
    if (author.family) ev.family = author.family;
    const sha = bestEffortHeadSha(cwd);
    if (sha) ev.sha = sha;
    appendEvent(cwd, ev);
  } catch {
    /* best-effort journaling — never blocks the dispatch path */
  }
}

/** Best-effort advisory result marker. Same never-throws posture as `journalDispatched`. */
function journalResult(
  cwd: string,
  milestoneId: string,
  unit: "task-plan" | "task-execute",
  taskId: string,
  status: string,
  summary: string,
): void {
  try {
    const ev: ForgeEvent = {
      ts: new Date().toISOString(),
      kind: "task_result",
      unit,
      agent: "forge-command",
      milestone: milestoneId,
      task: taskId,
      status,
      summary: `[${taskId}] ${summary}`,
    };
    const sha = bestEffortHeadSha(cwd);
    if (sha) ev.sha = sha;
    appendEvent(cwd, ev);
  } catch {
    /* best-effort journaling — never blocks the command's output */
  }
}

/**
 * Atomically reserves `.gsd/tasks/<taskId>` (S02-REVIEW R1): `mkdirSync`
 * WITHOUT `recursive` throws `EEXIST` if the directory is already taken,
 * closing the gap where a same-second collision (repeated/concurrent
 * invocations, or a stale directory left by a prior run) would otherwise be
 * silently accepted and reuse whatever stale PLAN/SUMMARY artifacts already
 * live there. On collision, retries with a numeric suffix appended to the
 * base id (`<id>-2`, `<id>-3`, …) — still `isValid`/`classify`-compatible,
 * since both accept an arbitrary trailing `-[a-z0-9-]*` slug.
 */
function reserveTaskDir(cwd: string, baseTaskId: string): { taskId: string; taskDir: string } {
  mkdirSync(join(cwd, ".gsd", "tasks"), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const taskId = attempt === 0 ? baseTaskId : `${baseTaskId}-${attempt + 1}`;
    const taskDir = join(cwd, ".gsd", "tasks", taskId);
    try {
      mkdirSync(taskDir);
      return { taskId, taskDir };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Collision — the directory already exists (stale or concurrent), retry with the next suffix.
    }
  }
  throw new Error(`/forge task: could not reserve a task directory for ${baseTaskId} (100 collisions)`);
}

/**
 * Write `<taskDir>/<taskId>-TASK.md` with the operator's request — plain
 * markdown, written BEFORE any dispatch so the `task-plan` worker always has
 * a descriptor to read. The directory itself is reserved by
 * `reserveTaskDir` — this function only writes into it.
 */
function writeTaskDescriptor(taskDir: string, taskId: string, desc: string): void {
  const body = [
    `# ${taskId}`,
    "",
    `- Criada em: ${new Date().toISOString()}`,
    "- Solicitado por: /forge task (operador interativo)",
    "",
    "## Descrição",
    "",
    desc,
    "",
  ].join("\n");
  writeFileSync(join(taskDir, `${taskId}-TASK.md`), body);
}

/**
 * Shared core for `dispatchTaskPlanPhase`/`dispatchTaskExecutePhase` (S02/T03
 * DRY Guard): the resolve→journal→compose→dispatch→journal sequence is
 * IDENTICAL for both phases, differing only in which `ComposableUnit`
 * variant is dispatched. Assumes the container is ALREADY bootstrapped
 * (`session.active`/`cmdCtx`/`cwd`/… set by the caller) — mirrors the
 * dispatch block inside `runResearchModelsCommand`/`runFixCommand`.
 */
async function dispatchTaskPhase(
  ctx: ExtensionCommandContext,
  session: ForgeAutoSession,
  taskId: string,
  milestoneId: string,
  phase: "task-plan" | "task-execute",
): Promise<TaskPhaseOutcome> {
  const unit: ComposableUnit = { type: phase, taskId };

  // Resolve authorship BEFORE publishing `currentUnit` — same discipline as
  // research-models-command.ts/fix-command.ts. Re-resolved per phase, never
  // carried over from a prior phase's dispatch.
  const resolved = resolveDispatchAuthor(session, unit, Date.now());
  session.currentUnit = unit;

  journalDispatched(ctx.cwd, milestoneId, phase, taskId, resolved);

  const resultToolName = resolveUnitResultToolName(session, unit);
  const dispatchAuthorRef = resolved.model ?? resolved.provider ?? undefined;
  const prompt = composePrompt(unit, {
    cwd: ctx.cwd,
    milestoneId,
    resultToolName,
    dispatchAuthorRef,
  });

  const outcome = await dispatchUnitViaNewSession(session, unit, prompt);
  const result =
    outcome.kind === "timeout"
      ? {
          status: "timeout",
          summary: "Worker não emitiu forge_unit_result antes do timeout.",
          artifacts: [] as string[],
        }
      : outcome.result;

  journalResult(ctx.cwd, milestoneId, phase, taskId, result.status, result.summary);

  return { taskId, status: result.status, summary: result.summary, artifacts: result.artifacts };
}

/**
 * Dispatch the `task-plan` phase for `taskId` through the production driver
 * and return its outcome. Originally factored out in T02 so T03's
 * `task-execute` chain could reuse the exact same shape without duplicating
 * the resolve→journal→compose→dispatch→journal sequence — now a thin wrapper
 * over the shared `dispatchTaskPhase` core (T03).
 */
export async function dispatchTaskPlanPhase(
  ctx: ExtensionCommandContext,
  session: ForgeAutoSession,
  taskId: string,
  milestoneId: string,
): Promise<TaskPhaseOutcome> {
  return dispatchTaskPhase(ctx, session, taskId, milestoneId, "task-plan");
}

/**
 * Dispatch the `task-execute` phase for `taskId` through the production
 * driver and return its outcome. Called ONLY after a `done` plan result whose
 * `<TASK_ID>-PLAN.md` exists on disk (see `runTaskCommand`'s gate) — this
 * function itself does not re-check that precondition.
 */
export async function dispatchTaskExecutePhase(
  ctx: ExtensionCommandContext,
  session: ForgeAutoSession,
  taskId: string,
  milestoneId: string,
): Promise<TaskPhaseOutcome> {
  return dispatchTaskPhase(ctx, session, taskId, milestoneId, "task-execute");
}

/**
 * Shared frontmatter-map extraction (DRY Guard, S03/T02): both
 * `checkTaskPlanFrontmatterAdvisory` and the review phase's best-effort
 * `domain:` read need the same `splitFrontmatter`/`parseFrontmatterMap`
 * sequence over `<TASK_ID>-PLAN.md`'s content — factored out instead of
 * duplicated. Pure over an already-read string; never throws.
 */
function taskPlanFrontmatter(content: string): Record<string, unknown> {
  const [fmLines] = splitFrontmatter(content);
  return fmLines ? parseFrontmatterMap(fmLines) : {};
}

/**
 * S01 consumption — ADVISORY frontmatter check on `<TASK_ID>-PLAN.md`,
 * between the plan and execute phases. Reuses `gates/plan-checker.ts`'s
 * `scoreFrontmatterCompliance` (the exact domain/effort rubric `S##-PLAN`
 * task frontmatter is scored against) via a minimal single-task adapter
 * instead of re-deriving the `EFFORT_LEVELS` vocabulary locally (Helper-First
 * Protocol). With only one task in the array, `countToVerdict` can only ever
 * return `"pass"` or `"warn"` — `"fail"` requires ≥2 bad tasks — so this
 * check can never surface as anything but advisory, by construction.
 * Try/catch, best-effort: a parse failure degrades to "no warning" (silent
 * pass) rather than surfacing a spurious one — NEVER blocks (D-S04-1).
 */
function checkTaskPlanFrontmatterAdvisory(planPath: string, taskId: string): string | null {
  try {
    const content = readFileSync(planPath, "utf-8");
    const frontmatter = taskPlanFrontmatter(content);
    const score = scoreFrontmatterCompliance([
      {
        id: taskId,
        planPath,
        exists: true,
        content,
        frontmatter,
        depends: [],
        expectedOutput: [],
        goalNonEmpty: true,
        isLegacy: false,
        mustHavesValid: true,
        mustHavesErrors: [],
        truths: [],
        bodyText: content.toLowerCase(),
      },
    ]);
    if (score.verdict === "pass") return null;
    return `⚠ plano da task sem domain:/effort: — ${score.justification}`;
  } catch {
    return null;
  }
}

/**
 * Post-execute write-back honesty check (fix-command R1–R3 posture; S02-PLAN
 * Notes' "write-back" requisito): `<TASK_ID>-SUMMARY.md` must exist AND be
 * non-trivial (>10 NON-BLANK lines, S02-REVIEW R4 — raw line count alone is
 * satisfiable by a skeleton of blank lines) before the execute outcome is
 * reported clean — mirrors `loop.ts`'s `complete-slice`/`complete-milestone`
 * D-S03-1 guard (never report success without the DURABLE artifact actually
 * landing). Full frontmatter/section validation is out of scope for this
 * downgrade-to-warning honesty check (R4 defesa) — belongs to a checker-class
 * gate instead.
 */
function verifyTaskSummary(cwd: string, taskId: string): { ok: boolean; reason?: string } {
  const summaryPath = join(cwd, ".gsd", "tasks", taskId, `${taskId}-SUMMARY.md`);
  if (!existsSync(summaryPath)) {
    return { ok: false, reason: `${taskId}-SUMMARY.md ausente` };
  }
  let nonBlankLines: number;
  try {
    nonBlankLines = readFileSync(summaryPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return { ok: false, reason: `${taskId}-SUMMARY.md ilegível` };
  }
  if (nonBlankLines <= 10) {
    return { ok: false, reason: `${taskId}-SUMMARY.md tem apenas ${nonBlankLines} linha(s) com conteúdo (mínimo 11)` };
  }
  return { ok: true };
}

/**
 * Pre-execute dispatch gate strengthening (S02-REVIEW R3 — conceded):
 * `<TASK_ID>-PLAN.md` is the artifact that AUTHORIZES a subsequent executor's
 * write access to the repo, so existence alone is not enough — a zero-byte or
 * truncated plan from a worker that merely claimed `done` must not dispatch
 * execute. Mirrors `verifyTaskSummary`'s >10-non-blank-line substance check
 * rather than existence-only scrutiny. `domain:`/`effort:` scoring stays
 * advisory (D-S04-1) via `checkTaskPlanFrontmatterAdvisory`, unaffected by
 * this gate.
 */
function verifyTaskPlan(planPath: string): { ok: boolean; reason?: string } {
  if (!existsSync(planPath)) {
    return { ok: false, reason: "ausente" };
  }
  let nonBlankLines: number;
  try {
    nonBlankLines = readFileSync(planPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return { ok: false, reason: "ilegível" };
  }
  if (nonBlankLines <= 10) {
    return { ok: false, reason: `tem apenas ${nonBlankLines} linha(s) com conteúdo (mínimo 11)` };
  }
  return { ok: true };
}

/**
 * Best-effort `domain:` read off `<TASK_ID>-PLAN.md` frontmatter (S03-PLAN
 * Interpretation Decision 2) — prompt-only input to the review dialectic's
 * `DOMAIN:` line, never touching `resolveModelForRole`/the reviewer rank
 * (D-S05-B). `scopeDomainFor` (milestone-path-based) is NOT applicable here:
 * a loose task has no `.gsd/milestones/` scope to read. A missing/unreadable
 * PLAN.md or absent `domain:` key degrades to `undefined` — same silent-pass
 * posture as `checkTaskPlanFrontmatterAdvisory`, never a hard failure.
 */
function readTaskDomainAdvisory(cwd: string, taskId: string): string | undefined {
  try {
    const planPath = join(cwd, ".gsd", "tasks", taskId, `${taskId}-PLAN.md`);
    const domain = taskPlanFrontmatter(readFileSync(planPath, "utf-8")).domain;
    return typeof domain === "string" && domain.length > 0 ? domain : undefined;
  } catch {
    return undefined;
  }
}

/** Mirrors `ReviewCommandOptions` (`review-command.ts`) — test seams so unit tests never spawn real sessions. */
export interface TaskCommandOptions {
  /** Test seam; production always uses `productionReviewDispatcher(ctx)`. */
  reviewDispatcher?: ReviewDispatcher;
  /** Test seam for deterministic model casting in the review phase. */
  resolveContext?: ResolveModelCtx;
}

/**
 * S03/T02 — advisory review phase: runs the EXISTING native dialectic
 * (`runReviewDialectic`, zero engine fork — S03-PLAN §Context locked
 * decision) over the task's own journaled diff range
 * (`taskId` threaded through to `computeReviewDiffCmd`, S03/T01) and persists
 * `<TASK_ID>-REVIEW.md` in the store. Called unconditionally after
 * `dispatchTaskExecutePhase` returns, regardless of `executeResult.status`
 * (S03-PLAN Interpretation Decision 3 — a thin/missing SUMMARY must never
 * suppress the review), and BEFORE `verifyTaskSummary`'s early-return.
 *
 * Composition mirrors `review-command.ts`'s `runReviewCommand` exactly: a
 * synthetic `{ type: "complete-slice", slice: taskId }` unit for
 * `resolveModelForRole`, `authorFamilyForTask` (not `authorFamilyForSlice` —
 * the loose-task event family) for `reviewer_not_author`, best-effort
 * `domain:` from the PLAN frontmatter, `readReviewPrefs(cwd).rounds`.
 *
 * Wrapped in its own try/catch: ANY throw degrades to a pt-BR warning and
 * never mutates `executeResult`/the command's reported outcome — the
 * dialectic itself already degrades internal failures (cast errors, dispatch
 * errors, no-diff) into a DECLARED stub rather than throwing, so this catch
 * is a defensive backstop, not the primary failure path.
 */
async function runTaskReviewPhase(
  ctx: ExtensionCommandContext,
  session: ForgeAutoSession,
  taskId: string,
  desc: string,
  milestoneId: string,
  options: TaskCommandOptions,
): Promise<void> {
  try {
    const unit: NextUnit = { type: "complete-slice", slice: taskId };
    const authorFamily = authorFamilyForTask(readEvents(ctx.cwd), taskId);
    const domain = readTaskDomainAdvisory(ctx.cwd, taskId);
    const sliceTitle = desc.split("\n")[0]?.trim() || taskId;
    const writePath = join(ctx.cwd, ".gsd", "tasks", taskId, `${taskId}-REVIEW.md`);
    const resolveContext = options.resolveContext ?? { session, config: readModelsConfig(ctx.cwd) };
    // Keep the resolve context's session cwd aligned — same defensive line
    // `runReviewCommand` runs, in case a test seam supplies a bare session.
    resolveContext.session.cwd = ctx.cwd;

    const dialectic = await runReviewDialectic({
      cwd: ctx.cwd,
      milestoneId,
      slice: taskId,
      sliceTitle,
      unit,
      ctxForResolve: resolveContext,
      dispatcher: options.reviewDispatcher ?? productionReviewDispatcher(ctx),
      reviewedOn: new Date().toISOString().slice(0, 10),
      rounds: readReviewPrefs(ctx.cwd).rounds,
      authorFamily,
      artifactTarget: { writePath },
      domain,
      taskId,
    });

    const counts = dialectic.result.counts;
    output(
      ctx,
      `⚖ Review de ${taskId}: ${counts.resolved} resolvido(s), ${counts.conceded} concedido(s), ${counts.open} aberto(s) — ${writePath}`,
    );
    if (dialectic.warnings.length > 0) {
      output(ctx, `⚠ review de ${taskId} com aviso(s): ${dialectic.warnings.join("; ")}`, "warning");
    }
  } catch (err) {
    output(ctx, `⚠ review da task falhou: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}

/**
 * Best-effort milestone id (S02-PLAN Interpretation Decision 3, mirrors
 * D-S04-1): this command never requires an active milestone. A missing or
 * unreadable STATE.md degrades to "", which `identityBlock` (prompts/
 * compose.ts) reads as "omit the Milestone line".
 */
function readMilestoneIdBestEffort(cwd: string): string {
  const statePath = join(cwd, ".gsd", "STATE.md");
  if (existsSync(statePath)) {
    try {
      return readState(cwd).milestone;
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Bootstrap the shared session container — mirrors runResearchModelsCommand/
 * runFixCommand/runAuto exactly. Identical for a fresh mint and a resume, so
 * both paths share it instead of duplicating the field-by-field setup.
 */
function bootstrapTaskSession(
  ctx: ExtensionCommandContext,
  session: ForgeAutoSession,
  milestoneId: string,
): void {
  session.active = true;
  session.cmdCtx = ctx;
  session.runRootSessionPath = ctx.sessionManager?.getSessionFile?.() ?? null;
  session.cwd = ctx.cwd;
  session.milestoneId = milestoneId;
  session.baselineModel = ctx.model ?? undefined;
  session.authStorageForOverride = ctx.modelRegistry?.authStorage ?? null;
  session.credentialRotator = ctx.modelRegistry?.authStorage
    ? new CredentialRotator(ctx.modelRegistry.authStorage)
    : null;
  session.providerReadiness = ctx.modelRegistry
    ? ((provider: string) => ctx.modelRegistry!.isProviderRequestReady(provider))
    : null;
}

/**
 * Shared plan→execute→review→report pipeline for both the fresh mint and the
 * resume. `startAtExecute` skips the plan dispatch when the caller has already
 * verified a substantive `<ID>-PLAN.md` on disk (resume path) — every other
 * step, including the advisory frontmatter check, the review dialectic, and the
 * write-back honesty gate, is IDENTICAL to a fresh task. Assumes the container
 * is already bootstrapped; the caller owns the `finally` restore.
 */
async function runTaskPipeline(
  ctx: ExtensionCommandContext,
  session: ForgeAutoSession,
  taskId: string,
  desc: string,
  milestoneId: string,
  options: TaskCommandOptions,
  startAtExecute: boolean,
): Promise<void> {
  const taskPlanPath = join(ctx.cwd, ".gsd", "tasks", taskId, `${taskId}-PLAN.md`);

  if (!startAtExecute) {
    const planResult = await dispatchTaskPlanPhase(ctx, session, taskId, milestoneId);

    // Gate: execute dispatches ONLY on a `done` plan result whose PLAN.md
    // actually landed on disk AND is non-trivial (R3 — existence alone is not
    // enough for the artifact that authorizes execute's write access).
    const planCheck: { ok: boolean; reason?: string } =
      planResult.status === "done" ? verifyTaskPlan(taskPlanPath) : { ok: false };
    if (!planCheck.ok) {
      const reason =
        planResult.status !== "done"
          ? `plano não concluído (${planResult.status})`
          : `${taskId}-PLAN.md ${planCheck.reason}`;
      output(ctx, `/forge task ${taskId}: ${reason} — execução não despachada.`, "warning");
      return;
    }
  }

  // S01 consumption — advisory-only, wrapped so a scoring failure can never
  // block the execute dispatch (D-S04-1).
  const advisoryWarning = checkTaskPlanFrontmatterAdvisory(taskPlanPath, taskId);
  if (advisoryWarning) output(ctx, advisoryWarning, "warning");

  const executeResult = await dispatchTaskExecutePhase(ctx, session, taskId, milestoneId);

  // Review phase (S03-PLAN Interpretation Decision 3): runs on EVERY completed
  // execute phase, before the verifyTaskSummary early-return, so a thin/missing
  // SUMMARY can never suppress the review — advisory only.
  await runTaskReviewPhase(ctx, session, taskId, desc, milestoneId, options);

  // Write-back honesty (fix-command R1–R3 posture): a missing/thin SUMMARY
  // downgrades the reported outcome to a warning naming exactly what's absent.
  const summaryCheck = verifyTaskSummary(ctx.cwd, taskId);
  if (!summaryCheck.ok) {
    output(
      ctx,
      `/forge task ${taskId}: aviso — execução reportou "${executeResult.status}" mas ${summaryCheck.reason} — resultado não confiável.`,
      "warning",
    );
    return;
  }

  const artifactsSuffix = executeResult.artifacts.length > 0 ? ` (${executeResult.artifacts.join(", ")})` : "";
  output(
    ctx,
    `/forge task ${taskId}: ${executeResult.status} — ${executeResult.summary}${artifactsSuffix}`,
    executeResult.status === "done" ? "info" : "warning",
  );
}

/**
 * `/forge task --list` — enumerate `.gsd/tasks/*` with each entry's OPEN/DONE
 * state and which artifacts landed. No dispatch, no session bootstrap.
 */
function runTaskListSubcommand(ctx: ExtensionCommandContext): void {
  const entries = listTaskEntries(ctx.cwd);
  if (entries.length === 0) {
    output(ctx, "/forge task: nenhuma task em .gsd/tasks/.", "info");
    return;
  }
  const lines = entries.map((e) => {
    const marks = `${e.hasPlan ? "plan" : "—"}/${e.hasSummary ? "summary" : "—"}`;
    return `  ${e.status.padEnd(4)}  ${e.id}   [${marks}]`;
  });
  const open = entries.filter((e) => e.status === "OPEN").length;
  output(
    ctx,
    `Tasks (${entries.length}, ${open} aberta(s)):\n${lines.join("\n")}\n\nRetomar uma aberta: /forge task --resume <ID>`,
    "info",
  );
}

/**
 * `/forge task --resume <ID>` — continue an EXISTING task instead of minting a
 * new id. Resolves the operator's reference to a real directory, recovers the
 * original request from its descriptor, and enters `runTaskPipeline` at the
 * first phase whose artifact is missing: straight to execute when a substantive
 * PLAN.md already exists, otherwise from plan. A task that already has a valid
 * SUMMARY is reported complete and left untouched.
 */
async function runTaskResumeSubcommand(
  ctx: ExtensionCommandContext,
  session: ForgeAutoSession,
  tokens: string[],
  options: TaskCommandOptions,
): Promise<void> {
  const needle = tokens.join(" ").trim().replace(/^["'](.*)["']$/, "$1").trim();
  if (!needle) {
    output(ctx, "Uso: /forge task --resume <ID>  (veja os IDs com /forge task --list)", "warning");
    return;
  }
  const resolved = resolveExistingTaskId(ctx.cwd, needle);
  if (resolved === null) {
    output(ctx, `/forge task --resume: nenhuma task casou "${needle}". Veja /forge task --list.`, "warning");
    return;
  }
  if ("ambiguous" in resolved) {
    output(
      ctx,
      `/forge task --resume: "${needle}" é ambíguo — casou ${resolved.ambiguous.join(", ")}. Use o ID completo.`,
      "warning",
    );
    return;
  }

  const taskId = resolved.id;
  if (verifyTaskSummary(ctx.cwd, taskId).ok) {
    output(ctx, `/forge task ${taskId}: já concluída (SUMMARY presente) — nada a retomar.`, "info");
    return;
  }
  const planOk = verifyTaskPlan(join(ctx.cwd, ".gsd", "tasks", taskId, `${taskId}-PLAN.md`)).ok;
  const desc = recoverTaskDesc(ctx.cwd, taskId);
  const milestoneId = readMilestoneIdBestEffort(ctx.cwd);

  bootstrapTaskSession(ctx, session, milestoneId);
  output(
    ctx,
    `/forge task ${taskId}: retomando a partir de ${planOk ? "execute" : "plan"} (plano ${planOk ? "presente" : "ausente"}).`,
    "info",
  );
  try {
    await runTaskPipeline(ctx, session, taskId, desc, milestoneId, options, planOk);
  } finally {
    await restoreInteractiveSession(session);
  }
}

/**
 * Run `/forge task` — three shapes: `--list` (enumerate), `--resume <ID>`
 * (continue an existing task), or `"<descrição>"` (mint a fresh one).
 *
 * `session` is a test seam (default the process singleton, mirrors
 * `runResearchModelsCommand`/`runFixCommand`/`runAuto`); `options` (S03/T02)
 * is a second test seam mirroring `ReviewCommandOptions`, kept as a trailing
 * 4th parameter so every existing 3-positional-argument call site (11
 * pre-S03/T02 tests) stays byte-compatible.
 */
export async function runTaskCommand(
  ctx: ExtensionCommandContext,
  rest: string[],
  session: ForgeAutoSession = getForgeAutoSession(),
  options: TaskCommandOptions = {},
): Promise<void> {
  const tokens = rest.filter((t) => t.trim().length > 0);
  const flag = tokens[0]?.toLowerCase();

  // `--list` needs neither the reentrancy guard nor a bootstrap — it only reads.
  if (flag === "--list" || flag === "-l") {
    runTaskListSubcommand(ctx);
    return;
  }

  // Guard de reentrância — mesmo texto-padrão do runAuto/research-models/fix.
  // Applies to BOTH resume and fresh dispatch (either bootstraps the loop).
  if (session.active) {
    output(ctx, "/forge task: loop já ativo — aguarde a execução atual terminar.", "warning");
    return;
  }

  if (flag === "--resume" || flag === "-r") {
    await runTaskResumeSubcommand(ctx, session, tokens.slice(1), options);
    return;
  }

  // Default: mint a fresh task from the description.
  const desc = tokens.join(" ").trim().replace(/^["'](.*)["']$/, "$1").trim();
  if (!desc) {
    output(ctx, `Uso: ${TASK_USAGE}`, "warning");
    return;
  }

  const milestoneId = readMilestoneIdBestEffort(ctx.cwd);

  // Mint the ID, atomically reserve its directory (R1 — closes the
  // same-second/stale-directory collision gap), and write the descriptor
  // BEFORE any dispatch — the `task-plan` worker's first artifact to read.
  const { taskId, taskDir } = reserveTaskDir(ctx.cwd, resolveTaskId(ctx.cwd, desc));
  writeTaskDescriptor(taskDir, taskId, desc);

  bootstrapTaskSession(ctx, session, milestoneId);
  try {
    await runTaskPipeline(ctx, session, taskId, desc, milestoneId, options, false);
  } finally {
    // R2 (shared with runAuto/research-models/fix): restore tools/model/
    // thinkingLevel then s.reset() — every exit path, including a throw, runs
    // this. One bootstrap, one restore, covering both phases.
    await restoreInteractiveSession(session);
  }
}
