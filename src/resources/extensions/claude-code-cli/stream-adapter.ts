// gsd-pi - Claude Code CLI provider stream adapter
/**
 * Stream adapter: bridges the Claude Agent SDK into GSD's streamSimple contract.
 *
 * The SDK runs the full agentic loop (multi-turn, tool execution, compaction)
 * in one call. This adapter translates the SDK's streaming output into
 * AssistantMessageEvents for TUI rendering, then preserves externally executed
 * tool-call blocks on the final AssistantMessage so Agent Core can render them
 * while `externalToolExecution` prevents local redispatch.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
	ToolCall,
} from "@gsd/pi-ai";
import type { ExtensionUIContext } from "@gsd/pi-coding-agent";
import { EventStream } from "@gsd/pi-ai";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PartialMessageBuilder, ZERO_USAGE, mapUsage } from "./partial-builder.js";
import {
	attachExternalResultsToToolBlocks,
	buildFinalAssistantContent,
	extractToolResultsFromSdkUserMessage,
	handleClaudeCodePartialStreamEvent,
	shouldSuppressDuplicateToolUnavailableBlock,
} from "./turn-assembler.js";
import type {
	ExternalToolResultPayload,
	ToolCallWithExternalResult,
} from "./turn-assembler.js";
import { showInterviewRound, type Question, type RoundResult } from "../shared/tui.js";
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "./sdk-types.js";
// Forge externalCli MCP bridge. Static import is SAFE: this module carries no
// top-level dependency on the OPTIONAL `@anthropic-ai/claude-agent-sdk` — the
// SDK is passed IN to `buildWorkerMcpServer`. Cross-extension provider→forge
// import has direct historical precedent (`a005bdd7^:stream-adapter.ts:43`).
import {
	buildWorkerMcpServer,
	getWorkerMcpRecord,
	type ForgeSdkModule,
} from "../forge/worker/mcp-bridge.js";

export {
	buildFinalAssistantContent,
	extractToolResultsFromSdkUserMessage,
	handleClaudeCodePartialStreamEvent,
	mergePendingToolCalls,
	shouldSuppressDuplicateToolUnavailableBlock,
} from "./turn-assembler.js";
export type {
	ExternalToolResultContentBlock,
	ExternalToolResultPayload,
	ToolCallWithExternalResult,
} from "./turn-assembler.js";

/** `SimpleStreamOptions` extended with an optional extension UI context for elicitation dialogs. */
interface ClaudeCodeStreamOptions extends SimpleStreamOptions {
	extensionUIContext?: ExtensionUIContext;
	onExternalToolCall?: (toolCall: ToolCall) => Promise<void> | void;
	onExternalToolResult?: (event: { toolCall: ToolCall; result: ExternalToolResultPayload }) => Promise<void> | void;
	_sdkQueryForTest?: (args: {
		prompt: string | AsyncIterable<unknown>;
		options?: Record<string, unknown>;
	}) => AsyncIterable<SDKMessage>;
	/**
	 * Test seam: the SDK module used to build the in-process forge MCP server.
	 * Real runs import `@anthropic-ai/claude-agent-sdk` dynamically; tests inject
	 * a structural fake so the `mcpServers`/`allowedTools` injection can be
	 * asserted without the real subprocess SDK. See `pumpSdkMessages`.
	 */
	_sdkMcpModuleForTest?: ForgeSdkModule;
}

export function serverToolUseToToolCallLike(block: {
	id: string;
	name: string;
	input: unknown;
}): ToolCall {
	const argumentsValue =
		block.input && typeof block.input === "object" && !Array.isArray(block.input)
			? (block.input as Record<string, unknown>)
			: { input: block.input };
	return {
		type: "toolCall",
		id: block.id,
		name: block.name,
		arguments: argumentsValue,
	};
}

/** Resolve the workspace root for local Claude Code process execution. */
export function resolveClaudeCodeCwd(options?: SimpleStreamOptions): string {
	return options?.cwd && options.cwd.trim().length > 0 ? options.cwd : process.cwd();
}

/** A single selectable option within an SDK elicitation schema field. */
interface SdkElicitationRequestOption {
	const?: string;
	title?: string;
}

/** JSON-Schema-like descriptor for a single field within an SDK elicitation request schema. */
interface SdkElicitationFieldSchema {
	type?: string;
	title?: string;
	description?: string;
	format?: string;
	writeOnly?: boolean;
	oneOf?: SdkElicitationRequestOption[];
	items?: {
		anyOf?: SdkElicitationRequestOption[];
	};
}

/** The full elicitation request object received from an MCP server via the Claude Agent SDK. */
interface SdkElicitationRequest {
	serverName: string;
	message: string;
	mode?: "form" | "url";
	requestedSchema?: {
		type?: string;
		properties?: Record<string, SdkElicitationFieldSchema>;
		required?: string[];
	};
}

/** The result returned by an elicitation handler back to the Claude Agent SDK. */
interface SdkElicitationResult {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, string | string[]>;
}

/** A TUI `Question` extended with an optional note-field ID for "None of the above" free-text capture. */
interface ParsedElicitationQuestion extends Question {
	noteFieldId?: string;
}

interface HeadlessAnswersFile {
	questions?: Record<string, string | string[]>;
	defaults?: { strategy?: "first_option" | "cancel" };
}

/** Descriptor for a single free-text input field parsed from an SDK elicitation form schema. */
interface ParsedTextInputField {
	id: string;
	title: string;
	description: string;
	required: boolean;
	secure: boolean;
}

/** A base64-encoded image block in the format accepted by the Claude Agent SDK input message. */
interface SDKInputImageBlock {
	type: "image";
	source: {
		type: "base64";
		media_type: string;
		data: string;
	};
}

/** A plain-text block in the format accepted by the Claude Agent SDK input message. */
interface SDKInputTextBlock {
	type: "text";
	text: string;
}

/** Union of content block types that may appear in a Claude Agent SDK user input message. */
type SDKInputUserContentBlock = SDKInputImageBlock | SDKInputTextBlock;

/** A synthetic user message in the Claude Agent SDK's async-iterable prompt format, used when images are present. */
interface SDKInputUserMessage {
	type: "user";
	message: {
		role: "user";
		content: SDKInputUserContentBlock[];
	};
	parent_tool_use_id: null;
}

/** Label used for the free-text fallback option in single-choice elicitation questions. */
const OTHER_OPTION_LABEL = "None of the above";
/** Regex pattern that identifies field names and descriptions that should be treated as sensitive/secure inputs. */
const SENSITIVE_FIELD_PATTERN = /(password|passphrase|secret|token|api[_\s-]*key|private[_\s-]*key|credential)/i;
/** Mirrors @opengsd/mcp-server's ask_user_questions host elicitation timeout. */
const WORKFLOW_ELICIT_TIMEOUT_MS = 10 * 60 * 1000;
/** Close the local form just before the server drops the MCP elicitation request. */
const WORKFLOW_ELICIT_TIMEOUT_SKEW_MS = 1_000;
export const CLAUDE_CODE_INTERVIEW_FORM_TIMEOUT_MS = Math.max(
	1,
	WORKFLOW_ELICIT_TIMEOUT_MS - WORKFLOW_ELICIT_TIMEOUT_SKEW_MS,
);
const ELICITATION_EXPIRED_NOTICE =
	"Question expired before you answered - the form was closed and no answers were sent.";
const activeAskUserQuestionElicitationTimeoutAborters = new Set<() => void>();

function isAskUserQuestionsToolName(toolName: string | undefined): boolean {
	const name = String(toolName ?? "");
	return name === "ask_user_questions" || name.endsWith("__ask_user_questions");
}

function isAskUserQuestionsTimedOutResult(
	toolCall: Pick<ToolCall, "name">,
	result: ExternalToolResultPayload,
): boolean {
	return isAskUserQuestionsToolName(toolCall.name) && result.details?.timed_out === true;
}

function abortActiveAskUserQuestionElicitationsForTimeout(): void {
	for (const abort of [...activeAskUserQuestionElicitationTimeoutAborters]) {
		abort();
	}
}

// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

/**
 * Construct an AssistantMessageEventStream using EventStream directly.
 * (The class itself is only re-exported as a type from the @gsd/pi-ai barrel.)
 */
function createAssistantStream(): AssistantMessageEventStream {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type for final result");
		},
	) as AssistantMessageEventStream;
}

/** Extract a human-readable error string from an SDK result message. */
export function getResultErrorMessage(result: SDKResultMessage): string {
	if ("errors" in result && Array.isArray(result.errors) && result.errors.length > 0) {
		return result.errors.join("; ");
	}

	if ("result" in result && typeof result.result === "string" && result.result.trim().length > 0) {
		return result.result.trim();
	}

	return result.subtype === "success" ? "claude_code_request_failed" : result.subtype;
}

// ---------------------------------------------------------------------------
// Claude binary resolution
// ---------------------------------------------------------------------------

/** Cached result of the Claude executable/script resolution so lookup runs once per process. */
let cachedClaudePath: string | null = null;
const requireFromHere = createRequire(import.meta.url);

/** Return the shell command used to locate the `claude` binary on the given platform. */
export function getClaudeLookupCommand(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "where claude" : "which claude";
}

/**
 * Pick the most suitable path from `which`/`where` output.
 *
 * On Windows, `where claude` can return shim entries first (for example
 * `...\\npm\\claude` / `...\\npm\\claude.cmd`) that the Claude Agent SDK treats
 * as a native executable path and then fails to spawn. Prefer a native
 * `.exe` candidate when present.
 */
export function parseClaudeLookupOutput(output: Buffer | string, platform: NodeJS.Platform = process.platform): string {
	const lines = output
		.toString()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (lines.length === 0) return "";
	if (platform !== "win32") return lines[0] ?? "";

	const exeCandidate = lines.find((line) => /\.exe$/i.test(line));
	if (exeCandidate) return exeCandidate;

	const cmdCandidate = lines.find((line) => /\.cmd$/i.test(line));
	if (cmdCandidate) return cmdCandidate;

	return lines[0] ?? "";
}

/** Resolve the SDK-bundled cli.js path if available. */
export function resolveBundledClaudeCliPath(): string | null {
	try {
		const sdkEntry = requireFromHere.resolve("@anthropic-ai/claude-agent-sdk");
		const cliPath = join(dirname(sdkEntry), "cli.js");
		return existsSync(cliPath) ? cliPath : null;
	} catch {
		return null;
	}
}

/**
 * Normalize a discovered path for Claude Agent SDK consumption.
 *
 * On Windows, the SDK treats non-`.js` paths as native binaries. NPM shims
 * like `claude`/`claude.cmd` are not native binaries and can fail with
 * `ENOENT`/`EINVAL` in that mode. When no `.exe` is available, prefer the
 * SDK-bundled `cli.js` so the SDK runs via Node.
 */
export function normalizeClaudePathForSdk(
	resolvedPath: string,
	platform: NodeJS.Platform = process.platform,
	bundledCliPath: string | null = resolveBundledClaudeCliPath(),
): string {
	if (platform !== "win32") return resolvedPath;
	if (/\.exe$/i.test(resolvedPath)) return resolvedPath.replaceAll("\\", "/");
	if (bundledCliPath) return bundledCliPath.replaceAll("\\", "/");
	return resolvedPath;
}

/** Resolve the path passed to `pathToClaudeCodeExecutable`. */
function getClaudePath(): string {
	if (cachedClaudePath) return cachedClaudePath;

	const fallback = process.platform === "win32"
		? (resolveBundledClaudeCliPath() ?? "claude.cmd")
		: "claude";

	try {
		const lookupOutput = execSync(getClaudeLookupCommand(), { timeout: 5_000, stdio: "pipe" });
		const parsed = parseClaudeLookupOutput(lookupOutput, process.platform);
		cachedClaudePath = normalizeClaudePathForSdk(parsed || fallback, process.platform);
	} catch {
		cachedClaudePath = fallback;
	}

	return cachedClaudePath;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Extract text content from a single message regardless of content shape.
 */
function extractMessageText(msg: { role: string; content: unknown }): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		const textParts = msg.content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text ?? part.thinking ?? "");
		if (textParts.length > 0) return textParts.join("\n");
	}
	return "";
}

/**
 * Build a full conversational prompt from GSD's context messages.
 *
 * Previous behaviour sent only the last user message, making every SDK
 * call effectively stateless. This version serialises the complete
 * conversation history (system prompt + all user/assistant turns) so
 * Claude Code has full context for multi-turn continuity.
 *
 * History is wrapped in XML-tag structure rather than `[User]`/`[Assistant]`
 * bracket headers. Bracket headers read to the model as an in-context
 * demonstration of how turns are delimited, causing it to fabricate fake
 * user turns in its own output. XML tags read as document structure and
 * don't get mirrored in free text.
 */
export function buildPromptFromContext(context: Context): string {
	const hasContent = Boolean(context.systemPrompt) || context.messages.some((m) => extractMessageText(m));
	if (!hasContent) return "";

	const parts: string[] = [
		"Respond only to the final user message below. " +
			"Do not emit <user_message>, <assistant_message>, or <prior_system_context> tags in your response.",
	];

	// The prior system context lists pi-native tool names (lowercase: bash, read, etc.)
	// but this process runs inside Claude Code where tool names differ. Inject a remapping note
	// before the prior context so the model uses correct names regardless of what the prior
	// context describes.
	parts.push(
		"<tool_context>\n" +
			"You are running inside Claude Code. Use these exact tool names — do not use lowercase or pi-native names:\n" +
			"- Shell commands: 'Bash' (not 'bash')\n" +
			"- File operations: 'Read', 'Write', 'Edit', 'Glob', 'Grep' (PascalCase, not lowercase)\n" +
			"</tool_context>",
	);

	if (context.systemPrompt) {
		parts.push(`<prior_system_context>\n${context.systemPrompt}\n</prior_system_context>`);
	}

	const turns: string[] = [];
	for (const msg of context.messages) {
		const text = extractMessageText(msg);
		if (!text) continue;
		const tag =
			msg.role === "user" ? "user_message" : msg.role === "assistant" ? "assistant_message" : "system_message";
		turns.push(`<${tag}>\n${text}\n</${tag}>`);
	}
	if (turns.length > 0) {
		parts.push(`<conversation_history>\n${turns.join("\n")}\n</conversation_history>`);
	}

	return parts.join("\n\n");
}

/** Strip the `data:<mime>;base64,` prefix from a data URI, returning only the raw base64 payload. */
function stripDataUriPrefix(value: string): string {
	const commaIndex = value.indexOf(",");
	if (value.startsWith("data:") && commaIndex !== -1) {
		return value.slice(commaIndex + 1);
	}
	return value;
}

/** Extract the MIME type from a data URI string, or return `null` if the value is not a valid data URI. */
function inferMimeTypeFromDataUri(value: string): string | null {
	const match = /^data:([^;,]+);base64,/.exec(value);
	return match?.[1] ?? null;
}

/** Collect all base64 image blocks from user messages in the context for inclusion in the SDK prompt. */
export function extractImageBlocksFromContext(context: Context): SDKInputImageBlock[] {
	const imageBlocks: SDKInputImageBlock[] = [];
	const seenImageKeys = new Set<string>();

	for (const msg of context.messages) {
		if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const block = part as { type?: unknown; data?: unknown; mimeType?: unknown };
			if (block.type !== "image" || typeof block.data !== "string") continue;

			const mimeType =
				typeof block.mimeType === "string" && block.mimeType.length > 0
					? block.mimeType
					: inferMimeTypeFromDataUri(block.data);
			if (!mimeType) continue;

			const data = stripDataUriPrefix(block.data);
			const imageKey = `${mimeType}\0${createHash("sha1").update(data).digest("hex")}`;
			if (seenImageKeys.has(imageKey)) continue;
			seenImageKeys.add(imageKey);

			imageBlocks.push({
				type: "image",
				source: {
					type: "base64",
					media_type: mimeType,
					data,
				},
			});
		}
	}

	return imageBlocks;
}

/** Build the SDK query prompt, wrapping image blocks into an async iterable user message when present. */
export function buildSdkQueryPrompt(
	context: Context,
	textPrompt: string = buildPromptFromContext(context),
): string | AsyncIterable<SDKInputUserMessage> {
	const imageBlocks = extractImageBlocksFromContext(context);
	if (imageBlocks.length === 0) {
		return textPrompt;
	}

	const content: SDKInputUserContentBlock[] = [...imageBlocks];
	if (textPrompt) {
		content.push({ type: "text", text: textPrompt });
	}

	const sdkMessage: SDKInputUserMessage = {
		type: "user",
		message: { role: "user", content },
		parent_tool_use_id: null,
	};

	return {
		async *[Symbol.asyncIterator]() {
			yield sdkMessage;
		},
	};
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/** Build a minimal error `AssistantMessage` with the given model ID and error text. */
function makeErrorMessage(model: string, errorMsg: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `Claude Code error: ${errorMsg}` }],
		api: "anthropic-messages",
		provider: "claude-code",
		model,
		usage: { ...ZERO_USAGE },
		stopReason: "error",
		errorMessage: errorMsg,
		timestamp: Date.now(),
	};
}

export function isClaudeCodeAbortErrorMessage(message: string | undefined | null): boolean {
	if (!message) return false;
	return /\b(?:claude code process aborted by user|request aborted by user|process aborted by user|aborterror)\b/i.test(message);
}

function isBareClaudeCodeAbortErrorMessage(message: string | undefined | null): boolean {
	if (!message) return false;
	const normalized = message.trim().replace(/\s+/g, " ").toLowerCase();
	return normalized === "claude code process aborted by user"
		|| normalized === "request aborted by user"
		|| normalized === "process aborted by user";
}

export function resolveClaudeCodeAbortedMessageText(errorMsg: string, lastTextContent: string): string {
	const trimmedError = errorMsg.trim();
	if (trimmedError && !isBareClaudeCodeAbortErrorMessage(trimmedError)) {
		return trimmedError;
	}
	return lastTextContent;
}

/**
 * Generator exhaustion without a terminal result means the SDK stream was
 * interrupted mid-turn. Surface it as an error so downstream recovery logic
 * can classify and retry it instead of treating it as a clean completion.
 */
export function makeStreamExhaustedErrorMessage(model: string, lastTextContent: string): AssistantMessage {
	const errorMsg = "stream_exhausted_without_result";
	const message = makeErrorMessage(model, errorMsg);
	if (lastTextContent) {
		message.content = [{ type: "text", text: lastTextContent }];
	}
	return message;
}

/** Extract the string labels from an array of SDK elicitation option objects, filtering out blank entries. */
function readElicitationChoices(options: SdkElicitationRequestOption[] | undefined): string[] {
	if (!Array.isArray(options)) return [];
	return options
		.map((option) => (typeof option?.const === "string" ? option.const : typeof option?.title === "string" ? option.title : ""))
		.filter((option): option is string => option.length > 0);
}

let cachedHeadlessAnswersPath: string | undefined;
let cachedHeadlessAnswers: HeadlessAnswersFile | null | undefined;

function loadHeadlessAnswers(env: NodeJS.ProcessEnv = process.env): HeadlessAnswersFile | null {
	const filePath = env.GSD_HEADLESS_ANSWERS_PATH?.trim();
	if (!filePath) return null;
	if (cachedHeadlessAnswersPath === filePath) return cachedHeadlessAnswers ?? null;

	cachedHeadlessAnswersPath = filePath;
	cachedHeadlessAnswers = null;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		cachedHeadlessAnswers = parsed as HeadlessAnswersFile;
		return cachedHeadlessAnswers;
	} catch {
		return null;
	}
}

function normalizeHeadlessQuestionId(id: string): string {
	return id.trim().toLowerCase().replace(/[-\s]+/g, "_").replace(/_confirm$/, "");
}

function findHeadlessAnswer(
	answers: Record<string, string | string[]> | undefined,
	questionId: string,
): string | string[] | undefined {
	if (!answers) return undefined;
	const normalizedQuestionId = normalizeHeadlessQuestionId(questionId);

	for (const [key, answer] of Object.entries(answers)) {
		if (normalizeHeadlessQuestionId(key) === normalizedQuestionId) return answer;
	}

	for (const [key, answer] of Object.entries(answers)) {
		const normalizedKey = normalizeHeadlessQuestionId(key);
		if (normalizedQuestionId.startsWith(`${normalizedKey}_`) || normalizedKey.startsWith(`${normalizedQuestionId}_`)) {
			return answer;
		}
	}

	return undefined;
}

function answerValueForQuestion(
	question: ParsedElicitationQuestion,
	answers: HeadlessAnswersFile,
): string | string[] | undefined {
	const explicit = findHeadlessAnswer(answers.questions, question.id);
	if (explicit !== undefined) return explicit;

	const strategy = answers.defaults?.strategy ?? "first_option";
	if (strategy === "cancel") return undefined;
	return question.allowMultiple ? [question.options[0]?.label ?? ""] : question.options[0]?.label;
}

function answerElicitationFromHeadlessAnswers(
	questions: ParsedElicitationQuestion[],
	answers: HeadlessAnswersFile | null,
): SdkElicitationResult | null {
	if (!answers) return null;
	if (answers.defaults?.strategy === "cancel" && !answers.questions) return { action: "cancel" };

	const content: Record<string, string | string[]> = {};
	for (const question of questions) {
		const rawAnswer = answerValueForQuestion(question, answers);
		if (rawAnswer === undefined) return { action: "cancel" };

		const labels = new Set(question.options.map((option) => option.label));
		if (question.allowMultiple) {
			const selected = (Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer]).filter((value) => labels.has(value));
			if (selected.length > 0) {
				content[question.id] = selected;
				continue;
			}
			if ((answers.defaults?.strategy ?? "first_option") === "cancel") return { action: "cancel" };
			content[question.id] = [question.options[0]?.label ?? ""];
			continue;
		}

		const selected = Array.isArray(rawAnswer) ? rawAnswer[0] : rawAnswer;
		if (typeof selected === "string" && labels.has(selected)) {
			content[question.id] = selected;
			continue;
		}
		if ((answers.defaults?.strategy ?? "first_option") === "cancel") return { action: "cancel" };
		content[question.id] = question.options[0]?.label ?? "";
	}

	return { action: "accept", content };
}

/** Parse an SDK elicitation request into structured multiple-choice questions, or null if the schema is unsupported. */
export function parseAskUserQuestionsElicitation(
	request: Pick<SdkElicitationRequest, "mode" | "requestedSchema">,
): ParsedElicitationQuestion[] | null {
	if (request.mode && request.mode !== "form") return null;
	const properties = request.requestedSchema?.properties;
	if (!properties || typeof properties !== "object") return null;

	const questions: ParsedElicitationQuestion[] = [];

	for (const [fieldId, rawField] of Object.entries(properties)) {
		if (fieldId.endsWith("__note")) continue;
		if (!rawField || typeof rawField !== "object") return null;

		const header = typeof rawField.title === "string" && rawField.title.length > 0 ? rawField.title : fieldId;
		const question = typeof rawField.description === "string" ? rawField.description : "";

		if (rawField.type === "array") {
			const options = readElicitationChoices(rawField.items?.anyOf).map((label) => ({ label, description: "" }));
			if (options.length === 0) return null;
			questions.push({
				id: fieldId,
				header,
				question,
				options,
				allowMultiple: true,
			});
			continue;
		}

		if (rawField.type === "string") {
			const noteFieldId = Object.prototype.hasOwnProperty.call(properties, `${fieldId}__note`)
				? `${fieldId}__note`
				: undefined;
			const options = readElicitationChoices(rawField.oneOf)
				.filter((label) => label !== OTHER_OPTION_LABEL)
				.map((label) => ({ label, description: "" }));
			if (options.length === 0) return null;
			questions.push({
				id: fieldId,
				header,
				question,
				options,
				noteFieldId,
			});
			continue;
		}

		return null;
	}

	return questions.length > 0 ? questions : null;
}

/** Return true if the elicitation field should be treated as sensitive and rendered as a secure/password input. */
function isSecureElicitationField(
	requestMessage: string,
	fieldId: string,
	field: SdkElicitationFieldSchema,
): boolean {
	if (field.format === "password") return true;
	if (field.writeOnly === true) return true;

	const rawField = field as Record<string, unknown>;
	if (rawField.sensitive === true || rawField["x-sensitive"] === true) return true;

	const haystack = [
		requestMessage,
		fieldId.replace(/[_-]+/g, " "),
		typeof field.title === "string" ? field.title : "",
		typeof field.description === "string" ? field.description : "",
	]
		.join(" ")
		.toLowerCase();

	return SENSITIVE_FIELD_PATTERN.test(haystack);
}

/** Parse an SDK elicitation request into free-text input field descriptors, or null if unsupported. */
export function parseTextInputElicitation(
	request: Pick<SdkElicitationRequest, "message" | "mode" | "requestedSchema">,
): ParsedTextInputField[] | null {
	if (request.mode && request.mode !== "form") return null;
	const schema = request.requestedSchema as
		| ({ properties?: Record<string, SdkElicitationFieldSchema>; keys?: Record<string, SdkElicitationFieldSchema> } & Record<string, unknown>)
		| undefined;
	const fieldsSource = schema?.properties && typeof schema.properties === "object"
		? schema.properties
		: schema?.keys && typeof schema.keys === "object"
			? schema.keys
			: undefined;
	if (!fieldsSource) return null;

	const requiredSet = new Set(
		Array.isArray(request.requestedSchema?.required)
			? request.requestedSchema.required.filter((value): value is string => typeof value === "string")
			: [],
	);

	const fields: ParsedTextInputField[] = [];
	for (const [fieldId, field] of Object.entries(fieldsSource)) {
		if (!field || typeof field !== "object") continue;
		if (field.type !== "string") continue;
		if (Array.isArray(field.oneOf) && field.oneOf.length > 0) continue;

		fields.push({
			id: fieldId,
			title: typeof field.title === "string" && field.title.length > 0 ? field.title : fieldId,
			description: typeof field.description === "string" ? field.description : "",
			required: requiredSet.has(fieldId),
			secure: isSecureElicitationField(request.message, fieldId, field),
		});
	}

	return fields.length > 0 ? fields : null;
}

/** Convert a TUI interview round result into the SDK elicitation content map. */
export function roundResultToElicitationContent(
	questions: ParsedElicitationQuestion[],
	result: RoundResult,
): Record<string, string | string[]> {
	const content: Record<string, string | string[]> = {};

	for (const question of questions) {
		const answer = result.answers[question.id];
		if (!answer) continue;

		if (question.allowMultiple) {
			const selected = Array.isArray(answer.selected) ? answer.selected : [answer.selected];
			content[question.id] = selected;
			continue;
		}

		const selected = Array.isArray(answer.selected) ? answer.selected[0] ?? "" : answer.selected;
		content[question.id] = selected;
		if (question.noteFieldId && selected === OTHER_OPTION_LABEL && answer.notes.trim().length > 0) {
			content[question.noteFieldId] = answer.notes.trim();
		}
	}

	return content;
}

/** Build the dialog title string for a multiple-choice elicitation question, combining server name, header, and question text. */
function buildElicitationPromptTitle(request: SdkElicitationRequest, question: ParsedElicitationQuestion): string {
	const parts = [
		request.serverName ? `[${request.serverName}]` : "",
		question.header,
		question.question,
	].filter((part) => part && part.trim().length > 0);
	return parts.join("\n\n");
}

/** Drive each multiple-choice elicitation question through the extension UI's `select` dialog, collecting answers into an SDK result. */
async function promptElicitationWithDialogs(
	request: SdkElicitationRequest,
	questions: ParsedElicitationQuestion[],
	ui: ExtensionUIContext,
	signal: AbortSignal,
): Promise<SdkElicitationResult> {
	const content: Record<string, string | string[]> = {};

	for (const question of questions) {
		const title = buildElicitationPromptTitle(request, question);

		if (question.allowMultiple) {
			const selected = await ui.select(title, question.options.map((option) => option.label), {
				allowMultiple: true,
				signal,
			});
			if (Array.isArray(selected)) {
				if (selected.length === 0) return { action: "cancel" };
				content[question.id] = selected;
				continue;
			}
			if (typeof selected === "string" && selected.length > 0) {
				content[question.id] = [selected];
				continue;
			}
			return { action: "cancel" };
		}

		const selected = await ui.select(title, [...question.options.map((option) => option.label), OTHER_OPTION_LABEL], { signal });
		if (typeof selected !== "string" || selected.length === 0) {
			return { action: "cancel" };
		}

		content[question.id] = selected;
		if (question.noteFieldId && selected === OTHER_OPTION_LABEL) {
			const note = await ui.input(`${question.header} note`, "Explain your answer", { signal });
			if (note === undefined) return { action: "cancel" };
			if (note.trim().length > 0) {
				content[question.noteFieldId] = note.trim();
			}
		}
	}

	return { action: "accept", content };
}

/** Build the dialog title string for a free-text input field, combining server name, field title, and description. */
function buildTextInputPromptTitle(request: SdkElicitationRequest, field: ParsedTextInputField): string {
	const parts = [
		request.serverName ? `[${request.serverName}]` : "",
		field.title,
		field.description,
	].filter((part) => typeof part === "string" && part.trim().length > 0);
	return parts.join("\n\n");
}

/** Derive a placeholder hint for a free-text input field from its description, falling back to "Required" or "Leave empty to skip". */
function buildTextInputPlaceholder(field: ParsedTextInputField): string | undefined {
	const desc = field.description.trim();
	if (!desc) return field.required ? "Required" : "Leave empty to skip";

	const formatLine = desc
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => /^format:/i.test(line));

	if (!formatLine) return field.required ? "Required" : "Leave empty to skip";
	const hint = formatLine.replace(/^format:\s*/i, "").trim();
	return hint.length > 0 ? hint : field.required ? "Required" : "Leave empty to skip";
}

/** Collect each free-text input field via the extension UI's `input` dialog, returning the filled SDK elicitation result. */
async function promptTextInputElicitation(
	request: SdkElicitationRequest,
	fields: ParsedTextInputField[],
	ui: ExtensionUIContext,
	signal: AbortSignal,
): Promise<SdkElicitationResult> {
	const content: Record<string, string | string[]> = {};

	for (const field of fields) {
		const value = await ui.input(
			buildTextInputPromptTitle(request, field),
			buildTextInputPlaceholder(field),
			{ signal, ...(field.secure ? { secure: true } : {}) },
		);
		if (value === undefined) {
			return { action: "cancel" };
		}
		content[field.id] = value;
	}

	return { action: "accept", content };
}

// ---------------------------------------------------------------------------
// canUseTool handler
// ---------------------------------------------------------------------------

/** Options passed by the SDK to the canUseTool callback. */
interface CanUseToolOptions {
	signal: AbortSignal;
	suggestions?: Array<Record<string, unknown>>;
	blockedPath?: string;
	decisionReason?: string;
	title?: string;
	displayName?: string;
	description?: string;
	toolUseID: string;
	agentID?: string;
}

/** Result returned by the canUseTool callback to the SDK. */
type CanUseToolPermissionResult =
	| { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: Array<Record<string, unknown>>; toolUseID?: string }
	| { behavior: "deny"; message: string; interrupt?: boolean; toolUseID?: string };

/**
 * Known CLI tools where the subcommand verb changes the risk profile.
 * Value = number of subcommand tokens (beyond the executable) to capture
 * in the "Always Allow" permission pattern.
 *
 * `git push` and `git log` are very different → depth 1 → `Bash(git push:*)`
 * `gh pr create` and `gh pr list` differ at depth 2 → `Bash(gh pr create:*)`
 * `ping` is always safe → not listed → `Bash(ping:*)`
 */
const SUBCOMMAND_DEPTH: Record<string, number> = {
	git: 1,
	gh: 2,
	npm: 1,
	npx: 1,
	yarn: 1,
	pnpm: 1,
	docker: 1,
	kubectl: 1,
	aws: 2,
	az: 2,
	gcloud: 2,
	cargo: 1,
	pip: 1,
	pip3: 1,
	brew: 1,
	terraform: 1,
	helm: 1,
	dotnet: 1,
};

/** Command wrappers to skip when extracting the base executable. */
const CMD_PASSTHROUGH = new Set(["sudo", "env", "command"]);

/**
 * Build a smart permission pattern for Bash "Always Allow".
 *
 * Simple commands → `Bash(ping:*)` (any args are fine)
 * Subcommand-sensitive CLIs → `Bash(git push:*)` (verb is captured, args wildcarded)
 */
export function buildBashPermissionPattern(command: string): string {
	// When the command is a chain like "cd /foo && gh pr list", extract the
	// last segment — `cd` is just setup, the meaningful operation is what follows.
	const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
	// Skip leading `cd` (directory setup) and trailing error suppressors
	// like `|| true`, `|| :`, `|| echo ...`.  The meaningful command is
	// the first segment that is *neither* of those.
	const SETUP_RE = /^\s*cd\s/;
	const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
	let meaningful: string | undefined;
	if (segments.length > 1) {
		// Strip suppressors, then strip cd prefixes; take the *last* remaining
		// segment — that's the meaningful command.
		const trimmed = segments.filter(s => !SUPPRESSOR_RE.test(s));
		const core = trimmed.filter(s => !SETUP_RE.test(s));
		meaningful = core.length > 0 ? core[core.length - 1] : trimmed[trimmed.length - 1];
	}
	meaningful = meaningful || segments[0] || command;
	const rawTokens = meaningful.trim().split(/\s+/);

	// Skip sudo/env wrappers and leading VAR=val assignments
	let idx = 0;
	while (idx < rawTokens.length) {
		if (CMD_PASSTHROUGH.has(rawTokens[idx])) { idx++; continue; }
		if (/^[A-Za-z_]\w*=/.test(rawTokens[idx])) { idx++; continue; }
		break;
	}
	const tokens = rawTokens.slice(idx).filter(Boolean);
	if (tokens.length === 0) return "Bash(*)";

	// Strip path and .exe from executable name
	const base = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
	const depth = SUBCOMMAND_DEPTH[base];

	if (depth !== undefined) {
		// Capture base + N subcommand tokens: "gh pr list" → Bash(gh pr list:*)
		const significant = [base, ...tokens.slice(1, 1 + depth)].join(" ");
		return `Bash(${significant}:*)`;
	}

	// Simple command — any args are fine: "ping" → Bash(ping:*)
	return `Bash(${base}:*)`;
}

/**
 * Build the list of granularity options presented after a user chooses
 * "Always Allow" for a Bash command.
 *
 * Rather than assuming the user wants the default smart pattern, the UI
 * shows every meaningful prefix so the user explicitly picks the scope:
 *
 *   "gh pr list --limit 5" → [
 *     "Bash(gh:*)",         // allow any gh command
 *     "Bash(gh pr:*)",      // allow any gh pr subcommand
 *     "Bash(gh pr list:*)", // allow just this verb
 *   ]
 *
 * Flags (tokens starting with `-`) terminate the subcommand chain — they
 * are call-site arguments, not stable verbs. Subcommand depth is capped
 * at 3 to keep the menu short (max 4 options).
 *
 * Returns a single-entry list when there is no meaningful subcommand to
 * choose from (e.g. `ls -la`). Callers can skip the second dialog in
 * that case.
 */
export function buildBashPermissionPatternOptions(command: string): string[] {
	const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
	const SETUP_RE = /^\s*cd\s/;
	const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
	let meaningful: string | undefined;
	if (segments.length > 1) {
		const trimmed = segments.filter(s => !SUPPRESSOR_RE.test(s));
		const core = trimmed.filter(s => !SETUP_RE.test(s));
		meaningful = core.length > 0 ? core[core.length - 1] : trimmed[trimmed.length - 1];
	}
	meaningful = meaningful || segments[0] || command;
	const rawTokens = meaningful.trim().split(/\s+/);

	let idx = 0;
	while (idx < rawTokens.length) {
		if (CMD_PASSTHROUGH.has(rawTokens[idx])) { idx++; continue; }
		if (/^[A-Za-z_]\w*=/.test(rawTokens[idx])) { idx++; continue; }
		break;
	}
	const tokens = rawTokens.slice(idx).filter(Boolean);
	if (tokens.length === 0) return ["Bash(*)"];

	const base = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");

	// Collect up to 3 subcommand tokens, stopping at the first flag.
	const subTokens: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("-")) break;
		subTokens.push(t);
		if (subTokens.length >= 3) break;
	}

	const patterns: string[] = [`Bash(${base}:*)`];
	for (let i = 1; i <= subTokens.length; i++) {
		patterns.push(`Bash(${[base, ...subTokens.slice(0, i)].join(" ")}:*)`);
	}
	return patterns;
}

/**
 * Read Bash allow-rule patterns from project and user settings files.
 *
 * Returns the ruleContent portion (e.g. `"gh pr list:*"`) for each
 * `Bash(...)` entry found in `permissions.allow`.
 */
function readBashAllowRulesFromSettings(): string[] {
	const rules: string[] = [];
	const paths = [
		join(process.cwd(), ".claude", "settings.local.json"),
		join(process.cwd(), ".claude", "settings.json"),
	];
	try {
		paths.push(join(homedir(), ".claude", "settings.json"));
	} catch {
		// homedir() can throw on some platforms
	}
	for (const settingsPath of paths) {
		try {
			if (!existsSync(settingsPath)) continue;
			const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
			const allow = raw?.permissions?.allow;
			if (!Array.isArray(allow)) continue;
			for (const entry of allow) {
				if (typeof entry !== "string") continue;
				const m = /^Bash\((.+)\)$/.exec(entry);
				if (m) rules.push(m[1]);
			}
		} catch {
			// Ignore malformed settings files
		}
	}
	return rules;
}

/**
 * Check if a Bash compound command matches saved allow rules after
 * extracting the meaningful segment.
 *
 * The SDK's built-in matcher refuses to match prefix rules against
 * compound commands (e.g. `cd /path && gh pr list`). Claude Code
 * routinely prepends `cd <cwd> &&` to commands, causing saved rules
 * to never match on re-invocation. This function strips safe leading
 * segments (only `cd` commands) and checks the remaining operation
 * against saved rules.
 *
 * For compound commands, returns true only when all leading segments
 * are `cd` commands and the final segment matches a saved rule.
 * For simple (single-segment) commands, checks directly against saved
 * rules — this covers the case where a rule was added mid-session and
 * the SDK's in-memory cache is stale.
 */
export function bashCommandMatchesSavedRules(command: string): boolean {
	const segments = command.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
	if (segments.length === 0) return false;

	let meaningful: string;
	if (segments.length === 1) {
		meaningful = segments[0].trim();
	} else {
		// Strip trailing error suppressors (|| true, || :, || echo ...)
		// and leading cd segments.  The first remaining segment is the
		// meaningful command.  All other non-cd, non-suppressor segments
		// must be absent — otherwise we can't safely auto-approve.
		const SETUP_RE = /^cd\s/;
		const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
		const trimmed = segments.filter(s => !SUPPRESSOR_RE.test(s.trim()));
		const core = trimmed.filter(s => !SETUP_RE.test(s.trim()));
		if (core.length !== 1) return false; // ambiguous — multiple real commands
		meaningful = core[0].trim();
	}
	if (!meaningful) return false;

	const rules = readBashAllowRulesFromSettings();
	if (rules.length === 0) return false;

	for (const rule of rules) {
		const prefixMatch = /^(.+):\*$/.exec(rule);
		if (prefixMatch) {
			const prefix = prefixMatch[1];
			if (meaningful === prefix || meaningful.startsWith(prefix + " ")) {
				return true;
			}
			continue;
		}
		// Exact match
		if (meaningful === rule) return true;
	}

	return false;
}

/** Format the tool input into a human-readable summary for the permission prompt. */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
	// Bash — show the command
	if (input.command && typeof input.command === "string") {
		const cmd = input.command.length > 300 ? input.command.slice(0, 300) + "…" : input.command;
		return cmd;
	}
	// File-oriented tools — show path
	if (input.file_path && typeof input.file_path === "string") {
		return `${toolName}: ${input.file_path}`;
	}
	// Generic fallback — compact JSON, truncated
	const json = JSON.stringify(input);
	if (json.length <= 200) return json;
	return json.slice(0, 200) + "…";
}

/**
 * Create a canUseTool handler that routes SDK permission requests through the
 * extension UI's select dialog, or auto-approves when no UI is available.
 *
 * Presents three options:
 * - **Allow** — approve this one invocation
 * - **Always Allow** — approve and pass `suggestions` back as `updatedPermissions`
 *   so the SDK remembers the choice for the rest of the session
 * - **Deny** — reject the invocation
 *
 * Follows the same pattern as {@link createClaudeCodeElicitationHandler}:
 * takes an optional UI context and returns the callback or undefined.
 *
 * When UI is unavailable (headless / auto-mode sub-agents), returns a handler
 * that always approves — replacing the old GSD_AUTO_MODE → bypassPermissions
 * workaround.
 */
export function createClaudeCodeCanUseToolHandler(
	ui: ExtensionUIContext | undefined,
): ((toolName: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<CanUseToolPermissionResult>) | undefined {
	if (!ui) return undefined;

	return async (toolName, _input, options) => {
		// Abort early if the signal is already fired
		if (options.signal.aborted) {
			return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
		}

		// For Bash compound commands (e.g. "cd /path && gh pr list"),
		// check if the meaningful operation matches a saved allow rule.
		// The SDK's built-in matcher rejects prefix rules for compound
		// commands, but cd-prefixed commands are routine and the actual
		// operation is already approved.
		if (toolName === "Bash" && typeof _input.command === "string") {
			if (bashCommandMatchesSavedRules(_input.command)) {
				return { behavior: "allow", updatedInput: _input, toolUseID: options.toolUseID };
			}
		}

		const inputSummary = formatToolInput(toolName, _input);
		const title = options.title || `Allow Claude Code to use: ${toolName}?`;
		const body = [
			options.description,
			inputSummary,
		].filter(Boolean).join("\n");

		// The 2nd menu (level picker) lets the user choose the exact pattern,
		// so the 1st menu just shows "Always Allow" without a command suffix.
		const alwaysAllowLabel = "Always Allow";

		try {
			const choice = await ui.select(
				`${title}\n${body}`,
				["Allow", alwaysAllowLabel, "Deny"],
				{ signal: options.signal },
			);

			if (options.signal.aborted) {
				return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
			}

			if (choice === alwaysAllowLabel) {
				// Pass the SDK's own suggestions back as updatedPermissions so
				// it knows how to persist them (PermissionUpdate[] shape).
				// For Bash, patch the ruleContent with the user-chosen
				// granularity pattern (e.g. "gh", "gh pr", "gh pr list") so
				// the saved rule matches the scope the user actually wants.
				let perms = options.suggestions;
				let notifyLabel: string | undefined;
				if (toolName === "Bash" && typeof _input.command === "string") {
					// Present every meaningful prefix so the user picks the
					// scope explicitly rather than getting a blanket match.
					const patternOptions = buildBashPermissionPatternOptions(_input.command);
					let chosenPattern: string;
					if (patternOptions.length <= 1) {
						// No subcommand choice to make (e.g. "ls -la") — use
						// the single available pattern directly.
						chosenPattern = patternOptions[0] ?? buildBashPermissionPattern(_input.command);
					} else {
						const levelChoiceRaw = await ui.select(
							"Save permission at which level?",
							patternOptions,
							{ signal: options.signal },
						);
						if (options.signal.aborted) {
							return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
						}
						const levelChoice = Array.isArray(levelChoiceRaw) ? levelChoiceRaw[0] : levelChoiceRaw;
						if (!levelChoice || !patternOptions.includes(levelChoice)) {
							// User dismissed the level picker — cancel the
							// tool use. Falling back to a one-time allow
							// here would leave the spawned agent running
							// with no clear signal that the user bailed.
							return {
								behavior: "deny",
								message: "User cancelled permission selection",
								toolUseID: options.toolUseID,
							};
						}
						chosenPattern = levelChoice;
					}
					notifyLabel = chosenPattern;
					// Extract the ruleContent portion from "Bash(gh pr list:*)" → "gh pr list:*"
					const ruleContent = chosenPattern.replace(/^Bash\(/, "").replace(/\)$/, "");
					if (perms && Array.isArray(perms) && perms.length > 0) {
						// Clone suggestions and patch ruleContent on any Bash addRules entry
						perms = perms.map((s: any) => {
							if (s.type === "addRules" && Array.isArray(s.rules)) {
								return {
									...s,
									rules: s.rules.map((r: any) =>
										r.toolName === "Bash" ? { ...r, ruleContent } : r,
									),
								};
							}
							return s;
						});
					} else {
						// No suggestions from SDK — build a proper PermissionUpdate
						perms = [{
							type: "addRules",
							rules: [{ toolName: "Bash", ruleContent }],
							behavior: "allow",
							destination: "localSettings",
						}];
					}
				} else if (!perms || (Array.isArray(perms) && perms.length === 0)) {
					// Non-Bash tool with no SDK-supplied suggestions. Without a
					// fallback rule the SDK would return `behavior: "allow"`
					// with no `updatedPermissions`, so "Always Allow" silently
					// fails to persist for tools whose input varies per call
					// (e.g. AskUserQuestion with different `questions` payloads).
					// A bare `{ toolName }` rule matches any input.
					perms = [{
						type: "addRules",
						rules: [{ toolName }],
						behavior: "allow",
						destination: "localSettings",
					}];
					notifyLabel = toolName;
				}
				// Notify with the resolved pattern (label already previewed it)
				if (notifyLabel) {
					ui.notify(`Saved: ${notifyLabel}`, "info");
				}
				return {
					behavior: "allow",
					updatedInput: _input,
					toolUseID: options.toolUseID,
					...(perms ? { updatedPermissions: perms } : {}),
				};
			}

			if (choice === "Allow") {
				return {
					behavior: "allow",
					updatedInput: _input,
					toolUseID: options.toolUseID,
				};
			}

			return { behavior: "deny", message: "User denied", toolUseID: options.toolUseID };
		} catch {
			return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
		}
	};
}

// ---------------------------------------------------------------------------
// Elicitation handler
// ---------------------------------------------------------------------------

/**
 * Create an SDK elicitation handler that routes requests through the extension UI dialogs, or undefined if no UI is available.
 *
 * For structured (AskUserQuestion) elicitations, the interview round's result
 * disambiguates two cases that must not be conflated: an `undefined` result
 * means the custom UI is unavailable, so we fall back to the simpler `select`
 * dialogs; an empty-answers result means the user dismissed the question, which
 * is treated as a clean cancel. Falling back to dialogs on dismissal would
 * re-ask the same questions (the duplicate-question bug).
 */
export function createClaudeCodeElicitationHandler(
	ui: ExtensionUIContext | undefined,
): ((request: SdkElicitationRequest, options: { signal: AbortSignal }) => Promise<SdkElicitationResult>) | undefined {
	if (!ui) return undefined;

	return async (request, { signal }) => {
		if (request.mode === "url") {
			return { action: "decline" };
		}

		const questions = parseAskUserQuestionsElicitation(request);
		if (questions) {
			const headlessAnswer = answerElicitationFromHeadlessAnswers(questions, loadHeadlessAnswers());
			if (headlessAnswer) return headlessAnswer;

			// The SDK elicitation blocks waiting for human input. An expiry timer
			// closes the local form just before the MCP server drops the request,
			// and the aborter is registered so a timed-out ask_user_questions
			// tool-result can tear the overlay down (see
			// abortActiveAskUserQuestionElicitationsForTimeout).
			const formAbortController = new AbortController();
			let expiryNoticeShown = false;
			const abortExpiredForm = (): void => {
				if (formAbortController.signal.aborted) return;
				formAbortController.abort();
				if (!expiryNoticeShown) {
					expiryNoticeShown = true;
					ui.notify(ELICITATION_EXPIRED_NOTICE, "warning");
				}
			};
			const forwardSdkAbort = (): void => {
				if (!formAbortController.signal.aborted) formAbortController.abort();
			};
			if (signal.aborted) {
				forwardSdkAbort();
			} else {
				signal.addEventListener("abort", forwardSdkAbort, { once: true });
			}
			const expiryTimer = setTimeout(abortExpiredForm, CLAUDE_CODE_INTERVIEW_FORM_TIMEOUT_MS);
			activeAskUserQuestionElicitationTimeoutAborters.add(abortExpiredForm);
			try {
				const interviewResult = await showInterviewRound(
					questions,
					{ signal: formAbortController.signal, overlay: true },
					{ ui } as any,
				).catch(() => undefined);
				if (interviewResult === undefined) {
					// `await` so the dialog human-wait stays inside try/finally and the
					// in-flight guard is held until the dialog resolves. Without it,
					// `finally` runs the moment the promise is created and the fallback
					// wait runs with zero in-flight tools — reintroducing the
					// self-cancel on this path (Bugbot #1c00624d).
					return await promptElicitationWithDialogs(request, questions, ui, formAbortController.signal);
				}
				if (Object.keys(interviewResult.answers).length === 0) {
					// A system/host teardown (compaction, session_switch, true
					// interrupt) that aborted the signal mid-wait sets `interrupted`.
					// Surface that as a non-affirmative `decline` so it is not
					// laundered into a clean user-declined `cancel` the model re-asks
					// against. A genuine user dismissal leaves `interrupted` falsy and
					// keeps the prior `cancel` semantics.
					return interviewResult.interrupted ? { action: "decline" } : { action: "cancel" };
				}
				return {
					action: "accept",
					content: roundResultToElicitationContent(questions, interviewResult),
				};
			} finally {
				clearTimeout(expiryTimer);
				signal.removeEventListener("abort", forwardSdkAbort);
				activeAskUserQuestionElicitationTimeoutAborters.delete(abortExpiredForm);
			}
		}

		const textFields = parseTextInputElicitation(request);
		if (textFields) {
			return await promptTextInputElicitation(request, textFields, ui, signal);
		}

		return { action: "decline" };
	};
}

/**
 * Aborted by the caller's AbortSignal — distinct from exhaustion. GSD's
 * agent loop keys off `stopReason === "aborted"` to treat this as a clean
 * user cancel instead of a retry-eligible provider failure.
 */
export function makeAbortedMessage(model: string, lastTextContent: string): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: lastTextContent
			? [{ type: "text", text: lastTextContent }]
			: [{ type: "text", text: "Claude Code stream aborted by caller" }],
		api: "anthropic-messages",
		provider: "claude-code",
		model,
		usage: { ...ZERO_USAGE },
		stopReason: "aborted",
		timestamp: Date.now(),
	};
	return message;
}

// ---------------------------------------------------------------------------
// SDK options builder
// ---------------------------------------------------------------------------

/**
 * Resolve the Claude Code permission mode for the current run.
 *
 * Defaults to `acceptEdits`, which auto-approves file reads/edits but
 * surfaces a permission dialog for dangerous operations (e.g. general Bash,
 * Agent, WebFetch). This prevents tools outside the allowlist from being
 * silently denied — the SDK emits an `extension_ui_request` event so the
 * user sees a prompt instead of a silent refusal that Claude Code mistakes
 * for user rejection (#4383).
 *
 * Set `GSD_CLAUDE_CODE_PERMISSION_MODE` to `bypassPermissions` to restore
 * the old always-approve behaviour, or to `default` / `plan` for stricter
 * modes.
 *
 * When `GSD_HEADLESS=1` is set (auto-mode / non-interactive runs), the
 * default flips to `bypassPermissions` because there is no UI to approve
 * permission dialogs — `acceptEdits` would hang verification commands like
 * `npx tsc --noEmit` or `npx vitest run` indefinitely (#4657). Explicit
 * overrides still win, so users can opt back into `acceptEdits` in headless.
 */
export async function resolveClaudePermissionMode(
	env: NodeJS.ProcessEnv = process.env,
): Promise<"bypassPermissions" | "acceptEdits" | "default" | "plan"> {
	const override = env.GSD_CLAUDE_CODE_PERMISSION_MODE?.trim();
	if (override === "bypassPermissions" || override === "acceptEdits" || override === "default" || override === "plan") {
		return override;
	}
	if (env.GSD_HEADLESS === "1") {
		console.warn(
			"[claude-code-cli] Headless mode detected (GSD_HEADLESS=1): defaulting permissionMode to 'bypassPermissions' so verification Bash commands can run. Set GSD_CLAUDE_CODE_PERMISSION_MODE=acceptEdits to opt out.",
		);
		return "bypassPermissions";
	}
	return "bypassPermissions";
}

// NOTE: These helpers intentionally mirror @gsd/pi-ai anthropic-shared
// behavior so this extension remains typecheck-stable even when the published
// @gsd/pi-ai barrel lags behind monorepo source exports.
/** Return true for model IDs that support the adaptive thinking API (Opus 4.6/4.7/4.8, Sonnet 4.6/4.7, Haiku 4.5). */
function modelSupportsAdaptiveThinking(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6")
		|| modelId.includes("opus-4.6")
		|| modelId.includes("opus-4-7")
		|| modelId.includes("opus-4.7")
		|| modelId.includes("opus-4-8")
		|| modelId.includes("opus-4.8")
		|| modelId.includes("fable-5")
		|| modelId.includes("fable.5")
		|| modelId.includes("sonnet-4-6")
		|| modelId.includes("sonnet-4.6")
		|| modelId.includes("sonnet-4-7")
		|| modelId.includes("sonnet-4.7")
		|| modelId.includes("haiku-4-5")
		|| modelId.includes("haiku-4.5")
	);
}

/** Map a GSD thinking level to the Anthropic effort value, clamping xhigh to max for models that lack native xhigh support. */
function mapThinkingLevelToAnthropicEffort(level: ThinkingLevel | undefined, modelId: string): "low" | "medium" | "high" | "xhigh" | "max" {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			if (
				modelId.includes("opus-4-7")
				|| modelId.includes("opus-4.7")
				|| modelId.includes("opus-4-8")
				|| modelId.includes("opus-4.8")
				|| modelId.includes("fable-5")
				|| modelId.includes("fable.5")
			) return "xhigh";
			if (modelId.includes("opus-4-6") || modelId.includes("opus-4.6")) return "max";
			return "high";
		default:
			return "high";
	}
}

/**
 * Build the options object passed to the Claude Agent SDK's `query()` call.
 *
 * Extracted for testability — callers can verify session persistence,
 * beta flags, and other configuration without mocking the full SDK.
 *
 * `permissionMode` / `allowDangerouslySkipPermissions` are resolved through
 * {@link resolveClaudePermissionMode} so interactive runs don't silently
 * bypass the SDK's permission gate. Callers that want the old always-bypass
 * behaviour pass `permissionMode: "bypassPermissions"` explicitly.
 */
export function buildSdkOptions(
	modelId: string,
	prompt: string,
	overrides?: { permissionMode?: "bypassPermissions" | "acceptEdits" | "default" | "plan" },
	extraOptions: Record<string, unknown> & { reasoning?: ThinkingLevel } = {},
): Record<string, unknown> {
	const { reasoning, cwd, ...sdkExtraOptions } = extraOptions;
	const sdkCwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd : process.cwd();
	const permissionMode = overrides?.permissionMode ?? "bypassPermissions";

	const supportsAdaptive = modelSupportsAdaptiveThinking(modelId);
	const effort =
		reasoning && supportsAdaptive
			? mapThinkingLevelToAnthropicEffort(reasoning, modelId)
			: undefined;

	// Bug B: SDK requires thinking:{type:"adaptive"} alongside effort for adaptive thinking to activate.
	// Bug C: SDK requires thinking:{type:"disabled"} to actually stop adaptive thinking when reasoning is off;
	//        omitting the field leaves the SDK in its adaptive default (or persisted session state).
	const thinkingConfig = supportsAdaptive
		? effort
			? { thinking: { type: "adaptive" } }
			: { thinking: { type: "disabled" } }
		: undefined;

	return {
		pathToClaudeCodeExecutable: getClaudePath(),
		model: modelId,
		includePartialMessages: true,
		persistSession: true,
		cwd: sdkCwd,
		permissionMode,
		allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
		settingSources: ["user", "project", "local"],
		systemPrompt: { type: "preset", preset: "claude_code" },
		betas: (
			modelId.includes("sonnet")
			|| modelId.includes("opus-4-7")
			|| modelId.includes("opus-4.7")
			|| modelId.includes("opus-4-8")
			|| modelId.includes("opus-4.8")
			|| modelId.includes("fable-5")
			|| modelId.includes("fable.5")
		) ? ["context-1m-2025-08-07"] : [],
		...(thinkingConfig ?? {}),
		...(effort ? { effort } : {}),
		...sdkExtraOptions,
	};
}

// ---------------------------------------------------------------------------
// streamSimple implementation
// ---------------------------------------------------------------------------

let capturedClaudeCodeUIContext: ExtensionUIContext | undefined;

/**
 * Capture the active extension UI context from `before_provider_request`. Core
 * invokes `streamSimple` with a plain `SimpleStreamOptions` (no
 * `extensionUIContext`), so without this the elicitation handler is never wired
 * and `ask_user_questions` immediately returns cancelled. See index.ts, which
 * registers the hook that calls this.
 */
export function setClaudeCodeUIContext(ui: ExtensionUIContext | undefined): void {
	capturedClaudeCodeUIContext = ui;
}

/**
 * GSD streamSimple function that delegates to the Claude Agent SDK.
 *
 * Emits AssistantMessageEvent deltas for real-time TUI rendering
 * (thinking, text, tool calls). The final AssistantMessage preserves
 * SDK-executed tool-call blocks for Agent Core's `externalToolExecution`
 * path, which renders the results without dispatching the tools locally.
 */
/**
 * SDK teardown-race safety net (claude-agent-sdk 0.2.83).
 *
 * The SDK fires `handleControlRequest()` fire-and-forget (no await, no catch)
 * from its readMessages loop; when our session-teardown abort races an
 * in-flight control-request write, `transport.write()` throws "Operation
 * aborted" inside that orphaned async method → unhandledRejection → the WHOLE
 * host process dies mid-loop (seen live twice: A1 take-3/take-4, 2026-07-10,
 * always on the plan→T01 session transition). Upstream bug — report to
 * Anthropic; until fixed, swallow ONLY this exact signature and re-crash for
 * everything else (setImmediate throw restores default fatal semantics).
 */
let sdkAbortNetInstalled = false;
function installSdkAbortRejectionNet(): void {
	if (sdkAbortNetInstalled) return;
	sdkAbortNetInstalled = true;
	process.on("unhandledRejection", (reason) => {
		const msg = reason instanceof Error ? reason.message : String(reason);
		const stack = reason instanceof Error ? (reason.stack ?? "") : "";
		const isAbortMsg = /\b(Operation|Request) aborted\b/.test(msg);
		// Three shapes seen live (A1 takes 3-6, 2026-07-10): Error with SDK
		// frames, Error thrown by the adapter itself, and a BARE STRING
		// rejection ("Request aborted") with no stack at final teardown. All
		// are the same benign already-aborted class; a stackless non-Error
		// abort string cannot be attributed to user code in this binary.
		const isSdkPath =
			stack === "" ||
			stack.includes("claude-agent-sdk") ||
			stack.includes("claude-code-cli");
		if (isAbortMsg && isSdkPath) {
			return; // benign: already-aborted SDK transport/query during teardown
		}
		setImmediate(() => {
			throw reason;
		});
	});
}

export function streamViaClaudeCode(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	installSdkAbortRejectionNet();
	const stream = createAssistantStream();

	void pumpSdkMessages(model, context, options, stream);

	return stream;
}

interface SdkAttemptMessageState {
	builder: PartialMessageBuilder | null;
	intermediateToolBlocks: AssistantMessage["content"];
	intermediateTextBlocks: AssistantMessage["content"];
	toolResultsById: Map<string, ExternalToolResultPayload>;
	toolCompletionTargetsById: Map<string, { partial: AssistantMessage; contentIndex: number }>;
	emittedExternalToolResultIds: Set<string>;
}

function createSdkAttemptMessageState(): SdkAttemptMessageState {
	return {
		builder: null,
		intermediateToolBlocks: [],
		intermediateTextBlocks: [],
		toolResultsById: new Map<string, ExternalToolResultPayload>(),
		toolCompletionTargetsById: new Map<string, { partial: AssistantMessage; contentIndex: number }>(),
		emittedExternalToolResultIds: new Set<string>(),
	};
}

/** Async pump that drives the Claude Agent SDK's async-iterable message stream and pushes events into `stream`. */
async function pumpSdkMessages(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const modelId = model.id;
	/** Track the last text content seen across all assistant turns for the final message. */
	let lastTextContent = "";
	let lastThinkingContent = "";
	// E2E-2/W1: guards every abort/exhaustion push against a double-emit. Hoisted
	// to function scope so the exhaustion fallback and the outer catch (both outside
	// the streaming block) can honour an out-of-band abort already emitted.
	let abortEmitted = false;
	// Set when the turn already pushed its terminal message (done or error).
	// A LATER teardown abort (session replacement / process shutdown) must NOT
	// append an "aborted" message on top — print-mode reads the session's LAST
	// message and would report "Request aborted" + exit 1 for a run that
	// completed successfully (seen live: A1 takes 5-7, 2026-07-10, milestone
	// complete + real commits but exit 1).
	let terminalEmitted = false;

	try {
		const permissionMode = await resolveClaudePermissionMode();
		const claudeOptions = options as ClaudeCodeStreamOptions | undefined;
		const uiContext = claudeOptions?.extensionUIContext ?? capturedClaudeCodeUIContext;
		const onExternalToolCall = claudeOptions?.onExternalToolCall;
		const onExternalToolResult = claudeOptions?.onExternalToolResult;
		const sdkQueryForTest = claudeOptions?._sdkQueryForTest;
		// Resolve the forge MCP record ONCE, up front. When a record is
		// published, this is an externalCli worker dispatch and we must mount the
		// in-process `forge_unit_result` MCP server so the subprocess `claude` can
		// commit its result back into the shared rendezvous singleton (B1/B2).
		// When it is null (interactive / in-process / fake), we inject NOTHING —
		// the options stay byte-identical to today (W2).
		const forgeMcpRecord = getWorkerMcpRecord();
		// Lazily obtain the SDK module: reuse the real dynamic import when there
		// is no query seam, otherwise use the injected test module. Only actually
		// needed to build the MCP server (i.e. when a record is published).
		let sdkModuleForMcp: ForgeSdkModule | undefined = claudeOptions?._sdkMcpModuleForTest;
		const importedSdk = sdkQueryForTest
			? undefined
			: // Dynamic import — the SDK is an optional dependency.
				(await import(/* webpackIgnore: true */ "@anthropic-ai/claude-agent-sdk")) as {
					query: (args: {
						prompt: string | AsyncIterable<unknown>;
						options?: Record<string, unknown>;
					}) => AsyncIterable<SDKMessage>;
					createSdkMcpServer?: ForgeSdkModule["createSdkMcpServer"];
					tool?: ForgeSdkModule["tool"];
				};
		if (!sdkModuleForMcp && importedSdk?.createSdkMcpServer && importedSdk.tool) {
			sdkModuleForMcp = {
				createSdkMcpServer: importedSdk.createSdkMcpServer,
				tool: importedSdk.tool,
			};
		}
		const query = sdkQueryForTest ?? importedSdk!.query;
		const cwd = resolveClaudeCodeCwd(options);
		const canUseToolHandler = createClaudeCodeCanUseToolHandler(uiContext);
		// When no UI is available (headless), auto-approve all tool requests.
		// This replaces the old bypassPermissions workaround.
		const canUseToolFallback = canUseToolHandler
			?? (async (_toolName: string, _input: Record<string, unknown>, opts: CanUseToolOptions): Promise<CanUseToolPermissionResult> =>
				({ behavior: "allow", toolUseID: opts.toolUseID }));
		const sdkOpts = buildSdkOptions(
			modelId,
			"",
			{ permissionMode },
			{
				cwd,
				reasoning: options?.reasoning,
				canUseTool: canUseToolFallback,
				...(uiContext
					? {
							onElicitation: createClaudeCodeElicitationHandler(uiContext),
						}
					: {}),
			},
		);
		const prompt = buildPromptFromContext(context);
		const queryPrompt = buildSdkQueryPrompt(context, prompt);

		// Emit start with an empty partial
		const initialPartial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "claude-code",
			model: modelId,
			usage: { ...ZERO_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: initialPartial });

		{
				let {
					builder,
					intermediateToolBlocks,
					intermediateTextBlocks,
					toolResultsById,
					toolCompletionTargetsById,
					emittedExternalToolResultIds,
				} = createSdkAttemptMessageState();
				const controller = new AbortController();

				// Inject the forge MCP server + its namespaced tool ONLY when a
				// record is published AND we have an SDK module to build it with.
				// B1: `buildWorkerMcpServer` freezes the record's epoch token into
				// the handler closure HERE, at query-build time — never read live
				// at delivery. B2: the tool name is APPENDED to `allowedTools`
				// (never replace), preserving any tools already permitted.
				let mcpInjection: Record<string, unknown> = {};
				if (forgeMcpRecord && sdkModuleForMcp) {
					const built = buildWorkerMcpServer(forgeMcpRecord, sdkModuleForMcp);
					const existingMcpServers =
						(sdkOpts.mcpServers as Record<string, unknown> | undefined) ?? {};
					const existingAllowed = Array.isArray(sdkOpts.allowedTools)
						? (sdkOpts.allowedTools as string[])
						: [];
					const mergedAllowed = existingAllowed.includes(built.allowedTools[0]!)
						? existingAllowed
						: [...existingAllowed, ...built.allowedTools];
					mcpInjection = {
						mcpServers: { ...existingMcpServers, [built.serverName]: built.config },
						allowedTools: mergedAllowed,
						// M2R-1 Fix 1 Part A (primary): a forge worker dispatch must NOT
						// inherit the operator's full MCP fleet (`settingSources` default
						// of ["user","project","local"] set in `buildSdkOptions`). A large
						// tool count flips the claude-code subprocess into tool-search
						// mode, under which MCP tools (including our own commit tool)
						// become DEFERRED — never appearing eagerly, requiring a
						// `ToolSearch` preload the commit-point prompt didn't ask for
						// until Part B. Zeroing `settingSources` here keeps the worker's
						// tool surface small so `mcp__forge__forge_unit_result` stays
						// eager and directly callable. This ONLY applies to worker
						// dispatches (forgeMcpRecord != null) — normal/interactive
						// sessions keep the baseline `settingSources` untouched.
						//
						// M2 dialectic review R1 (ruled OPEN, operator decision: keep
						// Part A, document the tradeoff): zeroing `settingSources` also
						// drops settings.json-sourced hooks (Pre/PostToolUse), subagents,
						// output-styles, and env-vars for worker dispatches — the SDK
						// option is a coarse per-source on/off switch with no per-key
						// filter to keep hooks while excluding only the settings-sourced
						// MCP servers. Permission rules are NOT affected: worker
						// dispatches already resolve to `bypassPermissions` (see
						// `resolveClaudePermissionMode`), so no permission gate is
						// removed by this. Verified via A1 (real-provider wordstats run)
						// confirming the commit tool stays eager and gets called.
						settingSources: [],
					};
				}

				const queryResult = query({
					prompt: queryPrompt,
					options: {
						...sdkOpts,
						...mcpInjection,
						abortController: controller,
					},
				});

				// ── E2E-2/W1: out-of-band abort observation ──────────────────────
				// The gate at the top of the `for await` below only trips when the
				// SDK yields the NEXT message — inert while a subprocess is hung
				// mid-tool (never yields). This listener observes `options.signal`
				// directly: once (anti-double-push via `abortEmitted`) it pushes the
				// aborted error and tears the query down (controller.abort + best-
				// effort iterator interrupt/return) so the agent's waitForIdle()/
				// abort() settle instead of blocking on a zombie turn.
				const emitAbortAndTeardown = (): void => {
					if (abortEmitted) return;
					abortEmitted = true;
					// Teardown of an ALREADY-COMPLETED turn is cleanup, not an error:
					// skip the aborted-message push (else it becomes the session's
					// last message and print-mode exits 1 on a successful run), but
					// still abort + interrupt the query below.
					if (!terminalEmitted) {
						stream.push({
							type: "error",
							reason: "aborted",
							error: makeAbortedMessage(modelId, lastTextContent),
						});
					}
					controller.abort();
					// `interrupt`/`return` are both optional on the SDK's returned
					// async-iterator and safe to call redundantly; swallow failures.
					// BOTH channels: the sync try/catch covers synchronous throws, but
					// the SDK's interrupt() returns a PROMISE that rejects when the
					// transport is already dead ("Operation aborted") — an unswallowed
					// rejection here is an unhandledRejection that kills the whole
					// process mid-loop (seen live: A1 take-3, 2026-07-10, crash on the
					// plan→T01 session transition). Teardown of an already-dead query
					// is success by definition.
					const q = queryResult as {
						interrupt?: () => unknown;
						return?: (value?: unknown) => unknown;
					};
					const swallowAsync = (r: unknown): void => {
						(r as { catch?: (fn: () => void) => unknown } | undefined)?.catch?.(() => {
							/* best-effort teardown */
						});
					};
					try {
						swallowAsync(q.interrupt?.());
					} catch {
						/* best-effort teardown */
					}
					try {
						swallowAsync(q.return?.(undefined));
					} catch {
						/* best-effort teardown */
					}
				};
				const forwardAbort = (): void => emitAbortAndTeardown();
				if (options?.signal) {
					if (options.signal.aborted) {
						// Already aborted before we could subscribe — settle now rather
						// than wait for a message that may never come.
						emitAbortAndTeardown();
					} else {
						options.signal.addEventListener("abort", forwardAbort, { once: true });
					}
				}

				try {
					for await (const msg of queryResult as AsyncIterable<SDKMessage>) {
					if (options?.signal?.aborted) {
						// User-initiated cancel — emit an aborted error (idempotent with
						// the out-of-band listener above) so the agent loop classifies
						// this as a deliberate stop, not a transient provider failure to
						// retry.
						emitAbortAndTeardown();
						return;
					}

					switch (msg.type) {
						// -- Streaming partial messages --
						case "stream_event": {
							const partial = msg as SDKPartialAssistantMessage;

							const event = partial.event;

							const result = handleClaudeCodePartialStreamEvent(builder, event, modelId);
							builder = result.builder;
							const assistantEvent = result.assistantEvent;
							if (assistantEvent) {
								stream.push(assistantEvent);
								if (assistantEvent.type === "toolcall_start") {
									const toolBlock = assistantEvent.partial.content[assistantEvent.contentIndex];
									if (toolBlock?.type === "toolCall") {
										try {
											await onExternalToolCall?.(toolBlock);
										} catch (error) {
											console.warn("[claude-code] onExternalToolCall callback failed:", error);
										}
									}
								}
							}
							break;
						}

						// -- Complete assistant message (non-streaming fallback) --
						case "assistant": {
							const sdkAssistant = msg as SDKAssistantMessage;

							// Capture text content from complete messages
							for (const block of sdkAssistant.message.content) {
								if (block.type === "text") {
									lastTextContent = block.text;
								} else if (block.type === "thinking") {
									lastThinkingContent = block.thinking;
								}
							}
							break;
						}

						// -- User message (synthetic tool result — signals turn boundary) --
						case "user": {
							// Capture content from the completed turn before resetting
							if (builder) {
								for (const [contentIndex, block] of builder.message.content.entries()) {
									if (block.type === "text" && block.text) {
										lastTextContent = block.text;
										// Accumulate completed prose in order — a multi-question
										// turn commits [prose][elicitation] segments across several
										// synthetic-user boundaries, and overwriting a single
										// scalar would drop every explanation but the last.
										intermediateTextBlocks.push({ type: "text", text: block.text });
									} else if (block.type === "thinking" && block.thinking) {
										lastThinkingContent = block.thinking;
										intermediateTextBlocks.push({ type: "thinking", thinking: block.thinking });
									} else if (block.type === "toolCall" || block.type === "serverToolUse") {
										// Collect tool blocks for externalToolExecution rendering
										intermediateToolBlocks.push(block);
										toolCompletionTargetsById.set(block.id, {
											partial: builder.message,
											contentIndex,
										});
									}
								}
							}

							// Extract tool results from the SDK's synthetic user message
							// and attach to corresponding tool call blocks immediately.
							for (const { toolUseId, result } of extractToolResultsFromSdkUserMessage(msg as SDKUserMessage)) {
								toolResultsById.set(toolUseId, result);
							}
							attachExternalResultsToToolBlocks(intermediateToolBlocks, toolResultsById);

							// Push a synthetic toolcall_end for each tool call from this turn
							// so the TUI can render tool results in real-time during the SDK
							// session instead of waiting until the entire session completes.
							for (const block of intermediateToolBlocks) {
								if (block.type !== "toolCall" && block.type !== "serverToolUse") continue;
								if (emittedExternalToolResultIds.has(block.id)) continue;
								const target = toolCompletionTargetsById.get(block.id);
								if (!target) continue;

								const extResult = (block as ToolCallWithExternalResult).externalResult;
								if (!extResult) continue;
								const suppressDuplicateUnavailable = shouldSuppressDuplicateToolUnavailableBlock(
									block,
									target.partial.content,
								);
								// Push synthetic completion events with result attached so the
								// chat-controller can update pending ToolExecutionComponents.
								if (block.type === "toolCall") {
									if (isAskUserQuestionsTimedOutResult(block, extResult)) {
										abortActiveAskUserQuestionElicitationsForTimeout();
									}
									if (suppressDuplicateUnavailable) {
										delete (block as ToolCallWithExternalResult).externalResult;
										stream.push({
											type: "toolcall_end",
											contentIndex: target.contentIndex,
											toolCall: block,
											partial: target.partial,
										});
										(block as ToolCallWithExternalResult).externalResult = extResult;
										emittedExternalToolResultIds.add(block.id);
										continue;
									}
									try {
										await onExternalToolResult?.({
											toolCall: block,
											result: extResult,
										});
									} catch (error) {
										console.warn("[claude-code] onExternalToolResult callback failed:", error);
									}
									stream.push({
										type: "toolcall_end",
										contentIndex: target.contentIndex,
										toolCall: block,
										partial: target.partial,
									});
									emittedExternalToolResultIds.add(block.id);
								} else if (block.type === "serverToolUse") {
									const toolCall = serverToolUseToToolCallLike(block);
									if (isAskUserQuestionsTimedOutResult(toolCall, extResult)) {
										abortActiveAskUserQuestionElicitationsForTimeout();
									}
									try {
										await onExternalToolResult?.({
											toolCall,
											result: extResult,
										});
									} catch (error) {
										console.warn("[claude-code] onExternalToolResult callback failed:", error);
									}
									stream.push({
										type: "server_tool_use",
										contentIndex: target.contentIndex,
										partial: target.partial,
									});
									emittedExternalToolResultIds.add(block.id);
								}
							}

							builder = null;
							break;
						}

						// -- Result (terminal) --
						case "result": {
							const result = msg as SDKResultMessage;
							const finalContent = buildFinalAssistantContent({
								intermediateToolBlocks,
								intermediateTextBlocks,
								pendingContent: builder?.message.content,
								toolResultsById,
								lastThinkingContent,
								lastTextContent,
								fallbackResultText:
									result.subtype === "success" && result.result ? result.result : undefined,
							});

							const finalMessage: AssistantMessage = {
								role: "assistant",
								content: finalContent,
								api: "anthropic-messages",
								provider: "claude-code",
								model: modelId,
								usage: mapUsage(result.usage, result.total_cost_usd),
								stopReason: result.is_error ? "error" : "stop",
								timestamp: Date.now(),
							};

							terminalEmitted = true;
							if (result.is_error) {
								finalMessage.errorMessage = getResultErrorMessage(result);
								stream.push({ type: "error", reason: "error", error: finalMessage });
							} else {
								stream.push({ type: "done", reason: "stop", message: finalMessage });
							}
							return;
						}

						default:
							break;
					}
				}
				} finally {
					options?.signal?.removeEventListener("abort", forwardAbort);
				}
		}

		// Generator exhaustion without a terminal result is a stream interruption,
		// not a successful completion. Emitting an error lets GSD classify it as a
		// transient provider failure. E2E-2: if the abort listener already tore the
		// query down (its best-effort `return()` completes the loop cleanly), the
		// aborted error was already pushed — do not overwrite it with an exhaustion.
		if (!abortEmitted) {
			const fallback = makeStreamExhaustedErrorMessage(modelId, lastTextContent);
			stream.push({ type: "error", reason: "error", error: fallback });
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (options?.signal?.aborted || isClaudeCodeAbortErrorMessage(errorMsg)) {
			// E2E-2: the out-of-band teardown (`controller.abort()` +
			// iterator interrupt/return) commonly makes the awaited iterator throw
			// here — but the aborted error was already pushed. Guard the double-push.
			if (!abortEmitted) {
				const abortedText = resolveClaudeCodeAbortedMessageText(errorMsg, lastTextContent);
				stream.push({
					type: "error",
					reason: "aborted",
					error: makeAbortedMessage(modelId, abortedText),
				});
			}
			return;
		}
		stream.push({
			type: "error",
			reason: "error",
			error: makeErrorMessage(modelId, errorMsg),
		});
	}
}
