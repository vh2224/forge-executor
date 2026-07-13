import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Walks up from a test file's directory until the repo root (marked by
 * `pnpm-workspace.yaml`), so path resolution is identical whether the test
 * runs from `src/` (strip-types runner) or a compiled tree.
 */
export function repoRootFrom(startDir: string): string {
  let dir = startDir;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("repo root (pnpm-workspace.yaml) not found above test file");
    }
    dir = parent;
  }
  return dir;
}
