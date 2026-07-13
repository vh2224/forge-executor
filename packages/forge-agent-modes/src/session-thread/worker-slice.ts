/**
 * Fork-side detection of forge worker slices (`/forge auto` dispatch/review
 * sub-sessions) inside a session JSONL file.
 *
 * `SessionInfo` (vendored `session-manager-list.ts`) only inspects entries of
 * type `"message"` — it never surfaces `custom_message.customType`, which is
 * where the dispatch/review markers live (`display: false`, so they never
 * reach the LLM-context builder either). This module re-reads just the head
 * of the JSONL to recover that signal, without touching vendored code.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { SessionInfo } from "@gsd/pi-coding-agent/core/session-manager.js";

export type WorkerSliceKind = "forge-dispatch" | "forge-review";

export type ThreadSessionInfo = SessionInfo & { workerSlice?: WorkerSliceKind };

const WORKER_SLICE_KINDS: ReadonlySet<string> = new Set<WorkerSliceKind>(["forge-dispatch", "forge-review"]);

/** Matches the vendored `MAX_CONCURRENT_SESSION_INFO_LOADS` (session-manager-list.ts). */
const MAX_CONCURRENT_DETECTIONS = 10;

/** Marker entries live at the very head of a worker slice; stop scanning past this many. */
const MAX_HEAD_ENTRIES = 8;

/**
 * Reads only the head of `sessionPath` looking for a `custom_message` marker
 * entry that identifies a forge worker slice. Stops as soon as either the
 * marker or the first real conversation turn (`message`, role user/assistant)
 * is seen — a real worker slice always carries its marker before any turn.
 *
 * Never throws: malformed input, I/O errors, and anything short of a valid
 * `type: "session"` header on line 1 resolve to `null` (treated as an
 * ordinary operator session).
 */
export async function detectWorkerSliceKind(sessionPath: string): Promise<WorkerSliceKind | null> {
	const stream = createReadStream(sessionPath, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });

	try {
		let headerSeen = false;
		let scanned = 0;

		for await (const line of rl) {
			if (!line.trim()) continue;

			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				if (!headerSeen) return null;
				continue;
			}

			if (!headerSeen) {
				if (entry.type !== "session") return null;
				headerSeen = true;
				continue;
			}

			if (scanned >= MAX_HEAD_ENTRIES) return null;
			scanned++;

			if (entry.type === "custom_message") {
				const customType = (entry as { customType?: unknown }).customType;
				if (typeof customType === "string" && WORKER_SLICE_KINDS.has(customType)) {
					return customType as WorkerSliceKind;
				}
				continue;
			}

			if (entry.type === "message") {
				const role = (entry as { message?: { role?: string } }).message?.role;
				if (role === "user" || role === "assistant") return null;
			}
		}

		return null;
	} catch {
		return null;
	} finally {
		rl.close();
		stream.destroy();
	}
}

/**
 * Annotates each session with its detected worker-slice kind, if any.
 * Preserves input order; a failed individual detection leaves that session
 * unannotated rather than aborting the batch. Concurrency mirrors the
 * vendored session-list loader's pool size.
 */
export async function enrichSessionsWithWorkerSlice(sessions: SessionInfo[]): Promise<ThreadSessionInfo[]> {
	const results: ThreadSessionInfo[] = new Array(sessions.length);
	let nextIndex = 0;

	const runWorker = async (): Promise<void> => {
		for (;;) {
			const index = nextIndex++;
			if (index >= sessions.length) return;
			const session = sessions[index] as SessionInfo;

			let workerSlice: WorkerSliceKind | null = null;
			try {
				workerSlice = await detectWorkerSliceKind(session.path);
			} catch {
				workerSlice = null;
			}

			results[index] = workerSlice ? { ...session, workerSlice } : { ...session };
		}
	};

	const poolSize = Math.min(MAX_CONCURRENT_DETECTIONS, sessions.length);
	await Promise.all(Array.from({ length: poolSize }, () => runWorker()));

	return results;
}
