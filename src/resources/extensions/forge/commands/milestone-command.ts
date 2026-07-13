/**
 * `/forge milestone start <MID>` — dispatches the milestone planner after the
 * operator has reviewed its CONTEXT. This is deliberately a direct-dispatch
 * front-end: `plan-milestone` is composable but is not part of the auto-loop's
 * `deriveNextUnit` table.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { deriveNextUnit, parseRoadmap, readState, resolveMilestoneId, updateState, appendEvent, type ForgeEvent } from "../state/index.js";
import { getForgeAutoSession, resolveUnitResultToolName, type ForgeAutoSession } from "../auto/session.js";
import { dispatchUnitViaNewSession, resolveDispatchAuthor } from "../auto/driver.js";
import { milestoneComplete } from "../auto/housekeeping.js";
import { scopeDomainFor } from "../auto/scope-domain.js";
import { composePrompt, type ComposableUnit } from "../prompts/compose.js";
import { splitFrontmatter, parseFrontmatterMap } from "../../shared/frontmatter.js";
import { listGestations } from "../state/gestation.js";
import { CredentialRotator } from "@forge/agent-core/credential-rotation.js";
import { isPrintHeadlessContext, restoreInteractiveSession } from "./forge-command.js";

const MILESTONE_USAGE = '/forge milestone "<descrição>" | start <MID>';
const PLAN_MILESTONE_UNIT = "plan-milestone";
const MILESTONE_CONTEXT_UNIT = "milestone-context";

type DispatchAuthor = { model: string | null; provider: string | null; family: string | null };

/**
 * Headless-aware report, using the live replacement context after dispatch.
 * Prefers the injected `session`'s own `cmdCtx` (set by `bootstrapDispatchSession`
 * on that exact session) over the module singleton, so a caller running with a
 * non-default injected session never routes notifications through another
 * session's live context.
 */
function output(
  ctx: ExtensionCommandContext,
  session: ForgeAutoSession,
  message: string,
  level: "info" | "warning" | "success" = "info",
): void {
  if (isPrintHeadlessContext(ctx)) {
    process.stdout.write(message + "\n");
    return;
  }

  const live = session.cmdCtx ?? ctx;
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

/** Best-effort HEAD marker; journaling must work outside a git worktree too. */
function bestEffortHeadSha(cwd: string): string | undefined {
  try {
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/** Add only the shared authorship fields when the resolver supplied them. */
function stampAuthor(event: ForgeEvent, author: DispatchAuthor): void {
  if (author.model) event.model = author.model;
  if (author.provider) event.provider = author.provider;
  if (author.family) event.family = author.family;
}

/**
 * Normal plan-milestone journal marker. It intentionally has no `slice` or
 * `task`: T01 proved either field would make replay reconstruct a loop unit.
 */
function journalDispatched(cwd: string, milestoneId: string, author: DispatchAuthor): void {
  try {
    const event: ForgeEvent = {
      ts: new Date().toISOString(),
      kind: "unit_dispatched",
      unit: PLAN_MILESTONE_UNIT,
      agent: "forge-command",
      milestone: milestoneId,
      status: "dispatched",
      summary: `Dispatch de plan-milestone para ${milestoneId} via /forge milestone start.`,
    };
    stampAuthor(event, author);
    const sha = bestEffortHeadSha(cwd);
    if (sha) event.sha = sha;
    appendEvent(cwd, event);
  } catch {
    /* Best-effort journaling never blocks the planner dispatch. */
  }
}

/** Result companion to `journalDispatched`, also deliberately slice/task-free. */
function journalResult(
  cwd: string,
  milestoneId: string,
  author: DispatchAuthor,
  status: string,
  summary: string,
): void {
  try {
    const event: ForgeEvent = {
      ts: new Date().toISOString(),
      kind: "unit_result",
      unit: PLAN_MILESTONE_UNIT,
      agent: "forge-command",
      milestone: milestoneId,
      status,
      summary,
    };
    stampAuthor(event, author);
    const sha = bestEffortHeadSha(cwd);
    if (sha) event.sha = sha;
    appendEvent(cwd, event);
  } catch {
    /* Best-effort journaling never blocks the command report. */
  }
}

/**
 * Returns an honest readability check for a ROADMAP file. Non-triviality is
 * enforced downstream by structure — `parseRoadmap` + the caller's
 * `slices.length === 0` check — rather than a raw line-count guess, so a
 * legitimately concise (short vision + one-row Slices table) roadmap is
 * never rejected as "too few lines" before its structure is even read.
 */
function verifyRoadmap(roadmapPath: string): { ok: boolean; content?: string; reason?: string } {
  if (!existsSync(roadmapPath)) return { ok: false, reason: "ROADMAP ausente" };
  try {
    const content = readFileSync(roadmapPath, "utf-8");
    return { ok: true, content };
  } catch {
    return { ok: false, reason: "ROADMAP ilegível" };
  }
}

/** A CONTEXT needs at least one meaningful line before a planner may consume it. */
function hasContent(path: string): boolean {
  try {
    return readFileSync(path, "utf-8").split("\n").some((line) => line.trim().length > 0);
  } catch {
    return false;
  }
}

/** Atomically reserve a new milestone directory, retrying same-second collisions. */
function reserveMilestoneDir(cwd: string, baseMilestoneId: string): { milestoneId: string; milestoneDir: string } {
  mkdirSync(join(cwd, ".gsd", "milestones"), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const milestoneId = attempt === 0 ? baseMilestoneId : `${baseMilestoneId}-${attempt + 1}`;
    const milestoneDir = join(cwd, ".gsd", "milestones", milestoneId);
    try {
      mkdirSync(milestoneDir);
      return { milestoneId, milestoneDir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`/forge milestone: não foi possível reservar um diretório para ${baseMilestoneId} (100 colisões)`);
}

/** Persist the verbatim operator request before the context worker is dispatched. */
function writeMilestoneRequest(milestoneDir: string, milestoneId: string, description: string): void {
  const body = [
    `# ${milestoneId}`,
    "",
    `- Criada em: ${new Date().toISOString()}`,
    "- Solicitado por: /forge milestone (operador interativo)",
    "",
    "## Descrição",
    "",
    description,
    "",
  ].join("\n");
  writeFileSync(join(milestoneDir, `${milestoneId}-REQUEST.md`), body);
}

/** Best-effort porcelain snapshot; repositories without git simply skip the sweep. */
function gitStatusSnapshot(cwd: string): Set<string> | null {
  try {
    return new Set(
      execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" })
        .split("\n")
        .filter((line) => line.length > 0),
    );
  } catch {
    return null;
  }
}

/** Return only porcelain entries introduced while the worker was running. */
function newGitStatusEntries(before: Set<string> | null, after: Set<string> | null): string[] {
  if (!before || !after) return [];
  return [...after].filter((entry) => !before.has(entry));
}

/**
 * R3 (S02 review): `.gsd/` is gitignored in this repo, so porcelain never
 * sees a worker mutating `.gsd/STATE.md` — byte-snapshot it directly as the
 * backstop porcelain cannot provide.
 */
function snapshotFileBytes(path: string): Buffer | null {
  try {
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

/** True when the STATE.md snapshot changed (created, deleted, or edited). */
function stateBytesChanged(before: Buffer | null, after: Buffer | null): boolean {
  if (before === null || after === null) return before !== after;
  return !before.equals(after);
}

/**
 * R5 (S02 review): a named minimum, checked against post-frontmatter body
 * content only — the raw line count previously let the `---` delimiters
 * themselves pad a CONTEXT past the bar with no substantive body at all.
 */
const MIN_CONTEXT_BODY_LINES = 8;

/** Verify the worker landed a substantive CONTEXT with a usable frontmatter domain. */
function verifyMilestoneContext(contextPath: string): { ok: boolean; reason?: string } {
  if (!existsSync(contextPath)) return { ok: false, reason: "CONTEXT ausente" };
  let content: string;
  try {
    content = readFileSync(contextPath, "utf-8");
  } catch {
    return { ok: false, reason: "CONTEXT ilegível" };
  }
  const [frontmatter, body] = splitFrontmatter(content);
  const nonBlankBodyLines = body.split("\n").filter((line) => line.trim().length > 0).length;
  if (nonBlankBodyLines < MIN_CONTEXT_BODY_LINES) {
    return {
      ok: false,
      reason: `CONTEXT tem apenas ${nonBlankBodyLines} linha(s) de corpo além do frontmatter (mínimo ${MIN_CONTEXT_BODY_LINES})`,
    };
  }
  const domain = frontmatter ? parseFrontmatterMap(frontmatter).domain : undefined;
  if (typeof domain !== "string" || domain.trim().length === 0) {
    return { ok: false, reason: "CONTEXT sem domain: não-vazio no frontmatter" };
  }
  return { ok: true };
}

/** Advisory journal pair for the pre-STATE milestone-context dispatch. */
function journalMilestoneContext(
  cwd: string,
  kind: "milestone_dispatched" | "milestone_result",
  milestoneId: string,
  author: DispatchAuthor,
  status: string,
  summary: string,
): void {
  try {
    const event: ForgeEvent = {
      ts: new Date().toISOString(),
      kind,
      unit: MILESTONE_CONTEXT_UNIT,
      agent: "forge-command",
      milestone: milestoneId,
      status,
      summary,
    };
    stampAuthor(event, author);
    const sha = bestEffortHeadSha(cwd);
    if (sha) event.sha = sha;
    appendEvent(cwd, event);
  } catch {
    /* Best-effort journaling never blocks the command. */
  }
}

/** Initialize the cross-session dispatch container exactly as the auto command does. */
function bootstrapDispatchSession(session: ForgeAutoSession, ctx: ExtensionCommandContext, milestoneId: string): void {
  session.active = true;
  session.cmdCtx = ctx;
  session.runRootSessionPath = ctx.sessionManager.getSessionFile() ?? null;
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

/** Create a pre-STATE milestone and dispatch its CONTEXT author through the production spine. */
async function runMilestoneBirth(
  ctx: ExtensionCommandContext,
  description: string,
  session: ForgeAutoSession,
): Promise<void> {
  const reserved = reserveMilestoneDir(ctx.cwd, resolveMilestoneId(ctx.cwd, description));
  const { milestoneId, milestoneDir } = reserved;
  writeMilestoneRequest(milestoneDir, milestoneId, description);
  const contextPath = join(milestoneDir, `${milestoneId}-CONTEXT.md`);
  const beforeStatus = gitStatusSnapshot(ctx.cwd);
  const statePath = join(ctx.cwd, ".gsd", "STATE.md");
  const beforeStateBytes = snapshotFileBytes(statePath);

  // Deliberately in-memory only: birth must never create or mutate STATE.
  bootstrapDispatchSession(session, ctx, milestoneId);
  try {
    const unit: ComposableUnit = { type: MILESTONE_CONTEXT_UNIT, milestone: milestoneId };
    const author = resolveDispatchAuthor(session, unit, Date.now());
    session.currentUnit = unit;
    journalMilestoneContext(
      ctx.cwd,
      "milestone_dispatched",
      milestoneId,
      author,
      "dispatched",
      `Dispatch de milestone-context para ${milestoneId} via /forge milestone.`,
    );

    const resultToolName = resolveUnitResultToolName(session, unit);
    const dispatchAuthorRef = author.model ?? author.provider ?? undefined;
    const prompt = composePrompt(unit, { cwd: ctx.cwd, milestoneId, resultToolName, dispatchAuthorRef });
    const outcome = await dispatchUnitViaNewSession(session, unit, prompt);
    const result =
      outcome.kind === "timeout"
        ? { status: "timeout", summary: "Worker não emitiu forge_unit_result antes do timeout.", artifacts: [] as string[] }
        : outcome.result;
    journalMilestoneContext(ctx.cwd, "milestone_result", milestoneId, author, result.status, result.summary);

    if (result.status !== "done") {
      output(ctx, session, `/forge milestone ${milestoneId}: plano de contexto não concluído (${result.status}) — ${result.summary}`, "warning");
      return;
    }

    const context = verifyMilestoneContext(contextPath);
    if (!context.ok) {
      output(ctx, session, `/forge milestone ${milestoneId}: worker reportou done, mas ${context.reason}.`, "warning");
      return;
    }

    const changedPaths = newGitStatusEntries(beforeStatus, gitStatusSnapshot(ctx.cwd));
    if (stateBytesChanged(beforeStateBytes, snapshotFileBytes(statePath))) {
      changedPaths.push(".gsd/STATE.md (byte-compare — .gsd/ é gitignored, porcelain não vê)");
    }
    if (changedPaths.length > 0) {
      output(
        ctx,
        session,
        `/forge milestone ${milestoneId}: worker tocou arquivos fora do dir da milestone: ${changedPaths.join(", ")}`,
        "warning",
      );
      return;
    }

    output(
      ctx,
      session,
      `/forge milestone ${milestoneId}: CONTEXT verificado em ${contextPath}. ${result.summary} Lapide o arquivo à vontade e confirme com /forge milestone start ${milestoneId}.`,
      "success",
    );
  } finally {
    await restoreInteractiveSession(session);
  }
}

/** Render the read-only view of milestones waiting for planning confirmation. */
function formatGestationStatus(cwd: string): string {
  const lines: string[] = [];
  const gestations = listGestations(cwd);
  if (gestations.length > 0) {
    lines.push("Milestones em gestação:");
    for (const { milestoneId } of gestations) {
      lines.push(`  · ${milestoneId} — próximo passo: /forge milestone start ${milestoneId}`);
    }
  }

  try {
    const state = readState(cwd);
    if (state.milestone) {
      if (lines.length > 0) lines.push("");
      lines.push(`Ativa: ${state.milestone} — phase: ${state.phase ?? "—"}`);
    }
  } catch {
    // An absent or unreadable STATE means there is no active milestone to show.
  }

  if (lines.length === 0) {
    return [
      "Nenhuma milestone em gestação nem ativa.",
      `Uso: ${MILESTONE_USAGE}`,
      'Para nascer uma, use /forge milestone "<descrição>".',
    ].join("\n");
  }
  return lines.join("\n");
}

/** Run `/forge milestone start <MID>` or birth a new milestone from a description. */
export async function runMilestoneCommand(
  ctx: ExtensionCommandContext,
  rest: string[],
  session: ForgeAutoSession = getForgeAutoSession(),
): Promise<void> {
  // Read-only status remains available while an unrelated command is running.
  if (rest.length === 0) {
    output(ctx, session, formatGestationStatus(ctx.cwd));
    return;
  }

  if (session.active) {
    output(ctx, session, "/forge milestone: loop já ativo — aguarde a execução atual terminar.", "warning");
    return;
  }

  if (rest[0].toLowerCase() !== "start") {
    // R4 (S02 review): only strip a matching pair of the SAME quote char —
    // asymmetric delimiters ("foo') must pass through untouched rather than
    // being silently mangled by a blind ["']...["'] strip.
    const raw = rest.join(" ").trim();
    const matchedQuotes = /^(["'])([\s\S]*)\1$/.exec(raw);
    const description = (matchedQuotes ? matchedQuotes[2] : raw).trim();
    if (!description) {
      output(ctx, session, `Uso: ${MILESTONE_USAGE}`, "warning");
      return;
    }
    await runMilestoneBirth(ctx, description, session);
    return;
  }

  const milestoneId = (rest[1] ?? "").trim();
  if (!milestoneId || rest.length !== 2) {
    output(ctx, session, `Uso: ${MILESTONE_USAGE}`, "warning");
    return;
  }

  const milestoneDir = join(ctx.cwd, ".gsd", "milestones", milestoneId);
  const contextPath = join(milestoneDir, `${milestoneId}-CONTEXT.md`);
  const roadmapPath = join(milestoneDir, `${milestoneId}-ROADMAP.md`);

  // A roadmap is the durable signal that this milestone was already planned;
  // reject it before any state/context work so a re-start can never dispatch.
  if (existsSync(roadmapPath)) {
    output(ctx, session, `/forge milestone ${milestoneId}: milestone já planejada — use /forge auto.`, "warning");
    return;
  }

  // An absent or unreadable STATE is deliberately treated as no active
  // milestone. `updateState` remains the only subsequent STATE writer.
  let state: ReturnType<typeof readState> = { milestone: "" };
  try {
    state = readState(ctx.cwd);
  } catch {
    state = { milestone: "" };
  }
  if (state.milestone && state.milestone !== milestoneId && !milestoneComplete(state, state.milestone)) {
    output(
      ctx,
      session,
      `/forge milestone ${milestoneId}: existe uma milestone ativa incompleta (${state.milestone}) — veja /forge status.`,
      "warning",
    );
    return;
  }

  if (!existsSync(milestoneDir) || !hasContent(contextPath)) {
    output(ctx, session, `/forge milestone ${milestoneId}: CONTEXT ausente ou vazio; esperado: ${contextPath}`, "warning");
    return;
  }

  bootstrapDispatchSession(session, ctx, milestoneId);

  try {
    const unit: ComposableUnit = { type: PLAN_MILESTONE_UNIT, milestone: milestoneId };
    const author = resolveDispatchAuthor(session, unit, Date.now());
    session.currentUnit = unit;
    journalDispatched(ctx.cwd, milestoneId, author);

    const resultToolName = resolveUnitResultToolName(session, unit);
    const dispatchAuthorRef = author.model ?? author.provider ?? undefined;
    const prompt = composePrompt(unit, {
      cwd: ctx.cwd,
      milestoneId,
      resultToolName,
      dispatchAuthorRef,
      scopeDomain: scopeDomainFor(ctx.cwd, milestoneId),
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

    journalResult(ctx.cwd, milestoneId, author, result.status, result.summary);

    if (result.status !== "done") {
      output(ctx, session, `/forge milestone ${milestoneId}: plan-milestone não concluído (${result.status}) — ${result.summary}`, "warning");
      return;
    }

    const roadmap = verifyRoadmap(roadmapPath);
    if (!roadmap.ok) {
      output(ctx, session, `/forge milestone ${milestoneId}: worker reportou done, mas ${roadmap.reason}.`, "warning");
      return;
    }

    let slices;
    try {
      slices = parseRoadmap(roadmap.content!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output(ctx, session, `/forge milestone ${milestoneId}: falha ao ler ROADMAP — ${message}.`, "warning");
      return;
    }
    if (slices.length === 0) {
      output(ctx, session, `/forge milestone ${milestoneId}: ROADMAP não contém nenhuma slice válida.`, "warning");
      return;
    }

    // Validate against a freshly-activated-but-unwritten snapshot (units: []
    // scoped to this milestone) — the exact shape `updateState` below will
    // write, but checked in memory first so an invalid ROADMAP never touches
    // STATE at all.
    const activatedState = { ...state, milestone: milestoneId, phase: "plan", units: [] };
    try {
      const next = deriveNextUnit(activatedState, slices, {}, {});
      if (!next || next.type !== "plan-slice") {
        const received = next?.type ?? "nenhuma unidade";
        output(ctx, session, `/forge milestone ${milestoneId}: ROADMAP inválido para dispatch — deriveNextUnit retornou ${received}.`, "warning");
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output(ctx, session, `/forge milestone ${milestoneId}: não foi possível derivar a próxima unidade — ${message}.`, "warning");
      return;
    }

    // The command's one and only STATE mutation, deferred to here (R1, S01
    // review): activation only happens once the ROADMAP is verified AND
    // confirmed dispatchable, so no failure path above can ever leave a
    // phantom active milestone in `plan` phase with no usable ROADMAP.
    updateState(ctx.cwd, (previous) => ({ ...previous, milestone: milestoneId, phase: "plan", units: [] }));

    output(
      ctx,
      session,
      `/forge milestone ${milestoneId}: ROADMAP verificado em ${roadmapPath} (${slices.length} slice(s)). Próximo passo: /forge auto`,
      "success",
    );
  } catch (error) {
    // R4 (S01 review): composePrompt/resolveDispatchAuthor/dispatch can throw
    // for operational failures too, not just programmer errors — report them
    // through the same warning UX and best-effort journal a blocked result
    // instead of letting them escape as an unhandled rejection.
    const message = error instanceof Error ? error.message : String(error);
    journalResult(ctx.cwd, milestoneId, { model: null, provider: null, family: null }, "blocked", `Exceção não tratada durante dispatch: ${message}`);
    output(ctx, session, `/forge milestone ${milestoneId}: falha inesperada durante dispatch — ${message}.`, "warning");
  } finally {
    await restoreInteractiveSession(session);
  }
}
