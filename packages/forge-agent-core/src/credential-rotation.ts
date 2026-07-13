/**
 * `credential-rotation.ts` — the S06/T02 fork-side layer that binds the pure
 * `CredentialCooldownStore` (T01) to a real `AuthStorage`, so a caller can
 * rotate through the credentials array a provider already has (today
 * `AuthStorage.get()` always picks index `[0]` — `auth-storage.ts:319`)
 * instead of being stuck on the first one once it starts failing.
 *
 * Read-only over the vendored package: the only `AuthStorage` surface this
 * module touches is `getCredentialsForProvider(provider)`. Nothing here
 * patches `pi-coding-agent` — `verify-pi-patches.cjs` stays green because
 * there is no patch to register.
 *
 * `CredentialRotator` keeps ONE `CredentialCooldownStore` per provider
 * (lazily created), so exhausting an account under provider A never touches
 * provider B, or another account under A.
 *
 * S04: cooldown is keyed by the credential's stable IDENTITY, not its
 * position in the array (see `credentialIdentity` below and
 * `credential-cooldown.ts`'s doc header) — reordering the source array
 * between `selectCredential` and the matching `markExhausted` no longer
 * cools down the wrong account.
 */

import type { AuthCredential, AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { resolveConfigValue } from "@gsd/pi-coding-agent/core/resolve-config-value.js";
import { CredentialCooldownStore, type CredentialCooldownOptions } from "./credential-cooldown.js";

/**
 * The narrowest slice of `AuthStorage` the rotator needs — lets tests pass a
 * fake object instead of constructing a real `AuthStorage` (mirrors the
 * constructor-injection pattern `FallbackResolver` uses for its
 * `authStorage` dependency, `fallback-resolver.ts:23-28`).
 */
export type CredentialSource = Pick<AuthStorage, "getCredentialsForProvider">;

/**
 * Derives the stable identity of a credential: the field that survives a
 * refresh/rotation and uniquely names the underlying account, never the
 * array position it happens to occupy.
 *
 * - `api_key` — identity is `key` itself (the credential IS the secret).
 * - `oauth` — identity is `refresh` (`pi-ai/utils/oauth/types.ts:3`), not
 *   `access`: the access token rotates on every refresh, but the refresh
 *   token is the stable handle for the account across that rotation.
 *
 * Never logs or exposes the returned string outside this module's callers —
 * it is used only as an internal `Map` key by `CredentialCooldownStore`.
 * Collision of two distinct credentials sharing the same identity string
 * means they ARE the same account, so sharing a cooldown is correct.
 */
export function credentialIdentity(cred: AuthCredential): string {
	return cred.type === "api_key" ? cred.key : cred.refresh;
}

/**
 * Extract the material that can be injected into a native pi-ai request.
 *
 * API-key credentials use the same config-value resolution as vendored
 * `AuthStorage.getApiKey`, including environment variables and commands. OAuth
 * deliberately returns `null`: its access token is rotated by the vendored
 * refresh-with-lock path, so a raw override would bypass that synchronization.
 * The externalCli provider has a separate environment-based seam and is not
 * handled by this native path.
 */
export function injectableRequestKey(cred: AuthCredential): string | null {
	if (cred.type !== "api_key") return null;
	return resolveConfigValue(cred.key) ?? null;
}

export interface SelectedCredential {
	index: number;
	identity: string;
	credential: AuthCredential;
}

/**
 * Structurally identical to `auto/availability.ts`'s `AvailabilityProbe`
 * (`(ref: string) => boolean`). Not imported from there: that module is
 * fork-side extension code in a different build, and its own doc
 * explicitly keeps the coupling to real credentials out of its build
 * (`availability.ts:6-12`) — this bridge is what fills that gap, from the
 * other side, without creating a cross-build import.
 */
export type ProviderAvailabilityProbe = (ref: string) => boolean;

/** Readiness supplied by the live ModelRegistry for providers whose auth may
 * not be represented by rotatable credentials in auth.json (externalCli or
 * environment-backed providers). */
export type ProviderReadinessSignal = (provider: string) => boolean;

/**
 * Binds the pure per-credential-identity cooldown store (T01) to a real
 * `AuthStorage`-shaped source, giving callers `selectCredential` /
 * `markExhausted` for in-process handoff within a provider's credential
 * array — no relaunch, no external supervisor (D7).
 */
export class CredentialRotator {
	private readonly stores = new Map<string, CredentialCooldownStore>();
	private readonly authStorage: CredentialSource;
	private readonly cooldownOptions: CredentialCooldownOptions;

	constructor(authStorage: CredentialSource, cooldownOptions: CredentialCooldownOptions = {}) {
		this.authStorage = authStorage;
		this.cooldownOptions = cooldownOptions;
	}

	private storeFor(provider: string): CredentialCooldownStore {
		let store = this.stores.get(provider);
		if (!store) {
			store = new CredentialCooldownStore(this.cooldownOptions);
			this.stores.set(provider, store);
		}
		return store;
	}

	/**
	 * Re-reads `getCredentialsForProvider(provider)` on every call (neither
	 * the array nor its identities are ever cached), so a
	 * reordered/shrinking/growing array between calls never yields a stale
	 * selection — the caller always sees the current shape. `index` in the
	 * result is the credential's CURRENT position, useful for diagnostics
	 * only; `identity` is what `markExhausted` must be called with to close
	 * the cooldown loop on the right account regardless of later reordering.
	 * Returns `null` when every credential for `provider` is cooling down.
	 */
	selectCredential(provider: string, nowMs: number): SelectedCredential | null {
		const credentials = this.authStorage.getCredentialsForProvider(provider);
		const identities = credentials.map(credentialIdentity);
		const identity = this.storeFor(provider).selectAvailable(identities, nowMs);
		if (identity === null) return null;
		const index = identities.indexOf(identity);
		return { index, identity, credential: credentials[index] };
	}

	/**
	 * Puts `identity` into cooldown for `provider`. This is the in-process
	 * handoff: the very next `selectCredential(provider, nowMs)` call (same
	 * `nowMs` or later) skips `identity` and returns the next available one,
	 * or `null` if none remain. Identity is keyed by the credential's stable
	 * content (`credentialIdentity`), not by its array position, so
	 * reordering the source array between `selectCredential` and this call
	 * never cools down a different credential than the one that was
	 * actually returned.
	 */
	markExhausted(provider: string, identity: string, nowMs: number): void {
		this.storeFor(provider).markExhausted(identity, nowMs);
	}

	/**
	 * Reports cooldown for the credential currently at `index` without exposing
	 * its identity. The source is re-read so this remains correct after a
	 * credential array edit.
	 */
	isCoolingDown(provider: string, index: number, nowMs: number): boolean {
		const credential = this.authStorage.getCredentialsForProvider(provider)[index];
		return credential === undefined
			? false
			: this.storeFor(provider).isCooling(credentialIdentity(credential), nowMs);
	}

	/** True iff the provider currently has at least one rotatable credential. */
	hasRotatableCredentials(provider: string): boolean {
		return this.authStorage.getCredentialsForProvider(provider).length > 0;
	}

	/**
	 * True iff every credential currently in `provider`'s array is cooling
	 * down. Re-reads the array and re-derives identities (same re-read
	 * guarantee as `selectCredential`) so a just-added credential is picked
	 * up immediately.
	 */
	allExhausted(provider: string, nowMs: number): boolean {
		const identities = this.authStorage.getCredentialsForProvider(provider).map(credentialIdentity);
		return this.storeFor(provider).allExhausted(identities, nowMs);
	}
}

/**
 * Builds a `ProviderAvailabilityProbe` — shape-compatible with
 * `auto/availability.ts`'s `AvailabilityProbe` — out of a live
 * `CredentialRotator`. Parses the provider prefix off a flat
 * `"provider/model-id"` ref (the shape `resolveUnitModel` produces) and
 * reports `false` iff the live provider is not ready, or every rotatable
 * credential for that provider is cooled down. Providers ready through an
 * external CLI or environment-backed auth may have no rotatable credentials;
 * the injected readiness signal keeps those providers available. The S03 seam
 * (`role.ts:208 isModelAvailable`) consumes this through the production driver.
 */
export function providerAvailabilityProbe(
	rotator: CredentialRotator,
	nowMs: number,
	isReady?: ProviderReadinessSignal,
): ProviderAvailabilityProbe {
	return (ref: string) => {
		const provider = ref.split("/")[0];
		if (isReady === undefined) return !rotator.allExhausted(provider, nowMs);
		if (!isReady(provider)) return false;
		if (!rotator.hasRotatableCredentials(provider)) return true;
		return !rotator.allExhausted(provider, nowMs);
	};
}
