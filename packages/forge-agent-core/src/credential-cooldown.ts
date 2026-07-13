/**
 * `credential-cooldown.ts` — the S04/T01 pure store: tracks per-credential
 * exhaustion within a single `AuthStorage.getCredentialsForProvider()` array
 * snapshot, and selects the first identity that isn't currently cooling
 * down.
 *
 * This mirrors `AuthStorage.isProviderAvailable` / `markProviderExhausted`
 * (`pi-coding-agent/src/core/auth-storage.ts:366-378`) but on the finer
 * per-account axis instead of the vendored per-provider axis: the vendored
 * backoff knocks out an entire provider for a fixed 60s; this store cools
 * down a single credential, with a configurable, independent TTL, so
 * handing off to the next credential in the array doesn't also knock out the
 * one that just took over.
 *
 * Pure module: no I/O, no `AuthStorage`/`pi-ai`/`pi-coding-agent` import, no
 * argless `Date.now()`/`new Date()` — the clock is injected via `nowMs` on
 * every call, so exhaustion and cooldown expiry are deterministic in tests.
 *
 * Identity is by stable key (S04): `credentialIdentity` (`credential-rotation.ts`)
 * derives it from the credential's own stable field (`key` for api_key,
 * `refresh` for oauth), never from its ARRAY POSITION — reordering the
 * source array between a `selectAvailable` and the matching `markExhausted`
 * no longer cools down the wrong credential (the hazard S06's index-keyed
 * store had). Raw credential content is still never logged or exposed by
 * this module — the identity string is only ever used as an internal `Map`
 * key.
 */

export interface CredentialCooldownOptions {
	/**
	 * Cooldown duration in ms applied by `markExhausted`. Defaults to 60_000
	 * for conceptual parity with the vendored per-provider backoff
	 * (`auth-storage.ts:377`), but is a SEPARATE knob — this store never
	 * reads or mutates the vendored `providerBackoff` map.
	 */
	cooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Per-credential-identity cooldown store, scoped to one provider's
 * credential array. The identity list is passed per-call rather than
 * captured at construction, since the caller re-derives it from
 * `getCredentialsForProvider()` on each attempt and the array shape is the
 * caller's concern, not this store's.
 */
export class CredentialCooldownStore {
	private readonly cooldownMs: number;
	private readonly cooldownUntilMs = new Map<string, number>();

	constructor(options: CredentialCooldownOptions = {}) {
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	}

	/**
	 * Returns the first identity in `identities` whose cooldown has expired
	 * or was never set. An expired entry is cleared as a side effect (mirrors
	 * `isProviderAvailable`'s lazy cleanup at `auth-storage.ts:369-371`), so a
	 * later `allExhausted` walk over the same store doesn't re-pay the
	 * expired check. Returns `null` when every identity in the list is
	 * cooling down.
	 */
	selectAvailable(identities: string[], nowMs: number): string | null {
		for (const identity of identities) {
			const expiresAtMs = this.cooldownUntilMs.get(identity);
			if (expiresAtMs === undefined) return identity;
			if (nowMs >= expiresAtMs) {
				this.cooldownUntilMs.delete(identity);
				return identity;
			}
		}
		return null;
	}

	/**
	 * Puts `identity` into cooldown until `nowMs + cooldownMs`. A
	 * `selectAvailable` call at the same `nowMs` will skip it and hand off to
	 * the next available identity (or `null` if none remain) — regardless of
	 * where in the source array that identity now sits.
	 */
	markExhausted(identity: string, nowMs: number): void {
		this.cooldownUntilMs.set(identity, nowMs + this.cooldownMs);
	}

	/** Returns whether one identity is still inside its cooldown window. */
	isCooling(identity: string, nowMs: number): boolean {
		const expiresAtMs = this.cooldownUntilMs.get(identity);
		if (expiresAtMs === undefined) return false;
		if (nowMs >= expiresAtMs) {
			this.cooldownUntilMs.delete(identity);
			return false;
		}
		return true;
	}

	/**
	 * True iff `selectAvailable(identities, nowMs)` would return `null` — the
	 * single predicate the T02 provider-availability bridge consumes to
	 * decide "this provider is fully cooled down" without duplicating the
	 * walk.
	 */
	allExhausted(identities: string[], nowMs: number): boolean {
		return this.selectAvailable(identities, nowMs) === null;
	}
}
