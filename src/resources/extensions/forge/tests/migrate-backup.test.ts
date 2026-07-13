/**
 * Forge migrate — coverage for `backupGsdTree` (T01, `migrate/backup.ts`).
 *
 * Same mkdtemp-sandbox discipline as `migrate-command.test.ts`/
 * `gsd-history-operation.test.ts` — nothing here mutates a real project's
 * `.gsd/` tree.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupGsdTree } from "../migrate/backup.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-migrate-backup-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function snapshotTree(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else {
        out.push(`${full.slice(root.length)}:${st.size}:${readFileSync(full, "utf-8")}`);
      }
    }
  }
  walk(root);
  return out;
}

function writeGsdFixture(cwd: string): void {
  const gsdDir = join(cwd, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "STATE.md"), "# STATE\n\nsome content\n");

  const decisionsDir = join(gsdDir, "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(join(decisionsDir, "M001.md"), "---\nunit_id: M001\n---\n");

  // 2 levels deep, to prove recursion actually works.
  const milestoneDir = join(gsdDir, "milestones", "M-teste");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M-teste-STATE.md"), "---\nstatus: active\n---\n");
}

describe("backupGsdTree — happy path", () => {
  test("copies .gsd/ recursively to a sibling .gsd-backup-*/ dir, byte-identical file by file", () => {
    withSandbox((dir) => {
      writeGsdFixture(dir);

      const result = backupGsdTree(dir);

      assert.notEqual(result.backupDir, null);
      assert.ok(existsSync(result.backupDir!), "backup dir must exist on disk");
      assert.equal(result.fileCount, 3);

      const originalSnapshot = snapshotTree(join(dir, ".gsd"));
      const backupSnapshot = snapshotTree(result.backupDir!);
      assert.deepEqual(backupSnapshot, originalSnapshot, "backup must be byte-identical to the original, file by file");
    });
  });

  test("backup dir is a sibling of .gsd/, never nested inside it", () => {
    withSandbox((dir) => {
      writeGsdFixture(dir);
      const result = backupGsdTree(dir);
      assert.ok(result.backupDir!.startsWith(dir), "backup dir must live under cwd");
      assert.ok(
        !result.backupDir!.startsWith(join(dir, ".gsd") + "/"),
        "backup dir must not be nested inside .gsd/",
      );
    });
  });

  test(".gsd/ original is byte-identical before and after the call (never mutated)", () => {
    withSandbox((dir) => {
      writeGsdFixture(dir);
      const before = snapshotTree(join(dir, ".gsd"));

      backupGsdTree(dir);

      const after = snapshotTree(join(dir, ".gsd"));
      assert.deepEqual(after, before, ".gsd/ tree must be byte-identical before and after backupGsdTree");
    });
  });

  test("two sequential calls never collide — two distinct backup dirs, both present on disk simultaneously", () => {
    withSandbox((dir) => {
      writeGsdFixture(dir);

      const first = backupGsdTree(dir);
      const second = backupGsdTree(dir);

      assert.notEqual(first.backupDir, null);
      assert.notEqual(second.backupDir, null);
      assert.notEqual(first.backupDir, second.backupDir, "two calls must produce distinct backup dirs");
      assert.ok(existsSync(first.backupDir!), "first backup must still exist after the second call");
      assert.ok(existsSync(second.backupDir!), "second backup must exist");

      const firstSnapshot = snapshotTree(first.backupDir!);
      const secondSnapshot = snapshotTree(second.backupDir!);
      assert.deepEqual(firstSnapshot, secondSnapshot, "both backups must contain the same content");
    });
  });
});

describe("backupGsdTree — missing .gsd/", () => {
  test("cwd without .gsd/ returns { backupDir: null, fileCount: 0 } without throwing or creating anything", () => {
    withSandbox((dir) => {
      let result: ReturnType<typeof backupGsdTree> | undefined;
      assert.doesNotThrow(() => {
        result = backupGsdTree(dir);
      });
      assert.deepEqual(result, { backupDir: null, fileCount: 0 });

      const entries = readdirSync(dir);
      assert.deepEqual(entries, [], "no .gsd-backup-* dir should have been created");
    });
  });
});
