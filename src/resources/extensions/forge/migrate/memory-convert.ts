/**
 * Forge migrate — MEMORY fragment converter (1.0 facts+stats → 2.0
 * id/fact/confidence/hits/created_at), S02/T05.
 *
 * The 1.0 shape splits a memory fact across TWO separate blocks in the same
 * fragment: `facts:` (mem_id/category/text/created_at/source_unit/
 * confidence_base) and `stats:` (kind/mem_id/ts/confidence_base/hits) — an
 * append-log keyed by `mem_id`, NOT ordered the same way as `facts:`. The 2.0
 * `MemoryFact` (`memory/memory-store.ts`) has no `stats:` block and no
 * `category`/`source_unit` fields, so this converter:
 *   - JOINs each fact against `stats[]` by `mem_id` to obtain `hits` (no
 *     match → `hits: 0`, never throws);
 *   - preserves `category`/`source_unit` (1.0-only) as a `[category: ... |
 *     source_unit: ...]` prefix inside the 2.0 `fact` text field — the only
 *     loss-free place in the 2.0 schema, since `MemoryFragment` has no free
 *     body the way `DecisionFragment` does.
 *
 * `.json` files under `.gsd/memory/` are NEVER treated as a conversion
 * source — they are a fossil of a deleted script (`scripts/forge-memory.js`,
 * S01/T03 finding, commit 377a1b47), not a 1.0 fragment shape.
 *
 * Read path (`parseLegacyMemoryFragment`) is a standalone state machine, NOT
 * a reuse of `parseMemoryFragment` (2.0 shape has no `stats:` block to
 * recognize). Write path reuses the real 2.0 writer (`writeMemoryFragment`)
 * — never hand-serializes.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` import.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { memoryDir, writeMemoryFragment, type MemoryFragment } from "../memory/memory-store.js";

/** A single 1.0 `facts:` row — `category`/`source_unit` have no 2.0 field equivalent. */
export interface LegacyMemoryFact {
  mem_id: string;
  category: string;
  text: string;
  created_at: string;
  source_unit: string;
  confidence_base: string;
}

/** A single 1.0 `stats:` row — only the two fields the join needs. */
export interface LegacyMemoryStat {
  mem_id: string;
  hits: string;
}

const FENCED_HEADER = /^---\n[\s\S]*?\n---/;
const LEGACY_SIGNAL = /^\s*-?\s*(mem_id|source_unit|confidence_base)\s*:/m;

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
 * Parse a 1.0 memory fragment: TWO separate block arrays (`facts:`/`stats:`)
 * plus a top-level `unit_id:` scalar. Each row starts with `  - <key>:
 * <value>` and continues with `    <key>: <value>` — values may be inline
 * (`key: value`) OR YAML block-scalar (`key: |` followed by one or more
 * deeper-indented content lines). Never throws — a malformed shape degrades
 * to empty facts/stats.
 */
export function parseLegacyMemoryFragment(raw: string): {
  unitId: string;
  facts: LegacyMemoryFact[];
  stats: LegacyMemoryStat[];
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { unitId: "", facts: [], stats: [] };
  }

  const lines = match[1].split("\n");
  let unitId = "";
  let mode: "facts" | "stats" | null = null;
  const factRows: Record<string, string>[] = [];
  const statRows: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let currentList: Record<string, string>[] | null = null;
  let pendingKey: string | null = null;
  let pendingIndent = 0;

  const flush = (): void => {
    if (current && currentList) currentList.push(current);
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

    // Start of a row: "  - key: value" (only inside facts:/stats:).
    const itemStart = line.match(/^(\s*)-\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (mode && itemStart) {
      flush();
      current = {};
      currentList = mode === "facts" ? factRows : statRows;
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

    // Continuation of the current row: "    key: value".
    if (mode && current) {
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
    }

    // Top-level key: "facts:" / "stats:" / "unit_id: value" / anything else.
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) {
      if (kv[1] === "facts") {
        mode = "facts";
        continue;
      }
      if (kv[1] === "stats") {
        mode = "stats";
        continue;
      }
      mode = null;
      if (kv[1] === "unit_id") unitId = parseScalarValue(kv[2]);
    }
  }
  flush();

  const facts: LegacyMemoryFact[] = factRows.map((r) => ({
    mem_id: r.mem_id ?? "",
    category: r.category ?? "",
    text: r.text ?? "",
    created_at: r.created_at ?? "",
    source_unit: r.source_unit ?? "",
    confidence_base: r.confidence_base ?? "",
  }));
  const stats: LegacyMemoryStat[] = statRows.map((r) => ({
    mem_id: r.mem_id ?? "",
    hits: r.hits ?? "",
  }));

  return { unitId, facts, stats };
}

/**
 * Convert a parsed 1.0 fragment into a 2.0 `MemoryFragment`. `hits` comes
 * from the `stats[]` row whose `mem_id` matches the fact's `mem_id` — the
 * LAST match wins when more than one stat shares a `mem_id` (append-log
 * convention: later entries are more recent); no match → `hits: 0`, never
 * throws. `category`/`source_unit` (no 2.0 field) are folded into the fact
 * text as a `[category: ... | source_unit: ...]` prefix so nothing is
 * silently dropped.
 */
export function convertLegacyMemory(
  unitId: string,
  facts: LegacyMemoryFact[],
  stats: LegacyMemoryStat[],
): MemoryFragment {
  return {
    unit_id: unitId,
    facts: facts.map((fact) => {
      let stat: LegacyMemoryStat | undefined;
      for (const s of stats) {
        if (s.mem_id === fact.mem_id) stat = s;
      }
      const hits = stat ? Math.trunc(Number(stat.hits)) || 0 : 0;
      const confidence = Number(fact.confidence_base) || 0;
      const text = `[category: ${fact.category} | source_unit: ${fact.source_unit}] ${fact.text}`;
      return { id: fact.mem_id, fact: text, confidence, hits, created_at: fact.created_at };
    }),
  };
}

/**
 * Scan `.gsd/memory/` for `.md` files whose content matches the 1.0 shape
 * (same signal `fragment-store.ts:classifyMemoryFile` uses) and compute what
 * their 2.0 conversion would produce. `.json` files are always skipped (S01/
 * T03 fossil finding) and 2.0-native/unknown-shape files are skipped too.
 * Missing directory degrades to `[]`, never throws.
 */
export function computeMemoryConversion(cwd: string): { unitId: string; path: string; fragment: MemoryFragment }[] {
  const dir = memoryDir(cwd);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const results: { unitId: string; path: string; fragment: MemoryFragment }[] = [];
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

    const { facts, stats } = parseLegacyMemoryFragment(raw);
    const unitId = name.slice(0, -3);
    const fragment = convertLegacyMemory(unitId, facts, stats);
    results.push({ unitId, path: fullPath, fragment });
  }

  return results;
}

/**
 * Apply the conversion computed by `computeMemoryConversion`: write each
 * resulting fragment via the real 2.0 writer (`writeMemoryFragment`),
 * returning what it returns per result.
 */
export function applyMemoryConversion(cwd: string): { path: string; created: boolean }[] {
  return computeMemoryConversion(cwd).map(({ fragment }) => writeMemoryFragment(cwd, fragment));
}
