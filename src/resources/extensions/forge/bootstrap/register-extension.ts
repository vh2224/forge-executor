/**
 * Forge — defensive bootstrap.
 *
 * Registrations run through an array of `[name, fn]` pairs in a loop with a
 * try/catch per item, so a single failing subsystem never prevents the
 * others from registering or crashes TUI boot. Modeled on the pre-expurgo
 * gsd bootstrap (git show b8eb5c4b^:src/resources/extensions/gsd/bootstrap/register-extension.ts).
 *
 * No `.gsd/` I/O happens here — that is deferred to command handlers.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { findExactModelReferenceMatch } from "@gsd/pi-coding-agent/core/model-resolver.js";
import { registerForgeCommand } from "../commands/forge-command.js";
import { createForgeCommandTool } from "../commands/forge-command-tool.js";
import { createForgeUnitResultTool } from "../worker/unit-result.js";
import { getForgeAutoSession, scopedToolsFor } from "../auto/session.js";
import { effortToThinkingLevel } from "../auto/effort.js";
import { registerQueueWidget } from "../ui/queue-widget.js";
import { registerUnitPanel } from "../ui/unit-panel.js";
import { appendEvent } from "../state/index.js";
import { evidenceEventFor } from "../verify/index.js";
import { unitKeyOf } from "../worker/unit-key.js";

/**
 * Defensive `session_start` hook (B2/B3): when the auto-loop is live and a unit
 * is pending, scope the FRESH session's tools to the worker set and apply the
 * per-unit model — all via THIS instance's live `pi`/`ctx` (never a stale
 * pre-switch handle). When the loop is not active, restore the tool set once.
 *
 * This is the pi-bound counterpart of the driver: `setActiveTools`/`setModel`
 * live on `pi`, not on the `withSession` context, so they must be applied from
 * the fresh instance that owns the replacement session — NOT from `newSession`
 * itself. NO `newSession` is ever called here (B2).
 *
 * ── Token correlation: live-at-delivery + consume-once, NOT frozen ─────────
 * S01/T02 (4d7c8980) froze a `boundToken` default at registration time —
 * built on a FALSE premise: extension bootstraps run once per RUNTIME BUILD,
 * and a same-cwd `newSession` (every worker dispatch in shared isolation)
 * only refreshes the tool registry — it never re-runs this registration. The
 * frozen token was therefore `null` from process boot, the comparison never
 * matched, and NO per-unit model/effort was EVER applied: every worker
 * silently ran the session's default model while the journal recorded the
 * resolution as fact (caught live 2026-07-12 — fable-5 executing tasks the
 * journal attributed to sonnet-5; SDK transcripts in ~/.claude/projects are
 * the ground truth).
 *
 * The correct correlation for `session_start` is live-at-delivery: the driver
 * arms the rendezvous token AND the pending fields synchronously BEFORE
 * `newSession`, dispatches are serialized (R2), and `session_start` is
 * emitted synchronously INSIDE the replacement — a "late" delivery of this
 * event cannot exist (unlike `message_end`). The pending fields are CONSUMED
 * after one delivery (one-shot mailbox), so a later non-dispatch
 * `session_start` (an on-demand review session, a manual new session) can
 * never re-apply a stale unit's model — the guarantee the frozen token was
 * meant to buy, delivered structurally instead.
 */
export function registerAutoUnitSetup(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const s = getForgeAutoSession();

    // Re-publish the LIVE `pi` on every replacement (B3-safe: this hook runs in
    // the FRESH instance, so `pi` is never the stale pre-switch handle). This
    // gives `runAuto` a valid handle to restore the interactive session's
    // tools/model once the loop settles (R2 — nothing else re-narrows after the
    // last unit, so no future hook fires to restore it).
    s.livePi = pi;

    if (!s.active || !s.pendingUnitType) {
      // Loop idle: restore the default tool set once, if we ever narrowed it.
      if (s.defaultActiveTools !== null) {
        try {
          pi.setActiveTools(s.defaultActiveTools);
        } catch {
          /* best-effort */
        }
        s.defaultActiveTools = null;
      }
      return;
    }

    // Scope tools to the worker set for the fresh unit session.
    try {
      if (s.defaultActiveTools === null) s.defaultActiveTools = pi.getActiveTools();
      pi.setActiveTools(scopedToolsFor(s.pendingUnitType, pi.getAllTools().map((t) => t.name)));
    } catch (err) {
      ctx.ui.notify(`[forge] não foi possível escopar as ferramentas da unidade: ${String(err)}`, "warning");
    }

    // Apply the per-unit model best-effort (M1-D6). Correlation is
    // live-at-delivery (see the header): the pending token must match the
    // rendezvous armed by the dispatch that triggered THIS session_start.
    const deliveryToken = s.currentRendezvousToken;
    if (s.pendingUnitModel && deliveryToken !== null && s.pendingUnitModelToken === deliveryToken) {
      try {
        const model = findExactModelReferenceMatch(s.pendingUnitModel, ctx.modelRegistry.getAll());
        if (model) {
          await pi.setModel(model);
          // Mark that a per-unit model was applied so `runAuto` restores the
          // captured baseline model after the loop (the hook never restores it,
          // and `newSession` does not revert it — R2 finding).
          s.modelApplied = true;
          // G1/T01: publish the model that DE FATO ended up active, so the
          // loop's RESULT-event authorship reflects it instead of the merely
          // resolved `pendingUnitModel`.
          s.appliedUnitModel = s.pendingUnitModel;
          s.appliedUnitModelToken = deliveryToken;
        } else {
          ctx.ui.notify(`[forge] modelo por unidade '${s.pendingUnitModel}' não encontrado — usando o modelo da sessão.`, "warning");
          // G1/T01: nothing was applied — the session kept its own model. Null
          // out (not the failed pending ref) so the RESULT event never claims
          // authorship it didn't have.
          s.appliedUnitModel = null;
          s.appliedUnitModelToken = null;
        }
      } catch (err) {
        ctx.ui.notify(`[forge] falha ao aplicar o modelo da unidade — usando o modelo da sessão: ${String(err)}`, "warning");
        // G1/T01: `setModel` threw — same "nothing applied" outcome as not-found.
        s.appliedUnitModel = null;
        s.appliedUnitModelToken = null;
      }
      // Consume-once: this dispatch's delivery happened (whatever the
      // outcome). A later session_start must find nothing to apply.
      s.pendingUnitModel = null;
      s.pendingUnitModelToken = null;
    }

    // S01 effort axis: apply the per-unit effort AFTER the model block —
    // `setModel` re-clamps the thinking level for the new model
    // (`agent-session-model.ts:107`), so the reverse order would lose the
    // unit's effort. Same live-at-delivery correlation + consume-once as the
    // model block; with no effort resolved this block never runs and the
    // dispatch path stays byte-identical (D-S01-3).
    if (s.pendingUnitEffort && deliveryToken !== null && s.pendingUnitEffortToken === deliveryToken) {
      try {
        // Capture the interactive session's baseline ONCE, before the first
        // application, so `runAuto` restores it post-loop (mirror of
        // `baselineModel` — the hook itself never restores).
        if (s.baselineThinkingLevel === null) {
          s.baselineThinkingLevel = pi.getThinkingLevel();
        }
        const requested = effortToThinkingLevel(s.pendingUnitEffort.level);
        pi.setThinkingLevel(requested);
        // Clamp observation (verified empirically against the host): the pi
        // `setThinkingLevel` handler stores the EFFECTIVE post-clamp level in
        // session state (`agent-session-model.ts:173-181`), so a post-set
        // `getThinkingLevel()` reads the clamp directly — the deterministic
        // `clampThinkingLevel` fallback from the plan is not needed.
        const effective = pi.getThinkingLevel();
        // G1 honesty (D-S01-3): publish what was DE FATO applied, with the
        // clamp trail when the host demoted the request.
        s.effortApplied = true;
        s.appliedUnitEffort = {
          level: effective,
          clamped: effective !== requested ? `${requested}→${effective}` : null,
        };
        s.appliedUnitEffortToken = deliveryToken;
      } catch (err) {
        ctx.ui.notify(`[forge] falha ao aplicar o esforço da unidade — mantendo o thinking level da sessão: ${String(err)}`, "warning");
        // Same honesty as the model block: nothing applied → the RESULT event
        // never claims an effort it didn't have.
        s.appliedUnitEffort = null;
        s.appliedUnitEffortToken = null;
      }
      // Consume-once, mirror of the model block.
      s.pendingUnitEffort = null;
      s.pendingUnitEffortToken = null;
    }
  });
}

/**
 * STRICTLY advisory evidence capture (D-S06-6, S06 R2 review-fix). Subscribes
 * to `tool_execution_end` on THIS instance's `pi` and journals one advisory
 * `kind:"evidence"` event per tool end, stamped against the unit in flight
 * (`s.currentUnit`).
 *
 * ── Why here, not in `runAuto` (R2) ─────────────────────────────────────────
 * `runAuto` runs ONCE, in the instance that owns the interactive session; a
 * subscription attached there sits on the pre-loop `pi`. But every worker turn
 * runs in a FRESH instance published by `ctx.newSession()` — which re-runs this
 * bootstrap with its own `pi`. So the ONLY handle that observes the worker's
 * `tool_execution_end` events is the fresh instance's `pi`, and the ONLY way to
 * subscribe to it is from the bootstrap that re-runs per instance — exactly the
 * durable pattern `registerUnitPanel` already uses for the stream widget. The
 * old runAuto-entry subscription captured NOTHING after the first swap.
 *
 * Idempotent: `pi.on` is called once per instance registration (never inside a
 * `session_start` callback), so a single fresh `pi` carries exactly one
 * listener — no accumulation across `session_start` re-fires.
 *
 * Best-effort in every dimension: gated on `s.active` + a unit in flight, the
 * whole body in try/catch (the handler NEVER throws), append-only, never blocks
 * or mutates the worker's turn. `evidence: strict` mode is out of scope.
 */
function registerEvidenceCapture(pi: ExtensionAPI): void {
  pi.on("tool_execution_end", (event, _ctx) => {
    try {
      const s = getForgeAutoSession();
      if (!s.active) return;
      const u = s.currentUnit;
      if (!u) return;
      appendEvent(
        s.cwd,
        evidenceEventFor(
          unitKeyOf(u),
          { toolName: event.toolName, isError: event.isError },
          new Date().toISOString(),
          s.milestoneId,
        ),
      );
    } catch {
      /* advisory — the evidence handler NEVER throws */
    }
  });
}

/**
 * S03/T02 (achado HIGH #3, segunda metade — "429 marca esgotamento"): local,
 * minimal rate-limit classifier over a `message_end` payload. NOT the
 * canonical per-provider-slug error-family classifier (S05) — this only
 * recognizes the unambiguous 429/rate-limit shape the fake provider emits
 * (`packages/pi-ai/src/providers/fake.ts:228-249`, `stopReason:"error"` +
 * `errorMessage:"rate_limit_exceeded"` + `retryAfterMs`) and any real
 * provider following the same `AssistantMessage` contract
 * (`packages/pi-ai/src/types.ts:316-329`): `stopReason === "error"` AND
 * EITHER `retryAfterMs` is present (the server explicitly asked for a retry
 * delay) OR `errorMessage` (lowercased) contains one of a small, deliberately
 * literal term list — `rate`, `429`, `rate_limit`, `quota`, `overloaded`.
 * Anything else — including other `stopReason:"error"` failures with no
 * rate-limit signal — is deliberately NOT classified as exhaustion; a
 * generic error must never mark a credential exhausted.
 */
export function isRateLimitError(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown; retryAfterMs?: unknown };
  if (m.role !== "assistant" || m.stopReason !== "error") return false;
  if (typeof m.retryAfterMs === "number" && Number.isFinite(m.retryAfterMs)) return true;
  if (typeof m.errorMessage !== "string") return false;
  const lower = m.errorMessage.toLowerCase();
  return ["rate", "429", "rate_limit", "quota", "overloaded"].some((term) => lower.includes(term));
}

/**
 * S03/T02 (achado HIGH #3, segunda metade): `message_end` hook (instância
 * fresh, B3-safe, subscrito UMA vez por instância como
 * `registerEvidenceCapture`) que observa o 429 no ponto REAL onde ele chega
 * — uma `AssistantMessage` `stopReason:"error"` entregue via `message_end`,
 * NÃO o `catch` de `newSession` (que mapeia para `worker_turn_error`; ver
 * S03-PLAN §Descobertas 2). Em rate-limit + `s.selectedCredential` (T01,
 * widened S04/T02) + `s.credentialRotator` presentes, chama
 * `markExhausted(provider, identity, nowMs)` — a IDENTIDADE publicada pelo
 * driver, nunca o índice — para EXATAMENTE a credencial que de fato rodou
 * este dispatch, mesmo que o array tenha sido reordenado nesse meio-tempo.
 *
 * STRICTLY best-effort, espelhando `registerEvidenceCapture`: gated em
 * `s.active` + rotator + `selectedCredential`, corpo inteiro em try/catch
 * (o handler NUNCA lança), nunca toca `result`/`decision`/STATE, nunca
 * bloqueia/re-dispatcha o turno. Sem 429 (turno normal) é um no-op — a
 * credencial selecionada permanece intocada até o próximo dispatch limpá-la
 * (T01, `driver.ts`). Sem `credentialRotator` (caminho pré-S03) ou sem
 * `selectedCredential`, também no-op — nenhum caminho novo alcança
 * dispatches sem multi-conta.
 *
 * ── Correlation: live-at-delivery, NOT frozen (regression 4d7c8980) ────────
 * S01/T02 froze a registration-time `boundToken` here too — but this
 * registration runs ONCE per runtime build (same-cwd `newSession` never
 * re-runs it), so the frozen token was `null` forever and NO exhaustion was
 * EVER marked: the whole multi-account cooldown path was dead. Restored to
 * the pre-T02 live comparison: `selectedCredential.token` (stamped by the
 * driver for the dispatch in flight) vs `currentRendezvousToken` at delivery.
 * Known accepted edge: a message_end draining AFTER the next dispatch armed
 * (early-settle) sees the NEXT dispatch's matching pair and is indistinguishable
 * from a current delivery — R2 serialization makes that window narrow, and a
 * mistaken mark only cools a credential early (recoverable), while the frozen
 * variant marked nothing at all (multi-conta rotation inert).
 *
 * `nowMs` vem de `Date.now()` aqui (extension code — permitido); o store
 * puro (`credential-cooldown.ts`) nunca chama `Date.now()`.
 */
export function registerCredentialExhaustion(pi: ExtensionAPI): void {
  pi.on("message_end", (event, _ctx) => {
    try {
      const s = getForgeAutoSession();
      if (!s.active) return;
      if (!s.credentialRotator) return;
      if (!s.selectedCredential) return;
      if (!isRateLimitError(event.message)) return;
      const deliveryToken = s.currentRendezvousToken;
      if (deliveryToken === null || s.selectedCredential.token !== deliveryToken) return;

      const nowMs = Date.now();
      s.credentialRotator.markExhausted(s.selectedCredential.provider, s.selectedCredential.identity, nowMs);
    } catch {
      /* best-effort — the exhaustion handler NEVER throws */
    }
  });
}

/** Write a bootstrap warning without ever throwing — a broken logger must
 *  not re-enter or crash the registration loop. */
function logBootstrapWarning(subsystem: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[forge] bootstrap: failed to register ${subsystem}: ${message}`);
  } catch {
    /* stderr is also broken; nothing we can do */
  }
}

export function registerForgeExtension(pi: ExtensionAPI): void {
  const registrations: Array<[string, () => void]> = [
    ["command", () => registerForgeCommand(pi)],
    ["command.forge-command-tool", () => pi.registerTool(createForgeCommandTool(pi))],
    // R1 (M1R-1 review-fix, round 2): bind the tool's rendezvous token to
    // THIS fresh instance's registration moment, never re-read live — see
    // `worker/unit-result.ts` header for the full mechanism.
    [
      "worker.unit-result",
      () => pi.registerTool(createForgeUnitResultTool(getForgeAutoSession().currentRendezvousToken)),
    ],
    // Live-at-delivery correlation (see registerAutoUnitSetup header): this
    // bootstrap runs once per runtime build, NOT per newSession — a token
    // captured here would be null forever (regression 4d7c8980).
    ["auto.unit-scope", () => registerAutoUnitSetup(pi)],
    ["auto.evidence-capture", () => registerEvidenceCapture(pi)],
    ["auto.credential-exhaustion", () => registerCredentialExhaustion(pi)],
    ["ui.queue-widget", () => registerQueueWidget(pi)],
    ["ui.unit-panel", () => registerUnitPanel(pi)],
  ];

  for (const [name, register] of registrations) {
    try {
      register();
    } catch (err) {
      logBootstrapWarning(name, err);
    }
  }
}
