/**
 * `ui/unit-panel.ts` — collapsible live worker panel (S04 ROADMAP visibility scope).
 *
 * During an active `/forge auto`|`next` loop, the worker unit runs in a REPLACED
 * child session. This panel streams what that worker is doing — its tool calls
 * and assistant text — into a widget above the editor, so the operator can watch
 * the unit turn live. Collapsed by default (a single summary line); the expand
 * shortcut toggles it to the last few buffered lines plus the unit token total.
 *
 * ── B3 (stale-handle) ────────────────────────────────────────────────────────
 * Every subscription (`tool_execution_start` / `message_update` / `message_end`)
 * and the shortcut handler render THROUGH the `ctx` the handler is invoked with —
 * which, because these hooks fire in the FRESH instance, is never a pre-`newSession`
 * captured handle. Same discipline as `registerAutoUnitSetup` and the queue widget.
 *
 * ── Buffer lives on the singleton ───────────────────────────────────────────
 * The line buffer is `ForgeAutoSession.workerStream` (module-level singleton) so
 * it survives session replacement — the pure append/render helpers below never
 * touch the harness and are unit-tested in isolation.
 *
 * ── Telemetry-tolerant (RESEARCH S04) ────────────────────────────────────────
 * `message_end.usage.total` is summed into `ForgeAutoSession.unitTokens` when the
 * harness exposes it (Anthropic path) and simply omitted when absent (claude-code
 * path can lack usage) — the panel NEVER breaks or renders a fabricated "0 tok".
 *
 * ── Shortcut choice (S04-PLAN § step 3) ──────────────────────────────────────
 * The plan proposed Ctrl+O, but `ctrl+o` is already bound TWICE in the harness
 * (`app.tools.expand` "Toggle tool output" and `app.tree.filter.cycleForward`,
 * see `packages/forge-agent-core/src/keybindings.ts`). To avoid the collision we
 * bind the nearest free chord, **Ctrl+B** (mnemonic: worker Buffer). Documented
 * as a deviation in T03-SUMMARY.
 *
 * ── Identity (S04/T03) ───────────────────────────────────────────────────────
 * `renderInto` is the ONLY place this file reads new state: it computes
 * `formatIdentity(currentIdentity(s))` from `ui/identity.ts` (T01) and passes
 * the result through as `UnitPanelInput.identity` — the pure `renderPanel`
 * function itself never touches the container. When present, `identity`
 * replaces the generic `worker` label on both the collapsed strip (leading
 * segment before the narrative dash) and the expanded header (after the `▾ `
 * marker); when absent (idle-derived identity, i.e. `currentIdentity` returns
 * `null`) both surfaces render byte-identical to their pre-T03 shape. While a
 * review turn is in flight, `currentIdentity` prefers `reviewActivity` over
 * the unit (D16/M1R-1), so the strip/panel show the review identity without
 * this file knowing anything about reviews. REVIEW-FIX (S04/R1): the
 * `session_start` hook also registers a render callback on
 * `ForgeAutoSession.reviewActivityListeners`, so `review/dispatch.ts`'s
 * publish/clear can push a re-render the moment `reviewActivity` changes —
 * without that, the panel could keep showing a finished turn's identity
 * (e.g. `rebuttal`) until an unrelated tool/message event happened to redraw.
 *
 * ── Linha viva (S04/T04) ─────────────────────────────────────────────────────
 * `tool_execution_start` now appends a FIRST-CLASS action line via the pure
 * `formatToolLine` — bash renders as `$ <command>`, other tools as `<toolName>
 * <primary-arg>` (reusing `summarizeArgs`) — carrying a trailing running
 * marker (` ⋯`, distinct from `oneLine`'s truncation `…`) while the tool is
 * in flight. `tool_execution_end` finalizes that SAME line in place via the
 * pure `finishToolLine`: the marker is stripped, and an error appends ` ✗`.
 * Matching prefers the harness's `toolCallId` (exposed on both events, see
 * `extension-upstream-types.ts`'s `ToolExecutionStartEvent`/`ToolExecutionEndEvent`)
 * via a module-local `toolCallId → buffer index` map populated by the start
 * handler; the map lives in this module (survives `newSession` — bootstrap
 * registers `registerUnitPanel` once, not per session, same as the `collapsed`
 * flag below) and is cleared wherever the buffer itself is cleared, so a
 * stale entry can never outlive its buffer. `finishToolLine` itself stays
 * PURE and defensive: it re-verifies the candidate index still holds a
 * running line for that `toolName` before trusting it (guards a ring-splice
 * having shifted content under a since-stale index) and falls back to "last
 * running line with that toolName" — a genuine miss (end with nothing to
 * finish) is a silent no-op, never a throw. `tool_execution_end` is
 * display-only, gated on `s.active`, mirroring `registerEvidenceCapture`'s
 * posture; it does NOT touch the journal (evidence capture owns that).
 * REVIEW-FIX (S04/R2): re-verifying by `toolName` alone cannot tell TWO
 * concurrent same-name calls apart once a trim shifts the buffer — a stale
 * index could land on the wrong call's still-running line and pass the
 * check. `appendStreamLine`/`upsertAssistantLine` now report the trim
 * amount, and the module-local `onTrim` handler shifts every entry in
 * `runningIndexByCallId` by it (dropping an entry whose own line was
 * evicted), so a still-tracked index always points at ITS call's line, not
 * merely "a" running line for that tool name.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { KeyId } from "@gsd/pi-tui";
import { getForgeAutoSession } from "../auto/session.js";
// S04/T03 (D-S04-2): widened type-only with `ForgeAutoSession.currentUnit`,
// which this panel renders directly.
import type { ComposableUnit } from "../prompts/compose.js";
import { currentIdentity, formatIdentity, unitLabel } from "./identity.js";

/** `ctx.ui.setWidget` key for the unit panel — cleared with `undefined`. */
export const UNIT_PANEL_KEY = "forge:unit-panel";

/** Keyboard chord that toggles the panel collapsed/expanded (see header note). */
export const UNIT_PANEL_TOGGLE_KEY: KeyId = "ctrl+b";

/** Hint rendered in the collapsed summary line so the chord is discoverable. */
const EXPAND_HINT = "Ctrl+B";

/** Ring cap for the stream buffer — oldest lines drop past this. */
export const MAX_STREAM_LINES = 200;

/** How many buffered lines the expanded panel shows (its tail). */
export const PANEL_EXPANDED_LINES = 12;

/** Prefix marking an assistant-text line (replaced in place while it streams). */
const TEXT_PREFIX = "› ";

/**
 * Trailing marker on a tool line while the tool is still executing (S04/T04).
 * Deliberately a different glyph (U+22EF) from `oneLine`'s truncation
 * ellipsis (`…`, U+2026) so the two are never visually confused.
 */
const RUNNING_MARKER = " ⋯";

/** Collapse a multi-line/overlong fragment to one trimmed, capped line. */
function oneLine(raw: string, cap = 160): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/**
 * REVIEW-FIX (S04/R2): fired with the number of lines dropped from the FRONT
 * whenever `appendStreamLine`/`upsertAssistantLine` ring-trims the buffer.
 * `registerUnitPanel` uses this to keep `runningIndexByCallId`'s stored
 * indices accurate across a trim — without it, two same-name tool calls that
 * are BOTH in flight when a trim shifts the buffer can leave one call's
 * stored index silently pointing at the OTHER call's still-running line,
 * which `finishToolLine`'s toolName-only re-verification cannot tell apart
 * from the correct one.
 */
export type TrimListener = (trimmed: number) => void;

/**
 * Append a line to the ring buffer IN PLACE (stable reference — the singleton
 * holds it), dropping the oldest lines past `maxLines`. Returns the same buffer
 * for chaining/testing. Empty lines are ignored. `onTrim`, when given, is
 * called with the number of front lines dropped (S04/R2) — omitted whenever
 * no trim occurred.
 */
export function appendStreamLine(buf: string[], line: string, maxLines = MAX_STREAM_LINES, onTrim?: TrimListener): string[] {
  const clean = oneLine(line);
  if (!clean) return buf;
  buf.push(clean);
  if (buf.length > maxLines) {
    const trimmed = buf.length - maxLines;
    buf.splice(0, trimmed);
    onTrim?.(trimmed);
  }
  return buf;
}

/**
 * Upsert the CURRENT assistant-text line: while a single assistant message
 * streams, `message_update` fires repeatedly with the full accumulated text — so
 * we replace the trailing text line in place instead of flooding the buffer. If
 * the last line is not a text line (e.g. a tool call just landed), a new text
 * line is started. Returns the same buffer. `onTrim` — see `appendStreamLine`
 * (S04/R2); never called on the in-place-replace path since that never grows
 * the buffer and so can never trim it.
 */
export function upsertAssistantLine(buf: string[], text: string, maxLines = MAX_STREAM_LINES, onTrim?: TrimListener): string[] {
  const clean = oneLine(text);
  if (!clean) return buf;
  const line = `${TEXT_PREFIX}${clean}`;
  const last = buf[buf.length - 1];
  if (typeof last === "string" && last.startsWith(TEXT_PREFIX)) {
    buf[buf.length - 1] = line;
  } else {
    buf.push(line);
    if (buf.length > maxLines) {
      const trimmed = buf.length - maxLines;
      buf.splice(0, trimmed);
      onTrim?.(trimmed);
    }
  }
  return buf;
}

/** Compact token count — `12.3k` / `842`. Mirrors the queue widget's format. */
function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.max(0, Math.trunc(n)));
}

/** The pure input `renderPanel` renders from. */
export interface UnitPanelInput {
  /** The live stream buffer (`ForgeAutoSession.workerStream`). */
  lines: string[];
  /** Collapsed ⇒ one summary line; expanded ⇒ header + buffer tail. */
  collapsed: boolean;
  /** Summed unit tokens, when known. `undefined`/non-finite ⇒ segment omitted. */
  tokens?: number;
  /** The unit in flight, for the header / non-empty-idle gate. */
  currentUnit?: ComposableUnit | null;
  /** Preformatted identity segment (`ui/identity.ts`'s `formatIdentity`), computed by the wiring layer. `null`/absent ⇒ today's fallback shape. */
  identity?: string | null;
}

/**
 * PURE renderer: `{ lines, collapsed, tokens?, currentUnit?, identity? }` →
 * widget lines. Returns `[]` (nothing to show) when there is neither buffered
 * output nor a unit in flight — the loop is idle. Never renders a token
 * segment when `tokens` is absent (telemetry-tolerant). When `identity` is
 * present it replaces the generic `worker` label on both surfaces; absent
 * falls back to today's shape byte-for-byte.
 */
export function renderPanel(input: UnitPanelInput): string[] {
  const { lines, collapsed, tokens, currentUnit, identity } = input;
  if (lines.length === 0 && !currentUnit) return [];

  const last = lines.length > 0 ? lines[lines.length - 1]! : "(iniciando…)";

  if (collapsed) {
    return identity
      ? [`▸ ${identity} — ${last} · ${EXPAND_HINT}`]
      : [`▸ worker: ${last} · ${EXPAND_HINT}`];
  }

  const headSegments = identity ? [`▾ ${identity}`] : ["▾ worker", ...(currentUnit ? [unitLabel(currentUnit)] : [])];
  if (typeof tokens === "number" && Number.isFinite(tokens)) headSegments.push(`${formatTokenCount(tokens)} tok`);

  const tail = lines.slice(-PANEL_EXPANDED_LINES);
  return [headSegments.join(" · "), ...tail];
}

/**
 * Extract the assistant text from a `message_end`/`message_update` payload,
 * runtime-guarded (the value is a union; we tolerate any non-assistant shape).
 * Returns the concatenated text content, or `""` when there is none.
 */
export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== "assistant" || !Array.isArray(m.content)) return "";
  const parts: string[] = [];
  for (const block of m.content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join(" ");
}

/**
 * Extract `usage.total` from an assistant message, runtime-guarded. Returns the
 * finite token total, or `undefined` when the payload lacks usage (claude-code
 * path) — the caller must tolerate that and never fabricate a count.
 */
export function extractUsageTotal(message: unknown): number | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { role?: unknown; usage?: unknown };
  if (m.role !== "assistant" || !m.usage || typeof m.usage !== "object") return undefined;
  const total = (m.usage as { total?: unknown }).total;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

/** Summarize tool args to a short one-liner for the stream line. */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  // Prefer the argument that names the target (path/command), else first scalar.
  for (const key of ["file_path", "path", "command", "pattern", "query"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return oneLine(v, 60);
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.length > 0) return oneLine(v, 60);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return "";
}

/** The "line body" prefix a running/finished line for `toolName` starts with. */
function toolLinePrefix(toolName: string): string {
  return toolName === "bash" ? "$ " : `${toolName} `;
}

/**
 * PURE — format a fresh, IN-FLIGHT stream line for a tool call (S04/T04).
 * `bash` renders as `$ <command>` (the `command` arg, not the generic
 * first-scalar fallback `summarizeArgs` uses for every other tool); every
 * other tool renders as `<toolName> <primary-arg>` via `summarizeArgs`. Always
 * carries the trailing `RUNNING_MARKER` — `finishToolLine` strips it when the
 * matching `tool_execution_end` lands.
 */
export function formatToolLine(toolName: string, args: unknown): string {
  if (toolName === "bash") {
    const obj = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const command = typeof obj.command === "string" ? obj.command : "";
    return `$ ${oneLine(command, 60)}${RUNNING_MARKER}`;
  }
  const summary = summarizeArgs(args);
  const base = summary ? `${toolName} ${summary}` : toolName;
  return `${base}${RUNNING_MARKER}`;
}

/** True when `line` is still-running output of `formatToolLine(toolName, …)`. */
function isRunningLineFor(line: string, toolName: string): boolean {
  return line.endsWith(RUNNING_MARKER) && line.startsWith(toolLinePrefix(toolName));
}

/** Last index in `buf` holding a still-running line for `toolName`, or -1. */
function lastRunningIndexFor(buf: string[], toolName: string): number {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (isRunningLineFor(buf[i]!, toolName)) return i;
  }
  return -1;
}

/**
 * A `tool_execution_end` match hint for `finishToolLine`. `atIndex`, when
 * given, is the wiring layer's best-known buffer index for this tool call
 * (from its module-local `toolCallId → index` map, populated by the
 * `tool_execution_start` handler) — `finishToolLine` re-verifies it before
 * trusting it, so a stale index (buffer ring-spliced between start and end)
 * safely falls through instead of rewriting an unrelated line.
 */
export interface ToolLineMatch {
  toolName: string;
  atIndex?: number;
}

/**
 * PURE — finalize the running line matching `match` IN PLACE: strip the
 * running marker, and append ` ✗` on `isError`. Prefers `match.atIndex` when
 * it still points at a running line for `match.toolName`; otherwise (or on a
 * miss) falls back to the last running line for that `toolName`. No match at
 * all ⇒ silent no-op — a missed finalization is cosmetic, never a throw.
 */
export function finishToolLine(buf: string[], match: ToolLineMatch, isError: boolean): void {
  let idx = -1;
  if (typeof match.atIndex === "number" && match.atIndex >= 0 && match.atIndex < buf.length) {
    const candidate = buf[match.atIndex]!;
    if (isRunningLineFor(candidate, match.toolName)) idx = match.atIndex;
  }
  if (idx === -1) idx = lastRunningIndexFor(buf, match.toolName);
  if (idx === -1) return;
  const finished = buf[idx]!.slice(0, -RUNNING_MARKER.length);
  buf[idx] = isError ? `${finished} ✗` : finished;
}

/** Module-level collapsed flag — survives session replacement (module cache). */
let collapsed = true;

/**
 * REVIEW-FIX (S04/R1): the render callback this module currently has
 * registered on `ForgeAutoSession.reviewActivityListeners`, so `session_start`
 * can remove the stale (pre-`newSession`) one before adding a fresh-`ctx`-bound
 * replacement — never leaving two, never leaving a dangling stale closure.
 */
let reviewActivityListener: (() => void) | null = null;

/**
 * Render the current panel state through the handler's FRESH `ctx` (B3). Clears
 * the widget when the pure renderer yields nothing (idle / empty buffer).
 */
function renderInto(ctx: ExtensionContext): void {
  const s = getForgeAutoSession();
  const id = currentIdentity(s);
  const lines = renderPanel({
    lines: s.workerStream,
    collapsed,
    tokens: s.unitTokens,
    currentUnit: s.currentUnit,
    identity: id ? formatIdentity(id) : null,
  });
  ctx.ui.setWidget(UNIT_PANEL_KEY, lines.length > 0 ? lines : undefined, { placement: "aboveEditor" });
}

/**
 * Wire the collapsible unit panel. Subscribes to the turn/tool/message stream
 * of the FRESH instance and binds the toggle shortcut. All handlers are gated on
 * `getForgeAutoSession().active` and render only through their own `ctx` (B3);
 * the `session_start` hook additionally resets the per-unit buffer/tokens (and
 * the `toolCallId → index` map) at the start of each dispatch and clears the
 * widget when the loop is idle. `tool_execution_start`/`tool_execution_end`
 * render the linha viva (S04/T04) — see the header note.
 */
export function registerUnitPanel(pi: ExtensionAPI): void {
  // S04/T04: toolCallId → workerStream index for the running line it started.
  // Module-local (this closure is installed once per runtime build, not per
  // `newSession` — see the header note), cleared wherever `workerStream`
  // itself is cleared below so a stale entry can never outlive its buffer.
  //
  // REVIEW-FIX (S04/R2): a value of `EVICTED` means "this call WAS tracked,
  // but its own line was ring-trimmed out of the buffer" — distinct from the
  // key being simply absent (never tracked at all). The distinction matters
  // at `tool_execution_end`: an absent key still falls back to "last running
  // line for this toolName" (today's accepted best-effort default for a
  // genuinely-unknown call), but an `EVICTED` entry must NOT fall back —
  // there is provably nothing of THIS call's left to finalize, and falling
  // back would risk finalizing a different in-flight same-name call's line
  // instead (the exact misattribution the finding raised).
  const EVICTED = -1;
  const runningIndexByCallId = new Map<string, number>();

  // Keep every tracked index accurate across a ring trim.
  // `appendStreamLine`/`upsertAssistantLine` only ever drop lines from the
  // FRONT, so every element still present shifts down by exactly `trimmed` —
  // an entry whose index goes negative had its own running line evicted, so
  // it is marked `EVICTED` (not deleted — see above) rather than left
  // pointing at whatever OTHER call's line shifted into its old slot.
  const onTrim: TrimListener = (trimmed) => {
    for (const [callId, idx] of runningIndexByCallId) {
      if (idx === EVICTED) continue;
      const next = idx - trimmed;
      runningIndexByCallId.set(callId, next < 0 ? EVICTED : next);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    const s = getForgeAutoSession();
    // REVIEW-FIX (S04/R1): re-bind this module's render-callback entry to the
    // FRESH ctx (B3) — drop the previous (possibly stale, pre-`newSession`)
    // one first so the set never accumulates dangling closures.
    if (reviewActivityListener) s.reviewActivityListeners.delete(reviewActivityListener);
    reviewActivityListener = () => renderInto(ctx);
    s.reviewActivityListeners.add(reviewActivityListener);
    if (!s.active) {
      // Loop idle: clear the buffer and remove the widget once.
      s.workerStream.length = 0;
      runningIndexByCallId.clear();
      ctx.ui.setWidget(UNIT_PANEL_KEY, undefined);
      return;
    }
    // Fresh unit dispatch: start this unit's stream/telemetry clean.
    if (s.pendingUnitType) {
      s.workerStream.length = 0;
      s.unitTokens = undefined;
      runningIndexByCallId.clear();
    }
    renderInto(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const s = getForgeAutoSession();
    if (!s.active) return;
    appendStreamLine(s.workerStream, formatToolLine(event.toolName, event.args), MAX_STREAM_LINES, onTrim);
    runningIndexByCallId.set(event.toolCallId, s.workerStream.length - 1);
    renderInto(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const s = getForgeAutoSession();
    if (!s.active) return;
    const stored = runningIndexByCallId.get(event.toolCallId);
    runningIndexByCallId.delete(event.toolCallId);
    // REVIEW-FIX (S04/R2): a tracked-but-EVICTED entry means this call's own
    // line is definitively gone — skip `finishToolLine` entirely rather than
    // let it fall back to "last running line for this toolName", which could
    // finalize a different in-flight same-name call's line instead.
    if (stored !== EVICTED) {
      finishToolLine(s.workerStream, { toolName: event.toolName, atIndex: stored }, event.isError);
    }
    renderInto(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    const s = getForgeAutoSession();
    if (!s.active) return;
    const text = extractAssistantText(event.message);
    if (text) upsertAssistantLine(s.workerStream, text, MAX_STREAM_LINES, onTrim);
    renderInto(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const s = getForgeAutoSession();
    if (!s.active) return;
    const total = extractUsageTotal(event.message);
    if (typeof total === "number") s.unitTokens = (s.unitTokens ?? 0) + total;
    renderInto(ctx);
  });

  pi.registerShortcut(UNIT_PANEL_TOGGLE_KEY, {
    description: "Forge: expandir/colapsar o painel da unidade",
    handler: (ctx) => {
      collapsed = !collapsed;
      renderInto(ctx);
    },
  });
}
