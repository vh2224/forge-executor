/**
 * Forge migrate — STATE.md converter (dashboard1x/frontmatter1x-aware → 2.0
 * top-level shell), S02/T02.
 *
 * The 1.0 top-level `.gsd/STATE.md` is an auto-generated DASHBOARD (a view over
 * `.gsd/forge/runs/*.json` + `LEDGER.md`), not a structured source of truth. The
 * real source of truth for a milestone in flight is its PER-MILESTONE
 * `.gsd/milestones/<mid>/<mid>-STATE.md` (frontmatter `status:` + prose
 * `**Active Slice:**`/`**Phase:**`/`**Next Action:**`), already classified by
 * `migrate/state-layout.ts` (S01/T01) as `frontmatter1x`.
 *
 * This module only decides WHAT to do with each `StateLayoutKind` the S01
 * classifier already produced — it never reimplements shape detection. When the
 * top is `dashboard1x`, it picks the single per-milestone `frontmatter1x` file
 * whose `status:` is not terminal (fail-safe: an unrecognized/absent status
 * counts as active, since silently treating an in-flight milestone as done is
 * worse than a reported ambiguity). Zero active → an empty 2.0 shell
 * (`{milestone: ""}`); exactly one active → a filled shell; more than one →
 * `skip-ambiguous`, no write.
 *
 * `units[]` is DELIBERATELY never populated here — deriving per-slice/per-task
 * status from a 1.0 milestone mid-flight (`deriveNextUnit`) is S03's mandate
 * (S02-PLAN.md §Notes), not an omission.
 *
 * The only writer is `state/store.ts:updateState` (D3, the single real writer
 * of STATE.md) — this module never calls `writeFileSync` on `.gsd/STATE.md`
 * directly.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` runtime import.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyStateLayout, classifyMilestoneStateLayouts } from "./state-layout.js";
import { updateState } from "../state/store.js";
import type { StateDoc } from "../state/types.js";

export type StateConvertAction = "noop-native" | "noop-absent" | "convert" | "skip-unknown" | "skip-ambiguous";

export interface StateConversionPlan {
  action: StateConvertAction;
  targetDoc?: StateDoc;
  detail: string;
}

/** Fields extracted from a single 1.0 per-milestone `STATE.md`. */
interface Frontmatter1xFields {
  milestone: string;
  status: string;
  phase: string;
  activeSlice: string;
  nextAction: string;
}

const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---/;

// Comparison is always `.toLowerCase().trim()`. Anything NOT in this set —
// including an absent/empty status — counts as ACTIVE (fail-safe): better to
// report a false-active (which becomes `skip-ambiguous` on collision, never a
// silent drop) than to treat a genuinely in-flight milestone as done.
const TERMINAL_STATUSES = new Set(["complete", "cancelled", "cancelado", "done", "abandoned"]);

/**
 * Extract `milestone`/`status` (frontmatter block) and `phase`/`activeSlice`/
 * `nextAction` (prose body, `**Label:** value` lines) from the raw content of a
 * 1.0 per-milestone `STATE.md`. Never throws — an absent line degrades to an
 * empty string. The 1.0 em-dash (`—`, "no value") is normalized to an empty
 * string for `activeSlice`, per the fixture's own convention.
 */
export function parseFrontmatter1xFields(raw: string): Frontmatter1xFields {
  const blockMatch = raw.match(FRONTMATTER_BLOCK);
  const frontmatter = blockMatch ? blockMatch[1] : "";

  const milestoneMatch = frontmatter.match(/^milestone:\s*(.*)$/m);
  const statusMatch = frontmatter.match(/^status:\s*(.*)$/m);
  const phaseMatch = raw.match(/\*\*Phase:\*\*\s*(.*)$/m);
  const activeSliceMatch = raw.match(/\*\*Active Slice:\*\*\s*(.*)$/m);
  const nextActionMatch = raw.match(/\*\*Next Action:\*\*\s*(.*)$/m);

  const activeSliceRaw = activeSliceMatch ? activeSliceMatch[1].trim() : "";

  return {
    milestone: milestoneMatch ? milestoneMatch[1].trim() : "",
    status: statusMatch ? statusMatch[1].trim() : "",
    phase: phaseMatch ? phaseMatch[1].trim() : "",
    activeSlice: activeSliceRaw === "—" ? "" : activeSliceRaw,
    nextAction: nextActionMatch ? nextActionMatch[1].trim() : "",
  };
}

/**
 * Decide what a `.gsd/STATE.md` conversion should do, WITHOUT touching disk.
 * Delegates all shape classification to `state-layout.ts` (S01/T01) — this
 * function only maps each `StateLayoutKind` to an action.
 */
export function computeStateConversion(cwd: string): StateConversionPlan {
  const top = classifyStateLayout(cwd);

  if (top.kind === "twoPointZero") {
    return { action: "noop-native", detail: "STATE.md já é 2.0-nativo (bloco fenced com milestone: não-vazio) — nada a fazer" };
  }

  if (top.kind === "absent") {
    return { action: "noop-absent", detail: "não existe .gsd/STATE.md neste diretório — nada a fazer" };
  }

  if (top.kind === "unknown") {
    return { action: "skip-unknown", detail: `forma não reconhecida de STATE.md (${top.detail}) — não arriscar sobrescrever` };
  }

  // Only "dashboard1x" remains: the forge 1.0 auto-generated dashboard. The
  // real source of truth is whichever per-milestone frontmatter1x STATE.md
  // looks genuinely active.
  const frontmatterFindings = classifyMilestoneStateLayouts(cwd).filter((f) => f.kind === "frontmatter1x");

  const active: Frontmatter1xFields[] = [];
  for (const finding of frontmatterFindings) {
    let raw: string;
    try {
      raw = readFileSync(finding.path, "utf-8");
    } catch {
      continue;
    }
    const fields = parseFrontmatter1xFields(raw);
    if (TERMINAL_STATUSES.has(fields.status.toLowerCase().trim())) continue;
    active.push(fields);
  }

  if (active.length === 0) {
    return {
      action: "convert",
      targetDoc: { milestone: "" },
      detail: "dashboard 1.0 sem nenhum milestone per-milestone ativo (todos terminais ou nenhum encontrado) — shell 2.0 vazio",
    };
  }

  if (active.length === 1) {
    const winner = active[0];
    const targetDoc: StateDoc = { milestone: winner.milestone };
    if (winner.phase) targetDoc.phase = winner.phase;
    if (winner.activeSlice) targetDoc.current_slice = winner.activeSlice;
    if (winner.nextAction) targetDoc.next_action = winner.nextAction;
    return {
      action: "convert",
      targetDoc,
      detail: `dashboard 1.0 convertido a partir do único milestone per-milestone ativo (${winner.milestone}) — units[] não populado, deferido a S03`,
    };
  }

  const ids = active.map((a) => a.milestone).join(", ");
  return {
    action: "skip-ambiguous",
    detail: `${active.length} milestones parecem ativos simultaneamente: ${ids} — resolução manual necessária`,
  };
}

/**
 * Apply the plan `computeStateConversion` produces. Only `action === "convert"`
 * touches disk — every other action returns `written: false` without any
 * filesystem call. The write goes through `state/store.ts:updateState` (D3,
 * the single real writer), never a direct `writeFileSync`. The mutator ignores
 * the current parsed doc: the 1.0 dashboard is not a parseable `StateDoc`
 * anyway (`readState` already degrades it to `{milestone: ""}`), so
 * `plan.targetDoc` is the sole source of the next state.
 *
 * `milestoneId` (S03/T04) surfaces the SAME "winner" milestone this function
 * already resolved internally, without a second ambiguity-resolution pass —
 * only set when `action === "convert"` produced a non-empty `targetDoc.milestone`
 * (the empty-shell/zero-active-milestone case has no real winner to expose).
 */
export function applyStateConversion(
  cwd: string,
): { written: boolean; path: string; detail: string; milestoneId?: string } {
  const plan = computeStateConversion(cwd);
  const path = join(cwd, ".gsd", "STATE.md");

  if (plan.action !== "convert") {
    return { written: false, path, detail: plan.detail };
  }

  updateState(cwd, () => plan.targetDoc!);
  const milestoneId = plan.targetDoc!.milestone || undefined;
  return { written: true, path, detail: plan.detail, milestoneId };
}
