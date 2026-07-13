/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@gsd/pi-ai";
import type { AgentSession } from "@forge/agent-core";
import { createDefaultCommandContextActions } from "./shared/command-context-actions.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			console.log(JSON.stringify(header));
		}
	}
	// Set up extensions for print mode (no UI)
	await session.bindExtensions({
		commandContextActions: createDefaultCommandContextActions(session),
		onError: (err) => {
			console.error(`Extension error (${err.extensionPath}): ${err.error}`);
		},
	});

	// Always subscribe to enable session persistence via _handleAgentEvent
	const unsubscribe = session.subscribe((event) => {
		// In JSON mode, output all events
		if (mode === "json") {
			console.log(JSON.stringify(event));
		}
	});

	let exitCode = 0;

	// A command with structured exit semantics (e.g. /forge auto) may replace
	// the session mid-run (worker dispatch). The ORIGINAL session's prompt then
	// stays pending until final teardown aborts it — rejecting with an abort
	// error AFTER the command already claimed process.exitCode. That rejection
	// is shutdown mechanics, not a run failure: swallow it iff a command
	// claimed the exit code; rethrow anything else (A1 take-10 evidence,
	// 2026-07-10 — "Request aborted" + exit 1 on a fully successful run).
	const promptClaimAware = async (message: string, opts?: { images?: unknown }): Promise<void> => {
		try {
			await session.prompt(message, opts as never);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (process.exitCode !== undefined && /\babort/i.test(msg)) {
				return; // command owns the outcome; teardown abort is benign
			}
			throw err;
		}
	};

	try {
		// Send initial message with attachments
		if (initialMessage) {
			await promptClaimAware(initialMessage, { images: initialImages });
		}

		// Send remaining messages
		for (const message of messages) {
			await promptClaimAware(message);
		}

		// In text mode, output final response
		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (process.env.FORGE_EXIT_DEBUG === "1") {
				process.stderr.write(
					`[forge-exit-debug] print-mode inspect: lastStop=${(lastMessage as { stopReason?: string } | undefined)?.stopReason} ` +
					`exitCode=${String(process.exitCode)} ts=${Date.now()}\n`,
				);
			}
			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;

				// Check for error/aborted
				// A command may have already claimed the exit code with structured
				// semantics (e.g. /forge auto: 0=complete, 3=pause). In that case the
				// last-message heuristic below is wrong — a session-teardown "aborted"
				// artifact is not a run failure. Only apply the heuristic when no
				// command declared an exit code.
				if (
					(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
					process.exitCode === undefined
				) {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
					// Output text content
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							console.log(content.text);
						}
					}
				}
			}
		}

		// Ensure stdout is fully flushed before returning
		// This prevents race conditions where the process exits before all output is written
		await new Promise<void>((resolve, reject) => {
			process.stdout.write("", (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	} finally {
		unsubscribe();
	}

	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}
