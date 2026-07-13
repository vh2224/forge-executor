/**
 * S01/T02 — through-the-driver proof that the selected credential reaches the
 * native request layer after a 429 rotation.
 *
 * Honesty note: (i) `dispatchUnitViaNewSession` is REAL; (ii) the 429 is
 * delivered through the REAL `registerCredentialExhaustion` message_end hook;
 * (iii) the credential list is never reordered; (iv) keys are synthetic and
 * no network is used. The AuthStorage handle below is a fake of the
 * vendored AuthStorage contract (including runtime overrides and getApiKey),
 * instrumented at setRuntimeApiKey to observe exactly what the request would
 * receive before dispatch teardown clears the override. OAuth and the
 * externalCli environment path are explicitly deferred by S01's design.
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
import {
  CredentialRotator,
  providerAvailabilityProbe,
  type CredentialSource,
} from "@forge/agent-core/credential-rotation.js";

function apiKey(key: string) {
  return { type: "api_key" as const, key };
}

type ApiCredential = ReturnType<typeof apiKey>;

/** Real-shaped AuthStorage seam: storage credentials plus runtime override precedence. */
function fakeAuthStorage(data: Record<string, ApiCredential[]>) {
  const overrides = new Map<string, string>();
  const requests: string[] = [];
  const source: CredentialSource = {
    getCredentialsForProvider: (provider) => data[provider] ?? [],
  };
  const handle = {
    getCredentialsForProvider: source.getCredentialsForProvider,
    setRuntimeApiKey(provider: string, key: string): void {
      overrides.set(provider, key);
      requests.push(key);
    },
    removeRuntimeApiKey(provider: string): void {
      overrides.delete(provider);
    },
    async getApiKey(provider: string): Promise<string | undefined> {
      return overrides.get(provider) ?? data[provider]?.[0]?.key;
    },
  };
  return { handle, source, requests };
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
      try {
        await opts.withSession(freshCtx);
      } catch (error) {
        throw error;
      }
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

function makeSession(cwd: string, rotator: CredentialRotator | null, authStorageForOverride: unknown) {
  const session = getForgeAutoSession();
  Object.assign(session, new ForgeAutoSession());
  session.cwd = cwd;
  session.active = true;
  session.credentialRotator = rotator;
  session.authStorageForOverride = authStorageForOverride as never;
  session.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session.cmdCtx = fakeCmdCtx() as any;
  return session;
}

const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T02" };

describe("dispatchUnitViaNewSession request credential injection (S01/T02)", () => {
  test("429 on A causes the second request to receive B, while raw getApiKey remains A", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-s01-request-"));
    writeExecutorRoutesToOpenaiConfig(cwd);
    const credA = apiKey("fake-openai-A");
    const credB = apiKey("fake-openai-B");
    const auth = fakeAuthStorage({ openai: [credA, credB] });
    const rotator = new CredentialRotator(auth.source);
    const session = makeSession(cwd, rotator, auth.handle);

    await dispatchUnitViaNewSession(session, unit, "prompt");
    assert.equal(auth.requests.at(-1), "fake-openai-A", "request #1 receives A via runtime override");
    assert.equal(await auth.handle.getApiKey("openai"), "fake-openai-A", "capture is before teardown");

    const pi = makeFakePi();
    registerCredentialExhaustion(pi as unknown as ExtensionAPI);
    pi.fire(rateLimitAssistantMessage());
    assert.equal(rotator.selectCredential("openai", Date.now())?.index, 1, "REAL 429 hook cools A");

    await dispatchUnitViaNewSession(session, unit, "prompt");
    assert.equal(auth.requests.at(-1), "fake-openai-B", "request #2 authenticates with B, not cooled A");
    assert.equal(await auth.handle.getApiKey("openai"), "fake-openai-A", "without the override, [0] is still A");
    assert.notEqual(auth.requests.at(-1), await auth.handle.getApiKey("openai"));
    assert.deepEqual(session.selectedCredential, { provider: "openai", index: 1, identity: "fake-openai-B", token: session.currentRendezvousToken! });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("single-credential guard is byte-identical and applies no request override", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-s01-single-"));
    writeExecutorRoutesToOpenaiConfig(cwd);
    const credA = apiKey("fake-openai-only");
    const auth = fakeAuthStorage({ openai: [credA] });
    const session = makeSession(cwd, null, auth.handle);
    const preSliceRequestKey = await auth.handle.getApiKey("openai");

    await dispatchUnitViaNewSession(session, unit, "prompt");

    assert.deepEqual(auth.requests, [], "no rotator means no override is applied");
    assert.equal(await auth.handle.getApiKey("openai"), preSliceRequestKey);
    assert.equal(preSliceRequestKey, "fake-openai-only");
    rmSync(cwd, { recursive: true, force: true });
  });
});
