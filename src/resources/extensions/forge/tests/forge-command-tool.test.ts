import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { FORGE_COMMAND_REQUEST_TYPE } from "@forge/agent-core";
import {
	createForgeCommandTool,
	FORGE_COMMAND_ALLOWLIST,
	type ForgeCommandToolDetails,
} from "../commands/forge-command-tool.ts";
import { formatStatus } from "../commands/forge-command.ts";
import { getForgeAutoSession } from "../auto/session.ts";

type SentMessage = {
	customType: string;
	content: string;
	display: boolean;
	details: { command: string };
};

function fakePi() {
	const messages: SentMessage[] = [];
	const pi = {
		sendMessage: async (message: SentMessage) => {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;
	return { pi, messages };
}

function invoke(
	tool: ReturnType<typeof createForgeCommandTool>,
	params: { subcommand: keyof typeof FORGE_COMMAND_ALLOWLIST; args?: string; confirmed: boolean },
	cwd = process.cwd(),
) {
	return tool.execute("call", params, undefined, undefined, { cwd } as never);
}

function executed(result: { details: unknown }): ForgeCommandToolDetails["executed"] {
	return (result.details as ForgeCommandToolDetails).executed;
}

function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
	const content = result.content[0];
	if (content?.type !== "text" || typeof content.text !== "string") {
		throw new Error("Expected a text tool result");
	}
	return content.text;
}

afterEach(() => {
	getForgeAutoSession().reset();
});

describe("forge_command tool", () => {
	test("schema pins the narrow allowlist and excludes forbidden commands", () => {
		const tool = createForgeCommandTool(fakePi().pi);
		const subcommand = (tool.parameters as { properties: { subcommand: { enum: string[] } } }).properties.subcommand.enum;

		assert.deepEqual(subcommand, ["status", "auto", "next", "milestone-start", "fix", "review", "research-models"]);
		for (const forbidden of ["migrate", "init", "unblock", "accounts", "models", "task"]) {
			assert.equal(subcommand.includes(forbidden), false, `${forbidden} must not be in the schema`);
		}
		assert.equal(Value.Check(tool.parameters, { subcommand: "migrate", confirmed: false }), false);
		assert.equal(Value.Check(tool.parameters, { subcommand: "auto", confirmed: false }), true);
	});

	test("unconfirmed state change echoes its exact command without emitting a request", async () => {
		const { pi, messages } = fakePi();
		const result = await invoke(createForgeCommandTool(pi), {
			subcommand: "milestone-start",
			args: "M-20260713010156-fio-da-conversa",
			confirmed: false,
		});

		assert.equal(executed(result), "awaiting_confirmation");
		assert.match(resultText(result), /\/forge milestone start M-20260713010156-fio-da-conversa/);
		assert.match(resultText(result), /confirme na conversa/i);
		assert.deepEqual(messages, []);
	});

	test("confirmed state change emits exactly the reserved deferred payload", async () => {
		const { pi, messages } = fakePi();
		const result = await invoke(createForgeCommandTool(pi), {
			subcommand: "milestone-start",
			args: "M-20260713010156-fio-da-conversa",
			confirmed: true,
		});

		assert.equal(executed(result), "deferred");
		assert.deepEqual(messages, [{
			customType: FORGE_COMMAND_REQUEST_TYPE,
			content: "Comando sancionado na conversa: /forge milestone start M-20260713010156-fio-da-conversa",
			display: false,
			details: { command: "/forge milestone start M-20260713010156-fio-da-conversa" },
		}]);
	});

	test("builds the exact deferred command line for every stateful allowlist entry", async () => {
		const cases = [
			["auto", undefined, "/forge auto"],
			["next", undefined, "/forge next"],
			["fix", "S01:R2", "/forge fix S01:R2"],
			["review", "slices/S01", "/forge review slices/S01"],
			["research-models", undefined, "/forge research-models"],
		] as const;

		for (const [subcommand, args, command] of cases) {
			const { pi, messages } = fakePi();
			await invoke(createForgeCommandTool(pi), { subcommand, args, confirmed: true });
			assert.equal(messages.length, 1, subcommand);
			assert.equal(messages[0].details.command, command);
		}
	});

	test("status executes inline using the command formatter and never sends a message", async () => {
		const { pi, messages } = fakePi();
		const cwd = process.cwd();
		const result = await invoke(createForgeCommandTool(pi), { subcommand: "status", confirmed: false }, cwd);

		assert.equal(executed(result), "status");
		assert.equal(resultText(result), formatStatus(cwd));
		assert.deepEqual(messages, []);
	});

	test("status remains read-only when confirmed is true", async () => {
		const { pi, messages } = fakePi();
		const result = await invoke(createForgeCommandTool(pi), {
			subcommand: "status",
			confirmed: true,
		});

		assert.equal(executed(result), "status");
		assert.equal(messages.length, 0);
	});

	test("allowlist command builders never append an argument to no-argument commands", () => {
		for (const subcommand of ["status", "auto", "next", "research-models"] as const) {
			const entry = FORGE_COMMAND_ALLOWLIST[subcommand];
			assert.equal(entry.argsPattern.test(""), true, subcommand);
			assert.equal(entry.argsPattern.test("extra"), false, subcommand);
			assert.doesNotMatch(entry.command(""), /\s$/);
		}
	});

	test("rejects malformed, missing, option-smuggling, and control-character arguments without effects", async () => {
		const cases = [
			["auto", "anything"],
			["milestone-start", undefined],
			["fix", undefined],
			["fix", "S1"],
			["review", "--all"],
			["review", "target --all"],
			["review", "target\nother"],
		] as const;

		for (const [subcommand, args] of cases) {
			const { pi, messages } = fakePi();
			const result = await invoke(createForgeCommandTool(pi), { subcommand, args, confirmed: true });
			assert.equal(executed(result), "refused", `${subcommand}:${args}`);
			assert.match(resultText(result), /Argumentos inválidos/);
			assert.deepEqual(messages, []);
		}
	});

	test("active loop refuses every command before status or deferred effects", async () => {
		const session = getForgeAutoSession();
		session.active = true;
		const { pi, messages } = fakePi();
		const result = await invoke(createForgeCommandTool(pi), { subcommand: "auto", confirmed: true });

		assert.equal(executed(result), "refused");
		assert.match(resultText(result), /loop ativo.*aguarde o run atual terminar/i);
		assert.deepEqual(messages, []);
	});

	test("reports refused, not deferred, when the host drops the request", async () => {
		const pi = {
			sendMessage: async () => {
				throw new Error("Pedido de comando Forge ignorado: já há um comando pendente.");
			},
		} as unknown as ExtensionAPI;
		const result = await invoke(createForgeCommandTool(pi), { subcommand: "auto", confirmed: true });

		assert.equal(executed(result), "refused");
		assert.match(resultText(result), /Não foi possível agendar/);
		assert.match(resultText(result), /já há um comando pendente/);
	});

	test("uses the live session API after a replacement rather than the registration API", async () => {
		const registration = fakePi();
		const live = fakePi();
		getForgeAutoSession().livePi = live.pi;

		await invoke(createForgeCommandTool(registration.pi), { subcommand: "next", confirmed: true });
		assert.deepEqual(registration.messages, []);
		assert.equal(live.messages.length, 1);
		assert.equal(live.messages[0].details.command, "/forge next");
	});

	test("prompt guidelines enforce anti-improviso and conversational confirmation", () => {
		const tool = createForgeCommandTool(fakePi().pi);
		const guidelines = (tool.promptGuidelines ?? []).join("\n");

		assert.match(guidelines, /STATE/);
		assert.match(guidelines, /--print/);
		assert.match(guidelines, /bash/);
		assert.match(guidelines, /confirmed:true/);
		assert.match(guidelines, /confirmação conversacional/i);
	});
});
