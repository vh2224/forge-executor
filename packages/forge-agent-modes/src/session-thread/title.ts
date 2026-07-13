/**
 * Pure title derivation for the session picker. No I/O, no `Date.now()` — the
 * only clock input is `info.created`, so this stays deterministic and testable.
 */
import type { SessionInfo } from "@gsd/pi-coding-agent/core/session-manager.js";

import type { WorkerSliceKind } from "./worker-slice.js";

export type SessionTitleInfo = SessionInfo & { workerSlice?: WorkerSliceKind };

const FORGE_COMMAND_PREFIX = "/forge ";

const WORKER_SLICE_LABELS: Record<WorkerSliceKind, string> = {
	"forge-dispatch": "# Unit: dispatch",
	"forge-review": "# Unit: review",
};

function formatShortDate(date: Date): string {
	if (Number.isNaN(date.getTime())) return "";
	return date.toISOString().slice(0, 10);
}

function firstLineOf(text: string): string {
	const newlineIndex = text.indexOf("\n");
	return (newlineIndex === -1 ? text : text.slice(0, newlineIndex)).trim();
}

/**
 * Title precedence: explicit `name` > `/forge <sub>` command root (+ short
 * date) > worker-slice label > raw `firstMessage` (today's picker behavior,
 * preserved byte-for-byte for ordinary sessions).
 */
export function deriveSessionTitle(info: SessionTitleInfo): string {
	if (info.name) return info.name;

	const firstLine = firstLineOf(info.firstMessage);
	if (firstLine.startsWith(FORGE_COMMAND_PREFIX)) {
		return `${firstLine} · ${formatShortDate(info.created)}`;
	}

	if (info.workerSlice) return WORKER_SLICE_LABELS[info.workerSlice];

	return info.firstMessage;
}
