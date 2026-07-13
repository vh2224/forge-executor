/**
 * Forge DECISIONS fragment store — per-unit architectural decision log.
 *
 * Minimal TS port of forge-agent 1.0 `scripts/forge-decisions.js` into the 2.0
 * namespace (D-S03-3). Rewritten — no `gsd/` import, no `forge-yaml-safe`/
 * `forge-lock`. Each fragment is `.gsd/decisions/<unit-id>.md`, holding a
 * `decisions:` block array of `{ id, decision, rationale, date }` rows.
 *
 * S03 only consumes `readDecisionFragment`/`listDecisionFragments` from the
 * merger's rebuild (the merger is a no-op over zero fragments — D-S03-5). The
 * `write`/`parse` half exists for the future decision-writing machine
 * (discuss/plan) so the store is complete when that lands.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` import.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isValid, entityKind } from "./ids.js";
import { writeFileAtomic } from "./ledger.js";

/** Relative path (from cwd) to the decisions fragment directory. */
export const DECISIONS_DIR = ".gsd/decisions";

/** A single decision row inside a fragment. */
export interface DecisionRow {
  id: string;
  decision: string;
  rationale: string;
  date: string;
}

/** A parsed / writable DECISIONS fragment for one unit. */
export interface DecisionFragment {
  unit_id: string;
  decisions: DecisionRow[];
  body: string;
}

/** Absolute path to the decisions directory for a given cwd. */
export function decisionsDir(cwd: string = process.cwd()): string {
  return join(cwd, ".gsd", "decisions");
}

/**
 * Absolute path to the fragment file for a unit ID. The unit ID must be a valid
 * milestone or task ID (mirrors the 1.0 store, minus the `ask-*` shape which is
 * out of scope for S03). Throws otherwise.
 */
export function decisionFragmentPath(cwd: string, unitId: string): string {
  if (!isValid(unitId)) {
    throw new Error(`Invalid decisions unit ID: ${unitId}`);
  }
  const kind = entityKind(unitId);
  if (kind !== "milestone" && kind !== "task") {
    throw new Error(`Unit ID is not a milestone or task: ${unitId} (kind: ${kind})`);
  }
  return join(decisionsDir(cwd), `${unitId}.md`);
}

// ── Scalar (un)escaping — same convention as ledger.ts ──────────────────────────

function needsQuote(value: string): boolean {
  return value === "" || /[:#"]/.test(value) || value !== value.trim();
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

const ROW_KEYS = ["id", "decision", "rationale", "date"] as const;

// ── parseDecisionFragment ───────────────────────────────────────────────────────

/**
 * Parse a DECISIONS fragment. The `decisions:` key holds a block array of
 * objects; each object starts with `  - <key>: <value>` and continues with
 * `    <key>: <value>` lines. Never throws — a malformed shape degrades to an
 * empty decisions list.
 */
export function parseDecisionFragment(text: string): DecisionFragment {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { unit_id: "", decisions: [], body: text.trim() };
  }

  const lines = match[1].split("\n");
  const body = match[2].trim();
  let unitId = "";
  const decisions: DecisionRow[] = [];
  let current: Partial<Record<string, string>> | null = null;
  let inDecisions = false;

  const flush = (): void => {
    if (current) {
      decisions.push({
        id: current.id ?? "",
        decision: current.decision ?? "",
        rationale: current.rationale ?? "",
        date: current.date ?? "",
      });
      current = null;
    }
  };

  for (const line of lines) {
    // Start of a decision object item: "  - key: value"
    const itemStart = line.match(/^\s*-\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (inDecisions && itemStart) {
      flush();
      current = {};
      current[itemStart[1]] = parseScalarValue(itemStart[2]);
      continue;
    }

    // Continuation of the current decision object: "    key: value"
    if (inDecisions && current) {
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
      if (kv[1] === "decisions") {
        inDecisions = true;
        continue;
      }
      inDecisions = false;
      if (kv[1] === "unit_id") unitId = parseScalarValue(kv[2]);
    }
  }
  flush();

  return { unit_id: unitId, decisions, body };
}

// ── serializeDecisionFragment ───────────────────────────────────────────────────

/**
 * Serialize a DECISIONS fragment deterministically: `unit_id` scalar followed by
 * a `decisions:` block array (each row emitting id/decision/rationale/date in
 * fixed order). Diff-stable.
 */
export function serializeDecisionFragment(fragment: DecisionFragment): string {
  const lines: string[] = [];
  lines.push(`unit_id: ${serializeScalar(fragment.unit_id)}`);
  if (!fragment.decisions || fragment.decisions.length === 0) {
    lines.push("decisions: []");
  } else {
    lines.push("decisions:");
    for (const row of fragment.decisions) {
      lines.push(`  - id: ${serializeScalar(String(row.id ?? ""))}`);
      for (const key of ROW_KEYS.slice(1)) {
        lines.push(`    ${key}: ${serializeScalar(String(row[key] ?? ""))}`);
      }
    }
  }
  const body = fragment.body ? `\n${fragment.body.trim()}\n` : "";
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/**
 * Write a DECISIONS fragment atomically (temp+rename). Idempotent: byte-identical
 * existing content returns `{ created: false }`.
 */
export function writeDecisionFragment(cwd: string, fragment: DecisionFragment): { path: string; created: boolean } {
  if (!fragment || !fragment.unit_id) {
    throw new Error("fragment.unit_id is required");
  }
  const fpath = decisionFragmentPath(cwd, fragment.unit_id); // throws on invalid id
  const content = serializeDecisionFragment(fragment);
  if (existsSync(fpath)) {
    try {
      if (readFileSync(fpath, "utf-8") === content) return { path: fpath, created: false };
    } catch {
      // unreadable — fall through
    }
  }
  writeFileAtomic(fpath, content);
  return { path: fpath, created: true };
}

/** Read and parse a DECISIONS fragment, or `null` if the file does not exist. */
export function readDecisionFragment(cwd: string, unitId: string): DecisionFragment | null {
  const fpath = decisionFragmentPath(cwd, unitId); // throws on invalid id
  if (!existsSync(fpath)) return null;
  return parseDecisionFragment(readFileSync(fpath, "utf-8"));
}

/**
 * List all `.md` fragments in the decisions directory as `{ unitId, path }`,
 * sorted by unitId ascending. Returns `[]` when the directory is absent.
 */
export function listDecisionFragments(cwd: string): { unitId: string; path: string }[] {
  const dir = decisionsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ unitId: f.slice(0, -3), path: join(dir, f) }))
    .sort((a, b) => a.unitId.localeCompare(b.unitId));
}
