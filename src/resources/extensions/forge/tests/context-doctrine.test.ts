import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRootFrom } from "./helpers/repo-root.ts";

/**
 * Guard for the S08 anti-`--print` doctrine on the context file the in-TUI
 * assistant actually receives. Replicates the SAME candidate order and
 * first-match resolution as `loadContextFileFromDir` in
 * `packages/pi-coding-agent/src/core/resource-loader.ts:67` — standalone via
 * fs, no import from `packages/pi-*` (vendored source, iron rule #1).
 *
 * If a future `AGENTS.md` shadows `CLAUDE.md` at the repo root without
 * carrying the doctrine forward, this resolves to the shadowing file and the
 * anchor assertions below go red.
 */

const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function resolveContextFile(dir: string): { path: string; content: string } {
  for (const filename of CONTEXT_FILE_CANDIDATES) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      return { path: filePath, content: readFileSync(filePath, "utf8") };
    }
  }
  throw new Error(`no context file found in ${dir} (candidates: ${CONTEXT_FILE_CANDIDATES.join(", ")})`);
}

const repoRoot = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
const contextFile = resolveContextFile(repoRoot);

describe("repo-root context file — anti-`--print` doctrine guard", () => {
  test("first-match candidate resolves to CLAUDE.md (no AGENTS.md shadowing it)", () => {
    assert.equal(
      contextFile.path,
      join(repoRoot, "CLAUDE.md"),
      "an AGENTS.md at the repo root would shadow CLAUDE.md entirely (first-match, not merge) and hide the doctrine from the in-TUI assistant",
    );
  });

  test("resolved context file carries the anti-`--print` doctrine anchors", () => {
    assert.match(
      contextFile.content,
      /NUNCA via\s+`?--print`?\s+em background/u,
      "expected the doctrine anchor phrase 'NUNCA via `--print` em background' in the resolved context file",
    );
    assert.match(
      contextFile.content,
      /incidente 2026-07-12/u,
      "expected the anchor 'incidente 2026-07-12' in the resolved context file",
    );
  });
});
