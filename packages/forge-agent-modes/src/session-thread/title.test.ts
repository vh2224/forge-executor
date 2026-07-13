import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SessionInfo } from "@gsd/pi-coding-agent/core/session-manager.js";

import { deriveSessionTitle, type SessionTitleInfo } from "./title.js";

function makeInfo(overrides: Partial<SessionTitleInfo> = {}): SessionTitleInfo {
	const base: SessionInfo = {
		path: "/tmp/example/session.jsonl",
		id: "session-1",
		cwd: "/tmp/example",
		created: new Date("2026-07-13T10:30:00.000Z"),
		modified: new Date("2026-07-13T10:30:00.000Z"),
		messageCount: 1,
		firstMessage: "explique este arquivo pra mim",
		allMessagesText: "explique este arquivo pra mim",
	};
	return { ...base, ...overrides };
}

describe("deriveSessionTitle", () => {
	test("an explicit name always wins, regardless of firstMessage or workerSlice", () => {
		const info = makeInfo({ name: "minha sessão nomeada", firstMessage: "/forge auto", workerSlice: "forge-dispatch" });
		assert.equal(deriveSessionTitle(info), "minha sessão nomeada");
	});

	test("a run root whose firstMessage starts with a /forge command gets 'comando · data curta'", () => {
		const info = makeInfo({ firstMessage: "/forge auto\n\nbody the user typed after the command" });
		assert.equal(deriveSessionTitle(info), "/forge auto · 2026-07-13");
	});

	test("a single-line /forge command with no trailing body still formats correctly", () => {
		const info = makeInfo({ firstMessage: "/forge next" });
		assert.equal(deriveSessionTitle(info), "/forge next · 2026-07-13");
	});

	test("a visible worker slice gets a label derived from its marker kind", () => {
		const dispatch = makeInfo({ firstMessage: "(no messages)", workerSlice: "forge-dispatch" });
		assert.equal(deriveSessionTitle(dispatch), "# Unit: dispatch");

		const review = makeInfo({ firstMessage: "(no messages)", workerSlice: "forge-review" });
		assert.equal(deriveSessionTitle(review), "# Unit: review");
	});

	test("any other session returns firstMessage unchanged (today's picker behavior, preserved)", () => {
		const info = makeInfo({ firstMessage: "explique este arquivo pra mim" });
		assert.equal(deriveSessionTitle(info), "explique este arquivo pra mim");
	});

	test("firstMessage containing '/forge' mid-string but not as a command prefix falls through to the fallback", () => {
		const info = makeInfo({ firstMessage: "rode /forge auto pra mim, por favor" });
		assert.equal(deriveSessionTitle(info), "rode /forge auto pra mim, por favor");
	});
});
