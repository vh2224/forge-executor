import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AuthCredential } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { CredentialRotator, type CredentialSource } from "./credential-rotation.js";
import {
	addAccount,
	describeAccountStatus,
	listAccounts,
	removeAccount,
} from "./account-store.js";

const api = (key: string): AuthCredential => ({ type: "api_key", key });
const oauth = (refresh: string): AuthCredential => ({
	type: "oauth",
	refresh,
	access: `${refresh}-access-token`,
	expires: 0,
});

const directories: string[] = [];
function authFile(initial: unknown): string {
	const directory = mkdtempSync(join(tmpdir(), "forge-account-store-"));
	directories.push(directory);
	const path = join(directory, "auth.json");
	writeFileSync(path, JSON.stringify(initial));
	return path;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function source(data: Record<string, AuthCredential[]>): CredentialSource {
	return { getCredentialsForProvider: (provider) => data[provider] ?? [] };
}

function stored(path: string): Record<string, AuthCredential | AuthCredential[]> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, AuthCredential | AuthCredential[]>;
}

describe("account-store", () => {
	it("lists credentials in array order with redacted labels", () => {
		const secret = "refresh-secret-that-must-not-appear";
		const views = listAccounts(source({ anthropic: [oauth(secret), api("api-secret")] }), "anthropic");
		assert.deepEqual(views, [
			{ index: 0, type: "oauth", label: "oauth · …pear" },
			{ index: 1, type: "api_key", label: "api_key · stored" },
		]);
		assert.equal(JSON.stringify(views).includes(secret), false);
	});

	it("appends without replacing existing credentials", () => {
		const path = authFile({ anthropic: [api("first"), api("second")] });
		addAccount(path, "anthropic", oauth("third-refresh"));
		assert.deepEqual(stored(path).anthropic, [api("first"), api("second"), oauth("third-refresh")]);
	});

	it("removes exactly the selected index", () => {
		const path = authFile({ anthropic: [api("first"), api("second"), api("third")] });
		removeAccount(path, "anthropic", 1);
		assert.deepEqual(stored(path).anthropic, [api("first"), api("third")]);
	});

	it("clears the provider entry when removing its last account", () => {
		const path = authFile({ anthropic: api("only") });
		removeAccount(path, "anthropic", 0);
		assert.deepEqual(stored(path), {});
	});

	it("projects provider backoff and per-account cooldown with an injected clock", () => {
		const first = api("first-secret");
		const second = api("second-secret");
		const data = { openai: [first, second] };
		const rotator = new CredentialRotator(source(data), { cooldownMs: 1000 });
		rotator.markExhausted("openai", "first-secret", 100);
		const accounts = listAccounts(source(data), "openai");
		assert.deepEqual(describeAccountStatus(rotator, 0, "openai", accounts, 500).map(({ index, label, cooldown }) => ({ index, label, cooldown })), [
			{ index: 0, label: "api_key · stored", cooldown: "cooling" },
			{ index: 1, label: "api_key · stored", cooldown: "ready" },
		]);
		assert.equal(describeAccountStatus(rotator, 25, "openai", accounts, 500)[0]?.cooldown, "provider-backoff");
		const output = JSON.stringify(describeAccountStatus(rotator, 0, "openai", accounts, 500));
		assert.equal(output.includes("first-secret"), false);
		assert.equal(output.includes("second-secret"), false);
	});
});
