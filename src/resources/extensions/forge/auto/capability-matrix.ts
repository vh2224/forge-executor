/**
 * `auto/capability-matrix.ts` — dedicated surface for the operator-curated
 * capability matrix `.gsd/CAPABILITIES.md`: `domain × provider/model-id →
 * score 0..1`, with per-row `locked` and free-text `sources`.
 *
 * D-S02-1 — the file format is a markdown PIPE-TABLE, one row per entry,
 * NOT a fenced YAML block. The file is written by an LLM research unit
 * (S04) with sources PER ROW and hand-curated by the operator — the table
 * row is the natural unit for the per-row `locked: true` the ROADMAP asks
 * for. Per-row metadata (score + locked + sources/date) in nested YAML
 * would require a far heavier parser than the minimal line-reader allowed
 * here (iron rule: no new YAML dependency). The `models-config.ts`
 * discipline is preserved where it matters: own minimal tolerant parser,
 * fenced or not, never throws, degrades to empty. A row only becomes an
 * entry when it is a pipe-row with >= 3 cells and the score cell parses as
 * a number in [0,1] — a non-numeric score cell is skipped SILENTLY (this
 * is how the `| domain | model | score |…` header and the `|---|---|`
 * separator fall out naturally, no special case), while a numeric score
 * outside [0,1] is skipped with a named `console.warn`.
 *
 * D-S02-2 — `locked` semantics: a WRITE-time contract, not a read-time
 * precedence rule. In this reader, `locked` never alters the cascade —
 * the local layer is last-wins over the repo layer unconditionally (both
 * paths are operator curation; a single precedence rule, the cascade
 * order, keeps the merge predictable). `locked` is parsed, survives the
 * merge and is queryable on the resulting matrix (`entry.locked`) — it is
 * the contract the S04 WRITER honors: the research-models unit never
 * overwrites an existing `locked: true` row.
 *
 * D-S02-4 — a cross-layer override (local over repo) does NOT warn. This
 * is a deliberate divergence from `readModelsConfig`, where a layer
 * override is a misconfiguration symptom: here the local-over-repo
 * override is the DESIGNED usage path (operator curation beating the
 * researcher) — warning on every read would be noise that trains the
 * operator to ignore warns. Named warns are reserved for: a duplicate
 * `(domain, ref)` WITHIN the same layer (last-wins + warn), a numeric
 * score outside [0,1] (skip + warn), and a malformed ref (kept + warn).
 *
 * Scope note: `model-rank.ts` and `model-capabilities.ts` (the synthetic
 * static table used by today's rank tie-break) are NOT touched here —
 * composing/replacing that factor with this matrix is S03 work. This
 * module mirrors the FORM of `models-config.ts` (sources/cascade/
 * tolerance/named warns) without importing anything from it; the two
 * parsers are intentionally unrelated code, same note as models-config's
 * own header. The read side (`readCapabilities`, fs) is deliberately
 * separate from the lookup side (`capabilityFor`, pure): S03's call-site
 * pre-resolves the matrix once and injects a pure lookup into the rank —
 * `rankPool` never reads the filesystem.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** One parsed row of the capability table. */
export interface CapabilityEntry {
  /** Domain, lowercased at parse time (open vocabulary, D-S02-3). */
  domain: string;
  /** `provider/model-id` ref, VERBATIM — lookups are exact-match (D-S02-3). */
  ref: string;
  /** Capability score in [0,1], inclusive. */
  score: number;
  /**
   * Write-time protection flag (D-S02-2). Truthy cell values: `locked`,
   * `true`, `yes` (case-insensitive); anything else (including empty)
   * parses as `false`. Survives parse AND cascade merge.
   */
  locked: boolean;
  /** Free-text provenance, verbatim (URLs + embedded date). Absent when the cell is empty. */
  sources?: string;
}

/**
 * The parsed matrix: entries indexed by lowercased domain, then by
 * verbatim ref — O(1) merge and lookup — plus the optional file-level
 * `updated: <date>` metadata (in a cascade, the last layer that declares
 * it wins).
 */
export interface CapabilityMatrix {
  domains: Record<string, Record<string, CapabilityEntry>>;
  updated?: string;
}

export interface CapabilitySource {
  /** Absolute path to the capabilities file. */
  path: string;
  /** Short label for this cascade layer. */
  label: string;
}

/**
 * Ordered list of the 2 cascade layers, lowest precedence first —
 * mirror of `modelsConfigSources`. In target repos the convention is
 * `CAPABILITIES.md` committed, `CAPABILITIES.local.md` gitignored (same
 * convention as `models.local.md`).
 */
export function capabilitySources(cwd: string = process.cwd()): CapabilitySource[] {
  return [
    { path: path.join(cwd, ".gsd", "CAPABILITIES.md"), label: "repo" },
    { path: path.join(cwd, ".gsd", "CAPABILITIES.local.md"), label: "local" },
  ];
}

/** A fresh, empty matrix — the degraded result when no layer contributes. */
export function emptyCapabilities(): CapabilityMatrix {
  return { domains: {} };
}

/** A well-formed ref has exactly one `/` with non-empty sides. */
const REF_PATTERN = /^[^/]+\/[^/]+$/;

/** Optional file-level metadata line, outside the table: `updated: <date>`. */
const UPDATED_LINE = /^\s*updated:\s*(.+?)\s*$/i;

/** Truthy values for the `locked` cell (D-S02-2), case-insensitive. */
const LOCKED_PATTERN = /^(locked|true|yes)$/i;

function warnScoreOutOfRange(domain: string, ref: string, score: string): void {
  console.warn(
    `[forge] capability-matrix: score "${score}" out of [0,1] for "${domain}" × "${ref}" — row skipped`,
  );
}

function warnDuplicateEntry(domain: string, ref: string): void {
  console.warn(
    `[forge] capability-matrix: duplicate entry "${domain}" × "${ref}" in the same layer — last-wins, later row overrides earlier`,
  );
}

function warnMalformedRef(ref: string, domain: string): void {
  console.warn(
    `[forge] capability-matrix: malformed ref "${ref}" in domain "${domain}" — expected "provider/model-id" (entry kept; lookups will never match it)`,
  );
}

/**
 * Splits a markdown pipe-row into trimmed cells, or returns `undefined`
 * when the line is not a pipe-row at all. Leading/trailing pipes are
 * stripped; interior empty cells are preserved positionally (an empty
 * `locked` cell must stay in position 4 so `sources` stays in position 5).
 */
function splitPipeRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return undefined;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

/**
 * Parses one raw file body into a `CapabilityMatrix`. Tolerant line
 * reader, never throws:
 *
 * - a pipe-row with >= 3 cells becomes an entry: domain (lowercased,
 *   trimmed), ref (verbatim, trimmed), score (must parse as a number —
 *   a non-numeric cell skips the row SILENTLY, which is how the header
 *   and `|---|` separator rows fall out; a numeric value outside [0,1]
 *   skips with a named warn), locked (cell 4, `locked|true|yes`
 *   case-insensitive), sources (cell 5, verbatim). Cells beyond the 5th
 *   are ignored.
 * - a duplicate `(domain, ref)` within this same raw warns (named) and
 *   applies last-wins.
 * - a ref that is not `provider/model-id` warns (named) but the entry is
 *   PRESERVED — tolerant; the exact-match lookup will simply never hit
 *   it, so it degrades to "no effect on the rank".
 * - a line `updated: <value>` outside the table is captured as
 *   file-level metadata (last one wins within a file).
 * - everything else (prose, fences, blank lines) is ignored — a fenced
 *   table parses identically to a bare one.
 */
export function parseCapabilities(raw: string): CapabilityMatrix {
  const matrix = emptyCapabilities();
  if (typeof raw !== "string" || raw.length === 0) return matrix;

  for (const line of raw.split(/\r?\n/)) {
    const cells = splitPipeRow(line);
    if (cells === undefined) {
      const updated = line.match(UPDATED_LINE);
      if (updated) matrix.updated = updated[1];
      continue;
    }
    if (cells.length < 3) continue;

    const domain = cells[0].toLowerCase();
    const ref = cells[1];
    const scoreCell = cells[2];
    // Empty domain/ref or a non-numeric score cell: silently not an entry —
    // this is the tolerance path that drops the header and separator rows.
    if (!domain || !ref) continue;
    if (!scoreCell || Number.isNaN(Number(scoreCell))) continue;

    const score = Number(scoreCell);
    if (score < 0 || score > 1) {
      warnScoreOutOfRange(domain, ref, scoreCell);
      continue;
    }

    const locked = LOCKED_PATTERN.test(cells[3] ?? "");
    const sourcesCell = cells[4] ?? "";

    if (!REF_PATTERN.test(ref)) warnMalformedRef(ref, domain);

    const domainEntries = (matrix.domains[domain] ??= {});
    if (ref in domainEntries) warnDuplicateEntry(domain, ref);

    const entry: CapabilityEntry = { domain, ref, score, locked };
    if (sourcesCell.length > 0) entry.sources = sourcesCell;
    domainEntries[ref] = entry;
  }

  return matrix;
}

/**
 * Resolves the 2-layer capabilities cascade for `cwd`, last-wins per
 * `(domain, ref)` key: an entry set by `CAPABILITIES.local.md` overwrites
 * the same key from `CAPABILITIES.md`; keys the local layer doesn't
 * mention pass through untouched (their `locked`/`sources` included).
 * Missing files are skipped silently; an unreadable layer degrades to
 * "contributed nothing" rather than throwing. Returns an empty matrix
 * when no layer exists.
 *
 * Per D-S02-4 the cross-layer override emits NO warn — it is the designed
 * usage path. Per-layer diagnostics (same-layer duplicate, out-of-range
 * score, malformed ref) still fire from `parseCapabilities` on each
 * layer's own body.
 */
export function readCapabilities(cwd: string = process.cwd()): CapabilityMatrix {
  const merged = emptyCapabilities();

  for (const source of capabilitySources(cwd)) {
    if (!existsSync(source.path)) continue;
    try {
      const raw = readFileSync(source.path, "utf8");
      const layer = parseCapabilities(raw);
      for (const [domain, entries] of Object.entries(layer.domains)) {
        const target = (merged.domains[domain] ??= {});
        for (const [ref, entry] of Object.entries(entries)) {
          // Designed override path (D-S02-4): no warn, plain last-wins.
          target[ref] = entry;
        }
      }
      if (layer.updated !== undefined) merged.updated = layer.updated;
    } catch {
      // unreadable layer — skip it, keep going.
    }
  }

  return merged;
}

/**
 * Pure, deterministic lookup: the merged score for `(domain, ref)` or
 * `undefined` when either side is unknown — "no effect on the rank".
 * Domain is lowercased before the lookup (D-S02-3); ref is exact-match,
 * verbatim. Never throws, touches no fs — S03 pre-resolves the matrix
 * via `readCapabilities` and injects this per-matrix lookup into the
 * (pure) rank.
 */
export function capabilityFor(
  matrix: CapabilityMatrix,
  domain: string,
  ref: string,
): number | undefined {
  if (!matrix || !matrix.domains) return undefined;
  if (typeof domain !== "string" || typeof ref !== "string") return undefined;
  const entries = matrix.domains[domain.toLowerCase()];
  if (!entries) return undefined;
  const entry = entries[ref];
  return entry ? entry.score : undefined;
}
