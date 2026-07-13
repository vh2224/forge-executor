import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchUnitViaNewSession } from "../auto/driver.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import type { NextUnit } from "../state/index.ts";

/**
 * R1 (M2/S02 review) — driver-level regression for the S04-R2 ↔ M1 R1 collision.
 *
 * M1 R1 gave the driver a fast-pause: when the worker turn (`freshCtx.sendMessage`)
 * throws, `newSession` REJECTS and the driver synthesizes a `blocked` outcome
 * immediately instead of hanging on the un-timed rendezvous until the wall-clock
 * ceiling. S04-R2 later made `finishSessionReplacement`/`newSession` SWALLOW that
 * error (so a failing callback never aborts a committed replacement) — which
 * silently defeated the fast-pause: `newSession` always resolved, so the driver
 * kept waiting for a `forge_unit_result` the failed worker never delivers.
 *
 * The R1 fix reconciles both: forge-agent-core now COMMITS the replacement and
 * THEN re-throws the callback error, so `newSession` rejects AFTER the session is
 * consistent — restoring this driver contract. This test pins the driver side of
 * that contract: given a `newSession` that rejects (the R1-fixed forge-agent-core
 * behavior), the driver must produce a fast synthetic `blocked` (reason
 * `worker_turn_error`) well under the wall-clock ceiling.
 *
 * The forge-agent-core change itself is proven by typecheck (its node:test runner
 * was removed with resolve-ts.mjs — see S02-REVIEW-FIX-SUMMARY); this driver-level
 * test proves the integration contract R1 restores.
 */

describe("driver fast-pause on a rejecting newSession (R1)", () => {
  test("a worker-turn error that rejects newSession → fast synthetic blocked, not a ceiling wait", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    // A large ceiling: if the driver ever WAITED for the timeout instead of
    // fast-pausing, this test would take ~30s. It must return in a few ms.
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-fast-pause-"));

    try {
      const s = new ForgeAutoSession();
      s.cwd = cwd;

      // Fake cmdCtx whose `newSession` mimics the R1-FIXED forge-agent-core:
      // it commits the replacement, runs `withSession`, and RE-THROWS on failure
      // (instead of the old S04-R2 swallow). The driver's own `withSession`
      // re-points `s.cmdCtx` at the fresh ctx and calls `sendMessage`, which here
      // throws to simulate a transient worker-turn failure.
      const freshCtx = {
        abort() {},
        async sendMessage(): Promise<void> {
          throw new Error("boom: worker turn failed inside sendMessage");
        },
      };
      const cmdCtx = {
        abort() {},
        model: undefined,
        async newSession(opts: {
          withSession: (ctx: unknown) => Promise<void>;
        }): Promise<{ cancelled: boolean }> {
          let failure: { error: unknown } | undefined;
          try {
            await opts.withSession(freshCtx);
          } catch (error) {
            failure = { error };
          }
          // R1 invariant: commit is done; propagate the callback error so the
          // driver's fast-pause catch is reachable.
          if (failure) throw failure.error;
          return { cancelled: false };
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = cmdCtx as any;

      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };

      const started = Date.now();
      const outcome = await dispatchUnitViaNewSession(s, unit, "prompt");
      const elapsed = Date.now() - started;

      assert.equal(outcome.kind, "result", "a rejecting newSession must resolve a synthetic result");
      if (outcome.kind === "result") {
        assert.equal(outcome.result.status, "blocked", "the synthetic outcome must be a blocked pause");
        assert.equal(
          outcome.result.reason,
          "worker_turn_error",
          "the fast-pause must be tagged worker_turn_error (M1 R1)",
        );
      }
      assert.ok(
        elapsed < 5000,
        `fast-pause must resolve well under the 30s ceiling (took ${elapsed}ms) — a slow result means newSession swallowed the error again`,
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
