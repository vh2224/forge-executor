import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { createForgeUnitResultTool } from "../worker/unit-result.ts";
import {
	armRendezvous,
	awaitUnitResult,
	cancelRendezvous,
	deliverUnitResult,
	hasPendingRendezvous,
} from "../worker/rendezvous.ts";

const forgeUnitResultTool = createForgeUnitResultTool(null);

describe("forge_unit_result tool", () => {
	test("schema accepts a valid payload", () => {
		const payload = {
			status: "done",
			summary: "Fez a coisa",
			artifacts: ["a.ts", "b.ts"],
		};
		const ok = Value.Check(forgeUnitResultTool.parameters, payload);
		assert.equal(ok, true);
	});

	test("schema accepts an optional reason and rejects an invalid status", () => {
		const withReason = {
			status: "blocked",
			summary: "Não deu",
			artifacts: [],
			reason: "faltou contexto",
		};
		assert.equal(Value.Check(forgeUnitResultTool.parameters, withReason), true);

		const invalidStatus = { status: "nope", summary: "x", artifacts: [] };
		assert.equal(Value.Check(forgeUnitResultTool.parameters, invalidStatus), false);
	});

	test("execute() returns terminate: true and delivers to a pending rendezvous (unbound/null token = idle-session back-compat)", async () => {
		const rendezvousPromise = awaitUnitResult(5_000);

		const params = {
			status: "done" as const,
			summary: "Concluído com sucesso",
			artifacts: ["src/foo.ts"],
		};
		const result = await forgeUnitResultTool.execute("call-1", params, undefined, undefined, {} as never);

		assert.equal(result.terminate, true);
		assert.deepStrictEqual(result.details, {
			status: "done",
			summary: "Concluído com sucesso",
			artifacts: ["src/foo.ts"],
			reason: undefined,
		});

		const outcome = await rendezvousPromise;
		assert.deepStrictEqual(outcome, {
			kind: "result",
			result: {
				status: "done",
				summary: "Concluído com sucesso",
				artifacts: ["src/foo.ts"],
				reason: undefined,
			},
		});
	});
});

describe("rendezvous", () => {
	test("awaitUnitResult resolves { kind: 'timeout' } when nothing is delivered in time", async () => {
		const outcome = await awaitUnitResult(20);
		assert.deepStrictEqual(outcome, { kind: "timeout" });
		assert.equal(hasPendingRendezvous(), false);
	});

	test("deliverUnitResult with no pending rendezvous returns 'none' and never throws", () => {
		assert.equal(hasPendingRendezvous(), false);
		const delivered = deliverUnitResult({ status: "partial", summary: "sem pendência", artifacts: [] });
		assert.equal(delivered, "none");
	});

	test("deliverUnitResult resolves the pending promise exactly once", async () => {
		const pending = awaitUnitResult(5_000);
		const first = deliverUnitResult({ status: "blocked", summary: "s1", artifacts: [], reason: "r" });
		const second = deliverUnitResult({ status: "done", summary: "s2", artifacts: [] });

		assert.equal(first, "delivered");
		assert.equal(second, "none");

		const outcome = await pending;
		assert.deepStrictEqual(outcome, {
			kind: "result",
			result: { status: "blocked", summary: "s1", artifacts: [], reason: "r" },
		});
	});
});

// ── M1R-1: epoch token correlation (F1/F2 regressions) ──────────────────────

describe("rendezvous — epoch token correlation (M1R-1)", () => {
	test("F1: a stale cancel from an abandoned attempt does not destroy the retry's rendezvous", async () => {
		const rdv1 = armRendezvous(20);
		// rdv1's ceiling "expires" — simulate the driver's own timeout path
		// clearing it without resolving (mirrors a wall-clock ceiling).
		assert.equal(cancelRendezvous(rdv1.token), "cancelled");
		assert.equal(hasPendingRendezvous(), false);

		// Retry arms rendezvous-2.
		const rdv2 = armRendezvous(5_000);
		assert.equal(hasPendingRendezvous(), true);

		// attempt-1's late catch fires and calls cancel with the OLD token —
		// must be a stale no-op, must NOT touch rendezvous-2.
		assert.equal(cancelRendezvous(rdv1.token), "stale");
		assert.equal(hasPendingRendezvous(), true, "rendezvous-2 survives the stale cancel");

		// attempt-2 delivers with its own (current) token — rendezvous-2 settles.
		const delivered = deliverUnitResult(
			{ status: "done", summary: "attempt-2 result", artifacts: [] },
			rdv2.token,
		);
		assert.equal(delivered, "delivered");

		const outcome = await rdv2.outcome;
		assert.deepStrictEqual(outcome, {
			kind: "result",
			result: { status: "done", summary: "attempt-2 result", artifacts: [] },
		});
	});

	test("F2 (mirror): a stale deliver from an abandoned attempt does not settle the retry's rendezvous", async () => {
		const rdv1 = armRendezvous(20);
		assert.equal(cancelRendezvous(rdv1.token), "cancelled");

		const rdv2 = armRendezvous(5_000);

		// Late deliver with the OLD token — stale no-op, rdv2 stays pending.
		const staleDeliver = deliverUnitResult(
			{ status: "done", summary: "attempt-1 late result", artifacts: [] },
			rdv1.token,
		);
		assert.equal(staleDeliver, "stale");
		assert.equal(hasPendingRendezvous(), true, "rendezvous-2 not settled by the stale delivery");

		// attempt-2's own delivery still resolves rdv2 correctly.
		const delivered = deliverUnitResult(
			{ status: "done", summary: "attempt-2 result", artifacts: [] },
			rdv2.token,
		);
		assert.equal(delivered, "delivered");

		const outcome = await rdv2.outcome;
		assert.equal(outcome.kind, "result");
		assert.equal(outcome.kind === "result" && outcome.result.summary, "attempt-2 result");
	});
});

// ── R1 (review round 2): the tool must bind its token at REGISTRATION time,
// never read it live from the mutable session container. ──────────────────

describe("createForgeUnitResultTool — per-instance token binding (R1)", () => {
	test(
		"a token-1-bound tool instance delivering AFTER the retry re-arms (token-2) is a stale no-op; " +
			"the retry's rendezvous stays pending and only settles from its OWN (token-2-bound) tool instance",
		async () => {
			// Dispatch A: mint token 1, register a tool instance BOUND to it (as
			// `registerForgeExtension` would at A's session bring-up).
			const rdvA = armRendezvous(5_000);
			const toolA = createForgeUnitResultTool(rdvA.token);

			// A's session hits the ceiling/timeout and is abandoned WITHOUT its
			// tool call landing yet — mirrors driver.ts's cancelAndJournal path,
			// which drops the rendezvous but the in-flight tool call from the
			// old (aborted) session can still resolve later (best-effort abort).
			assert.equal(cancelRendezvous(rdvA.token), "cancelled");

			// Driver retries: dispatch B, mint token 2, re-arm, register a NEW
			// tool instance bound to token 2 (a fresh extension instance).
			const rdvB = armRendezvous(5_000);
			const toolB = createForgeUnitResultTool(rdvB.token);
			assert.equal(hasPendingRendezvous(), true, "rendezvous-B is armed");

			// THEN the OLD (token-1-bound) tool instance's delivery lands late.
			const staleResult = await toolA.execute(
				"call-stale",
				{ status: "done", summary: "A's late result", artifacts: [] },
				undefined,
				undefined,
				{} as never,
			);
			assert.equal(staleResult.terminate, true, "the tool never throws, even on a stale delivery");
			assert.equal(hasPendingRendezvous(), true, "B's rendezvous is STILL pending — uncorrupted by A's stale delivery");

			// B's rendezvous only resolves later, from B's OWN (token-2-bound) tool.
			await toolB.execute(
				"call-b",
				{ status: "done", summary: "B's result", artifacts: [] },
				undefined,
				undefined,
				{} as never,
			);
			const outcome = await rdvB.outcome;
			assert.deepStrictEqual(outcome, {
				kind: "result",
				result: { status: "done", summary: "B's result", artifacts: [], reason: undefined },
			});
		},
	);

	test(
		"the SAME regression via raw deliverUnitResult (fails before the R1 fix, passes after): " +
			"a stale token-1 delivery returns 'stale' and does not corrupt token-2's rendezvous",
		async () => {
			const rdvA = armRendezvous(5_000);
			assert.equal(cancelRendezvous(rdvA.token), "cancelled");

			const rdvB = armRendezvous(5_000);

			// Simulates what the OLD (pre-R1) live-read code would do: deliver
			// using A's stale token instead of the currently-bound one.
			const outcome = deliverUnitResult({ status: "done", summary: "A's stale delivery", artifacts: [] }, rdvA.token);
			assert.equal(outcome, "stale", "a delivery correlated to the abandoned attempt's token is a no-op");
			assert.equal(hasPendingRendezvous(), true, "rendezvous-B survives untouched");

			const delivered = deliverUnitResult({ status: "done", summary: "B's result", artifacts: [] }, rdvB.token);
			assert.equal(delivered, "delivered");
			const result = await rdvB.outcome;
			assert.equal(result.kind === "result" && result.result.summary, "B's result");
		},
	);
});
