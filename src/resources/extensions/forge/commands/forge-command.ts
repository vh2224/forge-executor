/**
 * `/forge` command — subcommand router: status | help | auto | next | migrate.
 *
 * `status`, `help` and `migrate` only ever read `.gsd/` — never write, never
 * assume it exists. `auto`/`next` (S03) are REAL command handlers: the only
 * place in the whole extension where `ctx.newSession()` is reachable (B2 —
 * `S03-RISK.md`). Everything session-bound lives behind `runAuto`, which
 * bootstraps the `ForgeAutoSession` container, builds the production driver
 * (`dispatchUnitViaNewSession`), and awaits `runForgeLoop` to a terminal
 * action (finish / pause / throw) with `s.reset()` guaranteed in `finally`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { readForgePrefs } from "../prefs.js";
import { readState, deriveNextUnit, sliceComplete, type NextUnit } from "../state/index.js";
import { listGestations } from "../state/gestation.js";
import { updateState, appendEvent, readEvents } from "../state/store.js";
import type { ForgeEvent } from "../state/types.js";
import { readSnapshot } from "../auto/snapshot.js";
import { getForgeAutoSession, type ForgeAutoSession } from "../auto/session.js";
import { runForgeLoop, type LoopDeps, type LoopTerminal, type NotifyLevel } from "../auto/loop.js";
import type { ForgeLoopEvent } from "../auto/housekeeping.js";
import { dispatchUnitViaNewSession } from "../auto/driver.js";
import { buildMigrateReport, formatMigrateReport } from "../migrate/report.js";
import { applyMigration, formatApplyReport } from "../migrate/apply.js";
import { formatMilestoneFinale } from "../ui/finale.js";
import { formatReviewDigest } from "../ui/review-digest.js";
import { readLastConversationLine } from "../conversas/last-entry.js";
import { CredentialRotator } from "@forge/agent-core/credential-rotation.js";
import { runReviewCommand } from "./review-command.js";
import { runAccountsCommand } from "./accounts-command.js";
import { runModelsCommand } from "./models-command.js";
import { runResearchModelsCommand } from "./research-models-command.js";
import { runFixCommand } from "./fix-command.js";
import { runInitCommand } from "./init-command.js";
import { runTaskCommand } from "./task-command.js";
import { runMilestoneCommand } from "./milestone-command.js";

/** Exit code plumbed for a non-`complete` loop terminal in print/headless mode. */
const PRINT_PAUSE_EXIT_CODE = 3;

/**
 * E2E-4 (Open Q5): is this command running in a non-interactive (print/headless)
 * context, where a paused/blocked `/forge auto` should surface a non-zero exit
 * code for CI/scripting? True when NO human is at a TUI to act on the pause.
 *
 * We derive this from the SAME signals the shared next-action UI uses to decide
 * whether it can render an interactive menu (`shared/next-action-ui.ts`
 * `isInteractiveUIContext`) — WITHOUT importing that module (it pulls in the
 * whole pi-tui dialog stack). A context is interactive when it advertises a UI
 * (`ctx.hasUI`), is not forced headless via `GSD_HEADLESS=1`, and its UI mode is
 * not `rpc`/`headless`. Anything else — including `--print` runs, which expose no
 * interactive UI — is treated as print/headless. This keeps the interactive TUI,
 * where a pause is a normal flow, from ever receiving a non-zero exit code.
 */
export function isPrintHeadlessContext(ctx: ExtensionCommandContext): boolean {
  if (!ctx.hasUI) return true;
  if (process.env.GSD_HEADLESS === "1") return true;
  const uiMode = (ctx.ui as { mode?: string } | undefined)?.mode;
  if (uiMode === "rpc" || uiMode === "headless") return true;
  return false;
}

const SUBCOMMANDS = [
  "status",
  "help",
  "init",
  "auto",
  "next",
  "migrate",
  "unblock",
  "review",
  "accounts",
  "models",
  "research-models",
  "fix",
  "task",
  "milestone",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export function registerForgeCommand(pi: ExtensionAPI): void {
  pi.registerCommand("forge", {
    description:
      "Forge loop — status | help | init | auto | next | migrate | unblock | review | accounts | models | research-models | fix | task | milestone",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "help") as Subcommand;
      const rest = parts.slice(1);

      switch (sub) {
        case "status": {
          // ctx.cwd (not process.cwd()) + stdout in print/headless — the same
          // mute-notify lesson as `migrate` (2026-07-10).
          const statusText = formatStatus(ctx.cwd);
          if (isPrintHeadlessContext(ctx)) process.stdout.write(statusText + "\n");
          else ctx.ui.notify(statusText, "info");
          return;
        }
        case "init":
          runInitCommand(ctx, rest);
          return;
        case "auto":
          await runAuto(ctx, { once: false });
          return;
        case "next":
          await runAuto(ctx, { once: true });
          return;
        case "migrate": {
          if (rest[0] === "--apply") {
            const applyReport = applyMigration(ctx.cwd);
            const text = formatApplyReport(applyReport);
            if (isPrintHeadlessContext(ctx)) {
              process.stdout.write(text + "\n");
            } else {
              ctx.ui.notify(text, "info");
            }
          } else {
            const report = formatMigrateReport(buildMigrateReport(ctx.cwd));
            // The PRIMARY consumer of a dry-run report is headless/print
            // (`forge --print "/forge migrate"` on a 1.0 project) — ctx.ui.notify
            // is a TUI surface and is MUTE there (found live on the first real
            // run against a forge-agent snapshot, 2026-07-10: exit 0, zero
            // output). stdout for print/headless; notify for the TUI.
            if (isPrintHeadlessContext(ctx)) {
              process.stdout.write(report + "\n");
            } else {
              ctx.ui.notify(report, "info");
            }
          }
          return;
        }
        case "review":
          await runReviewCommand(ctx, rest.join(" ").trim());
          return;
        case "accounts":
          await runAccountsCommand(ctx, rest);
          return;
        case "models":
          await runModelsCommand(ctx, rest);
          return;
        case "research-models":
          await runResearchModelsCommand(ctx);
          return;
        case "fix":
          await runFixCommand(ctx, rest);
          return;
        case "task":
          await runTaskCommand(ctx, rest);
          return;
        case "milestone":
          await runMilestoneCommand(ctx, rest);
          return;
        case "unblock": {
          // Operator clearing of a durably blocked/partial unit (M1R-4 guard).
          // TWO durable writes, both auditable: a `unit_unblocked` journal
          // marker (so the pause-replay net never re-applies the cleared
          // pause — trailing unblock wins) and the STATE entry removal (so
          // the resume guard dispatches again). Usage: /forge unblock S02
          // (slice) or /forge unblock S02/T01 (task).
          const key = (rest[0] ?? "").trim();
          const outNotify = (m: string, k: "info" | "warning" = "info") => {
            if (isPrintHeadlessContext(ctx)) process.stdout.write(m + "\n");
            else ctx.ui.notify(m, k);
          };
          if (!key) {
            outNotify("Uso: /forge unblock <S##|S##/T##>", "warning");
            return;
          }
          const [sliceId, taskId] = key.split("/");
          const targetId = taskId || sliceId;
          const st = readState(ctx.cwd);
          const entry = (st.units ?? []).find(
            (u) => u.id === targetId && (u.status === "blocked" || u.status === "partial"),
          );
          if (!entry) {
            outNotify(`Nada a desbloquear: nenhuma unidade '${targetId}' com status blocked/partial no STATE.`, "warning");
            return;
          }
          appendEvent(ctx.cwd, {
            ts: new Date().toISOString(),
            kind: "unit_unblocked",
            unit: key,
            agent: "forge-operator",
            milestone: st.milestone,
            status: "unblocked",
            summary: `Operador desbloqueou ${key} (era ${entry.status}) via /forge unblock.`,
            slice: sliceId,
            ...(taskId ? { task: taskId } : {}),
          } as ForgeLoopEvent);
          updateState(ctx.cwd, (prev) => ({
            ...prev,
            units: (prev.units ?? []).filter((u) => !(u.id === targetId && (u.status === "blocked" || u.status === "partial"))),
          }));
          outNotify(`Desbloqueado: ${key} (era ${entry.status}). O próximo /forge auto|next pode re-despachar a unidade.`);
          return;
        }
        case "help":
        default:
          ctx.ui.notify(formatHelp(), "info");
          return;
      }
    },
  });
}

/**
 * Real entry point for `/forge auto` (`once: false`) and `/forge next`
 * (`once: true`). COMMAND-HANDLER ONLY (B2) — this is the sole path that
 * reaches `dispatchUnitViaNewSession`'s `newSession` call.
 *
 * Pré-condições → guard de reentrância → bootstrap do container → driver de
 * produção → `runForgeLoop` → `s.reset()` em `finally`, sempre — o container
 * nunca fica preso em `active=true` após erro.
 */
export async function runAuto(
  ctx: ExtensionCommandContext,
  opts: { once: boolean },
  session: ForgeAutoSession = getForgeAutoSession(),
  loopRunner: typeof runForgeLoop = runForgeLoop,
): Promise<void> {
  const label = opts.once ? "next" : "auto";

  // Pré-condição: precisa existir .gsd/STATE.md com um milestone ativo.
  const statePath = join(ctx.cwd, ".gsd", "STATE.md");
  if (!existsSync(statePath)) {
    ctx.ui.notify(
      `/forge ${label}: nenhum estado forge neste diretório (.gsd/STATE.md não encontrado).`,
      "warning",
    );
    return;
  }
  let milestoneId: string;
  try {
    milestoneId = readState(ctx.cwd).milestone;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`/forge ${label}: .gsd/STATE.md não legível (${message}).`, "warning");
    return;
  }
  if (!milestoneId) {
    ctx.ui.notify(`/forge ${label}: .gsd/STATE.md não tem um milestone ativo.`, "warning");
    return;
  }

  // Guard de reentrância: uma sessão de loop ativa por vez.
  if (session.active) {
    ctx.ui.notify(`/forge ${label}: loop já ativo — aguarde a execução atual terminar.`, "warning");
    return;
  }

  // Bootstrap do container (B1) — sobrevive ao session-replacement.
  session.active = true;
  session.cmdCtx = ctx;
  session.runRootSessionPath = ctx.sessionManager?.getSessionFile?.() ?? null;
  session.cwd = ctx.cwd;
  // Publish the milestone id for the durable evidence subscription
  // (`registerEvidenceCapture`), which stamps advisory `evidence` events but
  // runs in a fresh post-`newSession` instance with no direct STATE handle.
  session.milestoneId = milestoneId;
  // Capture the interactive session's model BEFORE the loop narrows anything, so
  // the finally can restore it if a per-unit model was applied (R2).
  session.baselineModel = ctx.model ?? undefined;
  // S03/T01 (achado HIGH #3): build the rotator over the REAL `AuthStorage` —
  // `ctx.modelRegistry.authStorage` is a public `readonly` field
  // (`model-registry.ts:364`) satisfying `CredentialSource`, so this reads the
  // vendored package without patching it (`verify-pi-patches.cjs` stays green,
  // there is nothing to register). `ctx.modelRegistry` can be `undefined` in
  // some test contexts — guard, leaving `credentialRotator` `null` there so the
  // driver's no-rotator branch (byte-identical to S02) is what runs.
  session.authStorageForOverride = ctx.modelRegistry?.authStorage ?? null;
  session.credentialRotator = ctx.modelRegistry?.authStorage
    ? new CredentialRotator(ctx.modelRegistry.authStorage)
    : null;
  session.providerReadiness = ctx.modelRegistry
    ? ((provider: string) => ctx.modelRegistry!.isProviderRequestReady(provider))
    : null;

  const notify = (message: string, level: NotifyLevel = "info") => {
    session.cmdCtx?.ui.notify(message, level);
  };
  const deps: LoopDeps = {
    cwd: session.cwd,
    driver: { dispatch: (unit, prompt) => dispatchUnitViaNewSession(session, unit, prompt) },
    notify,
  };

  // S06 (D-S06-6): the STRICTLY advisory evidence subscription lives in the
  // bootstrap (`registerEvidenceCapture`), NOT here. It must be re-armed on each
  // fresh post-`newSession` instance's own `pi` — a subscription attached once at
  // runAuto entry sits on the pre-loop handle and never observes the worker turns
  // that run after the first `newSession` swap (S06 R2 review-fix).

  let terminal: LoopTerminal | undefined;
  // Captured BEFORE the finally's `s.reset()` nulls `session.cmdCtx`: the last
  // replacement session's LIVE context — the only ui handle guaranteed valid
  // at finale time (the original `ctx` is stale after the first newSession,
  // B3; `notify` above no-ops once cmdCtx is reset). M8-close bug.
  let finaleUiCtx: typeof ctx | null = null;
  try {
    terminal = await loopRunner(session, deps, { once: opts.once });
    finaleUiCtx = session.cmdCtx;
  } finally {
    // R2: restore the interactive session's tools/model + s.reset() — see
    // `restoreInteractiveSession` (shared with `runResearchModelsCommand`,
    // S04/T04, the other command handler that ever bootstraps the container).
    await restoreInteractiveSession(session);
  }

  // E2E-4: map the structured loop terminal → a print/headless exit code. A
  // non-`complete` terminal (paused/blocked/ceiling/no_progress) means the run
  // did NOT reach the milestone; in a non-interactive context that must surface
  // as a non-zero exit for CI/scripting. We set `process.exitCode` (a builtin —
  // NEVER `process.exit()`, which would cut off stream flushing, and never a
  // pi-* touch) and let the process drain naturally. In the interactive TUI a
  // pause is a normal flow, so the exit code is left untouched. A `complete`
  // terminal (or an early-guard return, where `terminal` is undefined) leaves
  // the exit code at its default 0.
  if (process.env.FORGE_EXIT_DEBUG === "1") {
    process.stderr.write(
      `[forge-exit-debug] runAuto tail: terminal=${terminal ? terminal.reason : "undefined"} ` +
      `printHeadless=${isPrintHeadlessContext(ctx)} exitCode(before)=${String(process.exitCode)} ts=${Date.now()}\n`,
    );
  }
  // Milestone finale — celebratory close-out banner (never throws; a finale
  // must never break a completed run). Printed in BOTH surfaces: notify for
  // the TUI, stdout for print/headless.
  //
  // DELIVERY BUG fixed here (M8 close, 2026-07-12): this used `ctx.ui.notify`
  // — the ORIGINAL runAuto context, stale after the first `newSession` (B3) —
  // with a silent catch, so the banner could vanish without a trace exactly
  // at the moment it mattered. The loop's own narration survives the whole
  // run because it goes through the LIVE re-pointed `session.cmdCtx`
  // (`notify`, above); the finale now rides the same channel, falls back to
  // the original ctx, and on total failure prints to stderr — a finale is
  // never silently dropped again.
  if (terminal && terminal.reason === "complete") {
    let finale = "";
    try {
      finale = formatMilestoneFinale(ctx.cwd, milestoneId);
      if (isPrintHeadlessContext(ctx)) process.stdout.write(finale + "\n");
      else (finaleUiCtx ?? ctx).ui.notify(finale, "success");
    } catch {
      try {
        if (finale) ctx.ui.notify(finale, "success");
      } catch {
        if (finale) console.error(finale);
      }
    }
  }

  if (terminal && terminal.reason !== "complete" && isPrintHeadlessContext(ctx)) {
    process.exitCode = PRINT_PAUSE_EXIT_CODE;
  } else if (terminal && terminal.reason === "complete" && isPrintHeadlessContext(ctx)) {
    // Explicitly CLAIM the exit code on success. The last worker session's
    // final message is an "aborted" teardown artifact (terminate:true flow —
    // the SDK result never arrives, so the adapter's teardown message is the
    // session's last message), and print-mode's generic last-message heuristic
    // would report "Request aborted" + exit 1 for a fully successful run
    // (seen live: A1 takes 5-8, 2026-07-10). print-mode honours an exitCode
    // already set by a command and skips the heuristic.
    process.exitCode = 0;
  }
}

/**
 * R2 — restore the interactive session's tools/model/thinking-level (via the
 * live post-`newSession` `pi` handle) and reset the container, on EVERY exit
 * path (success or throw). ORDER IS LOAD-BEARING: `setModel` runs BEFORE the
 * thinking-level restore — `setModel` re-clamps the thinking level for the
 * restored model (`agent-session-model.ts:107`), so the reverse order would
 * clobber this restore. `livePi` is the FRESH instance's `pi` republished by
 * the `session_start` hook (never stale, B3), or `null` if the loop/dispatch
 * never actually ran a worker turn (→ the whole restore is a no-op).
 *
 * Extracted from `runAuto`'s original `finally` (S03) so `/forge research-
 * models` (S04/T04, the other command handler that ever bootstraps the
 * container) shares the EXACT same restore/reset instead of duplicating it.
 */
export async function restoreInteractiveSession(session: ForgeAutoSession): Promise<void> {
  try {
    const live = session.livePi;
    if (live) {
      if (session.defaultActiveTools !== null) {
        try {
          live.setActiveTools(session.defaultActiveTools);
        } catch {
          /* best-effort */
        }
        session.defaultActiveTools = null;
      }
      if (session.modelApplied && session.baselineModel) {
        try {
          await live.setModel(session.baselineModel);
        } catch {
          /* best-effort — falls back to the last worker model */
        }
      }
      // S01 effort axis: restore AFTER the model restore above (see doc-comment).
      if (session.effortApplied && session.baselineThinkingLevel !== null) {
        try {
          live.setThinkingLevel(session.baselineThinkingLevel);
        } catch {
          /* best-effort — falls back to the last worker thinking level */
        }
        session.effortApplied = false;
        session.baselineThinkingLevel = null;
      }
    }
  } finally {
    session.reset();
  }
}

function formatHelp(): string {
  return [
    "Subcomandos do /forge:",
    "  status  — mostra o estado atual em .gsd/STATE.md",
    "  help    — esta mensagem",
    "  init    — cria o esqueleto .gsd/ num projeto novo; com .gsd/ existente vira doctor-lite (--repair, --gitignore)",
    "  auto    — roda o loop de dispatch até o milestone terminar, bloquear ou pausar",
    "  next    — roda exatamente uma unidade (plan-slice ou execute-task) e para",
    "  migrate — classifica um .gsd/ 1.0 (dry-run); migrate --apply converte de fato, com backup automático",
    "  review   — roda o review dialético sob demanda num alvo → docs/forge/<alvo>-REVIEW-<família>.md",
    "  accounts — lista/adiciona/remove credenciais por provider (status de cooldown)",
    "  models   — vê/edita o role×pool de .gsd/models.md sem abrir editor",
    "  research-models — pesquisa forças dos modelos e atualiza .gsd/CAPABILITIES.md",
    "  fix      — lista pendências de review (sem args) ou despacha um fix (S## | S##:R#)",
    '  task     — task "<descrição>" — task solta sem milestone (plan→execute)',
    '  milestone — milestone "<descrição>" cria o CONTEXT p/ lapidação; sem args lista gestações; start <MID> valida, planeja e prepara o /forge auto',
  ].join("\n");
}

/** One-line label for a derived unit, e.g. `execute-task S07/T03`. */
function formatUnit(unit: NextUnit): string {
  switch (unit.type) {
    case "plan-slice":
      return `plan-slice ${unit.slice}`;
    case "execute-task":
      return `execute-task ${unit.slice}/${unit.task}`;
    case "complete-slice":
      return `complete-slice ${unit.slice}`;
    case "complete-milestone":
      return `complete-milestone ${unit.milestone}`;
  }
}

/**
 * Human status dashboard rendered from the SAME snapshot machinery the loop
 * dispatches from (`readSnapshot` + `deriveNextUnit`) — never a raw STATE.md
 * dump (the pre-M4 behavior, which walled the transcript with serialized
 * yaml). Degrades honestly: no ROADMAP → the raw unit list from STATE; an
 * unreadable snapshot → the raw file as a last-resort fallback.
 */
function formatStatus(cwd: string = process.cwd()): string {
  const statePath = join(cwd, ".gsd", "STATE.md");
  const prefsLine = formatPrefsLine(cwd);

  if (!existsSync(statePath)) {
    const lines = [
      "Nenhum estado forge neste diretório (.gsd/STATE.md não encontrado).",
      "Rode /forge init para criar o esqueleto .gsd/.",
    ];
    // Loose tasks are repo-level (S03/T05) — they must surface even without an
    // active milestone. Same omit-on-failure posture as the milestone path below.
    try {
      const loose = formatLooseTasks(cwd);
      if (loose.length > 0) lines.push("", ...loose);
    } catch {
      // Loose-tasks read failure — omit the block, never hide the init hint.
    }
    try {
      const gestations = formatGestations(cwd);
      if (gestations.length > 0) lines.push("", ...gestations);
    } catch {
      // Gestation read failure — omit the block, never hide the init hint.
    }
    try {
      const lastConversation = readLastConversationLine(cwd);
      if (lastConversation) lines.push("", lastConversation);
    } catch {
      // Conversation read failure — omit the line, never hide the init hint.
    }
    lines.push(prefsLine);
    return lines.join("\n");
  }
  try {
    const snap = readSnapshot(cwd);
    const lines: string[] = [];
    // ROADMAP H1s conventionally start with the milestone id — strip it so the
    // header line doesn't read "M-… — M-… — título".
    const rawTitle = snap.titles.milestone ?? "";
    const title = rawTitle.startsWith(snap.milestoneId)
      ? rawTitle.slice(snap.milestoneId.length).replace(/^[\s—·:-]+/, "")
      : rawTitle;
    lines.push(`Milestone: ${snap.milestoneId || "—"}${title ? ` — ${title}` : ""}`);
    const phase = snap.state.phase;
    if (phase) lines.push(`phase: ${phase}`);

    let hasFlags = false;
    if (snap.roadmap.length > 0) {
      lines.push("", "Slices:");
      let doneSlices = 0;
      let doneTasks = 0;
      let totalTasks = 0;
      for (const slice of snap.roadmap) {
        const tasks = snap.plans[slice.id]?.tasks ?? [];
        const done = tasks.filter((t) => t.status === "done").length;
        totalTasks += tasks.length;
        doneTasks += done;
        const complete = sliceComplete(slice, snap.state);
        if (complete) doneSlices++;
        const flagged = tasks.filter((t) => t.status === "partial" || t.status === "blocked");
        if (flagged.length > 0) hasFlags = true;
        const icon = complete ? "✓" : flagged.length > 0 ? "⚠" : done > 0 ? "▸" : "·";
        const name = slice.name.length > 58 ? `${slice.name.slice(0, 57)}…` : slice.name;
        const taskInfo = tasks.length > 0 ? ` — ${done}/${tasks.length} tasks` : " — sem plano";
        const flags = flagged.map((t) => `${t.id}: ${t.status}`).join(", ");
        lines.push(`  ${icon} ${slice.id}  ${name}${taskInfo}${flags ? ` · ${flags}` : ""}`);
      }
      lines.push("", `Progresso: ${doneSlices}/${snap.roadmap.length} slices · ${doneTasks}/${totalTasks} tasks`);
      try {
        const next = deriveNextUnit(snap.state, snap.roadmap, snap.plans, {
          milestoneSummaryWritten: snap.milestoneSummaryWritten,
        });
        lines.push(next ? `Próxima unidade: ${formatUnit(next)}` : "Próxima unidade: — (milestone completo)");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lines.push(`Próxima unidade: irresolúvel — ${message}`);
      }
    } else if (snap.milestoneId) {
      lines.push("", "ROADMAP ainda não escrito (nenhuma slice conhecida).");
    }

    const units = snap.state.units ?? [];
    if (snap.roadmap.length === 0 && units.length > 0) {
      // Degraded view (no ROADMAP on disk): surface every STATE unit raw so
      // the operator still sees blocked/partial terminals (aceite #4).
      lines.push("", "Unidades no STATE:");
      for (const u of units) {
        lines.push(`  - ${u.id} (${u.type}${u.slice ? ` · ${u.slice}` : ""}) — status: ${u.status}`);
      }
    } else if (hasFlags || units.some((u) => u.status === "blocked" || u.status === "partial")) {
      const attention = units.filter((u) => u.status === "blocked" || u.status === "partial");
      if (attention.length > 0) {
        lines.push("", "Atenção:");
        for (const u of attention) {
          const key = u.type === "task" && u.slice ? `${u.slice}/${u.id}` : u.id;
          lines.push(`  - ${key} — status: ${u.status} → /forge unblock ${key}`);
        }
      }
    }

    if (snap.milestoneId) {
      try {
        const digest = formatReviewDigest(cwd, snap.milestoneId);
        if (digest.length > 0) lines.push("", ...digest);
      } catch {
        // Digest read/collector failure — omit the block, never hide the rest of status.
      }
    }

    try {
      const loose = formatLooseTasks(cwd);
      if (loose.length > 0) lines.push("", ...loose);
    } catch {
      // Loose-tasks read failure — omit the block, never hide the rest of status.
    }

    try {
      const gestations = formatGestations(cwd);
      if (gestations.length > 0) lines.push("", ...gestations);
    } catch {
      // Gestation read failure — omit the block, never hide the rest of status.
    }

    try {
      const lastConversation = readLastConversationLine(cwd);
      if (lastConversation) lines.push("", lastConversation);
    } catch {
      // Conversation read failure — omit the line, never hide the rest of status.
    }

    lines.push("", prefsLine);
    return lines.join("\n");
  } catch {
    // Snapshot unreadable — fall back to the raw file rather than hide state.
    try {
      const raw = readFileSync(statePath, "utf8");
      return [`.gsd/STATE.md (bruto — snapshot ilegível):\n\n${raw}`, prefsLine].join("\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [
        `Nenhum estado forge legível neste diretório (.gsd/STATE.md: ${message}).`,
        prefsLine,
      ].join("\n");
    }
  }
}

/** Loose-task dir ids: `T-<14-digit timestamp>[-slug]` (`state/ids.ts` grammar). */
const LOOSE_TASK_ID_RE = /^T-\d{14}/;

/** `/forge status` lists at most this many loose tasks; the rest collapse into an overflow line. */
const MAX_LOOSE_TASKS = 5;

type LooseTaskStage = "criada" | "planejada" | "executada" | "revisada";

/** Stage derived from which store artifacts exist for `id` — never from the journal. */
function looseTaskStage(taskDir: string, id: string): LooseTaskStage {
  if (existsSync(join(taskDir, `${id}-REVIEW.md`))) return "revisada";
  if (existsSync(join(taskDir, `${id}-SUMMARY.md`))) return "executada";
  if (existsSync(join(taskDir, `${id}-PLAN.md`))) return "planejada";
  return "criada";
}

/**
 * Last `task_result` event for `id` in journal order. S03/T01 stamps `task`
 * on every `task_result`; pre-S03 events lack it, so we fall back to the
 * `[<id>]` marker `journalResult` has always prefixed onto `summary`
 * (best-effort — S03-PLAN Interpretation Decision 1 / T05 Steps §2).
 */
function lastTaskResult(events: ForgeEvent[], id: string): { status: string; unit: string } | undefined {
  let found: ForgeEvent | undefined;
  for (const e of events) {
    if (e.kind !== "task_result") continue;
    const matches = e.task ? e.task === id : typeof e.summary === "string" && e.summary.includes(`[${id}]`);
    if (matches) found = e;
  }
  return found ? { status: found.status, unit: found.unit } : undefined;
}

/** Mirrors the ✓/⚠/· vocabulary already used for slices in `formatStatus`. */
function looseTaskIcon(stage: LooseTaskStage, result: { status: string } | undefined): string {
  if (result && (result.status === "partial" || result.status === "blocked" || result.status === "timeout")) {
    return "⚠";
  }
  if (stage === "revisada" && result?.status === "done") return "✓";
  return "·";
}

/**
 * `follows: {status section helper — omit-on-failure}` — same shape as
 * `formatReviewDigest`: pure read-side, never throws, `[]` when there is
 * nothing to show so callers can skip the block entirely (byte-identical
 * status when no tasks exist depends on this).
 *
 * Deliberately independent of the T03 pending-review collectors (S03-PLAN
 * Interpretation Decision 7) — stage comes ONLY from store artifacts +
 * journal, so T05 has zero coupling to T01/T03/T04.
 */
/**
 * Gestations are read-side status only: omit on absence or scanner failure so
 * existing dashboards remain byte-identical when there is nothing to report.
 */
function formatGestations(cwd: string): string[] {
  try {
    const gestations = listGestations(cwd);
    if (gestations.length === 0) return [];
    return [
      "Milestones em gestação:",
      ...gestations.map(
        ({ milestoneId }) => `  · ${milestoneId} — próximo passo: /forge milestone start ${milestoneId}`,
      ),
    ];
  } catch {
    return [];
  }
}

function formatLooseTasks(cwd: string): string[] {
  const tasksDir = join(cwd, ".gsd", "tasks");
  let ids: string[];
  try {
    ids = readdirSync(tasksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && LOOSE_TASK_ID_RE.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // descending — timestamp prefix sorts lexicographically
  } catch {
    return [];
  }
  if (ids.length === 0) return [];

  let events: ForgeEvent[] = [];
  try {
    events = readEvents(cwd);
  } catch {
    events = [];
  }

  const shown = ids.slice(0, MAX_LOOSE_TASKS);
  const overflow = ids.length - shown.length;
  const lines: string[] = ["Tasks soltas:"];
  for (const id of shown) {
    try {
      const stage = looseTaskStage(join(tasksDir, id), id);
      const result = lastTaskResult(events, id);
      const icon = looseTaskIcon(stage, result);
      const resultSuffix = result ? ` · último resultado: ${result.status} (${result.unit})` : "";
      lines.push(`  ${icon} ${id} — ${stage}${resultSuffix}`);
    } catch {
      // Malformed store entry for this one task — degrade to what can be shown.
      lines.push(`  · ${id} — (ilegível)`);
    }
  }
  if (overflow > 0) lines.push(`  … (+${overflow})`);
  return lines;
}

// Never throws: readForgePrefs already degrades to `{ prefs: {}, contributing: [] }`
// when no layer exists.
function formatPrefsLine(cwd: string): string {
  const { contributing } = readForgePrefs(cwd);
  if (contributing.length === 0) return "Prefs: nenhuma";
  const labels = contributing.map((s) => s.label).join(", ");
  return `Prefs: ${contributing.length} camada(s) (${labels})`;
}

// Exported for tests — keeps formatStatus/formatHelp testable without a full pi mock.
export { formatStatus, formatHelp };
