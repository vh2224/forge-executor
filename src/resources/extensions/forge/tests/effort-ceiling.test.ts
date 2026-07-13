/**
 * `auto/effort-ceiling.ts` unit suite (S09/T03) — proves `observedEffortCeilings`
 * scans `.gsd/forge/events.jsonl` best-effort (empty journal, missing file,
 * corrupted line, events with no usable `effort_clamped`/ref all degrade to
 * "no observation" rather than throwing), that the MOST RECENT clamp per ref
 * wins, and that `effortCeilingFor` is a pure lookup over the resulting map.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../state/store.ts";
import type { ForgeEvent } from "../state/types.ts";
import { observedEffortCeilings, effortCeilingFor } from "../auto/effort-ceiling.ts";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-effort-ceiling-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Minimal well-formed journal line, overridable per test. */
function ev(overrides: Partial<ForgeEvent>): ForgeEvent {
  return {
    ts: new Date().toISOString(),
    unit: "S01/T01",
    agent: "forge-loop",
    milestone: "M-toy",
    status: "done",
    summary: "toy",
    ...overrides,
  };
}

describe("observedEffortCeilings — absence degrades to empty, never throws", () => {
  test("no journal file at all (never dispatched)", () => {
    withSandbox((cwd) => {
      const ceilings = observedEffortCeilings(cwd);
      assert.equal(ceilings.size, 0);
    });
  });

  test("journal exists but has zero effort_clamped events", () => {
    withSandbox((cwd) => {
      appendEvent(cwd, ev({ kind: "unit_result", model: "claude-code/claude-sonnet-5" }));
      const ceilings = observedEffortCeilings(cwd);
      assert.equal(ceilings.size, 0);
    });
  });

  test("corrupted jsonl (torn/garbage line) degrades to empty, never throws", () => {
    withSandbox((cwd) => {
      const journalDir = join(cwd, ".gsd", "forge");
      mkdirSync(journalDir, { recursive: true });
      writeFileSync(join(journalDir, "events.jsonl"), "{not valid json at all\n");
      assert.doesNotThrow(() => observedEffortCeilings(cwd));
      assert.equal(observedEffortCeilings(cwd).size, 0);
    });
  });

  test("one valid line survives alongside a torn trailing line", () => {
    withSandbox((cwd) => {
      appendEvent(
        cwd,
        ev({
          kind: "unit_result",
          model: "claude-code/claude-sonnet-5",
          effort_clamped: "xhigh→high",
        }),
      );
      const journalDir = join(cwd, ".gsd", "forge");
      appendFileSync(join(journalDir, "events.jsonl"), "{torn\n");
      const ceilings = observedEffortCeilings(cwd);
      assert.equal(ceilings.get("claude-code/claude-sonnet-5"), "high");
    });
  });
});

describe("observedEffortCeilings — recording discipline", () => {
  test("records the clamp's EFFECTIVE (post-arrow) half, keyed by model ref", () => {
    withSandbox((cwd) => {
      appendEvent(
        cwd,
        ev({
          kind: "unit_result",
          model: "claude-code/claude-sonnet-5",
          effort_clamped: "high→medium",
        }),
      );
      const ceilings = observedEffortCeilings(cwd);
      assert.equal(ceilings.get("claude-code/claude-sonnet-5"), "medium");
    });
  });

  test("falls back to `provider` when `model` is absent", () => {
    withSandbox((cwd) => {
      appendEvent(
        cwd,
        ev({ kind: "unit_result", provider: "openai-codex", effort_clamped: "xhigh→low" }),
      );
      const ceilings = observedEffortCeilings(cwd);
      assert.equal(ceilings.get("openai-codex"), "low");
    });
  });

  test("the MOST RECENT (last in append order) clamp per ref wins", () => {
    withSandbox((cwd) => {
      appendEvent(
        cwd,
        ev({ model: "claude-code/claude-sonnet-5", effort_clamped: "high→medium" }),
      );
      appendEvent(
        cwd,
        ev({ model: "claude-code/claude-sonnet-5", effort_clamped: "xhigh→high" }),
      );
      const ceilings = observedEffortCeilings(cwd);
      assert.equal(ceilings.get("claude-code/claude-sonnet-5"), "high");
    });
  });

  test("an event with effort_clamped but no model AND no provider is skipped (no fabricated ref)", () => {
    withSandbox((cwd) => {
      appendEvent(cwd, ev({ effort_clamped: "high→medium" }));
      assert.equal(observedEffortCeilings(cwd).size, 0);
    });
  });

  test("a malformed clamp string with no arrow is skipped", () => {
    withSandbox((cwd) => {
      appendEvent(
        cwd,
        ev({ model: "claude-code/claude-sonnet-5", effort_clamped: "garbage" }),
      );
      assert.equal(observedEffortCeilings(cwd).size, 0);
    });
  });

  test("an effective half outside the EffortLevel vocabulary (e.g. 'minimal') is skipped — no fabricated ceiling", () => {
    withSandbox((cwd) => {
      appendEvent(
        cwd,
        ev({ model: "claude-code/claude-sonnet-5", effort_clamped: "low→minimal" }),
      );
      assert.equal(observedEffortCeilings(cwd).size, 0);
    });
  });

  test("distinct refs each get their own entry", () => {
    withSandbox((cwd) => {
      appendEvent(cwd, ev({ model: "claude-code/claude-sonnet-5", effort_clamped: "high→medium" }));
      appendEvent(cwd, ev({ model: "openai-codex/gpt-5.6-terra", effort_clamped: "xhigh→high" }));
      const ceilings = observedEffortCeilings(cwd);
      assert.equal(ceilings.size, 2);
      assert.equal(ceilings.get("claude-code/claude-sonnet-5"), "medium");
      assert.equal(ceilings.get("openai-codex/gpt-5.6-terra"), "high");
    });
  });
});

describe("effortCeilingFor — pure lookup", () => {
  test("returns the observed level for a known ref", () => {
    const ceilings = new Map([["claude-code/claude-sonnet-5", "medium" as const]]);
    assert.equal(effortCeilingFor(ceilings, "claude-code/claude-sonnet-5"), "medium");
  });

  test("returns undefined for a ref with no observation — never invents a penalty", () => {
    const ceilings = new Map([["claude-code/claude-sonnet-5", "medium" as const]]);
    assert.equal(effortCeilingFor(ceilings, "openai-codex/gpt-5.6-terra"), undefined);
  });

  test("returns undefined against an empty map", () => {
    assert.equal(effortCeilingFor(new Map(), "anything/anywhere"), undefined);
  });
});
