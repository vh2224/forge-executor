/**
 * S02/T03 lineage proof. This exercises the production dispatchers through the
 * host `newSession` boundary, then reads the JSONL which the vendored
 * SessionManager persisted. The fake is only the AgentSession host: production
 * agent-session-navigation forwards this same option to SessionManager.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { SessionManager } from "../../../../../packages/pi-coding-agent/src/core/session-manager.ts";
import { dispatchUnitViaNewSession } from "../auto/driver.ts";
import { ForgeAutoSession, getForgeAutoSession } from "../auto/session.ts";
import { productionReviewDispatcher } from "../review/dispatch.ts";
import type { NextUnit } from "../state/index.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";

const UNIT: NextUnit = { type: "execute-task", slice: "S02", task: "T03" };

type Header = { parentSession?: string };

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "forge-run-thread-lineage-"));
  try {
    return await fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function appendAssistant(sessionManager: SessionManager, text = "worker completed"): void {
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);
}

function readHeader(path: string): Header {
  assert.ok(existsSync(path), `the replacement session was persisted: ${path}`);
  const firstLine = readFileSync(path, "utf8").split("\n")[0];
  assert.ok(firstLine, "the JSONL contains its session header");
  return JSON.parse(firstLine) as Header;
}

/** A host-shaped context whose replacements use the real vendored persistence. */
function persistentHost(sm: SessionManager, session: ForgeAutoSession) {
  const newSession = async (options: {
    cwd?: string;
    parentSession?: string;
    withSession: (ctx: object) => Promise<void>;
  }): Promise<{ cancelled: boolean }> => {
    sm.newSession({ cwd: options.cwd, parentSession: options.parentSession });
    const fresh = {
      abort() {},
      modelRegistry: { getAll: () => [] },
      sessionManager: sm,
      newSession,
      async sendMessage(): Promise<void> {
        // SessionManager writes a header only once an assistant entry exists.
        appendAssistant(sm);
        deliverUnitResult({ status: "done", summary: "done", artifacts: [] }, session.currentRendezvousToken ?? undefined);
      },
    };
    await options.withSession(fresh);
    return { cancelled: false };
  };
  return { abort() {}, model: undefined, sessionManager: sm, newSession };
}

function persistedRoot(sm: SessionManager): string {
  appendAssistant(sm, "operator root");
  const root = sm.getSessionFile();
  assert.ok(root, "the operator root has a persisted JSONL path");
  return root;
}

describe("S02/T03 through-the-driver JSONL lineage", () => {
  test("two worker dispatches persist sibling headers under the captured operator root", async () => {
    const priorTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    await withSandboxAsync(async (cwd) => {
      const sm = SessionManager.create(cwd, join(cwd, "sessions"));
      const root = persistedRoot(sm);
      const s = new ForgeAutoSession();
      s.cwd = cwd;
      s.runRootSessionPath = root;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = persistentHost(sm, s) as any;

      await dispatchUnitViaNewSession(s, UNIT, "first worker");
      const firstWorker = sm.getSessionFile();
      assert.ok(firstWorker);
      assert.equal(readHeader(firstWorker).parentSession, root);

      await dispatchUnitViaNewSession(s, UNIT, "second worker");
      const secondWorker = sm.getSessionFile();
      assert.ok(secondWorker);
      assert.notEqual(secondWorker, firstWorker, "each dispatch creates a distinct replacement JSONL");
      assert.equal(readHeader(secondWorker).parentSession, root, "the second worker remains a root sibling, never a child of the first");
    });
    if (priorTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
    else process.env.FORGE_UNIT_TIMEOUT_MS = priorTimeout;
  });

  test("review dispatch persists its header under the same captured operator root", async () => {
    await withSandboxAsync(async (cwd) => {
      const sm = SessionManager.create(cwd, join(cwd, "sessions"));
      const root = persistedRoot(sm);
      const s = getForgeAutoSession();
      s.reset();
      s.cwd = cwd;
      s.runRootSessionPath = root;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const host = persistentHost(sm, s) as any;
      s.cmdCtx = host;

      const text = await productionReviewDispatcher(host).dispatch("review this", {
        workingDir: cwd,
        model: null,
        provider: null,
      });

      assert.equal(text, "worker completed");
      const reviewWorker = sm.getSessionFile();
      assert.ok(reviewWorker);
      assert.equal(readHeader(reviewWorker).parentSession, root);
      s.reset();
    });
  });

  test("a null run root produces the same no-parent header shape as a plain SessionManager session", async () => {
    const priorTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    await withSandboxAsync(async (cwd) => {
      const sm = SessionManager.create(cwd, join(cwd, "sessions"));
      persistedRoot(sm);
      const s = new ForgeAutoSession();
      s.cwd = cwd;
      s.runRootSessionPath = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = persistentHost(sm, s) as any;

      await dispatchUnitViaNewSession(s, UNIT, "unparented worker");
      const dispatchedPath = sm.getSessionFile();
      assert.ok(dispatchedPath);
      const dispatchedHeader = readHeader(dispatchedPath);

      const baseline = SessionManager.create(cwd, join(cwd, "baseline"));
      appendAssistant(baseline, "ordinary session");
      const baselinePath = baseline.getSessionFile();
      assert.ok(baselinePath);
      const baselineHeader = readHeader(baselinePath);

      assert.equal("parentSession" in dispatchedHeader, false, "null roots do not synthesize lineage metadata");
      assert.equal("parentSession" in dispatchedHeader, "parentSession" in baselineHeader, "the omitted option retains the vendored header shape");
    });
    if (priorTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
    else process.env.FORGE_UNIT_TIMEOUT_MS = priorTimeout;
  });
});
