/**
 * `tests/dispatch-concurrency-e2e.test.ts` — S07/T03 integration proof: the
 * MCP-bridge `record` (T01, `mcp-bridge-concurrency.test.ts`) and the
 * rendezvous `pending` (T02, `rendezvous-concurrency.test.ts`) exercised
 * TOGETHER across two overlapping dispatch windows, in the exact
 * publish/arm/build order `auto/driver.ts:163-177` uses in production.
 *
 * ── Nota de honestidade ──────────────────────────────────────────────────
 * Este teste NÃO passa por `runForgeLoop`: o `SessionDriver` injetável
 * (`loop.ts:105 dispatch`) fica ACIMA de `dispatchUnitViaNewSession`, e o
 * fake driver usado pelos testes de loop nunca arma record/rendezvous — ele
 * só simula o outcome. Modelar a sequência exata de publish/arm/build na
 * ordem de `driver.ts:163-177` é a fidelidade máxima alcançável sem um
 * provider externalCli real (que o gate desta slice não exige —
 * `docs/forge/FORGE2-ROADMAP.md §Notas de escopo`). Este arquivo NÃO afirma
 * provar o caminho pelo loop real — só a composição record+rendezvous como
 * eles co-movem dentro de dispatches sobrepostos. Ver `docs/forge/
 * FORGE2-CONCURRENCY.md` para o registro durável da decisão que este teste
 * trava.
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	buildWorkerMcpServer,
	clearWorkerMcp,
	getWorkerMcpRecord,
	publishWorkerMcp,
	type ForgeSdkModule,
} from "../worker/mcp-bridge.ts";
import { armRendezvous, deliverUnitResult, hasPendingRendezvous } from "../worker/rendezvous.ts";
import { getForgeAutoSession } from "../auto/session.ts";

// Reused verbatim from mcp-bridge.test.ts (Helper-First protocol) — a
// structural fake of the optional SDK module, capturing every registered
// tool in call order (one per buildWorkerMcpServer() call).
interface CapturedTool {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

function makeFakeSdk(): { sdk: ForgeSdkModule; captured: CapturedTool[] } {
	const captured: CapturedTool[] = [];
	const sdk: ForgeSdkModule = {
		tool(name, description, inputSchema, handler) {
			const t = { name, description, inputSchema, handler };
			captured.push(t);
			return t;
		},
		createSdkMcpServer(opts) {
			return { type: "sdk", name: opts.name, tools: opts.tools };
		},
	};
	return { sdk, captured };
}

afterEach(() => {
	clearWorkerMcp();
	getForgeAutoSession().reset();
});

describe("dispatch-concurrency-e2e — record + rendezvous co-moving across overlapping dispatch windows", () => {
	test("dispatch N's late MCP delivery is stale under N+1's own rendezvous; N+1 settles from its own token; N's late clearWorkerMcp() never touches N+1's already-built server", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "forge-dispatch-concurrency-"));
		try {
			const s = getForgeAutoSession();
			s.cwd = tmp;
			s.currentUnit = { type: "execute-task", slice: "S07", task: "T03" };

			const { sdk, captured } = makeFakeSdk();

			// ── Dispatch N: publish/arm/build, in `driver.ts:163-177` order ──────
			const rdvN = armRendezvous(5_000);
			s.currentRendezvousToken = rdvN.token;
			publishWorkerMcp(rdvN.token);
			buildWorkerMcpServer(getWorkerMcpRecord()!, sdk); // captured[0], boundToken = N

			assert.deepStrictEqual(getWorkerMcpRecord(), { token: rdvN.token });

			// ── Dispatch N+1 starts OVERLAPPING, before N delivers or clears ─────
			// armRendezvous's defensive clear (rendezvous.ts:67-70) drops N's still
			// -open `pending` WITHOUT resolving it — from here on N's own `outcome`
			// only ever settles via its 5s timeout (same contract T02 already locks
			// standalone; this test does not re-await rdvN.outcome for that reason
			// — see T02-SUMMARY's identical key_decision).
			const rdvNext = armRendezvous(5_000);
			s.currentRendezvousToken = rdvNext.token;
			publishWorkerMcp(rdvNext.token);
			buildWorkerMcpServer(getWorkerMcpRecord()!, sdk); // captured[1], boundToken = N+1

			assert.deepStrictEqual(
				getWorkerMcpRecord(),
				{ token: rdvNext.token },
				"the raw record slot now shows ONLY the newer dispatch — the slot IS clobbered by the second publish (the M2R-7 read-time gap named in FORGE2-CONCURRENCY.md §2); what protects correctness is that nothing in production reads it again after construction",
			);
			assert.equal(hasPendingRendezvous(), true);

			// ── (a) N's server, frozen on token N, delivers LATE ──────────────────
			const lateResult = await captured[0]!.handler(
				{ status: "done", summary: "N tardio (zombie)", artifacts: [] },
				undefined,
			);
			assert.ok(lateResult, "handler tolerates the stale delivery, never throws");
			assert.equal(
				hasPendingRendezvous(),
				true,
				"N+1's rendezvous is untouched by N's stale delivery",
			);

			const journalPath = join(tmp, ".gsd", "forge", "events.jsonl");
			const journal = readFileSync(journalPath, "utf-8").trim();
			const staleEvents = journal
				.split("\n")
				.map((l) => JSON.parse(l))
				.filter((e) => e.kind === "stale_rendezvous_delivery");
			assert.equal(staleEvents.length, 1, "N's late delivery was journaled exactly once as stale");

			// ── (c) N's dispatch `finally` clears the slot — LATE, after N+1 has
			// already republished it. The bare slot has no per-dispatch identity
			// (the named gap above), so this clear wipes N+1's published record too
			// — but N+1's server was already BUILT (its token frozen into the
			// closure two steps above), so this must never affect its own delivery.
			clearWorkerMcp();
			assert.equal(getWorkerMcpRecord(), null, "slot is inert after N's late clear");

			// ── (b) N+1's server, frozen on token N+1, delivers from its own token
			// — unaffected by N's stale delivery or N's late clearWorkerMcp() above.
			const nextResult = await captured[1]!.handler(
				{ status: "done", summary: "N+1 result", artifacts: ["src/y.ts"] },
				undefined,
			);
			assert.ok(nextResult);

			const outcome = await rdvNext.outcome;
			assert.deepStrictEqual(outcome, {
				kind: "result",
				result: {
					status: "done",
					summary: "N+1 result",
					artifacts: ["src/y.ts"],
					reason: undefined,
				},
			});

			// A further delivery correlated to N+1's now-consumed token is
			// tolerated as "none" (nothing pending anymore) — never a crash, and
			// never mistaken for corrupting some OTHER, later dispatch's rendezvous.
			assert.equal(
				deliverUnitResult({ status: "partial", summary: "double-deliver", artifacts: [] }, rdvNext.token),
				"none",
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
