import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  authorFamilyForSlice,
  authorFamilyForTask,
  excludeAuthorFamily,
  onlyAuthorFamily,
  reviewerIndependenceActive,
} from "../auto/reviewer-independence.ts";
import type { ForgeEvent } from "../state/types.ts";

/** Minimal `unit_dispatched`/`unit_result` fixture — only the fields these helpers read. */
function ev(overrides: Partial<ForgeEvent> & Pick<ForgeEvent, "kind">): ForgeEvent {
  return {
    ts: "2026-07-11T00:00:00.000Z",
    unit: "S04/T01",
    agent: "forge-loop",
    milestone: "M-test",
    status: "dispatched",
    summary: "test event",
    ...overrides,
  };
}

describe("authorFamilyForSlice", () => {
  test("returns the family from a populated execute-task authorship event", () => {
    const events = [
      ev({ kind: "unit_dispatched", slice: "S04", task: "T01", family: "gpt" }),
    ];
    assert.equal(authorFamilyForSlice(events, "S04"), "gpt");
  });

  test("returns null when the matching event carries no family", () => {
    const events = [ev({ kind: "unit_dispatched", slice: "S04", task: "T01" })];
    assert.equal(authorFamilyForSlice(events, "S04"), null);
  });

  test("returns null when no event matches the slice at all", () => {
    const events = [
      ev({ kind: "unit_dispatched", slice: "S03", task: "T01", family: "claude" }),
    ];
    assert.equal(authorFamilyForSlice(events, "S04"), null);
  });

  test("returns null for an empty events array", () => {
    assert.equal(authorFamilyForSlice([], "S04"), null);
  });

  test("latest wins between two execute-task authorship events for the same slice", () => {
    const events = [
      ev({ kind: "unit_dispatched", slice: "S04", task: "T01", family: "claude" }),
      ev({ kind: "unit_result", slice: "S04", task: "T01", family: "claude" }),
      ev({ kind: "unit_dispatched", slice: "S04", task: "T02", family: "gpt" }),
      ev({ kind: "unit_result", slice: "S04", task: "T02", family: "gpt" }),
    ];
    assert.equal(authorFamilyForSlice(events, "S04"), "gpt");
  });

  test("skips a later family-less event and falls back to the last family-carrying one", () => {
    const events = [
      ev({ kind: "unit_dispatched", slice: "S04", task: "T01", family: "claude" }),
      ev({ kind: "unit_result", slice: "S04", task: "T01" }), // no known model → no family
    ];
    assert.equal(authorFamilyForSlice(events, "S04"), "claude");
  });

  test("ignores non-authorship kinds (plan-slice/complete-slice have no task field)", () => {
    const events = [
      ev({ kind: "unit_dispatched", slice: "S04", family: "gpt" }), // no `task` — plan-slice/complete-slice
      ev({ kind: "loop_paused", slice: "S04", task: "T01", family: "claude" }), // not dispatch/result
    ];
    assert.equal(authorFamilyForSlice(events, "S04"), null);
  });

  test("ignores events whose slice differs even when task and family are set", () => {
    const events = [
      ev({ kind: "unit_dispatched", slice: "S01", task: "T01", family: "claude" }),
      ev({ kind: "unit_dispatched", slice: "S04", task: "T01" }),
    ];
    assert.equal(authorFamilyForSlice(events, "S04"), null);
  });
});

describe("authorFamilyForTask", () => {
  /** Minimal `task_dispatched`/`task_result` fixture (S02/S03) — only the fields `authorFamilyForTask` reads. */
  function taskEv(overrides: Partial<ForgeEvent> & Pick<ForgeEvent, "kind">): ForgeEvent {
    return {
      ts: "2026-07-12T00:00:00.000Z",
      unit: "task-execute",
      agent: "forge-command",
      milestone: "",
      status: "dispatched",
      summary: "test event",
      ...overrides,
    };
  }

  test("returns the family from a task-execute task_dispatched event", () => {
    const events = [taskEv({ kind: "task_dispatched", task: "T-1", family: "gpt" })];
    assert.equal(authorFamilyForTask(events, "T-1"), "gpt");
  });

  test("returns null when the matching event carries no family", () => {
    const events = [taskEv({ kind: "task_dispatched", task: "T-1" })];
    assert.equal(authorFamilyForTask(events, "T-1"), null);
  });

  test("ignores task-plan dispatches — only the task-execute phase counts", () => {
    const events = [taskEv({ kind: "task_dispatched", unit: "task-plan", task: "T-1", family: "gpt" })];
    assert.equal(authorFamilyForTask(events, "T-1"), null);
  });

  test("ignores kinds other than task_dispatched, e.g. the loop's own unit_dispatched", () => {
    const events = [taskEv({ kind: "unit_dispatched", task: "T-1", family: "gpt" })];
    assert.equal(authorFamilyForTask(events, "T-1"), null);
  });

  test("skips a family-less task_result and falls back to the last family-carrying task_dispatched", () => {
    const events = [
      taskEv({ kind: "task_dispatched", task: "T-1", family: "claude" }),
      taskEv({ kind: "task_result", task: "T-1" }), // task_result never carries family in production
    ];
    assert.equal(authorFamilyForTask(events, "T-1"), "claude");
  });

  test("ignores events for a different task", () => {
    const events = [taskEv({ kind: "task_dispatched", task: "T-2", family: "gpt" })];
    assert.equal(authorFamilyForTask(events, "T-1"), null);
  });

  test("returns null for an empty events array", () => {
    assert.equal(authorFamilyForTask([], "T-1"), null);
  });

  test("latest wins between two task-execute dispatches for the same task", () => {
    const events = [
      taskEv({ kind: "task_dispatched", task: "T-1", family: "claude" }),
      taskEv({ kind: "task_dispatched", task: "T-1", family: "gpt" }),
    ];
    assert.equal(authorFamilyForTask(events, "T-1"), "gpt");
  });
});

describe("excludeAuthorFamily", () => {
  const refs = ["claude-code/claude-opus-4-8", "openai/gpt-5.5", "claude-code/claude-sonnet-5"];

  test("drops every ref whose family matches the author family", () => {
    assert.deepEqual(excludeAuthorFamily(refs, "claude"), ["openai/gpt-5.5"]);
  });

  test("preserves input order among the surviving refs", () => {
    const mixed = ["openai/gpt-5.5", "claude-code/claude-opus-4-8", "openai/gpt-5-mini"];
    assert.deepEqual(excludeAuthorFamily(mixed, "claude"), ["openai/gpt-5.5", "openai/gpt-5-mini"]);
  });

  test("is the identity when authorFamily is null", () => {
    assert.deepEqual(excludeAuthorFamily(refs, null), refs);
  });

  test("drops nothing when authorFamily matches no ref", () => {
    assert.deepEqual(excludeAuthorFamily(refs, "mistral"), refs);
  });
});

describe("onlyAuthorFamily", () => {
  const refs = ["claude-code/claude-opus-4-8", "openai/gpt-5.5", "claude-code/claude-sonnet-5"];

  test("keeps only refs whose family matches the author family", () => {
    assert.deepEqual(onlyAuthorFamily(refs, "claude"), [
      "claude-code/claude-opus-4-8",
      "claude-code/claude-sonnet-5",
    ]);
  });

  test("preserves input order among the kept refs", () => {
    const mixed = ["openai/gpt-5.5", "claude-code/claude-opus-4-8", "openai/gpt-5-mini"];
    assert.deepEqual(onlyAuthorFamily(mixed, "gpt"), ["openai/gpt-5.5", "openai/gpt-5-mini"]);
  });

  test("is empty when authorFamily is null (no author → advocate has no target)", () => {
    assert.deepEqual(onlyAuthorFamily(refs, null), []);
  });

  test("is empty when authorFamily matches no ref", () => {
    assert.deepEqual(onlyAuthorFamily(refs, "mistral"), []);
  });
});

describe("reviewerIndependenceActive", () => {
  test("is true when the constraint is exactly 'family'", () => {
    assert.equal(reviewerIndependenceActive({ reviewer_not_author: "family" }), true);
  });

  test("is false when the constraint is absent", () => {
    assert.equal(reviewerIndependenceActive({}), false);
  });

  test("is false for any other constraint value", () => {
    assert.equal(reviewerIndependenceActive({ reviewer_not_author: "individual" }), false);
  });

  test("is false when unrelated constraints are present but this one is absent", () => {
    assert.equal(reviewerIndependenceActive({ on_missing_pool: "block" }), false);
  });
});
