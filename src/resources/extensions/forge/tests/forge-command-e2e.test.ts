import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { AgentSessionPromptModule } from "../../../../../packages/forge-agent-core/src/session/agent-session-prompt.ts";
import { createForgeCommandTool } from "../commands/forge-command-tool.ts";
import { getForgeAutoSession } from "../auto/session.ts";

type Deferred = { promise: Promise<void>; resolve: () => void };

type HandlerCall = { args: string; ctx: unknown; idleFinished: boolean };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function makePromptHarness(idle: Promise<void>, isIdleFinished: () => boolean) {
	const calls: HandlerCall[] = [];
	const commandContext = { source: "real-command-context" };
	const persistedMessages: unknown[][] = [];
	const errors: string[] = [];
	const host = {
		isStreaming: true,
		_retryAttempt: 0,
		_extensionRunner: {
			getCommand: (name: string) => name === "forge"
				? {
					handler: async (args: string, ctx: unknown) => {
						calls.push({ args, ctx, idleFinished: isIdleFinished() });
					},
				}
				: undefined,
			createCommandContext: () => commandContext,
			emitError: (entry: { error: string }) => errors.push(entry.error),
		},
		sessionManager: {
			appendCustomMessageEntry: (...entry: unknown[]) => persistedMessages.push(entry),
		},
		agent: {
			waitForIdle: async () => await idle,
			steer: () => {},
			state: { messages: [] },
		},
		beginTurnLatency: () => undefined,
		markTurnLatency: () => {},
		finishTurnLatency: () => {},
	};
	const module = new AgentSessionPromptModule(host as never);
	(host as { prompt?: (text: string) => Promise<void> }).prompt = (text) => module.prompt(text);
	return { module, calls, commandContext, persistedMessages, errors };
}

async function settleDeferredCommand(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	getForgeAutoSession().reset();
});

describe("forge_command conversational bridge end-to-end", () => {
	test("confirmed auto follows the real custom-message and command-handler surface after idle", async () => {
		const idle = deferred();
		let idleFinished = false;
		const harness = makePromptHarness(idle.promise, () => idleFinished);
		const pi = {
			sendMessage: async (message: Parameters<AgentSessionPromptModule["sendCustomMessage"]>[0]) => {
				await harness.module.sendCustomMessage(message);
			},
		} as unknown as ExtensionAPI;
		const tool = createForgeCommandTool(pi);

		const result = await tool.execute(
			"call",
			{ subcommand: "auto", confirmed: true },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);

		assert.equal((result.details as { executed: string }).executed, "deferred");
		assert.equal(harness.calls.length, 0, "the tool turn must not execute the command before idle");
		assert.equal(harness.persistedMessages.length, 1, "the sanctioned request is retained as an invisible audit entry");
		assert.deepEqual(harness.errors, [], "a valid forge command request must not emit an error");

		idleFinished = true;
		idle.resolve();
		await settleDeferredCommand();

		assert.deepEqual(harness.calls, [{ args: "auto", ctx: harness.commandContext, idleFinished: true }]);
	});

	test("a second confirmed call in the same turn is refused, never falsely reported as deferred", async () => {
		const idle = deferred();
		const harness = makePromptHarness(idle.promise, () => false);
		const pi = {
			sendMessage: async (message: Parameters<AgentSessionPromptModule["sendCustomMessage"]>[0]) => {
				await harness.module.sendCustomMessage(message);
			},
		} as unknown as ExtensionAPI;
		const tool = createForgeCommandTool(pi);

		const first = await tool.execute(
			"call-1",
			{ subcommand: "auto", confirmed: true },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);
		const second = await tool.execute(
			"call-2",
			{ subcommand: "next", confirmed: true },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);

		assert.equal((first.details as { executed: string }).executed, "deferred");
		assert.equal((second.details as { executed: string }).executed, "refused");
		assert.match(
			(second.content[0] as { text: string }).text,
			/já há um comando pendente/,
			"the operator must be told the second command was NOT scheduled",
		);
		assert.equal(harness.persistedMessages.length, 1, "only the first request is retained");
		assert.equal(harness.errors.length, 1);
		assert.match(harness.errors[0]!, /pendente/);

		idle.resolve();
		await settleDeferredCommand();
		assert.deepEqual(harness.calls.map(({ args }) => args), ["auto"]);
	});

	test("unconfirmed auto remains an echo and never reaches the host bridge", async () => {
		const harness = makePromptHarness(Promise.resolve(), () => true);
		const pi = {
			sendMessage: async (message: Parameters<AgentSessionPromptModule["sendCustomMessage"]>[0]) => {
				await harness.module.sendCustomMessage(message);
			},
		} as unknown as ExtensionAPI;
		const tool = createForgeCommandTool(pi);

		const result = await tool.execute(
			"call",
			{ subcommand: "auto", confirmed: false },
			undefined,
			undefined,
			{ cwd: process.cwd() } as never,
		);
		await settleDeferredCommand();

		assert.equal((result.details as { executed: string }).executed, "awaiting_confirmation");
		assert.equal(harness.calls.length, 0);
		assert.equal(harness.persistedMessages.length, 0);
	});
});
