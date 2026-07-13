/**
 * S03/T03 product e2e proof. This exercises the full real surface the
 * "picker sem ruído" claim depends on: fixtures persisted through the real
 * `SessionManager` (same header/`custom_message` marker shape production
 * writes — `auto/driver.ts:397` / `review/dispatch.ts:195`, ground-truthed by
 * the S02 lineage e2e, `run-thread-lineage-e2e.test.ts`), listed by the
 * vendored `SessionManager.list` (never a synthetic loader), then rendered
 * through the real `SessionSelectorComponent` in both toggle states.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { KeybindingsManager } from "@forge/agent-core";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { Message } from "@gsd/pi-ai";

import { SessionSelectorComponent } from "./session-selector.js";
import { TREE_BRANCH, TREE_LAST } from "./tree-render-utils.js";

/** `app.session.toggleWorkerSlices` default key (keybindings.ts, S03/T02). */
const TOGGLE_KEY = "\x11"; // ctrl+q

function appendUser(sm: SessionManager, text: string): void {
	sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as Message);
}

function appendAssistant(sm: SessionManager, text: string): void {
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
}

async function withSandbox<T>(fn: (cwd: string, sessionsDir: string) => Promise<T>): Promise<T> {
	const cwd = mkdtempSync(join(tmpdir(), "forge-session-selector-thread-e2e-"));
	const sessionsDir = join(cwd, "sessions");
	try {
		return await fn(cwd, sessionsDir);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

/**
 * Persists a mixed directory through the real `SessionManager`: (a) an
 * operator run root, (b) 2 dispatch slices + 1 review slice parented to the
 * root (one dispatch slice carries a full-size unit prompt, mirroring the
 * real payload driver.ts writes), (c) a pre-thread session with no
 * `parentSession` and no marker, and (d) an orphan slice whose
 * `parentSession` points at a file that was never written.
 */
function buildFixtures(cwd: string, sessionsDir: string): { rootPath: string; dispatch1Path: string } {
	const sm = SessionManager.create(cwd, sessionsDir);

	appendUser(sm, "/forge auto");
	appendAssistant(sm, "on it");
	const rootPath = sm.getSessionFile();
	assert.ok(rootPath, "the operator run root is persisted");

	sm.newSession({ parentSession: rootPath });
	sm.appendCustomMessageEntry("forge-dispatch", "# Unit: execute-task\n\nfirst dispatch prompt", false);
	appendAssistant(sm, "dispatch-slice-unique-token");
	const dispatch1Path = sm.getSessionFile();
	assert.ok(dispatch1Path, "the first dispatch slice is persisted");

	sm.newSession({ parentSession: rootPath });
	// A real unit prompt can be enormous (the full task text) — prove head
	// detection tolerates a huge custom_message line without choking.
	sm.appendCustomMessageEntry("forge-dispatch", `# Unit: execute-task\n\n${"x".repeat(50_000)}`, false);
	appendAssistant(sm, "second dispatch worker done");
	const dispatch2Path = sm.getSessionFile();
	assert.ok(dispatch2Path, "the second (huge-prompt) dispatch slice is persisted");

	sm.newSession({ parentSession: rootPath });
	sm.appendCustomMessageEntry("forge-review", "# Unit: review\n\nreview prompt", false);
	appendAssistant(sm, "review worker done");
	const reviewPath = sm.getSessionFile();
	assert.ok(reviewPath, "the review slice is persisted");

	// Pre-thread session: today's shape, no lineage metadata at all.
	sm.newSession();
	appendUser(sm, "explica esse arquivo pra mim");
	appendAssistant(sm, "claro, deixa eu ver");
	const preThreadPath = sm.getSessionFile();
	assert.ok(preThreadPath, "the pre-thread session is persisted");

	// Orphan slice: its parent was never written to this directory.
	const missingParent = join(sessionsDir, "does-not-exist_orphan-parent.jsonl");
	sm.newSession({ parentSession: missingParent });
	sm.appendCustomMessageEntry("forge-dispatch", "# Unit: execute-task\n\norphan dispatch prompt", false);
	appendAssistant(sm, "orphan worker done");
	const orphanPath = sm.getSessionFile();
	assert.ok(orphanPath, "the orphan dispatch slice is persisted");

	return { rootPath: rootPath as string, dispatch1Path: dispatch1Path as string };
}

/**
 * Constructs the real `SessionSelectorComponent` wired to `SessionManager.list`,
 * awaiting its first load. `loadScope()` fires `requestRender()` once entering
 * the loading state, once per progress tick, and once on completion — the
 * header's own "Loading" text (cleared only after `setSessions` runs) is the
 * one signal that survives that variable render count.
 */
async function loadComponent(cwd: string, sessionsDir: string): Promise<SessionSelectorComponent> {
	let component: SessionSelectorComponent | undefined;
	let resolveFirstLoad: () => void = () => {};
	const firstLoadDone = new Promise<void>((resolve) => {
		resolveFirstLoad = resolve;
	});
	const requestRender = () => {
		if (!component) return;
		const text = stripVTControlCharacters(component.render(100).join("\n"));
		if (!text.includes("Loading")) resolveFirstLoad();
	};

	component = new SessionSelectorComponent(
		(onProgress) => SessionManager.list(cwd, sessionsDir, onProgress),
		async () => [],
		() => {},
		() => {},
		() => {},
		requestRender,
		{ keybindings: KeybindingsManager.inMemory() },
	);

	await firstLoadDone;
	return component;
}

describe("SessionSelectorComponent thread e2e: SessionManager.list -> loadScope -> render (mixed real directory)", () => {
	test("default (toggle off): 1 line per thread, zero '# Unit:' rows; pre-thread session renders unchanged", async () => {
		initTheme("dark", false);

		await withSandbox(async (cwd, sessionsDir) => {
			buildFixtures(cwd, sessionsDir);
			const component = await loadComponent(cwd, sessionsDir);

			const rendered = stripVTControlCharacters(component.render(100).join("\n"));

			assert.ok(!rendered.includes("# Unit: dispatch"), "dispatch slices are hidden by default");
			assert.ok(!rendered.includes("# Unit: review"), "the review slice is hidden by default");
			assert.match(
				rendered,
				/\/forge auto · \d{4}-\d{2}-\d{2}/,
				"the operator run root shows the derived command+date title",
			);
			assert.ok(
				rendered.includes("explica esse arquivo pra mim"),
				"the pre-thread session renders its firstMessage exactly as it does today",
			);
		});
	});

	test("toggle on: worker slices render nested under their root; the orphan slice renders as its own root", async () => {
		initTheme("dark", false);

		await withSandbox(async (cwd, sessionsDir) => {
			buildFixtures(cwd, sessionsDir);
			const component = await loadComponent(cwd, sessionsDir);

			component.handleInput(TOGGLE_KEY);
			const lines = component.render(100).map((l) => stripVTControlCharacters(l));

			const dispatchLines = lines.filter((l) => l.includes("# Unit: dispatch"));
			const reviewLines = lines.filter((l) => l.includes("# Unit: review"));
			assert.equal(dispatchLines.length, 3, "2 parented dispatch slices + 1 orphan dispatch slice are visible");
			assert.equal(reviewLines.length, 1, "the review slice is visible");

			const hasTreeConnector = (line: string) => line.includes(TREE_BRANCH) || line.includes(TREE_LAST);
			const nestedDispatch = dispatchLines.filter(hasTreeConnector);
			const rootDispatch = dispatchLines.filter((l) => !hasTreeConnector(l));
			assert.equal(nestedDispatch.length, 2, "the 2 parented dispatch slices nest under the operator root");
			assert.equal(rootDispatch.length, 1, "the orphan slice (missing parent) renders as its own root, not nested");
			assert.ok(reviewLines.every(hasTreeConnector), "the review slice nests under the operator root");

			const rootIndex = lines.findIndex((l) => l.includes("/forge auto"));
			const nestedIndex = lines.findIndex((l) => l.includes("# Unit: dispatch") && hasTreeConnector(l));
			assert.ok(rootIndex >= 0 && nestedIndex >= 0, "both the root and a nested slice row are present");
			assert.ok(nestedIndex > rootIndex, "a nested slice renders after its parent root row");

			assert.ok(
				lines.some((l) => l.includes("explica esse arquivo pra mim")),
				"the pre-thread session still renders unchanged with the toggle on",
			);
		});
	});

	test("search: toggle off never surfaces a real worker slice; toggle on makes the same slice findable", async () => {
		initTheme("dark", false);

		await withSandbox(async (cwd, sessionsDir) => {
			buildFixtures(cwd, sessionsDir);

			const off = await loadComponent(cwd, sessionsDir);
			for (const ch of "dispatch-slice-unique-token") off.handleInput(ch);
			const offRendered = stripVTControlCharacters(off.render(100).join("\n"));
			assert.ok(
				!offRendered.includes("# Unit: dispatch"),
				"a hidden slice must not be resurrected by a search query that matches its content",
			);

			const on = await loadComponent(cwd, sessionsDir);
			on.handleInput(TOGGLE_KEY);
			for (const ch of "dispatch-slice-unique-token") on.handleInput(ch);
			const onRendered = stripVTControlCharacters(on.render(100).join("\n"));
			assert.ok(onRendered.includes("# Unit: dispatch"), "with the toggle on, the same slice is searchable");
		});
	});
});
