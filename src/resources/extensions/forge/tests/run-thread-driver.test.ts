import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { dispatchUnitViaNewSession } from "../auto/driver.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { runAuto } from "../commands/forge-command.ts";
import type { NextUnit } from "../state/index.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";

const UNIT: NextUnit = { type: "execute-task", slice: "S02", task: "T01" };

function commandContext(s: ForgeAutoSession, captured: Array<Record<string, unknown>>) {
  const freshCtx = {
    abort() {},
    async sendMessage(): Promise<void> {
      deliverUnitResult({ status: "done", summary: "done", artifacts: [] }, s.currentRendezvousToken ?? undefined);
    },
  };
  return {
    abort() {},
    model: undefined,
    async newSession(opts: Record<string, unknown> & { withSession: (ctx: unknown) => Promise<void> }) {
      captured.push(opts);
      await opts.withSession(freshCtx);
      return { cancelled: false };
    },
  };
}

describe("driver: run-root parent session threading (S02/T01)", () => {
  test("passes the captured run root as parentSession", async () => {
    const s = new ForgeAutoSession();
    s.cwd = mkdtempSync(join(tmpdir(), "forge-run-thread-"));
    const captured: Array<Record<string, unknown>> = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = commandContext(s, captured) as any;
      s.runRootSessionPath = "/tmp/operator-root.jsonl";

      await dispatchUnitViaNewSession(s, UNIT, "prompt");

      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.parentSession, "/tmp/operator-root.jsonl");
    } finally {
      rmSync(s.cwd, { recursive: true, force: true });
    }
  });

  test("keeps the previous newSession shape when no persisted root is available", async () => {
    const s = new ForgeAutoSession();
    s.cwd = mkdtempSync(join(tmpdir(), "forge-run-thread-"));
    const captured: Array<Record<string, unknown>> = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = commandContext(s, captured) as any;

      await dispatchUnitViaNewSession(s, UNIT, "prompt");

      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.parentSession, undefined);
    } finally {
      rmSync(s.cwd, { recursive: true, force: true });
    }
  });

  test("reset clears the root and each auto bootstrap overwrites it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-run-thread-"));
    const stateDir = join(cwd, ".gsd");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "STATE.md"), "```yaml\nmilestone: M-test\nunits: []\n```\n");
    const s = new ForgeAutoSession();
    const roots = ["/tmp/first.jsonl", "/tmp/second.jsonl"];
    try {
      for (const root of roots) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = {
          cwd,
          model: undefined,
          ui: { notify() {} },
          sessionManager: { getSessionFile: () => root },
        } as any;
        await runAuto(ctx, { once: true }, s, async (activeSession) => {
          assert.equal(activeSession.runRootSessionPath, root);
          return { reason: "complete" };
        });
        assert.equal(s.runRootSessionPath, null, "run cleanup delegates to reset()");
      }

      s.runRootSessionPath = "/tmp/stale.jsonl";
      s.reset();
      assert.equal(s.runRootSessionPath, null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
