import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const commandPath = join(process.cwd(), "src/resources/extensions/forge/commands/accounts-command.ts");
const routerPath = join(process.cwd(), "src/resources/extensions/forge/commands/forge-command.ts");

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("/forge accounts command contract", () => {
  test("has list/add/remove routing and delegates persistence", () => {
    const body = source(commandPath);
    assert.match(body, /export async function runAccountsCommand/);
    assert.match(body, /subcommand === "list"/);
    assert.match(body, /subcommand === "add"/);
    assert.match(body, /subcommand === "remove"/);
    assert.match(body, /listAccounts\(storage, provider\)/);
    assert.match(body, /addAccount\(getAuthPath\(\), providerId/);
    assert.match(body, /removeAccount\(getAuthPath\(\), provider, index\)/);
  });

  test("renders only redacted account projections and cooldown state", () => {
    const body = source(commandPath);
    assert.match(body, /describeAccountStatus/);
    assert.match(body, /getProviderBackoffRemaining\(provider\)/);
    assert.match(body, /account\.label/);
    assert.doesNotMatch(body, /credential\.refresh/);
    assert.doesNotMatch(body, /credential\.access/);
    assert.match(body, /cooldown/);
  });

  test("OAuth add uses provider login and appends after login", () => {
    const body = source(commandPath);
    assert.match(body, /getOAuthProviders\(\)/);
    assert.match(body, /provider\.login\(callbacks\(ctx\)\)/);
    assert.match(body, /storage\.reload\(\)/);
    assert.match(body, /type: "oauth"/);
  });

  test("remove confirms before mutating", () => {
    const body = source(commandPath);
    const confirm = body.indexOf("ctx.ui.confirm");
    const remove = body.indexOf("removeAccount(getAuthPath()");
    assert.ok(confirm >= 0);
    assert.ok(remove > confirm);
  });

  test("router exposes both account and model commands", () => {
    const body = source(routerPath);
    assert.match(body, /runAccountsCommand/);
    assert.match(body, /runModelsCommand/);
    assert.match(body, /case "accounts"/);
    assert.match(body, /case "models"/);
    assert.match(body, /isPrintHeadlessContext/);
  });

  test("the display contract cannot contain raw credential field access", () => {
    const body = source(commandPath);
    const renderStart = body.indexOf("function renderAccounts");
    const renderEnd = body.indexOf("function callbacks");
    const render = body.slice(renderStart, renderEnd);
    assert.ok(renderStart >= 0 && renderEnd > renderStart);
    assert.doesNotMatch(render, /refresh|access|key/);
    assert.match(render, /provider/);
    assert.match(render, /pronto/);
  });
});
