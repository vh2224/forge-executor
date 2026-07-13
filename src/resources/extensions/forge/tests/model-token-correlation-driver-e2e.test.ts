/**
 * S01/T03 (rewritten pós-regressão 4d7c8980) — through-the-driver proof for
 * model epoch correlation, against the REAL registration topology.
 *
 * The original version of this test fabricated a fiction: one pi per
 * dispatch, each registered with the correct token passed BY THE TEST. In
 * production the bootstrap runs ONCE per runtime build (same-cwd `newSession`
 * never re-runs it), so a registration-frozen token is `null` forever and the
 * frozen-token hook NEVER applied a per-unit model — every worker ran the
 * session default while the journal recorded the resolution (caught live
 * 2026-07-12). This rewrite registers ONE pi BEFORE any dispatch (token null
 * at registration — the exact production shape) and proves live-at-delivery
 * correlation + consume-once:
 *   1. boot-registered hook still applies the armed dispatch's model;
 *   2. a second (non-dispatch) session_start applies nothing — the pending
 *      pair was consumed;
 *   3. a later dispatch re-arms and applies its own model with its own token.
 *
 * Both dispatches cross the REAL `dispatchUnitViaNewSession`. The pi handle,
 * command context, model registry, and model objects are fake/instrumented;
 * no provider or network is contacted. Runs against compiled output through
 * `scripts/dist-test-resolve.mjs` after `pnpm run test:compile`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { dispatchUnitViaNewSession } from "../auto/driver.ts";
import { ForgeAutoSession, getForgeAutoSession } from "../auto/session.ts";
import type { NextUnit } from "../state/index.ts";
import { registerAutoUnitSetup } from "../bootstrap/register-extension.ts";

function fakeCmdCtx() {
  const freshCtx = {
    abort() {},
    async sendMessage(): Promise<void> {
      throw new Error("synthetic worker failure: no network");
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

function writeExecutorModelConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "pools:\n  primary:\n    - openai/gpt-5.5\n\nroles:\n  executor:\n    - primary\n",
  );
}

function makeSession(cwd: string): ForgeAutoSession {
  const session = getForgeAutoSession();
  Object.assign(session, new ForgeAutoSession());
  session.cwd = cwd;
  session.active = true;
  session.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;
  session.cmdCtx = fakeCmdCtx() as never;
  return session;
}

interface FakePi {
  on(event: "session_start", handler: (event: unknown, ctx: unknown) => Promise<void>): void;
  fire(ctx: unknown): Promise<void>;
  setModel(model: unknown): Promise<void>;
  setActiveTools(tools: string[]): void;
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string }>;
}

function makeFakePi(): { pi: FakePi; setModelCalls: unknown[] } {
  let handler: ((event: unknown, ctx: unknown) => Promise<void>) | null = null;
  const setModelCalls: unknown[] = [];
  const pi: FakePi = {
    on(_event, registered) {
      handler = registered;
    },
    async fire(ctx) {
      assert.ok(handler, "session_start hook must be registered");
      await handler?.({}, ctx);
    },
    async setModel(model) {
      setModelCalls.push(model);
    },
    setActiveTools(_tools) {},
    getActiveTools() {
      return ["read", "write", "edit", "bash"];
    },
    getAllTools() {
      return [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }];
    },
  };
  return { pi, setModelCalls };
}

function hookContext() {
  return {
    modelRegistry: {
      getAll() {
        return [{ provider: "openai", id: "gpt-5.5" }];
      },
    },
    ui: { notify(_message: string, _level: string) {} },
  };
}

const unitA: NextUnit = { type: "execute-task", slice: "S01", task: "T03-A" };
const unitB: NextUnit = { type: "execute-task", slice: "S01", task: "T03-B" };

describe("model token correlation through the driver (S01/T03)", () => {
  test("boot-registered hook applies per-unit models live-at-delivery, consume-once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-s01-model-token-"));
    try {
      writeExecutorModelConfig(cwd);
      const session = makeSession(cwd);

      // PRODUCTION SHAPE (regression 4d7c8980): registration happens at boot,
      // BEFORE any dispatch — currentRendezvousToken is null right now. A
      // token frozen here would be null forever and no model would ever apply.
      const { pi, setModelCalls } = makeFakePi();
      registerAutoUnitSetup(pi as unknown as ExtensionAPI);

      // Dispatch A arms pending model + rendezvous token; its session_start
      // (fired synchronously inside the replacement) must apply A's model.
      await dispatchUnitViaNewSession(session, unitA, "prompt A");
      const tokenA = session.pendingUnitModelToken;
      const modelA = session.pendingUnitModel;
      assert.equal(typeof tokenA, "number");
      assert.ok(modelA, "dispatch A publishes its per-unit model");

      await pi.fire(hookContext());
      assert.equal(setModelCalls.length, 1, "boot-registered hook MUST apply the armed model");
      assert.deepEqual(setModelCalls.at(-1), { provider: "openai", id: "gpt-5.5" });
      assert.equal(session.appliedUnitModel, modelA);
      assert.equal(session.appliedUnitModelToken, tokenA);
      assert.equal(session.modelApplied, true);
      assert.equal(session.pendingUnitModel, null, "pending consumed after one delivery");
      assert.equal(session.pendingUnitModelToken, null);

      // A spurious session_start between dispatches (an on-demand review
      // session, a manual new session) finds nothing to apply.
      await pi.fire(hookContext());
      assert.equal(setModelCalls.length, 1, "consumed mailbox: nothing re-applies");

      // Dispatch B re-arms with a NEW token; the same boot registration
      // applies B's model stamped with B's token.
      await dispatchUnitViaNewSession(session, unitB, "prompt B");
      const tokenB = session.pendingUnitModelToken;
      const modelB = session.pendingUnitModel;
      assert.equal(typeof tokenB, "number");
      assert.notEqual(tokenB, tokenA);
      assert.equal(session.currentRendezvousToken, tokenB);
      assert.ok(modelB);

      await pi.fire(hookContext());
      assert.equal(setModelCalls.length, 2);
      assert.equal(session.appliedUnitModel, modelB);
      assert.equal(session.appliedUnitModelToken, tokenB);

      // This is the RESULT reader's production gate: only the current epoch is read.
      session.appliedUnitModelToken = tokenA;
      const staleRead = session.appliedUnitModelToken === session.currentRendezvousToken
        ? session.appliedUnitModel
        : null;
      assert.equal(staleRead, null, "RESULT must reject an applied model from A");
      session.appliedUnitModelToken = tokenB;
      const currentRead = session.appliedUnitModelToken === session.currentRendezvousToken
        ? session.appliedUnitModel
        : null;
      assert.equal(currentRead, modelB, "RESULT must consume B's matching authorship");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an orphaned pending from a superseded arm never applies (token mismatch)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-s01-model-token-"));
    try {
      writeExecutorModelConfig(cwd);
      const session = makeSession(cwd);
      const { pi, setModelCalls } = makeFakePi();
      registerAutoUnitSetup(pi as unknown as ExtensionAPI);

      await dispatchUnitViaNewSession(session, unitA, "prompt A");
      // Simulate a newer arm superseding the orphaned pending pair (the
      // driver re-arms the rendezvous but this pending belongs to the old one).
      session.currentRendezvousToken = (session.pendingUnitModelToken ?? 0) + 1000;

      await pi.fire(hookContext());
      assert.equal(setModelCalls.length, 0, "orphaned pending must never apply");
      assert.equal(session.appliedUnitModel, null);
      assert.equal(session.appliedUnitModelToken, null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
