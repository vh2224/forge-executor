/**
 * S03/T02 (achado HIGH #3, segunda metade — "429 marca esgotamento") —
 * exercita `registerCredentialExhaustion`/`isRateLimitError`
 * (`bootstrap/register-extension.ts`) diretamente, com um `pi` fake que
 * expõe só `.on("message_end", …)` (a única superfície que o hook usa) e um
 * `credentialRotator` fake cujo `markExhausted` é um spy — mirroring o
 * padrão de `evidence-rearm.test.ts`, mas importando o registrador REAL em
 * vez de mirrorá-lo, já que T02 (diferente de S04/T04) é dono de
 * `register-extension.ts`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { ThinkingLevel } from "@gsd/pi-agent-core";
import { registerAutoUnitSetup, registerCredentialExhaustion, isRateLimitError } from "../bootstrap/register-extension.ts";
import { ForgeAutoSession, getForgeAutoSession } from "../auto/session.ts";
import type { CredentialRotator } from "@forge/agent-core/credential-rotation.js";

/** Minimal fake `pi` — only `.on("message_end", handler)`, the sole surface
 *  `registerCredentialExhaustion` calls — plus a test-only `fire()`. */
interface FakePi {
  on(event: "message_end", handler: (event: { message: unknown }, ctx: unknown) => void): void;
  fire(message: unknown): void;
}

function makeFakePi(): FakePi {
  let handler: ((event: { message: unknown }, ctx: unknown) => void) | null = null;
  return {
    on(_event, h) {
      handler = h;
    },
    fire(message) {
      handler?.({ message }, {});
    },
  };
}

/** A fake `CredentialRotator` whose `markExhausted` is a spy, structurally
 *  cast to the real type (the hook only ever calls `markExhausted`). */
function makeFakeRotator(opts: { throwOnMarkExhausted?: boolean } = {}): {
  rotator: CredentialRotator;
  calls: Array<{ provider: string; identity: string; nowMs: number }>;
} {
  const calls: Array<{ provider: string; identity: string; nowMs: number }> = [];
  const rotator = {
    markExhausted(provider: string, identity: string, nowMs: number) {
      calls.push({ provider, identity, nowMs });
      if (opts.throwOnMarkExhausted) throw new Error("boom");
    },
  } as unknown as CredentialRotator;
  return { rotator, calls };
}

function assistantError(errorMessage: string, retryAfterMs?: number): unknown {
  return { role: "assistant", stopReason: "error", errorMessage, retryAfterMs };
}

function assistantStop(): unknown {
  return { role: "assistant", stopReason: "stop", content: [] };
}

describe("isRateLimitError — S03/T02 local rate-limit heuristic", () => {
  test("stopReason:error + errorMessage matching a rate-limit term -> true", () => {
    assert.equal(isRateLimitError(assistantError("rate_limit_exceeded")), true);
  });

  test("stopReason:error + retryAfterMs present (no matching errorMessage) -> true", () => {
    assert.equal(isRateLimitError({ role: "assistant", stopReason: "error", retryAfterMs: 30_000 }), true);
  });

  test("stopReason:error + unrelated errorMessage -> false", () => {
    assert.equal(isRateLimitError(assistantError("context_length_exceeded")), false);
  });

  test("stopReason:stop -> false regardless of content", () => {
    assert.equal(isRateLimitError(assistantStop()), false);
  });

  test("non-assistant / malformed payload -> false, never throws", () => {
    assert.equal(isRateLimitError(null), false);
    assert.equal(isRateLimitError(undefined), false);
    assert.equal(isRateLimitError("nope"), false);
    assert.equal(isRateLimitError({ role: "user", stopReason: "error" }), false);
  });
});

describe("registerCredentialExhaustion — S03/T02 message_end hook", () => {
  test("rate-limit message_end + selectedCredential + rotator present -> markExhausted called with the published { provider, identity }, not the index", () => {
    const s = getForgeAutoSession();
    Object.assign(s, new ForgeAutoSession());
    s.active = true;
    s.currentRendezvousToken = 1;
    const { rotator, calls } = makeFakeRotator();
    s.credentialRotator = rotator;
    s.selectedCredential = { provider: "claude-code", index: 1, identity: "refresh-token-B", token: 1 };

    const pi = makeFakePi();
    registerCredentialExhaustion(pi as unknown as ExtensionAPI);
    pi.fire(assistantError("rate_limit_exceeded", 30_000));

    assert.equal(calls.length, 1, "markExhausted called exactly once");
    assert.equal(calls[0]!.provider, "claude-code");
    assert.equal(calls[0]!.identity, "refresh-token-B", "keyed by identity, never the array index");
    assert.equal(typeof calls[0]!.nowMs, "number");
  });

  test("normal (non-rate-limit) message_end -> markExhausted NOT called", () => {
    const s = getForgeAutoSession();
    Object.assign(s, new ForgeAutoSession());
    s.active = true;
    s.currentRendezvousToken = 1;
    const { rotator, calls } = makeFakeRotator();
    s.credentialRotator = rotator;
    s.selectedCredential = { provider: "claude-code", index: 0, identity: "refresh-token-A", token: 1 };

    const pi = makeFakePi();
    registerCredentialExhaustion(pi as unknown as ExtensionAPI);
    pi.fire(assistantStop());

    assert.equal(calls.length, 0);
  });

  test("no credentialRotator on the container -> no-op even on a rate-limit signal", () => {
    const s = getForgeAutoSession();
    Object.assign(s, new ForgeAutoSession());
    s.active = true;
    s.currentRendezvousToken = 1;
    s.credentialRotator = null;
    s.selectedCredential = { provider: "claude-code", index: 0, identity: "refresh-token-A", token: 1 };

    const pi = makeFakePi();
    registerCredentialExhaustion(pi as unknown as ExtensionAPI);
    pi.fire(assistantError("rate_limit_exceeded"));
    // Nothing to assert on a spy (none exists) — the only failure mode here
    // would be a throw, which the test harness itself would surface.
  });

  test("no selectedCredential on the container -> no-op even on a rate-limit signal", () => {
    const s = getForgeAutoSession();
    Object.assign(s, new ForgeAutoSession());
    s.active = true;
    s.currentRendezvousToken = 1;
    const { rotator, calls } = makeFakeRotator();
    s.credentialRotator = rotator;
    s.selectedCredential = null;

    const pi = makeFakePi();
    registerCredentialExhaustion(pi as unknown as ExtensionAPI);
    pi.fire(assistantError("rate_limit_exceeded"));

    assert.equal(calls.length, 0);
  });

  test("s.active === false -> no-op even with rotator + selectedCredential + rate-limit signal", () => {
    const s = getForgeAutoSession();
    Object.assign(s, new ForgeAutoSession());
    s.active = false;
    const { rotator, calls } = makeFakeRotator();
    s.credentialRotator = rotator;
    s.selectedCredential = { provider: "claude-code", index: 0, identity: "refresh-token-A", token: 1 };

    const pi = makeFakePi();
    registerCredentialExhaustion(pi as unknown as ExtensionAPI);
    pi.fire(assistantError("rate_limit_exceeded"));

    assert.equal(calls.length, 0);
  });

  test("the handler never throws even when markExhausted itself throws", () => {
    const s = getForgeAutoSession();
    Object.assign(s, new ForgeAutoSession());
    s.active = true;
    s.currentRendezvousToken = 1;
    const { rotator, calls } = makeFakeRotator({ throwOnMarkExhausted: true });
    s.credentialRotator = rotator;
    s.selectedCredential = { provider: "claude-code", index: 0, identity: "refresh-token-A", token: 1 };

    const pi = makeFakePi();
    registerCredentialExhaustion(pi as unknown as ExtensionAPI);
    assert.doesNotThrow(() => pi.fire(assistantError("rate_limit_exceeded")));
    assert.equal(calls.length, 1, "markExhausted was still called once before it threw");
  });
});

/**
 * S01/T03 — exercises the `session_start` effort block of
 * `registerAutoUnitSetup` with a fake `pi` that records every thinking-level
 * call: application, host clamp observation (`getThinkingLevel` post-set),
 * token gating (MEM001/D16 — a stale hook never applies an older dispatch's
 * effort), byte-identity (no `pendingUnitEffort` → ZERO thinking-level calls),
 * one-shot baseline capture, and the failure-path honesty (applied stays null).
 * `pendingUnitModel` is left null throughout so the model block is inert —
 * the effort block runs regardless (it is a sibling, not nested).
 */

/** Fake `pi` for `session_start`: tools surface + thinking-level surface with
 *  call recording and an optional host-side clamp. */
function makeSessionStartFakePi(opts: {
  initialThinking: ThinkingLevel;
  clampTo?: ThinkingLevel;
  throwOnSet?: boolean;
}): {
  pi: ExtensionAPI;
  fire: () => Promise<void>;
  setCalls: ThinkingLevel[];
  getCalls: () => number;
  notifications: string[];
} {
  let handler: ((event: unknown, ctx: unknown) => Promise<void> | void) | null = null;
  let thinking: ThinkingLevel = opts.initialThinking;
  const setCalls: ThinkingLevel[] = [];
  let getCount = 0;
  const notifications: string[] = [];
  const pi = {
    on(event: string, h: (event: unknown, ctx: unknown) => Promise<void> | void) {
      if (event === "session_start") handler = h;
    },
    getActiveTools: () => ["read"],
    setActiveTools: (_tools: string[]) => {},
    getAllTools: () => [{ name: "read" }],
    getThinkingLevel: () => {
      getCount++;
      return thinking;
    },
    setThinkingLevel: (level: ThinkingLevel) => {
      setCalls.push(level);
      if (opts.throwOnSet) throw new Error("boom: setThinkingLevel failed");
      // The real host stores the EFFECTIVE (clamped) level — `clampTo`
      // simulates a model whose capabilities demote the request.
      thinking = opts.clampTo ?? level;
    },
    setModel: async () => true,
  } as unknown as ExtensionAPI;
  const ctx = {
    ui: { notify: (message: string, _level?: string) => notifications.push(message) },
    modelRegistry: { getAll: () => [] },
  };
  return {
    pi,
    fire: async () => {
      await handler?.({}, ctx);
    },
    setCalls,
    getCalls: () => getCount,
    notifications,
  };
}

/** Container primed for the effort block: loop active, unit pending, NO per-unit model. */
function primeEffortSession(pending: { level: "low" | "medium" | "high" | "xhigh" | "max"; reason: string } | null, token: number | null): ForgeAutoSession {
  const s = getForgeAutoSession();
  Object.assign(s, new ForgeAutoSession());
  s.active = true;
  s.pendingUnitType = "execute-task";
  s.pendingUnitModel = null;
  s.pendingUnitEffort = pending;
  s.pendingUnitEffortToken = token;
  // Live-at-delivery correlation: the driver arms the rendezvous token for
  // the dispatch whose newSession fires this hook (regression 4d7c8980 —
  // registration-frozen tokens were null forever in production).
  s.currentRendezvousToken = token;
  return s;
}

describe("registerAutoUnitSetup — S01/T03 session_start effort application", () => {
  test("(a) pending effort + matching token -> setThinkingLevel(requested) called once, applied published token-stamped, no clamp trail", async () => {
    const s = primeEffortSession({ level: "high", reason: "task-frontmatter" }, 7);
    const fake = makeSessionStartFakePi({ initialThinking: "off" });
    registerAutoUnitSetup(fake.pi);
    await fake.fire();

    assert.deepEqual(fake.setCalls, ["high"], "exactly one application, with the requested level");
    assert.equal(s.effortApplied, true);
    assert.deepEqual(s.appliedUnitEffort, { level: "high", clamped: null });
    assert.equal(s.appliedUnitEffortToken, 7, "applied is stamped with the dispatch's token");
    assert.equal(s.baselineThinkingLevel, "off", "interactive baseline captured before the application");
  });

  test("(b) host clamp observed: effective < requested -> applied carries the effective level and the clamp trail", async () => {
    const s = primeEffortSession({ level: "high", reason: "task-frontmatter" }, 7);
    const fake = makeSessionStartFakePi({ initialThinking: "off", clampTo: "medium" });
    registerAutoUnitSetup(fake.pi);
    await fake.fire();

    assert.deepEqual(fake.setCalls, ["high"], "the REQUESTED level is what gets set — the host does the demoting");
    assert.deepEqual(
      s.appliedUnitEffort,
      { level: "medium", clamped: "high→medium" },
      "applied records the effective post-clamp level plus the requested→effective trail (D-S01-3)",
    );
    assert.equal(s.appliedUnitEffortToken, 7);
  });

  test("(c) token mismatch (stale pending) -> NO thinking-level call, applied/baseline untouched", async () => {
    const s = primeEffortSession({ level: "high", reason: "task-frontmatter" }, 7);
    // A newer dispatch armed the rendezvous past the orphaned pending pair.
    s.currentRendezvousToken = 8;
    const fake = makeSessionStartFakePi({ initialThinking: "off" });
    registerAutoUnitSetup(fake.pi);
    await fake.fire();

    assert.equal(fake.setCalls.length, 0, "a stale dispatch's effort is never applied (MEM001/D16)");
    assert.equal(s.effortApplied, false);
    assert.equal(s.appliedUnitEffort, null);
    assert.equal(s.appliedUnitEffortToken, null);
    assert.equal(s.baselineThinkingLevel, null, "no baseline capture on the stale path");
  });

  test("(d) byte-identity: pendingUnitEffort null -> ZERO thinking-level calls of any kind", async () => {
    const s = primeEffortSession(null, 7);
    const fake = makeSessionStartFakePi({ initialThinking: "off" });
    registerAutoUnitSetup(fake.pi);
    await fake.fire();

    assert.equal(fake.setCalls.length, 0, "setThinkingLevel never called without effort config");
    assert.equal(fake.getCalls(), 0, "getThinkingLevel never called either — the block is fully inert");
    assert.equal(s.effortApplied, false);
    assert.equal(s.appliedUnitEffort, null);
    assert.equal(s.baselineThinkingLevel, null);
  });

  test("(e) baseline captured only on the FIRST application — a second unit's application never overwrites it", async () => {
    const s = primeEffortSession({ level: "high", reason: "task-frontmatter" }, 7);
    const fake = makeSessionStartFakePi({ initialThinking: "low" });
    registerAutoUnitSetup(fake.pi);
    await fake.fire();
    assert.equal(s.baselineThinkingLevel, "low");

    // Next unit: the first delivery CONSUMED the pending pair (one-shot
    // mailbox), so the driver re-arms both for the new dispatch. Live thinking
    // is now "high" (the previous application), but the captured baseline must
    // survive.
    s.pendingUnitEffort = { level: "medium", reason: "role-default:executor" };
    s.pendingUnitEffortToken = 8;
    s.currentRendezvousToken = 8;
    await fake.fire();

    assert.deepEqual(fake.setCalls, ["high", "medium"], "both units applied");
    assert.equal(s.baselineThinkingLevel, "low", "baseline still the INTERACTIVE level, not unit N's applied level");
    assert.deepEqual(s.appliedUnitEffort, { level: "medium", clamped: null });
  });

  test("failure path: setThinkingLevel throws -> warning notified, applied stays null (result never claims an effort it didn't get)", async () => {
    const s = primeEffortSession({ level: "high", reason: "task-frontmatter" }, 7);
    const fake = makeSessionStartFakePi({ initialThinking: "off", throwOnSet: true });
    registerAutoUnitSetup(fake.pi);
    await fake.fire();

    assert.equal(s.effortApplied, false, "nothing was applied");
    assert.equal(s.appliedUnitEffort, null);
    assert.equal(s.appliedUnitEffortToken, null);
    assert.ok(
      fake.notifications.some((n) => n.includes("esforço")),
      "operator warned about the failed effort application",
    );
  });
});
