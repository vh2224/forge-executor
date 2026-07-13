/**
 * `ui/queue-widget.ts` — footer queue widget (S04 ROADMAP visibility scope).
 *
 * Replaces the orphaned `gsd-status-widget` (iron rule 2 — no import into
 * `src/resources/extensions/gsd/`, ever). Shows, during an active `/forge
 * auto`|`next` loop: the current unit, the immediate next unit(s) derived
 * from the on-disk STATE (read-only, D3), and the unit's token total when
 * available.
 *
 * ── Telemetry-tolerant (RESEARCH S04) ────────────────────────────────────
 * `formatQueueWidget` is a PURE function: given `{ current, next, tokens? }`
 * it produces the widget lines and never assumes `tokens` is present — the
 * claude-code path can lack usage/stopReason. Absent tokens omit the token
 * segment entirely; we never render "0 tok" (that would be a lie, not a
 * degrade).
 *
 * ── Lifecycle wiring (S04-PLAN § step 3, option (a)) ─────────────────────
 * `registerQueueWidget` hooks `session_start` — mirroring the B3-safe pattern
 * of `registerAutoUnitSetup` (`bootstrap/register-extension.ts`) — and
 * re-publishes `ForgeAutoSession.onUnitChange` with the FRESH instance's
 * `pi`/`ctx` on every replacement. `auto/loop.ts` calls that callback
 * whenever `s.currentUnit` changes and, in its `finally`, with `null` — which
 * is what actually clears the footer status (`setStatus(KEY, undefined)`) so
 * no status survives the loop.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { readSnapshot, type ForgeSnapshot } from "../auto/snapshot.js";
import { getForgeAutoSession } from "../auto/session.js";
import type { NextUnit } from "../state/index.js";
import { unitSlice } from "../state/index.js";
import { currentIdentity, formatIdentity } from "./identity.js";

/** `ctx.ui.setStatus` key for the queue widget — cleared with `undefined`. */
export const QUEUE_STATUS_KEY = "forge:queue";

/** How many upcoming units to show after the current one. */
const NEXT_QUEUE_LIMIT = 3;

/** The pure input `formatQueueWidget` renders from. */
export interface QueueWidgetInput {
  current: NextUnit | null;
  next: NextUnit[];
  /** Summed tokens for the unit in flight. `undefined` ⇒ omit the segment. */
  tokens?: number;
  /** Preformatted identity segment (`ui/identity.ts`'s `formatIdentity`), computed by the wiring layer. Present ⇒ replaces the `Agora: …` segment; absent ⇒ today's shape byte-exact. */
  identity?: string;
}

/** Describe the CURRENT unit fully — `execute-task S01/T02` or `plan-slice S02`. */
function describeCurrent(unit: NextUnit): string {
  return unit.type === "execute-task" ? `execute-task ${unit.slice}/${unit.task}` : `${unit.type} ${unitSlice(unit)}`;
}

/** Describe a QUEUED (next) unit tersely — just the task id, or `plan S##`. */
function describeNext(unit: NextUnit): string {
  return unit.type === "execute-task" ? unit.task : `${unit.type} ${unitSlice(unit)}`;
}

/** Format a raw token count as a compact `12.3k`/`842` string (no unit suffix). */
function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.max(0, Math.trunc(n)));
}

/**
 * PURE formatter: `{ current, next, tokens?, identity? }` → widget lines.
 * Empty array when the loop is idle (`current === null`) — nothing to show,
 * nothing to clear-with-a-lie. Never renders a token segment when `tokens` is
 * absent. When `identity` is present it replaces the `Agora: …` segment;
 * absent renders today's shape byte-exact.
 */
export function formatQueueWidget(input: QueueWidgetInput): string[] {
  if (!input.current) return [];

  const segments = [input.identity ?? `Agora: ${describeCurrent(input.current)}`];

  if (input.next.length > 0) {
    segments.push(`Próx.: ${input.next.map(describeNext).join(", ")}`);
  }

  if (typeof input.tokens === "number" && Number.isFinite(input.tokens)) {
    segments.push(`${formatTokenCount(input.tokens)} tok`);
  }

  return [segments.join(" · ")];
}

/**
 * Read-only (D3) walk of the snapshot's pending work, in roadmap order —
 * mirrors `deriveNextUnit`'s own traversal (dispatch.ts) but collects EVERY
 * still-pending unit instead of stopping at the first. `queue[0]` is always
 * what `deriveNextUnit` would return for this snapshot; the rest is the M1
 * "immediate next" queue (no `depends` reordering — that is M2, per the plan).
 */
function computePendingQueue(snap: ForgeSnapshot): NextUnit[] {
  const queue: NextUnit[] = [];

  for (const slice of snap.roadmap) {
    const doneOnRoadmap = slice.status === "done";
    const stateUnit = snap.state.units?.find((u) => u.id === slice.id && u.type === "slice");
    if (doneOnRoadmap || stateUnit?.status === "done") continue;

    const info = snap.plans[slice.id];
    if (!info || !info.planned) {
      queue.push({ type: "plan-slice", slice: slice.id });
      continue;
    }

    for (const task of info.tasks) {
      if (task.status !== "done") queue.push({ type: "execute-task", slice: slice.id, task: task.id });
    }
  }

  return queue;
}

/**
 * Compute the current widget lines for `unit` against the live on-disk
 * snapshot at `cwd`. Read-only — never writes STATE (D3).
 */
function computeWidgetLines(cwd: string, unit: NextUnit, tokens: number | undefined, identity: string | undefined): string[] {
  const snap = readSnapshot(cwd);
  const queue = computePendingQueue(snap);
  const next = queue.slice(1, 1 + NEXT_QUEUE_LIMIT);
  return formatQueueWidget({ current: unit, next, tokens, identity });
}

/** `NextUnit`-shaped values `onUnitChange` accepts — mirrors the union `computePendingQueue` produces. */
function isNextUnitShaped(unit: unknown): unit is NextUnit {
  if (!unit || typeof unit !== "object") return false;
  const type = (unit as { type?: unknown }).type;
  return type === "plan-slice" || type === "execute-task";
}

/**
 * REVIEW-FIX (S04/R1): the render callback this module currently has
 * registered on `ForgeAutoSession.reviewActivityListeners` — mirrors
 * `ui/unit-panel.ts`'s own module-local tracker so `session_start` can drop
 * the stale (pre-`newSession`) entry before adding a fresh-`ctx`-bound one.
 */
let reviewActivityListener: (() => void) | null = null;

/**
 * Register the queue widget. Assigns `ForgeAutoSession.onUnitChange` from a
 * `session_start` hook so it is always the FRESH instance's `ctx` (B3) —
 * never a handle captured before a `newSession` replacement. `auto/loop.ts`
 * invokes the callback on every unit change and once more (with `null`) in
 * its `finally`, which is what clears the status.
 *
 * ── Identity re-invoke (S04/T03, S04-PLAN Interpretation Decision 6) ────────
 * `auto.unit-scope` registers BEFORE this file (`bootstrap/register-extension.ts`),
 * so its `session_start` hook has already published `appliedUnitModel` by the
 * time THIS hook runs. Re-invoking `onUnitChange` here — with the container's
 * own `currentUnit`, when it is `NextUnit`-shaped and the loop is active —
 * is what gives the footer its model segment without any new event surface:
 * the FIRST `onUnitChange` call for a unit (fired from `auto/loop.ts` before
 * the child session even starts) never sees a model, but this re-invoke does.
 *
 * ── Review-activity re-invoke (REVIEW-FIX S04/R1) ───────────────────────────
 * The SAME re-invoke trick above also closes the gap the review-fix raised:
 * `review/dispatch.ts`'s publish/clear of `reviewActivity` mutates the
 * container directly and has no `ctx` of its own to redraw with, so without a
 * listener the footer could keep showing a finished turn's identity until an
 * unrelated unit change happened to call `onUnitChange` again. Registering a
 * `reviewActivityListeners` entry that re-invokes `onUnitChange` with the
 * CURRENT unit gives the footer the same live-updating behavior the panel
 * gets, with no new rendering path to maintain.
 */
export function registerQueueWidget(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const s = getForgeAutoSession();

    s.onUnitChange = (unit) => {
      if (!unit) {
        ctx.ui.setStatus(QUEUE_STATUS_KEY, undefined);
        return;
      }
      try {
        const id = currentIdentity(s);
        const lines = computeWidgetLines(s.cwd, unit, s.unitTokens, id ? formatIdentity(id) : undefined);
        ctx.ui.setStatus(QUEUE_STATUS_KEY, lines[0]);
      } catch {
        // Best-effort — a widget failure must never break the loop (D3: the
        // loop is the single writer; this hook is purely observational).
        ctx.ui.setStatus(QUEUE_STATUS_KEY, undefined);
      }
    };

    // REVIEW-FIX (S04/R1): re-bind to the FRESH ctx-bound `onUnitChange`
    // above — drop the previous entry first (B3), same discipline as
    // `ui/unit-panel.ts`.
    if (reviewActivityListener) s.reviewActivityListeners.delete(reviewActivityListener);
    reviewActivityListener = () => {
      try {
        const unit = s.currentUnit;
        if (s.active && isNextUnitShaped(unit)) s.onUnitChange?.(unit);
      } catch {
        // Same best-effort posture as the closure itself (widget failures never break the loop).
      }
    };
    s.reviewActivityListeners.add(reviewActivityListener);

    try {
      const unit = s.currentUnit;
      if (s.active && isNextUnitShaped(unit)) s.onUnitChange(unit);
    } catch {
      // Same best-effort posture as the closure itself (widget failures never break the loop).
    }
  });
}
