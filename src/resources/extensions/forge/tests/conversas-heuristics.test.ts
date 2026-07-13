import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry } from "@gsd/pi-coding-agent";
import {
  MIN_OPERATOR_MESSAGES,
  countOperatorMessages,
  isWorkerSliceEntries,
  shouldDistillSession,
} from "../conversas/heuristics.js";

function entries(items: unknown[]): SessionEntry[] {
  return items as SessionEntry[];
}

function user(text: string): unknown {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function assistant(text: string): unknown {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function worker(customType: "forge-dispatch" | "forge-review"): unknown {
  return { type: "custom_message", customType, content: "dispatch", display: false };
}

describe("conversas heuristics", () => {
  test("exports the locked operator-message threshold", () => {
    assert.equal(MIN_OPERATOR_MESSAGES, 3);
  });

  test("distills an eligible operator conversation at the threshold", () => {
    const session = entries([user("primeiro contexto"), assistant("entendi"), user("decidimos X"), user("pendência Y")]);
    assert.equal(countOperatorMessages(session), 3);
    assert.equal(shouldDistillSession(session, "quit"), true);
  });

  test("does not distill with fewer than three operator messages", () => {
    const session = entries([user("contexto"), assistant("ok"), user("decisão")]);
    assert.equal(countOperatorMessages(session), 2);
    assert.equal(shouldDistillSession(session, "quit"), false);
  });

  test("excludes slash and bang input from the operator count", () => {
    const session = entries([user("/forge status"), user("!ls"), user("  /também comando"), user("decisão humana"), user("outra decisão"), user("pendência")]);
    assert.equal(countOperatorMessages(session), 3);
    assert.equal(shouldDistillSession(session, "new"), true);
  });

  test("does not count empty or non-text user messages", () => {
    const session = entries([
      user(""),
      { type: "message", message: { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] } },
      user("uma conversa real"),
    ]);
    assert.equal(countOperatorMessages(session), 1);
    assert.equal(shouldDistillSession(session, "fork"), false);
  });

  test("forge dispatch entries classify the complete session as worker", () => {
    const session = entries([user("a"), user("b"), user("c"), worker("forge-dispatch")]);
    assert.equal(isWorkerSliceEntries(session), true);
    assert.equal(shouldDistillSession(session, "resume"), false);
  });

  test("forge review entries classify the complete session as worker", () => {
    const session = entries([user("a"), user("b"), user("c"), worker("forge-review")]);
    assert.equal(isWorkerSliceEntries(session), true);
    assert.equal(shouldDistillSession(session, "quit"), false);
  });

  test("reload and unknown shutdown reasons never distill", () => {
    const session = entries([user("a"), user("b"), user("c")]);
    assert.equal(shouldDistillSession(session, "reload"), false);
    assert.equal(shouldDistillSession(session, "crash"), false);
  });

  test("an empty session is not a worker and cannot qualify", () => {
    assert.equal(isWorkerSliceEntries([]), false);
    assert.equal(countOperatorMessages([]), 0);
    assert.equal(shouldDistillSession([], "quit"), false);
  });
});
