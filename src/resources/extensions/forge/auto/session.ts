/**
 * `auto/session.ts` — the `ForgeAutoSession` container: the small, mutable,
 * MODULE-LEVEL singleton that carries the auto-loop's live state across
 * `ctx.newSession()` session replacements (S03-PLAN § B1).
 *
 * ── Why module-level (the whole point) ──────────────────────────────────────
 * `ctx.newSession()` is a session REPLACEMENT, not a spawn: it tears down the
 * current runtime and rebinds the extension into a brand-new instance with a
 * brand-new `pi`/`ctx`. What survives that rebind is the Node *module cache* —
 * so a value reachable through a module-level singleton is the only object both
 * the pre-switch loop closure AND the post-switch fresh instance (tool handler,
 * `session_start` hook) can reach in common. That is exactly the mechanism the
 * gsd 1.0 `AutoSession` relied on, ported here in enxuta form: this M1 container
 * holds ONLY the handful of fields the loop actually needs — never the ~80
 * fields of the 1.0 class.
 *
 * Single-writer note (D3): this container is pure in-memory coordination state.
 * It NEVER writes STATE.md — the loop is the single STATE writer, exclusively
 * through the S02 store's `updateState`/`appendEvent`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
// S01/T03: the HOST's ThinkingLevel (`@gsd/pi-agent-core`, includes "off"),
// not `@gsd/pi-ai`'s 5-level union — `pi.getThinkingLevel()` legitimately
// returns "off" (thinking disabled interactively, or clamped by a model with
// no thinking support), and both the captured baseline and the applied
// effective level must round-trip that value.
import type { ThinkingLevel } from "@gsd/pi-agent-core";
import type { NextUnit } from "../state/index.js";
import type { ComposableUnit } from "../prompts/compose.js";
import type { ResolvedEffort } from "./effort.js";
import { readForgePrefs } from "../prefs.js";
import {
  FORGE_MCP_UNIT_RESULT_TOOL,
  FORGE_UNIT_RESULT_TOOL_BARE,
} from "../worker/mcp-bridge.js";
import type {
  CredentialRotator,
  ProviderReadinessSignal,
} from "@forge/agent-core/credential-rotation.js";
import type { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";

/** Default per-unit worker timeout (B4). Overridable by env / pref — see `resolveUnitTimeoutMs`. */
export const NEW_SESSION_TIMEOUT_MS = 120_000;

/** Core (non-forge) tools a worker unit is scoped to. Filtered against the live tool set. */
const CORE_WORKER_TOOLS = ["read", "bash", "edit", "write", "find", "grep", "ls"] as const;

/**
 * In-process web tools the `research-models` unit is additionally scoped to
 * (S04/T02). Names verbatim as registered by the `search-the-web` extension:
 * `fetch_page` (key-free, always registered), `search-the-web` and
 * `search_and_read` (both key-gated — only registered when a search provider
 * key resolves). Registration is lazy, so any of these may be absent from the
 * fresh session's tool set; `scopedToolsFor` intersects with
 * `availableToolNames`, which is the degrade mechanism — absence is normal
 * state, never an error.
 */
const WEB_RESEARCH_TOOLS = ["fetch_page", "search-the-web", "search_and_read"] as const;

/**
 * The live auto-loop container. Exactly one instance exists per process (see
 * `getForgeAutoSession`). All fields are mutable coordination state; `reset()`
 * returns it to the inert "no loop running" shape in one call.
 */
export class ForgeAutoSession {
  /** True while a `/forge auto` (or `/forge next`) loop is running. */
  active = false;

  /**
   * The MOST RECENT live command context. Re-pointed to the fresh
   * `ReplacedSessionContext` inside every `withSession` (B3): after the first
   * `newSession`, this is the ONLY session handle the driver ever uses — a
   * handle captured pre-switch is stale and must never be reused.
   */
  cmdCtx: ExtensionCommandContext | null = null;

  /** Working directory the loop reads/writes forge state under. */
  cwd = "";

  /**
   * Root session path captured once at command bootstrap for this entire run.
   * This is intentionally run-scoped rather than token-paired per-dispatch:
   * it is immutable lineage metadata, does not affect authorship, cooldown, or
   * STATE/B3 replacement semantics, and each bootstrap overwrites it before a
   * dispatch. No post-`newSession` code rewrites it, so it cannot go stale
   * within a run; `reset()` clears it before a subsequent run.
   */
  runRootSessionPath: string | null = null;

  /**
   * The active milestone id, captured by `runAuto` at loop entry. Read by the
   * durable evidence subscription (`registerEvidenceCapture`, S06 R2 review-fix)
   * to stamp each advisory `evidence` event with its milestone — the hook runs
   * in a fresh post-`newSession` instance with no direct STATE handle, so it
   * reads the id from this singleton instead of re-reading STATE.md per event.
   */
  milestoneId = "";

  /**
   * The unit currently being dispatched (diagnostic / step-mode). Widened to
   * `ComposableUnit` (S04/T03, D-S04-2) so a direct-dispatch caller (e.g.
   * `/forge research-models`) can publish its unit exactly like the loop does.
   */
  currentUnit: ComposableUnit | null = null;

  /**
   * The epoch token of the rendezvous currently armed for the in-flight
   * dispatch (M1R-1), published by the driver via `armRendezvous` BEFORE
   * `newSession`. Read by `worker/unit-result.ts` (`forge_unit_result`,
   * running in the fresh post-rebind instance) so it can correlate its
   * delivery to the CURRENT attempt's rendezvous — a late delivery from an
   * abandoned attempt (stale token) is a no-op instead of corrupting a
   * subsequent retry's rendezvous.
   */
  currentRendezvousToken: number | null = null;

  /** Per-unit retry tally for the current run (B4: whole-unit, at most once). */
  retryCount = new Map<string, number>();

  /**
   * The unit type of the pending dispatch, read by the fresh instance's
   * `session_start` hook to scope tools + apply the per-unit model. Set by the
   * driver BEFORE `newSession`, so the hook in the NEW instance sees it.
   */
  pendingUnitType: string | null = null;

  /**
   * The per-unit model pref (`provider/model-id`) for the pending dispatch, or
   * null. Its companion token freezes which dispatch may consume it.
   */
  pendingUnitModel: string | null = null;

  /** Rendezvous token stamped with `pendingUnitModel`; stale session_start hooks must not consume it. */
  pendingUnitModelToken: number | null = null;

  /**
   * S01 effort axis: the RESOLVED effort (`{ level, reason }`) for the pending
   * dispatch, or null when the unit has no effort config (byte-identity path —
   * the hook then never calls `setThinkingLevel`). Mirrors `pendingUnitModel`:
   * set by the driver BEFORE `newSession`, consumed by the fresh instance's
   * `session_start` hook, gated by its companion token.
   */
  pendingUnitEffort: ResolvedEffort | null = null;

  /** Rendezvous token stamped with `pendingUnitEffort`; stale session_start hooks must not consume it. */
  pendingUnitEffortToken: number | null = null;

  /**
   * The single model-authority resolution published before `unit_dispatched`.
   * This is per-dispatch coordination state that survives `newSession` rebind,
   * like `pendingUnitModel` and `selectedCredential`; unlike the hook-owned
   * model fields below, it is consumed synchronously by the driver.
   */
  resolvedDispatchAuthor: {
    provider: string | null;
    model: string | null;
    family: string | null;
    violation?: "reviewer_not_author";
    /**
     * S09/T03: the cross-pool judgment's audit trail (`rankUnion`'s
     * `reason`, `role.ts`'s `rank_reason`) — additive, present ONLY when
     * the judgment branch decided authorship. Consumed synchronously by
     * the SAME dispatch's `dispatchedEvent` (`.gsd/CODING-STANDARDS.md:112`
     * §"Campo por-dispatch exige token/epoch" — same documented exception
     * as this field's siblings above: no token needed for a value read and
     * discarded within one dispatch, never surviving a `newSession` rebind).
     */
    rankReason?: string;
    /** S09/T03: the `domain` that drove `rankReason` — present only alongside it. */
    domain?: string;
  } | null = null;

  /**
   * S01 effort axis: the single effort resolution published before
   * `unit_dispatched`, mirror of `resolvedDispatchAuthor` — consumed
   * synchronously by the driver/loop within the SAME dispatch (journals the
   * resolved effort on the dispatched event), so it carries no token by the
   * same allowlisted justification.
   */
  resolvedDispatchEffort: ResolvedEffort | null = null;

  /**
   * G1 T01: the model (`provider/model-id`) the `session_start` hook DE FATO
   * applied via `setModel` for the pending unit, or `null` if none was applied
   * / the application failed. Published by the hook (`register-extension.ts`),
   * never by the driver — it is the only writer that knows `setModel`'s
   * outcome. Read by the loop AFTER the dispatch settles to author the RESULT
   * event with what actually ran, not what was merely resolved pre-dispatch.
   * `appliedUnitModelToken` gates this read so a stale hook cannot author a
   * later dispatch.
   */
  appliedUnitModel: string | null = null;

  /** Token of the dispatch whose model `session_start` actually applied; null when none applied. */
  appliedUnitModelToken: number | null = null;

  /**
   * S01 effort axis, mirror of `appliedUnitModel` (D-S01-3): the thinking
   * level the `session_start` hook DE FATO applied via `setThinkingLevel` for
   * the pending unit — the EFFECTIVE post-clamp level, plus the clamp record
   * (`"<pedido>→<efetivo>"`, e.g. `"high→medium"`) or `null` when no clamp
   * happened. Published by the HOOK, never by the driver — it is the only
   * writer that observes `setThinkingLevel`'s outcome. Read by the loop AFTER
   * the dispatch settles to author the RESULT event with what actually ran;
   * `appliedUnitEffortToken` gates that read (same G1 discipline).
   */
  appliedUnitEffort: { level: ThinkingLevel; clamped: string | null } | null = null;

  /** Token of the dispatch whose effort `session_start` actually applied; null when none applied. */
  appliedUnitEffortToken: number | null = null;

  /**
   * S03/T01 (achado HIGH #3): the `CredentialRotator` `runAuto` builds over
   * `ctx.modelRegistry.authStorage` (a public `readonly` field — no
   * `packages/pi-*` patch involved) and publishes here BEFORE the loop
   * starts, so the driver can reach it across every `newSession` replacement
   * the same way it reaches `livePi`/`appliedUnitModel`. `null` on every
   * pre-S03 path (no multi-account config, or a test container that never
   * calls `runAuto`) — the driver's no-rotator branch then stays byte-
   * identical to S02: `resolveModelForRole` gets `{ session: s }` with no
   * `availabilityProbe`, and `selectedCredential` never gets published.
   */
  credentialRotator: CredentialRotator | null = null;

  /**
   * S01/T01: run-scoped readiness from the live ModelRegistry. This is
   * immutable during a run and does not affect dispatch authorship or
   * credential cooldown, so it is intentionally not token-paired (D16).
   */
  providerReadiness: ProviderReadinessSignal | null = null;

  /**
   * S01/T01: the real vendored AuthStorage used by the native pi-ai request
   * path. The driver publishes the selected api_key as a runtime override on
   * this handle and clears it when the dispatch ends. Null keeps contexts
   * without a model registry and all pre-rotation paths byte-identical.
   */
  authStorageForOverride: AuthStorage | null = null;

  /**
   * S03/T01, widened S04/T02: the `{ provider, index, identity, token }` the driver
   * selected via `credentialRotator.selectCredential` for the dispatch in
   * flight — the WINNING provider's credential, resolved AFTER
   * `resolveModelForRole` picks it (never the session baseline). `index` is
   * retained for diagnostics/handoff only; `identity` (the stable key —
   * `key` for `api_key`, `refresh` for `oauth`, see `credentialIdentity`) is
   * what the `message_end` hook must pass to `markExhausted` so a 429 cools
   * the credential that actually ran even if the array reordered between
   * selection and the hook firing. Never raw credential content
   * (`credential-cooldown.ts` §"Identity is by stable key, never content").
   * Cleared at the start of every dispatch (same point as the
   * `appliedUnitModel` clear) and in `reset()`, so a selection never leaks
   * from one unit to the next. The rendezvous token correlates this selection
   * to the dispatch that made it; the message_end hook only marks exhaustion
   * when it matches `currentRendezvousToken` (stale = no-op).
   */
  selectedCredential: { provider: string; index: number; identity: string; token: number } | null = null;

  /**
   * R2 (review-fix): the still-in-flight `dispatch` promise of the MOST RECENT
   * `dispatchUnitViaNewSession`, so the NEXT dispatch can serialize against it.
   * On an early-settle (or wall-clock ceiling) the dispatch RETURNS while its
   * abandoned `newSession` turn is still draining — this field lets the next
   * dispatch wait (bounded) for that residual turn to unwind before starting a
   * new `newSession` on the same host, so two `newSession` calls never overlap
   * un-serialized. Cleared when the dispatch settles. Never a stale pre-switch
   * handle — it is a plain promise, safe across the `newSession` rebind (B3).
   */
  pendingDispatch: Promise<unknown> | null = null;

  /**
   * The active-tool set captured the first time the loop narrows tools, so the
   * `session_start` hook can restore it once the loop is no longer active.
   */
  defaultActiveTools: string[] | null = null;

  /**
   * The LIVE `pi` (`ExtensionAPI`) of the most recent instance. `setActiveTools`/
   * `setModel` live on `pi`, not on the command/replaced-session context — and
   * the `pi` closed over by `registerForgeCommand` goes stale after any
   * `newSession` (B3). So the `session_start` hook re-publishes THIS field with
   * its own fresh `pi` on every replacement, giving `runAuto` a never-stale
   * handle to restore the interactive session's tools/model once the loop ends.
   */
  livePi: ExtensionAPI | null = null;

  /**
   * The interactive session's model captured before the loop narrowed anything,
   * so `runAuto` can restore it if a per-unit model was applied (the hook only
   * APPLIES a per-unit model, it never restores the baseline — and `newSession`
   * does not revert it either). `undefined` when unknown.
   */
  baselineModel: ExtensionCommandContext["model"] = undefined;

  /** True once the hook applied a per-unit model — gates the baseline restore. */
  modelApplied = false;

  /**
   * S01 effort axis: the interactive session's thinking level captured before
   * the hook first applied a per-unit effort, so `runAuto` can restore it once
   * the loop ends (mirror of `baselineModel` — the hook only APPLIES, never
   * restores). Run-scoped restore state, not a dispatch decision. `null` when
   * unknown / nothing was ever applied.
   */
  baselineThinkingLevel: ThinkingLevel | null = null;

  /** True once the hook applied a per-unit effort — gates the baseline thinking-level restore (mirror of `modelApplied`). */
  effortApplied = false;

  /**
   * T02 queue-widget hookup (option (a), S04-PLAN § step 3): re-published by
   * `registerQueueWidget`'s `session_start` hook on every fresh instance
   * (B3-safe — never a stale pre-switch handle), and invoked by the loop
   * (`auto/loop.ts`) whenever `currentUnit` changes and in its `finally`. Kept
   * on the module-level singleton — NOT cleared by `reset()` — so the widget
   * stays wired across loop runs; the loop always calls it with `null` on
   * completion, which is what actually clears the footer status.
   */
  onUnitChange: ((unit: NextUnit | null) => void) | null = null;

  /**
   * Running token total for the unit currently in flight, summed from
   * `message_end`/usage when the harness exposes it. Left `undefined` in T02
   * (no stream subscription yet — that is T03); the widget tolerates its
   * absence and simply omits the token segment. Reset per loop run.
   */
  unitTokens: number | undefined = undefined;

  /**
   * T03 unit-panel live stream buffer: the last N formatted lines of the
   * in-flight worker's turn (tool calls + assistant text), appended by the
   * `registerUnitPanel` hooks running on the FRESH instance (B3-safe) and read
   * by the collapsible panel renderer. Kept on the module-level singleton for
   * the SAME reason as `livePi`/`onUnitChange`: it is the only object both the
   * pre-switch loop closure and the post-switch fresh instance reach in common,
   * so it survives `newSession` replacement. Ring-limited by the panel; cleared
   * per-unit (fresh dispatch) and on loop end. A mutable array (cleared in place
   * with `.length = 0`) so the reference stays stable across renders.
   */
  workerStream: string[] = [];

  /**
   * S04/T01: the live review-turn identity, published by `review/dispatch.ts`
   * per dialectic turn (T02) — `role` is the TURN (`challenger`/`advocate`/
   * `rebuttal`), never the dispatch `Role` from `auto/role.ts`. `token` is a
   * PUBLISHER-owned monotonic epoch, deliberately NOT `currentRendezvousToken`
   * (D16/M1R-1): reviews never arm a rendezvous, so gating on the dispatch
   * rendezvous would be both wrong and meaningless here. The clear is
   * correlated to that SAME token, so a delayed clear from an abandoned turn
   * can never erase a newer turn's publication. Written justification for the
   * token exception (CODING-STANDARDS §"Campo por-dispatch exige
   * token/epoch"): the reader (`ui/identity.ts`) is strictly display-only —
   * zero impact on authorship, cooldown, or STATE. Cleared in `reset()`.
   */
  reviewActivity: {
    role: "challenger" | "advocate" | "rebuttal";
    model: string | null;
    family: string | null;
    scope: string;
    token: number;
  } | null = null;

  /**
   * S04 REVIEW-FIX (R1, D16/M1R-1): best-effort render callbacks that widgets
   * surfacing `reviewActivity` register on themselves. `publishReviewActivity`/
   * `clearReviewActivity` (`review/dispatch.ts`) invoke every registered
   * callback right after mutating `reviewActivity`, so the widgets can render
   * the change immediately instead of waiting for an unrelated
   * session/tool/message event to trigger the next render — the gap the
   * objection raised (a completed final review turn's clear was otherwise
   * invisible until something else happened to redraw). A `Set`, unlike the
   * single-nullable `onUnitChange`, because more than one widget subscribes
   * (the unit panel AND the queue-widget footer); each widget's `session_start`
   * hook removes its OWN previous entry before adding a fresh-`ctx`-bound one
   * (B3 — a stale pre-`newSession` callback must never linger in the set). Not
   * cleared by `reset()` — stays wired across loop runs, same posture as
   * `onUnitChange`.
   */
  reviewActivityListeners: Set<() => void> = new Set();

  /** Clear every field back to the inert shape in one call. */
  reset(): void {
    this.active = false;
    this.cmdCtx = null;
    this.cwd = "";
    this.runRootSessionPath = null;
    this.milestoneId = "";
    this.currentUnit = null;
    this.currentRendezvousToken = null;
    this.retryCount.clear();
    this.pendingUnitType = null;
    this.pendingUnitModel = null;
    this.pendingUnitModelToken = null;
    this.pendingUnitEffort = null;
    this.pendingUnitEffortToken = null;
    this.resolvedDispatchAuthor = null;
    this.resolvedDispatchEffort = null;
    this.appliedUnitModel = null;
    this.appliedUnitModelToken = null;
    this.appliedUnitEffort = null;
    this.appliedUnitEffortToken = null;
    this.credentialRotator = null;
    this.providerReadiness = null;
    this.authStorageForOverride = null;
    this.selectedCredential = null;
    this.pendingDispatch = null;
    this.defaultActiveTools = null;
    this.livePi = null;
    this.baselineModel = undefined;
    this.modelApplied = false;
    this.baselineThinkingLevel = null;
    this.effortApplied = false;
    this.unitTokens = undefined;
    this.workerStream.length = 0;
    this.reviewActivity = null;
  }
}

/** The process-wide singleton — created lazily, survives session replacement. */
let singleton: ForgeAutoSession | null = null;

/** Return the process-wide `ForgeAutoSession` singleton, creating it on first use. */
export function getForgeAutoSession(): ForgeAutoSession {
  if (!singleton) singleton = new ForgeAutoSession();
  return singleton;
}

/** Parse a positive finite integer from a string, or `null` if it is not one. */
function positiveInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the per-unit worker timeout in ms (B4), highest precedence first:
 *   1. `FORGE_UNIT_TIMEOUT_MS` env  (wins — used to make e2e fast)
 *   2. flat pref `unit_timeout_ms`  (4-layer cascade)
 *   3. `NEW_SESSION_TIMEOUT_MS`     (default)
 */
export function resolveUnitTimeoutMs(cwd: string): number {
  const fromEnv = positiveInt(process.env.FORGE_UNIT_TIMEOUT_MS);
  if (fromEnv !== null) return fromEnv;

  const { prefs } = readForgePrefs(cwd);
  const fromPref = positiveInt(prefs["unit_timeout_ms"]);
  if (fromPref !== null) return fromPref;

  return NEW_SESSION_TIMEOUT_MS;
}

/**
 * Resolve the per-unit model pref (M1-D6). FLAT keys only — the S01 prefs parser
 * does not support nested blocks (empirical S02/T01 finding). Returns the raw
 * `provider/model-id` string, or `null` to fall back to the session model.
 *
 * The pool-of-one primitive `resolveModelForRole` (`auto/role.ts`, the G2 seam)
 * delegates to via `effectiveModelFor` below — kept here unchanged; callers
 * that need the seam's `{ model, provider, family }` contract should go
 * through the seam rather than calling this directly (S02/T02).
 */
export function resolveUnitModel(cwd: string, unitType: string): string | null {
  const key =
    unitType === "plan-slice"
      ? "unit_model_plan_slice"
      : unitType === "execute-task"
        ? "unit_model_execute_task"
        : null;
  if (!key) return null;

  const { prefs } = readForgePrefs(cwd);
  const raw = prefs[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * The `{ provider, model }` of the model that will actually run `unit` —
 * highest precedence first: the per-unit model pref (`resolveUnitModel`, flat
 * `provider/model-id`) or, if already published on the container, the pending
 * dispatch's model; otherwise the LIVE session model. The live handles
 * (`s.cmdCtx?.model`, `s.baselineModel`) are read from the container, never
 * from a pre-switch capture (B3). Fields are `null` when nothing is known —
 * callers must never synthesize `""`/`"null"` in their place (G1).
 *
 * G2 seam (S02/T02, Option A): this IS the single precedence implementation —
 * `resolveModelForRole` (`auto/role.ts`) is a thin wrapper that delegates
 * straight here (+ `familyOf`) on its degrade path, rather than re-deriving
 * precedence. Callers that need the resolved model for a NEW dispatch (the
 * seam's purpose) go through `resolveModelForRole` — `loop.ts`'s authorship
 * recording site does too as of G1/T01, so this function is no longer called
 * directly for authorship; it survives as the seam's degrade body and for any
 * other caller that only needs the raw precedence (no config/role routing).
 */
export function effectiveModelFor(
  s: ForgeAutoSession,
  unit: ComposableUnit,
): { provider: string | null; model: string | null } {
  const perUnit = resolveUnitModel(s.cwd, unit.type) ?? s.pendingUnitModel;
  if (perUnit) {
    // Flat `provider/model-id` (S02/T01 finding) — the provider is the prefix.
    const slash = perUnit.indexOf("/");
    return {
      provider: slash > 0 ? perUnit.slice(0, slash) : perUnit,
      model: perUnit,
    };
  }
  return {
    model: s.cmdCtx?.model?.id ?? s.baselineModel?.id ?? null,
    provider: s.cmdCtx?.model?.provider ?? s.baselineModel?.provider ?? null,
  };
}

/**
 * The provider slug of the model that will actually run `unit` — see
 * `effectiveModelFor` for the precedence rules; this delegates to it.
 */
function effectiveProviderFor(s: ForgeAutoSession, unit: ComposableUnit): string | null {
  return effectiveModelFor(s, unit).provider;
}

/**
 * The `forge_unit_result` tool name to instruct in the worker's prompt, resolved
 * from the EFFECTIVE provider of `unit` (B2). On the `claude-code` (externalCli /
 * SDK) provider the tool is exposed namespaced as `mcp__forge__forge_unit_result`
 * (the MCP bridge); every other provider — including the in-process fake used by
 * the e2e — sees the bare `forge_unit_result`. The namespacing is therefore
 * CONDITIONAL on the externalCli path and never leaks into the in-process path
 * (W2). Names come from the bridge constants — never re-declared here.
 */
export function resolveUnitResultToolName(s: ForgeAutoSession, unit: ComposableUnit): string {
  return effectiveProviderFor(s, unit) === "claude-code"
    ? FORGE_MCP_UNIT_RESULT_TOOL
    : FORGE_UNIT_RESULT_TOOL_BARE;
}

/**
 * The tool set a worker unit of `unitType` is scoped to: the core read/write/
 * exec tools that actually exist in the live session PLUS the mandatory
 * `forge_unit_result` commit-point tool. `availableToolNames` comes from
 * `pi.getAllTools()` in the fresh instance, so we only ever enable real tools.
 *
 * M1 kept `unitType` in the signature so a future slice could branch per type
 * without a call-site change; the S03/T05 note ("no branch needed yet") is now
 * history — S04/T02 introduces the first real branch: `research-models` widens
 * the wanted set with `WEB_RESEARCH_TOOLS` (still intersected with
 * `availableToolNames`, so missing web tools degrade silently to the core
 * set). Every other unit type keeps the exact same core superset as before.
 */
export function scopedToolsFor(unitType: string, availableToolNames: string[]): string[] {
  // DEC-S01-2 (B2): this scopes tools PI-SIDE on the fresh instance. On the
  // externalCli (claude-code) path the subprocess `claude` runs its OWN tool set
  // (including native WebSearch/WebFetch) and never sees this scope nor executes
  // the pi-side `forge_unit_result` — it uses the namespaced
  // `mcp__forge__forge_unit_result` from the MCP bridge instead. Keeping the bare
  // `forge_unit_result` in the pi-side scope is inert on that path and preserves
  // the in-process path (W2), so this is deliberately left unchanged — not omitted.
  const wanted = new Set<string>([...CORE_WORKER_TOOLS, "forge_unit_result"]);
  if (unitType === "research-models") {
    // Added BEFORE the availableToolNames filter: the intersection is the
    // degrade path (key-gated tools may be unregistered) — never an
    // unconditional push like forge_unit_result, which is our own tool.
    for (const t of WEB_RESEARCH_TOOLS) wanted.add(t);
  }
  const scoped = availableToolNames.filter((n) => wanted.has(n));
  if (!scoped.includes("forge_unit_result")) scoped.push("forge_unit_result");
  return scoped;
}
