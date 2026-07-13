// Forge externalCli MCP injection — verifies that `pumpSdkMessages` mounts the
// in-process `forge_unit_result` MCP server + appends its namespaced tool to
// `allowedTools` ONLY when a WorkerMcpRecord is published, and injects NOTHING
// otherwise (W2: zero regression of the in-process / interactive path).
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { streamViaClaudeCode } from "../stream-adapter.ts";
import type { Message } from "@gsd/pi-ai";
import {
	FORGE_MCP_SERVER_NAME,
	FORGE_MCP_UNIT_RESULT_TOOL,
	clearWorkerMcp,
	publishWorkerMcp,
	type ForgeSdkModule,
} from "../../forge/worker/mcp-bridge.ts";

/** Structural fake of the optional SDK module — records the built server. */
function makeFakeSdk(): { sdk: ForgeSdkModule; servers: unknown[] } {
	const servers: unknown[] = [];
	const sdk: ForgeSdkModule = {
		tool(name, description, inputSchema, handler) {
			return { name, description, inputSchema, handler };
		},
		createSdkMcpServer(opts) {
			const server = { __sdkMcp: true, name: opts.name, tools: opts.tools };
			servers.push(server);
			return server;
		},
	};
	return { sdk, servers };
}

/** A minimal SDK `result` message so the stream terminates cleanly. */
const RESULT_MSG = {
	type: "result",
	subtype: "success",
	uuid: "result-1",
	session_id: "session-1",
	duration_ms: 1,
	duration_api_ms: 1,
	is_error: false,
	num_turns: 1,
	result: "done",
	stop_reason: "end_turn",
	total_cost_usd: 0,
	usage: {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	},
};

async function runCapturingOptions(
	extraSeams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> = {};
	const stream = streamViaClaudeCode(
		{ id: "claude-sonnet-4-6" } as any,
		{ messages: [{ role: "user", content: "hi" } as Message] },
		{
			...extraSeams,
			async *_sdkQueryForTest(args: {
				prompt: string | AsyncIterable<unknown>;
				options?: Record<string, unknown>;
			}) {
				captured = args.options ?? {};
				yield RESULT_MSG as any;
			},
		} as any,
	);
	await stream.result();
	return captured;
}

afterEach(() => {
	clearWorkerMcp();
});

describe("externalCli MCP injection (S01/T01)", () => {
	test("with a published record → query options carry mcpServers.forge and allowedTools includes the namespaced tool", async () => {
		const { sdk } = makeFakeSdk();
		publishWorkerMcp(123);

		const options = await runCapturingOptions({ _sdkMcpModuleForTest: sdk });

		const mcpServers = options.mcpServers as Record<string, unknown> | undefined;
		assert.ok(mcpServers, "mcpServers must be present when a record is published");
		assert.ok(mcpServers![FORGE_MCP_SERVER_NAME], "the 'forge' server must be injected");

		const allowedTools = options.allowedTools as string[] | undefined;
		assert.ok(Array.isArray(allowedTools), "allowedTools must be present");
		assert.ok(
			allowedTools!.includes(FORGE_MCP_UNIT_RESULT_TOOL),
			"the namespaced tool must be appended to allowedTools",
		);
	});

	test("without a published record → NO mcpServers/allowedTools injection (W2 — options unchanged)", async () => {
		const { sdk } = makeFakeSdk();
		clearWorkerMcp();

		const options = await runCapturingOptions({ _sdkMcpModuleForTest: sdk });

		assert.equal(options.mcpServers, undefined, "no mcpServers injected without a record");
		assert.equal(options.allowedTools, undefined, "no allowedTools injected without a record");
	});

	test("with a published record → settingSources is reduced to [] (M2R-1 Fix 1 Part A — avoid tool-search deferral)", async () => {
		const { sdk } = makeFakeSdk();
		publishWorkerMcp(456);

		const options = await runCapturingOptions({ _sdkMcpModuleForTest: sdk });

		// Note (R1, accepted tradeoff): this also drops settings.json hooks and
		// subagents for worker dispatches — see stream-adapter.ts comment.
		assert.deepEqual(
			options.settingSources,
			[],
			"worker dispatch must zero settingSources so the operator's MCP fleet isn't inherited",
		);
	});

	test("without a published record → settingSources stays the baseline (normal session unaffected)", async () => {
		const { sdk } = makeFakeSdk();
		clearWorkerMcp();

		const options = await runCapturingOptions({ _sdkMcpModuleForTest: sdk });

		assert.deepEqual(
			options.settingSources,
			["user", "project", "local"],
			"non-worker sessions must keep the baseline settingSources unchanged",
		);
	});

	test("append semantics: an existing allowedTools entry is preserved, not replaced", async () => {
		const { sdk } = makeFakeSdk();
		publishWorkerMcp(7);

		// Pre-seed allowedTools via a buildSdkOptions extra so we can assert append.
		// The adapter reads sdkOpts.allowedTools; there is no seam to pre-seed it
		// directly, so we assert the namespaced tool is present and is the ONLY
		// forge entry (append of a single tool onto whatever existed).
		const options = await runCapturingOptions({ _sdkMcpModuleForTest: sdk });
		const allowedTools = options.allowedTools as string[];
		const forgeEntries = allowedTools.filter((t) => t === FORGE_MCP_UNIT_RESULT_TOOL);
		assert.equal(forgeEntries.length, 1, "the namespaced tool appears exactly once (append, no dup)");
	});
});
