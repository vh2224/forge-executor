import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CredentialRotator,
	credentialIdentity,
	injectableRequestKey,
	providerAvailabilityProbe,
	type CredentialSource,
} from "./credential-rotation.js";

function apiKey(key: string) {
	return { type: "api_key" as const, key };
}

function oauth(refresh: string, access = `${refresh}-access`, expires = 0) {
	return { type: "oauth" as const, refresh, access, expires };
}

const credA = apiKey("openai-account-1");
const credB = apiKey("openai-account-2");
const claudeCredA = apiKey("claude-account-1");

/** Fake `AuthStorage`: a plain provider→array map the test can mutate directly (item e). */
function fakeAuthStorage(data: Record<string, ReturnType<typeof apiKey>[]>): CredentialSource {
	return {
		getCredentialsForProvider: (provider: string) => data[provider] ?? [],
	};
}

describe("credentialIdentity", () => {
	it("derives identity from key for api_key credentials", () => {
		assert.equal(credentialIdentity(apiKey("k")), "k");
	});

	it("derives identity from refresh for oauth credentials, never from access", () => {
		const cred = oauth("refresh-token", "access-token", 0);
		assert.equal(credentialIdentity(cred), "refresh-token");
		assert.notEqual(credentialIdentity(cred), cred.access);
	});
});

describe("injectableRequestKey", () => {
	it("resolves api_key material using the vendored config-value rules", () => {
		const previous = process.env.FORGE_TEST_REQUEST_KEY;
		process.env.FORGE_TEST_REQUEST_KEY = "resolved-request-key";
		try {
			assert.equal(injectableRequestKey(apiKey("FORGE_TEST_REQUEST_KEY")), "resolved-request-key");
		} finally {
			if (previous === undefined) delete process.env.FORGE_TEST_REQUEST_KEY;
			else process.env.FORGE_TEST_REQUEST_KEY = previous;
		}
	});

	it("returns null for oauth so vendored refresh remains authoritative", () => {
		assert.equal(injectableRequestKey(oauth("refresh-token", "access-token")), null);
	});
});

describe("CredentialRotator", () => {
	it("selects the first credential in the array when nothing is exhausted", () => {
		const authStorage = fakeAuthStorage({ openai: [credA, credB] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });

		const selected = rotator.selectCredential("openai", 0);
		assert.deepEqual(selected, { index: 0, identity: "openai-account-1", credential: credA });
	});

	it("hands off to the next credential in-process after markExhausted, same nowMs, no relaunch", () => {
		const authStorage = fakeAuthStorage({ openai: [credA, credB] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });

		rotator.markExhausted("openai", "openai-account-1", 0);
		const selected = rotator.selectCredential("openai", 0);
		assert.deepEqual(selected, { index: 1, identity: "openai-account-2", credential: credB });
	});

	it("returns null once every credential for the provider is exhausted", () => {
		const authStorage = fakeAuthStorage({ openai: [credA, credB] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });

		rotator.markExhausted("openai", "openai-account-1", 0);
		rotator.markExhausted("openai", "openai-account-2", 0);
		assert.equal(rotator.selectCredential("openai", 0), null);
	});

	it("keeps one cooldown store per provider — exhausting openai's account never touches claude", () => {
		const authStorage = fakeAuthStorage({
			openai: [credA, credB],
			claude: [claudeCredA],
		});
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });

		rotator.markExhausted("openai", "openai-account-1", 0);
		rotator.markExhausted("openai", "openai-account-2", 0);

		assert.equal(rotator.allExhausted("openai", 0), true);
		assert.equal(rotator.allExhausted("claude", 0), false);
		assert.deepEqual(rotator.selectCredential("claude", 0), {
			index: 0,
			identity: "claude-account-1",
			credential: claudeCredA,
		});
	});

	it("re-reads getCredentialsForProvider on every call — a stale selection is never returned when the array shrinks/grows", () => {
		const data: Record<string, ReturnType<typeof apiKey>[]> = { openai: [credA] };
		const authStorage = fakeAuthStorage(data);
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });

		rotator.markExhausted("openai", "openai-account-1", 0);
		assert.equal(rotator.selectCredential("openai", 0), null, "the only credential is cooling down");

		// Array grows between calls (e.g. the user added a second account) —
		// the rotator must pick this up without any re-construction.
		data.openai = [credA, credB];
		assert.deepEqual(
			rotator.selectCredential("openai", 0),
			{ index: 1, identity: "openai-account-2", credential: credB },
			"newly-added identity is selectable immediately — no cached identity list",
		);
	});

	it("markExhausted expires after cooldownMs — a later selectCredential call sees the credential recover", () => {
		const authStorage = fakeAuthStorage({ openai: [credA, credB] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });

		rotator.markExhausted("openai", "openai-account-1", 0);
		assert.deepEqual(rotator.selectCredential("openai", 999), {
			index: 1,
			identity: "openai-account-2",
			credential: credB,
		});
		assert.deepEqual(
			rotator.selectCredential("openai", 1_000),
			{ index: 0, identity: "openai-account-1", credential: credA },
			"the identity recovers exactly at t0+cooldownMs",
		);
	});

	it("reordering the source array between selectCredential and markExhausted still cools down the credential that was actually selected", () => {
		// select [A, B] -> A (index 0). Reorder the underlying source to
		// [B, A] BEFORE calling markExhausted with the selection's identity.
		// The S06 hazard: an index-keyed store would now cool down "index 0",
		// which after the reorder is B — the wrong credential, leaving the
		// truly exhausted A selectable again. Identity-keyed cooldown must
		// cool down A regardless.
		const data: Record<string, ReturnType<typeof apiKey>[]> = { openai: [credA, credB] };
		const authStorage = fakeAuthStorage(data);
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });

		const first = rotator.selectCredential("openai", 0);
		assert.deepEqual(first, { index: 0, identity: "openai-account-1", credential: credA });

		// Reorder the mutable fake source between select and markExhausted.
		data.openai = [credB, credA];

		assert.ok(first);
		rotator.markExhausted("openai", first.identity, 0);

		// Re-select against the reordered array: B (never exhausted) must be
		// returned, not A (which is cooling down despite now sitting at
		// index 1).
		const second = rotator.selectCredential("openai", 0);
		assert.deepEqual(
			second,
			{ index: 0, identity: "openai-account-2", credential: credB },
			"B is selectable — position no longer determines which credential cools down",
		);
	});
});

describe("providerAvailabilityProbe", () => {
	it("reports true for a provider/model ref while at least one credential is available", () => {
		const authStorage = fakeAuthStorage({ openai: [credA, credB] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });
		const probe = providerAvailabilityProbe(rotator, 0);

		assert.equal(probe("openai/gpt-5.5"), true);
	});

	it("reports false for a provider/model ref once every credential for that provider is exhausted", () => {
		const authStorage = fakeAuthStorage({ openai: [credA, credB] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });

		rotator.markExhausted("openai", "openai-account-1", 0);
		rotator.markExhausted("openai", "openai-account-2", 0);
		const probe = providerAvailabilityProbe(rotator, 0);

		assert.equal(probe("openai/gpt-5.5"), false);
	});

	it("isolates providers — exhausting openai leaves a claude ref's probe result unaffected", () => {
		const authStorage = fakeAuthStorage({
			openai: [credA, credB],
			claude: [claudeCredA],
		});
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });

		rotator.markExhausted("openai", "openai-account-1", 0);
		rotator.markExhausted("openai", "openai-account-2", 0);
		const probe = providerAvailabilityProbe(rotator, 0);

		assert.equal(probe("openai/gpt-5.5"), false, "openai is fully cooled down");
		assert.equal(probe("claude/claude-opus-5"), true, "claude is untouched by openai's exhaustion");
	});

	it("parses only the provider prefix off a flat provider/model-id ref", () => {
		const authStorage = fakeAuthStorage({ openai: [] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });
		const probe = providerAvailabilityProbe(rotator, 0);

		// Without a readiness signal, preserve the historical conservative result.
		assert.equal(probe("openai/gpt-5.5-with/slash-in-id"), false);
	});

	it("reports externalCli as available when readiness is true and credentials are empty", () => {
		const rotator = new CredentialRotator(fakeAuthStorage({ "claude-code": [] }));
		const probe = providerAvailabilityProbe(rotator, 0, (provider) => provider === "claude-code");

		assert.equal(probe("claude-code/claude-opus-4-8"), true);
	});

	it("reports an env-var-only provider as available when readiness is true", () => {
		const rotator = new CredentialRotator(fakeAuthStorage({ openai: [] }));
		const probe = providerAvailabilityProbe(rotator, 0, (provider) => provider === "openai");

		assert.equal(probe("openai/gpt-5.5"), true);
	});

	it("preserves cooldown exhaustion for ready providers with rotatable credentials", () => {
		const authStorage = fakeAuthStorage({ openai: [credA, credB] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 1_000 });
		rotator.markExhausted("openai", credA.key, 0);
		rotator.markExhausted("openai", credB.key, 0);
		const probe = providerAvailabilityProbe(rotator, 0, () => true);

		assert.equal(probe("openai/gpt-5.5"), false);
	});

	it("reports false when readiness is false even if the credential array is empty", () => {
		const rotator = new CredentialRotator(fakeAuthStorage({ openai: [] }));
		const probe = providerAvailabilityProbe(rotator, 0, () => false);

		assert.equal(probe("openai/gpt-5.5"), false);
	});
});
