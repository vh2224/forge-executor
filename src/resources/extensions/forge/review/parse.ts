/**
 * Forge review — tolerant parsers for the challenger/advocate/rebuttal agent
 * outputs (the counterpart of `review/prompts.ts` — same task, T02). These
 * are the native replacement for the ad-hoc regex the forge 1.0
 * `## Engine workflow` script ran inline on the agent's structured JSON
 * result; here the agents answer in plain text (per `prompts.ts`), so this
 * module owns turning that text back into the `review/resolve.ts` (T01)
 * domain types.
 *
 * Source: the output-format contracts documented in `agents/forge-reviewer.md`
 * (§ Output format, § Rebuttal mode) and `agents/forge-advocate.md`
 * (§ Output format) of forge-agent 1.0 — reformatted here as line-oriented
 * parsing instead of prose reading, since an LLM read those formats but a
 * deterministic function must read this one.
 *
 * Design constraint (must-have): NEVER throw. Every malformed line becomes a
 * `warnings` entry and is skipped; the caller decides whether accumulated
 * warnings are worth surfacing. This mirrors `resolveReview`'s own
 * warning-not-throw posture (T01) — the whole review pipeline degrades
 * gracefully rather than aborting on a single bad line from a chatty agent.
 */

import type {
  ObjectionSeverity,
  ReviewObjection,
  ReviewVerdict,
} from "./resolve.js";

/** Result of {@link parseObjections}. */
export interface ParseObjectionsResult {
  /** True when the text was the literal `NO_FLAGS` marker (case-insensitive). */
  noFlags: boolean;
  objections: ReviewObjection[];
  warnings: string[];
}

/** Result of {@link parseVerdicts}. */
export interface ParseVerdictsResult<K extends string> {
  verdicts: ReviewVerdict<K>[];
  warnings: string[];
}

const SEVERITY_ENUM: ReadonlySet<ObjectionSeverity> = new Set([
  "critical",
  "high",
  "medium",
  "low",
]);

/** Maps the `### <bucket>` markdown headings emitted by the challenger prompt to severities. */
const HEADING_SEVERITY: Record<string, ObjectionSeverity> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  "low / nit": "low",
  nit: "low",
};

const NO_FLAGS_RE = /^no_flags$/i;
const HEADING_RE = /^#{1,4}\s*(.+?)\s*$/;
// `- R1 `path:line` [severity] — claim — suggested fix: ... — challenge: ...`
// the `[severity]` bracket is optional (the reference prompt relies on the
// section heading instead); tolerated here for robustness against agent
// drift (an agent inlining the severity anyway).
const OBJECTION_RE =
  /^-?\s*(R\d+)\s+`([^`]+)`(?:\s*\[([^\]]+)\])?\s*—\s*(.+)$/;

/**
 * Parse a challenger response (`agents/forge-reviewer.md § Output format`)
 * into structured objections. Tolerant: recognizes the literal `NO_FLAGS`
 * marker anywhere on its own line (case-insensitive), reads `### <bucket>`
 * headings to infer severity when no inline `[severity]` is present, and
 * degrades an out-of-enum severity to `medium` with a warning rather than
 * failing. Malformed `R#` lines become a warning and are skipped — this
 * function never throws.
 */
export function parseObjections(text: string): ParseObjectionsResult {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);

  for (const raw of lines) {
    if (NO_FLAGS_RE.test(raw.trim())) {
      return { noFlags: true, objections: [], warnings: [] };
    }
  }

  const objections: ReviewObjection[] = [];
  const seenIds = new Set<string>();
  let currentSeverity: ObjectionSeverity | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const key = headingMatch[1]!.toLowerCase();
      currentSeverity = HEADING_SEVERITY[key];
      continue;
    }

    const m = OBJECTION_RE.exec(line);
    if (!m) {
      // Prose noise around the structured lines is expected — only warn when
      // the line looks like it was trying to be an objection (starts with an
      // `R#` token) but didn't match the full shape.
      if (/^-?\s*R\d+\b/.test(line)) {
        warnings.push(`malformed objection line — skipped: "${line}"`);
      }
      continue;
    }

    const [, id, pathLine, bracketSeverity, rest] = m as unknown as [
      string,
      string,
      string,
      string | undefined,
      string,
    ];

    if (seenIds.has(id)) {
      warnings.push(`duplicate objection id ${id} — first occurrence kept`);
      continue;
    }

    const sfIdx = rest.search(/—\s*suggested fix:/i);
    const chIdx = rest.search(/—\s*challenge:/i);
    if (sfIdx === -1 || chIdx === -1 || chIdx < sfIdx) {
      warnings.push(`malformed objection body for ${id} — skipped: "${line}"`);
      continue;
    }

    const claim = rest.slice(0, sfIdx).trim();
    const suggestedFix = rest
      .slice(sfIdx, chIdx)
      .replace(/^—\s*suggested fix:\s*/i, "")
      .trim();
    const challenge = rest
      .slice(chIdx)
      .replace(/^—\s*challenge:\s*/i, "")
      .trim();

    let severity: ObjectionSeverity | undefined =
      bracketSeverity?.toLowerCase() as ObjectionSeverity | undefined;
    if (severity && !SEVERITY_ENUM.has(severity)) {
      warnings.push(
        `severity "${bracketSeverity}" for ${id} outside enum — degraded to medium`,
      );
      severity = "medium";
    }
    if (!severity) {
      severity = currentSeverity;
    }
    if (!severity) {
      warnings.push(`no severity resolvable for ${id} — degraded to medium`);
      severity = "medium";
    }

    seenIds.add(id);
    objections.push({ id, pathLine, severity, claim, suggestedFix, challenge });
  }

  return { noFlags: false, objections, warnings };
}

// `- R1: refuted — rationale text` (also tolerates no leading `- `).
const VERDICT_RE = /^-?\s*(R\d+):\s*(\S+)\s*—\s*(.*)$/;

/**
 * Parse an advocate defense (`agents/forge-advocate.md § Output format`) or
 * a reviewer rebuttal (`agents/forge-reviewer.md § Rebuttal mode`) response
 * into `R# -> verdict` pairs. `allowed` narrows the verdict vocabulary for
 * the phase (`['refuted','conceded','open']` for a defense,
 * `['maintained','withdrawn','conceded']` for a rebuttal — see
 * `AdvocateVerdictKind`/`RebuttalVerdictKind` in `review/resolve.ts`). A
 * verdict outside `allowed` becomes a warning and the entry is discarded —
 * `resolveReview`'s own open/maintained defaults (T01) cover the resulting
 * gap. Never throws.
 */
export function parseVerdicts<K extends string>(
  text: string,
  allowed: readonly K[],
): ParseVerdictsResult<K> {
  const warnings: string[] = [];
  const verdicts: ReviewVerdict<K>[] = [];
  const seenIds = new Set<string>();
  const allowedSet = new Set<string>(allowed);

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const m = VERDICT_RE.exec(line);
    if (!m) {
      if (/^-?\s*R\d+\b/.test(line)) {
        warnings.push(`malformed verdict line — skipped: "${line}"`);
      }
      continue;
    }

    const [, id, verdictRaw, rationaleRaw] = m;
    // Strip trailing edge punctuation the agent may append to the verdict token
    // (`R2: conceded.` / `open,` / `refuted;`) before the enum check — without
    // it, a stray full stop silently discards a genuine verdict and lets
    // `resolveReview` default a CONCEDED objection down to open (C2/S05).
    const verdict = verdictRaw!.replace(/[.,;:]+$/, "").toLowerCase();
    const rationale = (rationaleRaw ?? "").trim();

    if (!allowedSet.has(verdict)) {
      warnings.push(
        `verdict "${verdictRaw}" for ${id} outside allowed set [${allowed.join(", ")}] — discarded`,
      );
      continue;
    }

    if (seenIds.has(id!)) {
      warnings.push(`duplicate verdict for ${id} — first occurrence kept`);
      continue;
    }

    seenIds.add(id!);
    verdicts.push({ id: id!, verdict: verdict as K, rationale });
  }

  return { verdicts, warnings };
}
