import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	armRendezvous,
	awaitUnitResult,
	cancelRendezvous,
	deliverUnitResult,
	hasPendingRendezvous,
} from "../worker/rendezvous.ts";

// ── Regression: rendezvous single-slot serialization contract (S07 §Decisão B) ──
//
// The module-level `pending` slot has no per-caller identity of its own; the
// guarantee that a LATE delivery/cancel from an abandoned arm can never
// corrupt a SUBSEQUENT arm rests entirely on two things already present in
// `rendezvous.ts`:
//   1. `armRendezvous` defensively drops any still-open `pending` (:67-70) —
//      so at most one arm is ever live, by construction (arm-after-drain).
//   2. `deliverUnitResult`/`cancelRendezvous` are token-guarded (:118, :147) —
//      a caller whose token does not match the CURRENT `pending.token` is a
//      no-op `"stale"`, never touching the live rendezvous.
// This suite locks that contract as a regression: arm(N) -> arm(N+1) ->
// late-delivery/cancel-of-N must be "stale" no-ops that leave N+1 untouched,
// and the happy path (deliver on the CURRENT token) must still settle.

afterEach(() => {
	cancelRendezvous();
});

describe("rendezvous — arm-after-drain + token-guarded serialization contract", () => {
	test("a LATE delivery carrying the dropped arm's token is a stale no-op and does not settle/clear the current arm", async () => {
		const a = armRendezvous(5_000);
		const b = armRendezvous(5_000); // second arm defensively drops A's pending (rendezvous.ts:67-70)

		assert.equal(hasPendingRendezvous(), true, "B is armed and pending");

		// A late delivery correlated to A's (dropped) token must not touch B.
		assert.equal(
			deliverUnitResult({ status: "done", summary: "A tardio", artifacts: [] }, a.token),
			"stale",
			"A's token no longer matches the current pending (B)",
		);
		assert.equal(hasPendingRendezvous(), true, "B's rendezvous survives A's stale delivery");

		// B still settles correctly from its OWN token — the happy path is intact.
		assert.equal(
			deliverUnitResult({ status: "done", summary: "B result", artifacts: [] }, b.token),
			"delivered",
			"B settles from its own current token",
		);
		assert.equal(hasPendingRendezvous(), false, "B's arm is drained after delivery");

		const outcome = await b.outcome;
		assert.deepStrictEqual(outcome, {
			kind: "result",
			result: { status: "done", summary: "B result", artifacts: [] },
		});

		// A's outcome does NOT resolve with a result — its arm was dropped by
		// B's arm; A would only ever settle via its own timeout (B4), never via
		// a stale delivery. We do not await a.outcome here (it would hang for
		// 5s until the timer fires) — the point is proven by the "stale" return
		// above and by B settling correctly from its own token.
	});

	test("a LATE cancelRendezvous of the dropped arm's token is a stale no-op and leaves the current arm intact", () => {
		const a = armRendezvous(5_000);
		const b = armRendezvous(5_000); // second arm drops A's pending

		assert.equal(hasPendingRendezvous(), true, "B is armed and pending");

		assert.equal(cancelRendezvous(a.token), "stale", "A's token no longer matches the current pending (B)");
		assert.equal(hasPendingRendezvous(), true, "B's rendezvous survives A's stale cancel");

		assert.equal(cancelRendezvous(b.token), "cancelled", "B cancels correctly from its own current token");
		assert.equal(hasPendingRendezvous(), false, "B's arm is drained after cancel");
	});

	test("happy path: delivering on the currently-pending arm's own token settles exactly that arm's outcome", async () => {
		const r = armRendezvous(5_000);
		assert.equal(hasPendingRendezvous(), true);

		const payload = { status: "done" as const, summary: "feito", artifacts: ["src/x.ts"] };
		assert.equal(deliverUnitResult(payload, r.token), "delivered");
		assert.equal(hasPendingRendezvous(), false);

		const outcome = await r.outcome;
		assert.deepStrictEqual(outcome, {
			kind: "result",
			result: payload,
		});
	});

	test("delivering with token left undefined is unconditional back-compat delivery for legacy callers", async () => {
		const outcomePromise = awaitUnitResult(5_000);
		assert.equal(hasPendingRendezvous(), true);

		const payload = { status: "partial" as const, summary: "sem token", artifacts: [] };
		assert.equal(
			deliverUnitResult(payload),
			"delivered",
			"undefined token delivers into whatever is currently pending, unconditionally",
		);
		assert.equal(hasPendingRendezvous(), false);

		const outcome = await outcomePromise;
		assert.deepStrictEqual(outcome, {
			kind: "result",
			result: payload,
		});
	});
});
