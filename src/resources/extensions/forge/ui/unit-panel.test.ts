/**
 * `ui/unit-panel.test.ts` — pure logic of the collapsible unit panel: buffer
 * append + ring limit, assistant-line upsert, collapsed vs expanded render, the
 * idle gate, telemetry extraction (tokens present vs absent), and the S04/T03
 * identity segment (present vs absent fallback, review precedence pass-through).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  appendStreamLine,
  extractAssistantText,
  extractUsageTotal,
  finishToolLine,
  formatToolLine,
  MAX_STREAM_LINES,
  PANEL_EXPANDED_LINES,
  renderPanel,
  upsertAssistantLine,
} from "./unit-panel.js";
import type { NextUnit } from "../state/index.js";
import { ForgeAutoSession } from "../auto/session.js";
import { currentIdentity, formatIdentity } from "./identity.js";

const UNIT: NextUnit = { type: "execute-task", slice: "S04", task: "T03" };

test("appendStreamLine flattens multiline input and skips empties", () => {
  const buf: string[] = [];
  appendStreamLine(buf, "  hello\n  world  ");
  appendStreamLine(buf, "   ");
  assert.deepEqual(buf, ["hello world"]);
});

test("appendStreamLine enforces the ring limit (oldest dropped)", () => {
  const buf: string[] = [];
  for (let i = 0; i < MAX_STREAM_LINES + 50; i++) appendStreamLine(buf, `line ${i}`);
  assert.equal(buf.length, MAX_STREAM_LINES);
  assert.equal(buf[0], `line 50`);
  assert.equal(buf[buf.length - 1], `line ${MAX_STREAM_LINES + 49}`);
});

test("upsertAssistantLine replaces the trailing text line in place while streaming", () => {
  const buf: string[] = [];
  upsertAssistantLine(buf, "Reading");
  upsertAssistantLine(buf, "Reading the plan");
  upsertAssistantLine(buf, "Reading the plan file");
  assert.equal(buf.length, 1);
  assert.equal(buf[0], "› Reading the plan file");
});

test("upsertAssistantLine starts a fresh text line after a tool line", () => {
  const buf: string[] = [];
  upsertAssistantLine(buf, "before tool");
  appendStreamLine(buf, "· read(plan.md)");
  upsertAssistantLine(buf, "after tool");
  assert.deepEqual(buf, ["› before tool", "· read(plan.md)", "› after tool"]);
});

test("renderPanel returns [] when idle (no buffer, no unit)", () => {
  assert.deepEqual(renderPanel({ lines: [], collapsed: true }), []);
  assert.deepEqual(renderPanel({ lines: [], collapsed: false, currentUnit: null }), []);
});

test("renderPanel collapsed shows one summary line with the last action + hint", () => {
  const out = renderPanel({ lines: ["· read(a)", "· bash(ls)"], collapsed: true, currentUnit: UNIT });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /^▸ worker: · bash\(ls\) · Ctrl\+B$/);
});

test("renderPanel collapsed with a unit but empty buffer shows the starting placeholder", () => {
  const out = renderPanel({ lines: [], collapsed: true, currentUnit: UNIT });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /iniciando/);
});

test("renderPanel expanded shows a header + the buffer tail, capped", () => {
  const lines = Array.from({ length: PANEL_EXPANDED_LINES + 5 }, (_, i) => `· step ${i}`);
  const out = renderPanel({ lines, collapsed: false, currentUnit: UNIT, tokens: 12_300 });
  assert.equal(out[0], "▾ worker · S04/T03 · 12.3k tok");
  assert.equal(out.length, 1 + PANEL_EXPANDED_LINES);
  assert.equal(out[out.length - 1], `· step ${PANEL_EXPANDED_LINES + 4}`);
});

test("renderPanel expanded omits the token segment when tokens are absent", () => {
  const out = renderPanel({ lines: ["· read(a)"], collapsed: false, currentUnit: UNIT });
  assert.equal(out[0], "▾ worker · S04/T03");
  assert.ok(!out[0]!.includes("tok"));
});

test("extractUsageTotal reads usage.total from an assistant message", () => {
  const msg = { role: "assistant", content: [], usage: { total: 4200 } };
  assert.equal(extractUsageTotal(msg), 4200);
});

test("extractUsageTotal tolerates a missing/foreign payload (claude-code path)", () => {
  assert.equal(extractUsageTotal({ role: "assistant", content: [] }), undefined);
  assert.equal(extractUsageTotal({ role: "user", content: "hi" }), undefined);
  assert.equal(extractUsageTotal(null), undefined);
  assert.equal(extractUsageTotal({ role: "assistant", usage: { total: "nope" } }), undefined);
});

test("extractAssistantText concatenates text blocks and ignores non-text", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "hidden" },
      { type: "toolCall", id: "1", name: "read", arguments: {} },
      { type: "text", text: "world" },
    ],
  };
  assert.equal(extractAssistantText(msg), "hello world");
  assert.equal(extractAssistantText({ role: "user", content: "x" }), "");
  assert.equal(extractAssistantText(undefined), "");
});

// ── S04/T03: identity segment ───────────────────────────────────────────────

test("renderPanel collapsed with identity leads with it, keeping the narrative dash + hint", () => {
  const out = renderPanel({
    lines: ["· read(a)", "· bash(ls)"],
    collapsed: true,
    currentUnit: UNIT,
    identity: "⚒ executor · sonnet-5 · S02/T03",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0], "▸ ⚒ executor · sonnet-5 · S02/T03 — · bash(ls) · Ctrl+B");
});

test("renderPanel collapsed without identity falls back to today's 'worker' shape (byte-compat)", () => {
  const out = renderPanel({ lines: ["· read(a)", "· bash(ls)"], collapsed: true, currentUnit: UNIT });
  assert.equal(out[0], "▸ worker: · bash(ls) · Ctrl+B");
});

test("renderPanel expanded with identity replaces '▾ worker · S##/T##', keeps the token segment", () => {
  const out = renderPanel({
    lines: ["· step"],
    collapsed: false,
    currentUnit: UNIT,
    tokens: 12_300,
    identity: "⚒ executor · sonnet-5 · S02/T03",
  });
  assert.equal(out[0], "▾ ⚒ executor · sonnet-5 · S02/T03 · 12.3k tok");
});

test("renderPanel expanded without identity falls back to today's header (byte-compat)", () => {
  const out = renderPanel({ lines: ["· step"], collapsed: false, currentUnit: UNIT, tokens: 12_300 });
  assert.equal(out[0], "▾ worker · S04/T03 · 12.3k tok");
});

test("review-in-flight identity takes precedence over unit identity on the strip (D16/M1R-1)", () => {
  const s = new ForgeAutoSession();
  s.currentUnit = { type: "execute-task", slice: "S02", task: "T03" };
  s.reviewActivity = { role: "challenger", model: "openai/gpt-5.6-luna", family: "openai", scope: "S02", token: 1 };

  const id = currentIdentity(s);
  assert.ok(id);
  const line = formatIdentity(id!);
  assert.equal(line, "⚖ challenger · gpt-5.6-luna · S02");

  const out = renderPanel({ lines: ["· step"], collapsed: true, currentUnit: s.currentUnit, identity: line });
  assert.match(out[0]!, /^▸ ⚖ challenger · gpt-5\.6-luna · S02 —/);
});

// ── S04/T04: linha viva (tool_execution_start/end) ──────────────────────────

test("formatToolLine renders bash as '$ <command>' with a trailing running marker", () => {
  assert.equal(formatToolLine("bash", { command: "git diff --stat" }), "$ git diff --stat ⋯");
});

test("formatToolLine renders non-bash tools as '<toolName> <primary-arg>' with a running marker", () => {
  assert.equal(formatToolLine("read", { file_path: "S04-PLAN.md" }), "read S04-PLAN.md ⋯");
});

test("formatToolLine omits the arg segment when there is nothing to summarize", () => {
  assert.equal(formatToolLine("ls", {}), "ls ⋯");
});

test("finishToolLine strips the running marker in place on a clean finish", () => {
  const buf: string[] = [];
  appendStreamLine(buf, formatToolLine("bash", { command: "pnpm test" }));
  finishToolLine(buf, { toolName: "bash", atIndex: 0 }, false);
  assert.deepEqual(buf, ["$ pnpm test"]);
});

test("finishToolLine appends ✗ in place on an errored finish", () => {
  const buf: string[] = [];
  appendStreamLine(buf, formatToolLine("read", { file_path: "missing.md" }));
  finishToolLine(buf, { toolName: "read", atIndex: 0 }, true);
  assert.deepEqual(buf, ["read missing.md ✗"]);
});

test("finishToolLine no-ops when there is no matching running line (end without start)", () => {
  const buf = ["$ already finished earlier"];
  finishToolLine(buf, { toolName: "bash" }, false);
  assert.deepEqual(buf, ["$ already finished earlier"]);
});

test("finishToolLine still matches after a text line lands between start and end", () => {
  const buf: string[] = [];
  appendStreamLine(buf, formatToolLine("bash", { command: "pnpm build" }));
  const atIndex = buf.length - 1;
  upsertAssistantLine(buf, "building now…");
  finishToolLine(buf, { toolName: "bash", atIndex }, false);
  assert.deepEqual(buf, ["$ pnpm build", "› building now…"]);
});

test("finishToolLine falls back to the last running line for the toolName when atIndex is stale", () => {
  const buf: string[] = [];
  appendStreamLine(buf, formatToolLine("read", { file_path: "a.md" })); // index 0, a different tool
  appendStreamLine(buf, formatToolLine("bash", { command: "ls" })); // index 1, the real running line
  // A stale index (e.g. captured before an unrelated splice) that no longer
  // holds a running "bash" line must be rejected, not blindly rewritten.
  finishToolLine(buf, { toolName: "bash", atIndex: 0 }, false);
  assert.deepEqual(buf, ["read a.md ⋯", "$ ls"]);
});

test("finishToolLine never rewrites the wrong line once the ring buffer splices the running line out", () => {
  const buf: string[] = [];
  appendStreamLine(buf, formatToolLine("bash", { command: "long-running-task" }));
  const atIndex = buf.length - 1; // 0
  for (let i = 0; i < MAX_STREAM_LINES + 10; i++) appendStreamLine(buf, `noise ${i}`);
  assert.equal(buf.length, MAX_STREAM_LINES);
  const before = buf.slice();
  finishToolLine(buf, { toolName: "bash", atIndex }, false);
  assert.deepEqual(buf, before);
});

// ── REVIEW-FIX S04/R2: onTrim keeps a tracked index accurate across a splice ─

test("appendStreamLine calls onTrim with the dropped count only when the ring actually trims", () => {
  const buf: string[] = [];
  const trimCalls: number[] = [];
  const onTrim = (n: number) => trimCalls.push(n);
  appendStreamLine(buf, "a", 2, onTrim);
  appendStreamLine(buf, "b", 2, onTrim);
  assert.deepEqual(trimCalls, [], "buffer at capacity but not yet over — no trim");
  appendStreamLine(buf, "c", 2, onTrim);
  assert.deepEqual(trimCalls, [1], "pushing past capacity trims exactly the overflow");
  assert.deepEqual(buf, ["b", "c"]);
});

test("upsertAssistantLine never calls onTrim on the in-place-replace path (no growth, nothing to trim)", () => {
  const buf: string[] = [];
  const trimCalls: number[] = [];
  const onTrim = (n: number) => trimCalls.push(n);
  upsertAssistantLine(buf, "hello", 5, onTrim);
  upsertAssistantLine(buf, "hello world", 5, onTrim);
  assert.deepEqual(trimCalls, [], "replacing the trailing text line in place never grows the buffer");
});

test(
  "two concurrent same-name tool calls: a trim-adjusted index finalizes the RIGHT call, not whichever same-name line shifted into its old slot",
  () => {
    const EVICTED = -1;
    const buf: string[] = [];
    const runningIndexByCallId = new Map<string, number>();
    const onTrim = (trimmed: number) => {
      for (const [callId, idx] of runningIndexByCallId) {
        if (idx === EVICTED) continue;
        const next = idx - trimmed;
        runningIndexByCallId.set(callId, next < 0 ? EVICTED : next);
      }
    };

    // Call A (bash) starts.
    appendStreamLine(buf, formatToolLine("bash", { command: "task-a" }), MAX_STREAM_LINES, onTrim);
    runningIndexByCallId.set("call-A", buf.length - 1);

    // Some unrelated lines land while A is still in flight — not enough to
    // trim yet.
    for (let i = 0; i < 50; i++) appendStreamLine(buf, `noise-early ${i}`, MAX_STREAM_LINES, onTrim);

    // Call B (bash) starts concurrently, BEFORE A ends — same tool name.
    appendStreamLine(buf, formatToolLine("bash", { command: "task-b" }), MAX_STREAM_LINES, onTrim);
    runningIndexByCallId.set("call-B", buf.length - 1);

    // Exactly enough unrelated lines land to trim ONE line off the front
    // (evicting call A's line, the oldest) while call B's more-recent line
    // survives, merely shifted down — WITHOUT the onTrim adjustment, call
    // A's now-stale stored index would coincide with call B's shifted,
    // still-running line.
    const untilOneOverCapacity = MAX_STREAM_LINES - buf.length + 1;
    for (let i = 0; i < untilOneOverCapacity; i++) appendStreamLine(buf, `noise-late ${i}`, MAX_STREAM_LINES, onTrim);
    assert.equal(buf.length, MAX_STREAM_LINES, "sanity: the ring is exactly at capacity after the trim");

    // Call A's own line was evicted by the trim — its tracked index must be
    // marked EVICTED, not left pointing at call B's line.
    assert.equal(runningIndexByCallId.get("call-A"), EVICTED, "call A's evicted line is marked EVICTED, not misattributed");
    assert.ok((runningIndexByCallId.get("call-B") ?? EVICTED) >= 0, "call B's line is still buffered and still tracked accurately");

    // Call A's end event arrives (its own line is gone — the wiring layer
    // must skip `finishToolLine` entirely rather than let its fallback
    // finalize call B's still-running line as a side effect).
    const storedA = runningIndexByCallId.get("call-A");
    runningIndexByCallId.delete("call-A");
    const beforeAEnd = buf.slice();
    if (storedA !== EVICTED) finishToolLine(buf, { toolName: "bash", atIndex: storedA }, false);
    assert.deepEqual(buf, beforeAEnd, "call A's end is a no-op — its line is gone, and call B's must be untouched");

    // Call B's own end event still correctly finalizes ITS OWN (still
    // trim-adjusted-accurate) line.
    const atIndexB = runningIndexByCallId.get("call-B")!;
    finishToolLine(buf, { toolName: "bash", atIndex: atIndexB }, false);
    assert.equal(buf[atIndexB], "$ task-b", "call B's line finalized cleanly, unaffected by call A's eviction");
  },
);
