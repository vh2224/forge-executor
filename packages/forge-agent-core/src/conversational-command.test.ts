import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FORGE_COMMAND_REQUEST_TYPE, parseCommandRequest } from "./conversational-command.ts";
import { AgentSessionPromptModule } from "./session/agent-session-prompt.ts";

type Deferred = { resolve: () => void; promise: Promise<void> };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { resolve, promise };
}

function makeHost(idle: Promise<void> = Promise.resolve()) {
	const errors: Array<{ error: string }> = [];
	const entries: unknown[][] = [];
	const steered: unknown[] = [];
	const calls: Array<{ args: string; ctx: unknown }> = [];
	const commandContext = { source: "real-command-context" };
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined = async (args, ctx) => {
		calls.push({ args, ctx });
	};

	const host = {
		isStreaming: true,
		_retryAttempt: 0,
		_extensionRunner: {
			getCommand: (name: string) => (name === "forge" ? { handler } : undefined),
			createCommandContext: () => commandContext,
			emitError: (entry: { error: string }) => errors.push(entry),
		},
		sessionManager: {
			appendCustomMessageEntry: (...entry: unknown[]) => entries.push(entry),
		},
		agent: {
			waitForIdle: async () => await idle,
			steer: (message: unknown) => steered.push(message),
			state: { messages: [] },
		},
		beginTurnLatency: () => undefined,
		markTurnLatency: () => {},
		finishTurnLatency: () => {},
		setHandler(next: (args: string, ctx: unknown) => Promise<void>) {
			handler = next;
		},
	};
	const module = new AgentSessionPromptModule(host as any);
	(host as any).prompt = (text: string) => module.prompt(text);
	return { host, module, errors, entries, steered, calls, commandContext };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("parseCommandRequest", () => {
	test("accepts one slash-prefixed command line only", () => {
		assert.equal(parseCommandRequest({ command: "/forge auto" }), "/forge auto");
		assert.equal(parseCommandRequest({ command: "forge auto" }), null);
		assert.equal(parseCommandRequest({ command: "/forge\nauto" }), null);
		assert.equal(parseCommandRequest({ command: 2 }), null);
		assert.equal(parseCommandRequest(null), null);
	});
});

describe("forge-command-request bridge", () => {
	test("executes the registered handler with a real command context only after idle", async () => {
		const idle = deferred();
		const { module, calls, commandContext, entries } = makeHost(idle.promise);

		await module.sendCustomMessage({
			customType: FORGE_COMMAND_REQUEST_TYPE,
			content: "defer /forge auto",
			display: false,
			details: { command: "/forge auto" },
		});

		assert.equal(calls.length, 0);
		assert.equal(entries.length, 1);
		idle.resolve();
		await settle();
		assert.deepEqual(calls, [{ args: "auto", ctx: commandContext }]);
	});

	test("returns while streaming instead of awaiting idle", async () => {
		const idle = deferred();
		const { module, calls } = makeHost(idle.promise);
		let resolved = false;
		const request = module.sendCustomMessage({
			customType: FORGE_COMMAND_REQUEST_TYPE,
			content: "",
			display: false,
			details: { command: "/forge next" },
		}).then(() => {
			resolved = true;
		});

		await request;
		assert.equal(resolved, true);
		assert.equal(calls.length, 0);
		idle.resolve();
		await settle();
		assert.equal(calls.length, 1);
	});

	test("drops an unknown command before it can fall through to a prompt", async () => {
		const { module, host, errors } = makeHost();
		let prompted = false;
		(host as any).prompt = async () => {
			prompted = true;
		};

		await module.sendCustomMessage({
			customType: FORGE_COMMAND_REQUEST_TYPE,
			content: "",
			display: false,
			details: { command: "/missing command" },
		});

		assert.equal(prompted, false);
		assert.equal(errors.length, 1);
		assert.match(errors[0]!.error, /desconhecido/);
	});

	test("ignores malformed payloads with an error", async () => {
		const { module, calls, errors } = makeHost();
		for (const details of [{}, { command: 1 }, { command: "forge auto" }]) {
			await module.sendCustomMessage({
				customType: FORGE_COMMAND_REQUEST_TYPE,
				content: "",
				display: false,
				details,
			});
		}
		assert.equal(calls.length, 0);
		assert.equal(errors.length, 3);
	});

	test("drops a second request while the single deferred slot is occupied", async () => {
		const idle = deferred();
		const { module, errors, calls } = makeHost(idle.promise);
		await module.sendCustomMessage({
			customType: FORGE_COMMAND_REQUEST_TYPE, content: "", display: false, details: { command: "/forge auto" },
		});
		await module.sendCustomMessage({
			customType: FORGE_COMMAND_REQUEST_TYPE, content: "", display: false, details: { command: "/forge next" },
		});
		assert.equal(errors.length, 1);
		assert.match(errors[0]!.error, /pendente/);
		idle.resolve();
		await settle();
		assert.deepEqual(calls.map(({ args }) => args), ["auto"]);
	});

	test("keeps unrelated custom messages on their existing streaming route", async () => {
		const { module, steered, entries } = makeHost();
		await module.sendCustomMessage({ customType: "other", content: "payload", display: true, details: { x: 1 } });
		assert.equal(steered.length, 1);
		assert.equal(entries.length, 0);
	});
});
