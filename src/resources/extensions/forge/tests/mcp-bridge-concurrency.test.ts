import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	buildWorkerMcpServer,
	clearWorkerMcp,
	getWorkerMcpRecord,
	publishWorkerMcp,
	type ForgeSdkModule,
} from "../worker/mcp-bridge.ts";
import {
	armRendezvous,
	cancelRendezvous,
	deliverUnitResult,
	hasPendingRendezvous,
} from "../worker/rendezvous.ts";
import { getForgeAutoSession } from "../auto/session.ts";

// ── Structural fake of the optional SDK module (copied from mcp-bridge.test.ts,
// per T01-PLAN's Reuse directive — do not reinvent). Each `buildWorkerMcpServer`
// call pushes ONE new tool into `captured`, so `captured[0]` is server A's
// handler and `captured[1]` is server B's — the two never share a slot.

interface CapturedTool {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

function makeFakeSdk(): { sdk: ForgeSdkModule; captured: CapturedTool[]; servers: unknown[] } {
	const captured: CapturedTool[] = [];
	const servers: unknown[] = [];
	const sdk: ForgeSdkModule = {
		tool(name, description, inputSchema, handler) {
			const t = { name, description, inputSchema, handler };
			captured.push(t);
			return t;
		},
		createSdkMcpServer(opts) {
			const server = { type: "sdk", name: opts.name, tools: opts.tools };
			servers.push(server);
			return server;
		},
	};
	return { sdk, captured, servers };
}

afterEach(() => {
	clearWorkerMcp();
	cancelRendezvous();
	getForgeAutoSession().reset();
});

describe("mcp-bridge — concurrency: two servers in an overlapping publish window (S07 T01)", () => {
	test("republishing the slot for B does NOT clobber A's delivery — each server routes to its own frozen token", async () => {
		const { sdk, captured } = makeFakeSdk();

		// Dispatch A: arm + publish token A, build server A (freezes A's token
		// at construction).
		const rdvA = armRendezvous(5_000);
		publishWorkerMcp(rdvA.token);
		buildWorkerMcpServer(getWorkerMcpRecord()!, sdk);

		// A's handler fires and delivers, settling its OWN rendezvous. This
		// happens before B ever arms — armRendezvous defensively drops any
		// still-open PREVIOUS arm without resolving it (rendezvous.ts:67-70,
		// the documented single-live-arm contract, S07-PLAN §Decisão B), so a
		// second live arm here would orphan rdvA.outcome forever. The
		// production loop never does this (dispatch is sequential); the test
		// must not either.
		const resultA = await captured[0]!.handler(
			{ status: "done", summary: "A entrega ao seu token", artifacts: [] },
			undefined,
		);
		assert.ok(resultA, "handler A returns tolerantly");
		assert.deepStrictEqual(await rdvA.outcome, {
			kind: "result",
			result: { status: "done", summary: "A entrega ao seu token", artifacts: [], reason: undefined },
		});

		// Dispatch B republishes the SAME module-level `record` slot and builds
		// a second server — server A's already-built closure (`captured[0]`)
		// is untouched by this republish.
		const rdvB = armRendezvous(5_000);
		publishWorkerMcp(rdvB.token);
		buildWorkerMcpServer(getWorkerMcpRecord()!, sdk);

		assert.equal(captured.length, 2, "two servers, two captured handlers");
		assert.notEqual(rdvA.token, rdvB.token, "each arm mints a distinct epoch token");

		// A's handler fires AGAIN (a zombie/duplicate tool call) AFTER the slot
		// moved to B. If A's handler read the live slot at delivery instead of
		// its frozen `boundToken`, this would resolve/clobber B. It must be a
		// tolerated stale no-op that leaves B's rendezvous intact.
		const zombieResult = await captured[0]!.handler(
			{ status: "done", summary: "A zumbi após republish para B", artifacts: [] },
			undefined,
		);
		assert.ok(zombieResult, "handler A's zombie call is tolerated, never throws");
		assert.equal(hasPendingRendezvous(), true, "B's freshly-armed rendezvous survives A's zombie delivery");

		// B settles cleanly, correlated to its OWN token — proving A's zombie
		// call never touched it.
		const resultB = await captured[1]!.handler(
			{ status: "done", summary: "B entrega ao seu token", artifacts: [] },
			undefined,
		);
		assert.ok(resultB, "handler B returns tolerantly");
		assert.deepStrictEqual(await rdvB.outcome, {
			kind: "result",
			result: { status: "done", summary: "B entrega ao seu token", artifacts: [], reason: undefined },
		});
	});

	test("a server frozen on token N survives clearWorkerMcp() as a stale no-op — it never reads the (now null or live-B) slot at delivery time", async () => {
		const { sdk, captured } = makeFakeSdk();

		// Dispatch A: arm + publish N, build server A (freezes N).
		const rdvA = armRendezvous(5_000);
		publishWorkerMcp(rdvA.token);
		buildWorkerMcpServer(getWorkerMcpRecord()!, sdk);

		// A hits the ceiling: driver cancels the rendezvous and clears the slot
		// in its `finally` — mirrors the production abandon path.
		assert.equal(cancelRendezvous(rdvA.token), "cancelled");
		clearWorkerMcp();
		assert.equal(getWorkerMcpRecord(), null, "slot is inert after A's abandonment");

		// Retry B: arm + publish N+1 — B is now the only live rendezvous.
		const rdvB = armRendezvous(5_000);
		publishWorkerMcp(rdvB.token);
		assert.equal(hasPendingRendezvous(), true);

		// A's zombie query fires its frozen-N handler AFTER the clear AND after
		// B has re-armed. It must be a stale no-op — never reading the null (or
		// now-live-B) slot — and must NOT touch B's rendezvous.
		const zombieResult = await captured[0]!.handler(
			{ status: "done", summary: "A zumbi pós-clear e pós-rearm de B", artifacts: [] },
			undefined,
		);
		assert.ok(zombieResult, "handler A returns tolerantly on a stale delivery");
		assert.equal(hasPendingRendezvous(), true, "B's rendezvous is uncorrupted by A's post-clear zombie delivery");

		// B still settles correlated to its OWN token, proving A's stale
		// delivery never touched it — mirrors the direct token-guard check in
		// mcp-bridge.test.ts.
		assert.equal(
			deliverUnitResult({ status: "done", summary: "B result", artifacts: [] }, rdvB.token),
			"delivered",
			"B still settles from its own token",
		);
	});
});
