/**
 * Forge LEDGER fragment store — per-milestone (and per-task) durable record.
 *
 * Minimal TS port of forge-agent 1.0 `scripts/forge-ledger.js` into the 2.0
 * namespace (D-S03-3). Deliberately REWRITTEN — never imports the condemned
 * `gsd/` tree (iron rule 2), and drops the 1.0 `forge-yaml-safe`/`forge-lock`
 * dependencies: D3 single-writer + the temp+rename atomic write of `store.ts`
 * make the cross-process lockfile unnecessary.
 *
 * Each fragment lives at `.gsd/ledger/<id>.md` as YAML-ish frontmatter + body.
 * The `complete-milestone` worker (S03/T03) synthesizes and writes this exact
 * shape with its own `write` tool; `state/merger.ts` reads all fragments back to
 * rebuild the global `.gsd/LEDGER.md` projection.
 *
 * Performs I/O but stays pure of the harness runtime: node builtins + sibling
 * pure state modules only — no `@gsd/*` import.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { isValid, entityKind } from "./ids.js";

/** Relative path (from cwd) to the ledger fragment directory. */
export const LEDGER_DIR = ".gsd/ledger";

/** A parsed / writable LEDGER fragment. */
export interface LedgerEntry {
  id: string;
  title: string | null;
  completed_at: string | null;
  slices: string[];
  key_files: string[];
  key_decisions: string[];
  body: string;
}

/** Absolute path to the ledger directory for a given cwd. */
export function ledgerDir(cwd: string = process.cwd()): string {
  return join(cwd, ".gsd", "ledger");
}

/**
 * Absolute path to the fragment file for a milestone OR task ID.
 * Both kinds share the store: `.gsd/ledger/<id>.md`. Throws on an invalid id or
 * an id that is neither a milestone nor a task (mirrors the 1.0 contract).
 */
export function fragmentPath(cwd: string, id: string): string {
  if (!isValid(id)) {
    throw new Error(`Invalid ledger ID: ${id}`);
  }
  const kind = entityKind(id);
  if (kind !== "milestone" && kind !== "task") {
    throw new Error(`ID is not a milestone or task: ${id} (kind: ${kind})`);
  }
  return join(ledgerDir(cwd), `${id}.md`);
}

// ── Scalar (un)escaping ────────────────────────────────────────────────────────
// A scalar is JSON-double-quoted when it is empty or contains a character that
// would confuse the flat `key: value` reader (colon, leading `#`, or leading/
// trailing whitespace). Reading re-attempts `JSON.parse` on quoted values so a
// title with a `:` round-trips losslessly.

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

/**
 * Split a `[a, "b, c", d]` inline array into its item strings, honoring quoted
 * items so an embedded comma inside a quoted value does not split it.
 */
function splitInlineArray(inner: string): string[] {
  const items: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      buf += ch;
      if (ch === quote && inner[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      items.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== "") items.push(buf);
  return items.map((s) => parseScalarValue(s)).filter((s) => s !== "");
}

// ── parseLedgerFragment ────────────────────────────────────────────────────────

const ARRAY_FIELDS = ["slices", "key_files", "key_decisions"] as const;

/**
 * Parse a LEDGER fragment (frontmatter + body). Accepts BOTH the inline-array
 * form the `complete-milestone` worker writes (`slices: ["S01 — t", "S02 — t"]`)
 * and the block-array form `writeLedgerFragment` serializes. Never throws on a
 * malformed shape — missing fields degrade to null/[] (A6 resilience).
 */
export function parseLedgerFragment(text: string): LedgerEntry {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { id: "", title: null, completed_at: null, slices: [], key_files: [], key_decisions: [], body: text.trim() };
  }

  const lines = match[1].split("\n");
  const body = match[2].trim();
  const scalars: Record<string, string> = {};
  const arrays: Record<string, string[]> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    const rawVal = kv[2].trim();

    // Inline array
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      const inner = rawVal.slice(1, -1).trim();
      arrays[key] = inner === "" ? [] : splitInlineArray(inner);
      i++;
      continue;
    }

    // Block array — empty value, items on subsequent `  - ` lines
    if (rawVal === "") {
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const item = lines[i].match(/^\s*-\s+(.*)$/);
        if (!item) break;
        items.push(parseScalarValue(item[1]));
        i++;
      }
      arrays[key] = items;
      continue;
    }

    // Scalar
    scalars[key] = parseScalarValue(rawVal);
    i++;
  }

  const arr = (k: string): string[] => arrays[k] ?? (scalars[k] != null ? [scalars[k]] : []);

  return {
    id: scalars.id ?? "",
    title: scalars.title ?? null,
    completed_at: scalars.completed_at ?? null,
    slices: arr(ARRAY_FIELDS[0]),
    key_files: arr(ARRAY_FIELDS[1]),
    key_decisions: arr(ARRAY_FIELDS[2]),
    body,
  };
}

// ── serializeLedgerFragment ────────────────────────────────────────────────────

/**
 * Serialize a LEDGER entry to `---\n<frontmatter>\n---\n\n<body>\n`. Keys are
 * emitted in a fixed canonical order (id, title, completed_at, slices,
 * key_files, key_decisions) for deterministic, diff-stable output. Arrays use
 * block form.
 */
export function serializeLedgerFragment(entry: LedgerEntry): string {
  const lines: string[] = [];
  lines.push(`id: ${serializeScalar(entry.id)}`);
  lines.push(`title: ${entry.title == null ? '""' : serializeScalar(entry.title)}`);
  lines.push(`completed_at: ${entry.completed_at == null ? '""' : serializeScalar(entry.completed_at)}`);

  for (const field of ARRAY_FIELDS) {
    const items = entry[field] ?? [];
    if (items.length === 0) {
      lines.push(`${field}: []`);
    } else {
      lines.push(`${field}:`);
      for (const item of items) lines.push(`  - ${serializeScalar(String(item))}`);
    }
  }

  const body = entry.body ? `\n${entry.body.trim()}\n` : "";
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

// ── Atomic write (temp + rename, D3 single-writer — no lockfile) ────────────────

/**
 * Write `content` to `target` atomically: serialize into a sibling temp file in
 * the SAME directory, then `renameSync` over the target (intra-directory rename
 * is atomic on POSIX). Shared by the fragment stores and the merger.
 */
export function writeFileAtomic(target: string, content: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ── writeLedgerFragment ─────────────────────────────────────────────────────────

/**
 * Write a LEDGER fragment. Validates `entry.id`, serializes canonically, and
 * writes atomically. Idempotent: if the file already exists with byte-identical
 * content, returns `{ created: false }` without rewriting.
 */
export function writeLedgerFragment(cwd: string, entry: LedgerEntry): { path: string; created: boolean } {
  if (!entry || !entry.id) {
    throw new Error("entry.id is required");
  }
  const fpath = fragmentPath(cwd, entry.id); // throws on invalid id
  const content = serializeLedgerFragment(entry);

  if (existsSync(fpath)) {
    try {
      if (readFileSync(fpath, "utf-8") === content) return { path: fpath, created: false };
    } catch {
      // unreadable — fall through and rewrite
    }
  }

  writeFileAtomic(fpath, content);
  return { path: fpath, created: true };
}

/** Read and parse a LEDGER fragment, or `null` if the file does not exist. */
export function readLedgerFragment(cwd: string, id: string): LedgerEntry | null {
  const fpath = fragmentPath(cwd, id); // throws on invalid id
  if (!existsSync(fpath)) return null;
  return parseLedgerFragment(readFileSync(fpath, "utf-8"));
}

/**
 * List all `.md` fragments in the ledger directory as `{ id, path }`, sorted by
 * id ascending. Returns `[]` when the directory is absent (never throws).
 */
export function listLedgerFragments(cwd: string): { id: string; path: string }[] {
  const dir = ledgerDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ id: f.slice(0, -3), path: join(dir, f) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
