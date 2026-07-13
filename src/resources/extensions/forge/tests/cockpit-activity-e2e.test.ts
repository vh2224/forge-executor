/**
 * S05/T02 — the through-the-driver referent for S05's whole demo claim: the
 * cockpit reports exactly ONE live activity at a time, and that activity
 * identifies itself honestly — either as the genuinely-running tool count
 * (never the retained render ledger), or, when a review is in flight, as the
 * review's own role (`⚖ challenger`), never as "N historical tool cards".
 *
 * Two production seams are exercised, both from their real publish sites:
 *
 * (A) T01's count seam — `countActiveTools`/`handleAgentEvent`, imported from
 *     the BUILT `@forge/agent-modes` package artifact (not
 *     `packages/forge-agent-modes/src` directly), the same way the shipped
 *     binary resolves it. A fake `InteractiveModeStateHost` (duplicated
 *     locally from `chat-controller.test.ts`'s `createStreamingHost`, per
 *     this file family's convention of not importing fixtures across e2e
 *     files) drives two sequential real `tool_execution_start`/`_end` pairs
 *     through `handleAgentEvent`. `tool_execution_end` deliberately retains
 *     the completed `ToolExecutionComponent` in `pendingTools` (see the NOTE
 *     in `chat-controller.ts`) — the assertion is that the OBSERVABLE live
 *     count still walks `1 → 0 → 1 → 0`, never accumulating into
 *     `pendingTools.size`.
 *
 * (B) S04's review-identity seam — the REAL `runReviewDialectic`
 *     (`review/dispatch.ts`) with a fake `ReviewDispatcher`, over a real git
 *     repo with an uncommitted, reviewable diff (same `initTrackedGitRepo`
 *     fixture as `cockpit-identity-e2e.test.ts`/`task-e2e.test.ts`). The
 *     dispatcher asserts MID-FLIGHT (inside its own `dispatch`, before the
 *     dialectic has settled) that `formatIdentity(currentIdentity(s))` reads
 *     `⚖ challenger · <model> · <scope>` — the single identified activity,
 *     not a tool-card count — then returns `NO_FLAGS`, ending the dialectic
 *     after the challenger turn alone. `publishReviewActivity`/
 *     `clearReviewActivity` hardcode `getForgeAutoSession()` internally, so
 *     this scenario uses the process-wide singleton, not a synthetic
 *     instance.
 *
 * Both proofs run inside ONE named scenario (S05-PLAN Step 4): the cockpit is
 * a single surface, and the point of the slice is that it never conflates
 * "N tool cards happen to be retained" with "a review is live" — one honest,
 * role-identified activity at a time.
 *
 * The `ForgeAutoSession` singleton is reset before AND after, so the file is
 * repeat-safe (`node --test` run twice in a row) and leaves no state for a
 * sibling test file to trip over.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Container } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { countActiveTools, handleAgentEvent } from "@forge/agent-modes/modes/interactive/controllers/chat-controller.js";
import { createStreamingRenderState } from "@forge/agent-modes/modes/interactive/streaming-render-state.js";

import { getForgeAutoSession } from "../auto/session.ts";
import type { NextUnit } from "../state/dispatch.ts";
import { runReviewDialectic, type ReviewDispatcher } from "../review/dispatch.ts";
import { currentIdentity, formatIdentity, shortModelLabel } from "../ui/identity.ts";

async function withSandboxAsync<T>(prefix: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** git repo with one tracked, committed file — duplicated from `cockpit-identity-e2e.test.ts`'s `initTrackedGitRepo`. */
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

/**
 * Minimal fake `InteractiveModeStateHost` sufficient for `handleAgentEvent`'s
 * `tool_execution_start`/`tool_execution_update`/`tool_execution_end` cases —
 * duplicated locally from `chat-controller.test.ts`'s `createStreamingHost`
 * (per this file family's convention of not importing test fixtures across
 * packages). Typed `any` so it can be handed to `handleAgentEvent`'s wider
 * host intersection type without restating every unused method.
 */
function createStreamingHost(chatContainer: Container): any {
  return {
    isInitialized: true,
    streamingRenderState: createStreamingRenderState(),
    footer: { invalidate() {} },
    settingsManager: {
      getTimestampFormat() {
        return "date-time-iso";
      },
      getShowImages() {
        return false;
      },
    },
    getMarkdownThemeWithSettings() {
      return undefined;
    },
    getRegisteredToolDefinition() {
      return undefined;
    },
    formatWebSearchResult() {
      return "";
    },
    session: { messages: [], retryAttempt: 0 },
    chatContainer,
    pendingTools: new Map(),
    pendingMessagesContainer: { clear() {} },
    pinnedMessageContainer: new Container(),
    statusContainer: new Container(),
    hideThinkingBlock: true,
    toolOutputExpanded: false,
    loadingAnimation: undefined,
    pendingWorkingMessage: undefined,
    defaultWorkingMessage: "Working...",
    ui: {
      terminal: { rows: 60, columns: 100 },
      requestRender() {},
    },
  };
}

describe("S05/T02 — cockpit activity e2e (through-the-driver)", () => {
  test("review is one identified worker activity, not N historical tool cards: honest tool count + role-aware review identity, end to end", async () => {
    await withSandboxAsync("forge-cockpit-activity-e2e-", async (cwd) => {
      const s = getForgeAutoSession();
      s.reset();
      try {
        // --- (A) T01's honest count seam, through the BUILT @forge/agent-modes ---
        initTheme("dark", false);
        const chatContainer = new Container();
        const host = createStreamingHost(chatContainer);
        const progression: number[] = [];

        await handleAgentEvent(host, {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read",
          args: { path: "src/a.ts" },
        } as any);
        progression.push(countActiveTools(host.pendingTools));

        await handleAgentEvent(host, {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "read",
          result: { content: [], isError: false },
          isError: false,
        } as any);
        progression.push(countActiveTools(host.pendingTools));

        await handleAgentEvent(host, {
          type: "tool_execution_start",
          toolCallId: "call-2",
          toolName: "bash",
          args: { command: "pnpm test" },
        } as any);
        progression.push(countActiveTools(host.pendingTools));

        await handleAgentEvent(host, {
          type: "tool_execution_end",
          toolCallId: "call-2",
          toolName: "bash",
          result: { content: [], isError: false },
          isError: false,
        } as any);
        progression.push(countActiveTools(host.pendingTools));

        assert.deepEqual(
          progression,
          [1, 0, 1, 0],
          "the observable live count tracks the currently-running worker, never accumulating across settled calls",
        );
        assert.equal(
          host.pendingTools.size,
          2,
          "both completed tool components are intentionally retained in the render ledger for message_end reconstruction — " +
            "a historical ledger size of 2, while the honest live count after the second settle is 0, proves the count and the ledger are distinct contracts",
        );

        // --- (B) S04's role-aware review identity, through the real production publisher ---
        initTrackedGitRepo(cwd);
        // An uncommitted, reviewable change — `computeReviewDiffCmd`'s
        // `git diff HEAD` fallback (no journal shas in this fixture) sees it.
        writeFileSync(join(cwd, "tracked.txt"), "seed\nmudança revisável\n");

        s.active = true;
        s.cwd = cwd;
        const unit: NextUnit = { type: "execute-task", slice: "S05", task: "T02" };
        // Deliberately set BEFORE the dialectic runs, and with retained tool
        // components still sitting in the (unrelated) chat-controller host
        // above — proves the live activity identifies as the review role,
        // not as a tool-card count, and beats the simultaneously-set
        // currentUnit (D16/M1R-1).
        s.currentUnit = unit;

        let dispatchCount = 0;
        const dialecticDispatcher: ReviewDispatcher = {
          dispatch: async (_prompt, opts) => {
            dispatchCount++;
            const id = currentIdentity(s);
            assert.ok(id, "the review identity is derivable mid-flight, before the dialectic has settled");
            assert.equal(
              formatIdentity(id!),
              `⚖ challenger · ${shortModelLabel(opts.model)} · S05`,
              "the live activity identifies itself as the review role — one worker, not N historical tool cards",
            );
            return "NO_FLAGS\n";
          },
        };

        const dialecticResult = await runReviewDialectic({
          cwd,
          milestoneId: "M-toy",
          slice: "S05",
          sliceTitle: "S05/T02 e2e fixture slice",
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
          "⚒ executor · S05/T02",
          "falls back to the unit identity once the review clears (no model published on this container)",
        );
      } finally {
        s.reset();
      }
    });
  });
});
