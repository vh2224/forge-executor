/**
 * `/forge fix` — give review objections a path to action (S02/T03; extended
 * to loose tasks in cockpit-v2 S03/T03+T04).
 *
 * `/forge fix` with no args LISTS the still-pending review items
 * (`open`/`conceded-sem-fix`) of BOTH universes: the active milestone (if
 * any) and every loose task under `.gsd/tasks/`. `/forge fix S##` (or
 * `S##:R#`) or `/forge fix T-<id>` (or `T-<id>:R#`) despatches ONE
 * `{ type: "review-fix"; slice; taskId? }` executor via the SAME production
 * spine `/forge research-models` uses — guard de reentrância → bootstrap do
 * container → `resolveDispatchAuthor` → `composePrompt` →
 * `dispatchUnitViaNewSession` (D-S02-1) — with the chosen items' verbatim
 * dialogue + a diff-range command inlined into the prompt (D-S02-2).
 * `deriveNextUnit` never sees `review-fix` (fronteira dura, mesma família de
 * D-S04-1): this command is the ONLY dispatcher. A slice target is
 * MILESTONE-BOUND (unlike `research-models`, which is repo-level) — it
 * requires an active `.gsd/STATE.md` milestone, since the review artifacts it
 * fixes live under that milestone's slices. A `T-<id>` target (loose task,
 * S03/T03 grammar) is repo-level like `research-models` — its dispatch (S03/
 * T04) reuses the same journal helpers with an added `task`/`sha` stamp
 * (T01 pattern) and its write-back operates on the task's own
 * `.gsd/tasks/<id>/<id>-REVIEW.md`, milestone-agnostic (`milestoneId` may be
 * `""`).
 *
 * Write-back is the COMMAND's job, never the worker's (D-S02-3): the worker
 * is forbidden from touching `S##-REVIEW.md`/`.gsd/KNOWLEDGE.md` and instead
 * reports one decision line per item, in a fixed grammar, inside its
 * `forge_unit_result` summary. `parseFixDecisions` parses that summary
 * tolerantly and `applyFixDecisions` applies each decision via
 * `applyDecision`/`applyConcededFix`/`appendReviewFollowUps` (D-S02-4). An
 * item whose decision line is missing or unparseable simply stays pending —
 * it reappears next time `/forge fix` lists (falha segura, nunca inventa
 * decisão, nunca lança).
 *
 * Journal is STRICTLY advisory (D-S02-5), via kinds distinct from the
 * loop's own: `review_fix_dispatched`/`review_fix_result`, never
 * `unit_dispatched`/`unit_result` — those feed the pause-replay net and the
 * STATE unit view, both keyed off units the derive actually knows about.
 *
 * Anti ping-pong (D-S02-6): ONE dispatch per invocation, no re-review of the
 * fix, no automatic re-dispatch on `partial`/`blocked` — the operator
 * re-runs `/forge fix` if they want another pass.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { readState, appendEvent, type ForgeEvent } from "../state/index.js";
import { getForgeAutoSession, resolveUnitResultToolName, type ForgeAutoSession } from "../auto/session.js";
import { dispatchUnitViaNewSession, resolveDispatchAuthor } from "../auto/driver.js";
import { composePrompt, type ComposableUnit } from "../prompts/compose.js";
import { CredentialRotator } from "@forge/agent-core/credential-rotation.js";
import { isPrintHeadlessContext, restoreInteractiveSession } from "./forge-command.js";
import {
  collectPendingReviewItems,
  collectPendingReviewBlocks,
  collectPendingTaskReviewItems,
  collectPendingTaskReviewBlocks,
  applyDecision,
  applyConcededFix,
  appendReviewFollowUps,
  computeReviewDiffCmd,
  reviewArtifactPath,
  type PendingReviewBlock,
  type ReviewFollowUpEntry,
} from "../review/index.js";

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

const FIX_USAGE = "/forge fix S## | S##:R# | T-<id>[:R#]";

/** Absolute path to a loose task's `.gsd/tasks/<taskId>/<taskId>-REVIEW.md`. */
function taskReviewArtifactPath(cwd: string, taskId: string): string {
  return join(cwd, ".gsd", "tasks", taskId, `${taskId}-REVIEW.md`);
}

// ── parseFixTarget — pure, testable ─────────────────────────────────────────

/** A parsed `/forge fix` argument: either a milestone slice or a loose task (S03/T03). */
export type FixTarget = { kind: "slice"; slice: string; id?: string } | { kind: "task"; taskId: string; id?: string };

const SLICE_TARGET = /^(S\d+)(?::(R\d+))?$/i;
/** `T-<14 digits>[-slug][:R#]` — the taskId's `T-`/digits are normalized, the slug's case is kept as typed. */
const TASK_TARGET = /^t-(\d{14})((?:-[a-z0-9-]+)?)(?::(r\d+))?$/i;

/**
 * Parse a `/forge fix` argument into a `FixTarget`. Accepts `S##`/`S##:R#`
 * (slice, case-insensitive, normalized to uppercase — unchanged since
 * S02/T03) or `T-<14 digits>[-slug]`/`…:R#` (loose task, S03/T03): the `T-`
 * prefix and digits normalize (so the parsed id matches the on-disk
 * `.gsd/tasks/<TASK_ID>/` directory regardless of how the operator cased the
 * `t-`), the slug is kept byte-for-byte as typed, and `R#` normalizes to
 * uppercase in both grammars. Anything else — empty, malformed, wrong shape
 * — returns `null` so the caller can reject with the usage hint.
 */
export function parseFixTarget(raw: string): FixTarget | null {
  const trimmed = raw.trim();

  const sliceMatch = SLICE_TARGET.exec(trimmed);
  if (sliceMatch) {
    const slice = sliceMatch[1].toUpperCase();
    const id = sliceMatch[2] ? sliceMatch[2].toUpperCase() : undefined;
    return id ? { kind: "slice", slice, id } : { kind: "slice", slice };
  }

  const taskMatch = TASK_TARGET.exec(trimmed);
  if (taskMatch) {
    // Generation (`slugify()`, state/ids.ts) lowercases unconditionally, so a
    // typed-case slug (accepted by this regex's `/i` flag) must normalize to
    // lowercase here too — otherwise acceptance depends on filesystem
    // case-sensitivity instead of being genuinely case-insensitive.
    const taskId = `T-${taskMatch[1]}${taskMatch[2].toLowerCase()}`;
    const id = taskMatch[3] ? taskMatch[3].toUpperCase() : undefined;
    return id ? { kind: "task", taskId, id } : { kind: "task", taskId };
  }

  return null;
}

// ── parseFixDecisions — pure, testable ──────────────────────────────────────

/** One worker-reported decision for a review item (D-S02-3 grammar). */
export interface FixDecision {
  kind: "manter" | "corrigida" | "follow-up";
  detail: string;
}

/** `R#: corrigida (commit <sha>)` | `R#: manter (razão)` | `R#: follow-up (nota)` — see `prompts/review-fix.ts`. */
const DECISION_LINE = /^(R\d+):\s*(corrigida|manter|follow-up)\s*\(([^)]*)\)\s*$/i;

/**
 * Tolerantly extract one decision per `R#` from a worker's `forge_unit_result`
 * summary text. Lines that don't match the exact grammar are ignored — never
 * thrown on, never guessed at (D-S02-3 falha segura). A later line for the
 * same id overwrites an earlier one (last-write-wins, mirrors a worker that
 * restates its summary).
 */
export function parseFixDecisions(summary: string): Map<string, FixDecision> {
  const out = new Map<string, FixDecision>();
  for (const rawLine of summary.split("\n")) {
    const m = DECISION_LINE.exec(rawLine.trim());
    if (!m) continue;
    const id = m[1].toUpperCase();
    const kind = m[2].toLowerCase() as FixDecision["kind"];
    out.set(id, { kind, detail: m[3].trim() });
  }
  return out;
}

/** Extract a commit sha from a `corrigida` decision's detail (`commit <sha>` or a bare sha). */
function extractSha(detail: string): string | null {
  const trimmed = detail.trim();
  const m = /^commit\s+(\S+)/i.exec(trimmed);
  if (m) return m[1];
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * R3: cheap syntactic-validity guard — does `sha` resolve to a real commit
 * object in the repo at `cwd`? Does NOT verify the commit contains the fix
 * (that would be the re-review the anti-ping-pong decision excludes), only
 * that the worker didn't report garbage (`commit failed`, an invented hash,
 * a sha from a different repository).
 */
function isRealCommit(cwd: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// ── applyFixDecisions — the D-S02-4 mapping ─────────────────────────────────

/**
 * Apply each decision in `decisions` to its matching item in `blocks`,
 * write-back-side (D-S02-4):
 *   - `open` item → `applyDecision` with `"<kind> (<detail>)"`, EXCEPT
 *     `follow-up`, which is deferred to a second pass (see below): the note
 *     must land in `.gsd/KNOWLEDGE.md § Review follow-ups` BEFORE the
 *     `S##-REVIEW.md` marker flips, or a failed append would permanently
 *     drop the item from `collectPendingReviewItems`' pending scan with the
 *     note lost (R1).
 *   - `conceded-sem-fix` item → ONLY a `corrigida` decision whose detail
 *     extracts a sha that ALSO resolves to a real commit object in this repo
 *     applies (`isRealCommit`, R3) — a worker reporting `commit failed`, an
 *     invented hash, or a sha from a different repository leaves the item
 *     pending instead of stamping a garbage `Correção:`. Any other decision
 *     on a conceded item is not-applicable (the conceded block's grammar has
 *     no `Decisão:` field to write manter/follow-up into).
 *   - No decision, a decision that doesn't apply to the item's status, or a
 *     write-back whose target vanished/changed underneath us (R2 — checked
 *     via `applyDecision`/`applyConcededFix`'s `updated`/`alreadyApplied`,
 *     never assumed) → the item stays pending.
 * Returns the ids actually written vs. the ids still pending, for the
 * command's final report.
 */
export function applyFixDecisions(
  cwd: string,
  milestoneId: string,
  blocks: PendingReviewBlock[],
  decisions: Map<string, FixDecision>,
): { applied: string[]; pending: string[] } {
  const applied: string[] = [];
  const pending: string[] = [];
  const followUps: { block: PendingReviewBlock; entry: ReviewFollowUpEntry }[] = [];

  for (const block of blocks) {
    const decision = decisions.get(block.id);
    if (!decision) {
      pending.push(block.id);
      continue;
    }

    if (block.status === "open") {
      if (decision.kind === "follow-up") {
        // R1: hold off on the marker until the KNOWLEDGE.md append is confirmed — see the pass below.
        followUps.push({
          block,
          entry: {
            milestoneId,
            slice: block.slice,
            id: block.id,
            pathLine: block.pathLine,
            claim: block.claim,
            note: decision.detail,
          },
        });
        continue;
      }
      const res = applyDecision(block.reviewPath, block.id, `${decision.kind} (${decision.detail})`);
      if (res.updated || res.alreadyApplied) applied.push(block.id);
      else pending.push(block.id); // R2: target vanished/changed — do not falsely report success.
      continue;
    }

    // conceded-sem-fix: only a well-formed "corrigida" whose sha resolves to a real commit applies (R3).
    const sha = decision.kind === "corrigida" ? extractSha(decision.detail) : null;
    if (sha && isRealCommit(cwd, sha)) {
      const res = applyConcededFix(block.reviewPath, block.id, { sha });
      if (res.updated || res.alreadyApplied) applied.push(block.id);
      else pending.push(block.id); // R2: target vanished/changed — do not falsely report success.
    } else {
      pending.push(block.id);
    }
  }

  // R1: append the KNOWLEDGE.md notes BEFORE stamping any "follow-up (KNOWLEDGE)"
  // marker. `appendReviewFollowUps`'s `ok` (distinct from `appended`, which is
  // legitimately 0 on an idempotent re-run) tells apart "nothing new to write"
  // from "the write failed" — only in the failed case do we leave the item
  // pending instead of flipping a marker whose note never landed.
  if (followUps.length > 0) {
    const { ok } = appendReviewFollowUps(
      cwd,
      followUps.map((f) => f.entry),
    );
    for (const { block } of followUps) {
      if (!ok) {
        pending.push(block.id);
        continue;
      }
      const res = applyDecision(block.reviewPath, block.id, "follow-up (KNOWLEDGE)");
      if (res.updated || res.alreadyApplied) applied.push(block.id);
      else pending.push(block.id); // R2: target vanished/changed — do not falsely report success.
    }
  }

  return { applied, pending };
}

// ── Journal (D-S02-5) — strictly advisory, never throws ────────────────────

/** Best-effort HEAD sha (S03/T04, mirrors `task-command.ts`'s helper) — undefined without git, never throws. */
function bestEffortHeadSha(cwd: string): string | undefined {
  try {
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/** Task-scope stamp (S03/T04): `task` + best-effort `sha`, so a task's review-fix dispatch is journal-rangeable exactly like `task_dispatched`/`task_result` (T01 pattern). Absent for slice targets — byte-identical to pre-T04 events. */
interface TaskJournalStamp {
  taskId: string;
  sha: string | undefined;
}

function journalDispatched(
  cwd: string,
  milestoneId: string,
  slice: string,
  author: { model: string | null; provider: string | null; family: string | null },
  taskStamp?: TaskJournalStamp,
): void {
  try {
    const ev: ForgeEvent = {
      ts: new Date().toISOString(),
      kind: "review_fix_dispatched",
      unit: "review-fix",
      agent: "forge-command",
      milestone: milestoneId,
      status: "dispatched",
      summary: `Dispatch de review-fix (${slice}) via /forge fix.`,
      slice,
    };
    if (author.model) ev.model = author.model;
    if (author.provider) ev.provider = author.provider;
    if (author.family) ev.family = author.family;
    if (taskStamp) {
      ev.task = taskStamp.taskId;
      if (taskStamp.sha) ev.sha = taskStamp.sha;
    }
    appendEvent(cwd, ev);
  } catch {
    /* best-effort journaling — never blocks the dispatch path */
  }
}

function journalResult(
  cwd: string,
  milestoneId: string,
  slice: string,
  status: string,
  summary: string,
  taskStamp?: TaskJournalStamp,
): void {
  try {
    const ev: ForgeEvent = {
      ts: new Date().toISOString(),
      kind: "review_fix_result",
      unit: "review-fix",
      agent: "forge-command",
      milestone: milestoneId,
      status,
      summary,
      slice,
    };
    if (taskStamp) {
      ev.task = taskStamp.taskId;
      if (taskStamp.sha) ev.sha = taskStamp.sha;
    }
    appendEvent(cwd, ev);
  } catch {
    /* best-effort journaling — never blocks the command's output */
  }
}

// ── Payload assembly (D-S02-2) ──────────────────────────────────────────────

/** The `## Itens de review a corrigir (inlinados)` payload: diff range + each item's verbatim dialogue + its REVIEW.md origin. */
function buildReviewFixPayload(blocks: PendingReviewBlock[], diffCmd: string): string {
  const items = blocks.map((b) => `${b.dialogue}\n(REVIEW.md: \`${b.reviewPath}\`)`).join("\n\n");
  return `Diff range: \`${diffCmd}\`\n\n${items}`;
}

// ── Dispatch bootstrap (shared by the slice and task branches) ─────────────

/** Reentrancy guard — same text/posture as `runAuto`/`research-models`. Returns true (after notifying) when a dispatch is already in flight. */
function reentrancyBlocked(ctx: ExtensionCommandContext, session: ForgeAutoSession): boolean {
  if (!session.active) return false;
  output(ctx, "/forge fix: loop já ativo — aguarde a execução atual terminar.", "warning");
  return true;
}

/** Bootstrap the container — mirrors `runResearchModelsCommand`/`runAuto` exactly (shared by both dispatch branches). */
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

// ── runFixCommand ────────────────────────────────────────────────────────────

/**
 * Run `/forge fix [S## | S##:R# | T-<id>[:R#]]`.
 *
 * Unlike `research-models` (repo-level) and the pre-S03/T03 `/forge fix`
 * (strictly milestone-bound), this command now straddles both universes
 * (S03-PLAN Interpretation Decision 4): `.gsd/STATE.md`/an active milestone
 * is read BEST-EFFORT (missing/empty → `milestoneId = ""`) rather than
 * hard-returning, because loose-task pendências (`.gsd/tasks/`) are
 * repo-level and must stay reachable with no milestone active. List mode
 * therefore merges both universes (milestone items only when `milestoneId`
 * is set, task items always); a slice target (`S##`/`S##:R#`) remains
 * milestone-bound (Step 6) since its artifacts live under a milestone's
 * slices. A `T-<id>` target (S03/T04) dispatches through the same driver
 * spine as a slice target, repo-level (no milestone required) — its
 * write-back operates on the task's own `.gsd/tasks/<id>/<id>-REVIEW.md`.
 *
 * `session` is a test seam (default the process singleton, mirrors
 * `runResearchModelsCommand`/`runAuto`).
 */
export async function runFixCommand(
  ctx: ExtensionCommandContext,
  rest: string[],
  session: ForgeAutoSession = getForgeAutoSession(),
): Promise<void> {
  // Best-effort milestone read: a missing/unreadable STATE.md or an empty
  // milestone field degrade to `""` rather than a hard return — loose-task
  // pendências are repo-level and must stay reachable regardless (S03-PLAN
  // Interpretation Decision 4). An UNREADABLE (as opposed to absent) STATE.md
  // is still a hard stop: a real I/O corruption, not "no milestone active".
  const statePath = `${ctx.cwd}/.gsd/STATE.md`;
  let milestoneId = "";
  if (existsSync(statePath)) {
    try {
      milestoneId = readState(ctx.cwd).milestone;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output(ctx, `/forge fix: .gsd/STATE.md não legível (${message}).`, "warning");
      return;
    }
  }

  const targetRaw = (rest[0] ?? "").trim();

  // List mode: no target — merges both universes; a milestone-less repo
  // degrades to the task-only listing instead of hard-returning.
  if (!targetRaw) {
    const lines = ["/forge fix — pendências de review:"];
    let any = false;
    if (milestoneId) {
      for (const item of collectPendingReviewItems(ctx.cwd, milestoneId)) {
        any = true;
        const reviewPath = reviewArtifactPath(ctx.cwd, milestoneId, item.slice);
        lines.push(`  ${item.slice}:${item.id} [${item.status}] ${item.claim} — ${reviewPath}`);
      }
    }
    for (const item of collectPendingTaskReviewItems(ctx.cwd)) {
      any = true;
      lines.push(`  ${item.slice}:${item.id} [${item.status}] ${item.claim} — ${taskReviewArtifactPath(ctx.cwd, item.slice)}`);
    }
    if (!any) {
      // Byte-compatible with the pre-S03/T03 message — same text whether the
      // milestone universe, the task universe, or both are empty.
      output(ctx, "/forge fix: nenhuma pendência de review na milestone ativa.");
      return;
    }
    lines.push("", `Uso: ${FIX_USAGE}`);
    output(ctx, lines.join("\n"));
    return;
  }

  const target = parseFixTarget(targetRaw);
  if (!target) {
    output(ctx, `/forge fix: alvo inválido '${targetRaw}'. Uso: ${FIX_USAGE}`, "warning");
    return;
  }

  if (target.kind === "task") {
    // Repo-level dispatch (S03-PLAN Interpretation Decision 4/5): a task
    // target needs no active milestone — `milestoneId` may be `""` here,
    // threaded through unchanged (compose paths + write-back are both
    // milestone-agnostic for the task store).
    const taskBlocks = collectPendingTaskReviewBlocks(ctx.cwd, { taskId: target.taskId, id: target.id });
    if (taskBlocks.length === 0) {
      output(ctx, `/forge fix: nenhuma pendência para '${targetRaw}'.`, "warning");
      return;
    }

    if (reentrancyBlocked(ctx, session)) return;

    bootstrapDispatchSession(session, ctx, milestoneId);

    try {
      const unit: ComposableUnit = { type: "review-fix", slice: target.taskId, taskId: target.taskId };

      // Resolve authorship BEFORE publishing `currentUnit` — same discipline
      // as the slice branch below / research-models-command.ts.
      const resolved = resolveDispatchAuthor(session, unit, Date.now());
      session.currentUnit = unit;

      const taskStamp: TaskJournalStamp = { taskId: target.taskId, sha: bestEffortHeadSha(ctx.cwd) };
      journalDispatched(ctx.cwd, milestoneId, target.taskId, resolved, taskStamp);

      const resultToolName = resolveUnitResultToolName(session, unit);
      const dispatchAuthorRef = resolved.model ?? resolved.provider ?? undefined;
      const diffCmd = computeReviewDiffCmd(ctx.cwd, { milestoneId, taskId: target.taskId });
      const reviewFixPayload = buildReviewFixPayload(taskBlocks, diffCmd);

      const prompt = composePrompt(unit, {
        cwd: ctx.cwd,
        milestoneId,
        resultToolName,
        dispatchAuthorRef,
        reviewFixPayload,
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

      // R2: the result event must carry HEAD *after* the dispatch, not the
      // pre-dispatch `taskStamp` — reusing that stale sha would make the
      // dispatched→result range degenerate (base === to) whenever the worker
      // committed, defeating the range this stamp exists to support (mirrors
      // `task-command.ts`'s journalResult, which recomputes fresh too).
      const resultStamp: TaskJournalStamp = { taskId: target.taskId, sha: bestEffortHeadSha(ctx.cwd) };
      journalResult(ctx.cwd, milestoneId, target.taskId, result.status, result.summary, resultStamp);

      const decisions = parseFixDecisions(result.summary);
      const { applied, pending } = applyFixDecisions(ctx.cwd, milestoneId, taskBlocks, decisions);

      const taskLabel = target.id ? `${target.taskId}:${target.id}` : target.taskId;
      const lines = [`/forge fix ${taskLabel}: ${result.status} — ${result.summary}`];
      if (applied.length > 0) lines.push(`Aplicadas: ${applied.join(", ")}.`);
      if (pending.length > 0) {
        lines.push(`Ainda pendentes: ${pending.join(", ")} — rode '${FIX_USAGE}' de novo para re-despachar.`);
      }
      // Relatório é ENTREGÁVEL, nunca nag: a TUI filtra level "warning" do
      // transcript (shouldRenderExtensionNotifyInChat) e o rebaixa a toast de
      // rodapé — o operador via o comando "terminar" sem overview (2026-07-12).
      // Success quando limpo, info quando resta pendência — o texto carrega o aviso.
      output(ctx, lines.join("\n"), result.status === "done" && pending.length === 0 ? "success" : "info");
    } finally {
      // R2: restore the interactive session's tools/model + s.reset() — see
      // `restoreInteractiveSession` (shared with runAuto/research-models).
      await restoreInteractiveSession(session);
    }
    return;
  }

  // Slice targets remain milestone-bound (S03-PLAN Step 6): their review
  // artifacts live under an active milestone's slices.
  if (!milestoneId) {
    output(ctx, "/forge fix: .gsd/STATE.md não tem um milestone ativo.", "warning");
    return;
  }

  const blocks = collectPendingReviewBlocks(ctx.cwd, milestoneId, { slice: target.slice, id: target.id });
  if (blocks.length === 0) {
    output(ctx, `/forge fix: nenhuma pendência para '${targetRaw}'.`, "warning");
    return;
  }

  // Guard de reentrância — mesmo texto-padrão do runAuto/research-models.
  if (reentrancyBlocked(ctx, session)) return;

  // Bootstrap the container — mirrors runResearchModelsCommand/runAuto exactly.
  bootstrapDispatchSession(session, ctx, milestoneId);

  try {
    const unit: ComposableUnit = { type: "review-fix", slice: target.slice };

    // Resolve authorship BEFORE publishing `currentUnit` — same discipline as
    // research-models-command.ts.
    const resolved = resolveDispatchAuthor(session, unit, Date.now());
    session.currentUnit = unit;

    journalDispatched(ctx.cwd, milestoneId, target.slice, resolved);

    const resultToolName = resolveUnitResultToolName(session, unit);
    const dispatchAuthorRef = resolved.model ?? resolved.provider ?? undefined;
    const diffCmd = computeReviewDiffCmd(ctx.cwd, { milestoneId, slice: target.slice });
    const reviewFixPayload = buildReviewFixPayload(blocks, diffCmd);

    const prompt = composePrompt(unit, {
      cwd: ctx.cwd,
      milestoneId,
      resultToolName,
      dispatchAuthorRef,
      reviewFixPayload,
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

    journalResult(ctx.cwd, milestoneId, target.slice, result.status, result.summary);

    const decisions = parseFixDecisions(result.summary);
    const { applied, pending } = applyFixDecisions(ctx.cwd, milestoneId, blocks, decisions);

    const lines = [`/forge fix ${targetRaw.toUpperCase()}: ${result.status} — ${result.summary}`];
    if (applied.length > 0) lines.push(`Aplicadas: ${applied.join(", ")}.`);
    if (pending.length > 0) {
      lines.push(`Ainda pendentes: ${pending.join(", ")} — rode '${FIX_USAGE}' de novo para re-despachar.`);
    }
    // Relatório é ENTREGÁVEL, nunca nag: a TUI filtra level "warning" do
      // transcript (shouldRenderExtensionNotifyInChat) e o rebaixa a toast de
      // rodapé — o operador via o comando "terminar" sem overview (2026-07-12).
      // Success quando limpo, info quando resta pendência — o texto carrega o aviso.
      output(ctx, lines.join("\n"), result.status === "done" && pending.length === 0 ? "success" : "info");
  } finally {
    // R2: restore the interactive session's tools/model + s.reset() — see
    // `restoreInteractiveSession` (shared with runAuto/research-models).
    await restoreInteractiveSession(session);
  }
}
