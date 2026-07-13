/**
 * Forge file-audit — pure comparator between a T##-PLAN.md's declared
 * `expected_output` and the set of files actually changed by the unit.
 *
 * ADVISORY (D-S06-1/D-S06-5): this module never blocks anything. The wiring
 * (`runVerifyGate` in T06) is responsible for collecting `expected` (union of
 * `expected_output` across a slice's tasks, via `collectExpectedOutputs`, T03)
 * and `changed` (best-effort `git diff --name-only`); if git fails, the caller
 * degrades to declared-but-missing-on-disk only. None of that lives here —
 * this module is a pure set comparator with no I/O, no git, no dates.
 *
 * Exports:
 *   auditFiles(expected, changed) → { missing, unexpected }
 *   renderFileAudit(result) → one-line/table summary string
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileAuditResult {
  missing: string[];
  unexpected: string[];
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Dedup + sort a list of paths deterministically (lexicographic). */
function normalize(paths: string[]): string[] {
  return Array.from(new Set(paths)).sort();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compare `expected` (declared `expected_output` paths) against `changed`
 * (actually-changed paths) and return the two-way diff.
 *
 * - `missing`    = expected paths absent from changed (declared but not written).
 * - `unexpected` = changed paths absent from expected (written but not declared).
 *
 * Both sides are deduped and sorted deterministically. Pure: no I/O, no git,
 * no dates, no randomness.
 */
export function auditFiles(expected: string[], changed: string[]): FileAuditResult {
  const expectedSet = new Set(normalize(expected));
  const changedSet = new Set(normalize(changed));

  const missing = normalize(expected).filter((p) => !changedSet.has(p));
  const unexpected = normalize(changed).filter((p) => !expectedSet.has(p));

  return { missing, unexpected };
}

/**
 * Render a pure, one-line/table summary of a `FileAuditResult`. No embedded
 * date/timestamp — determinism for idempotency tests (mirrors S06's
 * puro+writer pattern where `generated_at` is always a caller parameter,
 * never synthesized inside a pure render function).
 */
export function renderFileAudit(result: FileAuditResult): string {
  const lines: string[] = [];
  lines.push(`file-audit: ${result.missing.length} missing, ${result.unexpected.length} unexpected`);

  if (result.missing.length > 0) {
    lines.push("missing:");
    for (const p of result.missing) {
      lines.push(`  - ${p}`);
    }
  }

  if (result.unexpected.length > 0) {
    lines.push("unexpected:");
    for (const p of result.unexpected) {
      lines.push(`  - ${p}`);
    }
  }

  return lines.join("\n");
}
