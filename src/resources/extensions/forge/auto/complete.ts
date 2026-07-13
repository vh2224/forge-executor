/**
 * `auto/complete.ts` — the in-process milestone-close side effect (D-S03-2).
 *
 * When the loop dispatches `complete-milestone` and it reports `done`, the STATE
 * flip is already applied by the single-writer mutator (`applyUnitResult`, T02).
 * What remains is the DURABLE-PROJECTION half of a milestone close: rebuild the
 * global `.gsd/LEDGER.md` / `.gsd/DECISIONS.md` from their fragment stores (the
 * `complete-milestone`/`complete-slice` workers wrote the fragments during their
 * dispatch), receive the completer's advisory suite-run result (S06/T02), and
 * apply the operator's milestone-cleanup preference.
 *
 * ── Suite reception (S06/T02) ────────────────────────────────────────────────
 * The completer runs the canonical suite and writes flat `suite_*` frontmatter
 * onto `<mid>-SUMMARY.md` (contract 1, S06-PLAN). This module parses it and
 * appends ONE additive `suite_result` journal event (contract 2) — idempotent
 * per milestone, ordered BEFORE cleanup (which can move/delete the SUMMARY's
 * dir), and strictly advisory: the outcome never changes `rebuilt`/`cleanup`
 * or blocks the close, it only ever adds to `errors`/fires a `notify` warning.
 *
 * ── Why a SEPARATE layer (never in the pure housekeeping brain) ──────────────
 * `auto/housekeeping.ts` is 100% pure (StateDoc → StateDoc mutators, zero I/O);
 * `state/merger.ts` is idempotent projection I/O. This module is the ONLY new
 * side-effecting layer S03 adds to the loop: it performs the rebuild + the
 * filesystem cleanup that must NOT leak into either of those. It is invoked
 * exactly once by the loop, in the `continue` of a `complete-milestone: done`,
 * AFTER the STATE flip is persisted.
 *
 * ── Best-effort (D-S03-2) ────────────────────────────────────────────────────
 * A rebuild or cleanup failure must NEVER derail the loop nor un-complete the
 * milestone (the flip already landed atomically). Every step is wrapped so a
 * throw degrades to a `warning` notification and the close still returns.
 *
 * ── Never touches the global monoliths' single-writer inputs ─────────────────
 * The rebuild writes `.gsd/LEDGER.md` / `.gsd/DECISIONS.md` (projections, owned
 * by the merger). Cleanup only ever moves/removes the per-milestone directory
 * under `.gsd/milestones/<mid>`; it NEVER touches `.gsd/STATE.md` (the store's
 * single-writer surface) — STATE is authoritative and outlives the milestone dir.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` import.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, readEvents, rebuildProjections, type ForgeEvent } from "../state/index.js";
import { splitFrontmatter, parseFrontmatterMap } from "../../shared/frontmatter.js";
import { readForgePrefs } from "../prefs.js";

/** How the loop reports a non-fatal close warning (matches the loop's `notify`). */
export type CloseNotify = (message: string, level?: "info" | "warning" | "error" | "success") => void;

/** The milestone-cleanup modes an operator can select via the `milestone_cleanup` pref. */
export type MilestoneCleanupMode = "keep" | "archive" | "delete";

/**
 * Resolve the `milestone_cleanup` preference (flat key, 4-layer cascade). Any
 * value other than the three known modes — including an absent pref — degrades to
 * the safe default `keep` (never move/remove the milestone dir unless explicitly
 * asked). Case-insensitive.
 */
export function resolveMilestoneCleanup(cwd: string): MilestoneCleanupMode {
  const { prefs } = readForgePrefs(cwd);
  const raw = prefs["milestone_cleanup"];
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "archive" || value === "delete") return value;
  return "keep";
}

/**
 * The result of a milestone close — surfaced for tests/telemetry. `rebuilt` is
 * the number of LEDGER fragments merged (0 over an empty store, never a throw);
 * `cleanup` is the mode actually applied; `suite` is the advisory suite-gate
 * outcome (S06/T02, absent when the step was a no-op on an idempotent re-run);
 * `errors` collects any non-fatal step failures (the close still completes).
 */
export interface MilestoneCloseResult {
  rebuilt: number;
  cleanup: MilestoneCleanupMode;
  suite?: string;
  errors: string[];
}

/**
 * S06/T02 — the suite outcome recorded in `<mid>-SUMMARY.md` frontmatter
 * (contract 1, S06-PLAN), mirrored 1:1 onto the journaled `suite_result`
 * event's `status` (contract 2). `skipped` covers both an absent SUMMARY and
 * one with no `suite_*` keys — the completer simply never reported a suite run.
 */
type SuiteStatus = "green" | "red" | "skipped" | "error" | "timeout";

/**
 * `Number(...)` a raw frontmatter scalar; anything that isn't already a
 * string/number (an empty-value array from `parseFrontmatterMap`, `undefined`,
 * a malformed nested shape) or that fails to parse to a finite number omits
 * the field entirely, per contract 1's "counts via `Number(...)`; `NaN` →
 * omitir campo".
 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Human-readable `suite_result.summary` (contract 2) for a parsed outcome. */
function describeSuiteOutcome(
  status: SuiteStatus,
  command: string | undefined,
  passed: number | undefined,
  failed: number | undefined,
): string {
  const suffix = command ? ` (${command})` : "";
  if (status === "skipped") return "suíte: completer não reportou resultado no SUMMARY";
  if (status === "error") return `suíte: erro ao rodar${suffix}`;
  if (status === "timeout") return `suíte: timeout${suffix}`;
  const counts =
    passed !== undefined && failed !== undefined
      ? `${passed} passed, ${failed} failed`
      : passed !== undefined
        ? `${passed} passed`
        : failed !== undefined
          ? `${failed} failed`
          : "sem contagem";
  return `suíte: ${counts}${suffix}`;
}

/**
 * Close out a just-completed milestone IN-PROCESS (D-S03-2): rebuild the global
 * projections from fragments, then apply the milestone-cleanup pref. Called by
 * the loop exactly once, in the `continue` of a `complete-milestone: done`,
 * AFTER the STATE flip is persisted and BEFORE the loop returns `complete`.
 *
 * Best-effort by contract: every step is isolated so a failure logs a `warning`
 * via `notify` and is collected in `errors` — it never throws, never blocks the
 * loop's completion, and never un-does the (already-persisted) milestone flip.
 */
export function runMilestoneClose(
  cwd: string,
  milestoneId: string,
  notify: CloseNotify = () => {},
): MilestoneCloseResult {
  const errors: string[] = [];

  // (a) Rebuild LEDGER.md / DECISIONS.md from fragments — idempotent (T04).
  let rebuilt = 0;
  try {
    const res = rebuildProjections(cwd, milestoneId);
    rebuilt = res.ledger;
    // Per-fragment parse errors are non-fatal inside rebuildProjections; surface
    // them here so a malformed fragment is visible without aborting the close.
    for (const e of res.errors) errors.push(`rebuild: ${e}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`rebuild: ${message}`);
    notify(`Rebuild das projeções falhou (milestone já concluído): ${message}`, "warning");
  }

  // (a2) S06/T02 — suite reception: parse the completer's `<mid>-SUMMARY.md`
  // frontmatter and project it into the journal as an ADDITIVE `suite_result`
  // event, advisory-notifying on non-green outcomes. MUST run before (b)
  // cleanup: `archive`/`delete` can move/remove the milestone dir the SUMMARY
  // lives in (D-S06v2-1, S06-PLAN "Ordem dentro de runMilestoneClose").
  //
  // Idempotent: a `suite_result` already journaled for this milestone makes
  // the whole step a no-op — covers all 3 `runMilestoneClose` call-sites
  // (reconcile, resume-reconcile, direct dispatch) without ever duplicating.
  // Best-effort: any throw (e.g. an unreadable SUMMARY) degrades to `errors[]`
  // + a warning notify, exactly like (a)/(b) — it NEVER blocks the close.
  let suite: string | undefined;
  try {
    const alreadyJournaled = readEvents(cwd).some(
      (e) => e.kind === "suite_result" && e.milestone === milestoneId,
    );
    if (!alreadyJournaled) {
      const summaryPath = join(cwd, ".gsd", "milestones", milestoneId, `${milestoneId}-SUMMARY.md`);
      let map: Record<string, unknown> = {};
      if (existsSync(summaryPath)) {
        const raw = readFileSync(summaryPath, "utf-8");
        const [fmLines] = splitFrontmatter(raw);
        if (fmLines) map = parseFrontmatterMap(fmLines);
      }

      const command = typeof map.suite_command === "string" ? map.suite_command : undefined;
      const rawStatus = typeof map.suite_status === "string" ? map.suite_status : undefined;
      let status: SuiteStatus =
        rawStatus === "green" || rawStatus === "red" || rawStatus === "error" || rawStatus === "timeout"
          ? rawStatus
          : "skipped";
      const passed = toFiniteNumber(map.suite_passed);
      const failed = toFiniteNumber(map.suite_failed);
      // R1 (S06-REVIEW): the SUMMARY is model-authored and unvalidated — a
      // hallucinated `green` alongside a nonzero `suite_failed` must not be
      // journaled/displayed as clean. Per the completer contract (green ⇔ 0
      // failed, red ⇔ ≥1 failed), the parsed count is ground truth whenever
      // it's present; it overrides a contradictory self-reported label.
      if ((status === "green" || status === "red") && failed !== undefined) {
        status = failed === 0 ? "green" : "red";
      }

      const event: ForgeEvent = {
        ts: new Date().toISOString(),
        kind: "suite_result",
        unit: "complete-milestone",
        agent: "loop",
        milestone: milestoneId,
        status,
        summary: describeSuiteOutcome(status, command, passed, failed),
        ...(passed !== undefined ? { suite_passed: passed } : {}),
        ...(failed !== undefined ? { suite_failed: failed } : {}),
      };
      appendEvent(cwd, event);
      suite = status;

      if (status === "red") {
        notify(
          failed !== undefined ? `⚠ suíte: ${failed} reds` : "⚠ suíte: red sem contagem de falhas",
          "warning",
        );
      } else if (status === "error") {
        notify(`⚠ suíte: erro ao rodar a suíte${command ? ` (${command})` : ""}`, "warning");
      } else if (status === "timeout") {
        notify(`⚠ suíte: timeout ao rodar a suíte${command ? ` (${command})` : ""}`, "warning");
      } else if (status === "skipped") {
        notify("Suíte: completer não reportou resultado no SUMMARY.", "warning");
      }
      // green: no notify — the finale (T03) is what celebrates a clean suite.
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`suite: ${message}`);
    notify(`Recepção da suíte falhou (best-effort): ${message}`, "warning");
  }

  // (b) Apply the milestone-cleanup pref. `keep` (default) is a no-op; `archive`
  // moves the milestone dir under `.gsd/archive/<mid>`; `delete` removes it. Only
  // ever touches `.gsd/milestones/<mid>` — never STATE.md/LEDGER.md/DECISIONS.md.
  const cleanup = resolveMilestoneCleanup(cwd);
  if (cleanup !== "keep" && milestoneId) {
    const milestoneDir = join(cwd, ".gsd", "milestones", milestoneId);
    try {
      if (existsSync(milestoneDir)) {
        if (cleanup === "archive") {
          const archiveRoot = join(cwd, ".gsd", "archive");
          mkdirSync(archiveRoot, { recursive: true });
          const dest = join(archiveRoot, milestoneId);
          rmSync(dest, { recursive: true, force: true }); // idempotent re-archive
          renameSync(milestoneDir, dest);
        } else {
          rmSync(milestoneDir, { recursive: true, force: true });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`cleanup(${cleanup}): ${message}`);
      notify(`Cleanup do milestone (${cleanup}) falhou: ${message}`, "warning");
    }
  }

  return { rebuilt, cleanup, suite, errors };
}
