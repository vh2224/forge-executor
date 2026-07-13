import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyConfig, parseModelsConfig, readModelsConfig } from "./models-config.js";
import { serializeModelsConfig, writeModelsConfigLocal } from "./models-config-writer.js";

function tempProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-models-"));
  mkdirSync(join(cwd, ".gsd"));
  writeFileSync(join(cwd, ".gsd-placeholder"), "");
  return cwd;
}

const fixture = {
  pools: { claude: ["anthropic/opus", "anthropic/sonnet"], gpt: ["openai/luna"] },
  roles: { planner: ["claude"], executor: ["claude", "gpt"] },
  constraints: { reviewer_not_author: "family", on_missing_pool: "degrade+warn" },
};

describe("models config writer", () => {
  test("serializes and parses the closed shape without loss", () => {
    assert.deepEqual(parseModelsConfig(serializeModelsConfig(fixture)), fixture);
  });

  test("writes the local layer atomically and leaves repo layer unchanged", () => {
    const cwd = tempProject();
    const repo = join(cwd, ".gsd", "models.md");
    writeFileSync(repo, serializeModelsConfig(fixture));
    writeModelsConfigLocal(cwd, (config) => ({ ...config, roles: { reviewer: ["gpt"] } }));
    const local = join(cwd, ".gsd", "models.local.md");
    assert.ok(existsSync(local));
    assert.equal(readFileSync(repo, "utf8"), serializeModelsConfig(fixture));
    assert.deepEqual(readModelsConfig(cwd).roles.reviewer, ["gpt"]);
    assert.equal(readFileSync(local, "utf8").includes(".models.local."), false);
  });

  test("uses an empty local layer when it does not exist", () => {
    const cwd = tempProject();
    writeModelsConfigLocal(cwd, (config) => ({ ...config, pools: { api: ["provider/model"] } }));
    assert.deepEqual(readModelsConfig(cwd).pools, { api: ["provider/model"] });
  });

  test("writes an undefined pool reference and preserves the parser warning", () => {
    const cwd = tempProject();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      writeModelsConfigLocal(cwd, () => ({ ...emptyConfig(), roles: { planner: ["missing"] } }));
      assert.deepEqual(readModelsConfig(cwd).roles.planner, ["missing"]);
    } finally {
      console.warn = original;
    }
    assert.ok(warnings.some((warning) => warning.includes("undefined pool") && warning.includes("missing")));
  });
});
