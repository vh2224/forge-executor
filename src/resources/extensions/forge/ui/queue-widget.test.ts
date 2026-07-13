import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatQueueWidget } from "./queue-widget.ts";
import type { NextUnit } from "../state/dispatch.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { currentIdentity, formatIdentity } from "./identity.ts";

// Pure-formatter tests: no filesystem, no pi/ctx — synthetic input only.

const EXECUTE_UNIT: NextUnit = { type: "execute-task", slice: "S01", task: "T02" };
const PLAN_UNIT: NextUnit = { type: "plan-slice", slice: "S02" };

describe("formatQueueWidget", () => {
  test("idle loop (current: null) → no lines", () => {
    const lines = formatQueueWidget({ current: null, next: [] });
    assert.deepStrictEqual(lines, []);
  });

  test("current only, no queue, no tokens → single 'Agora' segment", () => {
    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next: [] });
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0], "Agora: execute-task S01/T02");
  });

  test("plan-slice current is described as 'plan-slice S##'", () => {
    const lines = formatQueueWidget({ current: PLAN_UNIT, next: [] });
    assert.strictEqual(lines[0], "Agora: plan-slice S02");
  });

  test("current + a queue of next units → 'Próx.' segment, terse ids", () => {
    const next: NextUnit[] = [
      { type: "execute-task", slice: "S01", task: "T03" },
      PLAN_UNIT,
    ];
    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next });
    assert.strictEqual(lines[0], "Agora: execute-task S01/T02 · Próx.: T03, plan S02");
  });

  test("tokens present → appended as a compact 'Nk tok' segment", () => {
    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next: [], tokens: 12345 });
    assert.strictEqual(lines[0], "Agora: execute-task S01/T02 · 12.3k tok");
  });

  test("tokens present but small (< 1000) → raw integer, no 'k'", () => {
    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next: [], tokens: 842 });
    assert.strictEqual(lines[0], "Agora: execute-task S01/T02 · 842 tok");
  });

  test("tokens absent (undefined) → NEVER renders a token segment (no '0 tok')", () => {
    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next: [] });
    assert.ok(!lines[0].includes("tok"), `must not mention tokens: ${lines[0]}`);
  });

  test("tokens = 0 is a valid present value → renders '0 tok', not omitted", () => {
    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next: [], tokens: 0 });
    assert.ok(lines[0].endsWith("0 tok"));
  });

  test("full shape: current + queue + tokens all present together", () => {
    const next: NextUnit[] = [{ type: "execute-task", slice: "S01", task: "T03" }, PLAN_UNIT];
    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next, tokens: 12300 });
    assert.strictEqual(lines[0], "Agora: execute-task S01/T02 · Próx.: T03, plan S02 · 12.3k tok");
  });

  // ── S04/T03: identity segment ─────────────────────────────────────────────

  test("identity present → replaces the 'Agora: …' segment, keeps Próx./tokens", () => {
    const next: NextUnit[] = [{ type: "execute-task", slice: "S01", task: "T03" }];
    const lines = formatQueueWidget({
      current: EXECUTE_UNIT,
      next,
      tokens: 12300,
      identity: "⚒ executor · sonnet-5 · S01/T02",
    });
    assert.strictEqual(lines[0], "⚒ executor · sonnet-5 · S01/T02 · Próx.: T03 · 12.3k tok");
  });

  test("identity present, no queue, no tokens → identity is the only segment", () => {
    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next: [], identity: "⚒ executor · sonnet-5 · S01/T02" });
    assert.strictEqual(lines[0], "⚒ executor · sonnet-5 · S01/T02");
  });

  test("identity absent → output is byte-identical to the pre-T03 'Agora: …' shape", () => {
    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next: [], tokens: 842 });
    assert.strictEqual(lines[0], "Agora: execute-task S01/T02 · 842 tok");
  });

  test("review-in-flight identity takes precedence over unit identity on the footer (D16/M1R-1)", () => {
    const s = new ForgeAutoSession();
    s.currentUnit = { type: "execute-task", slice: "S01", task: "T02" };
    s.reviewActivity = { role: "challenger", model: "openai/gpt-5.6-luna", family: "openai", scope: "S01", token: 1 };

    const id = currentIdentity(s);
    assert.ok(id);
    const identity = formatIdentity(id!);
    assert.strictEqual(identity, "⚖ challenger · gpt-5.6-luna · S01");

    const lines = formatQueueWidget({ current: EXECUTE_UNIT, next: [], identity });
    assert.strictEqual(lines[0], "⚖ challenger · gpt-5.6-luna · S01");
  });
});
