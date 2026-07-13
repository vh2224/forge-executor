import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMemoryFragment,
  readMemoryFragment,
  listMemoryFragments,
  parseMemoryFragment,
  serializeMemoryFragment,
  memoryFragmentPath,
  type MemoryFragment,
} from "../memory/memory-store.ts";

/** Toy unit id used across the global (non-milestone-namespaced) fragment store. */
const UNIT = "M-20260101000000-a";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-memory-store-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("memoryFragmentPath", () => {
  test("is global — no milestone segment folded in", () => {
    withSandbox((cwd) => {
      const p = memoryFragmentPath(cwd, UNIT);
      assert.equal(p, join(cwd, ".gsd", "memory", `${UNIT}.md`));
    });
  });
});

describe("writeMemoryFragment / readMemoryFragment round-trip", () => {
  test("writes a fragment parseable back with the same fact", () => {
    withSandbox((cwd) => {
      const res = writeMemoryFragment(cwd, {
        unit_id: UNIT,
        facts: [
          { id: "F1", fact: "uses pnpm workspaces", confidence: 0.9, hits: 3, created_at: "2026-01-01T00:00:00.000Z" },
        ],
      });
      assert.equal(res.created, true);
      assert.ok(existsSync(res.path));

      const frag = readMemoryFragment(cwd, UNIT);
      assert.ok(frag);
      assert.equal(frag!.unit_id, UNIT);
      assert.equal(frag!.facts.length, 1);
      assert.equal(frag!.facts[0].id, "F1");
      assert.equal(frag!.facts[0].fact, "uses pnpm workspaces");
      assert.equal(frag!.facts[0].confidence, 0.9);
      assert.equal(frag!.facts[0].hits, 3);
      assert.equal(frag!.facts[0].created_at, "2026-01-01T00:00:00.000Z");
    });
  });

  test("re-writing byte-identical content is idempotent (created:false, PRE-mutation compare) — S04-R1 regression", () => {
    withSandbox((cwd) => {
      const fragment: MemoryFragment = {
        unit_id: UNIT,
        facts: [{ id: "F1", fact: "same fact", confidence: 0.5, hits: 1, created_at: "2026-01-01T00:00:00.000Z" }],
      };

      const first = writeMemoryFragment(cwd, fragment);
      assert.equal(first.created, true);

      // 2nd write of byte-identical content must NOT rewrite and must report created:false.
      const second = writeMemoryFragment(cwd, { ...fragment, facts: [...fragment.facts] });
      assert.equal(second.created, false, "re-writing identical content is a no-op");

      const frag = readMemoryFragment(cwd, UNIT);
      assert.ok(frag);
      assert.equal(frag!.facts.length, 1, "no duplicate row accumulated");

      // A genuinely different fragment still (re)writes.
      const third = writeMemoryFragment(cwd, {
        unit_id: UNIT,
        facts: [...fragment.facts, { id: "F2", fact: "new fact", confidence: 0.2, hits: 0, created_at: "2026-01-02T00:00:00.000Z" }],
      });
      assert.equal(third.created, true);
      const after = readMemoryFragment(cwd, UNIT);
      assert.equal(after!.facts.length, 2);
    });
  });

  test("does not leave a stray temp file behind after write", () => {
    withSandbox((cwd) => {
      writeMemoryFragment(cwd, {
        unit_id: UNIT,
        facts: [{ id: "F1", fact: "n", confidence: 1, hits: 1, created_at: "2026-01-01T00:00:00.000Z" }],
      });
      const dir = join(cwd, ".gsd", "memory");
      const entries = readdirSync(dir);
      assert.ok(entries.every((f: string) => !f.includes(".tmp")));
    });
  });
});

describe("readMemoryFragment", () => {
  test("returns null when the fragment does not exist", () => {
    withSandbox((cwd) => {
      assert.equal(readMemoryFragment(cwd, "M-nope"), null);
    });
  });
});

describe("listMemoryFragments", () => {
  test("returns [] when the memory directory is absent", () => {
    withSandbox((cwd) => {
      assert.deepEqual(listMemoryFragments(cwd), []);
    });
  });

  test("lists fragments sorted by unitId ascending, keyed by file name", () => {
    withSandbox((cwd) => {
      writeMemoryFragment(cwd, { unit_id: "M-b", facts: [] });
      writeMemoryFragment(cwd, { unit_id: "M-a", facts: [] });

      const list = listMemoryFragments(cwd);
      assert.equal(list.length, 2);
      assert.deepEqual(
        list.map((e) => e.unitId),
        ["M-a", "M-b"],
      );
    });
  });

  test("tolerates a synthetic/non-canonical unit id (checker-memory-style gotcha)", () => {
    withSandbox((cwd) => {
      const synthetic = "synthetic-unit-xyz";
      writeMemoryFragment(cwd, { unit_id: synthetic, facts: [] });

      const list = listMemoryFragments(cwd);
      assert.ok(list.some((e) => e.unitId === synthetic));

      const frag = readMemoryFragment(cwd, synthetic);
      assert.ok(frag);
      assert.equal(frag!.unit_id, synthetic);
    });
  });
});

describe("parseMemoryFragment / serializeMemoryFragment", () => {
  test("round-trips a fragment with multiple facts", () => {
    const fragment: MemoryFragment = {
      unit_id: "M-20260101000000-a",
      facts: [
        { id: "F1", fact: "a: b", confidence: 0.75, hits: 4, created_at: "2026-01-01T00:00:00.000Z" },
        { id: "F2", fact: "clean", confidence: 0, hits: 0, created_at: "2026-01-02T00:00:00.000Z" },
      ],
    };
    const text = serializeMemoryFragment(fragment);
    const parsed = parseMemoryFragment(text);
    assert.equal(parsed.unit_id, "M-20260101000000-a");
    assert.deepEqual(parsed.facts, fragment.facts);
  });

  test("coerces numeric confidence/hits from raw text (Number/Math.trunc, NaN -> 0)", () => {
    const text = [
      "---",
      "unit_id: M-x",
      "facts:",
      "  - id: F1",
      "    fact: weird numbers",
      "    confidence: 0.33",
      "    hits: 5.9",
      "    created_at: 2026-01-01T00:00:00.000Z",
      "  - id: F2",
      "    fact: garbage numbers",
      "    confidence: not-a-number",
      "    hits: also-not-a-number",
      "    created_at: 2026-01-01T00:00:00.000Z",
      "---",
      "",
    ].join("\n");
    const parsed = parseMemoryFragment(text);
    assert.equal(parsed.facts.length, 2);
    assert.equal(parsed.facts[0].confidence, 0.33);
    assert.equal(parsed.facts[0].hits, 5); // Math.trunc(5.9)
    assert.equal(parsed.facts[1].confidence, 0);
    assert.equal(parsed.facts[1].hits, 0);
  });

  test("degrades to empty facts on a malformed shape (never throws)", () => {
    const parsed = parseMemoryFragment("not frontmatter at all");
    assert.equal(parsed.unit_id, "");
    assert.deepEqual(parsed.facts, []);
  });

  test("serializes an empty facts list as facts: []", () => {
    const text = serializeMemoryFragment({ unit_id: "M-empty", facts: [] });
    assert.ok(text.includes("facts: []"));
    const parsed = parseMemoryFragment(text);
    assert.deepEqual(parsed.facts, []);
  });

  test("round-trips a fact with an embedded newline without corrupting following fields (S07-REVIEW R3)", () => {
    withSandbox((cwd) => {
      const fragment: MemoryFragment = {
        unit_id: "M-20260101000000-multiline",
        facts: [
          {
            id: "F1",
            fact: "line1\nline2",
            confidence: 0.9,
            hits: 7,
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "F2",
            fact: "sane fact after it",
            confidence: 0.5,
            hits: 2,
            created_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      };
      writeMemoryFragment(cwd, fragment);
      const parsed = readMemoryFragment(cwd, fragment.unit_id);
      assert.ok(parsed);
      assert.equal(parsed!.facts.length, 2);
      assert.equal(parsed!.facts[0].fact, "line1\nline2");
      assert.equal(parsed!.facts[0].confidence, 0.9);
      assert.equal(parsed!.facts[0].hits, 7);
      assert.equal(parsed!.facts[0].created_at, "2026-01-01T00:00:00.000Z");
      // fields after the corrupted line must survive unchanged too
      assert.equal(parsed!.facts[1].fact, "sane fact after it");
      assert.equal(parsed!.facts[1].confidence, 0.5);
      assert.equal(parsed!.facts[1].hits, 2);
      assert.equal(parsed!.facts[1].created_at, "2026-01-02T00:00:00.000Z");
    });
  });
});

describe("writeMemoryFragment — path-traversal containment (S07-REVIEW R1)", () => {
  test("throws on a traversal-unsafe unit_id and creates no file outside .gsd/memory", () => {
    withSandbox((cwd) => {
      assert.throws(() => {
        writeMemoryFragment(cwd, {
          unit_id: "../evil",
          facts: [{ id: "F1", fact: "x", confidence: 1, hits: 1, created_at: "2026-01-01T00:00:00.000Z" }],
        });
      });
      const escaped = join(cwd, "..", "evil.md");
      assert.equal(existsSync(escaped), false);
    });
  });

  test("throws on an absolute-looking / separator-bearing unit_id", () => {
    withSandbox((cwd) => {
      assert.throws(() => {
        writeMemoryFragment(cwd, { unit_id: "sub/dir", facts: [] });
      });
      assert.throws(() => {
        writeMemoryFragment(cwd, { unit_id: "", facts: [] });
      });
    });
  });

  test("does NOT false-positive on a canonical unit_id (no separators/..)", () => {
    withSandbox((cwd) => {
      const res = writeMemoryFragment(cwd, {
        unit_id: "T-20260710-foo",
        facts: [{ id: "F1", fact: "ok", confidence: 1, hits: 1, created_at: "2026-01-01T00:00:00.000Z" }],
      });
      assert.equal(res.created, true);
      assert.ok(existsSync(res.path));
    });
  });
});
