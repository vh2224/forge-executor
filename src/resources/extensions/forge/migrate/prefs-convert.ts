/**
 * Forge migrate — prefs converter (nested1x → flat 2.0), S02/T03.
 *
 * Each `nested1x` layer of the 4-layer cascade (`prefs.ts:prefsSources`,
 * classified by `migrate/prefs-layout.ts`, S01/T02) gets a converted 2.0-flat
 * file: `unit_models`/`ids` extracted field-by-field (the only two 1.0 shapes
 * with a real 2.0 consumer today — `state/ids.ts:readIdFormat` reads the flat
 * key `ids`, not `ids.format`), every already-flat value passed through
 * verbatim (via the real `parsePrefsBlock`, reused not reimplemented), and
 * every OTHER nested block (`key:\n  subkey: value`, no dash-list) WARN-listed
 * explicitly in the output file — structural detection (same branch
 * `parsePrefsBlock` itself falls through on), never a hardcoded key-name list.
 *
 * The `legacy ~/.claude` layer is documented read-only (`prefs.ts` header) —
 * its conversion target is redirected to `gsdHome()/prefs.md`, never in-place.
 * Every other nested1x layer converts in-place (`targetPath === sourcePath`).
 *
 * Node builtins + sibling pure modules only — no `@gsd/*` runtime import.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePrefsBlock, type ForgePrefs } from "../prefs.js";
import { classifyPrefsLayout, PREFS_KEY_MAP } from "./prefs-layout.js";
import { gsdHome } from "../../shared/compat/gsd-home.js";
import { writeFileAtomic } from "../state/ledger.js";

export interface PrefsConversionPlan {
  sourcePath: string;
  sourceLabel: string;
  targetPath: string;
  /** Set when --apply refused the write (e.g. target outside the cwd scope). */
  skipped?: "outside-cwd";
  targetLabel: string;
  content: string;
  renamedKeys: { from: string; to: string }[];
  warnedKeys: string[];
}

const MODELS_TABLE_ROW = /^\|\s*`?[\w-]+`?\s*\|\s*`?([^`|]+?)`?\s*\|/;
const TIER_MODELS_BLOCK = /tier_models:\n((?:[ \t]+.+\n?)*)/;
const TIER_MODELS_LINE = /^[ \t]+[\w-]+:\s*"?([^"#]+?)"?\s*(#.*)?$/;
const IDS_FORMAT = /^ids:\s*\n[ \t]+format:\s*(\w+)/m;
const TOP_LEVEL_LIST_HEAD = /^([A-Za-z_][\w-]*):[ \t]*$/;
const DASH_ITEM = /^[ \t]+-[ \t]*(.+?)[ \t]*$/;

/** Splits raw content into `## `-headed sections. Never uses `\Z` (not valid in JS). */
function splitSections(raw: string): { heading: string | null; body: string }[] {
  return raw.split(/\n(?=## )/).map((part) => {
    const m = part.match(/^##\s+(.+?)\s*\n/);
    return { heading: m ? m[1].trim() : null, body: part };
  });
}

/**
 * `models` table (`## Modelos disponíveis`) + `tier_models` fenced block →
 * deduped list of model IDs, order of first appearance.
 */
export function extractUnitModels(raw: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "" || /^-+$/.test(trimmed)) return;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      models.push(trimmed);
    }
  };

  const section = splitSections(raw).find((s) => s.heading === "Modelos disponíveis");
  if (section) {
    for (const line of section.body.split(/\r?\n/)) {
      const row = line.match(MODELS_TABLE_ROW);
      if (!row) continue;
      const value = row[1].trim();
      if (value === "Model ID" || /^-+$/.test(value)) continue;
      push(value);
    }
  }

  const tierBlock = raw.match(TIER_MODELS_BLOCK);
  if (tierBlock) {
    for (const line of tierBlock[1].split(/\r?\n/)) {
      const m = line.match(TIER_MODELS_LINE);
      if (m) push(m[1]);
    }
  }

  return models;
}

/** `ids:\n  format: X` → `X`, or `null` when absent. */
export function extractIdsFormat(raw: string): string | null {
  const m = raw.match(IDS_FORMAT);
  return m ? m[1] : null;
}

/**
 * Top-level `key:` (no value on the same line — same shape `parsePrefsBlock`'s
 * `listHead` branch matches) whose immediately following indented line(s) do
 * NOT start with `- ` — the exact shape `parsePrefsBlock` silently drops today
 * (`// no indented list items followed — fall through, leave key unset.`).
 * Excludes `tier_models`/`ids`, already handled field-by-field above.
 */
export function extractNestedMappingKeys(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const found: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const listHead = lines[i].match(TOP_LEVEL_LIST_HEAD);
    if (!listHead) continue;

    const key = listHead[1];
    if (key === "tier_models" || key === "ids") continue;

    const next = lines[i + 1];
    if (next === undefined) continue; // nothing follows — no block lost
    if (!/^[ \t]+/.test(next)) continue; // not indented — no block at all
    if (DASH_ITEM.test(next)) continue; // dash-list — parsePrefsBlock reads it fine

    found.push(key);
  }

  return found;
}

function needsQuote(value: string): boolean {
  return /[:#"'\n]/.test(value) || value.trim() !== value || value === "";
}

function serializeScalar(value: string): string {
  return needsQuote(value) ? JSON.stringify(value) : value;
}

function warnNoteFor(key: string): string {
  const mapping = PREFS_KEY_MAP.find((entry) => entry.legacyKey === key);
  return mapping ? mapping.note : "bloco aninhado 1.0, sem extração automática — revisar manualmente";
}

/**
 * Strip a 1.0 inline comment from a scalar value. The nested1x files carry
 * `key: value        # explanation` lines; parsePrefsBlock keeps everything
 * after `: ` as the value, so without this the converted 2.0 file holds
 * garbage strings like `"false        # true = pula discuss"` (external-review
 * finding, 2026-07-11 — seen live on the first real --apply).
 */
function stripInlineComment(value: string): string {
  const stripped = value.replace(/\s+#.*$/, "").trim();
  return stripped;
}

export function buildConvertedContent(
  raw: string,
  sourceLabel: string,
): { content: string; renamedKeys: { from: string; to: string }[]; warnedKeys: string[] } {
  const idsFormat = extractIdsFormat(raw);
  const warnedKeys = extractNestedMappingKeys(raw);
  // models/tier_models: NO auto-conversion (external-review, 2026-07-11). The
  // S02-PLAN research already established `unit_models` has zero consumers —
  // the real per-unit keys are `unit_model_plan_slice`/`unit_model_execute_task`,
  // and deriving those from a 1.0 phase-routing table would be guesswork.
  // WARN with a pointer instead (never silence, never guess).
  if (/^models:[ \t]*$/m.test(raw) && !warnedKeys.includes("models")) warnedKeys.push("models");
  if (/^tier_models:[ \t]*$/m.test(raw) && !warnedKeys.includes("tier_models")) warnedKeys.push("tier_models");

  const flat: ForgePrefs = parsePrefsBlock(raw);
  delete flat.models;
  delete flat.tier_models;
  delete flat.ids;
  delete flat.unit_models;

  const lines: string[] = ["```yaml"];
  if (idsFormat !== null) {
    lines.push(`ids: ${serializeScalar(idsFormat)}`);
  }
  for (const [key, value] of Object.entries(flat)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${serializeScalar(typeof value === "string" ? stripInlineComment(value) : value)}`);
    }
  }
  lines.push("```");

  if (warnedKeys.length > 0) {
    lines.push("");
    lines.push("## WARN — chaves 1.0 sem conversão automática");
    for (const key of warnedKeys) {
      lines.push(`- ${key}: ${warnNoteFor(key)}`);
    }
  }

  lines.push(`\n<!-- convertido de: ${sourceLabel} -->`);

  const renamedKeys: { from: string; to: string }[] = [];
  if (/^ids:[ \t]*$/m.test(raw)) renamedKeys.push({ from: "ids", to: "ids" });

  return { content: lines.join("\n") + "\n", renamedKeys, warnedKeys };
}

/** Decides what each `nested1x` prefs layer converts to, WITHOUT touching disk. */
export function computePrefsConversion(cwd: string): PrefsConversionPlan[] {
  const plans: PrefsConversionPlan[] = [];

  for (const finding of classifyPrefsLayout(cwd)) {
    if (finding.shape !== "nested1x") continue;

    let raw: string;
    try {
      raw = readFileSync(finding.source, "utf-8");
    } catch {
      continue;
    }

    const { content, renamedKeys, warnedKeys } = buildConvertedContent(raw, finding.label);

    const isLegacy = finding.label === "legacy ~/.claude";
    const targetPath = isLegacy ? join(gsdHome(), "prefs.md") : finding.source;
    const targetLabel = isLegacy ? "user (gsdHome)" : finding.label;

    plans.push({
      sourcePath: finding.source,
      sourceLabel: finding.label,
      targetPath,
      targetLabel,
      content,
      renamedKeys,
      warnedKeys,
    });
  }

  return plans;
}

/**
 * Applies plans via `writeFileAtomic` — **cwd-scoped ONLY** (external-review
 * CRITICAL, 2026-07-11): a `--apply` run on a project fixture wrote the
 * converted legacy user layer to the OPERATOR'S REAL `~/.forge/prefs.md` —
 * outside the migration target, outside the `.gsd-backup-*` snapshot, without
 * consent. `--apply` may only ever write beneath the target `cwd`; layers
 * whose target falls outside (the legacy `~/.claude` → `gsdHome()` mapping)
 * are returned as REPORT-ONLY plans (`skipped: "outside-cwd"`) so the report
 * can tell the user exactly what to convert manually (or via a future,
 * explicitly opt-in `--apply-user-prefs`).
 */
export function applyPrefsConversion(cwd: string): PrefsConversionPlan[] {
  const plans = computePrefsConversion(cwd);
  const cwdPrefix = cwd.endsWith("/") ? cwd : cwd + "/";
  for (const plan of plans) {
    if (!plan.targetPath.startsWith(cwdPrefix)) {
      plan.skipped = "outside-cwd";
      continue;
    }
    writeFileAtomic(plan.targetPath, plan.content);
  }
  return plans;
}
