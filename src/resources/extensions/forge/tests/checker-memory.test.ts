import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCheckerFragment,
  listCheckerFragments,
  parseCheckerFragment,
  serializeCheckerFragment,
  readCheckerFragment,
  checkerFragmentPath,
  type CheckerFragment,
} from "../gates/checker-memory.ts";

/** Toy milestone id used across the milestone-namespaced fragment store. */
const MID = "M-20260101000000-a";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-checker-memory-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("checkerFragmentPath", () => {
  test("does not validate via isValid — accepts short slice labels, folds in milestoneId", () => {
    withSandbox((cwd) => {
      const p = checkerFragmentPath(cwd, MID, "S01");
      assert.equal(p, join(cwd, ".gsd", "checker", MID, "S01.md"));
    });
  });
});

describe("writeCheckerFragment / readCheckerFragment round-trip", () => {
  test("writes a fragment parseable back with the same finding", () => {
    withSandbox((cwd) => {
      const res = writeCheckerFragment(cwd, MID, "S01", {
        dimension: "coverage",
        verdict: "gap",
        note: "missing edge-case test",
      });
      assert.equal(res.created, true);
      assert.ok(existsSync(res.path));

      const frag = readCheckerFragment(cwd, MID, "S01");
      assert.ok(frag);
      assert.equal(frag!.slice, "S01");
      assert.equal(frag!.findings.length, 1);
      assert.equal(frag!.findings[0].dimension, "coverage");
      assert.equal(frag!.findings[0].verdict, "gap");
      assert.equal(frag!.findings[0].note, "missing edge-case test");
    });
  });

  test("appends a second, DIFFERENT finding to the existing fragment", () => {
    withSandbox((cwd) => {
      writeCheckerFragment(cwd, MID, "S02", { dimension: "coverage", verdict: "gap", note: "first" });
      writeCheckerFragment(cwd, MID, "S02", { dimension: "security", verdict: "risk", note: "second" });

      const frag = readCheckerFragment(cwd, MID, "S02");
      assert.ok(frag);
      assert.equal(frag!.findings.length, 2);
      assert.equal(frag!.findings[0].note, "first");
      assert.equal(frag!.findings[1].note, "second");
    });
  });

  test("re-writing an IDENTICAL finding is idempotent (created:false, no duplicate row) — R1 regression", () => {
    withSandbox((cwd) => {
      const finding = { dimension: "coverage", verdict: "gap", note: "same" };

      const first = writeCheckerFragment(cwd, MID, "S03", finding);
      assert.equal(first.created, true);

      // 2nd write of the SAME finding must NOT append and must report created:false.
      const second = writeCheckerFragment(cwd, MID, "S03", { ...finding });
      assert.equal(second.created, false, "re-writing the same finding is a no-op");

      const frag = readCheckerFragment(cwd, MID, "S03");
      assert.ok(frag);
      assert.equal(frag!.findings.length, 1, "no duplicate row accumulated");

      // A genuinely DIFFERENT finding still appends.
      const third = writeCheckerFragment(cwd, MID, "S03", { dimension: "security", verdict: "risk", note: "new" });
      assert.equal(third.created, true);
      const after = readCheckerFragment(cwd, MID, "S03");
      assert.equal(after!.findings.length, 2);
    });
  });

  test("same slice label in DIFFERENT milestones does not collide — R2 regression", () => {
    withSandbox((cwd) => {
      const midA = "M-20260101000000-a";
      const midB = "M-20260202000000-b";

      const resA = writeCheckerFragment(cwd, midA, "S01", { dimension: "coverage", verdict: "gap", note: "from A" });
      const resB = writeCheckerFragment(cwd, midB, "S01", { dimension: "security", verdict: "risk", note: "from B" });

      // Separate files on disk.
      assert.notEqual(resA.path, resB.path);
      assert.ok(existsSync(resA.path) && existsSync(resB.path));

      const fragA = readCheckerFragment(cwd, midA, "S01");
      const fragB = readCheckerFragment(cwd, midB, "S01");
      assert.equal(fragA!.findings.length, 1);
      assert.equal(fragB!.findings.length, 1);
      assert.equal(fragA!.findings[0].note, "from A");
      assert.equal(fragB!.findings[0].note, "from B");

      // Each milestone's listing sees only its own fragment.
      assert.deepEqual(listCheckerFragments(cwd, midA).map((e) => e.slice), ["S01"]);
      assert.deepEqual(listCheckerFragments(cwd, midB).map((e) => e.slice), ["S01"]);
    });
  });
});

describe("listCheckerFragments", () => {
  test("returns [] when the checker directory is absent", () => {
    withSandbox((cwd) => {
      assert.deepEqual(listCheckerFragments(cwd, MID), []);
    });
  });

  test("lists fragments sorted by slice ascending, keyed by file name", () => {
    withSandbox((cwd) => {
      writeCheckerFragment(cwd, MID, "S02", { dimension: "d", verdict: "v", note: "n" });
      writeCheckerFragment(cwd, MID, "S01", { dimension: "d", verdict: "v", note: "n" });

      const list = listCheckerFragments(cwd, MID);
      assert.equal(list.length, 2);
      assert.deepEqual(
        list.map((e) => e.slice),
        ["S01", "S02"],
      );
    });
  });

  test("tolerates a synthetic/non-canonical slice id (S03/T07 fixture gotcha)", () => {
    withSandbox((cwd) => {
      // A slice label that would fail state/ids.ts isValid() (not M-/T-/TASK-
      // shaped) must still be writable and listable, keyed by file name.
      const syntheticSlice = "synthetic-slice-xyz";
      writeCheckerFragment(cwd, MID, syntheticSlice, { dimension: "d", verdict: "v", note: "n" });

      const list = listCheckerFragments(cwd, MID);
      assert.ok(list.some((e) => e.slice === syntheticSlice));

      const frag = readCheckerFragment(cwd, MID, syntheticSlice);
      assert.ok(frag);
      assert.equal(frag!.slice, syntheticSlice);
    });
  });
});

describe("parseCheckerFragment / serializeCheckerFragment", () => {
  test("round-trips a fragment with multiple findings", () => {
    const fragment: CheckerFragment = {
      slice: "S05",
      generatedAt: "2026-01-01T00:00:00.000Z",
      findings: [
        { dimension: "coverage", verdict: "gap", note: "a: b" },
        { dimension: "security", verdict: "ok", note: "clean" },
      ],
    };
    const text = serializeCheckerFragment(fragment);
    const parsed = parseCheckerFragment(text);
    assert.equal(parsed.slice, "S05");
    assert.equal(parsed.generatedAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(parsed.findings, fragment.findings);
  });

  test("degrades to empty findings on a malformed shape (never throws)", () => {
    const parsed = parseCheckerFragment("not frontmatter at all");
    assert.equal(parsed.slice, "");
    assert.equal(parsed.generatedAt, null);
    assert.deepEqual(parsed.findings, []);
  });

  test("serializes an empty findings list as findings: []", () => {
    const text = serializeCheckerFragment({ slice: "S06", generatedAt: null, findings: [] });
    assert.ok(text.includes("findings: []"));
    const parsed = parseCheckerFragment(text);
    assert.deepEqual(parsed.findings, []);
  });
});

describe("write atomicity", () => {
  test("does not leave a stray temp file behind after write", () => {
    withSandbox((cwd) => {
      writeCheckerFragment(cwd, MID, "S07", { dimension: "d", verdict: "v", note: "n" });
      const dir = join(cwd, ".gsd", "checker", MID);
      const entries = readdirSync(dir);
      assert.ok(entries.every((f: string) => !f.includes(".tmp")));
    });
  });
});
