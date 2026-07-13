import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { readModelsConfig } from "../auto/models-config.js";
import { runModelsCommand } from "../commands/models-command.js";

function context(cwd: string, output: string[]): ExtensionCommandContext {
  return {
    cwd,
    hasUI: false,
    ui: {
      mode: "headless",
      notify: (message: string) => output.push(message),
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
  } as unknown as ExtensionCommandContext;
}

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-model-command-"));
  mkdirSync(join(cwd, ".gsd"));
  writeFileSync(join(cwd, ".gsd", "models.md"), "\n```yaml\nmodels:\n  pools:\n    claude: [anthropic/opus]\n  roles:\n    planner: [claude]\n  constraints:\n    reviewer_not_author: family\n```\n");
  return cwd;
}

describe("/forge models", () => {
  test("view renders named sections rather than a yaml dump", async () => {
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    let printed = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runModelsCommand(context(project(), output), []);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.match(printed, /Forge models \(role×pool\)/);
    assert.match(printed, /Pools:/);
    assert.match(printed, /Roles:/);
    assert.match(printed, /planner: claude/);
    assert.doesNotMatch(printed, /```yaml/);
  });

  test("set writes only the local layer and view reads the merged edit", async () => {
    const cwd = project();
    const output: string[] = [];
    await runModelsCommand(context(cwd, output), ["set", "roles", "planner", "gpt"]);
    assert.deepEqual(readModelsConfig(cwd).roles.planner, ["gpt"]);
    assert.match(readFileSync(join(cwd, ".gsd", "models.md"), "utf8"), /planner: \[claude\]/);
    assert.match(readFileSync(join(cwd, ".gsd", "models.local.md"), "utf8"), /planner: \[gpt\]/);
  });

  test("accepts comma-separated pool lists and rejects invalid usage", async () => {
    const cwd = project();
    const output: string[] = [];
    await runModelsCommand(context(cwd, output), ["set", "roles", "executor", "claude, gpt"]);
    assert.deepEqual(readModelsConfig(cwd).roles.executor, ["claude", "gpt"]);
    await runModelsCommand(context(cwd, output), ["set", "unknown", "x", "y"]);
    assert.equal(output.length, 0);
    assert.equal(readModelsConfig(cwd).roles.unknown, undefined);
  });

  test("view can be invoked explicitly", async () => {
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    let printed = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runModelsCommand(context(project(), output), ["view"]);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.match(printed, /Constraints:/);
    assert.match(printed, /reviewer_not_author: family/);
  });
});
