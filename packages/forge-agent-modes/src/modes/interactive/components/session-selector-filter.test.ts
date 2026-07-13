import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { KeybindingsManager } from "@forge/agent-core";
import type { SessionInfo } from "@gsd/pi-coding-agent/core/session-manager.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

import type { ThreadSessionInfo } from "../../../session-thread/index.js";
import { appKey } from "./keybinding-hints.js";
import { SessionList, SessionSelectorComponent } from "./session-selector.js";
import { TREE_BRANCH, TREE_LAST } from "./tree-render-utils.js";

function makeSession(path: string, overrides: Partial<ThreadSessionInfo> = {}): ThreadSessionInfo {
	return {
		path,
		id: path,
		cwd: "/tmp/example",
		created: new Date("2026-07-13T00:00:00.000Z"),
		modified: new Date("2026-07-13T00:00:00.000Z"),
		messageCount: 1,
		firstMessage: "(no messages)",
		allMessagesText: "",
		...overrides,
	};
}

describe("SessionList worker-slice filter/toggle/tree/title (synthetic sessions, no I/O)", () => {
	beforeEach(() => {
		initTheme("dark", false);
	});

	const root = makeSession("/virtual/root.jsonl", {
		modified: new Date("2026-07-13T09:00:00.000Z"),
		firstMessage: "/forge auto\n\nbody the operator typed",
		allMessagesText: "/forge auto body the operator typed",
	});
	const dispatch1 = makeSession("/virtual/dispatch1.jsonl", {
		parentSessionPath: root.path,
		workerSlice: "forge-dispatch",
		modified: new Date("2026-07-13T09:01:00.000Z"),
		allMessagesText: "dispatch-slice-unique-token",
	});
	const dispatch2 = makeSession("/virtual/dispatch2.jsonl", {
		parentSessionPath: root.path,
		workerSlice: "forge-dispatch",
		modified: new Date("2026-07-13T09:02:00.000Z"),
	});
	const dispatch3 = makeSession("/virtual/dispatch3.jsonl", {
		parentSessionPath: root.path,
		workerSlice: "forge-dispatch",
		modified: new Date("2026-07-13T09:03:00.000Z"),
	});
	const review1 = makeSession("/virtual/review1.jsonl", {
		parentSessionPath: root.path,
		workerSlice: "forge-review",
		modified: new Date("2026-07-13T09:04:00.000Z"),
	});
	const orphan = makeSession("/virtual/orphan.jsonl", {
		modified: new Date("2026-07-13T08:00:00.000Z"),
		firstMessage: "explica esse arquivo pra mim",
		allMessagesText: "explica esse arquivo pra mim",
	});
	const allSessions = [root, dispatch1, dispatch2, dispatch3, review1, orphan];

	function makeList(sessions: ThreadSessionInfo[], showWorkerSlices = false): SessionList {
		return new SessionList(sessions, false, "threaded", "all", showWorkerSlices, KeybindingsManager.inMemory());
	}

	test("default (toggle off) hides worker slices in threaded mode; operator sessions render as today", () => {
		const list = makeList(allSessions);
		const rendered = list.render(100).join("\n");

		assert.ok(!rendered.includes("# Unit: dispatch"), "dispatch slices must not appear by default");
		assert.ok(!rendered.includes("# Unit: review"), "review slice must not appear by default");
		assert.ok(rendered.includes("/forge auto · 2026-07-13"), "run root shows derived command+date title");
		assert.ok(rendered.includes("explica esse arquivo pra mim"), "ordinary session renders firstMessage unchanged");
	});

	test("default (toggle off) also hides worker slices in recent and relevance modes", () => {
		for (const sortMode of ["recent", "relevance"] as const) {
			const list = new SessionList(allSessions, false, sortMode, "all", false, KeybindingsManager.inMemory());
			const rendered = list.render(100).join("\n");
			assert.ok(!rendered.includes("# Unit: dispatch"), `dispatch slices hidden in ${sortMode} mode`);
			assert.ok(!rendered.includes("# Unit: review"), `review slice hidden in ${sortMode} mode`);
		}
	});

	test("toggle on reveals worker slices nested under the parent conversation", () => {
		const list = makeList(allSessions, true);
		const rendered = list.render(100).join("\n");

		const dispatchCount = rendered.split("# Unit: dispatch").length - 1;
		const reviewCount = rendered.split("# Unit: review").length - 1;
		assert.equal(dispatchCount, 3, "all 3 dispatch slices appear when toggle is on");
		assert.equal(reviewCount, 1, "the review slice appears when toggle is on");

		const lines = list.render(100);
		const sliceLine = lines.find((l) => l.includes("# Unit: dispatch"));
		assert.ok(sliceLine, "expected to find a rendered dispatch slice line");
		assert.ok(
			sliceLine!.includes(TREE_BRANCH) || sliceLine!.includes(TREE_LAST),
			"slice line must carry a tree connector (nested under root), not render as a bare root",
		);

		const rootIndex = lines.findIndex((l) => l.includes("/forge auto"));
		const orphanIndex = lines.findIndex((l) => l.includes("explica esse arquivo"));
		const sliceIndex = lines.findIndex((l) => l.includes("# Unit: dispatch"));
		assert.ok(rootIndex >= 0 && orphanIndex >= 0 && sliceIndex >= 0);
		assert.ok(sliceIndex > rootIndex, "nested slice renders after its parent root row");
	});

	test("search with toggle off does not resurrect a hidden slice; toggle on makes it findable", () => {
		const listOff = makeList(allSessions, false);
		for (const ch of "dispatch-slice-unique-token") {
			listOff.handleInput(ch);
		}
		assert.equal(listOff.getSelectedSessionPath(), undefined, "hidden slice must not surface via search");

		const listOn = makeList(allSessions, true);
		for (const ch of "dispatch-slice-unique-token") {
			listOn.handleInput(ch);
		}
		assert.equal(listOn.getSelectedSessionPath(), dispatch1.path, "with toggle on, the slice is searchable");
	});

	test("derived title: explicit name wins over everything else", () => {
		const named = makeSession("/virtual/named.jsonl", { name: "minha sessão nomeada", firstMessage: "/forge auto" });
		const list = makeList([named]);
		const rendered = list.render(100).join("\n");
		assert.ok(rendered.includes("minha sessão nomeada"));
		assert.ok(!rendered.includes("/forge auto"));
	});

	test("empty list caused only by hidden slices cites the toggle key (demo does not look broken)", () => {
		const list = makeList([dispatch1, dispatch2], false);
		const rendered = list.render(80).join("\n");
		const toggleKey = appKey(KeybindingsManager.inMemory(), "toggleWorkerSlices");

		assert.ok(rendered.includes("fatias de worker ocultas"), "empty message cites hidden worker slices, in pt-BR");
		assert.ok(rendered.includes(toggleKey), "empty message names the actual toggle key");
	});

	test("empty list with no sessions at all still uses the generic message, not the slice-specific one", () => {
		const list = makeList([], false);
		const rendered = list.render(80).join("\n");
		assert.ok(!rendered.includes("fatias de worker ocultas"));
	});
});

describe("SessionSelectorComponent end-to-end: loadScope wires real worker-slice detection", () => {
	function headerLine(): string {
		return JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-07-13T00:00:00.000Z", cwd: "/tmp/example" });
	}

	function customMessageLine(customType: string): string {
		return JSON.stringify({
			type: "custom_message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-07-13T00:00:01.000Z",
			customType,
			content: "prompt",
			display: false,
		});
	}

	function messageLine(role: "user" | "assistant", text: string): string {
		return JSON.stringify({
			type: "message",
			id: "entry-2",
			parentId: null,
			timestamp: "2026-07-13T00:00:02.000Z",
			message: { role, content: [{ type: "text", text }] },
		});
	}

	function writeSession(dir: string, name: string, lines: string[]): string {
		const path = join(dir, name);
		writeFileSync(path, `${lines.join("\n")}\n`);
		return path;
	}

	function makeSessionInfo(path: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
		return {
			path,
			id: path,
			cwd: "/tmp/example",
			created: new Date("2026-07-13T00:00:00.000Z"),
			modified: new Date("2026-07-13T00:00:00.000Z"),
			messageCount: 1,
			firstMessage: "(no messages)",
			allMessagesText: "",
			...overrides,
		};
	}

	test("default hides a real forge-dispatch slice detected from disk; ctrl+q reveals it nested under its root", async () => {
		initTheme("dark", false);

		const dir = mkdtempSync(join(tmpdir(), "forge-session-selector-"));
		try {
			const rootPath = writeSession(dir, "root.jsonl", [headerLine(), messageLine("user", "please help me ship this")]);
			const dispatchPath = writeSession(dir, "dispatch.jsonl", [headerLine(), customMessageLine("forge-dispatch")]);

			const rawSessions: SessionInfo[] = [
				makeSessionInfo(rootPath, {
					modified: new Date("2026-07-13T09:00:00.000Z"),
					firstMessage: "please help me ship this",
					allMessagesText: "please help me ship this",
				}),
				makeSessionInfo(dispatchPath, {
					parentSessionPath: rootPath,
					modified: new Date("2026-07-13T09:01:00.000Z"),
				}),
			];

			let renderCount = 0;
			let resolveFirstLoad: () => void = () => {};
			const firstLoadDone = new Promise<void>((r) => {
				resolveFirstLoad = r;
			});
			const requestRender = () => {
				renderCount++;
				if (renderCount === 2) resolveFirstLoad();
			};

			const component = new SessionSelectorComponent(
				async () => rawSessions,
				async () => [],
				() => {},
				() => {},
				() => {},
				requestRender,
				{ keybindings: KeybindingsManager.inMemory() },
			);

			await firstLoadDone;

			const beforeToggle = stripVTControlCharacters(component.render(100).join("\n"));
			assert.ok(beforeToggle.includes("Fatias: off"), "header shows the toggle default state");
			assert.ok(beforeToggle.includes("fatias"), "header hint mentions the new toggle");
			assert.ok(!beforeToggle.includes("# Unit: dispatch"), "real dispatch slice hidden by default");

			component.handleInput("\x11"); // ctrl+q
			const afterToggle = stripVTControlCharacters(component.render(100).join("\n"));
			assert.ok(afterToggle.includes("Fatias: on"), "header reflects toggle-on state");
			assert.ok(afterToggle.includes("# Unit: dispatch"), "real dispatch slice revealed after toggle");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
