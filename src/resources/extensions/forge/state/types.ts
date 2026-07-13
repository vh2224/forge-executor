/**
 * Forge state model — pure TS interfaces consumed by parse.ts / serialize.ts /
 * (future) store.ts / dispatch.ts.
 *
 * Pure module: no filesystem/OS dependency, no `@gsd/*` runtime import.
 */

import type { MustHaves } from "./must-haves.js";

// ── StateDoc — the 2.0 STATE.md model (fenced ```yaml block, NOT frontmatter) ──

export type UnitType = "milestone" | "slice" | "task";
export type UnitStatus = "pending" | "running" | "done" | "blocked" | "partial";

export interface StateUnit {
  id: string;
  type: UnitType;
  status: UnitStatus;
  /**
   * Slice qualifier for `type: "task"` entries. Task ids (T01, T02…) COLLIDE
   * across slices within a milestone — without this, S01's done T01 makes
   * S02's T01 look already-executed (seen live 2026-07-11: derive skipped
   * S02/T01-T04 straight to T05 because S01's task entries matched). Absent on
   * pre-fix entries and on slice/milestone entries.
   */
  slice?: string;
}

export interface StateDoc {
  milestone: string;
  // `phase` is DERIVED — serialized for read-compat/debug convenience, never a
  // separate source of truth. Callers should recompute it, not trust the
  // parsed value as authoritative (M1-D4).
  phase?: string;
  current_slice?: string;
  next_action?: string;
  units?: StateUnit[];
}

// ── RoadmapSlice — one row of the ROADMAP.md "## Slices" table ──────────────

export interface RoadmapSlice {
  id: string;
  name: string;
  risk: string;
  depends: string[];
  status: string;
}

// ── PlanDoc — T##-PLAN.md / S##-PLAN.md frontmatter (read-compat) ───────────

export interface PlanDoc {
  id: string;
  slice?: string;
  milestone?: string;
  title?: string;
  depends: string[];
  writes?: string[];
  mustHaves?: MustHaves;
}

// ── SummaryDoc — S##-SUMMARY.md / T##-SUMMARY.md frontmatter (read-compat) ──

export interface SummaryDoc {
  id: string;
  provides: string[];
  key_files: string[];
}

// ── ForgeEvent — one line of .gsd/forge/events.jsonl (journal) ──────────────

export interface ForgeEvent {
  ts: string;
  unit: string;
  agent: string;
  milestone: string;
  status: string;
  summary: string;
  slice?: string;
  task?: string;
  key_decisions?: string[];
  files_changed?: string[];
  // Optional event-kind discriminator. `auto/housekeeping.ts` extends this into
  // the closed `ForgeLoopEvent` (where `kind` is required); journaled loop
  // events therefore carry it on disk, and `readEvents` surfaces it back so the
  // resume-time replay detector can filter by kind without a cast.
  kind?: string;
  /** Autoria G1 (D15): o model efetivo que executou a unidade (`provider/model-id`). */
  model?: string;
  /** Autoria G1: o provider-slug do model efetivo (prefixo de `model`). */
  provider?: string;
  /** Autoria G1: a família derivada (`familyOf(model)`) — gravada p/ grep/consumo (S04). */
  family?: string;
  /**
   * "G1 do git" (fix batch pós-M6): o SHA de HEAD no momento do evento, gravado
   * em `unit_dispatched`/`unit_result`/`unit_timeout` pelo loop. Permite derivar
   * o range exato de commits de uma slice/milestone em QUALQUER modo de
   * isolamento (inclusive commits direto na main, onde merge-base==HEAD e o
   * review-diff ficava cego — achado #1 da cerimônia do M6). Aditivo; leitores
   * legados ignoram.
   */
  sha?: string;
  /**
   * Autoria de esforço (S01, padrão G1): o nível de effort da unidade — o
   * RESOLVIDO pré-dispatch no `unit_dispatched`, o EFETIVO pós-clamp no
   * `unit_result`/`unit_timeout` (D-S01-3). Aditivo; leitores legados ignoram.
   */
  effort?: string;
  /**
   * Autoria de esforço: proveniência da resolução (`task-frontmatter`,
   * `role-default:<role>`, com sufixo `capped …→… by effort_max` quando o teto
   * rebaixou o pedido).
   */
  effort_reason?: string;
  /**
   * Autoria de esforço: registro do clamp por capacidade do modelo, formato
   * `"<pedido>→<efetivo>"` (ex.: `"high→medium"`). Presente APENAS quando o
   * hook observou um clamp real — ausente significa "aplicado como pedido".
   */
  effort_clamped?: string;
  /**
   * S06 (T02): contagem de testes que passaram na suíte advisory rodada pelo
   * completer, espelhando `suite_passed` do frontmatter de `<mid>-SUMMARY.md`
   * (contrato 1, S06-PLAN) no evento `suite_result` (contrato 2). Aditivo;
   * leitores legados ignoram. Ausente quando o completer não reportou (ou
   * quando a contagem não pôde ser parseada — `error`/`timeout`).
   */
  suite_passed?: number;
  /** S06 (T02): contagem de testes que falharam — irmão de `suite_passed`. */
  suite_failed?: number;
  /**
   * S09/T03 (addendum §6): a razão auditável do `rankUnion` cross-pool
   * (`model-rank-union.ts`) para o `unit_dispatched` — presente APENAS
   * quando o julgamento cross-pool decidiu a autoria (`role.ts`'s
   * `resolveModelForRole`, ramo de julgamento). Ausente no caminho guard
   * (sem domain/cobertura) — byte-identidade preservada (G1, mesma regra
   * de `author`/`effort`); nunca `""`/`"null"`.
   */
  rank_reason?: string;
  /**
   * S09/T03: o `domain` que orientou o `rank_reason` acima — fecha o gap
   * cosmético citado no addendum §6. Mesma disciplina aditiva/ausente de
   * `rank_reason`: só presente junto com ele.
   */
  domain?: string;
}
