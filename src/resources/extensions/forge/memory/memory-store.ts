/**
 * Forge MEMORY fragment store — cross-milestone emergent-memory facts.
 *
 * Minimal TS port of forge-agent 1.0 `scripts/forge-memory.js` (740l) into the
 * 2.0 namespace (S07/T01). Deliberately MINIMAL — no lockfile, no FTS, no
 * dedup/decay/extraction heuristics from the 1.0 script; only what a merger
 * or extractor projection needs: write/read/list/parse a fact fragment.
 *
 * Each fragment lives at `.gsd/memory/<unit_id>.md` — GLOBAL, unlike
 * ledger.ts/decisions.ts (`.gsd/decisions/<unit_id>.md`, milestone-scoped by
 * convention of the unit id shape) and unlike checker-memory.ts
 * (`.gsd/checker/<milestoneId>/<slice>.md`, explicitly milestone-namespaced
 * in its path). Memory is intentionally NOT milestone-namespaced: unit ids
 * that produce memory fragments already embed a timestamp (e.g.
 * `M-20260709234644-...`, task ids under a milestone) and are globally
 * unique on their own, and memory facts are meant to survive and be queried
 * across milestone boundaries (that is the point of "emergent memory").
 *
 * GOTCHA (mirrors checker-memory.ts, S04/T? contour): `writeMemoryFragment`
 * does NOT gate on `isValid()` from state/ids.ts. The memory extractor may
 * run over unit ids captured from slice-level or synthetic contexts that
 * `isValid()` (which only recognizes M-/T-/TASK- id shapes) would reject —
 * exactly the same rationale checker-memory.ts documents for slice labels
 * like "S01". `listMemoryFragments` therefore keys fragments by FILE NAME
 * (the `.md` stem), not by a validated id. This is the documented contour
 * for this store only — ledger/decisions keep their `isValid` gate.
 *
 * Written atomically via `writeFileAtomic` (shared with ledger.ts/decisions.ts) —
 * no lockfile: the D3 single-writer invariant + temp+rename make cross-process
 * locking unnecessary, same rationale as the sibling fragment stores.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` import, no
 * `gsd/` import.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../state/ledger.js";

/** Relative path (from cwd) to the memory fragment directory. */
export const MEMORY_DIR = ".gsd/memory";

/** A single learned fact row inside a fragment. */
export interface MemoryFact {
  id: string;
  fact: string;
  confidence: number;
  hits: number;
  created_at: string;
}

/** A parsed / writable MEMORY fragment for one unit. */
export interface MemoryFragment {
  unit_id: string;
  facts: MemoryFact[];
}

/**
 * Absolute path to the memory directory for a given cwd. GLOBAL — no
 * milestone segment folded in (see module comment).
 */
export function memoryDir(cwd: string = process.cwd()): string {
  return join(cwd, ".gsd", "memory");
}

/**
 * Absolute path to the fragment file for a unit id: `.gsd/memory/<unit_id>.md`.
 * Unlike `decisionFragmentPath`, this does NOT validate via `isValid()` —
 * see module gotcha comment.
 */
export function memoryFragmentPath(cwd: string, unitId: string): string {
  return join(memoryDir(cwd), `${unitId}.md`);
}

/**
 * Path-traversal containment guard (R1, S07-REVIEW). `unit_id` is destined to
 * be LLM-supplied by the (out-of-process) memory-extraction agent, and this
 * store deliberately skips `isValid()` (see module gotcha comment above) —
 * so unlike ledger.ts/decisions.ts there is no id-shape gate standing between
 * a crafted `unit_id` (e.g. `"../../etc/passwd"`) and the filesystem. This is
 * NOT a replacement for `isValid()` — it is a cheap, distinct containment
 * check: reject empty ids, ids with a path separator, ids containing `..`,
 * or absolute-looking ids, BEFORE a path is built or a file written.
 */
function isTraversalUnsafeUnitId(unitId: string): boolean {
  if (!unitId) return true;
  if (unitId.includes("/") || unitId.includes("\\")) return true;
  if (unitId.includes("..")) return true;
  return false;
}

// ── Scalar (un)escaping — same convention as ledger.ts/decisions.ts ────────────

function needsQuote(value: string): boolean {
  return (
    value === "" ||
    /[:#"]/.test(value) ||
    value !== value.trim() ||
    /[\n\r\x00-\x1f]/.test(value)
  );
}

function serializeScalar(value: string): string {
  return needsQuote(value) ? JSON.stringify(value) : value;
}

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

const ROW_KEYS = ["id", "fact", "confidence", "hits", "created_at"] as const;

// ── parseMemoryFragment ─────────────────────────────────────────────────────────

/**
 * Parse a MEMORY fragment. The `facts:` key holds a block array of objects;
 * each object starts with `  - <key>: <value>` and continues with
 * `    <key>: <value>` lines — mirrors `parseDecisionFragment`'s row shape.
 * `confidence` is coerced via `Number(v)` (NaN -> 0); `hits` is coerced via
 * `Math.trunc(Number(v))` (NaN -> 0). Never throws — a malformed shape
 * degrades to an empty facts list.
 */
export function parseMemoryFragment(text: string): MemoryFragment {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { unit_id: "", facts: [] };
  }

  const lines = match[1].split("\n");
  let unitId = "";
  const facts: MemoryFact[] = [];
  let current: Partial<Record<string, string>> | null = null;
  let inFacts = false;

  const flush = (): void => {
    if (current) {
      const confidence = Number(current.confidence);
      const hits = Math.trunc(Number(current.hits));
      facts.push({
        id: current.id ?? "",
        fact: current.fact ?? "",
        confidence: Number.isNaN(confidence) ? 0 : confidence,
        hits: Number.isNaN(hits) ? 0 : hits,
        created_at: current.created_at ?? "",
      });
      current = null;
    }
  };

  for (const line of lines) {
    // Start of a fact object item: "  - key: value"
    const itemStart = line.match(/^\s*-\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (inFacts && itemStart) {
      flush();
      current = {};
      current[itemStart[1]] = parseScalarValue(itemStart[2]);
      continue;
    }

    // Continuation of the current fact object: "    key: value"
    if (inFacts && current) {
      const cont = line.match(/^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (cont) {
        current[cont[1]] = parseScalarValue(cont[2]);
        continue;
      }
      flush();
    }

    // Top-level key
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) {
      if (kv[1] === "facts") {
        inFacts = true;
        continue;
      }
      inFacts = false;
      if (kv[1] === "unit_id") unitId = parseScalarValue(kv[2]);
    }
  }
  flush();

  return { unit_id: unitId, facts };
}

// ── serializeMemoryFragment ─────────────────────────────────────────────────────

/**
 * Serialize a MEMORY fragment deterministically: `unit_id` scalar followed by
 * a `facts:` block array (each row emitting id/fact/confidence/hits/created_at
 * in fixed order; numeric fields serialized via `String(n)`). Diff-stable,
 * mirrors `serializeDecisionFragment`/`serializeCheckerFragment`.
 */
export function serializeMemoryFragment(fragment: MemoryFragment): string {
  const lines: string[] = [];
  lines.push(`unit_id: ${serializeScalar(fragment.unit_id)}`);
  if (!fragment.facts || fragment.facts.length === 0) {
    lines.push("facts: []");
  } else {
    lines.push("facts:");
    for (const row of fragment.facts) {
      lines.push(`  - id: ${serializeScalar(String(row.id ?? ""))}`);
      for (const key of ROW_KEYS.slice(1)) {
        const value = row[key];
        const serialized =
          key === "confidence" || key === "hits" ? String(value ?? 0) : serializeScalar(String(value ?? ""));
        lines.push(`    ${key}: ${serialized}`);
      }
    }
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * Write a MEMORY fragment atomically (temp+rename). Idempotent by
 * PRE-mutation byte-compare (S04-R1 lesson): the serialized content is
 * compared against the existing file BEFORE any write; a byte-identical
 * fragment returns `{ created: false }` WITHOUT rewriting.
 */
export function writeMemoryFragment(cwd: string, fragment: MemoryFragment): { path: string; created: boolean } {
  if (!fragment || !fragment.unit_id) {
    throw new Error("fragment.unit_id is required");
  }
  if (isTraversalUnsafeUnitId(fragment.unit_id)) {
    throw new Error(
      `writeMemoryFragment: unit_id ${JSON.stringify(fragment.unit_id)} is traversal-unsafe (path separator or ".." not allowed)`,
    );
  }
  const fpath = memoryFragmentPath(cwd, fragment.unit_id);
  const content = serializeMemoryFragment(fragment);
  if (existsSync(fpath)) {
    try {
      if (readFileSync(fpath, "utf-8") === content) return { path: fpath, created: false };
    } catch {
      // unreadable — fall through to (re)write
    }
  }
  writeFileAtomic(fpath, content);
  return { path: fpath, created: true };
}

/** Read and parse a MEMORY fragment, or `null` if the file does not exist. */
export function readMemoryFragment(cwd: string, unitId: string): MemoryFragment | null {
  const fpath = memoryFragmentPath(cwd, unitId);
  if (!existsSync(fpath)) return null;
  return parseMemoryFragment(readFileSync(fpath, "utf-8"));
}

/**
 * List all `.md` fragments in the memory directory as `{ unitId, path }`,
 * sorted by unitId ascending. Keyed by FILE NAME, not by a validated id (see
 * module gotcha comment) — returns `[]` when the directory is absent (never
 * throws).
 */
export function listMemoryFragments(cwd: string): { unitId: string; path: string }[] {
  const dir = memoryDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ unitId: f.slice(0, -3), path: join(dir, f) }))
    .sort((a, b) => a.unitId.localeCompare(b.unitId));
}
