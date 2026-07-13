/**
 * Forge dispatch loop — REAL-PATH acceptance (S04 / T01).
 *
 * ── What this proves (S03 review R1-b, the enabler) ──────────────────────────
 * The S03 loop's worker turn is fired from inside `withSession`, which the forge
 * driver (`auto/driver.ts`) passes to `ctx.newSession()`. Until T01 that
 * `withSession` was DEAD CODE on the real binary path: `ExtensionCommandContext.
 * newSession → AgentSession.newSession → AgentSessionNavigationModule.newSession`
 * accepted the option but NEVER invoked it. The loop only "worked" in S03 tests
 * that used FAKE drivers.
 *
 * This test drives the PRODUCTION driver `dispatchUnitViaNewSession` against a
 * REAL `ExtensionCommandContext` obtained from a real headless `AgentSession`
 * (SDK `createAgentSession`), with a real forge extension registered and a fake
 * MODEL (never a fake driver). It asserts that the worker turn actually fires
 * (`sendMessage({triggerTurn})` runs the fresh session's turn) and that the
 * rendezvous receives an outcome `{ kind: "result" }` carrying the payload the
 * worker emitted via the real `forge_unit_result` tool. If `withSession` were
 * still dead code, `newSession` would resolve without ever running the worker
 * turn and the rendezvous would only ever settle at its timeout — so a
 * `{ kind: "result" }` outcome is exactly the signal that R1-b is closed.
 *
 * ── Why a fake model, not a fake driver ──────────────────────────────────────
 * A fake driver would bypass the very seam under test. A fake MODEL keeps the
 * whole real path intact (real `AgentSession.newSession` → navigation module →
 * `withSession` → `sendMessage` → agent turn → real `forge_unit_result` tool →
 * rendezvous) and only scripts what the LLM would have streamed. Determinism
 * without `--print` (see forge-loop.e2e.test.ts § W4 for why print-mode is flaky).
 *
 * ── Fake-provider constraint ─────────────────────────────────────────────────
 * The fake LLM provider registers off `GSD_FAKE_LLM_TRANSCRIPT` at pi-ai module
 * load, with a single process-global transcript + cursor. So the transcript is
 * written and the env var set BEFORE any dynamic import that pulls pi-ai, and
 * this file carries exactly one behavioral test.
 *
 * ── RUNNER ───────────────────────────────────────────────────────────────────
 * The forge extension SOURCE uses ESM `.js` specifiers over `.ts` files, which
 * bare `--experimental-strip-types` does not rewrite. We register a `.js`→`.ts`
 * resolver hook FIRST and pull the forge source modules in via dynamic import,
 * so the driver, the session container singleton, and the extension factory all
 * resolve to the SAME source module instances (shared module-level rendezvous +
 * ForgeAutoSession singletons — the whole mechanism depends on that).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 1) write the transcript + arm the fake provider BEFORE importing pi-ai ────
//
// The single worker turn emits the real `forge_unit_result` closing tool call.
// A couple of spare text turns tolerate any extra turn the agent loop might take.
const transcriptDir = mkdtempSync(join(tmpdir(), "forge-realpath-transcript-"));
const transcriptPath = join(transcriptDir, "transcript.jsonl");
const turns = [
	{
		turn: 1,
		expect: { modelId: "gsd-fake-model" },
		emit: {
			kind: "tool_use",
			calls: [
				{
					name: "forge_unit_result",
					input: {
						status: "done",
						summary: "unidade concluída pelo worker turn real",
						artifacts: ["tests/e2e/forge-realpath-loop.e2e.test.ts"],
					},
				},
			],
		},
	},
	{ turn: 2, emit: { kind: "text", text: "spare" } },
	{ turn: 3, emit: { kind: "text", text: "spare" } },
];
writeFileSync(transcriptPath, turns.map((t) => JSON.stringify(t)).join("\n") + "\n");

process.env.GSD_FAKE_LLM_TRANSCRIPT = transcriptPath;
process.env.GSD_TOOL_APPROVAL = "auto";
// Bound the run: if the worker turn ever fails to fire (regression), the
// rendezvous settles as a timeout and the assertion fails LOUDLY instead of
// hanging the test.
process.env.FORGE_UNIT_TIMEOUT_MS = process.env.FORGE_UNIT_TIMEOUT_MS ?? "20000";

// ── 2) self-registered `.js`→`.ts` source resolver (see the RUNNER note) ─────
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			(specifier.startsWith("./") || specifier.startsWith("../")) &&
			specifier.endsWith(".js") &&
			context.parentURL?.startsWith("file:")
		) {
			try {
				const jsPath = fileURLToPath(new URL(specifier, context.parentURL));
				if (!existsSync(jsPath) && existsSync(jsPath.slice(0, -3) + ".ts")) {
					return nextResolve(pathToFileURL(jsPath.slice(0, -3) + ".ts").href, context);
				}
			} catch {
				/* fall through to the default resolver */
			}
		}
		return nextResolve(specifier, context);
	},
});

// ── 3) dynamic imports (after the hook is live + env is set) ─────────────────
const { createTmpProject } = await import("./_shared/tmp-project.ts");
const { createAgentSession } = await import("@forge/agent-core");
const { createDefaultCommandContextActions } = await import(
	"@forge/agent-modes/modes/shared/command-context-actions.js"
);
const { DefaultResourceLoader, SettingsManager, SessionManager } = await import("@gsd/pi-coding-agent");
const { getModel } = await import("@gsd/pi-ai");

// forge extension SOURCE (via the hook) — the factory, driver, and container
// singleton must all be the SAME module instances.
const forgeExtension = (await import("../../src/resources/extensions/forge/index.ts")).default;
const { dispatchUnitViaNewSession } = await import("../../src/resources/extensions/forge/auto/driver.ts");
const { getForgeAutoSession } = await import("../../src/resources/extensions/forge/auto/session.ts");

describe("forge real-path loop (in-process, real newSession + fake model)", () => {
	test("the production driver fires the worker turn through the REAL ExtensionCommandContext and receives forge_unit_result", async (t) => {
		const project = createTmpProject({ git: true });
		t.after(project.cleanup);
		const dir = project.dir;

		// A real headless session with the forge extension registered as an
		// extension factory (so `forge_unit_result` + the session_start hook live
		// in the runner) and a fake model (so the worker turn is deterministic).
		const fakeModel = getModel("gsd-fake", "gsd-fake-model");
		assert.ok(fakeModel, "fake model must be registered (GSD_FAKE_LLM_TRANSCRIPT set before pi-ai import)");

		// Isolated agent dir under the tmp project — no real user extensions/config
		// leak into the session; the forge factory is the only extension present.
		const agentDir = join(dir, ".agent");
		const settingsManager = SettingsManager.create(dir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir,
			settingsManager,
			extensionFactories: [forgeExtension],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: dir,
			agentDir,
			model: fakeModel,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(dir),
		});
		t.after(() => session.dispose?.());

		// Bind the DEFAULT (headless) command-context actions: this is the exact
		// wiring the three real modes use — `ctx.newSession → session.newSession`.
		await session.bindExtensions({
			commandContextActions: createDefaultCommandContextActions(session),
		});

		// The REAL ExtensionCommandContext (never a fake) the driver drives.
		const cmdCtx = session.extensionRunner.createCommandContext();

		// Wire the live loop container the driver reads/writes (B1 module-level
		// singleton). This is the same object the fresh instance's session_start
		// hook re-points to during the replacement.
		const s = getForgeAutoSession();
		s.reset();
		s.active = true;
		s.cwd = dir;
		s.cmdCtx = cmdCtx;

		const unit = { type: "execute-task", slice: "S01", task: "T01" } as const;

		const outcome = await dispatchUnitViaNewSession(s, unit, "Execute a unidade de teste real-path.");

		// The load-bearing assertion: a real result (NOT a timeout) means
		// `withSession` fired on the real path → the worker turn ran → the real
		// `forge_unit_result` tool delivered into the rendezvous. R1-b closed.
		assert.equal(
			outcome.kind,
			"result",
			`expected a delivered result, got ${JSON.stringify(outcome)}. A 'timeout' here means withSession is still dead code on the real newSession path (R1-b NOT closed).`,
		);
		if (outcome.kind === "result") {
			assert.equal(outcome.result.status, "done", "the worker's forge_unit_result payload is threaded through verbatim");
			assert.match(outcome.result.summary, /worker turn real/, "the summary is the one the worker emitted, proving the real turn ran");
		}
	});
});
