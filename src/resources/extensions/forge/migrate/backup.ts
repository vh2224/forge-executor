/**
 * Forge migrate — automatic backup of `.gsd/` before any conversion write.
 *
 * HARD RULE (ROADMAP, incident 2026-06-10 of the real 1.0): no mutation of a
 * user's `.gsd/` without a prior automatic backup. `backupGsdTree` is the
 * mechanism that rule depends on — pure I/O, no `@gsd/*` import, no
 * dependency on the S01 classifiers. T06 calls it exactly once per
 * `--apply` invocation, before any real write.
 */

import { existsSync, cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface BackupResult {
  backupDir: string | null;
  fileCount: number;
}

/**
 * Recursively copies `<cwd>/.gsd/` to a sibling `.gsd-backup-<timestamp>-<pid>-<suffix>/`
 * directory (never nested under `.gsd/` — that would recurse into itself).
 *
 * Returns `{ backupDir: null, fileCount: 0 }` without creating anything when
 * `.gsd/` does not exist. Any real I/O failure (permission, disk full)
 * during the copy is allowed to propagate — silently swallowing a backup
 * failure would be worse than aborting `--apply` entirely, since the HARD
 * RULE depends on the backup having actually happened before the real write.
 */
export function backupGsdTree(cwd: string): BackupResult {
  const gsdDir = join(cwd, ".gsd");
  if (!existsSync(gsdDir)) {
    return { backupDir: null, fileCount: 0 };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  const backupDir = join(cwd, `.gsd-backup-${timestamp}-${process.pid}-${suffix}`);

  mkdirSync(backupDir, { recursive: true });
  cpSync(gsdDir, backupDir, { recursive: true, errorOnExist: false });

  return { backupDir, fileCount: countFiles(backupDir) };
}

function countFiles(dir: string): number {
  let count = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      count += countFiles(full);
    } else {
      count += 1;
    }
  }
  return count;
}
