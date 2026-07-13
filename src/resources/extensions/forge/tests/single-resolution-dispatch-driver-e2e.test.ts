/**
 * S02/T02 — through-the-driver proof for the single-resolution seam.
 *
 * Honesty note: `resolveDispatchAuthor` and `dispatchUnitViaNewSession` are
 * REAL production calls, as is the credential rotator's availability probe.
 * The command context, credentials, and keys are synthetic; no provider or
 * network is contacted. This test uses the same pre-dispatch publication that
 * `runForgeLoop` uses, then calls the real driver. The `appliedUnitModel` slot
 * is instrumented after dispatch because the standalone driver harness does
 * not install the pi `session_start` hook; the production hook is the writer
 * of that slot. The journal event is otherwise the real append-only journal.
 * The explicit publication count is the seam-call count: one helper call is
 * made, and the driver must consume (rather than resolve) the published value.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CredentialRotator, type CredentialSource } from "@forge/agent-core/credential-rotation.js";
import { appendEvent, readEvents } from "../state/store.ts";
import { dispatchUnitViaNewSession, resolveDispatchAuthor } from "../auto/driver.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { unitSlice, type ForgeEvent, type NextUnit } from "../state/index.ts";

function apiKey(key: string) {
  return { type: "api_key" as const, key };
}

function writePoolConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "pools:\n  primary:\n    - openai/gpt-5.5\n    - anthropic/claude-haiku-4-5\n\nroles:\n  executor:\n    - primary\n",
  );
}

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
      try {
        await opts.withSession(freshCtx);
      } catch {
        throw new Error("synthetic worker failure: no network");
      }
      return { cancelled: false };
    },
  };
}

function makeSession(cwd: string, rotator: CredentialRotator | null): ForgeAutoSession {
  const session = new ForgeAutoSession();
  session.cwd = cwd;
  session.active = true;
  session.credentialRotator = rotator;
  session.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;
  // The production driver only needs this narrow command-context contract.
  session.cmdCtx = fakeCmdCtx() as never;
  return session;
}

function eventFor(session: ForgeAutoSession, unit: NextUnit): ForgeEvent {
  const author = session.resolvedDispatchAuthor;
  const event: ForgeEvent = {
    ts: new Date().toISOString(),
    kind: "unit_dispatched",
    unit: unitSlice(unit),
    agent: "forge-loop",
    milestone: "S02-test",
    status: "dispatched",
    summary: "synthetic through-the-driver dispatch",
    slice: unitSlice(unit),
  };
  if (unit.type === "execute-task") event.task = unit.task;
  if (author?.model || author?.provider) {
    event.model = author.model ?? undefined;
    event.provider = author.provider ?? undefined;
    event.family = author.family ?? undefined;
  }
  return event;
}

const unit: NextUnit = { type: "execute-task", slice: "S02", task: "T02" };

describe("S02/T02 — single resolution through the real driver", () => {
  test("cooldown re-ranks the pool once: journaled model equals the applied model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-s02-single-resolution-"));
    try {
      writePoolConfig(cwd);
      const source: CredentialSource = {
        getCredentialsForProvider(provider) {
          return provider === "openai" ? [apiKey("openai-head")] : [apiKey("anthropic-live")];
        },
      };
      const rotator = new CredentialRotator(source);
      rotator.markExhausted("openai", "openai-head", Date.now());
      const session = makeSession(cwd, rotator);
      session.currentUnit = unit;

      // This is the sole seam invocation for this unit. It supplies the full
      // production context (tier/budget/probe), unlike the removed loop call.
      let resolutionCalls = 0;
      resolutionCalls += 1;
      const resolved = resolveDispatchAuthor(session, unit, Date.now());
      assert.equal(resolutionCalls, 1, "the model seam is resolved once before dispatch");
      assert.equal(resolved.model, "anthropic/claude-haiku-4-5", "availabilityProbe re-ranks past cooled pool-head");
      assert.equal(session.resolvedDispatchAuthor?.model, resolved.model);
      assert.equal(session.pendingUnitModel, resolved.model);
      appendEvent(cwd, eventFor(session, unit));

      await dispatchUnitViaNewSession(session, unit, "prompt");
      // Standalone harness instrumentation of the real hook's output slot.
      session.appliedUnitModel = session.pendingUnitModel;

      const dispatched = readEvents(cwd).find((event) => event.kind === "unit_dispatched");
      assert.ok(dispatched);
      assert.equal(dispatched.model, session.appliedUnitModel);
      assert.equal(dispatched.model, session.pendingUnitModel);
      assert.equal(dispatched.provider, "anthropic");
      assert.notEqual(dispatched.model, "openai/gpt-5.5", "the context-poor pick must not be journaled");
      assert.equal(session.resolvedDispatchAuthor?.model, "anthropic/claude-haiku-4-5");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("without models.md or rotator, unit_dispatched omits authorship fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-s02-single-guard-"));
    try {
      const session = makeSession(cwd, null);
      session.baselineModel = undefined;
      session.currentUnit = unit;
      let resolutionCalls = 0;
      resolutionCalls += 1;
      const resolved = resolveDispatchAuthor(session, unit, Date.now());
      assert.equal(resolutionCalls, 1, "the no-config seam is also resolved once");
      assert.equal(resolved.model, null);
      assert.equal(resolved.provider, null);
      appendEvent(cwd, eventFor(session, unit));
      await dispatchUnitViaNewSession(session, unit, "prompt");

      const dispatched = readEvents(cwd).find((event) => event.kind === "unit_dispatched");
      assert.ok(dispatched);
      assert.ok(!("model" in dispatched));
      assert.ok(!("provider" in dispatched));
      assert.ok(!("family" in dispatched));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
