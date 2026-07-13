import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Covers T04 / A3: the upgrade path must actively prune GSD-methodology
 * residue that was deployed by a pre-fork version and is no longer part of
 * the bundled source (GSD-WORKFLOW.md + removed skill subdirectories).
 *
 * syncResourceDir/pruneStaleSiblingFiles alone are insufficient — they only
 * clear top-level files whose .ts/.js sibling disappeared, never whole
 * subdirectories. pruneStaleSubdirs is the additive helper introduced here.
 */

function overrideHomeEnv(homeDir: string): () => void {
  const original = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  return () => {
    if (original.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = original.HOME;
    if (original.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = original.USERPROFILE;
    if (original.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE;
    else process.env.HOMEDRIVE = original.HOMEDRIVE;
    if (original.HOMEPATH === undefined) delete process.env.HOMEPATH;
    else process.env.HOMEPATH = original.HOMEPATH;
  };
}

test("pruneStaleSubdirs removes destination subdirs absent from source, keeps present ones", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prune-subdirs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const srcDir = join(tmp, "src", "skills");
  const destDir = join(tmp, "dest", "skills");

  mkdirSync(join(srcDir, "accessibility"), { recursive: true });
  writeFileSync(join(srcDir, "accessibility", "SKILL.md"), "# accessibility\n");

  mkdirSync(join(destDir, "accessibility"), { recursive: true });
  writeFileSync(join(destDir, "accessibility", "SKILL.md"), "# accessibility (deployed)\n");
  mkdirSync(join(destDir, "decompose-into-slices"), { recursive: true });
  writeFileSync(join(destDir, "decompose-into-slices", "SKILL.md"), "# decompose-into-slices\n");

  const { pruneStaleSubdirs } = await import("../resource-loader.ts");
  pruneStaleSubdirs(srcDir, destDir);

  assert.equal(
    existsSync(join(destDir, "decompose-into-slices")),
    false,
    "skill subdir removed from source should be pruned from the deploy",
  );
  assert.equal(
    existsSync(join(destDir, "accessibility")),
    true,
    "skill subdir still present in source must not be pruned",
  );
});

test("pruneStaleSubdirs is a no-op when destDir does not exist", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prune-subdirs-missing-"));
  const srcDir = join(tmp, "src");
  const destDir = join(tmp, "dest", "does-not-exist");
  mkdirSync(srcDir, { recursive: true });

  const { pruneStaleSubdirs } = await import("../resource-loader.ts");
  assert.doesNotThrow(() => pruneStaleSubdirs(srcDir, destDir));

  rmSync(tmp, { recursive: true, force: true });
});

test("initResources prunes an orphaned GSD-WORKFLOW.md left by a pre-fork deploy", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prune-workflow-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  mkdirSync(fakeAgentDir, { recursive: true });
  writeFileSync(join(fakeAgentDir, "GSD-WORKFLOW.md"), "# stale GSD workflow guidance\n");

  const { initResources } = await import("../resource-loader.ts");
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(join(fakeAgentDir, "GSD-WORKFLOW.md")),
    false,
    "orphaned GSD-WORKFLOW.md must be pruned on the next boot (A3)",
  );
});
