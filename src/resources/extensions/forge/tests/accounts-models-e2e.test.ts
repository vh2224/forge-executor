import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { getAuthPath } from "@gsd/pi-coding-agent/config.js";
import { runAccountsCommand } from "../commands/accounts-command.js";
import { runModelsCommand } from "../commands/models-command.js";
import { formatHelp } from "../commands/forge-command.js";
import { readModelsConfig } from "../auto/models-config.js";

const PROVIDER = "anthropic";
const FIRST_REFRESH = "refresh-token-initial-redacted-test";
const SECOND_REFRESH = "refresh-token-appended-redacted-test";

function context(
  cwd: string,
  storage: AuthStorage,
  output: string[],
): ExtensionCommandContext {
  return {
    cwd,
    hasUI: false,
    modelRegistry: { authStorage: storage },
    ui: {
      mode: "headless",
      notify: (message: string) => output.push(message),
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
  } as unknown as ExtensionCommandContext;
}

function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-accounts-models-e2e-"));
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "\n```yaml\nmodels:\n  pools:\n    claude: [anthropic/opus]\n  roles:\n    planner: [claude]\n  constraints:\n    reviewer_not_author: family\n```\n",
  );
  writeFileSync(
    join(cwd, "auth.json"),
    JSON.stringify({
      [PROVIDER]: { type: "oauth", refresh: FIRST_REFRESH, access: "access-initial", expires: 4102444800000 },
    }),
  );
  return cwd;
}

describe("/forge accounts + /forge models production handlers", () => {
  test("add appends to a real auth.json array and fresh storage reads it", async () => {
    const cwd = fixture();
    const previousAgentDir = process.env.GSD_CODING_AGENT_DIR;
    process.env.GSD_CODING_AGENT_DIR = cwd;
    try {
      assert.equal(getAuthPath(), join(cwd, "auth.json"));
      const storage = AuthStorage.create(join(cwd, "auth.json"));
      const initial = storage.getCredentialsForProvider(PROVIDER);
      assert.equal(initial.length, 1);

      const oauthProvider = {
        id: PROVIDER,
        name: "Fake Anthropic",
        login: async () => ({ refresh: SECOND_REFRESH, access: "access-appended", expires: 4102444800000 }),
      };
      (storage as unknown as { getOAuthProviders: () => typeof oauthProvider[] }).getOAuthProviders = () => [oauthProvider];
      const output: string[] = [];
      await runAccountsCommand(context(cwd, storage, output), ["add", PROVIDER]);

      const raw = JSON.parse(readFileSync(join(cwd, "auth.json"), "utf8")) as Record<string, unknown>;
      assert.ok(Array.isArray(raw[PROVIDER]));
      assert.equal((raw[PROVIDER] as unknown[]).length, 2);
      const fresh = AuthStorage.create(join(cwd, "auth.json"));
      const credentials = fresh.getCredentialsForProvider(PROVIDER);
      assert.equal(credentials.length, 2);
      assert.equal((credentials[1] as { refresh: string }).refresh, SECOND_REFRESH);
      assert.equal((credentials[0] as { refresh: string }).refresh, FIRST_REFRESH);

      const rendered: string[] = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        rendered.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await runAccountsCommand(context(cwd, fresh, rendered), []);
      } finally {
        process.stdout.write = originalWrite;
      }
      const listing = rendered.join("\n");
      assert.match(listing, /Contas Forge:/);
      assert.ok(!listing.includes(FIRST_REFRESH));
      assert.ok(!listing.includes(SECOND_REFRESH));
      assert.ok(!listing.includes("access-initial"));
      assert.ok(!listing.includes("access-appended"));
    } finally {
      if (previousAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
      else process.env.GSD_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("models set writes only the local layer and readModelsConfig sees its precedence", async () => {
    const cwd = fixture();
    try {
      const committedPath = join(cwd, ".gsd", "models.md");
      const committed = readFileSync(committedPath);
      const output: string[] = [];
      await runModelsCommand(context(cwd, AuthStorage.inMemory(), output), ["set", "roles", "reviewer", "gpt,claude"]);
      assert.deepEqual(readModelsConfig(cwd).roles.reviewer, ["gpt", "claude"]);
      assert.deepEqual(readFileSync(committedPath), committed);
      const localPath = join(cwd, ".gsd", "models.local.md");
      assert.equal(existsSync(localPath), true);
      assert.match(readFileSync(localPath, "utf8"), /reviewer: \[gpt, claude\]/);
      assert.ok(existsSync(localPath), "the command completed with a persisted local layer");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("help names both operator subcommands with one-line descriptions", () => {
    const help = formatHelp();
    assert.match(help, /accounts\s+—\s+lista.*credenciais/);
    assert.match(help, /models\s+—\s+.*role×pool/);
  });
});
