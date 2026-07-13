import { defineTool, type ExtensionAPI } from "@gsd/pi-coding-agent";
import { StringEnum, Type } from "@gsd/pi-ai";
import { Text } from "@gsd/pi-tui";
import { FORGE_COMMAND_REQUEST_TYPE } from "@forge/agent-core";
import { getForgeAutoSession } from "../auto/session.js";
import { formatStatus } from "./forge-command.js";

const FORGE_COMMAND_SUBCOMMANDS = [
	"status",
	"auto",
	"next",
	"milestone-start",
	"fix",
	"review",
	"research-models",
] as const;

type ForgeCommandSubcommand = (typeof FORGE_COMMAND_SUBCOMMANDS)[number];

interface AllowlistEntry {
	readonly readOnly: boolean;
	readonly argumentLabel: string;
	readonly argsPattern: RegExp;
	readonly command: (args: string) => string;
}

/**
 * The conversational command boundary. This hard-coded table is deliberately
 * narrower than `/forge`: it is the auditable v1 allowlist, not a router.
 */
export const FORGE_COMMAND_ALLOWLIST: Readonly<Record<ForgeCommandSubcommand, AllowlistEntry>> = {
	status: { readOnly: true, argumentLabel: "sem argumentos", argsPattern: /^$/, command: () => "/forge status" },
	auto: { readOnly: false, argumentLabel: "sem argumentos", argsPattern: /^$/, command: () => "/forge auto" },
	next: { readOnly: false, argumentLabel: "sem argumentos", argsPattern: /^$/, command: () => "/forge next" },
	"milestone-start": {
		readOnly: false,
		argumentLabel: "um MID (M-...)",
		argsPattern: /^M-[A-Za-z0-9-]+$/,
		command: (args) => `/forge milestone start ${args}`,
	},
	fix: {
		readOnly: false,
		argumentLabel: "um alvo S## ou S##:R#",
		argsPattern: /^S\d{2}(:R\d+)?$/,
		command: (args) => `/forge fix ${args}`,
	},
	review: {
		readOnly: false,
		argumentLabel: "um alvo sem opções",
		argsPattern: /^[\w./:-]+$/,
		command: (args) => `/forge review ${args}`,
	},
	"research-models": {
		readOnly: false,
		argumentLabel: "sem argumentos",
		argsPattern: /^$/,
		command: () => "/forge research-models",
	},
};

export interface ForgeCommandToolDetails {
	executed: "refused" | "status" | "awaiting_confirmation" | "deferred";
	command?: string;
}

/**
 * The deferred payload ultimately re-enters the command parser. Keep its one
 * argument field incapable of carrying an option, a second line, or a hidden
 * control character even when a command-specific pattern changes later.
 */
function hasUnsafeArguments(args: string): boolean {
	return args.includes("--") || /[\u0000-\u001F\u007F]/.test(args);
}

function refusal(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { executed: "refused" as const } satisfies ForgeCommandToolDetails,
	};
}

/**
 * Creates the interactive-only Forge command tool. It only asks the host to
 * defer state changes; the host subsequently invokes the normal `/forge`
 * command handler after this tool turn reaches idle.
 */
export function createForgeCommandTool(pi: ExtensionAPI) {
	return defineTool({
		name: "forge_command",
		label: "Comando Forge",
		description: "Executa comandos Forge permitidos após confirmação conversacional.",
		promptSnippet: "Use forge_command para comandos Forge sancionados na conversa.",
		promptGuidelines: [
			"Nunca edite .gsd/STATE.md nem artefatos de estado do Forge à mão.",
			"Nunca despache Forge via bash, --print, &, ou nohup: forge_command é o único caminho sancionado.",
			"Para comandos que mudam estado, ecoe o comando e aguarde confirmação conversacional do operador antes de chamar com confirmed:true.",
			"Recuse comandos fora da allowlist e informe o equivalente manual quando necessário.",
		],
		parameters: Type.Object({
			subcommand: StringEnum(FORGE_COMMAND_SUBCOMMANDS, { description: "Subcomando Forge permitido" }),
			args: Type.Optional(Type.String({ description: "Argumento único permitido pelo subcomando" })),
			confirmed: Type.Boolean({ description: "Só true após confirmação do operador para mudanças de estado" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const session = getForgeAutoSession();
			if (session.active) {
				return refusal("Há um loop ativo — aguarde o run atual terminar antes de agendar outro comando.");
			}

			const args = params.args ?? "";
			const entry = FORGE_COMMAND_ALLOWLIST[params.subcommand];
			if (hasUnsafeArguments(args) || !entry.argsPattern.test(args)) {
				return refusal(`Argumentos inválidos para ${params.subcommand}; esperado: ${entry.argumentLabel}.`);
			}

			const command = entry.command(args);
			if (entry.readOnly) {
				const text = formatStatus(ctx.cwd);
				return {
					content: [{ type: "text" as const, text }],
					details: { executed: "status", command } satisfies ForgeCommandToolDetails,
				};
			}

			if (params.confirmed !== true) {
				return {
					content: [{
						type: "text" as const,
						text: `Vou executar \`${command}\` — confirme na conversa para eu prosseguir.`,
					}],
					details: { executed: "awaiting_confirmation", command } satisfies ForgeCommandToolDetails,
				};
			}

			await (session.livePi ?? pi).sendMessage({
				customType: FORGE_COMMAND_REQUEST_TYPE,
				content: `Comando sancionado na conversa: ${command}`,
				display: false,
				details: { command },
			});
			return {
				content: [{ type: "text" as const, text: `Comando \`${command}\` agendado — executa quando este turno terminar.` }],
				details: { executed: "deferred", command } satisfies ForgeCommandToolDetails,
			};
		},

		renderCall(args) {
			const entry = FORGE_COMMAND_ALLOWLIST[args.subcommand];
			return new Text(entry.command(args.args ?? ""), 0, 0);
		},
	});
}
