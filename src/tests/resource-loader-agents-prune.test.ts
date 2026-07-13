import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Covers T02 / M1R-6: agentDir/agents/ files not present in the bundled
 * shipped allowlist (src/resources/agents/*.md) must be pruned unconditionally
 * on every initResources call — even when the version/hash fast-path skips
 * the full sync — so forge 1.0 leftovers (e.g. forge-discusser.md) don't
 * persist forever.
 *
 * pruneStaleSiblingFiles's .ts/.js sibling heuristic never matches flat .md
 * agent files, so it cannot cover this case — pruneStaleAgents is additive.
 */

test("pruneStaleAgents removes an orphaned .md agent not in the bundled allowlist, keeps shipped ones", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prune-agents-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const bundledAgentsDir = join(tmp, "src", "agents");
  const agentsDestDir = join(tmp, "dest", "agents");

  mkdirSync(bundledAgentsDir, { recursive: true });
  writeFileSync(join(bundledAgentsDir, "worker.md"), "# worker\n");

  mkdirSync(agentsDestDir, { recursive: true });
  writeFileSync(join(agentsDestDir, "worker.md"), "# worker (deployed)\n");
  writeFileSync(join(agentsDestDir, "forge-discusser.md"), "# forge-discusser (orphan)\n");

  const { pruneStaleAgents } = await import("../resource-loader.ts");
  pruneStaleAgents(bundledAgentsDir, agentsDestDir);

  assert.equal(
    existsSync(join(agentsDestDir, "forge-discusser.md")),
    false,
    "orphaned .md agent absent from the bundled allowlist must be pruned",
  );
  assert.equal(
    existsSync(join(agentsDestDir, "worker.md")),
    true,
    "shipped agent present in the bundled allowlist must never be pruned",
  );
});

test("pruneStaleAgents keeps a user's custom agent, prunes a manifest-recorded shipped-removed orphan (R2)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prune-agents-r2-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const bundledAgentsDir = join(tmp, "src", "agents");
  const agentsDestDir = join(tmp, "dest", "agents");

  // Current bundle ships only worker.md.
  mkdirSync(bundledAgentsDir, { recursive: true });
  writeFileSync(join(bundledAgentsDir, "worker.md"), "# worker\n");

  mkdirSync(agentsDestDir, { recursive: true });
  writeFileSync(join(agentsDestDir, "worker.md"), "# worker (deployed)\n");
  // A user-authored custom agent — a name the fork NEVER shipped.
  writeFileSync(join(agentsDestDir, "my-custom-agent.md"), "# my custom agent\n");
  // A shipped-then-removed agent — recorded in the PREVIOUS manifest below.
  writeFileSync(join(agentsDestDir, "old-shipped.md"), "# old shipped (removed)\n");

  const { pruneStaleAgents } = await import("../resource-loader.ts");
  // Previous manifest shipped worker.md + old-shipped.md; old-shipped.md is gone
  // from the current bundle → prune it, but never the custom agent.
  pruneStaleAgents(bundledAgentsDir, agentsDestDir, ["worker.md", "old-shipped.md"]);

  assert.equal(
    existsSync(join(agentsDestDir, "my-custom-agent.md")),
    true,
    "a user's custom agent (never shipped) must survive pruning",
  );
  assert.equal(
    existsSync(join(agentsDestDir, "old-shipped.md")),
    false,
    "a shipped-removed agent recorded in the previous manifest must be pruned",
  );
  assert.equal(
    existsSync(join(agentsDestDir, "worker.md")),
    true,
    "a still-shipped agent must never be pruned",
  );
});

test("pruneStaleAgents (no manifest) keeps unknown files, prunes only known legacy orphans (R2)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prune-agents-r2-legacy-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const bundledAgentsDir = join(tmp, "src", "agents");
  const agentsDestDir = join(tmp, "dest", "agents");

  mkdirSync(bundledAgentsDir, { recursive: true });
  writeFileSync(join(bundledAgentsDir, "worker.md"), "# worker\n");

  mkdirSync(agentsDestDir, { recursive: true });
  writeFileSync(join(agentsDestDir, "forge-discusser.md"), "# legacy orphan\n");
  writeFileSync(join(agentsDestDir, "my-custom-agent.md"), "# custom\n");

  const { pruneStaleAgents } = await import("../resource-loader.ts");
  // No previous manifest (fresh/pre-R2): only the KNOWN legacy orphan is pruned.
  pruneStaleAgents(bundledAgentsDir, agentsDestDir);

  assert.equal(
    existsSync(join(agentsDestDir, "forge-discusser.md")),
    false,
    "a known legacy pre-manifest orphan must be pruned even without a manifest",
  );
  assert.equal(
    existsSync(join(agentsDestDir, "my-custom-agent.md")),
    true,
    "an unknown user file must survive when there is no manifest record",
  );
});

test("pruneStaleAgents is a no-op when agentsDestDir does not exist", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prune-agents-missing-"));
  const bundledAgentsDir = join(tmp, "src", "agents");
  const agentsDestDir = join(tmp, "dest", "does-not-exist");
  mkdirSync(bundledAgentsDir, { recursive: true });

  const { pruneStaleAgents } = await import("../resource-loader.ts");
  assert.doesNotThrow(() => pruneStaleAgents(bundledAgentsDir, agentsDestDir));

  rmSync(tmp, { recursive: true, force: true });
});

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

test("initResources prunes an orphaned agents/ file even on the version/hash fast-path", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-prune-agents-init-"));
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  const { initResources } = await import("../resource-loader.ts");

  // First call performs the full sync and lands the shipped agents +
  // manifest, establishing the version/hash fast-path baseline.
  initResources(fakeAgentDir);

  const agentsDestDir = join(fakeAgentDir, "agents");
  assert.equal(existsSync(agentsDestDir), true, "agents/ must exist after the initial sync");

  // Simulate a forge 1.0 leftover agent file dropped into a live deploy.
  writeFileSync(join(agentsDestDir, "forge-discusser.md"), "# forge-discusser (orphan)\n");

  // Second call should hit the version/hash fast-path (manifest unchanged)
  // yet still prune the orphan, since pruneStaleAgents runs unconditionally.
  initResources(fakeAgentDir);

  assert.equal(
    existsSync(join(agentsDestDir, "forge-discusser.md")),
    false,
    "orphaned agents/ file must be pruned even when the fast-path skips the full sync",
  );
});
