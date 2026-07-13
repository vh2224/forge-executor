/**
 * Forge migrate — `--apply` orchestrator (backup-first), S02/T06.
 *
 * HARD RULE (ROADMAP, incident 2026-06-10 of the real 1.0): no mutation of a
 * user's `.gsd/` without a prior automatic backup. `applyMigration` is the
 * ONLY place that decides whether something needs converting AND is allowed
 * to call `backupGsdTree` (T01) — always BEFORE any of the four `applyX`
 * converters (T02-T05) run. When nothing needs converting, no backup is
 * created and none of the four converters is called — same zero-write
 * guarantee the dry-run (S01) already gives.
 *
 * This module orchestrates only — it reimplements no classification or
 * conversion logic, reusing `buildMigrateReport` (S01) to decide WHAT needs
 * converting and the five T01-T05 modules to do the actual work.
 *
 * Node builtins + sibling `migrate/*.ts` modules only — no `@gsd/*` import.
 */

import { readState } from "../state/store.js";
import { join } from "node:path";
import { backupGsdTree } from "./backup.js";
import { buildMigrateReport } from "./report.js";
import { applyStateConversion } from "./state-convert.js";
import { applyPrefsConversion, type PrefsConversionPlan } from "./prefs-convert.js";
import { applyDecisionsConversion } from "./decisions-convert.js";
import { applyMemoryConversion } from "./memory-convert.js";
import { applyRoadmapConversion } from "./roadmap-convert.js";
import { applyUnitsConversion } from "./units-convert.js";

export interface ApplyReport {
  backup: { dir: string; fileCount: number } | null;
  state: { written: boolean; path: string; detail: string; milestoneId?: string };
  prefs: PrefsConversionPlan[];
  decisions: { path: string; created: boolean }[];
  memory: { path: string; created: boolean }[];
  roadmap: { written: boolean; path: string; detail: string };
  units: { written: boolean; unitCount: number; warnings: string[] };
  warnings: string[];
}

// Actionable state outcomes: `written === false` for a reason OTHER than
// "there was nothing to convert" (already-2.0, absent). These are surfaced
// as warnings because they need a human to look, unlike the two no-op cases.
const STATE_ACTIONABLE_NO_WRITE = /(não reconhecida|resolução manual necessária)/;

/**
 * Orchestrate a full `--apply` run: decide (via `buildMigrateReport`,
 * read-only) whether anything needs converting, back up `.gsd/` exactly once
 * if so — BEFORE any converter runs — then call the four T02-T05 converters
 * in a fixed, auditable order. When nothing needs converting, neither the
 * backup nor any of the four converters is reached at all.
 */
export function applyMigration(cwd: string): ApplyReport {
  const report = buildMigrateReport(cwd);

  const needsConversion =
    report.stateTop.kind === "dashboard1x" ||
    report.prefs.some((p) => p.shape === "nested1x") ||
    report.fragmentStores.some(
      (s) => s.store !== "ledger" && s.files.some((f) => !f.compatible && f.path.endsWith(".md")),
    );

  const backupResult = needsConversion ? backupGsdTree(cwd) : null;
  const backup = backupResult?.backupDir ? { dir: backupResult.backupDir, fileCount: backupResult.fileCount } : null;

  const state = needsConversion
    ? applyStateConversion(cwd)
    : { written: false, path: join(cwd, ".gsd", "STATE.md"), detail: "nada precisava de conversão — pulado" };
  const prefs = needsConversion ? applyPrefsConversion(cwd) : [];
  const decisions = needsConversion ? applyDecisionsConversion(cwd) : [];
  const memory = needsConversion ? applyMemoryConversion(cwd) : [];

  // The single "winner" milestone state.ts already resolved internally (S02's
  // ambiguity gate) — never re-resolved here. Absent when nothing needed
  // converting or when the ambiguity gate (0 or 2+ active milestones) blocked
  // the write. When STATE is ALREADY 2.0-native, honor its `milestone:` as the
  // resolution — that is exactly the state the report's own "resolução manual
  // necessária" instruction produces (operator writes the 2.0 shell pointing
  // at the chosen milestone, re-runs --apply). Without this, following the
  // report's instruction led to a dead end: roadmap/units were skipped forever
  // (external-review finding, 2026-07-11 — same catch-22 shape as the unblock
  // bug: the machinery ignored the manual action it itself requested).
  let activeMilestoneId = state.milestoneId;
  if (!activeMilestoneId) {
    try {
      const current = readState(cwd);
      if (current.milestone && current.milestone.length > 0) {
        activeMilestoneId = current.milestone;
      }
    } catch {
      /* unreadable/absent STATE — stay unresolved */
    }
  }

  // Units BEFORE roadmap, deliberately: `applyUnitsConversion` (T03) reads the
  // raw prose1x `<mid>-ROADMAP.md` directly via `parseRoadmap1x`. If
  // `applyRoadmapConversion` (T02) ran first it would have already rewritten
  // that same file into the 2.0 pipe table, and `parseRoadmap1x` would then
  // see zero slices in it — silently dropping every unit (flagged as a real
  // ordering risk in T03-SUMMARY, not a hypothetical).
  const units = activeMilestoneId
    ? applyUnitsConversion(cwd, activeMilestoneId)
    : { written: false, unitCount: 0, warnings: [] };
  const roadmap = activeMilestoneId
    ? applyRoadmapConversion(cwd, activeMilestoneId)
    : { written: false, path: "", detail: "sem milestone ativo resolvido — pulado" };

  const warnings: string[] = [];
  for (const plan of prefs) {
    warnings.push(...plan.warnedKeys.map((key) => `prefs (${plan.targetLabel}): ${key}`));
  }
  if (!state.written && STATE_ACTIONABLE_NO_WRITE.test(state.detail)) {
    warnings.push(`STATE.md: ${state.detail}`);
  }
  warnings.push(...units.warnings);

  return { backup, state, prefs, decisions, memory, roadmap, units, warnings };
}

/**
 * Render an `ApplyReport` as pt-BR text — reports what was ACTUALLY written,
 * not just classified. Always ends with an explicit backup/rollback section:
 * the backup dir + rollback instruction when one was created, or an explicit
 * "no backup needed" line when nothing was converted.
 */
export function formatApplyReport(report: ApplyReport): string {
  const lines: string[] = [];

  lines.push("## STATE.md", "");
  lines.push(`- ${report.state.written ? "convertido" : "sem alteração"}: ${report.state.path} — ${report.state.detail}`);

  lines.push("", "## Prefs", "");
  if (report.prefs.length === 0) {
    lines.push("- nenhuma camada de prefs precisou de conversão");
  } else {
    for (const plan of report.prefs) {
      if (plan.skipped === "outside-cwd") {
        // Never claim a write that was refused (external-review, 2026-07-11):
        // out-of-cwd layers are report-only.
        lines.push(
          `- ${plan.sourceLabel}: NÃO convertido — destino fora do projeto (${plan.targetPath}). ` +
            `--apply só escreve dentro do cwd; converta essa camada manualmente se desejar.`,
        );
      } else {
        lines.push(`- ${plan.sourceLabel} → ${plan.targetLabel} (${plan.targetPath})`);
      }
      if (plan.warnedKeys.length > 0) {
        lines.push(`  chaves sem conversão automática: ${plan.warnedKeys.join(", ")}`);
      }
    }
  }

  lines.push("", "## Decisions", "");
  if (report.decisions.length === 0) {
    lines.push("- nenhum fragment decisions precisou de conversão");
  } else {
    for (const d of report.decisions) {
      lines.push(`- ${d.created ? "criado" : "sem alteração (já 2.0)"}: ${d.path}`);
    }
  }

  lines.push("", "## Memory", "");
  if (report.memory.length === 0) {
    lines.push("- nenhum fragment memory precisou de conversão");
  } else {
    for (const m of report.memory) {
      lines.push(`- ${m.created ? "criado" : "sem alteração (já 2.0)"}: ${m.path}`);
    }
  }

  lines.push("", "## Roadmap", "");
  lines.push(
    `- ${report.roadmap.written ? "convertido" : "sem alteração"}: ${report.roadmap.path || "(sem milestone ativo resolvido)"} — ${report.roadmap.detail}`,
  );

  lines.push("", "## Units", "");
  if (report.units.written) {
    lines.push(`- convertido: ${report.units.unitCount} unit(s) populada(s) em StateDoc.units[]`);
  } else {
    lines.push("- sem alteração: nenhuma unit populada");
  }
  if (report.units.warnings.length > 0) {
    lines.push(`  avisos: ${report.units.warnings.join("; ")}`);
  }

  if (report.warnings.length > 0) {
    lines.push("", "## Avisos", "");
    for (const w of report.warnings) lines.push(`- ${w}`);
  }

  lines.push("");
  if (report.backup) {
    lines.push(
      `Backup criado em: ${report.backup.dir} (${report.backup.fileCount} arquivos). ` +
        `Para reverter: apague .gsd/ e renomeie ${report.backup.dir} de volta para .gsd/.`,
    );
  } else {
    lines.push("Nenhum backup foi criado — nada precisava de conversão (.gsd/ já estava no formato 2.0 ou ausente).");
  }

  return lines.join("\n");
}
