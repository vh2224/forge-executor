/**
 * Forge CHECKER fragment store — per-slice recurring plan-checker findings.
 *
 * Minimal TS port of forge-agent 1.0 `scripts/forge-checker-memory.js` (591l)
 * into the 2.0 namespace (D-S04-4), closing the "CHECKER no merger → S04"
 * deferral from D-S03-3. Deliberately MINIMAL — no lockfile, no FTS, no
 * dedup/decay heuristics from the 1.0 script; only what the merger projection
 * needs: write/list/parse a recurring finding per slice.
 *
 * Each fragment lives at `.gsd/checker/<milestoneId>/<slice>.md` (S04
 * review-fix R2: the milestone id is folded into the path so slice labels that
 * restart per-milestone — "S01" in two milestones — never collide on a single
 * `.gsd/checker/<slice>.md`). This mirrors the milestone-namespaced layout of
 * every sibling artifact under `.gsd/milestones/<mid>/...`. It mirrors the
 * ledger.ts / decisions.ts fragment-store shape (frontmatter scalar + a block
 * array of rows). Written atomically via `writeFileAtomic` (shared with ledger.ts) —
 * no lockfile: the D3 single-writer invariant + temp+rename make cross-process
 * locking unnecessary, same rationale as ledger.ts/decisions.ts.
 *
 * GOTCHA (S03/T07): unlike ledger.ts/decisions.ts, `writeCheckerFragment` does
 * NOT gate on `isValid(slice)` from state/ids.ts — slice IDs are short forms
 * like "S01" that `isValid` (which only recognizes M-/T-/TASK- id shapes)
 * would reject. `listCheckerFragments` keys fragments by FILE NAME (slice
 * label straight from the `.md` stem), matching an e2e fixture in S03/T07
 * that exercises synthetic/non-canonical slice ids. This is the documented
 * contour for this store only — ledger/decisions keep their `isValid` gate.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` import.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../state/ledger.js";

/** Relative path (from cwd) to the checker fragment directory. */
export const CHECKER_DIR = ".gsd/checker";

/** A single recurring finding row inside a fragment. */
export interface CheckerFinding {
  dimension: string;
  verdict: string;
  note: string;
}

/** A parsed / writable CHECKER fragment for one slice. */
export interface CheckerFragment {
  slice: string;
  generatedAt: string | null;
  findings: CheckerFinding[];
}

/**
 * Absolute path to the checker directory for a given cwd and milestone. The
 * milestone id is folded in (S04 review-fix R2) so per-milestone slice labels
 * never collide.
 */
export function checkerDir(cwd: string = process.cwd(), milestoneId: string = ""): string {
  return milestoneId ? join(cwd, ".gsd", "checker", milestoneId) : join(cwd, ".gsd", "checker");
}

/**
 * Absolute path to the fragment file for a slice label under a milestone:
 * `.gsd/checker/<milestoneId>/<slice>.md` (S04 review-fix R2). Unlike
 * `fragmentPath`/`decisionFragmentPath`, this does NOT validate via
 * `isValid()` — slice labels ("S01", synthetic test ids, ...) are outside the
 * milestone/task id shape those stores gate on (see module gotcha comment).
 */
export function checkerFragmentPath(cwd: string, milestoneId: string, slice: string): string {
  return join(checkerDir(cwd, milestoneId), `${slice}.md`);
}

// ── Scalar (un)escaping — same convention as ledger.ts/decisions.ts ────────────

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

const ROW_KEYS = ["dimension", "verdict", "note"] as const;

// ── parseCheckerFragment ────────────────────────────────────────────────────────

/**
 * Parse a CHECKER fragment. The `findings:` key holds a block array of
 * objects; each object starts with `  - <key>: <value>` and continues with
 * `    <key>: <value>` lines — mirrors `parseDecisionFragment`'s row shape.
 * Never throws — a malformed shape degrades to an empty findings list.
 */
export function parseCheckerFragment(text: string): CheckerFragment {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { slice: "", generatedAt: null, findings: [] };
  }

  const lines = match[1].split("\n");
  let slice = "";
  let generatedAt: string | null = null;
  const findings: CheckerFinding[] = [];
  let current: Partial<Record<string, string>> | null = null;
  let inFindings = false;

  const flush = (): void => {
    if (current) {
      findings.push({
        dimension: current.dimension ?? "",
        verdict: current.verdict ?? "",
        note: current.note ?? "",
      });
      current = null;
    }
  };

  for (const line of lines) {
    // Start of a finding object item: "  - key: value"
    const itemStart = line.match(/^\s*-\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (inFindings && itemStart) {
      flush();
      current = {};
      current[itemStart[1]] = parseScalarValue(itemStart[2]);
      continue;
    }

    // Continuation of the current finding object: "    key: value"
    if (inFindings && current) {
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
      if (kv[1] === "findings") {
        inFindings = true;
        continue;
      }
      inFindings = false;
      if (kv[1] === "slice") slice = parseScalarValue(kv[2]);
      if (kv[1] === "generated_at") {
        const v = parseScalarValue(kv[2]);
        generatedAt = v === "" ? null : v;
      }
    }
  }
  flush();

  return { slice, generatedAt, findings };
}

// ── serializeCheckerFragment ────────────────────────────────────────────────────

/**
 * Serialize a CHECKER fragment deterministically: `slice`/`generated_at`
 * scalars followed by a `findings:` block array (dimension/verdict/note in
 * fixed order). Diff-stable, mirrors `serializeDecisionFragment`.
 */
export function serializeCheckerFragment(fragment: CheckerFragment): string {
  const lines: string[] = [];
  lines.push(`slice: ${serializeScalar(fragment.slice)}`);
  lines.push(`generated_at: ${fragment.generatedAt == null ? '""' : serializeScalar(fragment.generatedAt)}`);
  if (!fragment.findings || fragment.findings.length === 0) {
    lines.push("findings: []");
  } else {
    lines.push("findings:");
    for (const row of fragment.findings) {
      lines.push(`  - dimension: ${serializeScalar(String(row.dimension ?? ""))}`);
      for (const key of ROW_KEYS.slice(1)) {
        lines.push(`    ${key}: ${serializeScalar(String(row[key] ?? ""))}`);
      }
    }
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

/** True when two findings carry the same dimension/verdict/note triple. */
function sameFinding(a: CheckerFinding, b: CheckerFinding): boolean {
  return a.dimension === b.dimension && a.verdict === b.verdict && a.note === b.note;
}

/**
 * Write (append) a recurring CHECKER finding for a slice under a milestone.
 * Reads the existing `.gsd/checker/<milestoneId>/<slice>.md` fragment (if any),
 * and — if `finding` is NOT already present (same dimension/verdict/note) —
 * appends it and writes atomically.
 *
 * Idempotent by dedupe (S04 review-fix R1): the pre-append `existing.findings`
 * is checked for an equivalent finding BEFORE any append. If found, the
 * fragment is left untouched and `{ created: false }` is returned. This makes
 * repeated writes of the same finding (e.g. a re-planned slice re-running the
 * advisory hook) a true no-op instead of accumulating duplicate rows without
 * bound. A genuinely new finding still appends and returns `{ created: true }`.
 *
 * Does NOT validate `slice` via `isValid()` — see module gotcha comment.
 */
export function writeCheckerFragment(
  cwd: string,
  milestoneId: string,
  slice: string,
  finding: CheckerFinding,
): { path: string; created: boolean } {
  if (!slice) {
    throw new Error("slice is required");
  }
  const fpath = checkerFragmentPath(cwd, milestoneId, slice);
  const existing = existsSync(fpath) ? parseCheckerFragment(readFileSync(fpath, "utf-8")) : null;
  const existingFindings = existing?.findings ?? [];

  // Dedupe BEFORE appending: an equivalent finding already on disk means the
  // fragment is unchanged — no rewrite, no duplicate row.
  if (existingFindings.some((f) => sameFinding(f, finding))) {
    return { path: fpath, created: false };
  }

  const fragment: CheckerFragment = {
    slice,
    generatedAt: new Date().toISOString(),
    findings: [...existingFindings, finding],
  };
  writeFileAtomic(fpath, serializeCheckerFragment(fragment));
  return { path: fpath, created: true };
}

/** Read and parse a CHECKER fragment, or `null` if the file does not exist. */
export function readCheckerFragment(
  cwd: string,
  milestoneId: string,
  slice: string,
): CheckerFragment | null {
  const fpath = checkerFragmentPath(cwd, milestoneId, slice);
  if (!existsSync(fpath)) return null;
  return parseCheckerFragment(readFileSync(fpath, "utf-8"));
}

/**
 * List all `.md` fragments in the milestone's checker directory as
 * `{ slice, path }`, sorted by slice ascending. Keyed by FILE NAME, not by a
 * validated id (see module gotcha comment) — returns `[]` when the directory
 * is absent (never throws).
 */
export function listCheckerFragments(
  cwd: string,
  milestoneId: string,
): { slice: string; path: string }[] {
  const dir = checkerDir(cwd, milestoneId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ slice: f.slice(0, -3), path: join(dir, f) }))
    .sort((a, b) => a.slice.localeCompare(b.slice));
}
