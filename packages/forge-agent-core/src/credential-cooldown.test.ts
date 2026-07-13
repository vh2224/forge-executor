import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CredentialCooldownStore } from "./credential-cooldown.js";

describe("CredentialCooldownStore", () => {
	it("selects the first identity first when nothing is exhausted", () => {
		const store = new CredentialCooldownStore();
		assert.equal(store.selectAvailable(["a", "b", "c"], 0), "a");
		assert.equal(store.allExhausted(["a", "b", "c"], 0), false);
	});

	it("hands off to the next identity after markExhausted", () => {
		const store = new CredentialCooldownStore({ cooldownMs: 1_000 });
		store.markExhausted("a", 0);
		assert.equal(store.selectAvailable(["a", "b", "c"], 0), "b");
		assert.equal(store.allExhausted(["a", "b", "c"], 0), false);
	});

	it("returns null and allExhausted=true once every identity is cooling down", () => {
		const store = new CredentialCooldownStore({ cooldownMs: 1_000 });
		store.markExhausted("a", 0);
		store.markExhausted("b", 0);
		assert.equal(store.selectAvailable(["a", "b"], 0), null);
		assert.equal(store.allExhausted(["a", "b"], 0), true);
	});

	it("recovers an exhausted identity once cooldownMs has elapsed (not just a one-shot rotation)", () => {
		const store = new CredentialCooldownStore({ cooldownMs: 1_000 });
		store.markExhausted("a", 0);
		assert.equal(store.selectAvailable(["a", "b"], 500), "b", "still cooling down before the TTL elapses");
		assert.equal(store.selectAvailable(["a", "b"], 999), "b", "still cooling down 1ms before expiry");
		assert.equal(store.selectAvailable(["a", "b"], 1_000), "a", "selectable again exactly at t0+cooldownMs");
	});

	it("keeps recovered identities available across repeated selects, not just the first post-expiry call", () => {
		const store = new CredentialCooldownStore({ cooldownMs: 1_000 });
		store.markExhausted("a", 0);
		store.markExhausted("b", 0);
		assert.equal(store.allExhausted(["a", "b"], 999), true);
		// "a" expires at 1_000, "b" at 1_000 too (both marked at t0) — both
		// should be selectable again, starting from "a".
		assert.equal(store.selectAvailable(["a", "b"], 1_000), "a");
		assert.equal(store.selectAvailable(["a", "b"], 1_000), "a", "expired entry stays available, not consumed by the read");
	});

	it("uses a cooldownMs distinct from the vendored 60s per-provider backoff when configured", () => {
		const store = new CredentialCooldownStore({ cooldownMs: 5_000 });
		store.markExhausted("a", 0);
		assert.equal(store.selectAvailable(["a", "b"], 4_999), "b", "still cooling down 1ms before the custom 5s TTL expiry");
		assert.equal(store.selectAvailable(["a", "b"], 5_000), "a", "recovers at the custom 5s TTL boundary, well before 60s");
		// but a fresh store with no options defaults to 60_000 for conceptual parity
		const defaulted = new CredentialCooldownStore();
		defaulted.markExhausted("a", 0);
		assert.equal(defaulted.selectAvailable(["a", "b"], 59_999), "b", "still cooling down 1ms before the 60s default expiry");
		assert.equal(defaulted.selectAvailable(["a", "b"], 60_000), "a", "recovers at the 60s default boundary");
	});

	it("identifies credentials by stable IDENTITY, never by array position — reordering the identity list between calls follows the identity, not the slot", () => {
		const store = new CredentialCooldownStore({ cooldownMs: 1_000 });

		// select() with [A, B] -> A is first. Reorder to [B, A] before
		// markExhausted(A): the store must still cool down A specifically,
		// not "whatever is now at index 0" (which would be B).
		const selected = store.selectAvailable(["identity-a", "identity-b"], 0);
		assert.equal(selected, "identity-a");

		store.markExhausted(selected as string, 0);

		// Re-select against the REORDERED list: B must be selectable (it was
		// never exhausted), A must be skipped (it was, regardless of its new
		// position in the list).
		assert.equal(
			store.selectAvailable(["identity-b", "identity-a"], 0),
			"identity-b",
			"reordering never changes WHICH identity is cooling down",
		);
		assert.equal(store.allExhausted(["identity-b", "identity-a"], 0), false);
	});

	it("distinguishes identities regardless of underlying secret content — two same-shaped identity lists share the same store logic", () => {
		const store = new CredentialCooldownStore({ cooldownMs: 1_000 });
		const providerAIdentities = ["key-a-primary", "key-a-secondary"];
		const providerBIdentities = ["totally-different-secret", "another-different-secret"];

		// Same store, same identity semantics regardless of what the
		// underlying content is.
		assert.equal(store.selectAvailable(providerAIdentities, 0), "key-a-primary");
		store.markExhausted("key-a-primary", 0);
		assert.equal(store.selectAvailable(providerBIdentities, 0), "totally-different-secret");

		// The store's public API surface takes only identities/lists/timestamps.
		assert.equal(store.markExhausted.length, 2);
		assert.equal(store.selectAvailable.length, 2);
		assert.equal(store.allExhausted.length, 2);
	});

	it("treats an identity with no prior markExhausted call as always available", () => {
		const store = new CredentialCooldownStore();
		assert.equal(store.selectAvailable(["only"], 0), "only");
		assert.equal(store.selectAvailable(["only"], 1_000_000), "only");
		assert.equal(store.allExhausted(["only"], 0), false);
	});
});
