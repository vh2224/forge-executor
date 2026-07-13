/**
 * S04/T03 — production-path proof for bare model IDs and OAuth refresh recovery.
 *
 * The model assertion crosses dispatchUnitViaNewSession and then invokes the
 * session_start hook on the fresh-session surface. The auth assertions use the
 * same AgentSessionModelModule request-auth seam used by a real AgentSession
 * turn; credentials and the refresh result are synthetic and never touch a
 * provider or the network.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dispatchUnitViaNewSession } from "../auto/driver.ts";
import { ForgeAutoSession, getForgeAutoSession } from "../auto/session.ts";
import { registerAutoUnitSetup } from "../bootstrap/register-extension.ts";
import type { NextUnit } from "../state/index.ts";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { AgentSessionModelModule } from "@forge/agent-core/session/agent-session-model.js";

function fakeCmdCtx() {
  const freshCtx = {
    abort() {},
    async sendMessage(): Promise<void> {
      throw new Error("synthetic worker failure");
    },
  };
  return {
    abort() {},
    model: undefined,
    async newSession(opts: { withSession: (ctx: unknown) => Promise<void> }) {
      await opts.withSession(freshCtx);
      return { cancelled: false };
    },
  };
}

interface FakePi {
  on(event: "session_start", handler: (event: unknown, ctx: unknown) => Promise<void>): void;
  setModel(model: unknown): Promise<void>;
  setActiveTools(tools: string[]): void;
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string }>;
  fire(ctx: unknown): Promise<void>;
}

function fakePi(): FakePi {
  let hook: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  return {
    on(_event, handler) { hook = handler; },
    async fire(ctx) {
      assert.ok(hook, "fresh session must register session_start");
      await hook?.({}, ctx);
    },
    async setModel(_model) {},
    setActiveTools(_tools) {},
    getActiveTools() { return ["read", "write"]; },
    getAllTools() { return [{ name: "read" }, { name: "write" }]; },
  };
}

function sessionForDriver(): ForgeAutoSession {
  const session = getForgeAutoSession();
  Object.assign(session, new ForgeAutoSession());
  session.active = true;
  session.baselineModel = { provider: "claude", id: "baseline" } as never;
  session.cmdCtx = fakeCmdCtx() as never;
  return session;
}

const targetModel = { provider: "openai", id: "gpt-5.6-luna" };
const unit: NextUnit = { type: "execute-task", slice: "S04", task: "T03" };

function authHost(sequence: Array<{ ok: boolean; apiKey?: string; error?: string }>, credentials = true) {
  let cursor = 0;
  return {
    modelRegistry: {
      getApiKeyAndHeaders: async () => sequence[Math.min(cursor++, sequence.length - 1)],
      isUsingOAuth: () => true,
      authStorage: {
        getCredentialsForProvider: () => credentials ? [{ type: "oauth", refresh: "synthetic" }] : [],
      },
    },
  } as never;
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    assert.fail("expected the request-auth turn to reject");
  } catch (error) {
    return (error as Error).message;
  }
}

describe("provider resilience through production seams (S04/T03)", () => {
  test("real dispatch publishes a bare ID and the fresh session applies it", async () => {
    const session = sessionForDriver();
    // This is the value produced by the role resolver in production. Keeping
    // it bare here targets the exact hand-off that T01 fixed.
    session.currentUnit = unit;
    session.resolvedDispatchAuthor = { provider: "openai", model: "gpt-5.6-luna", family: "openai" };

    await dispatchUnitViaNewSession(session, unit, "execute the unit");
    assert.equal(session.pendingUnitModel, "gpt-5.6-luna");
    const pi = fakePi();
    registerAutoUnitSetup(pi as unknown as ExtensionAPI);
    await pi.fire({
      modelRegistry: { getAll: () => [targetModel] },
      ui: { notify() {} },
    });

    assert.deepEqual(session.appliedUnitModel, "gpt-5.6-luna");
    assert.equal(session.appliedUnitModelToken, session.currentRendezvousToken);
  });

  test("a transient refresh failure rejects one turn, then the next turn recovers", async () => {
    const model = { provider: "anthropic", id: "claude-test" } as never;
    const module = new AgentSessionModelModule(authHost([
      { ok: false, error: "Failed to refresh OAuth token for anthropic" },
      { ok: true, apiKey: "recovered-token" },
    ]));

    const firstTurn = await rejectedMessage(module.getRequiredRequestAuth(model));
    assert.match(firstTurn, /retrying on the next turn/);
    assert.doesNotMatch(firstTurn, /Run '\/login/);
    assert.deepEqual(await module.getRequiredRequestAuth(model), {
      apiKey: "recovered-token",
      headers: undefined,
    });
  });

  test("missing OAuth credentials remain terminal through the same auth seam", async () => {
    const model = { provider: "anthropic", id: "claude-test" } as never;
    const module = new AgentSessionModelModule(authHost([
      { ok: false, error: "Failed to refresh OAuth token for anthropic" },
    ], false));
    const message = await rejectedMessage(module.getRequiredRequestAuth(model));
    assert.match(message, /Failed to refresh/);
    assert.doesNotMatch(message, /retrying on the next turn/);
  });
});
