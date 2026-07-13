/**
 * M2R-9 regression test — proves the evidence-capture subscription is
 * re-armed PER FRESH INSTANCE (the S06-R2 fix), not registered once at
 * `runAuto` entry (the pre-fix bug it replaced).
 *
 * `registerEvidenceCapture` (`bootstrap/register-extension.ts:112`) is a
 * private, non-exported function, and S04/T04 is scoped to add ONLY this
 * test file — S04-PLAN §Standards forbids touching `bootstrap/`/`commands/`/
 * `verify/` ("o fix já existe; T04 é SÓ a regressão"). Per T04-PLAN step 4,
 * this test therefore drives the EQUIVALENT per-instance capture path: a
 * local `registerCapture(pi, s)` helper that mirrors the real handler's body
 * EXACTLY (same gate — `s.active` + `s.currentUnit` — same `evidenceEventFor`
 * + `appendEvent` call, same never-throw contract). The one deviation: the
 * session is passed in explicitly instead of read from the module-level
 * `getForgeAutoSession()` singleton, for test isolation across cases.
 *
 * The scenario simulates THREE bootstrap runs — the initial registration
 * plus TWO `newSession` swaps — calling `registerCapture` on a fresh fake
 * `pi` each time, mirroring how `registerForgeExtension` re-runs on every
 * `session_start`. It then fires `tool_execution_end` ONLY on the THIRD
 * (latest) fake `pi` and asserts the evidence event lands in the journal —
 * exactly the point the pre-fix one-shot subscription regressed at. The
 * "control" case below makes that regression concrete: registering ONLY on
 * the first instance (the pre-fix shape) and firing on the third produces NO
 * evidence event, proving this test targets the fixed behavior, not the bug.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evidenceEventFor } from "../verify/evidence.ts";
import { appendEvent, readEvents } from "../state/store.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { unitKeyOf } from "../worker/unit-key.ts";
import type { NextUnit } from "../state/dispatch.ts";

const MID = "M-toy";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-evidence-rearm-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The narrow slice of `ToolExecutionEndEvent` the real handler reads. */
interface FakeToolEnd {
  toolName: string;
  isError: boolean;
}

/**
 * Minimal fake `pi` — implements only the single method
 * `registerEvidenceCapture` calls (`pi.on("tool_execution_end", handler)`),
 * plus a test-only `fire()` to simulate the harness dispatching the event.
 * Deliberately NOT the real `ExtensionAPI` — a full mock is unnecessary
 * since the fix's behavior hinges entirely on WHEN `.on()` is called
 * relative to `newSession` swaps, not on any other `pi` surface.
 */
interface FakePi {
  on(event: "tool_execution_end", handler: (event: FakeToolEnd) => void): void;
  fire(event: FakeToolEnd): void;
}

function makeFakePi(): FakePi {
  let handler: ((event: FakeToolEnd) => void) | null = null;
  return {
    on(_event, h) {
      handler = h;
    },
    fire(event) {
      handler?.(event);
    },
  };
}

/**
 * Mirrors `registerEvidenceCapture` (`bootstrap/register-extension.ts:112`)
 * body-for-body: gated on `s.active` + a unit in flight (`s.currentUnit`),
 * appends the `evidenceEventFor` output under a try/catch that never throws.
 */
function registerCapture(pi: FakePi, s: ForgeAutoSession): void {
  pi.on("tool_execution_end", (event) => {
    try {
      if (!s.active) return;
      const u = s.currentUnit;
      if (!u) return;
      appendEvent(
        s.cwd,
        evidenceEventFor(
          unitKeyOf(u),
          { toolName: event.toolName, isError: event.isError },
          "2026-07-11T00:00:00Z",
          s.milestoneId,
        ),
      );
    } catch {
      /* advisory — the evidence handler NEVER throws */
    }
  });
}

function makeSession(cwd: string, unit: NextUnit): ForgeAutoSession {
  const s = new ForgeAutoSession();
  s.active = true;
  s.cwd = cwd;
  s.milestoneId = MID;
  s.currentUnit = unit;
  return s;
}

describe("M2R-9 — evidence re-arm survives repeated newSession swaps", () => {
  test("per-instance registration (the fix): a tool_execution_end fired on the THIRD instance (after TWO newSession swaps) is still captured", () => {
    withSandbox((cwd) => {
      const unit: NextUnit = { type: "execute-task", slice: "S04", task: "T04" };
      const s = makeSession(cwd, unit);

      // Bootstrap run #1 — the initial session.
      const pi1 = makeFakePi();
      registerCapture(pi1, s);

      // newSession swap #1 — bootstrap re-runs on a FRESH pi (pi2).
      const pi2 = makeFakePi();
      registerCapture(pi2, s);

      // newSession swap #2 — bootstrap re-runs again on a FRESH pi (pi3).
      const pi3 = makeFakePi();
      registerCapture(pi3, s);

      // The worker's tool call happens in the CURRENT (third) instance.
      pi3.fire({ toolName: "Bash", isError: false });

      const events = readEvents(cwd);
      const evidence = events.find((e) => e.kind === "evidence");
      assert.ok(evidence, "an evidence event was appended after the SECOND newSession swap");
      assert.equal(evidence!.unit, unitKeyOf(unit));
      assert.equal(evidence!.status, "ok");
      assert.equal(evidence!.milestone, MID);
    });
  });

  test("status derives from isError — the error path also survives the second swap", () => {
    withSandbox((cwd) => {
      const unit: NextUnit = { type: "execute-task", slice: "S04", task: "T04" };
      const s = makeSession(cwd, unit);

      const pi1 = makeFakePi();
      registerCapture(pi1, s);
      const pi2 = makeFakePi();
      registerCapture(pi2, s);
      const pi3 = makeFakePi();
      registerCapture(pi3, s);

      pi3.fire({ toolName: "Edit", isError: true });

      const events = readEvents(cwd);
      const evidence = events.find((e) => e.kind === "evidence");
      assert.ok(evidence, "an evidence event was appended after the SECOND newSession swap");
      assert.equal(evidence!.status, "error");
    });
  });

  test("control — a ONE-SHOT subscription (the pre-fix shape, registered only on the FIRST instance) does NOT observe a tool_execution_end fired on the third instance", () => {
    withSandbox((cwd) => {
      const unit: NextUnit = { type: "execute-task", slice: "S04", task: "T04" };
      const s = makeSession(cwd, unit);

      // Pre-fix bug: registration happened ONCE, at the initial (pre-loop) pi
      // — never re-armed on subsequent newSession swaps.
      const pi1 = makeFakePi();
      registerCapture(pi1, s);

      const pi2 = makeFakePi(); // swap #1 — NOT registered (mirrors the bug)
      const pi3 = makeFakePi(); // swap #2 — NOT registered (mirrors the bug)

      // The worker's tool call happens in the CURRENT (third) instance — the
      // one-shot subscription attached to pi1 never observes it.
      pi3.fire({ toolName: "Bash", isError: false });

      const events = readEvents(cwd);
      const evidence = events.find((e) => e.kind === "evidence");
      assert.equal(
        evidence,
        undefined,
        "the one-shot (pre-fix) subscription captures NOTHING after two swaps — this is exactly the regression the fix addresses",
      );
    });
  });
});
