import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	FORGE_MCP_SERVER_NAME,
	FORGE_MCP_UNIT_RESULT_TOOL,
	FORGE_UNIT_RESULT_TOOL_BARE,
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

// ── A structural fake of the optional SDK module ────────────────────────────
// Captures the single registered tool (name/description/shape/handler) and
// hands back opaque marker objects for the server config, so the factory can
// be exercised with zero dependency on the real subprocess SDK.

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
	// Drain any rendezvous a test left armed so cases stay isolated.
	cancelRendezvous();
	getForgeAutoSession().reset();
});

describe("mcp-bridge — record lifecycle", () => {
	test("publish/get/clear round-trips the epoch token; default slot is null", () => {
		clearWorkerMcp();
		assert.equal(getWorkerMcpRecord(), null);

		publishWorkerMcp(42);
		assert.deepStrictEqual(getWorkerMcpRecord(), { token: 42 });

		publishWorkerMcp(43);
		assert.deepStrictEqual(getWorkerMcpRecord(), { token: 43 }, "republish overwrites");

		clearWorkerMcp();
		assert.equal(getWorkerMcpRecord(), null);
	});
});

describe("mcp-bridge — buildWorkerMcpServer factory", () => {
	test("exposes the namespaced tool under server 'forge' and registers the bare tool", () => {
		const { sdk, captured } = makeFakeSdk();
		const built = buildWorkerMcpServer({ token: 7 }, sdk);

		assert.equal(built.serverName, FORGE_MCP_SERVER_NAME);
		assert.deepStrictEqual(built.allowedTools, [FORGE_MCP_UNIT_RESULT_TOOL]);
		assert.equal(captured.length, 1);
		assert.equal(captured[0]!.name, FORGE_UNIT_RESULT_TOOL_BARE);
		assert.match(captured[0]!.description, /forge_unit_result|resultado final/i);
	});

	test("handler delivers into a pending rendezvous with the token FROZEN at construction (B1)", async () => {
		const { sdk, captured } = makeFakeSdk();
		// Arm the rendezvous for THIS dispatch, then build the server with its token.
		const rdv = armRendezvous(5_000);
		const built = buildWorkerMcpServer({ token: rdv.token }, sdk);
		void built;

		const result = await captured[0]!.handler(
			{ status: "done", summary: "feito via MCP", artifacts: ["src/x.ts"] },
			undefined,
		);

		// Tool returns a tolerant text block (never throws).
		assert.ok(result && typeof result === "object");

		const outcome = await rdv.outcome;
		assert.deepStrictEqual(outcome, {
			kind: "result",
			result: { status: "done", summary: "feito via MCP", artifacts: ["src/x.ts"], reason: undefined },
		});
	});

	test("a token-N-bound handler delivering AFTER the retry re-arms (token N+1) is a stale no-op and journals stale_rendezvous_delivery (B1 mirror)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "forge-mcp-bridge-"));
		try {
			const s = getForgeAutoSession();
			s.cwd = tmp;
			s.currentUnit = { type: "execute-task", slice: "S01", task: "T01" };

			const { sdk, captured } = makeFakeSdk();

			// Dispatch A: arm token N, build server A (freezes N).
			const rdvA = armRendezvous(5_000);
			buildWorkerMcpServer({ token: rdvA.token }, sdk);
			// A hits the ceiling: driver drops the rendezvous without resolving.
			assert.equal(cancelRendezvous(rdvA.token), "cancelled");

			// Dispatch B (retry): arm token N+1.
			const rdvB = armRendezvous(5_000);
			assert.equal(hasPendingRendezvous(), true);

			// A's late tool call lands — handler A (frozen on token N) delivers.
			const result = await captured[0]!.handler(
				{ status: "done", summary: "A tardio", artifacts: [] },
				undefined,
			);
			assert.ok(result, "handler returns tolerantly, never throws");
			assert.equal(hasPendingRendezvous(), true, "B's rendezvous is uncorrupted by A's stale delivery");

			// The stale delivery was journaled best-effort.
			const journal = readFileSync(join(tmp, ".gsd", "forge", "events.jsonl"), "utf-8").trim();
			const lines = journal.split("\n").map((l) => JSON.parse(l));
			const stale = lines.find((e) => e.kind === "stale_rendezvous_delivery");
			assert.ok(stale, "a stale_rendezvous_delivery event was written");
			assert.equal(stale.unit, "S01/T01");
			assert.equal(stale.slice, "S01");
			assert.equal(stale.task, "T01");
			assert.equal(stale.status, "stale");

			// B still settles from a delivery correlated to its own token.
			assert.equal(
				deliverUnitResult({ status: "done", summary: "B result", artifacts: [] }, rdvB.token),
				"delivered",
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("a server built inside dispatch A's publish window stays token-frozen after clearWorkerMcp() — a zombie delivery post-clear is stale, retry B intact (B1 lifecycle)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "forge-mcp-bridge-window-"));
		try {
			const s = getForgeAutoSession();
			s.cwd = tmp;
			s.currentUnit = { type: "execute-task", slice: "S01", task: "T02" };

			const { sdk, captured } = makeFakeSdk();

			// ── Dispatch A: publish token N (driver does this right after arm),
			// build server A INSIDE the window (freezes N), then the ceiling fires:
			// the driver drops the rendezvous AND clears the slot in its finally.
			const rdvA = armRendezvous(5_000);
			publishWorkerMcp(rdvA.token);
			buildWorkerMcpServer(getWorkerMcpRecord()!, sdk);
			assert.equal(cancelRendezvous(rdvA.token), "cancelled");
			clearWorkerMcp();
			assert.equal(getWorkerMcpRecord(), null, "slot inert after A settles");

			// ── Dispatch B (retry): publish token N+1.
			const rdvB = armRendezvous(5_000);
			publishWorkerMcp(rdvB.token);
			assert.equal(hasPendingRendezvous(), true);

			// A's zombie query fires its (frozen-N) handler AFTER the clear. It must
			// route to token N → stale no-op, never touching B — proving the read is
			// at construction, never at delivery (never re-reads the now-null slot).
			await captured[0]!.handler(
				{ status: "done", summary: "A zombie post-clear", artifacts: [] },
				undefined,
			);
			assert.equal(hasPendingRendezvous(), true, "B uncorrupted by A's post-clear zombie delivery");

			const journal = readFileSync(join(tmp, ".gsd", "forge", "events.jsonl"), "utf-8").trim();
			assert.ok(
				journal.split("\n").map((l) => JSON.parse(l)).some((e) => e.kind === "stale_rendezvous_delivery"),
				"stale delivery journaled",
			);

			assert.equal(
				deliverUnitResult({ status: "done", summary: "B result", artifacts: [] }, rdvB.token),
				"delivered",
				"B still settles from its own token",
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("no pending rendezvous → handler tolerates (returns, never throws), no journal needed", async () => {
		const { sdk, captured } = makeFakeSdk();
		buildWorkerMcpServer({ token: 99 }, sdk);
		assert.equal(hasPendingRendezvous(), false);

		const result = await captured[0]!.handler(
			{ status: "partial", summary: "sem rendezvous", artifacts: [] },
			undefined,
		);
		assert.ok(result, "handler returns tolerantly on the 'none' outcome");
	});

	test("invalid payload is tolerated (never throws, returns a rejection text)", async () => {
		const { sdk, captured } = makeFakeSdk();
		buildWorkerMcpServer({ token: 1 }, sdk);

		const result = (await captured[0]!.handler(
			{ status: "not-a-status", summary: 123 },
			undefined,
		)) as { content: { type: string; text: string }[] };
		assert.ok(result.content?.[0]?.text.includes("inválido"));
	});
});
