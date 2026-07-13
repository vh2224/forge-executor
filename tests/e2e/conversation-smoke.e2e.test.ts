/**
 * M0 acceptance #1 (fake) LIVE smoke.
 *
 * Drives the real `gsd`/`forge` binary through a 3-turn fake-LLM transcript
 * that exercises the REAL, registered `bash` and `read` tools (not the
 * unregistered `read_file` used by agent-loop.e2e.test.ts T2). This proves
 * the harness actually executes tools end-to-end, not just dispatches a
 * loop cycle:
 *
 *   turn 1: model calls bash {command: "echo forge-smoke-bash-ok"}
 *   turn 2: model calls read {file_path: "probe.txt"} (sentinel file
 *           written into the tmp project before the run)
 *   turn 3: model returns final text "smoke complete" with stopReason=stop
 *
 * Observed evidence asserted below: exit 0; 2x tool_execution_start +
 * 2x tool_execution_end; the read sentinel content round-trips into the
 * stream; final stopReason=stop; no errorMessage.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
	createTmpProject,
	lastAssistantStopReason,
	lastAssistantText,
	parseJsonEvents,
	runWithFakeLlm,
	writeTranscript,
} from "./_shared/index.ts";

const PRINT_TIMEOUT_MS = 90_000;
const SENTINEL = "hello-from-forge-smoke";

function binaryAvailable(): { ok: boolean; reason?: string } {
	const bin = process.env.GSD_SMOKE_BINARY;
	if (!bin) return { ok: false, reason: "GSD_SMOKE_BINARY not set; build with `npm run build:core` and re-export." };
	if (!existsSync(bin)) return { ok: false, reason: `binary not found at ${bin}` };
	return { ok: true };
}

describe("conversation smoke e2e (fake LLM, real bash+read tools)", () => {
	const avail = binaryAvailable();
	const skipReason = avail.ok ? null : avail.reason;

	test(
		"3-turn transcript drives real bash + read tools and round-trips the read sentinel",
		{ skip: skipReason ?? false },
		(t) => {
			const project = createTmpProject();
			t.after(project.cleanup);

			// Sentinel file the `read` tool call in turn 2 will read back.
			project.writeFile("probe.txt", SENTINEL);

			const transcript = writeTranscript([
				{
					turn: 1,
					expect: { modelId: "gsd-fake-model", lastUserText: "run smoke" },
					emit: {
						kind: "tool_use",
						calls: [
							{
								id: "call-bash",
								name: "bash",
								input: { command: "echo forge-smoke-bash-ok" },
							},
						],
					},
				},
				{
					turn: 2,
					expect: { hasToolResultFor: "bash" },
					emit: {
						kind: "tool_use",
						calls: [
							{
								id: "call-read",
								name: "read",
								input: { file_path: "probe.txt" },
							},
						],
					},
				},
				{
					turn: 3,
					expect: { hasToolResultFor: "read" },
					emit: { kind: "text", text: "smoke complete", stopReason: "stop" },
				},
			]);

			const result = runWithFakeLlm(transcript, {
				cwd: project.dir,
				prompt: "run smoke",
				mode: "json",
				extraEnv: { GSD_TOOL_APPROVAL: "auto" },
				timeoutMs: PRINT_TIMEOUT_MS,
			});

			assert.equal(
				result.code,
				0,
				`expected exit 0, got ${result.code}. stderr=${result.stderrClean.slice(0, 1200)}`,
			);

			const events = parseJsonEvents(result.stdoutClean);

			const startCount = events.filter((e) => e.type === "tool_execution_start").length;
			const endCount = events.filter((e) => e.type === "tool_execution_end").length;
			assert.equal(startCount, 2, `expected 2x tool_execution_start (bash+read), got ${startCount}`);
			assert.equal(endCount, 2, `expected 2x tool_execution_end (bash+read), got ${endCount}`);

			// The read tool's content must round-trip into the stream somewhere
			// (either in a tool_execution_end payload or the raw stdout).
			assert.ok(
				result.stdoutClean.includes(SENTINEL),
				`expected read sentinel "${SENTINEL}" to round-trip into the stream`,
			);

			assert.equal(lastAssistantStopReason(events), "stop");
			assert.equal(lastAssistantText(events), "smoke complete");

			const agentEnd = events.find((e) => e.type === "agent_end") as
				| { messages?: Array<Record<string, unknown>> }
				| undefined;
			const lastAssistantMsg = [...(agentEnd?.messages ?? [])]
				.reverse()
				.find((m) => (m as { role?: string }).role === "assistant") as { errorMessage?: string } | undefined;
			assert.equal(lastAssistantMsg?.errorMessage, undefined, "expected no errorMessage on the final assistant message");
		},
	);
});
