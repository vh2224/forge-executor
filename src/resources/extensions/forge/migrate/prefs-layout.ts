/**
 * Forge migrate — prefs layout classifier.
 *
 * `forge migrate` (T04) needs to know, for each of the 4 prefs cascade layers
 * (`prefs.ts:prefsSources`), whether the file on disk is:
 *   - `flat`: the shape `prefs.ts:parsePrefsBlock` already understands
 *     (top-level `key: value` lines / simple indented dash-lists — the
 *     2.0-native shape, even when wrapped in a ```yaml fence for readability)
 *   - `nested1x`: the forge 1.0 shape (`~/.claude/forge-agent-prefs.md`),
 *     which carries a `## Phase → Agent Routing` markdown table and fenced
 *     blocks of `skip_discuss:`-style settings that `parsePrefsBlock` would
 *     silently degrade (only ever reading top-level lines, losing the
 *     surrounding structure — never throwing, but never warning either)
 *   - `empty` / `unknown`
 *
 * This module also carries the migration equivalence table (`PREFS_KEY_MAP`)
 * from forge 1.0 keys to their forge 2.0 flat counterpart, and flags every
 * 1.0 key that has none — the hard rule from the ROADMAP is "keys without an
 * equivalent get an explicit WARN in the report, never silence".
 *
 * Pure module: node builtins + `prefs.ts:prefsSources` only (reused, not
 * reimplemented — see Standards in T02-PLAN). Never writes, never throws.
 */

import { existsSync, readFileSync } from "node:fs";
import { prefsSources } from "../prefs.js";

export type PrefsShapeKind = "flat" | "nested1x" | "empty" | "unknown";

export interface PrefsKeyMapping {
  /** Top-level key name as it appears in a forge 1.0 prefs file. */
  legacyKey: string;
  /** Forge 2.0 flat equivalent, or `null` when there is none (→ WARN). */
  targetKey: string | null;
  note: string;
}

/**
 * Forge 1.0 → 2.0 key equivalence table (ROADMAP context block). `targetKey:
 * null` means "no 2.0 equivalent" — always surfaces as a WARN in
 * `PrefsLayoutFinding.unmapped`, never silently dropped.
 */
export const PREFS_KEY_MAP: PrefsKeyMapping[] = [
  {
    legacyKey: "models",
    targetKey: "unit_models",
    note: "alias table (`## Modelos disponíveis`) — the flat list of allowed model IDs it documents maps to `unit_models`.",
  },
  {
    legacyKey: "tier_models",
    targetKey: "unit_models",
    note: "per-tier model routing (light/standard/heavy/max) collapses to the flat `unit_models` list — 2.0 has no tier concept yet.",
  },
  {
    legacyKey: "ids.format",
    targetKey: "ids.format",
    note: "direct 1:1 — both layouts read `ids: { format: timestamp|sequential }`.",
  },
  {
    legacyKey: "ids",
    targetKey: "ids.format",
    note: "bare top-level occurrence of the `ids:` parent key — same equivalence as `ids.format`, listed separately because layout classification only scans top-level key names, not nested paths.",
  },
  {
    legacyKey: "review",
    targetKey: null,
    note: "dialectic review gate (reviewer × advocate) has no 2.0 equivalent yet.",
  },
  {
    legacyKey: "plan_gate",
    targetKey: null,
    note: "interactive plan-approval handshake has no 2.0 equivalent yet.",
  },
  {
    legacyKey: "evidence",
    targetKey: null,
    note: "PostToolUse evidence-log settings have no 2.0 equivalent yet.",
  },
  {
    legacyKey: "milestone_cleanup",
    targetKey: null,
    note: "artifact-cleanup policy on milestone close has no 2.0 equivalent yet.",
  },
  {
    legacyKey: "verification",
    targetKey: null,
    note: "no 2.0 equivalent for the block as a whole; its `command_timeout_ms` sub-key is conceptually close to the flat `unit_timeout_ms`, but the block itself does not map 1:1.",
  },
];

const PHASE_ROUTING_HEADER = /^##\s*Phase\s*→\s*Agent Routing/m;
const PHASE_ROUTING_TABLE_ROW = /^\|\s*Phase\s*\|\s*Agent\s*\|/m;
const FENCED_BLOCK = /```[\s\S]*?```/g;
/** Top-level (unindented) `key: value` or `key:` line — same anchor shape as `prefs.ts:parsePrefsBlock`. */
const TOP_LEVEL_KEY_LINE = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/m;

function extractFencedBlocks(raw: string): string[] {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  FENCED_BLOCK.lastIndex = 0;
  while ((match = FENCED_BLOCK.exec(raw)) !== null) {
    blocks.push(match[0]);
  }
  return blocks;
}

function hasNested1xSignal(raw: string): boolean {
  if (PHASE_ROUTING_HEADER.test(raw)) return true;
  if (PHASE_ROUTING_TABLE_ROW.test(raw)) return true;
  return extractFencedBlocks(raw).some((block) => block.includes("skip_discuss:"));
}

/**
 * Classify raw prefs-file content (never a parsed/merged object — the
 * caller must read the file itself, since `readForgePrefs`/`parsePrefsBlock`
 * already collapse structure this classifier needs to detect).
 *
 * Order matters: empty check first, then the 1.0 nested signals (markdown
 * `## Phase → Agent Routing` table, or a fenced block carrying
 * `skip_discuss:`), then a lenient flat check (at least one recognizable
 * top-level `key:` line — the real 2.0-native fixture wraps its flat content
 * in a ```yaml fence and a trailing `## Notas` prose section, so "flat" is
 * "no 1.0 signal + something that looks like a key line", not "nothing but
 * key lines"). Never throws.
 */
export function classifyPrefsShape(raw: string): PrefsShapeKind {
  if (raw.trim() === "") return "empty";
  if (hasNested1xSignal(raw)) return "nested1x";
  if (TOP_LEVEL_KEY_LINE.test(raw)) return "flat";
  return "unknown";
}

export interface PrefsLayoutFinding {
  /** Absolute path to the prefs file this finding is about. */
  source: string;
  /** Short label from `PrefsSource.label` (e.g. "repo", "legacy ~/.claude"). */
  label: string;
  shape: PrefsShapeKind;
  /** Legacy keys found in this layer with no 2.0 equivalent (or absent from `PREFS_KEY_MAP` entirely). */
  unmapped: string[];
}

function findUnmappedKeys(raw: string): string[] {
  const found = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (match) found.add(match[1]);
  }

  const unmapped: string[] = [];
  for (const key of found) {
    const mapping = PREFS_KEY_MAP.find((entry) => entry.legacyKey === key);
    if (!mapping || mapping.targetKey === null) {
      unmapped.push(key);
    }
  }
  return unmapped;
}

/**
 * Classify every existing layer of the 4-layer prefs cascade for `cwd`
 * (reuses `prefs.ts:prefsSources` for the layer list — never reimplements
 * it). A missing layer is normal and simply does not appear in the result;
 * an unreadable layer is skipped the same way `readForgePrefs` does.
 *
 * `unmapped` is only computed for `nested1x` layers — a `flat` layer is, by
 * definition, already in the 2.0 shape and has nothing to migrate.
 */
export function classifyPrefsLayout(cwd: string): PrefsLayoutFinding[] {
  const findings: PrefsLayoutFinding[] = [];

  for (const source of prefsSources(cwd)) {
    if (!existsSync(source.path)) continue;

    let raw: string;
    try {
      raw = readFileSync(source.path, "utf-8");
    } catch {
      continue;
    }

    const shape = classifyPrefsShape(raw);
    const unmapped = shape === "nested1x" ? findUnmappedKeys(raw) : [];

    findings.push({ source: source.path, label: source.label, shape, unmapped });
  }

  return findings;
}
