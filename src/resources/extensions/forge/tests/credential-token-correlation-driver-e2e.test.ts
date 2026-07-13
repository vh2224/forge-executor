/**
 * S01/T03 — through-the-driver proof that credential exhaustion is token-safe.
 *
 * Honesty note: both dispatches cross the REAL `dispatchUnitViaNewSession`
 * driver, and each fresh-instance hook is registered once with that dispatch's
 * bound token. The stale A event is delivered to A's pi after a real B
 * dispatch, while the current B event is delivered to B's pi. AuthStorage,
 * CredentialRotator's source, pi handles, command context, and model routes
 * are fake/instrumented; no provider or network is contacted. The test runs
 * against compiled output via `scripts/dist-test-resolve.mjs` after
 * `pnpm run test:compile`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { dispatchUnitViaNewSession } from "../auto/driver.ts";
import { ForgeAutoSession, getForgeAutoSession } from "../auto/session.ts";
import type { NextUnit } from "../state/index.ts";
import { registerCredentialExhaustion } from "../bootstrap/register-extension.ts";
import { CredentialRotator, type CredentialSource } from "@forge/agent-core/credential-rotation.js";

function apiKey(key: string) {
  return { type: "api_key" as const, key };
}

type ApiCredential = ReturnType<typeof apiKey>;

/** Real-shaped AuthStorage source; this test needs the rotator, not request injection. */
function fakeAuthStorage(data: Record<string, ApiCredential[]>) {
  const source: CredentialSource = {
    getCredentialsForProvider: (provider) => data[provider] ?? [],
  };
  return { source };
}

function fakeCmdCtx() {
  const freshCtx = {
    abort() {},
    async sendMessage(): Promise<void> {
      throw new Error("boom: worker turn failed inside sendMessage");
    },
  };
  return {
    abort() {},
    model: undefined,
    async newSession(opts: { withSession: (ctx: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
      await opts.withSession(freshCtx);
      return { cancelled: false };
    },
  };
}

interface FakePi {
  on(event: "message_end", handler: (event: { message: unknown }, ctx: unknown) => void): void;
  fire(message: unknown): void;
}

function makeFakePi(): FakePi {
  let handler: ((event: { message: unknown }, ctx: unknown) => void) | null = null;
  return {
    on(_event, registered) {
      handler = registered;
    },
    fire(message) {
      handler?.({ message }, {});
    },
  };
}

function rateLimitAssistantMessage(): unknown {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage: "rate_limit_exceeded",
    retryAfterMs: 30_000,
  };
}

function writeExecutorRoutesToOpenaiConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "pools:\n  primary:\n    - openai/gpt-5.5\n\nroles:\n  executor:\n    - primary\n",
  );
}

function makeSession(cwd: string, rotator: CredentialRotator) {
  const session = getForgeAutoSession();
  Object.assign(session, new ForgeAutoSession());
  session.cwd = cwd;
  session.active = true;
  session.credentialRotator = rotator;
  session.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session.cmdCtx = fakeCmdCtx() as any;
  return session;
}

const unitA: NextUnit = { type: "execute-task", slice: "S01", task: "T03-A" };
const unitB: NextUnit = { type: "execute-task", slice: "S01", task: "T03-B" };

describe("credential token correlation through the driver (S01/T03)", () => {
  test("boot-registered hook cools the in-flight credential live-at-delivery (regression 4d7c8980)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-s01-token-"));
    try {
      writeExecutorRoutesToOpenaiConfig(cwd);
      const credA = apiKey("fake-openai-A");
      const credB = apiKey("fake-openai-B");
      const rotator = new CredentialRotator(fakeAuthStorage({ openai: [credA, credB] }).source);
      const session = makeSession(cwd, rotator);

      // PRODUCTION SHAPE: the bootstrap registers ONCE, before any dispatch —
      // currentRendezvousToken is null here. A token frozen at registration
      // would be null forever and NO exhaustion would ever be marked (the
      // whole multi-account cooldown was dead under 4d7c8980).
      const pi = makeFakePi();
      registerCredentialExhaustion(pi as unknown as ExtensionAPI);

      await dispatchUnitViaNewSession(session, unitA, "prompt A");
      assert.equal(session.selectedCredential?.identity, "fake-openai-A");
      const tokenA = session.currentRendezvousToken;
      assert.equal(typeof tokenA, "number");

      // 429 during A's turn: live comparison matches → A cools.
      pi.fire(rateLimitAssistantMessage());
      assert.equal(
        rotator.selectCredential("openai", Date.now())?.identity,
        "fake-openai-B",
        "A must be cooled by its own 429 — the frozen-token variant marked nothing",
      );

      await dispatchUnitViaNewSession(session, unitB, "prompt B");
      assert.equal(session.selectedCredential?.identity, "fake-openai-B");
      const tokenB = session.currentRendezvousToken;
      assert.equal(typeof tokenB, "number");
      assert.notEqual(tokenB, tokenA);

      // A selection stamped with a superseded token must never cool the
      // current credential (the M1R-1 guard, expressed live-at-delivery).
      session.selectedCredential = { ...session.selectedCredential!, token: tokenA! };
      pi.fire(rateLimitAssistantMessage());
      assert.equal(
        rotator.selectCredential("openai", Date.now())?.identity,
        "fake-openai-B",
        "stale-stamped selection must not cool B",
      );

      // Restore the real stamp: a current 429 cools B.
      session.selectedCredential = { ...session.selectedCredential!, token: tokenB! };
      pi.fire(rateLimitAssistantMessage());
      assert.equal(rotator.selectCredential("openai", Date.now()), null, "current B event cools B");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
