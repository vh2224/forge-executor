import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ComposableUnit } from "../prompts/compose.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import {
  currentIdentity,
  formatIdentity,
  reviewIdentity,
  shortModelLabel,
  unitIdentity,
  unitLabel,
} from "./identity.ts";

// Pure-core tests: synthetic `ForgeAutoSession` instances only — never the
// module-level singleton, no filesystem, no pi/ctx.

const EXECUTE_UNIT: ComposableUnit = { type: "execute-task", slice: "S02", task: "T03" };
const PLAN_UNIT: ComposableUnit = { type: "plan-slice", slice: "S02" };

describe("shortModelLabel", () => {
  test("claude-code ref → after-slash segment, redundant 'claude-' stripped", () => {
    assert.strictEqual(shortModelLabel("claude-code/claude-sonnet-5"), "sonnet-5");
  });

  test("openai ref → after-slash segment, no 'claude-' prefix to strip", () => {
    assert.strictEqual(shortModelLabel("openai/gpt-5.6-luna"), "gpt-5.6-luna");
  });

  test("xai ref → after-slash segment", () => {
    assert.strictEqual(shortModelLabel("xai/grok-4"), "grok-4");
  });

  test("bare ref with no '/' → the ref itself (strip rule still applies)", () => {
    assert.strictEqual(shortModelLabel("claude-sonnet-5"), "sonnet-5");
  });

  test("bare ref with no '/' and no 'claude-' prefix → unchanged", () => {
    assert.strictEqual(shortModelLabel("grok-4"), "grok-4");
  });

  test("null in → null out", () => {
    assert.strictEqual(shortModelLabel(null), null);
  });
});

describe("unitLabel", () => {
  test("execute-task → S##/T##", () => {
    assert.strictEqual(unitLabel(EXECUTE_UNIT), "S02/T03");
  });

  test("non execute-task → '<type> <unitSlice>'", () => {
    assert.strictEqual(unitLabel(PLAN_UNIT), "plan-slice S02");
  });
});

describe("unitIdentity", () => {
  test("no currentUnit (idle) → null", () => {
    const s = new ForgeAutoSession();
    assert.strictEqual(unitIdentity(s), null);
  });

  test("appliedUnitModel gated by matching token → wins over resolvedDispatchAuthor", () => {
    const s = new ForgeAutoSession();
    s.currentUnit = EXECUTE_UNIT;
    s.currentRendezvousToken = 7;
    s.appliedUnitModel = "claude-code/claude-sonnet-5";
    s.appliedUnitModelToken = 7;
    s.resolvedDispatchAuthor = { provider: "openai", model: "openai/gpt-5.6-luna", family: "openai" };

    const id = unitIdentity(s);
    assert.deepStrictEqual(id, {
      glyph: "⚒",
      role: "executor",
      model: "sonnet-5",
      unitLabel: "S02/T03",
    });
  });

  test("appliedUnitModelToken mismatch (stale hook) → falls to resolvedDispatchAuthor.model", () => {
    const s = new ForgeAutoSession();
    s.currentUnit = EXECUTE_UNIT;
    s.currentRendezvousToken = 9;
    s.appliedUnitModel = "claude-code/claude-sonnet-5";
    s.appliedUnitModelToken = 7; // stale — does not match currentRendezvousToken
    s.resolvedDispatchAuthor = { provider: "openai", model: "openai/gpt-5.6-luna", family: "openai" };

    const id = unitIdentity(s);
    assert.strictEqual(id?.model, "gpt-5.6-luna");
  });

  test("no applied model, no resolvedDispatchAuthor → model is null (never fabricated)", () => {
    const s = new ForgeAutoSession();
    s.currentUnit = EXECUTE_UNIT;

    const id = unitIdentity(s);
    assert.strictEqual(id?.model, null);
  });

  test("role derives via roleForUnit — plan-slice → planner glyph", () => {
    const s = new ForgeAutoSession();
    s.currentUnit = PLAN_UNIT;

    const id = unitIdentity(s);
    assert.strictEqual(id?.role, "planner");
    assert.strictEqual(id?.glyph, "✎");
    assert.strictEqual(id?.unitLabel, "plan-slice S02");
  });
});

describe("reviewIdentity", () => {
  test("no reviewActivity → null", () => {
    const s = new ForgeAutoSession();
    assert.strictEqual(reviewIdentity(s), null);
  });

  test("reviewActivity present → derives identity with ⚖ glyph", () => {
    const s = new ForgeAutoSession();
    s.reviewActivity = { role: "challenger", model: "openai/gpt-5.6-luna", family: "openai", scope: "S02", token: 1 };

    const id = reviewIdentity(s);
    assert.deepStrictEqual(id, {
      glyph: "⚖",
      role: "challenger",
      model: "gpt-5.6-luna",
      unitLabel: "S02",
    });
  });
});

describe("currentIdentity", () => {
  test("idle (no currentUnit, no reviewActivity) → null", () => {
    const s = new ForgeAutoSession();
    assert.strictEqual(currentIdentity(s), null);
  });

  test("review in flight takes precedence over unit identity (D16/M1R-1)", () => {
    const s = new ForgeAutoSession();
    s.currentUnit = EXECUTE_UNIT;
    s.reviewActivity = { role: "advocate", model: "claude-code/claude-sonnet-5", family: "anthropic", scope: "S02", token: 2 };

    const id = currentIdentity(s);
    assert.strictEqual(id?.role, "advocate");
    assert.strictEqual(id?.unitLabel, "S02");
  });

  test("no review in flight → falls back to unit identity", () => {
    const s = new ForgeAutoSession();
    s.currentUnit = EXECUTE_UNIT;

    const id = currentIdentity(s);
    assert.strictEqual(id?.role, "executor");
  });

  test("reset() clears reviewActivity → currentIdentity falls back to unit", () => {
    const s = new ForgeAutoSession();
    s.currentUnit = EXECUTE_UNIT;
    s.reviewActivity = { role: "rebuttal", model: null, family: null, scope: "S02", token: 3 };
    assert.strictEqual(currentIdentity(s)?.role, "rebuttal");

    s.reset();
    assert.strictEqual(s.reviewActivity, null);
    // reset() also clears currentUnit, so the loop is fully idle afterwards.
    assert.strictEqual(currentIdentity(s), null);
  });
});

describe("formatIdentity", () => {
  test("full shape with model → '<glyph> <role> · <model> · <unitLabel>'", () => {
    const line = formatIdentity({ glyph: "⚒", role: "executor", model: "sonnet-5", unitLabel: "S02/T03" });
    assert.strictEqual(line, "⚒ executor · sonnet-5 · S02/T03");
  });

  test("model null → segment OMITTED entirely (never empty/null placeholder)", () => {
    const line = formatIdentity({ glyph: "⚒", role: "executor", model: null, unitLabel: "S02/T03" });
    assert.strictEqual(line, "⚒ executor · S02/T03");
    assert.ok(!line.includes("null"));
  });

  test("review turn shape", () => {
    const line = formatIdentity({ glyph: "⚖", role: "challenger", model: "gpt-5.6-luna", unitLabel: "S02" });
    assert.strictEqual(line, "⚖ challenger · gpt-5.6-luna · S02");
  });
});
