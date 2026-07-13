/**
 * Forge plan-checker — deterministic structural scorer for a slice plan.
 *
 * Native in-process port of the 1.0 advisory agent
 * `forge-agent/agents/forge-plan-checker.md` (10 LOCKED dimensions, Step 3 rubrics,
 * plus enforcement dimensions `through_the_driver` and `scope_drop`, and the
 * conditional `frontmatter_compliance` dimension, S01).
 * Rewritten from the 1.0 skill markdown into the forge namespace — this repo has
 * NO gsd/ import (the condemned tree is never referenced).
 *
 * Design decisions (S04-PLAN):
 *   D-S04-1 — STRICTLY advisory. `checkPlan` is a pure read+score function; it
 *     NEVER mutates STATE/PLAN, NEVER blocks the loop, NEVER re-dispatches. The
 *     only side-effect in this module is `writePlanCheck` (the artefact writer).
 *     The 1.0 `blocking` mode is inert / not ported.
 *   D-S04-2 — the `must_haves_wellformed` dimension runs the must-haves check
 *     itself, in-process, by importing `parseMustHaves`/`hasStructuredMustHaves`
 *     from `../state/must-haves.js`. No shell-out to `forge-must-haves.js`, no
 *     `MUST_HAVES_CHECK_RESULTS` injection.
 *
 * C13 — legacy tasks (no structured `must_haves:` block) are ALWAYS `warn` on
 * both `must_haves_wellformed` and `legacy_schema_detect`, NEVER `fail`. This
 * does NOT extend to `frontmatter_compliance` (S01): legacy tasks are still
 * scored for domain/effort presence — C13 protects the must_haves schema,
 * not frontmatter routing compliance.
 *
 * Exports:
 *   checkPlan(cwd, milestoneId, sliceId) → PlanCheckResult   (pure)
 *   writePlanCheck(cwd, milestoneId, sliceId, result) → string  (writes artefact)
 *   scoreFrontmatterCompliance(tasks) → DimensionScore   (S02/T03: reused by
 *     `/forge task`'s single-task advisory check, via a minimal adapter)
 *   types: Verdict, DimensionScore, PlanCheckResult
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatter, parseFrontmatterMap } from "../../shared/frontmatter.js";
import { hasStructuredMustHaves, parseMustHaves } from "../state/must-haves.js";
import { writeFileAtomic } from "../state/ledger.js";
import { EFFORT_LEVELS } from "../auto/effort.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Verdict = "pass" | "warn" | "fail";

export interface DimensionScore {
  name: string;
  verdict: Verdict;
  justification: string;
}

export interface PlanCheckResult {
  status: "done" | "blocked";
  dimensions: DimensionScore[];
  counts: { pass: number; warn: number; fail: number };
  blocker_class?: string;
  blocker?: string;
}

/**
 * The 13 LOCKED dimension names, in order. The first 10 are the exact 1.0
 * order; enforcement dimensions are appended at the end to minimize churn on
 * existing dimension indices/justifications.
 *
 * `frontmatter_compliance` (13th, S01) is a LOCKED name but a CONDITIONAL
 * member of `checkPlan`'s `result.dimensions`: it is only pushed when the
 * milestone/slice CONTEXT requires `domain:`/`effort:` frontmatter
 * (`detectFrontmatterRequirement`). A milestone with no such requirement gets
 * a byte-identical 12-dimension result — see `checkPlan`/`writePlanCheck`.
 */
export const DIMENSION_NAMES = [
  "completeness",
  "must_haves_wellformed",
  "ordering",
  "dependencies",
  "risk_coverage",
  "acceptance_observable",
  "scope_alignment",
  "decisions_honored",
  "expected_output_realistic",
  "legacy_schema_detect",
  "through_the_driver",
  "scope_drop",
  "frontmatter_compliance",
] as const;

// ── Internal model ────────────────────────────────────────────────────────────

interface TaskPlan {
  id: string; // e.g. "T01"
  planPath: string;
  exists: boolean;
  content: string;
  frontmatter: Record<string, unknown>;
  depends: string[];
  expectedOutput: string[];
  goalNonEmpty: boolean;
  isLegacy: boolean;
  mustHavesValid: boolean;
  mustHavesErrors: string[];
  truths: string[];
  bodyText: string; // full content lowercased for keyword scans
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function normCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/");
}

function sliceDir(cwd: string, mid: string, sid: string): string {
  return join(normCwd(cwd), ".gsd", "milestones", mid, "slices", sid);
}

function milestoneDir(cwd: string, mid: string): string {
  return join(normCwd(cwd), ".gsd", "milestones", mid);
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// ── Section / frontmatter extraction ──────────────────────────────────────────

/** Extract the body of a `## Heading` section (until the next `## ` or `# ` heading). */
function extractSection(content: string, heading: string): string | null {
  const lines = content.split("\n");
  const re = new RegExp(`^#{1,3}\\s+${heading}\\b`, "i");
  let capturing = false;
  const out: string[] = [];
  for (const line of lines) {
    if (!capturing) {
      if (re.test(line)) capturing = true;
      continue;
    }
    if (/^#{1,3}\s+\S/.test(line)) break;
    out.push(line);
  }
  if (!capturing) return null;
  return out.join("\n");
}

function taskFrontmatter(content: string): Record<string, unknown> {
  const [fm] = splitFrontmatter(content);
  if (!fm) return {};
  return parseFrontmatterMap(fm);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** Extract the declared task IDs, in declared order, from S##-PLAN `## Tasks`. */
function declaredTaskIds(planContent: string): string[] {
  const section = extractSection(planContent, "Tasks") ?? "";
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /\bT(\d{2,})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const id = `T${m[1]}`;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// ── Task-plan discovery ───────────────────────────────────────────────────────

/** Discover task plans under `tasks/<T##>/<T##>-PLAN.md` (readdir-based, no glob dep). */
function discoverTaskPlans(cwd: string, mid: string, sid: string): TaskPlan[] {
  const tasksDir = join(sliceDir(cwd, mid, sid), "tasks");
  if (!existsSync(tasksDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return [];
  }
  const plans: TaskPlan[] = [];
  for (const entry of entries.sort()) {
    if (!/^T\d+$/.test(entry)) continue;
    const planPath = join(tasksDir, entry, `${entry}-PLAN.md`);
    plans.push(loadTaskPlan(entry, planPath));
  }
  return plans;
}

function loadTaskPlan(id: string, planPath: string): TaskPlan {
  const exists = existsSync(planPath);
  const content = exists ? readIfExists(planPath) ?? "" : "";
  const frontmatter = content ? taskFrontmatter(content) : {};
  const depends = asStringArray(frontmatter.depends);
  const expectedOutput = asStringArray(frontmatter.expected_output);
  const goalSection = content ? extractSection(content, "Goal") : null;
  const goalNonEmpty = !!goalSection && goalSection.trim().length > 0;

  let isLegacy = true;
  let mustHavesValid = true;
  let mustHavesErrors: string[] = [];
  let truths: string[] = [];

  if (content) {
    if (hasStructuredMustHaves(content)) {
      isLegacy = false;
      try {
        const mh = parseMustHaves(content);
        truths = mh.truths;
        mustHavesValid = true;
      } catch (err) {
        mustHavesValid = false;
        mustHavesErrors = [err instanceof Error ? err.message : String(err)];
      }
    } else {
      isLegacy = true;
    }
  } else {
    // Missing plan file: not legacy, not valid — surfaces in must_haves + completeness.
    isLegacy = false;
    mustHavesValid = false;
    mustHavesErrors = ["plan file not found"];
  }

  return {
    id,
    planPath,
    exists,
    content,
    frontmatter,
    depends,
    expectedOutput,
    goalNonEmpty,
    isLegacy,
    mustHavesValid,
    mustHavesErrors,
    truths,
    bodyText: content.toLowerCase(),
  };
}

// ── Optional-input model ──────────────────────────────────────────────────────

interface OptionalInputs {
  mContext: string | null;
  sContext: string | null;
  risk: string | null;
  scope: string | null;
}

function readOptionalInputs(cwd: string, mid: string, sid: string): OptionalInputs {
  return {
    mContext: readIfExists(join(milestoneDir(cwd, mid), `${mid}-CONTEXT.md`)),
    sContext: readIfExists(join(sliceDir(cwd, mid, sid), `${sid}-CONTEXT.md`)),
    risk: readIfExists(join(sliceDir(cwd, mid, sid), `${sid}-RISK.md`)),
    scope: readIfExists(join(milestoneDir(cwd, mid), `${mid}-SCOPE.md`)),
  };
}

// ── Scoring utility ───────────────────────────────────────────────────────────

/** Map a bad-item count to a verdict (0→pass, 1→warn, ≥2→fail). */
function countToVerdict(bad: number): Verdict {
  if (bad <= 0) return "pass";
  if (bad === 1) return "warn";
  return "fail";
}

const NON_WORD = /[^a-z0-9]+/g;

function significantTokens(line: string): string[] {
  return line
    .toLowerCase()
    .replace(NON_WORD, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5);
}

/** Bullet lines from a section body (leading `-`/`*` list items). */
function bulletLines(section: string): string[] {
  return section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ""));
}

// ── Dimension scorers ─────────────────────────────────────────────────────────

function scoreCompleteness(planContent: string, declared: string[], tasks: TaskPlan[]): DimensionScore {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const gaps: string[] = [];
  const idsToCheck = declared.length > 0 ? declared : tasks.map((t) => t.id);
  for (const id of idsToCheck) {
    const t = byId.get(id);
    if (!t || !t.exists) {
      gaps.push(`${id} (no plan file)`);
    } else if (!t.goalNonEmpty) {
      gaps.push(`${id} (empty ## Goal)`);
    }
  }
  if (idsToCheck.length === 0) {
    return {
      name: "completeness",
      verdict: "fail",
      justification: "No task plan files found and no tasks declared in S##-PLAN § Tasks.",
    };
  }
  const verdict = countToVerdict(gaps.length);
  const justification =
    gaps.length === 0
      ? `All ${idsToCheck.length} declared task(s) have a plan file with a non-empty ## Goal.`
      : `Completeness gap(s): ${gaps.join(", ")}.`;
  return { name: "completeness", verdict, justification };
}

function scoreMustHaves(tasks: TaskPlan[]): DimensionScore {
  const invalid = tasks.filter((t) => !t.isLegacy && !t.mustHavesValid);
  const legacy = tasks.filter((t) => t.isLegacy);
  if (invalid.length > 0) {
    return {
      name: "must_haves_wellformed",
      verdict: "fail",
      justification: `Malformed must_haves in ${invalid.map((t) => t.id).join(", ")}: ${invalid[0].mustHavesErrors[0] ?? "invalid"}.`,
    };
  }
  if (legacy.length > 0) {
    return {
      name: "must_haves_wellformed",
      verdict: "warn",
      justification: `Legacy free-text task(s) ${legacy.map((t) => t.id).join(", ")} present; all structured tasks valid (C13 → warn, never fail).`,
    };
  }
  return {
    name: "must_haves_wellformed",
    verdict: "pass",
    justification: `All ${tasks.length} task(s) carry a valid structured must_haves block.`,
  };
}

function scoreOrdering(declared: string[], tasks: TaskPlan[]): DimensionScore {
  if (declared.length === 0) {
    return {
      name: "ordering",
      verdict: "warn",
      justification: "Declared execution order not found in S##-PLAN § Tasks; ordering not verifiable.",
    };
  }
  const pos = new Map(declared.map((id, i) => [id, i]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const backEdges: string[] = [];
  for (const id of declared) {
    const t = byId.get(id);
    if (!t) continue;
    for (const dep of t.depends) {
      const depId = dep.includes("/") ? dep.split("/").pop()! : dep;
      if (!pos.has(depId)) continue; // cross-slice / unresolved → dependencies dim
      if (pos.get(depId)! >= pos.get(id)!) {
        backEdges.push(`${id} depends on ${depId} but is ordered before it`);
      }
    }
  }
  if (backEdges.length > 0) {
    return { name: "ordering", verdict: "fail", justification: `Back-dependency: ${backEdges.join("; ")}.` };
  }
  return {
    name: "ordering",
    verdict: "pass",
    justification: "Declared task order respects all in-slice depends: relationships.",
  };
}

function scoreDependencies(declared: string[], tasks: TaskPlan[]): DimensionScore {
  const known = new Set(declared.length > 0 ? declared : tasks.map((t) => t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const unresolved: string[] = [];
  for (const t of tasks) {
    for (const dep of t.depends) {
      if (dep.includes("/")) continue; // annotated cross-slice — treated as resolved
      if (!known.has(dep) || !(byId.get(dep)?.exists ?? false)) {
        unresolved.push(`${t.id} → ${dep}`);
      }
    }
  }
  const verdict = countToVerdict(unresolved.length);
  const justification =
    unresolved.length === 0
      ? "Every depends: entry resolves to an existing in-slice task."
      : `Unresolved depends: ${unresolved.join(", ")}.`;
  return { name: "dependencies", verdict, justification };
}

function scoreRiskCoverage(risk: string | null, tasks: TaskPlan[]): DimensionScore {
  if (!risk) {
    return {
      name: "risk_coverage",
      verdict: "pass",
      justification: "S##-RISK.md not present — dimension not applicable.",
    };
  }
  const risks = bulletLines(risk).filter((l) => l.length > 0);
  const corpus = tasks.map((t) => t.bodyText).join("\n");
  const uncovered: string[] = [];
  for (const r of risks) {
    const tokens = significantTokens(r);
    if (tokens.length === 0) continue;
    const covered = tokens.some((tok) => corpus.includes(tok));
    if (!covered) uncovered.push(r.slice(0, 40));
  }
  const verdict = countToVerdict(uncovered.length);
  const justification =
    risks.length === 0
      ? "S##-RISK.md present but lists no risk bullets."
      : uncovered.length === 0
        ? `All ${risks.length} risk(s) have a matching mitigation keyword in some T##-PLAN.`
        : `Risk(s) without mitigation: ${uncovered.join("; ")}.`;
  return { name: "risk_coverage", verdict, justification };
}

const OBSERVABLE_VERBS =
  /^(run|open|grep|inspect|check|navigate|execute|verify|confirm|read|assert|build|import|call|score|write)\b/i;

function scoreAcceptanceObservable(planContent: string): DimensionScore {
  const section = extractSection(planContent, "Acceptance Criteria");
  if (section === null) {
    return {
      name: "acceptance_observable",
      verdict: "pass",
      justification: "No § Acceptance Criteria section — dimension not applicable.",
    };
  }
  const criteria = bulletLines(section);
  const ambiguous = criteria.filter((c) => {
    if (OBSERVABLE_VERBS.test(c)) return false;
    // observable if it embeds a path, exit code, regex anchor, or CLI/code snippet
    if (/[\x60/]|exit\s*code|\d+\.\w|\^|\$|--\w|\bnpm\b|\bnode\b|\bpnpm\b/i.test(c)) return false;
    return true;
  });
  const verdict = countToVerdict(ambiguous.length);
  const justification =
    criteria.length === 0
      ? "§ Acceptance Criteria present but empty."
      : ambiguous.length === 0
        ? `All ${criteria.length} acceptance criteria are phrased as observable outcomes.`
        : `Ambiguous criteria: ${ambiguous.map((c) => c.slice(0, 30)).join("; ")}.`;
  return { name: "acceptance_observable", verdict, justification };
}

/** Extract forbidden/out-of-scope tokens from Out-of-Scope / Deferral sections. */
function outOfScopeTokens(planContent: string): string[] {
  const tokens: string[] = [];
  for (const heading of ["Out of Scope", "Fora de escopo", "Deferrals", "Deferrals explícitos", "Deferrals explicitos"]) {
    const section = extractSection(planContent, heading);
    if (!section) continue;
    for (const b of bulletLines(section)) {
      // leading bold token, or first significant word
      const bold = b.match(/\*\*(.+?)\*\*/);
      if (bold) {
        tokens.push(...significantTokens(bold[1]));
      } else {
        tokens.push(...significantTokens(b).slice(0, 2));
      }
    }
  }
  return [...new Set(tokens)];
}

function scoreScopeAlignment(planContent: string, tasks: TaskPlan[]): DimensionScore {
  const forbidden = outOfScopeTokens(planContent);
  if (forbidden.length === 0) {
    return {
      name: "scope_alignment",
      verdict: "pass",
      justification: "No § Out of Scope terms declared; no scope violations detectable.",
    };
  }
  const violations: string[] = [];
  for (const t of tasks) {
    const hay = (t.truths.join(" ") + " " + (extractSection(t.content, "Goal") ?? "")).toLowerCase();
    for (const tok of forbidden) {
      if (hay.includes(tok)) {
        violations.push(`${t.id} references out-of-scope "${tok}"`);
        break;
      }
    }
  }
  const verdict = countToVerdict(violations.length);
  const justification =
    violations.length === 0
      ? "No task Goal/truths reference an out-of-scope capability."
      : `Scope violation(s): ${violations.join("; ")}.`;
  return { name: "scope_alignment", verdict, justification };
}

/** Extract prohibition tokens ("NUNCA X" / "never X" / "sem X") from decision text. */
function prohibitionTokens(text: string): string[] {
  const tokens: string[] = [];
  const re = /\b(?:nunca|never|sem|proibido|must not|não deve|nao deve)\s+([A-Za-zÀ-ÿ][\w-]{3,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[1].toLowerCase());
  }
  return [...new Set(tokens)];
}

function scoreDecisionsHonored(inputs: OptionalInputs, tasks: TaskPlan[]): DimensionScore {
  const decisionText = [
    inputs.mContext ? extractSection(inputs.mContext, "Implementation Decisions") : null,
    inputs.sContext ? extractSection(inputs.sContext, "Decisions") : null,
  ]
    .filter((s): s is string => !!s)
    .join("\n");
  if (!decisionText.trim()) {
    return {
      name: "decisions_honored",
      verdict: "pass",
      justification: "No CONTEXT decisions file — dimension not applicable.",
    };
  }
  const forbidden = prohibitionTokens(decisionText);
  if (forbidden.length === 0) {
    return {
      name: "decisions_honored",
      verdict: "pass",
      justification: "No prohibition-style decisions detected to contradict.",
    };
  }
  const contradictions: string[] = [];
  for (const t of tasks) {
    const steps = ((extractSection(t.content, "Steps") ?? "") + (extractSection(t.content, "Standards") ?? "")).toLowerCase();
    for (const tok of forbidden) {
      if (steps.includes(tok)) {
        contradictions.push(`${t.id} uses "${tok}" which a decision prohibits`);
        break;
      }
    }
  }
  const verdict = countToVerdict(contradictions.length);
  const justification =
    contradictions.length === 0
      ? "No task step contradicts a locked decision."
      : `Decision contradiction(s): ${contradictions.join("; ")}.`;
  return { name: "decisions_honored", verdict, justification };
}

function scoreExpectedOutput(tasks: TaskPlan[]): DimensionScore {
  const seen = new Map<string, string>();
  const suspicious: string[] = [];
  let duplicate = false;
  for (const t of tasks) {
    for (const p of t.expectedOutput) {
      if (p.startsWith("/")) suspicious.push(`${p} (absolute)`);
      else if (p.includes("\\")) suspicious.push(`${p} (backslash)`);
      if (seen.has(p)) duplicate = true;
      else seen.set(p, t.id);
    }
  }
  let verdict: Verdict;
  let justification: string;
  if (duplicate) {
    verdict = "fail";
    justification = `Duplicate expected_output path across tasks${suspicious.length ? "; " + suspicious.join(", ") : ""}.`;
  } else {
    verdict = countToVerdict(suspicious.length);
    justification =
      suspicious.length === 0
        ? `Union of ${seen.size} expected_output path(s) is clean (no dup/absolute/backslash).`
        : `Suspicious path(s): ${suspicious.join(", ")}.`;
  }
  return { name: "expected_output_realistic", verdict, justification };
}

function scoreLegacyDetect(tasks: TaskPlan[]): DimensionScore {
  const legacy = tasks.filter((t) => t.isLegacy).map((t) => t.id);
  if (legacy.length === 0) {
    return {
      name: "legacy_schema_detect",
      verdict: "pass",
      justification: "All tasks use the structured must_haves schema.",
    };
  }
  // C13: legacy detection is warn at worst, NEVER fail.
  return {
    name: "legacy_schema_detect",
    verdict: "warn",
    justification: `Legacy free-text must_haves in ${legacy.join(", ")} (C13 → warn, never fail).`,
  };
}

/**
 * Keywords that indicate a task truth/step is claiming production
 * dispatch behavior (S08 — "claim de comportamento de produção exige teste
 * through-the-driver").
 */
const DISPATCH_CLAIM_KEYWORDS = [
  "dispatch",
  "unit_dispatched",
  "unit_result",
  "production",
  "real driver",
  "através do dispatch",
  "through the driver",
];

/** Referents proving a claim is backed by a through-the-driver test. */
const THROUGH_THE_DRIVER_REFERENT_RE = /dispatchunitvianewsession|runforgeloop|-e2e\.test/;

/**
 * S08 — each task claiming production-dispatch behavior must be backed by a
 * through-the-driver referent in its own plan or in a declared dependency.
 *
 * This is intentionally not a slice-global search: M5-REVIEW-GPT56 found that
 * an unrelated sibling's e2e mention could accidentally clear another task's
 * claim. The dimension remains advisory (D-S04-1); only its precision changes.
 */
function scoreThroughTheDriver(tasks: TaskPlan[]): DimensionScore {
  const claiming = tasks.filter((t) => {
    const hay = (t.truths.join(" ") + " " + t.bodyText).toLowerCase();
    return DISPATCH_CLAIM_KEYWORDS.some((kw) => hay.includes(kw));
  });
  if (claiming.length === 0) {
    return {
      name: "through_the_driver",
      verdict: "pass",
      justification: "No production-dispatch behavior claim — dimension not applicable.",
    };
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const hasReferent = (task: TaskPlan): boolean => {
    const ownText = `${task.bodyText} ${task.expectedOutput.join(" ").toLowerCase()}`;
    if (THROUGH_THE_DRIVER_REFERENT_RE.test(ownText)) return true;
    return task.depends.some((dependency) => {
      const depId = dependency.includes("/") ? dependency.split("/").pop()! : dependency;
      const depTask = byId.get(depId);
      if (!depTask) return false;
      const depText = `${depTask.bodyText} ${depTask.expectedOutput.join(" ").toLowerCase()}`;
      return THROUGH_THE_DRIVER_REFERENT_RE.test(depText);
    });
  };
  const unbacked = claiming.filter((task) => !hasReferent(task));
  if (unbacked.length === 0) {
    return {
      name: "through_the_driver",
      verdict: "pass",
      justification: `Production-dispatch claim(s) in ${claiming.map((t) => t.id).join(", ")} backed by a co-located or depended-on through-the-driver referent.`,
    };
  }
  const verdict = countToVerdict(unbacked.length);
  return {
    name: "through_the_driver",
    verdict,
    justification: `Production-dispatch claim without a co-located or depended-on through-the-driver referent: ${unbacked.map((t) => t.id).join(", ")}.`,
  };
}

interface ContextAddendum {
  targetSlice: string | null;
  subjectTokens: string[];
  raw: string;
}

const ADDENDUM_HEADING_RE = /(?:achado\s+durante\s+a\s+execu(?:ção|cao)|finding\s+during\s+execution|adendo|addendum)/i;
const ADDENDUM_MARKER_RE = /achado|durante|execu(?:ção|cao)|finding|during|execution|adendo|addendum/gi;

/** Parse marked execution findings while retaining the slice they address. */
export function extractContextAddenda(contextText: string): ContextAddendum[] {
  const lines = contextText.split("\n");
  const addenda: ContextAddendum[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,3}\s+/.test(lines[i]) || !ADDENDUM_HEADING_RE.test(lines[i])) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^#{1,3}\s+/.test(lines[j]); j++) body.push(lines[j]);
    const raw = [lines[i], ...body].join("\n");
    const slice = raw.match(/\bS\d{2}\b/i)?.[0]?.toUpperCase() ?? null;
    const firstSentence = body.join(" ").split(/[.!?](?:\s|$)/, 1)[0] ?? "";
    const cleanedHeading = lines[i].replace(ADDENDUM_MARKER_RE, " ");
    const subjectTokens = [...new Set(
      significantTokens(`${cleanedHeading} ${firstSentence}`)
        .filter((token) => !/^s\d{2}$/.test(token) && !/^\d{4,}$/.test(token)),
    )];
    addenda.push({ targetSlice: slice, subjectTokens, raw });
    i += body.length;
  }
  return addenda;
}

/**
 * Detect dropped, marked CONTEXT findings. One uncovered finding is a hard
 * dimension failure: a single silently dropped fix is the incident this gate
 * exists to prevent. This remains advisory at the checkPlan level (D-S04-1).
 */
function scoreScopeDrop(
  sid: string,
  inputs: OptionalInputs,
  planContent: string,
  tasks: TaskPlan[],
): DimensionScore {
  const addenda = [inputs.mContext, inputs.sContext]
    .filter((text): text is string => text !== null)
    .flatMap(extractContextAddenda)
    .filter((addendum) => addendum.targetSlice === null || addendum.targetSlice === sid);
  if (addenda.length === 0) {
    return { name: "scope_drop", verdict: "pass", justification: "No marked CONTEXT addendum addressed to this slice." };
  }

  const taskCorpus = tasks.map((task) => {
    const goal = extractSection(task.content, "Goal") ?? "";
    return significantTokens(`${goal} ${task.truths.join(" ")}`);
  });
  const deferralCorpus = ["Notes", "Deferrals", "Out of Scope", "Fora de escopo"]
    .flatMap((heading) => {
      const section = extractSection(planContent, heading);
      return section ? bulletLines(section).flatMap(significantTokens) : [];
    });
  const drops = addenda.filter((addendum) => {
    const covered = addendum.subjectTokens.length > 0 && addendum.subjectTokens.every((token) =>
      taskCorpus.some((tokens) => tokens.includes(token)) || deferralCorpus.includes(token),
    );
    return !covered;
  });
  return drops.length > 0
    ? { name: "scope_drop", verdict: "fail", justification: `${drops.length} marked CONTEXT addendum(s) lack task coverage or declared deferral.` }
    : { name: "scope_drop", verdict: "pass", justification: `All ${addenda.length} marked CONTEXT addendum(s) have task coverage or declared deferral.` };
}

/**
 * Line-scoped, case-insensitive match for a bancada clause: an obligation
 * word (deve, must, exige-family, require(s)) followed — within a short
 * window — by `domain`, then — within a shorter window — by `effort`. The
 * window is unrestricted-character (`[\s\S]`) rather than a fixed
 * backtick-colon-slash charset because the real calibration text separates
 * the two terms with ordinary prose (e.g. "domain:`/`effort:`" or
 * "domain:` e `effort:`").
 */
const FRONTMATTER_REQUIREMENT_RE =
  /\b(?:deve|must|exige\w*|requires?)\b[\s\S]{0,80}?\bdomain\b[\s\S]{0,40}?\beffort\b/i;

/**
 * Detects whether a CONTEXT text (milestone or slice) declares the bancada
 * requirement that every T##-PLAN emit `domain:`/`effort:` frontmatter.
 * Scanned line-by-line (a real clause spanning this milestone's own
 * `M###-CONTEXT.md` recurs, whole, on at least one single line — see
 * `plan-checker.test.ts`'s direct unit test against the real file).
 */
export function detectFrontmatterRequirement(text: string): boolean {
  return text.split("\n").some((line) => FRONTMATTER_REQUIREMENT_RE.test(line));
}

/**
 * S01 — frontmatter compliance: a task is non-conforming if `domain:` is
 * absent/empty after trim, OR `effort:` is absent/outside `EFFORT_LEVELS`
 * (imported from `auto/effort.ts`, the single source of the effort
 * vocabulary). `domain:` vocabulary is intentionally open (D-S03-4) — only
 * presence/non-emptiness is checked, never a fixed domain list. Legacy tasks
 * are NOT exempt (C13 protects the must_haves schema, not frontmatter
 * routing compliance).
 */
export function scoreFrontmatterCompliance(tasks: TaskPlan[]): DimensionScore {
  const badTasks: string[] = [];
  for (const t of tasks) {
    const domain = t.frontmatter.domain;
    const domainOk = typeof domain === "string" && domain.trim().length > 0;
    const effort = t.frontmatter.effort;
    const effortOk = typeof effort === "string" && EFFORT_LEVELS.has(effort);
    if (domainOk && effortOk) continue;
    const reasons: string[] = [];
    if (!domainOk) reasons.push("sem domain:");
    if (!effortOk) reasons.push(effort === undefined ? "sem effort:" : "effort inválido");
    badTasks.push(`${t.id} (${reasons.join(", ")})`);
  }
  const verdict = countToVerdict(badTasks.length);
  const justification =
    badTasks.length === 0
      ? `All ${tasks.length} task(s) emit domain: and a valid effort: level.`
      : `Frontmatter não-conforme: ${badTasks.join(", ")}.`;
  return { name: "frontmatter_compliance", verdict, justification };
}

// ── Public: checkPlan ─────────────────────────────────────────────────────────

/**
 * Score a slice plan across the 12 LOCKED structural dimensions, plus the
 * conditional 13th (`frontmatter_compliance`, S01) when the CONTEXT requires
 * it. PURE — reads files and returns a result; never mutates STATE/PLAN. The
 * one blocking condition (parity with the 1.0 Step 1) is a missing
 * `S##-PLAN.md`.
 */
export function checkPlan(cwd: string, mid: string, sid: string): PlanCheckResult {
  const planPath = join(sliceDir(cwd, mid, sid), `${sid}-PLAN.md`);
  const planContent = readIfExists(planPath);
  if (planContent === null) {
    return {
      status: "blocked",
      dimensions: [],
      counts: { pass: 0, warn: 0, fail: 0 },
      blocker_class: "scope_exceeded",
      blocker: `${sid}-PLAN.md missing — plan-checker cannot score an absent plan`,
    };
  }

  const tasks = discoverTaskPlans(cwd, mid, sid);
  const declared = declaredTaskIds(planContent);
  const opt = readOptionalInputs(cwd, mid, sid);

  const dimensions: DimensionScore[] = [
    scoreCompleteness(planContent, declared, tasks),
    scoreMustHaves(tasks),
    scoreOrdering(declared, tasks),
    scoreDependencies(declared, tasks),
    scoreRiskCoverage(opt.risk, tasks),
    scoreAcceptanceObservable(planContent),
    scoreScopeAlignment(planContent, tasks),
    scoreDecisionsHonored(opt, tasks),
    scoreExpectedOutput(tasks),
    scoreLegacyDetect(tasks),
    scoreThroughTheDriver(tasks),
    scoreScopeDrop(sid, opt, planContent, tasks),
  ];

  // Conditional 13th dimension (S01): only present when the milestone/slice
  // CONTEXT declares the domain/effort bancada requirement — absent it, the
  // result (and the artefact writePlanCheck produces) stays byte-identical.
  const requiresFrontmatter =
    detectFrontmatterRequirement(opt.mContext ?? "") || detectFrontmatterRequirement(opt.sContext ?? "");
  if (requiresFrontmatter) {
    dimensions.push(scoreFrontmatterCompliance(tasks));
  }

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const d of dimensions) counts[d.verdict]++;

  return { status: "done", dimensions, counts };
}

// ── Public: writePlanCheck ────────────────────────────────────────────────────

/**
 * Write `S##-PLAN-CHECK.md` (LOCKED shape) atomically. The only side-effect in
 * this module. Deterministic / idempotent: a re-run produces byte-identical
 * output except for the `generated_at` timestamp. Returns the artefact path.
 *
 * Never call for a `blocked` result (nothing to score).
 */
export function writePlanCheck(cwd: string, mid: string, sid: string, result: PlanCheckResult): string {
  const target = join(sliceDir(cwd, mid, sid), `${sid}-PLAN-CHECK.md`);
  const generatedAt = new Date().toISOString();
  const mode = "advisory";
  const round = 1;

  const rows = result.dimensions
    .map((d, i) => `| ${i + 1} | ${d.name} | ${d.verdict} | ${escapeCell(d.justification)} |`)
    .join("\n");

  const fails = result.dimensions.filter((d) => d.verdict === "fail");
  let advisory = "";
  if (result.counts.fail > 0) {
    const lines = fails.slice(0, 4).map((d) => `- **${d.name}**: ${escapeCell(d.justification)}`);
    advisory = `\n## Advisory Notes\n\n${lines.join("\n")}\n`;
  }

  const content =
    `---\n` +
    `id: ${sid}\n` +
    `milestone: ${mid}\n` +
    `slice: ${sid}\n` +
    `generated_at: ${generatedAt}\n` +
    `mode: ${mode}\n` +
    `round: ${round}\n` +
    `---\n\n` +
    `# ${sid}: Plan Check — Advisory\n\n` +
    `Structural scorecard for the slice plan. Scores ${result.dimensions.length} locked dimensions. ` +
    `**This is advisory** — the loop proceeds regardless (D-S04-1: never blocks, never re-dispatches).\n\n` +
    `## Dimensions\n\n` +
    `| # | Dimension | Verdict | Justification |\n` +
    `|---|-----------|---------|---------------|\n` +
    `${rows}\n\n` +
    `## Summary\n\n` +
    `- **pass:** ${result.counts.pass}\n` +
    `- **warn:** ${result.counts.warn}\n` +
    `- **fail:** ${result.counts.fail}\n` +
    advisory;

  writeFileAtomic(target, content);
  return target;
}

/** Escape pipe/newline so a justification stays on one Markdown table cell. */
function escapeCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}
