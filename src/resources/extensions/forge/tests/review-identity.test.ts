/**
 * S04/T02 — per-turn `reviewActivity` publish/clear, exercised through the
 * exact same `runReviewDialectic` seam as `tests/review-dispatch.test.ts`
 * (fake `ReviewDispatcher`, no real turn dispatch). Assertions run FROM
 * INSIDE the fake's `dispatch()` — the only place the field is guaranteed to
 * still be mid-flight — and after `runReviewDialectic` returns, proving the
 * `finally`-based clear fires for every outcome (verdict, stub, throw).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runReviewDialectic, ReviewDispatchError, type ReviewDispatcher } from "../review/dispatch.js";
import { getForgeAutoSession } from "../auto/session.js";
import type { ResolveModelCtx } from "../auto/role.js";

function sandbox(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-review-identity-"));
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
  writeFileSync(join(cwd, "changed.ts"), "export const changed = true;\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  writeFileSync(join(cwd, "changed.ts"), "export const changed = false;\n");
  return cwd;
}

function context(cwd: string): ResolveModelCtx {
  return {
    session: { cwd } as ResolveModelCtx["session"],
    config: {
      pools: { claude: ["claude/sonnet"], gpt: ["openai/gpt-5"] },
      roles: { reviewer: ["gpt"], advocate: ["claude"] },
      constraints: { reviewer_not_author: "family", on_missing_pool: "block" },
    },
  };
}

function params(cwd: string, d: ReviewDispatcher, extra: Record<string, unknown> = {}) {
  return {
    cwd,
    milestoneId: "M-test",
    slice: "S03",
    sliceTitle: "Review",
    unit: { type: "execute-task", slice: "S03", task: "T01" } as const,
    ctxForResolve: context(cwd),
    dispatcher: d,
    reviewedOn: "2026-07-11",
    rounds: 1 as const,
    authorFamily: "claude",
    ...extra,
  };
}

const challenge = "### High\n- R1 `src/a.ts:4` — bug — suggested fix: guard it — challenge: is this safe?";
const defense = "R1: conceded — yes, this is a bug";
const rebuttal = "R1: conceded — carried through";

type ObservedActivity = { role: string; model: string | null; family: string | null; scope: string; token: number } | null;

test("mid-flight challenger publish carries role/model/scope/token; cleared after NO_FLAGS return", async () => {
  getForgeAutoSession().reset();
  const cwd = sandbox();
  let mutObserved: ObservedActivity = null;
  const dispatcher: ReviewDispatcher = {
    async dispatch(_prompt, opts) {
      const activity = getForgeAutoSession().reviewActivity;
      mutObserved = activity ? { ...activity } : null;
      assert.equal(mutObserved?.model, opts.model, "publish uses the SAME model resolution the turn actually dispatches with");
      return "NO_FLAGS";
    },
  };

  const result = await runReviewDialectic(params(cwd, dispatcher));
  // `mutObserved` is reassigned only inside the closure above — TS's flow
  // analysis for captured `let`s does not track that across the intervening
  // `await`, so it must be re-cast here (verified in isolation: it otherwise
  // narrows to `never`).
  const observed = mutObserved as ObservedActivity;

  assert.notEqual(observed, null, "reviewActivity was published while the challenger dispatch was in flight");
  assert.equal(observed?.role, "challenger");
  assert.equal(observed?.family, "gpt");
  assert.equal(observed?.scope, "S03", "scope = taskId ?? slice — no taskId here, so the slice");
  assert.equal(typeof observed?.token, "number");
  assert.equal(result.result.noFlags, true);
  assert.equal(getForgeAutoSession().reviewActivity, null, "cleared in finally after the dialectic returns");
});

test("full dialectic: challenger then advocate then rebuttal publish in order with strictly increasing tokens", async () => {
  getForgeAutoSession().reset();
  const cwd = sandbox();
  const observedRoles: string[] = [];
  const observedTokens: number[] = [];
  const answers = [challenge, defense, rebuttal];
  const dispatcher: ReviewDispatcher = {
    async dispatch() {
      const activity = getForgeAutoSession().reviewActivity;
      assert.ok(activity, "a turn is always publishing while its dispatch is in flight");
      observedRoles.push(activity!.role);
      observedTokens.push(activity!.token);
      return answers.shift() ?? null;
    },
  };

  await runReviewDialectic(params(cwd, dispatcher));

  assert.deepEqual(observedRoles, ["challenger", "advocate", "rebuttal"]);
  assert.ok(observedTokens[1]! > observedTokens[0]!, "advocate token is HIGHER than the challenger's");
  assert.ok(observedTokens[2]! > observedTokens[1]!, "rebuttal token is HIGHER than the advocate's");
  assert.equal(getForgeAutoSession().reviewActivity, null, "cleared after the last turn's finally");
});

test("stale-clear safety: a newer (fabricated) publish survives the challenger's own clear", async () => {
  getForgeAutoSession().reset();
  const cwd = sandbox();
  const fabricated = { role: "advocate" as const, model: "fake/model", family: "fake", scope: "fake-scope", token: 999_999 };
  const dispatcher: ReviewDispatcher = {
    async dispatch() {
      // Simulate an abandoned/overlapping turn publishing a NEWER token while
      // the challenger's own dispatch is still in flight.
      getForgeAutoSession().reviewActivity = { ...fabricated };
      return "NO_FLAGS"; // ends the dialectic after this one turn — nothing else clears
    },
  };

  await runReviewDialectic(params(cwd, dispatcher));

  assert.deepEqual(
    getForgeAutoSession().reviewActivity,
    fabricated,
    "the challenger's clear is token-correlated — it must NOT wipe a higher-token publish it doesn't own",
  );
  getForgeAutoSession().reset();
});

test("throwing dispatcher (ReviewDispatchError) still clears via finally", async () => {
  getForgeAutoSession().reset();
  const cwd = sandbox();
  const dispatcher: ReviewDispatcher = {
    async dispatch() {
      assert.ok(getForgeAutoSession().reviewActivity, "publish happened before the throw");
      throw new ReviewDispatchError("boom");
    },
  };

  const result = await runReviewDialectic(params(cwd, dispatcher));

  assert.equal(result.result.noFlags, true);
  assert.ok(result.warnings.some((w) => w.includes("boom")));
  assert.equal(getForgeAutoSession().reviewActivity, null, "cleared even on the throw path");
});

// ── REVIEW-FIX S04/R1: publish/clear render callbacks ───────────────────────

test("publish/clear notify every registered reviewActivityListeners entry, including on the FINAL clear", async () => {
  getForgeAutoSession().reset();
  const cwd = sandbox();
  const observedAtCallback: ObservedActivity[] = [];
  const listener = () => {
    observedAtCallback.push(getForgeAutoSession().reviewActivity);
  };
  getForgeAutoSession().reviewActivityListeners.add(listener);
  try {
    const dispatcher: ReviewDispatcher = {
      async dispatch() {
        return "NO_FLAGS";
      },
    };

    await runReviewDialectic(params(cwd, dispatcher));

    // One notify for the challenger publish (reviewActivity set), one for its clear (null) —
    // proving the clear itself pushes a render, not just the publish.
    assert.ok(observedAtCallback.length >= 2, "notified at least once for the publish and once for the clear");
    assert.notEqual(observedAtCallback[0], null, "first notify observed the published activity");
    assert.equal(
      observedAtCallback[observedAtCallback.length - 1],
      null,
      "the LAST notify observed the cleared (null) activity — the fix under test",
    );
  } finally {
    getForgeAutoSession().reviewActivityListeners.delete(listener);
    getForgeAutoSession().reset();
  }
});

test("a throwing reviewActivityListeners entry never breaks the dialectic or the other listeners", async () => {
  getForgeAutoSession().reset();
  const cwd = sandbox();
  let goodListenerCalls = 0;
  const throwingListener = () => {
    throw new Error("widget render exploded");
  };
  const goodListener = () => {
    goodListenerCalls++;
  };
  getForgeAutoSession().reviewActivityListeners.add(throwingListener);
  getForgeAutoSession().reviewActivityListeners.add(goodListener);
  try {
    const dispatcher: ReviewDispatcher = {
      async dispatch() {
        return "NO_FLAGS";
      },
    };

    const result = await runReviewDialectic(params(cwd, dispatcher));

    assert.equal(result.result.noFlags, true, "the dialectic completed normally despite the throwing listener");
    assert.ok(goodListenerCalls >= 2, "the other listener still ran for both the publish and the clear");
  } finally {
    getForgeAutoSession().reviewActivityListeners.delete(throwingListener);
    getForgeAutoSession().reviewActivityListeners.delete(goodListener);
    getForgeAutoSession().reset();
  }
});

test("taskId param set: published scope is the TASK_ID, not the slice", async () => {
  getForgeAutoSession().reset();
  const cwd = sandbox();
  let observedScope: string | null = null;
  const dispatcher: ReviewDispatcher = {
    async dispatch() {
      observedScope = getForgeAutoSession().reviewActivity?.scope ?? null;
      return "NO_FLAGS";
    },
  };

  await runReviewDialectic(params(cwd, dispatcher, { taskId: "T-loose-9" }));

  assert.equal(observedScope, "T-loose-9");
  assert.equal(getForgeAutoSession().reviewActivity, null);
});
