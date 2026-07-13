import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { scopedToolsFor } from "../auto/session.ts";
import {
	FORGE_MCP_UNIT_RESULT_TOOL,
	FORGE_UNIT_RESULT_TOOL_BARE,
	buildWorkerMcpServer,
	type ForgeSdkModule,
} from "../worker/mcp-bridge.ts";

const WORKER_UNIT_TYPES = [
	"plan-slice",
	"execute-task",
	"complete-slice",
	"complete-milestone",
	"plan-milestone",
	"research-models",
	"fix",
] as const;

const AVAILABLE_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"find",
	"grep",
	"ls",
	"forge_command",
	"forge_unit_result",
];

interface CapturedTool {
	name: string;
}

function makeFakeSdk(): { sdk: ForgeSdkModule; captured: CapturedTool[] } {
	const captured: CapturedTool[] = [];
	const sdk: ForgeSdkModule = {
		tool(name, _description, _inputSchema, _handler) {
			const tool = { name };
			captured.push(tool);
			return tool;
		},
		createSdkMcpServer(_options) {
			return { type: "sdk" };
		},
	};
	return { sdk, captured };
}

describe("forge_command worker scoping", () => {
	for (const unitType of WORKER_UNIT_TYPES) {
		test(`${unitType} never scopes the interactive forge_command tool`, () => {
			const scoped = scopedToolsFor(unitType, AVAILABLE_TOOLS);

			assert.equal(scoped.includes("forge_command"), false);
			assert.ok(scoped.includes("forge_unit_result"));
		});
	}

	test("the externalCli MCP bridge exposes only forge_unit_result", () => {
		const { sdk, captured } = makeFakeSdk();
		const server = buildWorkerMcpServer({ token: 1 }, sdk);

		assert.deepEqual(captured.map((tool) => tool.name), [FORGE_UNIT_RESULT_TOOL_BARE]);
		assert.deepEqual(server.allowedTools, [FORGE_MCP_UNIT_RESULT_TOOL]);
		assert.equal(server.allowedTools.includes("mcp__forge__forge_command"), false);
	});
});
