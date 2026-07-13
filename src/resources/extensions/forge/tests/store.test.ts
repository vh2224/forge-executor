import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, updateState, appendEvent, readEvents } from "../state/store.ts";
import type { StateDoc, ForgeEvent } from "../state/types.ts";

// Every filesystem test runs inside a fresh mkdtemp sandbox as `cwd`. The store
// resolves `<cwd>/.gsd/STATE.md`, so nothing here can ever touch the live repo
// `.gsd/` (which is runtime state of the forge 1.0 orchestrator managing this
// work — writing to it would corrupt live state).
function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-store-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── updateState — atomic write + round-trip through disk ─────────────────────

describe("updateState", () => {
  test("creates STATE.md and round-trips the written doc through disk", () => {
    withSandbox((cwd) => {
      const written = updateState(cwd, () => ({
        milestone: "M-1",
        phase: "execute",
        current_slice: "S02",
        next_action: "Run T04 gate",
      }));

      const path = join(cwd, ".gsd", "STATE.md");
      assert.ok(existsSync(path), "STATE.md exists after updateState");

      const reread = readState(cwd);
      assert.deepStrictEqual(reread, written);
      assert.deepStrictEqual(reread, {
        milestone: "M-1",
        phase: "execute",
        current_slice: "S02",
        next_action: "Run T04 gate",
      });
    });
  });

  test("reads an empty-defaults doc when STATE.md is absent", () => {
    withSandbox((cwd) => {
      let seen: StateDoc | undefined;
      updateState(cwd, (s) => {
        seen = s;
        return { milestone: "M-first" };
      });
      assert.deepStrictEqual(seen, { milestone: "" });
    });
  });

  test("second updateState preserves and edits fields via the mutator", () => {
    withSandbox((cwd) => {
      updateState(cwd, () => ({
        milestone: "M-1",
        current_slice: "S01",
        units: [{ id: "S01", type: "slice", status: "pending" }],
      }));

      updateState(cwd, (s) => ({
        ...s,
        current_slice: "S02",
        units: (s.units ?? []).map((u) =>
          u.id === "S01" ? { ...u, status: "done" as const } : u,
        ),
      }));

      const doc = readState(cwd);
      assert.equal(doc.milestone, "M-1", "milestone preserved");
      assert.equal(doc.current_slice, "S02", "current_slice edited");
      assert.deepStrictEqual(doc.units, [{ id: "S01", type: "slice", status: "done" }]);
    });
  });

  test("leaves no .tmp residue after a successful write", () => {
    withSandbox((cwd) => {
      updateState(cwd, () => ({ milestone: "M-1" }));
      updateState(cwd, (s) => ({ ...s, phase: "plan" }));

      const gsdDir = join(cwd, ".gsd");
      const entries = readdirSync(gsdDir);
      const tmpResidue = entries.filter((e) => e.includes(".tmp"));
      assert.deepStrictEqual(tmpResidue, [], `no .tmp residue, found: ${tmpResidue.join(", ")}`);
      assert.deepStrictEqual(
        entries.filter((e) => e === "STATE.md"),
        ["STATE.md"],
        "exactly one STATE.md present",
      );
    });
  });

  test("does not corrupt an existing STATE.md when the mutator throws", () => {
    withSandbox((cwd) => {
      updateState(cwd, () => ({ milestone: "M-1", phase: "execute" }));
      const before = readFileSync(join(cwd, ".gsd", "STATE.md"), "utf-8");

      assert.throws(() => {
        updateState(cwd, () => {
          throw new Error("boom");
        });
      }, /boom/);

      const after = readFileSync(join(cwd, ".gsd", "STATE.md"), "utf-8");
      assert.equal(after, before, "STATE.md untouched when mutator throws");

      const entries = readdirSync(join(cwd, ".gsd"));
      assert.deepStrictEqual(
        entries.filter((e) => e.includes(".tmp")),
        [],
        "no .tmp residue after a failed write",
      );
    });
  });
});

// ── appendEvent — append-only journal ────────────────────────────────────────

describe("appendEvent", () => {
  function makeEvent(n: number): ForgeEvent {
    return {
      ts: `2026-07-08T00:00:0${n}Z`,
      unit: `execute-task/T0${n}`,
      agent: "forge-executor",
      milestone: "M-1",
      status: "done",
      summary: `did thing ${n}`,
    };
  }

  test("creates .gsd/forge/ and accumulates N valid JSON lines", () => {
    withSandbox((cwd) => {
      for (let i = 1; i <= 3; i++) {
        appendEvent(cwd, makeEvent(i));
      }

      const path = join(cwd, ".gsd", "forge", "events.jsonl");
      assert.ok(existsSync(path), "events.jsonl created");

      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      assert.equal(lines.length, 3, "three lines accumulated");

      const parsed = lines.map((l) => JSON.parse(l) as ForgeEvent);
      assert.deepStrictEqual(
        parsed.map((p) => p.unit),
        ["execute-task/T01", "execute-task/T02", "execute-task/T03"],
      );
    });
  });

  test("never rewrites existing lines (pure append)", () => {
    withSandbox((cwd) => {
      appendEvent(cwd, makeEvent(1));
      const path = join(cwd, ".gsd", "forge", "events.jsonl");
      const afterFirst = readFileSync(path, "utf-8");

      appendEvent(cwd, makeEvent(2));
      const afterSecond = readFileSync(path, "utf-8");

      assert.ok(
        afterSecond.startsWith(afterFirst),
        "the second append preserves the first line verbatim as a prefix",
      );
    });
  });

  test("appends alongside a pre-existing journal file", () => {
    withSandbox((cwd) => {
      const dir = join(cwd, ".gsd", "forge");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ pre: true })}\n`, "utf-8");

      appendEvent(cwd, makeEvent(1));

      const lines = readFileSync(join(dir, "events.jsonl"), "utf-8").split("\n").filter(Boolean);
      assert.equal(lines.length, 2, "pre-existing line + appended line");
      assert.deepStrictEqual(JSON.parse(lines[0]), { pre: true });
    });
  });
});

// ── readEvents — tolerant read side of the journal (M1R-3) ────────────────────

describe("readEvents", () => {
  function makeEvent(n: number): ForgeEvent {
    return {
      ts: `2026-07-08T00:00:0${n}Z`,
      unit: `execute-task/T0${n}`,
      agent: "forge-executor",
      milestone: "M-1",
      status: "done",
      summary: `did thing ${n}`,
    };
  }

  test("returns [] when the journal is absent (never throws)", () => {
    withSandbox((cwd) => {
      assert.deepStrictEqual(readEvents(cwd), []);
    });
  });

  test("returns all appended events in append order", () => {
    withSandbox((cwd) => {
      for (let i = 1; i <= 3; i++) appendEvent(cwd, makeEvent(i));
      const events = readEvents(cwd);
      assert.equal(events.length, 3);
      assert.deepStrictEqual(
        events.map((e) => e.unit),
        ["execute-task/T01", "execute-task/T02", "execute-task/T03"],
      );
    });
  });

  test("skips a malformed / torn line without throwing", () => {
    withSandbox((cwd) => {
      const dir = join(cwd, ".gsd", "forge");
      mkdirSync(dir, { recursive: true });
      // Valid, then a torn/partial line (crash mid-append), then valid again.
      const good1 = JSON.stringify(makeEvent(1));
      const good2 = JSON.stringify(makeEvent(2));
      writeFileSync(join(dir, "events.jsonl"), `${good1}\n{"ts":"broken"\n\n${good2}\n`, "utf-8");

      const events = readEvents(cwd);
      assert.equal(events.length, 2, "the malformed line is skipped, both valid lines kept");
      assert.deepStrictEqual(
        events.map((e) => e.unit),
        ["execute-task/T01", "execute-task/T02"],
      );
    });
  });
});
