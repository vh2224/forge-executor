/**
 * Forge migrate — `<mid>-ROADMAP.md` converter (forge 1.0 prose+checkbox →
 * 2.0 pipe table), S03/T02.
 *
 * Delegates ALL shape classification and 1.0 parsing to `roadmap-layout.ts`
 * (T01) — this module only decides what to do with each `RoadmapLayoutKind`
 * and, for `prose1x`, rewrites the exact extent of the "## Slices" section
 * (from the `## Slices` heading up to — but not including — the next `## `
 * heading, or EOF) into the pipe table `state/parse.ts:parseRoadmap` already
 * reads. Everything else in the file (frontmatter, Vision, Boundary Map,
 * Notes) is copied through byte-for-byte.
 *
 * Status in the converted table is derived via `units-convert.ts`
 * (T03)'s `computeSliceStatus` — the SAME fail-safe cross-check (checkbox +
 * task completeness + `S##-SUMMARY.md` existence) that populates
 * `StateDoc.units[]`, so the two never disagree about whether a slice is
 * "done". Trusting the 1.0 checkbox alone here previously let a `[x]`
 * slice with a missing `S##-SUMMARY.md` read as `done` in the ROADMAP while
 * its STATE unit read `pending` — `deriveNextUnit`'s `sliceComplete` honors
 * either source, so it took the ROADMAP `done` and silently skipped the
 * slice forever (false-complete on real migrated data).
 *
 * The only writer is `state/ledger.ts:writeFileAtomic` (temp+rename) — never
 * a direct `writeFileSync` on the target path.
 *
 * Node builtins + sibling pure state/migrate modules only — no `@gsd/*`
 * runtime import.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyRoadmapLayout, parseRoadmap1x, type Roadmap1xSlice } from "./roadmap-layout.js";
import { computeSliceStatus } from "./units-convert.js";
import { writeFileAtomic } from "../state/ledger.js";

export type RoadmapConvertAction = "noop-native" | "noop-absent" | "convert" | "skip-unknown";

export interface RoadmapConversionPlan {
  action: RoadmapConvertAction;
  /** Only set when `action === "convert"` — the full replacement "## Slices" section text. */
  newSlicesSection?: string;
  detail: string;
}

const SLICES_HEADER = "## Slices";
const TABLE_HEADER = "| ID | Nome | Risk | Depends | Status |";
const TABLE_SEPARATOR = "|----|------|------|---------|--------|";

/**
 * Render `Roadmap1xSlice[]` (T01) into a `## Slices` pipe-table section,
 * 2.0-native. Status per row comes from `computeSliceStatus` (T03's fail-safe
 * cross-check against disk), not the checkbox alone — see module docstring.
 */
function buildSlicesSection(cwd: string, milestoneId: string, slices: Roadmap1xSlice[]): string {
  const rows = slices.map((s) => {
    const status = computeSliceStatus(cwd, milestoneId, s);
    return `| ${s.id} | ${s.name} | ${s.risk} | ${s.depends.join(", ") || "—"} | ${status} |`;
  });
  return [SLICES_HEADER, "", TABLE_HEADER, TABLE_SEPARATOR, ...rows, ""].join("\n");
}

/**
 * Decide what a `<mid>-ROADMAP.md` conversion should do, WITHOUT touching
 * disk. Delegates all shape classification to `roadmap-layout.ts` (T01) —
 * this function only maps each `RoadmapLayoutKind` to an action.
 */
export function computeRoadmapConversion(cwd: string, milestoneId: string): RoadmapConversionPlan {
  const finding = classifyRoadmapLayout(cwd, milestoneId);

  if (finding.kind === "twoPointZero") {
    return {
      action: "noop-native",
      detail: "ROADMAP.md já é 2.0-nativo (tabela pipe reconhecida por parseRoadmap) — nada a fazer",
    };
  }

  if (finding.kind === "absent") {
    return { action: "noop-absent", detail: `não existe ${milestoneId}-ROADMAP.md neste milestone — nada a fazer` };
  }

  if (finding.kind === "unknown") {
    return {
      action: "skip-unknown",
      detail: `forma não reconhecida de ${milestoneId}-ROADMAP.md (${finding.detail}) — não arriscar sobrescrever`,
    };
  }

  // Only "prose1x" remains.
  let raw: string;
  try {
    raw = readFileSync(finding.path, "utf-8");
  } catch {
    return { action: "skip-unknown", detail: "ROADMAP.md classificado como prose1x mas não pôde ser lido" };
  }

  const slices = parseRoadmap1x(raw);
  return {
    action: "convert",
    newSlicesSection: buildSlicesSection(cwd, milestoneId, slices),
    detail: `${slices.length} slice(s) convertida(s) de prosa+checkbox 1.0 para tabela pipe 2.0`,
  };
}

/**
 * Replace the exact extent of the "## Slices" section (heading line through
 * — but not including — the next "## " heading, or EOF) in `raw` with
 * `newSection`. Everything before the heading and everything from the next
 * heading onward is preserved verbatim. Returns `raw` unchanged if no
 * "## Slices" heading is found (should not happen when called after a
 * `convert` decision, since `prose1x` classification requires one).
 */
function replaceSlicesSection(raw: string, newSection: string): string {
  const lines = raw.split("\n");
  const startIdx = lines.findIndex((line) => line.trim().startsWith(SLICES_HEADER));
  if (startIdx === -1) return raw;

  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((line) => line.trim().startsWith("## "));
  const before = lines.slice(0, startIdx);
  const after = endIdx === -1 ? [] : rest.slice(endIdx);

  return [...before, ...newSection.split("\n"), ...after].join("\n");
}

/**
 * Apply the plan `computeRoadmapConversion` produces. Only `action ===
 * "convert"` touches disk — every other action returns `written: false`
 * without any filesystem call. Idempotent: a second call after a successful
 * conversion sees `twoPointZero` (the table it just wrote) and returns
 * `noop-native`.
 */
export function applyRoadmapConversion(
  cwd: string,
  milestoneId: string,
): { written: boolean; path: string; detail: string } {
  const plan = computeRoadmapConversion(cwd, milestoneId);
  const path = join(cwd, ".gsd", "milestones", milestoneId, `${milestoneId}-ROADMAP.md`);

  if (plan.action !== "convert") {
    return { written: false, path, detail: plan.detail };
  }

  const raw = readFileSync(path, "utf-8");
  const newContent = replaceSlicesSection(raw, plan.newSlicesSection!);
  writeFileAtomic(path, newContent);

  return { written: true, path, detail: plan.detail };
}
