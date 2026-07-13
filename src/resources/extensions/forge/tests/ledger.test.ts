import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ledgerDir,
  fragmentPath,
  parseLedgerFragment,
  serializeLedgerFragment,
  writeLedgerFragment,
  readLedgerFragment,
  listLedgerFragments,
  type LedgerEntry,
} from "../state/ledger.ts";

// Every test runs in a fresh mkdtemp sandbox as `cwd`; the store resolves
// `<cwd>/.gsd/ledger/…`, so nothing here touches the live repo `.gsd/`.
function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-ledger-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MID = "M-20260101000000-example";

function sampleEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: MID,
    title: "Example milestone: parity",
    completed_at: "2026-01-01T00:00:00Z",
    slices: ["S01 — one", "S02 — two"],
    key_files: ["src/a.ts", "src/b.ts"],
    key_decisions: ["Chose X over Y"],
    body: "Delivered the example milestone.",
    ...overrides,
  };
}

describe("fragmentPath", () => {
  test("resolves under .gsd/ledger for a milestone id", () => {
    withSandbox((cwd) => {
      assert.equal(fragmentPath(cwd, MID), join(ledgerDir(cwd), `${MID}.md`));
    });
  });

  test("accepts a task id", () => {
    withSandbox((cwd) => {
      assert.equal(fragmentPath(cwd, "TASK-007"), join(ledgerDir(cwd), "TASK-007.md"));
    });
  });

  test("throws on an invalid id", () => {
    withSandbox((cwd) => {
      assert.throws(() => fragmentPath(cwd, "not a valid id!!"), /Invalid ledger ID/);
    });
  });
});

describe("write → read → list roundtrip", () => {
  test("round-trips a full entry through disk", () => {
    withSandbox((cwd) => {
      const entry = sampleEntry();
      const res = writeLedgerFragment(cwd, entry);
      assert.equal(res.created, true);
      assert.ok(existsSync(res.path));

      const back = readLedgerFragment(cwd, MID);
      assert.deepEqual(back, entry);
    });
  });

  test("second identical write is idempotent (created=false)", () => {
    withSandbox((cwd) => {
      const entry = sampleEntry();
      writeLedgerFragment(cwd, entry);
      const res2 = writeLedgerFragment(cwd, entry);
      assert.equal(res2.created, false);
    });
  });

  test("listLedgerFragments returns sorted {id, path}", () => {
    withSandbox((cwd) => {
      writeLedgerFragment(cwd, sampleEntry({ id: "M-20260102000000-b" }));
      writeLedgerFragment(cwd, sampleEntry({ id: "M-20260101000000-a" }));
      const list = listLedgerFragments(cwd);
      assert.deepEqual(
        list.map((f) => f.id),
        ["M-20260101000000-a", "M-20260102000000-b"],
      );
    });
  });

  test("listLedgerFragments is [] when dir absent (no throw)", () => {
    withSandbox((cwd) => {
      assert.deepEqual(listLedgerFragments(cwd), []);
    });
  });

  test("readLedgerFragment is null when fragment absent", () => {
    withSandbox((cwd) => {
      assert.equal(readLedgerFragment(cwd, MID), null);
    });
  });

  test("writeLedgerFragment throws on invalid id", () => {
    withSandbox((cwd) => {
      assert.throws(() => writeLedgerFragment(cwd, sampleEntry({ id: "bogus id!!" })), /Invalid ledger ID/);
    });
  });
});

describe("parseLedgerFragment", () => {
  test("parses the inline-array shape the complete-milestone worker writes", () => {
    // This is the EXACT contract from complete-milestone.ts (T03): frontmatter
    // with inline arrays + a short body.
    const text = [
      "---",
      "id: M-20260101000000-example",
      'title: "Example milestone: parity"',
      'completed_at: "2026-01-01T00:00:00Z"',
      'slices: ["S01 — one", "S02 — two"]',
      'key_files: ["src/a.ts", "src/b.ts"]',
      'key_decisions: ["Chose X over Y"]',
      "---",
      "",
      "Delivered the example milestone.",
      "",
    ].join("\n");

    const frag = parseLedgerFragment(text);
    assert.equal(frag.id, "M-20260101000000-example");
    assert.equal(frag.title, "Example milestone: parity");
    assert.equal(frag.completed_at, "2026-01-01T00:00:00Z");
    assert.deepEqual(frag.slices, ["S01 — one", "S02 — two"]);
    assert.deepEqual(frag.key_files, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(frag.key_decisions, ["Chose X over Y"]);
    assert.equal(frag.body, "Delivered the example milestone.");
  });

  test("worker inline-array fragment survives serialize round-trip", () => {
    withSandbox((cwd) => {
      const text = [
        "---",
        `id: ${MID}`,
        'title: "Example milestone: parity"',
        'completed_at: "2026-01-01T00:00:00Z"',
        'slices: ["S01 — one", "S02 — two"]',
        'key_files: ["src/a.ts"]',
        'key_decisions: ["Chose X over Y"]',
        "---",
        "",
        "Body here.",
      ].join("\n");
      // Simulate the worker's write, then read back through our store.
      mkdirSync(ledgerDir(cwd), { recursive: true });
      writeFileSync(join(ledgerDir(cwd), `${MID}.md`), text);
      const back = readLedgerFragment(cwd, MID);
      assert.ok(back);
      assert.equal(back!.title, "Example milestone: parity");
      assert.deepEqual(back!.slices, ["S01 — one", "S02 — two"]);
      // And re-serializing then re-parsing is stable.
      const reparsed = parseLedgerFragment(serializeLedgerFragment(back!));
      assert.deepEqual(reparsed, back);
    });
  });

  test("degrades to defaults on missing frontmatter (no throw)", () => {
    const frag = parseLedgerFragment("just a body, no frontmatter");
    assert.equal(frag.id, "");
    assert.deepEqual(frag.slices, []);
    assert.equal(frag.body, "just a body, no frontmatter");
  });
});
