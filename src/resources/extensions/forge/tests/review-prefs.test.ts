import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReviewPrefs } from "../review/review-prefs.ts";

// Isolate the two user-scope cascade layers (legacy ~/.claude + gsdHome()) —
// mirrors tests/prefs.test.ts so a real machine's ~/.claude or ~/.forge
// prefs files never contaminate these tests.
function withIsolatedHome<T>(fn: (fakeHome: string) => T): T {
  const fakeHome = mkdtempSync(join(tmpdir(), "forge-review-prefs-home-"));
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

function withScratchRepo<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-review-prefs-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRepoPrefs(dir: string, content: string, file = "prefs.md") {
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", file), content);
}

describe("readReviewPrefs", () => {
  test("defaults when no cascade file exists", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        const prefs = readReviewPrefs(dir);
        assert.deepEqual(prefs, { mode: "enabled", rounds: 1, askInAuto: "defer", fixConceded: true });
      });
    });
  });

  test("defaults when file exists but has no review: block", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(dir, "mode: manual\n");
        const prefs = readReviewPrefs(dir);
        assert.deepEqual(prefs, { mode: "enabled", rounds: 1, askInAuto: "defer", fixConceded: true });
      });
    });
  });

  test("reads all fields from a single-layer review: block", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(
          dir,
          "review:\n  mode: disabled\n  rounds: 0\n  ask_in_auto: pause\n  fix_conceded: false\n",
        );
        const prefs = readReviewPrefs(dir);
        assert.deepEqual(prefs, { mode: "disabled", rounds: 0, askInAuto: "pause", fixConceded: false });
      });
    });
  });

  test("last-wins per key across cascade layers — a file that only sets rounds does not reset mode", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(dir, "review:\n  mode: disabled\n  ask_in_auto: pause\n", "prefs.md");
        writeRepoPrefs(dir, "review:\n  rounds: 0\n", "prefs.local.md");
        const prefs = readReviewPrefs(dir);
        // repo layer's mode/askInAuto survive; local layer only overrides rounds.
        assert.equal(prefs.mode, "disabled");
        assert.equal(prefs.askInAuto, "pause");
        assert.equal(prefs.rounds, 0);
        assert.equal(prefs.fixConceded, true);
      });
    });
  });

  test("local layer overrides repo layer for a shared key", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(dir, "review:\n  mode: disabled\n", "prefs.md");
        writeRepoPrefs(dir, "review:\n  mode: enabled\n", "prefs.local.md");
        const prefs = readReviewPrefs(dir);
        assert.equal(prefs.mode, "enabled");
      });
    });
  });

  test("rounds clamp: 2 -> 1", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(dir, "review:\n  rounds: 2\n");
        assert.equal(readReviewPrefs(dir).rounds, 1);
      });
    });
  });

  test("rounds clamp: negative -> default 1", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        // regex \d+ won't match a leading '-', so this exercises the
        // "no match at all -> default" path rather than a parsed negative.
        writeRepoPrefs(dir, "review:\n  rounds: -1\n");
        assert.equal(readReviewPrefs(dir).rounds, 1);
      });
    });
  });

  test("rounds: 0 is preserved (not clamped to default)", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(dir, "review:\n  rounds: 0\n");
        assert.equal(readReviewPrefs(dir).rounds, 0);
      });
    });
  });

  test("invalid mode falls back to default", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(dir, "review:\n  mode: bogus\n");
        assert.equal(readReviewPrefs(dir).mode, "enabled");
      });
    });
  });

  test("invalid ask_in_auto falls back to default", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(dir, "review:\n  ask_in_auto: bogus\n");
        assert.equal(readReviewPrefs(dir).askInAuto, "defer");
      });
    });
  });

  test("fix_conceded: anything other than 'false' string is treated as true", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(dir, "review:\n  fix_conceded: nope\n");
        assert.equal(readReviewPrefs(dir).fixConceded, true);
      });
    });
  });

  test("style and engine keys are parsed-and-ignored — do not affect result or crash", () => {
    withIsolatedHome(() => {
      withScratchRepo((dir) => {
        writeRepoPrefs(dir, "review:\n  style: flags\n  engine: workflow\n  mode: enabled\n");
        const prefs = readReviewPrefs(dir);
        assert.deepEqual(prefs, { mode: "enabled", rounds: 1, askInAuto: "defer", fixConceded: true });
        assert.ok(!("style" in prefs));
        assert.ok(!("engine" in prefs));
      });
    });
  });

  test("never throws on missing/unreadable directory", () => {
    withIsolatedHome(() => {
      const nonexistentDir = join(tmpdir(), "forge-review-prefs-does-not-exist-" + Date.now());
      assert.doesNotThrow(() => readReviewPrefs(nonexistentDir));
    });
  });
});
