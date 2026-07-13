/**
 * `worker/mcp-bridge.ts` — the externalCli (SDK / `claude-code`) delivery path
 * for `forge_unit_result`.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * On the in-process path the worker runs a FRESH pi extension instance and the
 * `forge_unit_result` tool (`worker/unit-result.ts`) reaches the loop through
 * the module-level `rendezvous` singleton. On the `claude-code` provider path
 * there is NO fresh pi instance — the subprocess `claude` runs its own tool
 * set. To let that subprocess commit its result back into the SAME rendezvous
 * singleton (same process, in-memory), the provider mounts an IN-PROCESS SDK
 * MCP server (`createSdkMcpServer`) exposing a single tool,
 * `mcp__forge__forge_unit_result`. Its handler calls `deliverUnitResult` on the
 * shared singleton — no IPC, no subprocess-to-kill, no serialization.
 *
 * ── B1 / MEM001 — freeze-at-construction (THE load-bearing invariant) ───────
 * The MCP tool handler is a LONG-LIVED closure: unlike the in-process path,
 * where `registerForgeExtension` builds a fresh tool bound to the dispatch's
 * token on every `newSession`, here the server is built once per `query()` and
 * its handler outlives the turn. If the handler read the live epoch token at
 * DELIVERY time (`getForgeAutoSession().currentRendezvousToken`, or the slot
 * below), a late delivery from an abandoned attempt (ceiling timeout) would
 * read the RETRY's token and corrupt the retry's rendezvous — the exact M1R-1
 * hazard, one layer deeper (S01-RISK B1).
 *
 * Therefore `buildWorkerMcpServer(record, sdk)` CAPTURES `record.token` into
 * the handler's closure AT CONSTRUCTION time (query-build, inside the dispatch
 * window). Every dispatch publishes a new record → the provider builds a new
 * server with a new frozen token. A zombie query from dispatch N holds a server
 * frozen on token N: a late delivery routes to `deliverUnitResult(payload, N)`
 * → `"stale"` no-op, leaving the retry's rendezvous intact.
 *
 * PROHIBITED (code AND intent): the handler must NEVER read the live token
 * (`currentRendezvousToken`) nor `getWorkerMcpRecord()` at delivery time. All
 * token reads happen at CONSTRUCTION. This mirrors R1 of the M1 review-fix.
 */

import { z } from "zod";
import { deliverUnitResult, type UnitResultPayload } from "./rendezvous.js";
import { unitKeyOf } from "./unit-key.js";
import { getForgeAutoSession } from "../auto/session.js";
import { appendEvent, unitSlice } from "../state/index.js";
import type { ForgeLoopEvent } from "../auto/housekeeping.js";

/** MCP server name → tools are exposed as `mcp__<serverName>__<tool>`. */
export const FORGE_MCP_SERVER_NAME = "forge";

/** The namespaced tool name the SDK exposes and `allowedTools` must permit. */
export const FORGE_MCP_UNIT_RESULT_TOOL = "mcp__forge__forge_unit_result";

/** The bare tool name (pre-namespacing), used to register the tool on the server. */
export const FORGE_UNIT_RESULT_TOOL_BARE = "forge_unit_result";

/**
 * The per-dispatch record: the epoch token minted by `armRendezvous` for the
 * in-flight dispatch. The driver (T02) publishes it right after arming and
 * clears it in the dispatch `finally`. A `null` slot means "no externalCli
 * dispatch is active" → the provider injects NOTHING (in-process / interactive
 * / fake paths are byte-identical to today; W2).
 */
export interface WorkerMcpRecord {
	/** Epoch token of the rendezvous armed for THIS dispatch (M1R-1). */
	token: number;
}

/**
 * Module-level slot — survives `newSession` session replacement for the same
 * reason as the rendezvous singleton (the Node module cache is the only object
 * both the pre-switch loop closure and the post-switch instance reach in
 * common). Read at query-BUILD time by the provider; never at delivery time.
 */
let record: WorkerMcpRecord | null = null;

/** Publish the record for the dispatch about to run (driver, right after arm). */
export function publishWorkerMcp(token: number): void {
	record = { token };
}

/** Clear the slot (driver `finally`) — returns to the inert "no dispatch" shape. */
export function clearWorkerMcp(): void {
	record = null;
}

/** The record currently published, or `null` when no externalCli dispatch is active. */
export function getWorkerMcpRecord(): WorkerMcpRecord | null {
	return record;
}

/**
 * Structural shape of the (optional) `@anthropic-ai/claude-agent-sdk` module —
 * only the two functions this bridge needs. Passed IN by the provider (which
 * imported the SDK dynamically) so this module never statically imports the
 * optional SDK dependency and stays safe to load at boot.
 */
export interface ForgeSdkModule {
	createSdkMcpServer: (opts: {
		name: string;
		version?: string;
		tools?: unknown[];
	}) => unknown;
	tool: (
		name: string,
		description: string,
		inputSchema: unknown,
		handler: (args: unknown, extra: unknown) => Promise<unknown>,
	) => unknown;
}

/** What the provider needs to inject the server into a `query()` call. */
export interface BuiltWorkerMcpServer {
	/** MCP server key under `options.mcpServers`. */
	serverName: string;
	/** The `McpSdkServerConfigWithInstance` (`type: "sdk"`) to inject. */
	config: unknown;
	/** Tool names to APPEND to `allowedTools` (never replace). */
	allowedTools: string[];
}

/** Zod raw shape mirroring `UnitResultPayload` / the in-process tool's params. */
const unitResultShape = {
	status: z.enum(["done", "partial", "blocked"]),
	summary: z.string(),
	artifacts: z.array(z.string()),
	reason: z.string().optional(),
} as const;

const UNIT_RESULT_DESCRIPTION =
	"Registra o resultado final da unidade de trabalho atual (plan-slice ou execute-task). " +
	"Chame como ÚLTIMA ação da unidade — é o único ponto de commit do worker: nenhum outro " +
	"formato de saída (texto, sentinela) é reconhecido pelo loop. status='done' só quando o " +
	"trabalho foi verificado (build/testes/gate); 'partial' quando algo foi feito mas não tudo; " +
	"'blocked' quando não é possível prosseguir sem intervenção humana.";

/**
 * Best-effort journal of a stale externalCli delivery — mirrors
 * `worker/unit-result.ts`'s in-process stale path so both delivery routes emit
 * the same `stale_rendezvous_delivery` event under the same unit key. NEVER
 * throws (the tool handler must not crash the worker session).
 */
function journalStaleDelivery(status: UnitResultPayload["status"]): void {
	try {
		const s = getForgeAutoSession();
		const unit = s.currentUnit;
		const ev: ForgeLoopEvent = {
			ts: new Date().toISOString(),
			kind: "stale_rendezvous_delivery",
			unit: unit ? unitKeyOf(unit) : "",
			agent: "forge-loop",
			milestone: "",
			status: "stale",
			summary: `Delivery tardio via MCP (status ${status}) ignorado — rendezvous já pertence a outra tentativa.`,
		};
		if (unit) {
			ev.slice = unitSlice(unit);
			if (unit.type === "execute-task") ev.task = unit.task;
		}
		appendEvent(s.cwd, ev);
	} catch {
		/* the handler NEVER throws — journaling is strictly best-effort */
	}
}

/**
 * Build the in-process SDK MCP server exposing `forge_unit_result` for the
 * given dispatch `record`, using the ALREADY-IMPORTED `sdk` module.
 *
 * B1/MEM001: `record.token` is read HERE, at construction, and captured into
 * the handler closure as `boundToken`. The handler NEVER re-reads the live
 * token or the module slot — see the module header.
 */
export function buildWorkerMcpServer(
	record: WorkerMcpRecord,
	sdk: ForgeSdkModule,
): BuiltWorkerMcpServer {
	// Freeze THIS dispatch's token into the handler's closure. This single
	// capture is the whole point of the module (B1) — do not inline `record`
	// reads below it.
	const boundToken = record.token;

	const unitResultTool = sdk.tool(
		FORGE_UNIT_RESULT_TOOL_BARE,
		UNIT_RESULT_DESCRIPTION,
		unitResultShape,
		async (args: unknown) => {
			// The SDK validates `args` against `unitResultShape` before calling
			// us; parse defensively so a shape drift can never throw here.
			const parsed = z.object(unitResultShape).safeParse(args);
			if (!parsed.success) {
				return {
					content: [
						{
							type: "text",
							text: "Resultado da unidade rejeitado: payload inválido.",
						},
					],
				};
			}

			const payload: UnitResultPayload = {
				status: parsed.data.status,
				summary: parsed.data.summary,
				artifacts: parsed.data.artifacts,
				reason: parsed.data.reason,
			};

			// Deliver into the shared rendezvous singleton correlated to the
			// token FROZEN at construction (B1). A stale token means this
			// delivery belongs to an abandoned attempt → no-op + best-effort
			// journal; a missing rendezvous → tolerated `"none"`. Never throws.
			const outcome = deliverUnitResult(payload, boundToken);
			if (outcome === "stale") {
				journalStaleDelivery(payload.status);
			}

			return {
				content: [
					{ type: "text", text: `Resultado da unidade registrado: ${payload.status}` },
				],
			};
		},
	);

	const config = sdk.createSdkMcpServer({
		name: FORGE_MCP_SERVER_NAME,
		version: "1.0.0",
		tools: [unitResultTool],
	});

	return {
		serverName: FORGE_MCP_SERVER_NAME,
		config,
		allowedTools: [FORGE_MCP_UNIT_RESULT_TOOL],
	};
}
