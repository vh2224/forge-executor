import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readForgePrefs } from "../prefs.ts";

// Isolate the two user-scope cascade layers (legacy ~/.claude + gsdHome()) by
// redirecting HOME/FORGE_HOME to a scratch dir for the duration of each test —
// otherwise a real ~/.claude/forge-agent-prefs.md or ~/.forge/prefs.md on the
// machine running these tests would contaminate the results.
function withIsolatedHome<T>(fn: (fakeHome: string) => T): T {
  const fakeHome = mkdtempSync(join(tmpdir(), "forge-prefs-home-"));
  const prevHome = process.env.HOME;
  const prevForgeHome = process.env.FORGE_HOME;
  process.env.HOME = fakeHome;
  process.env.FORGE_HOME = join(fakeHome, ".forge");
  try {
    return fn(fakeHome);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevForgeHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevForgeHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

describe("readForgePrefs", () => {
  test("returns {} and no contributing sources when nothing exists", () => {
    withIsolatedHome(() => {
      const dir = mkdtempSync(join(tmpdir(), "forge-prefs-"));
      try {
        const { prefs, contributing } = readForgePrefs(dir);
        assert.deepEqual(prefs, {});
        assert.deepEqual(contributing, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("repo layer overrides nothing when it's the only layer present", () => {
    withIsolatedHome(() => {
      const dir = mkdtempSync(join(tmpdir(), "forge-prefs-"));
      try {
        mkdirSync(join(dir, ".gsd"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.md"), "mode: manual\n");
        const { prefs, contributing } = readForgePrefs(dir);
        assert.equal(prefs.mode, "manual");
        assert.equal(contributing.length, 1);
        assert.equal(contributing[0].label, "repo");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("local layer wins over repo layer (last-wins)", () => {
    withIsolatedHome(() => {
      const dir = mkdtempSync(join(tmpdir(), "forge-prefs-"));
      try {
        mkdirSync(join(dir, ".gsd"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.md"), "mode: manual\n");
        writeFileSync(join(dir, ".gsd", "prefs.local.md"), "mode: auto\n");
        const { prefs, contributing } = readForgePrefs(dir);
        assert.equal(prefs.mode, "auto");
        assert.equal(contributing.length, 2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("unknown key (retry:) does not break parsing of other keys", () => {
    withIsolatedHome(() => {
      const dir = mkdtempSync(join(tmpdir(), "forge-prefs-"));
      try {
        mkdirSync(join(dir, ".gsd"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.md"), "retry: unit\nmode: manual\n");
        const { prefs } = readForgePrefs(dir);
        assert.equal(prefs.mode, "manual");
        // retry is an unknown key today (S01) but tolerated, not stripped.
        assert.equal(prefs.retry, "unit");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("indented list values are parsed into arrays", () => {
    withIsolatedHome(() => {
      const dir = mkdtempSync(join(tmpdir(), "forge-prefs-"));
      try {
        mkdirSync(join(dir, ".gsd"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.md"), "unit_models:\n  - sonnet\n  - haiku\n");
        const { prefs } = readForgePrefs(dir);
        assert.deepEqual(prefs.unit_models, ["sonnet", "haiku"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("legacy ~/.claude layer only contributes a key when higher layers don't set it", () => {
    withIsolatedHome((fakeHome) => {
      const dir = mkdtempSync(join(tmpdir(), "forge-prefs-"));
      try {
        mkdirSync(join(fakeHome, ".claude"), { recursive: true });
        writeFileSync(
          join(fakeHome, ".claude", "forge-agent-prefs.md"),
          "mode: legacy-value\nlegacy_only: yes\n",
        );
        mkdirSync(join(dir, ".gsd"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.md"), "mode: manual\n");

        const { prefs, contributing } = readForgePrefs(dir);
        // repo layer (higher precedence) wins over legacy for the shared key.
        assert.equal(prefs.mode, "manual");
        // a key only set by legacy still surfaces — legacy contributes when
        // nothing higher overrides it.
        assert.equal(prefs.legacy_only, "yes");
        assert.equal(contributing.length, 2);
        assert.equal(contributing[0].label, "legacy ~/.claude");
        assert.equal(contributing[1].label, "repo");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
