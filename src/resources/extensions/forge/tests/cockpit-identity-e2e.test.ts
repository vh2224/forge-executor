/**
 * S04/T05 — the through-the-driver referent for the WHOLE S04 demo
 * (`S04-PLAN.md`'s "Objective" string:
 * `⚒ executor · sonnet-5 · S02/T03 — corrigindo write-back`): unit identity,
 * review identity, and the linha viva, each proven over the PRODUCTION
 * publish site rather than a component-level seam — this is the file the
 * CODING-STANDARDS §through-the-driver plan-checker dimension looks for when
 * the S04 SUMMARY claims "a strip mostra…"/"review em voo aparece…".
 *
 * Same seam family as `authorship-routing-e2e.test.ts` (Scenario A) and
 * `task-e2e.test.ts`'s scenario (D) (Scenario B): only the
 * `ExtensionCommandContext.newSession`/`sendMessage` pair is a fake,
 * worker-compliant stand-in — the rest of the spine is REAL production code.
 *
 * (A) Unit identity — `auto/driver.ts`'s `dispatchUnitViaNewSession` is
 *     called directly against a temp `.gsd/models.md` that routes `executor`
 *     to a distinct pool (verbatim technique of
 *     `authorship-routing-e2e.test.ts`'s `writeExecutorRoutesToGptConfig`).
 *     The test never writes `resolvedDispatchAuthor`/`appliedUnitModel` into
 *     the container itself — `dispatchUnitViaNewSession` resolves and
 *     publishes them exactly as `auto/loop.ts` relies on it to. This fake
 *     path never runs a real `session_start` hook, so `appliedUnitModel`
 *     stays `null` throughout and `ui/identity.ts`'s `resolvedDispatchAuthor`
 *     fallback is the asserted source — asserted explicitly below, not just
 *     assumed.
 *
 * (B) Review identity — the REAL `runReviewDialectic` (`review/dispatch.ts`)
 *     with a fake `ReviewDispatcher`, over a real git repo with an
 *     uncommitted, reviewable diff (same `initTrackedGitRepo` fixture as
 *     `task-e2e.test.ts`'s scenario (D)). The dispatcher asserts MID-FLIGHT
 *     (inside its own `dispatch`, before the dialectic has settled) that
 *     `formatIdentity(currentIdentity(s))` reads `⚖ challenger · <model> ·
 *     <scope>` — proving review precedence over a SIMULTANEOUSLY-set
 *     `currentUnit` (D16/M1R-1) — then returns `NO_FLAGS`, which ends the
 *     dialectic after the challenger turn alone. `publishReviewActivity`/
 *     `clearReviewActivity` (`review/dispatch.ts`) hardcode
 *     `getForgeAutoSession()` internally (never a passed-in session), so
 *     this scenario — unlike (A) — MUST use the process-wide singleton, not
 *     a synthetic instance, for the review-side assertions to observe
 *     anything.
 *
 * (C) Linha viva — drives the exported pure helpers
 *     (`appendStreamLine`+`formatToolLine`, then `finishToolLine`) directly
 *     over `s.workerStream` and asserts `renderPanel`'s collapsed strip
 *     shows the running `$ …` line, then the finalized one, then `✗` on
 *     `isError: true`. The full `pi.on("tool_execution_start"/"_end", …)`
 *     wiring (`registerUnitPanel`) is exercised only by a live TUI — this is
 *     the DATA PATH the wiring calls into, which is what an e2e file that
 *     never boots a real `pi` can honestly claim.
 *
 * Every scenario resets the `ForgeAutoSession` singleton before AND after, so
 * the file is repeat-safe (`node --test` run twice in a row) and leaves no
 * state for a sibling test file to trip over.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { dispatchUnitViaNewSession } from "../auto/driver.ts";
import { getForgeAutoSession } from "../auto/session.ts";
import type { NextUnit } from "../state/dispatch.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";
import { runReviewDialectic, type ReviewDispatcher } from "../review/dispatch.ts";
import { appendStreamLine, finishToolLine, formatToolLine, renderPanel } from "../ui/unit-panel.ts";
import { currentIdentity, formatIdentity, shortModelLabel } from "../ui/identity.ts";

async function withSandboxAsync<T>(prefix: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `.gsd/models.md` routing `executor` to a single-ref pool distinct from any
 * session baseline — same shape/purpose as
 * `authorship-routing-e2e.test.ts`'s `writeExecutorRoutesToGptConfig`
 * (duplicated locally, per that file's own convention of not importing
 * fixtures across e2e files).
 */
const EXECUTOR_MODEL = "openai/gpt-5.5";

function writeExecutorRoutesToGptConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(join(cwd, ".gsd", "models.md"), `pools:\n  gpt:\n    - ${EXECUTOR_MODEL}\n\nroles:\n  executor:\n    - gpt\n`);
}

/**
 * A fake `ExtensionCommandContext` whose `newSession` runs `onSendMessage`
 * synchronously, no real `pi` session involved — the minimal shape
 * `dispatchUnitViaNewSession` needs (`workspaceRoot`+`withSession`, a single
 * `sendMessage({ content, ... }, { triggerTurn: true })`), reused from the
 * `fakeCtx` family in `task-e2e.test.ts`/`authorship-routing-e2e.test.ts`.
 */
function fakeUnitCtx(onSendMessage: (content: string) => void): ExtensionCommandContext {
  function makeSessionLike(): unknown {
    return {
      hasUI: false,
      abort() {
        /* no-op — nothing to abort in the synchronous fake turn */
      },
      async sendMessage(msg: { content: string }): Promise<void> {
        onSendMessage(msg.content);
      },
      async newSession(opts: { withSession: (fresh: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
        const fresh = makeSessionLike();
        await opts.withSession(fresh);
        return { cancelled: false };
      },
    };
  }
  return makeSessionLike() as ExtensionCommandContext;
}

/** git repo with one tracked, committed file — duplicated from `task-e2e.test.ts`'s `initTrackedGitRepo`. */
function initTrackedGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
  writeFileSync(join(cwd, "tracked.txt"), "seed\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "seed"]);
}

/** `roles.reviewer`/`roles.advocate` config so `resolveModelForRole` resolves a non-null model for the dialectic. */
const CHALLENGER_MODEL = "claude-code/claude-opus-4-8";
const reviewModelsConfig = {
  pools: { main: [CHALLENGER_MODEL] },
  roles: { reviewer: ["main"], advocate: ["main"] },
  constraints: {},
};

describe("S04/T05 — cockpit identity e2e (through-the-driver)", () => {
  test("(A) unit identity: dispatchUnitViaNewSession publishes the resolvedDispatchAuthor model currentIdentity renders", async () => {
    await withSandboxAsync("forge-cockpit-identity-e2e-unit-", async (cwd) => {
      const s = getForgeAutoSession();
      s.reset();
      try {
        writeExecutorRoutesToGptConfig(cwd);
        s.active = true;
        s.cwd = cwd;
        const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
        // The loop publishes `currentUnit` before calling the driver — this
        // test mirrors exactly that, never writing identity fields itself.
        s.currentUnit = unit;

        const cmdCtx = fakeUnitCtx(() => {
          deliverUnitResult({ status: "done", summary: "ok", artifacts: [] }, s.currentRendezvousToken ?? undefined);
        });
        s.cmdCtx = cmdCtx;

        const outcome = await dispatchUnitViaNewSession(s, unit, "# Unit: execute-task\n\nDo the thing.\n");
        assert.equal(outcome.kind, "result", "the fake worker delivered a result, not a timeout/blocked outcome");

        // This fake path never runs a real `session_start` hook — no hook
        // exists to publish `appliedUnitModel`. Assert that explicitly rather
        // than assume it, per the plan's "state which source in a comment":
        // the model `currentIdentity` reads below is the
        // `resolvedDispatchAuthor` fallback, not the (unused) applied slot.
        assert.equal(s.appliedUnitModel, null, "no session_start hook ran — appliedUnitModel was never published");
        assert.ok(s.resolvedDispatchAuthor, "dispatchUnitViaNewSession published resolvedDispatchAuthor pre-dispatch");
        assert.equal(s.resolvedDispatchAuthor!.model, EXECUTOR_MODEL, "resolved through the real .gsd/models.md executor route");

        const id = currentIdentity(s);
        assert.ok(id, "an identity is derivable from the container after the dispatch settles");
        const rendered = formatIdentity(id!);
        assert.match(rendered, /^⚒ executor · .+ · S01\/T01$/);
        assert.equal(rendered, `⚒ executor · ${shortModelLabel(EXECUTOR_MODEL)} · S01/T01`);
      } finally {
        s.reset();
      }
    });
  });

  test("(B) review identity mid-flight beats a simultaneously-set currentUnit; clears after, falls back to unit identity", async () => {
    await withSandboxAsync("forge-cockpit-identity-e2e-review-", async (cwd) => {
      const s = getForgeAutoSession();
      s.reset();
      try {
        initTrackedGitRepo(cwd);
        // An uncommitted, reviewable change — `computeReviewDiffCmd`'s
        // `git diff HEAD` fallback (no journal shas in this fixture) sees it.
        writeFileSync(join(cwd, "tracked.txt"), "seed\nmudança revisável\n");

        s.active = true;
        s.cwd = cwd;
        const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
        // Deliberately set BEFORE the dialectic runs — proves review
        // precedence (D16/M1R-1) over an in-flight unit, not merely "no unit
        // was set".
        s.currentUnit = unit;

        let dispatchCount = 0;
        const dialecticDispatcher: ReviewDispatcher = {
          dispatch: async (_prompt, opts) => {
            dispatchCount++;
            const id = currentIdentity(s);
            assert.ok(id, "the review identity is derivable mid-flight, before the dialectic has settled");
            assert.equal(
              formatIdentity(id!),
              `⚖ challenger · ${shortModelLabel(opts.model)} · S01`,
              "review precedence beats the simultaneously-set currentUnit (D16/M1R-1)",
            );
            return "NO_FLAGS\n";
          },
        };

        const dialecticResult = await runReviewDialectic({
          cwd,
          milestoneId: "M-toy",
          slice: "S01",
          sliceTitle: "S04/T05 e2e fixture slice",
          unit,
          ctxForResolve: { session: s, config: reviewModelsConfig },
          dispatcher: dialecticDispatcher,
          reviewedOn: "2026-07-12",
          rounds: 1,
          authorFamily: null,
        });

        assert.equal(dispatchCount, 1, "NO_FLAGS ends the dialectic after the challenger turn alone");
        assert.equal(dialecticResult.result.noFlags, true, "sanity: the dialectic actually took the NO_FLAGS branch");
        assert.equal(s.reviewActivity, null, "the token-correlated clear ran after the challenger turn settled");

        const idAfter = currentIdentity(s);
        assert.ok(idAfter, "unit identity is still derivable — currentUnit was never cleared by the dialectic");
        assert.equal(
          formatIdentity(idAfter!),
          "⚒ executor · S01/T01",
          "falls back to the unit identity once the review clears (no model published on this container)",
        );
      } finally {
        s.reset();
      }
    });
  });

  test("(C) linha viva: tool_execution_start→end lifecycle over the collapsed strip, ✗ on isError", () => {
    const s = getForgeAutoSession();
    s.reset();
    try {
      s.active = true;
      const unit: NextUnit = { type: "execute-task", slice: "S02", task: "T09" };
      s.currentUnit = unit;
      const identity = (() => {
        const id = currentIdentity(s);
        return id ? formatIdentity(id) : null;
      })();
      assert.equal(identity, "⚒ executor · S02/T09");

      // start: tool_execution_start's handler appends via formatToolLine —
      // driven here directly (the pure data path; `registerUnitPanel`'s
      // `pi.on` wiring itself only runs in a live TUI).
      appendStreamLine(s.workerStream, formatToolLine("bash", { command: "git diff --stat" }));
      let lines = renderPanel({ lines: s.workerStream, collapsed: true, currentUnit: s.currentUnit, identity });
      assert.equal(lines.length, 1);
      assert.equal(lines[0], "▸ ⚒ executor · S02/T09 — $ git diff --stat ⋯ · Ctrl+B", "the running $ … line is visible, collapsed");

      // end (clean): tool_execution_end's handler finalizes the SAME line in place.
      finishToolLine(s.workerStream, { toolName: "bash" }, false);
      lines = renderPanel({ lines: s.workerStream, collapsed: true, currentUnit: s.currentUnit, identity });
      assert.equal(lines[0], "▸ ⚒ executor · S02/T09 — $ git diff --stat · Ctrl+B", "the running marker is stripped once finished, no ✗");

      // A second tool call whose end reports isError:true — ✗ appended in place.
      appendStreamLine(s.workerStream, formatToolLine("edit", { file_path: "src/x.ts" }));
      finishToolLine(s.workerStream, { toolName: "edit" }, true);
      lines = renderPanel({ lines: s.workerStream, collapsed: true, currentUnit: s.currentUnit, identity });
      assert.equal(lines[0], "▸ ⚒ executor · S02/T09 — edit src/x.ts ✗ · Ctrl+B", "isError:true finalizes with a trailing ✗");
    } finally {
      s.reset();
    }
  });
});
