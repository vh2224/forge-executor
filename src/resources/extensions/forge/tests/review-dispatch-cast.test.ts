/**
 * Fail-closed model cast for review turns (fix batch pós-M7 kickoff).
 *
 * Root cause fixed here, caught live on 2026-07-11: `productionReviewDispatcher`
 * subscribed `message_end`/called `setModel` via optional chains on
 * `ReplacedSessionContext` — which exposes NEITHER — so every dialectic review
 * ever run (a) executed on the SESSION's default model regardless of the
 * resolved reviewer (a Fable session "cross-reviewing" Fable-family code), and
 * (b) captured no text (every review stubbed "challenger falhou" while the
 * turn streamed orphaned in the TUI). Selection≠consumption, 5th recurrence.
 *
 * These tests pin the fail-closed contract at the dialectic layer plus the
 * transcript capture helper, and structurally ban the dead optional-chain
 * pattern from the dispatcher source.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  runReviewDialectic,
  lastAssistantMessage,
  ReviewModelCastError,
  ReviewDispatchError,
  type ReviewDispatcher,
} from "../review/dispatch.js";
import type { ResolveModelCtx } from "../auto/role.js";

function sandbox(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-review-cast-"));
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

function params(cwd: string, d: ReviewDispatcher) {
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
  };
}

const artifact = (cwd: string): string =>
  readFileSync(join(cwd, ".gsd/milestones/M-test/slices/S03/S03-REVIEW.md"), "utf8");

const challenge =
  "### High\n- R1 `src/a.ts:4` — bug — suggested fix: guard it — challenge: is this safe?";

// ── fail-closed at the dialectic layer ──────────────────────────────────────

test("challenger cast failure stubs DECLARED, never a silent same-family review", async () => {
  const cwd = sandbox();
  const calls: string[] = [];
  const d: ReviewDispatcher = {
    async dispatch() {
      calls.push("challenger");
      throw new ReviewModelCastError("modelo 'openai/gpt-5' não aplicável (não encontrado no registry)");
    },
  };
  const result = await runReviewDialectic(params(cwd, d));
  assert.equal(result.result.noFlags, true);
  assert.equal(calls.length, 1, "no advocate dispatch after a challenger cast failure");
  assert.ok(result.warnings.some((w) => w.includes("challenger não aplicável")));
  assert.match(artifact(cwd), /challenger não aplicável: modelo 'openai\/gpt-5' não aplicável/);
});

test("advocate cast failure is a named warning, dialectic still resolves", async () => {
  const cwd = sandbox();
  let n = 0;
  const d: ReviewDispatcher = {
    async dispatch() {
      n++;
      if (n === 1) return challenge;
      if (n === 2) throw new ReviewModelCastError("host recusou setModel('claude/sonnet')");
      return "R1: maintained — still a bug";
    },
  };
  const result = await runReviewDialectic(params(cwd, d));
  assert.ok(result.warnings.some((w) => w.includes("advocate não aplicável: host recusou")));
  assert.ok(!result.warnings.includes("advocate falhou"), "cast reason replaces the generic warn");
  assert.equal(result.result.items.length, 1, "objection still resolved without a defense");
});

test("rebuttal cast failure is a named warning, first-round verdicts stand", async () => {
  const cwd = sandbox();
  let n = 0;
  const d: ReviewDispatcher = {
    async dispatch() {
      n++;
      if (n === 1) return challenge;
      if (n === 2) return "R1: refuted — caller guarantees it";
      throw new ReviewModelCastError("turn autorado por 'claude-fable-5', esperado 'gpt-5'");
    },
  };
  const result = await runReviewDialectic(params(cwd, d));
  assert.ok(result.warnings.some((w) => w.includes("rebuttal não aplicável: turn autorado por 'claude-fable-5'")));
});

test("dispatch failure reason survives into the stub (S04 diagnostic finding)", async () => {
  const cwd = sandbox();
  const d: ReviewDispatcher = {
    async dispatch() {
      throw new ReviewDispatchError("newSession cancelada (session_before_switch/abort)");
    },
  };
  await runReviewDialectic(params(cwd, d));
  assert.match(
    artifact(cwd),
    /challenger falhou: newSession cancelada/,
    "the artifact must carry the real failure reason, not a bare 'falhou'",
  );
});

// ── transcript capture (replaces the no-op message_end listener) ────────────

test("lastAssistantMessage walks the branch backwards, skipping empty/tool-only turns", () => {
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "review this" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "### High\n- R1 finding" }], model: "gpt-5.6-terra" } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1" }], model: "gpt-5.6-terra" } },
    { type: "model_change" },
  ];
  const got = lastAssistantMessage({ getBranch: () => branch });
  assert.equal(got.text, "### High\n- R1 finding");
  assert.equal(got.model, "gpt-5.6-terra");
});

test("lastAssistantMessage degrades to nulls on empty/malformed branches", () => {
  assert.deepEqual(lastAssistantMessage({ getBranch: () => [] }), { text: null, model: null });
  assert.deepEqual(
    lastAssistantMessage({
      getBranch: () => {
        throw new Error("boom");
      },
    }),
    { text: null, model: null },
  );
});

// ── structural ban of the dead optional-chain pattern ───────────────────────

test("productionReviewDispatcher no longer relies on no-op ctx members", () => {
  const src = readFileSync(new URL("../review/dispatch.ts", import.meta.url), "utf8");
  assert.ok(!src.includes('on?.("message_end"'), "ReplacedSessionContext has no `on` — listener was a silent no-op");
  assert.ok(!src.includes("setModel?.("), "optional-chained setModel on ctx was a silent no-op");
  assert.ok(src.includes("findExactModelReferenceMatch"), "model cast resolves a real Model object");
  assert.ok(src.includes("ReviewModelCastError"), "cast failures are typed and fail-closed");
  assert.ok(src.includes("lastAssistantMessage"), "capture reads the fresh session transcript");
  assert.ok(src.includes("s.cmdCtx ?? ctx"), "second dispatch of a dialectic must not use a stale ctx");
  assert.ok(
    /forge_unit_result/.test(src) && src.includes("setActiveTools"),
    "review sessions must strip forge_unit_result (terminate:true would end the turn with no final text — S05 Luna finding)",
  );
});
