import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerAutoUnitSetup } from "../bootstrap/register-extension.ts";
import { ForgeAutoSession, getForgeAutoSession } from "../auto/session.ts";

type FakeModel = { provider: string; id: string };

interface FakePi {
  on(event: "session_start", handler: (event: unknown, ctx: unknown) => Promise<void>): void;
  fire(ctx: unknown): Promise<void>;
  setModel(model: unknown): Promise<void>;
  setActiveTools(tools: string[]): void;
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string }>;
}

function makePi(): { pi: FakePi; applied: unknown[] } {
  let handler: ((event: unknown, ctx: unknown) => Promise<void>) | null = null;
  const applied: unknown[] = [];
  const pi: FakePi = {
    on(_event, registered) {
      handler = registered;
    },
    async fire(ctx) {
      assert.ok(handler, "session_start hook must be registered");
      await handler?.({}, ctx);
    },
    async setModel(model) {
      applied.push(model);
    },
    setActiveTools() {},
    getActiveTools() {
      return ["read"];
    },
    getAllTools() {
      return [{ name: "read" }];
    },
  };
  return { pi, applied };
}

function prepareSession(reference: string, token = 7): ForgeAutoSession {
  const session = getForgeAutoSession();
  Object.assign(session, new ForgeAutoSession());
  session.active = true;
  session.pendingUnitType = "execute-task";
  session.pendingUnitModel = reference;
  session.pendingUnitModelToken = token;
  session.currentRendezvousToken = token;
  return session;
}

function context(models: FakeModel[], notices: string[] = []) {
  return {
    modelRegistry: { getAll: () => models },
    ui: { notify(message: string) { notices.push(message); } },
  };
}

const luna: FakeModel = { provider: "openai", id: "gpt-5.6-luna" };

describe("registerAutoUnitSetup model reference resolution", () => {
  test("resolves a bare model id and applies it", async () => {
    const session = prepareSession("gpt-5.6-luna");
    const { pi, applied } = makePi();
    registerAutoUnitSetup(pi as unknown as ExtensionAPI);

    await pi.fire(context([luna]));

    assert.deepEqual(applied, [luna]);
    assert.equal(session.appliedUnitModel, "gpt-5.6-luna");
    assert.equal(session.appliedUnitModelToken, 7);
  });

  test("continues to resolve the canonical provider/id reference", async () => {
    const session = prepareSession("openai/gpt-5.6-luna");
    const { pi, applied } = makePi();
    registerAutoUnitSetup(pi as unknown as ExtensionAPI);

    await pi.fire(context([luna]));

    assert.deepEqual(applied, [luna]);
    assert.equal(session.appliedUnitModel, "openai/gpt-5.6-luna");
  });

  test("does not apply an ambiguous bare id or claim authorship", async () => {
    const session = prepareSession("gpt-5.6-luna");
    const notices: string[] = [];
    const { pi, applied } = makePi();
    registerAutoUnitSetup(pi as unknown as ExtensionAPI);

    await pi.fire(context([luna, { provider: "azure", id: "gpt-5.6-luna" }], notices));

    assert.equal(applied.length, 0);
    assert.equal(session.appliedUnitModel, null);
    assert.equal(session.appliedUnitModelToken, null);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /não encontrado/);
  });

  test("ignores an orphaned pending pair from a superseded arm", async () => {
    const session = prepareSession("gpt-5.6-luna", 8);
    // A newer dispatch re-armed the rendezvous past this pending pair.
    session.currentRendezvousToken = 9;
    const { pi, applied } = makePi();
    registerAutoUnitSetup(pi as unknown as ExtensionAPI);

    await pi.fire(context([luna]));

    assert.equal(applied.length, 0);
    assert.equal(session.appliedUnitModel, null);
    assert.equal(session.appliedUnitModelToken, null);
  });
});
