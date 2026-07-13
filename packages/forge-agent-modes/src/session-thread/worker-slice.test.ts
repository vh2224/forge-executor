import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { SessionInfo } from "@gsd/pi-coding-agent/core/session-manager.js";

import { detectWorkerSliceKind, enrichSessionsWithWorkerSlice } from "./worker-slice.js";

async function withSandbox(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "forge-worker-slice-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let entrySeq = 0;
function nextId(): string {
	entrySeq++;
	return `entry-${entrySeq}`;
}

function headerLine(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "session",
		id: "session-1",
		timestamp: "2026-07-13T00:00:00.000Z",
		cwd: "/tmp/example",
		...overrides,
	});
}

function customMessageLine(customType: string, content = "prompt"): string {
	return JSON.stringify({
		type: "custom_message",
		id: nextId(),
		parentId: null,
		timestamp: "2026-07-13T00:00:01.000Z",
		customType,
		content,
		display: false,
	});
}

function messageLine(role: "user" | "assistant", text = "hello"): string {
	return JSON.stringify({
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: "2026-07-13T00:00:02.000Z",
		message: { role, content: [{ type: "text", text }] },
	});
}

function writeSession(dir: string, name: string, lines: string[]): string {
	const path = join(dir, name);
	writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");
	return path;
}

function makeSessionInfo(path: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path,
		id: "session-1",
		cwd: "/tmp/example",
		created: new Date("2026-07-13T00:00:00.000Z"),
		modified: new Date("2026-07-13T00:00:00.000Z"),
		messageCount: 0,
		firstMessage: "(no messages)",
		allMessagesText: "",
		...overrides,
	};
}

describe("detectWorkerSliceKind", () => {
	test("detects a real dispatch slice head", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "dispatch.jsonl", [
				headerLine({ parentSession: join(dir, "root.jsonl") }),
				customMessageLine("forge-dispatch"),
				messageLine("assistant", "worker completed"),
			]);
			assert.equal(await detectWorkerSliceKind(path), "forge-dispatch");
		});
	});

	test("detects a real review slice head", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "review.jsonl", [
				headerLine({ parentSession: join(dir, "root.jsonl") }),
				customMessageLine("forge-review"),
				messageLine("assistant", "review done"),
			]);
			assert.equal(await detectWorkerSliceKind(path), "forge-review");
		});
	});

	test("returns null for an ordinary operator session (first entry is a user turn)", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "operator.jsonl", [
				headerLine({ parentSession: join(dir, "root.jsonl") }),
				messageLine("user", "please fix the bug"),
			]);
			assert.equal(await detectWorkerSliceKind(path), null);
		});
	});

	test("returns null for a pre-thread session (no parentSession header field, no marker)", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "pre-thread.jsonl", [headerLine(), messageLine("user", "hi"), messageLine("assistant", "hello")]);
			assert.equal(await detectWorkerSliceKind(path), null);
		});
	});

	test("returns null for an empty file, never throws", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "empty.jsonl", []);
			assert.equal(await detectWorkerSliceKind(path), null);
		});
	});

	test("returns null when line 1 is not valid JSON", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "bad-header.jsonl", ["not json at all", customMessageLine("forge-dispatch")]);
			assert.equal(await detectWorkerSliceKind(path), null);
		});
	});

	test("returns null when line 1 parses but is not a session header", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "wrong-type-header.jsonl", [
				JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: "t", message: { role: "user", content: [] } }),
			]);
			assert.equal(await detectWorkerSliceKind(path), null);
		});
	});

	test("returns null when the only body line is malformed (never throws)", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "malformed-only.jsonl", [headerLine(), "{ this is not valid json"]);
			assert.equal(await detectWorkerSliceKind(path), null);
		});
	});

	test("skips a malformed line mid-file and still finds the marker after it", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "malformed-middle.jsonl", [
				headerLine(),
				"{ not valid json, dropped mid-stream",
				customMessageLine("forge-dispatch"),
			]);
			assert.equal(await detectWorkerSliceKind(path), "forge-dispatch");
		});
	});

	test("tolerates a giant marker line (>1MB prompt content)", async () => {
		await withSandbox(async (dir) => {
			const hugeContent = "x".repeat(2_000_000);
			const path = writeSession(dir, "giant.jsonl", [headerLine(), customMessageLine("forge-dispatch", hugeContent)]);
			assert.equal(await detectWorkerSliceKind(path), "forge-dispatch");
		});
	});

	test("stops early: a marker appearing only after a turn returns null", async () => {
		await withSandbox(async (dir) => {
			const path = writeSession(dir, "late-marker.jsonl", [
				headerLine(),
				messageLine("user", "please fix the bug"),
				customMessageLine("forge-dispatch"),
			]);
			assert.equal(await detectWorkerSliceKind(path), null);
		});
	});

	test("stops early: gives up after the first 8 entries even without a turn", async () => {
		await withSandbox(async (dir) => {
			const noise = Array.from({ length: 9 }, () => customMessageLine("some-other-extension-marker"));
			const path = writeSession(dir, "budget-exhausted.jsonl", [
				headerLine(),
				...noise,
				customMessageLine("forge-dispatch"),
			]);
			assert.equal(await detectWorkerSliceKind(path), null);
		});
	});
});

describe("enrichSessionsWithWorkerSlice", () => {
	test("annotates only detected worker slices, preserving input order", async () => {
		await withSandbox(async (dir) => {
			const dispatchPath = writeSession(dir, "dispatch.jsonl", [headerLine(), customMessageLine("forge-dispatch")]);
			const reviewPath = writeSession(dir, "review.jsonl", [headerLine(), customMessageLine("forge-review")]);
			const operatorPath = writeSession(dir, "operator.jsonl", [headerLine(), messageLine("user", "hi")]);

			const sessions: SessionInfo[] = [
				makeSessionInfo(operatorPath),
				makeSessionInfo(dispatchPath),
				makeSessionInfo(reviewPath),
			];

			const enriched = await enrichSessionsWithWorkerSlice(sessions);

			assert.equal(enriched.length, 3);
			assert.deepEqual(
				enriched.map((s) => s.path),
				[operatorPath, dispatchPath, reviewPath],
			);
			assert.equal(enriched[0]?.workerSlice, undefined);
			assert.equal(enriched[1]?.workerSlice, "forge-dispatch");
			assert.equal(enriched[2]?.workerSlice, "forge-review");
		});
	});

	test("handles a mixed batch larger than the concurrency pool, order intact", async () => {
		await withSandbox(async (dir) => {
			const sessions: SessionInfo[] = [];
			for (let i = 0; i < 12; i++) {
				const isDispatch = i % 3 === 0;
				const path = writeSession(
					dir,
					`s${i}.jsonl`,
					isDispatch ? [headerLine(), customMessageLine("forge-dispatch")] : [headerLine(), messageLine("user", "hi")],
				);
				sessions.push(makeSessionInfo(path, { id: `session-${i}` }));
			}

			const enriched = await enrichSessionsWithWorkerSlice(sessions);

			assert.equal(enriched.length, 12);
			assert.deepEqual(
				enriched.map((s) => s.id),
				sessions.map((s) => s.id),
			);
			for (let i = 0; i < 12; i++) {
				assert.equal(enriched[i]?.workerSlice, i % 3 === 0 ? "forge-dispatch" : undefined);
			}
		});
	});
});
