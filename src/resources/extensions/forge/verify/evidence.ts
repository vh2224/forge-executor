/**
 * Forge evidence — pure builder that turns a harness `tool_execution_end`
 * event into an advisory `ForgeEvent` (`kind: "evidence"`) ready to be
 * appended to the journal by the wiring (`runAuto` subscription, T06).
 *
 * ADVISORY (D-S06-6): this module never blocks anything and never throws —
 * it is a pure data transform. The real `pi.on("tool_execution_end", …)`
 * subscription and the best-effort try/catch around `appendEvent` live in
 * `commands/forge-command.ts` (T06), not here.
 *
 * The `ToolEnd` interface below is a deliberately narrow, hand-rolled subset
 * of the harness's `ToolExecutionEndEvent` (packages/pi-coding-agent,
 * extension-upstream-types: `{ toolCallId, toolName, result, isError }`).
 * We do NOT import that type here — this module stays decoupled from the
 * SDK/vendored `packages/pi-*` tree, per the "verify/* is pure" boundary.
 *
 * `ts` (and `milestone`) are always parameters, never synthesized inside
 * this function (no `Date.now()`) — determinism for callers/tests, mirroring
 * the puro+writer pattern used across S06 (file-audit, artifact-audit, ...).
 *
 * Exports:
 *   evidenceEventFor(unitKey, toolEnd, ts, milestone?) → ForgeEvent
 */

import type { ForgeEvent } from "../state/types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Narrow subset of the harness's `ToolExecutionEndEvent` — only the two
 * fields this builder needs. Intentionally NOT imported from the SDK.
 */
export interface ToolEnd {
  toolName: string;
  isError: boolean;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build an advisory `evidence` `ForgeEvent` from a `tool_execution_end`
 * (represented here as `ToolEnd`).
 *
 * - `kind` is always the literal `"evidence"` — allowed by `ForgeEvent.kind?:
 *   string` (state/types.ts) without touching the closed `ForgeEventKind`
 *   union (that union is extended separately, additively, in T06).
 * - `status` is derived from `isError`: `"error"` if true, else `"ok"`.
 * - `summary` cites the tool name; an empty/missing `toolName` degrades to
 *   `"?"` rather than throwing — this function never throws.
 * - `ts` and `milestone` are always caller-supplied parameters (pure, no
 *   embedded `Date`).
 */
export function evidenceEventFor(
  unitKey: string,
  end: ToolEnd,
  ts: string,
  milestone = "",
): ForgeEvent {
  const toolName = end && typeof end.toolName === "string" && end.toolName.length > 0 ? end.toolName : "?";
  const isError = Boolean(end && end.isError);
  const status = isError ? "error" : "ok";
  const summary = `evidence: tool ${toolName} ${isError ? "falhou" : "ok"}`;

  return {
    ts,
    kind: "evidence",
    unit: unitKey,
    agent: "forge-worker",
    milestone,
    status,
    summary,
  };
}
