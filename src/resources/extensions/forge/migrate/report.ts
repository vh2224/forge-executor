/**
 * Forge migrate — report aggregator (T04).
 *
 * Pure orchestration over T01 (`state-layout.ts`), T02 (`prefs-layout.ts`)
 * and T03 (`fragment-store.ts`): no classification logic is reimplemented
 * here, only composition of their findings into one `MigrateReport` and a
 * pt-BR rendering of it. Read-only, never throws — every classifier below
 * already degrades an absent/malformed `.gsd/` tree to an empty/absent
 * result on its own, so this module adds no defensive try/catch of its own.
 *
 * Node builtins + sibling `migrate/*.ts` modules only — no `@gsd/*` import.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  classifyStateLayout,
  classifyMilestoneStateLayouts,
  type StateLayoutFinding,
} from "./state-layout.js";
import { classifyPrefsLayout, type PrefsLayoutFinding } from "./prefs-layout.js";
import {
  classifyFragmentStore,
  findOrphanArtifacts,
  type FragmentStoreFinding,
  type FragmentStoreKind,
  type OrphanArtifactFinding,
} from "./fragment-store.js";
import { classifyRoadmapLayout, type RoadmapLayoutFinding } from "./roadmap-layout.js";

const FRAGMENT_STORE_KINDS: FragmentStoreKind[] = ["decisions", "ledger", "memory"];

export interface MigrateReport {
  stateTop: StateLayoutFinding;
  milestoneStates: StateLayoutFinding[];
  prefs: PrefsLayoutFinding[];
  fragmentStores: FragmentStoreFinding[];
  orphans: OrphanArtifactFinding[];
  roadmap: RoadmapLayoutFinding[];
}

/**
 * List milestone ids under `.gsd/milestones/` — same readdirSync+isDirectory
 * enumeration pattern `classifyMilestoneStateLayouts` (S01/T01) uses
 * internally, but NOT reused via that function's own findings: those only
 * cover milestones that have a per-milestone STATE.md, which a 2.0-native
 * `.gsd/` (state lives solely in the top-level STATE.md) never has — reusing
 * that list would silently blind the roadmap dimension for the common case.
 * Never throws — degrades to `[]`.
 */
function listMilestoneIds(cwd: string): string[] {
  const milestonesRoot = join(cwd, ".gsd", "milestones");
  if (!existsSync(milestonesRoot)) return [];

  let entries: string[];
  try {
    entries = readdirSync(milestonesRoot);
  } catch {
    return [];
  }

  return entries.filter((entryName) => {
    try {
      return statSync(join(milestonesRoot, entryName)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Build a full migrate report for `cwd` by calling each T01/T02/T03/T04
 * classifier exactly once. Purely read-only — never writes, never throws
 * (each classifier already survives an absent `.gsd/` tree on its own, so
 * a totally empty sandbox degrades every field to absent/empty here too).
 *
 * `roadmap` (S03/T04, the 6th dimension) is pre-filtered to `prose1x` findings
 * only — the milestones whose `<mid>-ROADMAP.md` genuinely needs converting,
 * mirroring what a `--apply` run would act on.
 */
export function buildMigrateReport(cwd: string): MigrateReport {
  return {
    stateTop: classifyStateLayout(cwd),
    milestoneStates: classifyMilestoneStateLayouts(cwd),
    prefs: classifyPrefsLayout(cwd),
    fragmentStores: FRAGMENT_STORE_KINDS.map((store) => classifyFragmentStore(cwd, store)),
    orphans: findOrphanArtifacts(cwd),
    roadmap: listMilestoneIds(cwd)
      .map((id) => classifyRoadmapLayout(cwd, id))
      .filter((finding) => finding.kind === "prose1x"),
  };
}

const STATE_KIND_LABEL: Record<StateLayoutFinding["kind"], string> = {
  absent: "ausente",
  twoPointZero: "2.0-nativo (bloco fenced yaml)",
  dashboard1x: "dashboard forge 1.0 (auto-gerado)",
  frontmatter1x: "frontmatter forge 1.0 (per-milestone)",
  unknown: "forma desconhecida",
};

function formatStateSection(report: MigrateReport): string[] {
  const lines: string[] = ["## STATE.md", ""];
  lines.push(
    `- Topo (\`.gsd/STATE.md\`): ${STATE_KIND_LABEL[report.stateTop.kind]} — ${report.stateTop.detail}`,
  );

  const milestone1x = report.milestoneStates.filter((f) => f.kind === "frontmatter1x");
  lines.push(
    `- Per-milestone: ${report.milestoneStates.length} arquivo(s) encontrado(s), ` +
      `${milestone1x.length} no formato forge 1.0 (frontmatter1x)`,
  );
  for (const finding of report.milestoneStates) {
    lines.push(`  - ${finding.path}: ${STATE_KIND_LABEL[finding.kind]}`);
  }

  return lines;
}

function formatPrefsSection(report: MigrateReport): string[] {
  const lines: string[] = ["## Prefs", ""];
  if (report.prefs.length === 0) {
    lines.push("- nenhuma camada de prefs encontrada neste diretório");
    return lines;
  }

  const nested = report.prefs.filter((f) => f.shape === "nested1x");
  lines.push(
    `- ${report.prefs.length} camada(s) de prefs encontrada(s), ${nested.length} no formato ` +
      "aninhado forge 1.0 (nested1x)",
  );
  for (const finding of report.prefs) {
    lines.push(`  - ${finding.label} (${finding.source}): ${finding.shape}`);
    if (finding.unmapped.length > 0) {
      lines.push(`    chaves sem equivalente 2.0: ${finding.unmapped.join(", ")}`);
    }
  }

  return lines;
}

function formatFragmentStoresSection(report: MigrateReport): string[] {
  const lines: string[] = ["## Fragment stores", ""];
  for (const store of report.fragmentStores) {
    const incompatible = store.files.filter((f) => !f.compatible);
    lines.push(
      `- ${store.store} (${store.dir}): ${incompatible.length}/${store.files.length} arquivo(s) incompatível(is)`,
    );
    for (const file of incompatible) {
      lines.push(`  - ${file.path}: ${file.detail}`);
    }
  }
  return lines;
}

function formatOrphansSection(report: MigrateReport): string[] {
  const lines: string[] = ["## Artefatos órfãos", ""];
  if (report.orphans.length === 0) {
    lines.push("- nenhum artefato órfão encontrado");
    return lines;
  }
  lines.push(`- ${report.orphans.length} artefato(s) órfão(s) encontrado(s):`);
  for (const orphan of report.orphans) {
    lines.push(`  - ${orphan.path}: ${orphan.reason}`);
  }
  return lines;
}

function formatRoadmapSection(report: MigrateReport): string[] {
  const lines: string[] = ["## Roadmap", ""];
  if (report.roadmap.length === 0) {
    lines.push("- nenhum <mid>-ROADMAP.md em formato prosa+checkbox forge 1.0 encontrado");
    return lines;
  }
  lines.push(`- ${report.roadmap.length} milestone(s) com ROADMAP.md em formato forge 1.0 (prosa+checkbox):`);
  for (const finding of report.roadmap) {
    lines.push(`  - ${finding.path}: ${finding.detail}`);
  }
  return lines;
}

/**
 * Render a `MigrateReport` as pt-BR text for `/forge migrate`. Always ends
 * with an explicit dry-run disclaimer — this command never writes to disk;
 * `--apply` (with automatic backup) arrives in S02.
 */
export function formatMigrateReport(report: MigrateReport): string {
  const sections = [
    ...formatStateSection(report),
    "",
    ...formatPrefsSection(report),
    "",
    ...formatFragmentStoresSection(report),
    "",
    ...formatOrphansSection(report),
    "",
    ...formatRoadmapSection(report),
    "",
    "Nenhuma escrita foi realizada (dry-run). --apply chega no S02.",
  ];
  return sections.join("\n");
}
