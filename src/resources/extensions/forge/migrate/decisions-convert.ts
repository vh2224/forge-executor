/**
 * Forge migrate — DECISIONS fragment converter (1.0 when/scope/choice/
 * revisable → 2.0 id/decision/rationale/date), S02/T04.
 *
 * The 1.0 shape has no `id` field per row — a decision is identified only by
 * its position in the `decisions:` array. This converter synthesizes a
 * deterministic `<unitId>-D<N>` (1-based appearance order). `when` maps to
 * `date`; `decision`/`rationale` copy verbatim. The two 1.0 fields with no 2.0
 * equivalent (`scope`/`choice`/`revisable`) are never dropped — they land in
 * the 2.0 fragment's free `body` under a `## Legacy fields (forge 1.0)`
 * section, one block per converted decision.
 *
 * The 1.0 fixture mixes block-scalar (`key: |` + deeper-indented content
 * line(s)) and inline (`key: value`) forms for the SAME field across
 * different rows in the same file (e.g. `choice`/`rationale` on most rows are
 * inline, but block-scalar on the last row) — `parseLegacyDecisionFragment`
 * must accept both, per-field, per-row. `unit_id:` can appear AFTER the
 * `decisions:` block in the real fixture, so the top-level-key scan keeps
 * running once the block ends rather than stopping at end-of-block.
 *
 * Read path (`parseLegacyDecisionFragment`) is a standalone state machine —
 * the 1.0 row shape (when/scope/choice/rationale/revisable) has no overlap
 * with `state/decisions.ts`'s 2.0 row shape (id/decision/rationale/date), so
 * there is nothing there to reuse for parsing. Write path reuses the real 2.0
 * writer (`writeDecisionFragment`) — never hand-serializes.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` import.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isValid, entityKind } from "../state/ids.js";
import { decisionsDir, writeDecisionFragment, type DecisionFragment, type DecisionRow } from "../state/decisions.js";

/** A single 1.0 `decisions:` row — `scope`/`choice`/`revisable` have no 2.0 field equivalent. */
export interface LegacyDecisionRow {
  when: string;
  scope: string;
  decision: string;
  choice: string;
  rationale: string;
  revisable: string;
}

const FENCED_HEADER = /^---\n[\s\S]*?\n---/;
const LEGACY_SIGNAL = /^\s*-?\s*(when|scope|choice|revisable)\s*:/m;

function parseScalarValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function indentOf(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/**
 * Parse a 1.0 DECISIONS fragment: a `decisions:` block array of objects
 * (`when`/`scope`/`decision`/`choice`/`rationale`/`revisable`) plus a
 * top-level `unit_id:` scalar that may appear before OR after the block. Each
 * row starts with `  - <key>: <value>` and continues with `    <key>:
 * <value>` — values may be inline or YAML block-scalar (`key: |` followed by
 * one or more deeper-indented content lines). Never throws — a malformed
 * shape degrades to an empty row list.
 */
export function parseLegacyDecisionFragment(raw: string): { unitId: string; rows: LegacyDecisionRow[] } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { unitId: "", rows: [] };
  }

  const lines = match[1].split("\n");
  let unitId = "";
  let inDecisions = false;
  const rowObjs: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let pendingKey: string | null = null;
  let pendingIndent = 0;

  const flush = (): void => {
    if (current) rowObjs.push(current);
    current = null;
    pendingKey = null;
  };

  for (const line of lines) {
    // Block-scalar content accumulation for the field opened by `key: |`.
    if (pendingKey && current) {
      if (line.trim() !== "" && indentOf(line) > pendingIndent) {
        const existing = current[pendingKey];
        current[pendingKey] = existing ? `${existing}\n${line.trim()}` : line.trim();
        continue;
      }
      pendingKey = null;
    }

    // Start of a decision object item: "  - key: value"
    const itemStart = line.match(/^(\s*)-\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (inDecisions && itemStart) {
      flush();
      current = {};
      const key = itemStart[2];
      const value = itemStart[3];
      if (value.trim() === "|") {
        pendingKey = key;
        pendingIndent = itemStart[1].length;
        current[key] = "";
      } else {
        current[key] = parseScalarValue(value);
      }
      continue;
    }

    // Continuation of the current decision object: "    key: value"
    if (inDecisions && current) {
      const cont = line.match(/^(\s{2,})([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (cont) {
        const key = cont[2];
        const value = cont[3];
        if (value.trim() === "|") {
          pendingKey = key;
          pendingIndent = cont[1].length;
          current[key] = "";
        } else {
          current[key] = parseScalarValue(value);
        }
        continue;
      }
      flush();
      inDecisions = false;
    }

    // Top-level key: "decisions:" / "unit_id: value" / anything else — this
    // keeps running after the decisions: block ends, since unit_id: may come
    // after it in the real fixture.
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) {
      if (kv[1] === "decisions") {
        inDecisions = true;
        continue;
      }
      inDecisions = false;
      if (kv[1] === "unit_id") unitId = parseScalarValue(kv[2]);
    }
  }
  flush();

  const rows: LegacyDecisionRow[] = rowObjs.map((r) => ({
    when: r.when ?? "",
    scope: r.scope ?? "",
    decision: r.decision ?? "",
    choice: r.choice ?? "",
    rationale: r.rationale ?? "",
    revisable: r.revisable ?? "",
  }));

  return { unitId, rows };
}

/**
 * Convert a parsed 1.0 row list into a 2.0 `DecisionFragment`. `id` is
 * synthesized as `<unitId>-D<N>` (1-based appearance order — 1.0 has no
 * native id field); `when` maps to `date`; `decision`/`rationale` copy
 * verbatim. `scope`/`choice`/`revisable` (no 2.0 field) are preserved in the
 * fragment's free `body`, one `### <id>` block per decision, so nothing is
 * silently dropped.
 */
export function convertLegacyDecisions(unitId: string, rows: LegacyDecisionRow[]): DecisionFragment {
  const decisions: DecisionRow[] = rows.map((r, i) => ({
    id: `${unitId}-D${i + 1}`,
    decision: r.decision,
    rationale: r.rationale,
    date: r.when,
  }));

  const body =
    "## Legacy fields (forge 1.0)\n\n" +
    rows
      .map(
        (r, i) =>
          `### ${unitId}-D${i + 1}\n- scope: ${r.scope}\n- choice: ${r.choice}\n- revisable: ${r.revisable}`,
      )
      .join("\n\n");

  return { unit_id: unitId, decisions, body };
}

/**
 * Scan `.gsd/decisions/` for `.md` files whose content matches the 1.0 shape
 * (same signal `fragment-store.ts:classifyDecisionFile` uses — the fenced
 * header plus a when/scope/choice/revisable key) and compute what their 2.0
 * conversion would produce. 2.0-native and unknown-shape files (e.g. a loose
 * markdown table like `legacy-orphan.md`) are skipped, never converted.
 * Missing directory degrades to `[]`, never throws. A filename that is not a
 * valid milestone/task unit ID is also skipped — such a directory entry
 * cannot be a real 1.0 decisions fragment for this store.
 */
export function computeDecisionsConversion(cwd: string): { unitId: string; path: string; fragment: DecisionFragment }[] {
  const dir = decisionsDir(cwd);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const results: { unitId: string; path: string; fragment: DecisionFragment }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const fullPath = join(dir, name);

    let raw: string;
    try {
      raw = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    // Test the legacy signal against the FRONTMATTER ONLY: the converter
    // preserves legacy-only fields in a "## Legacy fields" BODY section, and
    // matching the whole file re-classified converted fragments as legacy on
    // the next --apply — the legacy re-parse then DESTROYED converted data
    // (dates wiped to "", caught live on the double-apply idempotence check,
    // 2026-07-11). A genuine 1.0 fragment carries these keys in frontmatter.
    const fmMatch = raw.match(FENCED_HEADER);
    if (!fmMatch || !LEGACY_SIGNAL.test(fmMatch[0])) continue;

    const unitId = name.slice(0, -3);
    if (!isValid(unitId)) continue;
    const kind = entityKind(unitId);
    if (kind !== "milestone" && kind !== "task") continue;

    const { rows } = parseLegacyDecisionFragment(raw);
    const fragment = convertLegacyDecisions(unitId, rows);
    results.push({ unitId, path: fullPath, fragment });
  }

  return results;
}

/**
 * Apply the conversion computed by `computeDecisionsConversion`: write each
 * resulting fragment via the real 2.0 writer (`writeDecisionFragment`),
 * returning what it returns per result.
 */
export function applyDecisionsConversion(cwd: string): { path: string; created: boolean }[] {
  return computeDecisionsConversion(cwd).map(({ fragment }) => writeDecisionFragment(cwd, fragment));
}
