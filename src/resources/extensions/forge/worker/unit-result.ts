/**
 * `forge_unit_result` — the worker's SINGLE commit point (M1-D2).
 *
 * Modeled on `packages/pi-coding-agent/examples/extensions/structured-output.ts`:
 * `defineTool` + `terminate: true` so the worker session ends on this tool
 * call, without paying for an extra follow-up LLM turn.
 *
 * The handler runs in the NEW extension instance created by
 * `ctx.newSession()` (post-rebind) — it cannot reach the loop's original
 * closure directly. It reaches it exclusively via the module-level
 * `rendezvous` singleton (see `worker/rendezvous.ts` for the "why").
 *
 * R1 (M1R-1 review-fix, round 2): `execute()` must NEVER read
 * `s.currentRendezvousToken` LIVE — the driver overwrites that field
 * synchronously on every dispatch/retry, so a late delivery from an
 * abandoned prior session would read the RETRY's token and corrupt the
 * retry's rendezvous (the exact M1R-1 hazard, one layer deeper). Instead
 * this module exports a FACTORY, `createForgeUnitResultTool(boundToken)`,
 * called at REGISTRATION time (`registerForgeExtension`, which runs during
 * every fresh instance's bring-up, strictly after the driver publishes the
 * token and before any tool call can land) — the closure freezes THIS
 * dispatch's token for the tool instance's whole lifetime.
 *
 * Do NOT capture `pi`/`ctx` at module scope here — this module is
 * registered fresh on every session rebind and must stay stateless besides
 * the tool definition itself.
 */

import { defineTool } from "@gsd/pi-coding-agent";
import { StringEnum, Type } from "@gsd/pi-ai";
import { Text } from "@gsd/pi-tui";
import { deliverUnitResult, type UnitResultPayload } from "./rendezvous.js";
import { unitKeyOf } from "./unit-key.js";
import { getForgeAutoSession } from "../auto/session.js";
import { appendEvent, unitSlice } from "../state/index.js";
import type { ForgeLoopEvent } from "../auto/housekeeping.js";

export type { UnitResultPayload };

const STATUS_LABEL_PT: Record<UnitResultPayload["status"], string> = {
	done: "concluído",
	partial: "parcial",
	blocked: "bloqueado",
};

/**
 * Factory: build a `forge_unit_result` tool instance BOUND to the epoch
 * token that was current at REGISTRATION time (R1). `boundToken` is a real
 * sentinel: `null` means "registered outside an active dispatch" (idle
 * session — back-compat with `deliverUnitResult`'s `undefined`-token
 * semantics, which delivers into whatever is currently pending
 * unconditionally). It is NEVER coerced away or re-read live.
 */
export function createForgeUnitResultTool(boundToken: number | null) {
	return defineTool({
		name: "forge_unit_result",
		label: "Resultado da unidade",
		description:
			"Registra o resultado final da unidade de trabalho atual (plan-slice ou execute-task). " +
			"Chame como ÚLTIMA ação da unidade — é o único ponto de commit do worker: nenhum outro " +
			"formato de saída (texto, sentinela) é reconhecido pelo loop.",
		promptSnippet: "Emita o resultado da unidade como uma tool call de encerramento",
		promptGuidelines: [
			"Chame forge_unit_result como a ÚLTIMA ação da unidade, depois de completar (ou não conseguir completar) o trabalho.",
			"status='done' apenas quando o trabalho foi verificado (build/testes/gate); 'partial' quando algo foi feito mas não tudo; 'blocked' quando não é possível prosseguir sem intervenção humana.",
			"Não emita outra resposta do assistente depois de chamar forge_unit_result.",
		],
		parameters: Type.Object({
			status: StringEnum(["done", "partial", "blocked"] as const, {
				description: "Resultado final da unidade: done | partial | blocked",
			}),
			summary: Type.String({ description: "Resumo curto (1-3 frases) do que foi feito ou do bloqueio" }),
			artifacts: Type.Array(Type.String(), {
				description: "Caminhos de arquivos criados ou modificados nesta unidade",
			}),
			reason: Type.Optional(
				Type.String({ description: "Motivo do bloqueio ou da conclusão parcial, se aplicável" }),
			),
		}),

		async execute(_toolCallId, params) {
			const payload: UnitResultPayload = {
				status: params.status,
				summary: params.summary,
				artifacts: params.artifacts,
				reason: params.reason,
			};

			// Bridge to the loop's original closure via the module-level
			// rendezvous singleton. Tolerated (never throws) if there is no
			// pending rendezvous — e.g. the worker called this tool outside of
			// an active dispatched unit.
			// M1R-1/R1: correlate against `boundToken`, frozen in this closure at
			// REGISTRATION time — NEVER read live from the mutable session
			// container. A mismatched (stale) token means this delivery belongs
			// to an abandoned attempt and must not corrupt a subsequent retry's
			// rendezvous; journal it best-effort.
			const s = getForgeAutoSession();
			const outcome = deliverUnitResult(payload, boundToken ?? undefined);
			if (outcome === "stale") {
				const unit = s.currentUnit;
				const ev: ForgeLoopEvent = {
					ts: new Date().toISOString(),
					kind: "stale_rendezvous_delivery",
					unit: unit ? unitKeyOf(unit) : "",
					agent: "forge-loop",
					milestone: "",
					status: "stale",
					summary: `Delivery tardio (status ${payload.status}) ignorado — rendezvous já pertence a outra tentativa.`,
				};
				if (unit) {
					ev.slice = unitSlice(unit);
					if (unit.type === "execute-task") ev.task = unit.task;
				}
				try {
					appendEvent(s.cwd, ev);
				} catch {
					/* the tool NEVER throws — journaling is best-effort only */
				}
			}

			return {
				content: [{ type: "text", text: `Resultado da unidade registrado: ${payload.status}` }],
				details: payload,
				terminate: true,
			};
		},

		renderResult(result) {
			const details = result.details as UnitResultPayload | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const statusLabel = STATUS_LABEL_PT[details.status] ?? details.status;
			const lines = [`Status: ${statusLabel}`, details.summary];
			if (details.reason) {
				lines.push(`Motivo: ${details.reason}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
