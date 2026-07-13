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
			emitError: () => {
				throw new Error("The valid forge command request must not emit an error");
			},
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
	return { module, calls, commandContext, persistedMessages };
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

		idleFinished = true;
		idle.resolve();
		await settleDeferredCommand();

		assert.deepEqual(harness.calls, [{ args: "auto", ctx: harness.commandContext, idleFinished: true }]);
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
