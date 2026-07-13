import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentSessionModelModule } from "./agent-session-model.js";

const model = { provider: "anthropic", id: "claude-test" } as any;

function hostFor(sequence: Array<{ ok: boolean; apiKey?: string; error?: string }>, credentials = true, oauth = true) {
	let index = 0;
	return {
		modelRegistry: {
			getApiKeyAndHeaders: async () => sequence[Math.min(index++, sequence.length - 1)],
			isUsingOAuth: () => oauth,
			authStorage: {
				getCredentialsForProvider: () => credentials ? [{ type: "oauth", refresh: "stable-refresh" }] : [],
			},
		},
	} as any;
}

async function errorOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		assert.fail("expected authentication to fail");
	} catch (error) {
		return (error as Error).message;
	}
}

describe("OAuth refresh resilience", () => {
	it("retries on the next turn and recovers when refresh succeeds", async () => {
		const host = hostFor([
			{ ok: false, error: "Failed to refresh OAuth token for anthropic" },
			{ ok: true, apiKey: "recovered-token" },
		]);
		const sessionModel = new AgentSessionModelModule(host);

		const first = await errorOf(sessionModel.getRequiredRequestAuth(model));
		assert.match(first, /OAuth refresh temporarily unavailable/);
		assert.doesNotMatch(first, /Run '\/login/);
		assert.deepEqual(await sessionModel.getRequiredRequestAuth(model), { apiKey: "recovered-token", headers: undefined });
	});

	it("returns terminal re-login after the bounded retry budget", async () => {
		const host = hostFor([{ ok: false, error: "Failed to refresh OAuth token for anthropic" }]);
		const sessionModel = new AgentSessionModelModule(host);
		for (let attempt = 0; attempt < 3; attempt++) {
			assert.match(await errorOf(sessionModel.getRequiredRequestAuth(model)), /retrying on the next turn/);
		}
		assert.match(await errorOf(sessionModel.getRequiredRequestAuth(model)), /Run '\/login anthropic/);
	});

	it("keeps missing OAuth credentials terminal", async () => {
		const host = hostFor([{ ok: false, error: "Failed to refresh OAuth token for anthropic" }], false);
		assert.match(await errorOf(new AgentSessionModelModule(host).getRequiredRequestAuth(model)), /Failed to refresh/);
	});

	it("does not change the non-OAuth no-key path", async () => {
		const host = hostFor([{ ok: true }], false, false);
		assert.match(await errorOf(new AgentSessionModelModule(host).getRequiredRequestAuth(model)), /No API key found/);
	});
});
