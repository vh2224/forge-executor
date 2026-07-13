/**
 * Request User Input — LLM tool for asking the user questions
 *
 * Thin wrapper around the shared interview-ui. The LLM presents 1-3
 * questions with 2-3 options each. Each question can be single-select (default)
 * or multi-select (allowMultiple: true). A free-form "None of the above" option
 * is added automatically to single-select questions.
 *
 * Based on: https://github.com/openai/codex (codex-rs/core/src/tools/handlers/ask_user_questions.rs)
 */

import type { ExtensionAPI, Theme } from "@gsd/pi-coding-agent";
import { sanitizeError } from "./shared/sanitize.js";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	showInterviewRound,
	type Question,
	type QuestionOption,
	type RoundResult,
} from "./shared/tui.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Local, self-contained notification-preferences shape. Inlined (D2) to drop the
 * former condemned-gsd types dependency — used only as an optional param type for
 * the best-effort question bell below.
 */
interface NotificationPreferences {
	bell?: boolean;
	[key: string]: unknown;
}

interface LocalResultDetails {
	questions: Question[];
	response: RoundResult | null;
	cancelled: boolean;
	interrupted?: boolean;
}

type AskUserQuestionsDetails = LocalResultDetails;

// ─── Schema ───────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	label: Type.String({ description: "User-facing label (1-5 words)" }),
	description: Type.String({ description: "One short sentence explaining impact/tradeoff if selected" }),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional markdown content shown in a side-by-side preview panel when this option is highlighted. Use for showing code samples, config snippets, or detailed explanations. Keep under ~20 lines — longer content is truncated.",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for mapping answers (snake_case)" }),
	header: Type.String({ description: "Short header label shown in the UI (12 or fewer chars)" }),
	question: Type.String({ description: "Single-sentence prompt shown to the user" }),
	options: Type.Array(OptionSchema, {
		description:
			'Provide 2-3 mutually exclusive choices for single-select, or any number for multi-select. Put the recommended option first and suffix its label with "(Recommended)". Each option can include an optional "preview" field with markdown content shown in a side panel. Do not include an "Other" option for single-select; the client adds a free-form "None of the above" option automatically.',
	}),
	allowMultiple: Type.Optional(
		Type.Boolean({
			description:
				"If true, the user can select multiple options using SPACE to toggle and ENTER to confirm. No 'None of the above' option is added. Default: false.",
		}),
	),
});

const AskUserQuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to show the user. Prefer 1 and do not exceed 3.",
	}),
});

// ─── Per-turn deduplication ──────────────────────────────────────────────────
// Prevents duplicate question dispatches (especially to remote channels like
// Discord) when the LLM calls ask_user_questions multiple times with the same
// questions in a single turn. Keyed by full canonicalized payload (id, header,
// question, options, allowMultiple) — not just IDs — so that calls with the
// same IDs but different text/options are treated as distinct.

import { createHash } from "node:crypto";

interface CachedResult {
	content: { type: "text"; text: string }[];
	details: AskUserQuestionsDetails;
}

const turnCache = new Map<string, CachedResult>();

/** @internal Exported for testing only. */
export function questionSignature(questions: Question[]): string {
	const canonical = questions
		.map((q) => ({
			id: q.id,
			header: q.header,
			question: q.question,
			options: (q.options || []).map((o) => ({ label: o.label, description: o.description })),
			allowMultiple: !!q.allowMultiple,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/** Reset the dedup cache. Called on session boundaries. */
export function resetAskUserQuestionsCache(): void {
	turnCache.clear();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OTHER_OPTION_LABEL = "None of the above";

function errorResult(
	message: string,
	questions: Question[] = [],
	options?: { interrupted?: boolean },
): { content: { type: "text"; text: string }[]; details: AskUserQuestionsDetails } {
	return {
		content: [{ type: "text", text: sanitizeError(message) }],
		details: { questions, response: null, cancelled: true, interrupted: options?.interrupted === true },
	};
}

/** Parse the LLM-facing JSON payload back into a RoundResult for TUI rendering. */
function parseLlmAnswersContent(text: string): RoundResult | null {
	try {
		const parsed = JSON.parse(text) as { answers?: Record<string, { answers?: string[] }> };
		if (!parsed?.answers || typeof parsed.answers !== "object") return null;

		const answers: RoundResult["answers"] = {};
		for (const [id, entry] of Object.entries(parsed.answers)) {
			const list = Array.isArray(entry?.answers) ? [...entry.answers] : [];
			let notes = "";
			const noteIdx = list.findIndex((item) => typeof item === "string" && item.startsWith("user_note:"));
			if (noteIdx >= 0) {
				notes = list.splice(noteIdx, 1)[0].replace(/^user_note:\s*/, "");
			}
			if (list.length === 0) continue;
			answers[id] = {
				selected: list.length === 1 ? list[0] : list,
				notes,
			};
		}
		if (Object.keys(answers).length === 0) return null;
		return { endInterview: false, answers };
	} catch {
		return null;
	}
}

function isCancelledResultContent(text: string): boolean {
	return /\bwas cancelled before receiving a response\b/i.test(text)
		|| /\bwas interrupted before receiving a response\b/i.test(text);
}

function renderAnswerLines(questions: Question[], response: RoundResult, theme: Theme): Text {
	const lines: string[] = [];
	for (const q of questions) {
		const answer = response.answers[q.id];
		if (!answer) {
			lines.push(`${theme.fg("accent", q.header)}: ${theme.fg("dim", "(no answer)")}`);
			continue;
		}
		const selected = answer.selected;
		const notes = answer.notes;
		const multiSel = !!q.allowMultiple;
		const answerText = multiSel && Array.isArray(selected)
			? selected.join(", ")
			: (Array.isArray(selected) ? selected[0] : selected) ?? "(no answer)";
		let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", q.header)}: ${answerText}`;
		if (notes) {
			line += ` ${theme.fg("muted", `[note: ${notes}]`)}`;
		}
		lines.push(line);
	}
	return new Text(lines.join("\n"), 0, 0);
}

/** Convert the shared RoundResult into the JSON the LLM expects. */
function formatForLLM(result: RoundResult): string {
	const answers: Record<string, { answers: string[] }> = {};
	for (const [id, answer] of Object.entries(result.answers)) {
		const list: string[] = [];
		if (Array.isArray(answer.selected)) {
			list.push(...answer.selected);
		} else {
			list.push(answer.selected);
		}
		if (answer.notes) {
			list.push(`user_note: ${answer.notes}`);
		}
		answers[id] = { answers: list };
	}
	return JSON.stringify({ answers });
}

/**
 * Inline best-effort terminal bell (D2 — replaces the former condemned-gsd
 * notifications dynamic import). Emits the ASCII BEL to a TTY stream when
 * notifications are not explicitly disabled. No-op otherwise.
 */
function playNotificationBell(
	preferences?: NotificationPreferences,
	stream?: { isTTY?: boolean; write(chunk: string): unknown },
): void {
	if (preferences?.bell === false) return;
	const out = stream ?? process.stderr;
	if (out?.isTTY) {
		out.write("");
	}
}

/** @internal Exported for testing only. */
export async function playQuestionBell(
	preferences?: NotificationPreferences,
	stream?: { isTTY?: boolean; write(chunk: string): unknown },
): Promise<void> {
	try {
		playNotificationBell(preferences, stream);
	} catch {
		// Best-effort: question rendering must never depend on alert delivery.
	}
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function AskUserQuestions(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_questions",
		label: "Request User Input",
		description:
			"Request user input for one to three short questions and wait for the response. Single-select questions have 2-3 mutually exclusive options with a free-form 'None of the above' added automatically. Multi-select questions (allowMultiple: true) let the user toggle multiple options with SPACE and confirm with ENTER. Options can include an optional 'preview' field with markdown content shown in a side-by-side panel when highlighted.",
		promptGuidelines: [
			"Use ask_user_questions when you need the user to choose between concrete alternatives before proceeding.",
			"Keep questions to 1 when possible; never exceed 3.",
			"For single-select: each question must have 2-3 options. Put the recommended option first with '(Recommended)' suffix. Do not include an 'Other' or 'None of the above' option - the client adds one automatically.",
			"For multi-select: set allowMultiple: true. The user can pick any number of options. No 'None of the above' is added.",
			"When options involve code patterns, config choices, or architecture decisions, add a 'preview' field with markdown content (code blocks, lists, headers, etc.). The preview renders in a side-by-side panel when the option is highlighted.",
			"Preview content is rendered in a fixed-height panel (max ~20 lines visible). Keep previews concise — show the most relevant snippet, not exhaustive examples. Longer content stays fully accessible: the user scrolls it with PgUp/PgDn, with '▲/▼ N more' indicators marking hidden rows.",
		],
		parameters: AskUserQuestionsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// ── Per-turn dedup: return cached result for identical question sets ──
			const sig = questionSignature(params.questions);
			const cached = turnCache.get(sig);
			if (cached) {
				return {
					content: [{ type: "text" as const, text: cached.content[0].text + "\n(Returned cached answer — this question set was already asked this turn.)" }],
					details: cached.details,
				};
			}

			// Validation
			if (params.questions.length === 0 || params.questions.length > 3) {
				return errorResult("Error: questions must contain 1-3 items", params.questions);
			}

			for (const q of params.questions) {
				if (!q.options || q.options.length === 0) {
					return errorResult(
						`Error: ask_user_questions requires non-empty options for every question (question "${q.id}" has none)`,
						params.questions,
					);
				}
			}

			// ── Routing: local UI only ──────────────────────────────────────────
			if (ctx.hasUI) {
				await playQuestionBell();
			}

			// Local UI only.
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (non-interactive mode)", params.questions);
			}

			// Delegate to shared interview UI
			const result = await showInterviewRound(params.questions, { signal }, ctx as any);

			// RPC mode fallback: custom() returns undefined, so showInterviewRound
			// may return undefined. Fall back to sequential ctx.ui.select() calls.
			if (!result) {
				const answers: Record<string, { answers: string[] }> = {};
				for (const q of params.questions) {
					const options = q.options.map((o) => o.label);
					if (!q.allowMultiple) {
						options.push(OTHER_OPTION_LABEL);
					}
					const selected = await ctx.ui.select(
						`${q.header}: ${q.question}`,
						options,
						{ signal, ...(q.allowMultiple ? { allowMultiple: true } : {}) },
					);
					if (selected === undefined) {
						return errorResult("ask_user_questions was cancelled", params.questions);
					}

					// When the user picks "None of the above" on a single-select
					// question, prompt for a free-text explanation so they are not
					// trapped in a re-asking loop (bug #2715).
					let freeTextNote = "";
					const selectedStr = Array.isArray(selected) ? selected[0] : selected;
					if (!q.allowMultiple && selectedStr === OTHER_OPTION_LABEL) {
						const note = await ctx.ui.input(
							`${q.header}: Please explain in your own words`,
							"Type your answer here…",
						);
						if (note) {
							freeTextNote = note;
						}
					}

					const answerList = Array.isArray(selected) ? selected : [selected];
					if (freeTextNote) {
						answerList.push(`user_note: ${freeTextNote}`);
					}
					answers[q.id] = { answers: answerList };
				}
				const roundResult: RoundResult = {
					endInterview: false,
					answers: Object.fromEntries(
						Object.entries(answers).map(([id, a]) => [
							id,
							{ selected: a.answers.length === 1 ? a.answers[0] : a.answers, notes: "" },
						]),
					),
				};
				const fallbackResult = {
					content: [{ type: "text" as const, text: JSON.stringify({ answers }) }],
					details: {
						questions: params.questions,
						response: roundResult,
						cancelled: false,
					} satisfies LocalResultDetails,
				};
				turnCache.set(sig, fallbackResult);
				return fallbackResult;
			}

			// Check if cancelled (empty answers = user exited)
			const hasAnswers = Object.keys(result.answers).length > 0;
			if (!hasAnswers) {
				const interrupted = signal?.aborted === true;
				return {
					content: [{
						type: "text",
						text: interrupted
							? "ask_user_questions was interrupted before receiving a response"
							: "ask_user_questions was cancelled before receiving a response",
					}],
					details: {
						questions: params.questions,
						response: null,
						cancelled: true,
						interrupted,
					} satisfies LocalResultDetails,
				};
			}

			const successResult = {
				content: [{ type: "text" as const, text: formatForLLM(result) }],
				details: { questions: params.questions, response: result, cancelled: false } satisfies LocalResultDetails,
			};
			turnCache.set(sig, successResult);
			return successResult;
		},

		// ─── Rendering ────────────────────────────────────────────────────────

		renderCall(args, theme) {
			const qs = (args.questions as Question[]) || [];
			let text = theme.fg("toolTitle", theme.bold("ask_user_questions "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			if (qs.length > 0) {
				const headers = qs.map((q) => q.header).join(", ");
				text += theme.fg("dim", ` (${headers})`);
			}
			const previewCount = qs.reduce(
				(acc, q) => acc + (q.options || []).filter((o: QuestionOption) => o.preview).length,
				0,
			);
			if (previewCount > 0) {
				text += theme.fg("accent", ` [${previewCount} preview${previewCount !== 1 ? "s" : ""}]`);
			}
			for (const q of qs) {
				const multiSel = !!q.allowMultiple;
				text += `\n  ${theme.fg("text", q.question)}`;
				const optLabels = multiSel
					? (q.options || []).map((o: QuestionOption) => o.label)
					: [...(q.options || []).map((o: QuestionOption) => o.label), OTHER_OPTION_LABEL];
				const prefix = multiSel ? "☐" : "";
				const numbered = optLabels.map((l, i) => `${prefix}${i + 1}. ${l}`).join(", ");
				text += `\n  ${theme.fg("dim", numbered)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, context) {
			const details = result.details as AskUserQuestionsDetails | undefined;
			const contentText = result.content[0]?.type === "text" ? result.content[0].text : "";
			const questionsFromArgs = (context?.args as { questions?: Question[] } | undefined)?.questions;
			const parsedResponse = contentText ? parseLlmAnswersContent(contentText) : null;

			if (!details) {
				const questions = questionsFromArgs;
				if (questions?.length && parsedResponse) {
					return renderAnswerLines(questions, parsedResponse, theme);
				}
				return new Text(contentText, 0, 0);
			}

			const questions = details.questions ?? questionsFromArgs;
			const response = details.response ?? parsedResponse;
			const explicitCancel = details.cancelled === true || isCancelledResultContent(contentText);
			if (explicitCancel && !response) {
				const interrupted = "interrupted" in details && details.interrupted === true;
				return new Text(
					theme.fg("warning", interrupted ? "Interrupted" : "Cancelled"),
					0,
					0,
				);
			}

			if (questions?.length && response) {
				return renderAnswerLines(questions, response, theme);
			}

			if (contentText) {
				return new Text(contentText, 0, 0);
			}

			if (details.cancelled || !details.response) {
				const interrupted = "interrupted" in details && details.interrupted === true;
				return new Text(
					theme.fg("warning", interrupted ? "Interrupted" : "Cancelled"),
					0,
					0,
				);
			}

			return new Text("", 0, 0);
		},
	});
}
