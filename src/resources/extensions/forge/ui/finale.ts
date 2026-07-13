/**
 * Milestone finale — the celebratory close-out banner `/forge auto` prints
 * when a milestone reaches `complete` (operator request, 2026-07-11: "podia
 * aparecer um final de milestone dahora, só está encerrando").
 *
 * Pure read-side rendering: snapshot (slices/tasks/title) + journal
 * (duration, retries, G1 authorship per model, advisory suite result) +
 * review triage digest (S04: pending `### R#` items across every slice, via
 * `ui/review-digest.ts`).
 * Never throws — a finale must never break a completed run, so every input
 * degrades to an omitted line. The digest block and the suite line (S06) are
 * additive-only: with zero pending items / no `suite_result` event they push
 * nothing, keeping the pre-S04/pre-S06 output byte-identical.
 */

import { readSnapshot } from "../auto/snapshot.js";
import { readEvents } from "../state/store.js";
import { sliceComplete } from "../state/index.js";
import { formatReviewDigest } from "./review-digest.js";

const RULE = "─".repeat(56);

/** `9h04m` / `37m12s` / `52s` from a millisecond span. */
function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatMilestoneFinale(cwd: string, milestoneId: string): string {
  const lines: string[] = [RULE, " 🏁  MILESTONE COMPLETO", ` ${milestoneId}`];

  try {
    const snap = readSnapshot(cwd);
    const rawTitle = snap.titles.milestone ?? "";
    const title = rawTitle.startsWith(milestoneId)
      ? rawTitle.slice(milestoneId.length).replace(/^[\s—·:-]+/, "")
      : rawTitle;
    if (title && title !== "ROADMAP") lines.push(` ${title}`);

    const doneSlices = snap.roadmap.filter((sl) => sliceComplete(sl, snap.state)).length;
    const tasks = Object.values(snap.plans).reduce((n, p) => n + p.tasks.length, 0);
    if (snap.roadmap.length > 0) {
      lines.push("", ` ✓ ${doneSlices}/${snap.roadmap.length} slices · ${tasks} tasks`);
    }

    // "O que foi construído" — the family-friendly overview (operator request
    // 2026-07-12: "quando você encerra algo você avisa, dá um overview do que
    // foi feito — gostaria dessa parte lá; só acabou assim"). One line per
    // slice, name truncated to keep the banner shape; per-slice task count
    // from the plan when known.
    if (snap.roadmap.length > 0) {
      lines.push("");
      for (const sl of snap.roadmap) {
        const done = sliceComplete(sl, snap.state);
        const nTasks = snap.plans[sl.id]?.tasks.length;
        const name = sl.name.length > 46 ? sl.name.slice(0, 45) + "…" : sl.name;
        lines.push(` ${done ? "✓" : "✗"} ${sl.id}  ${name}${nTasks ? ` · ${nTasks} tasks` : ""}`);
      }
    }
  } catch {
    /* snapshot unreadable — counts omitted */
  }

  try {
    const events = readEvents(cwd).filter((e) => e.milestone === milestoneId);
    const results = events.filter((e) => e.kind === "unit_result" && e.status === "done");
    const retries = events.filter((e) => e.kind === "unit_retry").length;
    const first = events[0]?.ts;
    const last = events[events.length - 1]?.ts;
    const span = first && last ? formatSpan(Date.parse(last) - Date.parse(first)) : "";

    const statsParts: string[] = [];
    if (results.length > 0) statsParts.push(`${results.length} unidades concluídas`);
    if (span) statsParts.push(span);
    if (retries > 0) statsParts.push(`${retries} ${retries === 1 ? "retry" : "retries"}`);
    if (statsParts.length > 0) lines.push(` ⏱ ${statsParts.join(" · ")}`);

    // G1 authorship (D15): which model actually executed each unit.
    const byModel = new Map<string, number>();
    for (const e of results) {
      const who = e.model ?? e.provider;
      if (who) byModel.set(who, (byModel.get(who) ?? 0) + 1);
    }
    if (byModel.size > 0) {
      const parts = [...byModel.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([who, n]) => `${who} ×${n}`);
      lines.push(` 🤖 ${parts.join(" · ")}`);
    }

    // Suite line (S06): advisory `suite_result` from the completer, read from
    // the journal — never the SUMMARY, since cleanup may have moved/deleted
    // the milestone dir by render time (D-S06v2-1). Additive: no event → no
    // line, keeping the pre-S06 finale byte-identical. Last event wins.
    const suiteEvents = events.filter((e) => e.kind === "suite_result");
    const suiteEvent = suiteEvents[suiteEvents.length - 1];
    if (suiteEvent) {
      if (suiteEvent.status === "red") {
        if (typeof suiteEvent.suite_failed === "number") {
          const passedPart =
            typeof suiteEvent.suite_passed === "number" ? ` (${suiteEvent.suite_passed} passed)` : "";
          const n = suiteEvent.suite_failed;
          lines.push(` ⚠ suíte: ${n} ${n === 1 ? "red" : "reds"}${passedPart}`);
        } else {
          lines.push(` ⚠ suíte: ${suiteEvent.summary}`);
        }
      } else if (suiteEvent.status === "green") {
        const passedPart = typeof suiteEvent.suite_passed === "number" ? ` · ${suiteEvent.suite_passed} passed` : "";
        lines.push(` ✓ suíte verde${passedPart}`);
      } else {
        lines.push(` ⚠ suíte: não executada (${suiteEvent.status})`);
      }
    }
  } catch {
    /* journal unreadable — stats omitted */
  }

  // Review triage digest (S04): read-side only, degrades to nothing when
  // there is no pending item or the collector can't read the milestone —
  // this is what keeps the "zero pendências → byte-identical" contract from
  // S04-PLAN honest even though formatReviewDigest already never throws.
  // `formatReviewDigest` returns lines WITHOUT banner indentation by design
  // (it's shared with `/forge status`, which indents differently) — the
  // finale applies its own single-space banner prefix here, per-line.
  try {
    const digest = formatReviewDigest(cwd, milestoneId);
    if (digest.length > 0) {
      lines.push("", ...digest.map((line) => ` ${line}`));
    }
  } catch {
    /* digest unreadable — omitted, finale still renders */
  }

  lines.push("", " 📒 LEDGER.md atualizado · /forge status para o panorama", RULE);
  return lines.join("\n");
}
