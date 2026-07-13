/**
 * `/forge research-models` — the FIRST command surface that dispatches a
 * `ComposableUnit` OUTSIDE the auto-loop's own derive table (S04/T04). It
 * reuses the exact production machinery `runAuto` uses — `resolveDispatchAuthor`
 * → `composePrompt` → `dispatchUnitViaNewSession` (D-S04-2) — so there is no
 * parallel dispatcher: the rendezvous, B4 ceiling, MCP bridge, and credential
 * selection are all the SAME code path `/forge auto` exercises.
 *
 * `{ type: "research-models" }` is repo-level (D-S04-1): no slice/milestone
 * binding, invocable with or without an active `.gsd/STATE.md` — the
 * capability matrix it writes (`.gsd/CAPABILITIES.md`) is repo state, not
 * milestone state. `deriveNextUnit` never sees this unit type (the hard
 * fronteira the CONTEXT names) — this command is the ONLY dispatcher.
 *
 * Journal is STRICTLY advisory, via kinds distinct from the loop's own
 * (D-S04-4): `research_models_dispatched`/`research_models_result`, never
 * `unit_dispatched`/`unit_result` — those feed the pause-replay net and the
 * STATE unit view, both keyed off units the derive actually knows about.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { readState, appendEvent, type ForgeEvent } from "../state/index.js";
import { getForgeAutoSession, resolveUnitResultToolName, type ForgeAutoSession } from "../auto/session.js";
import { dispatchUnitViaNewSession, resolveDispatchAuthor } from "../auto/driver.js";
import { composePrompt, type ComposableUnit } from "../prompts/compose.js";
import { CredentialRotator } from "@forge/agent-core/credential-rotation.js";
import { isPrintHeadlessContext, restoreInteractiveSession } from "./forge-command.js";

/** Headless-aware output — same posture as `review-command.ts`'s `output()`, reusing the shared context detector instead of re-deriving it. */
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

/** The single `{ type: "research-models" }` value this command ever dispatches (D-S04-1). */
const RESEARCH_MODELS_UNIT: ComposableUnit = { type: "research-models" };

/**
 * D-S04-4: best-effort advisory dispatch marker. Never throws — a journal
 * write failure must never block the command (same posture as
 * `driver.ts`'s `journalStaleCancel`).
 */
function journalDispatched(
  cwd: string,
  milestoneId: string,
  author: { model: string | null; provider: string | null; family: string | null },
): void {
  try {
    const ev: ForgeEvent = {
      ts: new Date().toISOString(),
      kind: "research_models_dispatched",
      unit: "research-models",
      agent: "forge-command",
      milestone: milestoneId,
      status: "dispatched",
      summary: "Dispatch de research-models via /forge research-models.",
    };
    if (author.model) ev.model = author.model;
    if (author.provider) ev.provider = author.provider;
    if (author.family) ev.family = author.family;
    appendEvent(cwd, ev);
  } catch {
    /* best-effort journaling — never blocks the dispatch path */
  }
}

/** D-S04-4: best-effort advisory result marker. Same never-throws posture as `journalDispatched`. */
function journalResult(cwd: string, milestoneId: string, status: string, summary: string): void {
  try {
    const ev: ForgeEvent = {
      ts: new Date().toISOString(),
      kind: "research_models_result",
      unit: "research-models",
      agent: "forge-command",
      milestone: milestoneId,
      status,
      summary,
    };
    appendEvent(cwd, ev);
  } catch {
    /* best-effort journaling — never blocks the command's output */
  }
}

/**
 * Run `/forge research-models`: compose the researcher's prompt and dispatch
 * it via the production driver, then report the outcome.
 *
 * `session` is a test seam (default the process singleton, mirrors `runAuto`).
 */
export async function runResearchModelsCommand(
  ctx: ExtensionCommandContext,
  session: ForgeAutoSession = getForgeAutoSession(),
): Promise<void> {
  // Guard de reentrância — mesmo texto-padrão do runAuto (forge-command.ts).
  if (session.active) {
    output(ctx, "/forge research-models: loop já ativo — aguarde a execução atual terminar.", "warning");
    return;
  }

  // D-S04-1: milestoneId is BEST-EFFORT — this unit is repo-level and never
  // requires an active milestone. A missing or unreadable STATE.md degrades
  // to "", which `identityBlock` (prompts/compose.ts) reads as "omit the
  // Milestone line" — never a hard failure.
  let milestoneId = "";
  const statePath = join(ctx.cwd, ".gsd", "STATE.md");
  if (existsSync(statePath)) {
    try {
      milestoneId = readState(ctx.cwd).milestone;
    } catch {
      milestoneId = "";
    }
  }

  // Bootstrap the container — mirrors `runAuto`'s bootstrap exactly (the ONLY
  // other command handler that ever reaches `ctx.newSession()`, B2).
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

  try {
    // Resolve authorship BEFORE publishing `currentUnit` — the same
    // resolution the driver's `s.currentUnit === unit` fallback will reuse
    // instead of re-resolving (the exact contract `auto/loop.ts` relies on).
    const resolved = resolveDispatchAuthor(session, RESEARCH_MODELS_UNIT, Date.now());
    session.currentUnit = RESEARCH_MODELS_UNIT;

    journalDispatched(ctx.cwd, milestoneId, resolved);

    const resultToolName = resolveUnitResultToolName(session, RESEARCH_MODELS_UNIT);
    const dispatchAuthorRef = resolved.model ?? resolved.provider ?? undefined;
    const prompt = composePrompt(RESEARCH_MODELS_UNIT, {
      cwd: ctx.cwd,
      milestoneId,
      resultToolName,
      dispatchAuthorRef,
    });

    const outcome = await dispatchUnitViaNewSession(session, RESEARCH_MODELS_UNIT, prompt);
    const result =
      outcome.kind === "timeout"
        ? {
            status: "timeout",
            summary: "Worker não emitiu forge_unit_result antes do timeout.",
            artifacts: [] as string[],
          }
        : outcome.result;

    journalResult(ctx.cwd, milestoneId, result.status, result.summary);

    const artifactsSuffix = result.artifacts.length > 0 ? ` (${result.artifacts.join(", ")})` : "";
    output(
      ctx,
      `/forge research-models: ${result.status} — ${result.summary}${artifactsSuffix}`,
      result.status === "done" ? "info" : "warning",
    );
  } finally {
    // R2 (shared with runAuto): restore tools/model/thinkingLevel then
    // s.reset() — every exit path, including a throw, runs this.
    await restoreInteractiveSession(session);
  }
}
