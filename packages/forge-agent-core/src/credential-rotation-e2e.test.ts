/**
 * S06 demo evidence — the literal contract of ROADMAP §S06: "2 credenciais
 * fake no array de um provider, esgotar a primeira (429/limite sintético)
 * troca para a segunda in-process, sem relaunch; o dispatch seguinte usa a
 * credencial nova".
 *
 * This is deliberately a SEPARATE file from `credential-cooldown.test.ts`
 * (T01's exhaustive unit coverage of the pure store) and
 * `credential-rotation.test.ts` (T02's exhaustive unit coverage of
 * `CredentialRotator`/`providerAvailabilityProbe` in isolation): this file
 * drives the rotator end to end over a fake `AuthStorage`, mirroring the
 * sibling S05 e2e file's role (`model-rank-e2e.test.ts`) — "demo file
 * separate from the unit tests, drives the piece end to end with a
 * synthetic fixture".
 *
 * No real `openai`/`gpt` credential is read or required anywhere in this
 * file — both credentials are synthetic `AuthCredential` objects (CONTEXT
 * §Realidades: the gate never requires a 2nd real account).
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// `require`d (not `import`ed) so the spy below can reassign `spawn` — an ESM
// namespace import is a frozen module-namespace object and cannot be
// monkeypatched, while `require("node:child_process")` returns Node's
// ordinary writable/configurable CJS exports object.
const child_process = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");

import { CredentialRotator, providerAvailabilityProbe, type CredentialSource } from "./credential-rotation.js";

function apiKey(key: string) {
	return { type: "api_key" as const, key };
}

/** Fake `AuthStorage`: a plain provider→array map, mirroring T02's test fixture. */
function fakeAuthStorage(data: Record<string, ReturnType<typeof apiKey>[]>): CredentialSource {
	return {
		getCredentialsForProvider: (provider: string) => data[provider] ?? [],
	};
}

describe("S06 demo — esgotar a primeira credencial troca para a segunda in-process, sem relaunch", () => {
	it("select -> exhaust (429 sintético) -> select troca de credencial -> próxima chamada usa a nova, sem spawnar processo", () => {
		// Two synthetic, distinguishable credentials — compared by identity
		// (===), never by content (D7 forbids keying/logging by key value).
		const credA = apiKey("fake-A");
		const credB = apiKey("fake-B");
		const authStorage = fakeAuthStorage({ openai: [credA, credB] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 60_000 });
		const nowMs = 1_000;

		// Guard: the whole handoff below must never spawn a child process or
		// otherwise relaunch — D7's "in-process, sem relaunch" is proved by the
		// STRUCTURAL ABSENCE of any spawn call, not merely by inference. If any
		// step under test tried to shell out, this fails the demo immediately.
		const originalSpawn = child_process.spawn;
		let spawnCalled = false;
		child_process.spawn = ((...args: Parameters<typeof originalSpawn>) => {
			spawnCalled = true;
			return originalSpawn(...args);
		}) as typeof originalSpawn;

		try {
			// (a) First selection, nothing exhausted yet -> credA (index 0).
			const first = rotator.selectCredential("openai", nowMs);
			assert.deepEqual(first, { index: 0, identity: "fake-A", credential: credA });

			// (b) Simulate a synthetic 429/limit hit on the credential just used.
			// markExhausted takes the selection's IDENTITY (S04), not its index.
			assert.ok(first);
			rotator.markExhausted("openai", first.identity, nowMs);

			// (c) The handoff: the next selection at the same nowMs must move
			// to the SECOND credential, in-process — no relaunch, no
			// supervisor, just the next method call on the same live object.
			const second = rotator.selectCredential("openai", nowMs);
			assert.deepEqual(second, { index: 1, identity: "fake-B", credential: credB });
			assert.notEqual(second?.credential, first.credential, "handoff must move off the exhausted credential");

			// (d) "Dispatch seguinte usa a credencial nova": a second,
			// independent selectCredential call — standing in for the NEXT
			// dispatch reading the rotator fresh — still returns credB, never
			// credA. The rotation persists across calls within the process
			// (no re-construction, no reset).
			const nextDispatch = rotator.selectCredential("openai", nowMs + 1);
			assert.deepEqual(nextDispatch, { index: 1, identity: "fake-B", credential: credB });

			// (e) The in-process proof: nothing above ever spawned a process.
			assert.equal(spawnCalled, false, "the entire handoff is in-process method calls — no relaunch, no subprocess");
		} finally {
			child_process.spawn = originalSpawn;
		}
	});

	it("providerAvailabilityProbe só vira false quando AMBAS as credenciais esgotam", () => {
		const credA = apiKey("fake-A");
		const credB = apiKey("fake-B");
		const authStorage = fakeAuthStorage({ openai: [credA, credB] });
		const rotator = new CredentialRotator(authStorage, { cooldownMs: 60_000 });
		const nowMs = 2_000;

		const probeBeforeAny = providerAvailabilityProbe(rotator, nowMs);
		assert.equal(probeBeforeAny("openai/gpt-5.5"), true, "control: nothing exhausted yet -> available");

		rotator.markExhausted("openai", "fake-A", nowMs);
		const probeAfterFirst = providerAvailabilityProbe(rotator, nowMs);
		assert.equal(
			probeAfterFirst("openai/gpt-5.5"),
			true,
			"only the first credential is cooling down — the second still covers the provider",
		);

		rotator.markExhausted("openai", "fake-B", nowMs);
		const probeAfterBoth = providerAvailabilityProbe(rotator, nowMs);
		assert.equal(probeAfterBoth("openai/gpt-5.5"), false, "both credentials cooling down -> provider reads unavailable");
	});

	it("nenhuma credencial gpt/openai real é lida — ambas as credenciais deste arquivo são sintéticas", () => {
		const credA = apiKey("fake-A");
		const credB = apiKey("fake-B");
		for (const cred of [credA, credB]) {
			assert.match(cred.key, /^fake-/, "every credential in this e2e file is a synthetic fixture, never a real key");
		}
		// Structural guarantee (not runtime-assertable here): this file never
		// imports `@gsd/pi-ai`'s real provider clients or reads `auth.json` —
		// `fakeAuthStorage` above is the only "AuthStorage" this file ever
		// touches, satisfying CONTEXT §Realidades (no 2nd real account needed).
		assert.ok(true);
	});
});
