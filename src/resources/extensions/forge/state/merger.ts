/**
 * Forge projection merger — rebuilds the global `.gsd/LEDGER.md` and
 * `.gsd/DECISIONS.md` from their fragment stores.
 *
 * Minimal TS port of the LEDGER/DECISIONS rebuild logic from forge-agent 1.0
 * (`scripts/forge-projection.js` renderLedger/renderDecisions +
 * `scripts/forge-merger.js`) into the 2.0 namespace (D-S03-3). Rewritten — no
 * `gsd/` import. CHECKER (S04) was out of scope at that time; events remain
 * out of scope.
 *
 * `rebuildProjections(cwd)` reads EVERY fragment and regenerates all global
 * projections deterministically and idempotently: running it twice produces
 * byte-identical files. It is a safe no-op over zero fragments (absent
 * directories → header-only projection, never a throw). No lockfile: the D3
 * single-writer invariant + the temp+rename atomic write make cross-process
 * locking unnecessary.
 *
 * S04/D-S04-4 extends the rebuild with a third projection, `.gsd/CHECKER.md`,
 * from the `gates/checker-memory.ts` fragment store — closing the "CHECKER no
 * merger → S04" deferral from D-S03-3. Checker fragments are milestone-
 * namespaced (`.gsd/checker/<mid>/<slice>.md`, S04 review-fix R2), so
 * `rebuildProjections(cwd, milestoneId)` renders the CHECKER projection for the
 * current milestone only.
 *
 * S07/T03 closes the "AUTO-MEMORY out of scope" deferral: a fourth projection,
 * `.gsd/AUTO-MEMORY.md`, is rendered from the `memory/memory-rank.ts` ranked
 * fact store via `loadRankedMemory`+`renderAutoMemory`. `rebuildProjections`
 * also threads an optional `now` (default `Date.now()`) through to
 * `loadRankedMemory` for deterministic decay/idempotency in tests. Both
 * additions are ADDITIVE — existing call sites passing 1-2 args are untouched.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` import.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listLedgerFragments, parseLedgerFragment, writeFileAtomic, type LedgerEntry } from "./ledger.js";
import { listDecisionFragments, parseDecisionFragment, type DecisionRow } from "./decisions.js";
import {
  listCheckerFragments,
  parseCheckerFragment,
  type CheckerFinding,
} from "../gates/checker-memory.js";
import { loadRankedMemory, renderAutoMemory } from "../memory/memory-rank.js";

/** Result of a projection rebuild. */
export interface RebuildResult {
  /** Number of ledger fragments rendered into LEDGER.md. */
  ledger: number;
  /** Number of unique decision rows rendered into DECISIONS.md. */
  decisions: number;
  /** Number of checker fragments (slices) rendered into CHECKER.md. */
  checker: number;
  /** Number of ranked memory facts rendered into AUTO-MEMORY.md. */
  memory: number;
  /** Non-fatal per-fragment read/parse errors (rebuild still completes). */
  errors: string[];
}

// ── LEDGER.md rendering ─────────────────────────────────────────────────────────

/**
 * Render the LEDGER.md projection from parsed fragments. Fragments are ordered
 * by `completed_at` ascending (id as deterministic tiebreaker) so the tail is
 * always the most recently completed milestone; a missing `completed_at` sorts
 * first (treated as oldest).
 */
function renderLedger(entries: { id: string; frag: LedgerEntry }[]): string {
  const lines: string[] = ["# Forge Project Ledger", ""];
  lines.push("> Compact record of completed milestones. Rebuilt from fragments. Never hand-edited.");
  lines.push("");

  if (entries.length === 0) {
    lines.push("_No completed milestones yet._");
    return lines.join("\n") + "\n";
  }

  const sorted = [...entries].sort((a, b) => {
    const ca = String(a.frag.completed_at ?? "");
    const cb = String(b.frag.completed_at ?? "");
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return a.id.localeCompare(b.id);
  });

  for (const { id, frag } of sorted) {
    lines.push(`## ${frag.id || id}`);
    if (frag.title) lines.push(`**${frag.title}**`);
    if (frag.completed_at) lines.push(`Completed: ${frag.completed_at}`);
    lines.push("");

    const hasStructured =
      frag.slices.length > 0 || frag.key_files.length > 0 || frag.key_decisions.length > 0;

    if (frag.slices.length > 0) lines.push(`**Slices:** ${frag.slices.join(", ")}`);
    if (frag.key_files.length > 0) {
      lines.push("**Key files:**");
      for (const kf of frag.key_files) lines.push(`  - ${kf}`);
    }
    if (frag.key_decisions.length > 0) {
      lines.push("**Key decisions:**");
      for (const kd of frag.key_decisions) lines.push(`  - ${kd}`);
    }

    // Body is only emitted when no structured fields exist — otherwise it would
    // duplicate them (mirrors the 1.0 renderLedger contract).
    if (!hasStructured && frag.body) {
      lines.push("");
      lines.push(frag.body);
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ── DECISIONS.md rendering ──────────────────────────────────────────────────────

const DECISIONS_HEADER = "| ID | Decision | Rationale | Date |";
const DECISIONS_SEP = "|----|----------|-----------|------|";

function escapeCell(value: string): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/**
 * Render the DECISIONS.md projection as a markdown table
 * `| ID | Decision | Rationale | Date |`. Rows are deduped by ID (first
 * occurrence wins) and ordered by Date ascending, with ID as tiebreaker for
 * determinism.
 */
function renderDecisions(rows: DecisionRow[]): { text: string; count: number } {
  const seen = new Set<string>();
  const unique: DecisionRow[] = [];
  for (const row of rows) {
    const id = String(row.id ?? "").trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    unique.push(row);
  }

  unique.sort((a, b) => {
    const da = String(a.date ?? "");
    const db = String(b.date ?? "");
    if (da < db) return -1;
    if (da > db) return 1;
    return String(a.id).localeCompare(String(b.id));
  });

  const lines: string[] = ["# Forge Decisions Log", ""];
  lines.push("> Append-only decision registry. Rebuilt from fragments. Never hand-edited.");
  lines.push("");
  lines.push(DECISIONS_HEADER);
  lines.push(DECISIONS_SEP);
  for (const row of unique) {
    lines.push(
      `| ${escapeCell(row.id)} | ${escapeCell(row.decision)} | ${escapeCell(row.rationale)} | ${escapeCell(row.date)} |`,
    );
  }
  lines.push("");
  return { text: lines.join("\n"), count: unique.length };
}

// ── CHECKER.md rendering ────────────────────────────────────────────────────────

/**
 * Render the CHECKER.md projection from parsed fragments, one section per
 * slice, ordered by slice label ascending (deterministic, mirrors
 * renderLedger's ordering-by-key discipline). Always emits a header even with
 * zero fragments (zero-fragment header-only, same guarantee as LEDGER/
 * DECISIONS — never conditional).
 */
function renderChecker(entries: { slice: string; findings: CheckerFinding[] }[]): string {
  const lines: string[] = ["# Forge Checker Memory", ""];
  lines.push("> Recurring plan-checker findings by slice. Rebuilt from fragments. Never hand-edited.");
  lines.push("");

  if (entries.length === 0) {
    lines.push("_No recurring checker findings yet._");
    return lines.join("\n") + "\n";
  }

  const sorted = [...entries].sort((a, b) => a.slice.localeCompare(b.slice));

  for (const { slice, findings } of sorted) {
    lines.push(`## ${slice}`);
    lines.push("");
    for (const f of findings) {
      lines.push(`- **${f.dimension}** (${f.verdict}): ${f.note}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ── rebuildProjections ───────────────────────────────────────────────────────────

/**
 * Read all LEDGER and DECISIONS fragments under `cwd` and regenerate the global
 * `.gsd/LEDGER.md` and `.gsd/DECISIONS.md` projections. Deterministic and
 * idempotent (rerun → byte-identical). Safe no-op over zero fragments. A
 * per-fragment read/parse failure is collected in `errors` and skipped — never
 * aborts the whole rebuild.
 */
export function rebuildProjections(
  cwd: string,
  milestoneId: string = "",
  now: number = Date.now(),
): RebuildResult {
  const errors: string[] = [];

  // ── LEDGER ──
  const ledgerEntries: { id: string; frag: LedgerEntry }[] = [];
  for (const { id, path: fpath } of listLedgerFragments(cwd)) {
    try {
      ledgerEntries.push({ id, frag: parseLedgerFragment(readFileSync(fpath, "utf-8")) });
    } catch (e) {
      errors.push(`ledger:${id}: ${(e as Error).message}`);
    }
  }
  const ledgerText = renderLedger(ledgerEntries);
  writeFileAtomic(join(cwd, ".gsd", "LEDGER.md"), ledgerText);

  // ── DECISIONS ──
  const decisionRows: DecisionRow[] = [];
  for (const { unitId, path: fpath } of listDecisionFragments(cwd)) {
    try {
      const frag = parseDecisionFragment(readFileSync(fpath, "utf-8"));
      for (const row of frag.decisions) decisionRows.push(row);
    } catch (e) {
      errors.push(`decisions:${unitId}: ${(e as Error).message}`);
    }
  }
  const rendered = renderDecisions(decisionRows);
  writeFileAtomic(join(cwd, ".gsd", "DECISIONS.md"), rendered.text);

  // ── CHECKER ──
  // S04 review-fix R2: CHECKER fragments are milestone-namespaced
  // (`.gsd/checker/<mid>/<slice>.md`), so the projection for the current
  // milestone reads only its own fragments. Absent a milestone id (legacy call
  // sites), the store is empty → a header-only projection.
  const checkerEntries: { slice: string; findings: CheckerFinding[] }[] = [];
  for (const { slice, path: fpath } of listCheckerFragments(cwd, milestoneId)) {
    try {
      const frag = parseCheckerFragment(readFileSync(fpath, "utf-8"));
      checkerEntries.push({ slice, findings: frag.findings });
    } catch (e) {
      errors.push(`checker:${slice}: ${(e as Error).message}`);
    }
  }
  const checkerText = renderChecker(checkerEntries);
  writeFileAtomic(join(cwd, ".gsd", "CHECKER.md"), checkerText);

  // ── AUTO-MEMORY ──
  // loadRankedMemory already wraps each fragment read in its own try/catch
  // (unreadable/corrupt fragment is skipped, never aborts the load), matching
  // the per-fragment error tolerance of the other three projections.
  const { selected, promoted } = loadRankedMemory(cwd, { now });
  const memoryText = renderAutoMemory(selected, promoted);
  writeFileAtomic(join(cwd, ".gsd", "AUTO-MEMORY.md"), memoryText);

  return {
    ledger: ledgerEntries.length,
    decisions: rendered.count,
    checker: checkerEntries.length,
    memory: selected.length,
    errors,
  };
}
