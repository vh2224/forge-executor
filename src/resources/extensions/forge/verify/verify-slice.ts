/**
 * Forge verify-slice — slice-level runner + render/persist of S##-VERIFICATION.md.
 *
 * Composes the T01 artifact-audit (levels 1-3) and T02 test-quality (level 4)
 * into a native slice verifier: discovers each `tasks/T##/T##-PLAN.md`, aggregates
 * their `must_haves` via the shared `state/must-haves.ts` parser (NOT re-ported),
 * runs `verifyArtifact` + `auditTestQuality` over the real artifacts on disk, and
 * renders/persists the `S##-VERIFICATION.md` natively (advisory — never blocks).
 *
 * Reescrita fiel do slice-runner 1.0 (`forge-agent/scripts/forge-verifier.js:908-1221`)
 * — discoverTaskPlans / aggregateMustHaves / runSliceVerification / formatVerificationMd
 * (→ renderVerification) / writeVerificationMd (→ writeVerification).
 *
 * Exports:
 *   discoverTaskPlans(sliceDir) → { plans, noTasksDir }
 *   aggregateMustHaves(plans) → { structured, legacy, malformed, errors }
 *   runSliceVerification(cwd, mid, slice) → SliceVerificationResult
 *   renderVerification(result, { generated_at, verifier_version }) → string   (PURE)
 *   writeVerification(cwd, mid, slice, md) → { path, created }                (ATOMIC, idempotent)
 *   collectExpectedOutputs(cwd, mid, slice) → string[]  (dedup union)
 *
 * D-S06-4: `renderVerification` is PURE — `generated_at`/`verifier_version` are
 * caller parameters (never `Date` inside), so re-render with identical input is
 * byte-identical. `writeVerification` compares PRE-mutation and no-ops on an
 * identical on-disk file (S04-R1/R3 idempotency).
 *
 * PURE-adjacent: only `node:fs`/`node:path` builtins + the shared parser/verifier/
 * writer. No import from the condemned `gsd/` tree. TS estrito ESM.
 *
 * MEM004: line-scoped regexes use [ \t] not \s; `\Z` does not exist in JS.
 */

import fs from "node:fs";
import path from "node:path";

import {
  hasStructuredMustHaves,
  parseMustHaves,
  type Artifact,
  type MustHaves,
} from "../state/must-haves.js";
import { writeFileAtomic } from "../state/ledger.js";
import {
  verifyArtifact,
  type Flag,
  type WalkerInfo,
  type WiredVerdict,
} from "./artifact-audit.js";
import { auditTestQuality, isTestFile } from "./test-quality.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Native verifier version stamp (frontmatter `verifier_version`, render default). */
export const VERIFIER_VERSION =
  "v2.0-native (forge/verify; L1-3 artifact-audit + L4 test-quality)";

// ── Path helper ────────────────────────────────────────────────────────────────

/** Absolute path of a slice directory: `.gsd/milestones/<mid>/slices/<slice>`. */
export function sliceDirOf(cwd: string, mid: string, slice: string): string {
  return path.join(cwd, ".gsd", "milestones", mid, "slices", slice);
}

// ── discoverTaskPlans ───────────────────────────────────────────────────────────

export interface TaskPlanRef {
  taskId: string;
  absPath: string;
}

export interface DiscoverResult {
  plans: TaskPlanRef[];
  noTasksDir: boolean;
}

/**
 * Scan `<sliceDir>/tasks/T##/` (regex `^T\d{2}$`, sorted) and build the plan
 * path for each. Missing/unreadable `tasks/` dir → `{ plans: [], noTasksDir: true }`.
 */
export function discoverTaskPlans(sliceDir: string): DiscoverResult {
  const tasksDir = path.join(sliceDir, "tasks");
  if (!fs.existsSync(tasksDir)) {
    return { plans: [], noTasksDir: true };
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(tasksDir);
  } catch {
    return { plans: [], noTasksDir: true };
  }
  const plans: TaskPlanRef[] = [];
  for (const entry of [...entries].sort()) {
    if (!/^T\d{2}$/.test(entry)) continue;
    const planFile = path.join(tasksDir, entry, `${entry}-PLAN.md`);
    plans.push({ taskId: entry, absPath: planFile });
  }
  return { plans, noTasksDir: false };
}

// ── aggregateMustHaves ──────────────────────────────────────────────────────────

export interface StructuredPlan {
  taskId: string;
  mustHaves: MustHaves;
  planPath: string;
}

export interface AggregateResult {
  structured: StructuredPlan[];
  legacy: TaskPlanRef[];
  malformed: { taskId: string; absPath: string; error: string }[];
  errors: { taskId: string; absPath: string; reason: string }[];
}

/**
 * Aggregate `must_haves` from discovered plans, reusing `state/must-haves.ts`
 * (the parser is NOT re-ported). Each plan is bucketed into:
 *   - structured : has a valid structured `must_haves:` block
 *   - legacy     : no structured block (`skipped: legacy_schema`)
 *   - malformed  : structured but `parseMustHaves` threw (`skipped: malformed_schema`)
 *   - errors     : plan file unreadable (`file_not_found`)
 * Never throws — legacy/malformed become skipped rows downstream.
 */
export function aggregateMustHaves(plans: TaskPlanRef[]): AggregateResult {
  const structured: StructuredPlan[] = [];
  const legacy: TaskPlanRef[] = [];
  const malformed: { taskId: string; absPath: string; error: string }[] = [];
  const errors: { taskId: string; absPath: string; reason: string }[] = [];

  for (const { taskId, absPath } of plans) {
    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch {
      errors.push({ taskId, absPath, reason: "file_not_found" });
      continue;
    }

    if (!hasStructuredMustHaves(content)) {
      legacy.push({ taskId, absPath });
      continue;
    }

    try {
      const mustHaves = parseMustHaves(content);
      structured.push({ taskId, mustHaves, planPath: absPath });
    } catch (err) {
      malformed.push({
        taskId,
        absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { structured, legacy, malformed, errors };
}

// ── runSliceVerification ────────────────────────────────────────────────────────

export interface SliceRow {
  sourceTask: string;
  path: string;
  exists: boolean | null;
  substantive: boolean | null;
  wired: WiredVerdict | null;
  flags: Flag[];
  test_quality?: boolean;
  walker_info?: WalkerInfo;
}

export interface SliceVerificationResult {
  slice: string;
  milestone: string;
  duration_ms: number;
  rows: SliceRow[];
  legacy_count: number;
  malformed_count: number;
  error_count: number;
  no_tasks_dir: boolean;
}

interface TaggedArtifact extends Artifact {
  _sourceTask: string;
}

/**
 * Run the full slice verification: discover the plans, aggregate `must_haves`,
 * run `verifyArtifact` (L1-3) + `auditTestQuality` (L4) over the combined artifact
 * set (against real files under `cwd`), and return rows + legacy/malformed/error
 * counts. Legacy/malformed/error plans yield `schema` skip rows (never thrown).
 *
 * `duration_ms` is measured wall-clock (part of the returned input); `generated_at`
 * is NOT set here — it is injected at `renderVerification` for determinism.
 */
export function runSliceVerification(
  cwd: string,
  mid: string,
  slice: string,
): SliceVerificationResult {
  const start = process.hrtime.bigint();

  const sliceDir = sliceDirOf(cwd, mid, slice);
  const { plans, noTasksDir } = discoverTaskPlans(sliceDir);
  const agg = aggregateMustHaves(plans);

  const rows: SliceRow[] = [];

  // Build combined artifacts array tagged with the owning task.
  const combinedArtifacts: TaggedArtifact[] = [];
  for (const { taskId, mustHaves } of agg.structured) {
    if (mustHaves.artifacts && mustHaves.artifacts.length > 0) {
      for (const artifact of mustHaves.artifacts) {
        combinedArtifacts.push({ ...artifact, _sourceTask: taskId });
      }
    }
  }

  if (combinedArtifacts.length > 0) {
    const combinedMustHaves: MustHaves = {
      truths: [],
      artifacts: combinedArtifacts,
      key_links: [],
      expected_output: [],
    };
    // Pass all artifact paths as sliceFiles so the walker has the full candidate set.
    const sliceFilesCandidates = combinedArtifacts.map((a) =>
      path.resolve(cwd, a.path),
    );
    const verifyResult = verifyArtifact(combinedMustHaves, sliceFilesCandidates, {
      cwd,
      // Adapter: TestQualityFlag lacks Flag's index signature — widen to Flag[].
      auditTestQuality: (content, artifact) => {
        const r = auditTestQuality(content, artifact);
        return { pass: r.pass, flags: r.flags as unknown as Flag[] };
      },
      isTestFile,
    });
    for (const row of verifyResult.rows) {
      const artifact = combinedArtifacts.find((a) => a.path === row.path);
      rows.push({
        sourceTask: artifact ? artifact._sourceTask : "?",
        path: row.path,
        exists: row.exists,
        substantive: row.substantive,
        wired: row.wired,
        flags: row.flags,
        test_quality: row.test_quality,
        walker_info: row.walker_info,
      });
    }
  }

  // Legacy plan rows.
  for (const { taskId, absPath } of agg.legacy) {
    rows.push({
      sourceTask: taskId,
      path: relPlanPath(cwd, absPath),
      exists: null,
      substantive: null,
      wired: null,
      flags: [{ level: "schema", reason: "legacy_schema", source_task: taskId }],
    });
  }

  // Malformed plan rows.
  for (const { taskId, absPath, error } of agg.malformed) {
    rows.push({
      sourceTask: taskId,
      path: relPlanPath(cwd, absPath),
      exists: null,
      substantive: null,
      wired: null,
      flags: [
        { level: "schema", reason: "malformed_schema", source_task: taskId, error },
      ],
    });
  }

  // Error rows (plan file unreadable).
  for (const { taskId, absPath } of agg.errors) {
    rows.push({
      sourceTask: taskId,
      path: relPlanPath(cwd, absPath),
      exists: null,
      substantive: null,
      wired: null,
      flags: [{ level: "schema", reason: "file_not_found", source_task: taskId }],
    });
  }

  const duration_ms = Number(process.hrtime.bigint() - start) / 1e6;

  return {
    slice,
    milestone: mid,
    duration_ms,
    rows,
    legacy_count: agg.legacy.length,
    malformed_count: agg.malformed.length,
    error_count: agg.errors.length,
    no_tasks_dir: noTasksDir,
  };
}

/** Relative, forward-slash plan path for a skip row. */
function relPlanPath(cwd: string, absPath: string): string {
  return path.relative(cwd, absPath).replace(/\\/g, "/");
}

// ── renderVerification (PURE) ────────────────────────────────────────────────────

export interface RenderOpts {
  generated_at: string;
  verifier_version?: string;
}

/**
 * Render the `S##-VERIFICATION.md` markdown from a slice-verification result.
 *
 * PURE: `generated_at` and `verifier_version` are caller parameters (no `Date`,
 * no randomness). Re-rendering the SAME result with the SAME opts is byte-identical.
 * Layout mirrors the 1.0 `formatVerificationMd` (frontmatter + Artifact Audit table
 * + Flags narrative + Performance); only the "generated by" line is swapped for the
 * native advisory notice.
 */
export function renderVerification(
  result: SliceVerificationResult,
  opts: RenderOpts,
): string {
  const { slice, milestone, duration_ms, rows, legacy_count, malformed_count } =
    result;
  const verifierVersion = opts.verifier_version ?? VERIFIER_VERSION;
  const durationRounded = Math.round(duration_ms * 100) / 100;

  // ── Frontmatter ──────────────────────────────────────────────────────────────
  const fm = [
    "---",
    `id: ${slice}-VERIFICATION`,
    `slice: ${slice}`,
    `milestone: ${milestone}`,
    `generated_at: ${opts.generated_at}`,
    `duration_ms: ${durationRounded}`,
    `verifier_version: "${verifierVersion}"`,
    `legacy_count: ${legacy_count}`,
    `malformed_count: ${malformed_count}`,
    "---",
    "",
  ].join("\n");

  // ── Header + description ──────────────────────────────────────────────────────
  const header = [
    `# ${slice}: Goal-backward Verification`,
    "",
    "Advisory only — heuristic 4-level audit (Exists / Substantive / Wired / Test-quality).",
    "Stub detection is regex-based; Wired is depth-2 import-chain scan (JS/TS only).",
    "Test-quality applies only to declared test files (*.test.* / *.spec.* / __tests__/).",
    "Gerado nativamente por `forge/verify` (advisory — nunca bloqueia o fecho do slice).",
    "",
  ].join("\n");

  // ── Artifact Audit table ──────────────────────────────────────────────────────
  const tableHeader = [
    "## Artifact Audit",
    "",
    "| Source | Artifact | Exists | Substantive | Wired | Flags |",
    "|--------|----------|--------|-------------|-------|-------|",
  ].join("\n");

  const tableRows = rows.map((row) => renderTableRow(row));
  const tableSection = tableHeader + "\n" + tableRows.join("\n") + "\n";

  // ── Flags narrative ───────────────────────────────────────────────────────────
  const flagsSection = renderFlagsSection(rows);

  // ── Performance ───────────────────────────────────────────────────────────────
  const artifactCount = rows.filter(
    (r) =>
      r.exists !== null ||
      (r.flags && r.flags[0] && r.flags[0].level === "exists"),
  ).length;
  const perfSection = [
    "## Performance",
    "",
    `- Wall-clock: ${durationRounded} ms`,
    `- Artifacts audited: ${artifactCount}`,
    "- Budget: ≤ 2000 ms per 10 artifacts (hot cache)",
    "",
  ].join("\n");

  return (
    fm +
    header +
    tableSection +
    "\n" +
    (flagsSection ? flagsSection + "\n" : "") +
    perfSection
  );
}

/** Render one Artifact Audit table row (compact cells). */
function renderTableRow(row: SliceRow): string {
  const existsCell =
    row.exists === true ? "✓" : row.exists === false ? "✗" : "—";
  const subCell =
    row.substantive === true ? "✓" : row.substantive === false ? "✗" : "—";
  const wiredCell =
    row.wired === true
      ? "✓"
      : row.wired === false
        ? "✗"
        : row.wired === "approximate"
          ? "~"
          : "—";

  let flagsCell = "—";
  if (row.flags && row.flags.length > 0) {
    const firstFlag = row.flags[0];
    if (firstFlag.reason === "legacy_schema") {
      flagsCell = "`skipped: legacy_schema`";
    } else if (firstFlag.reason === "malformed_schema") {
      flagsCell = "`skipped: malformed_schema`";
    } else if (firstFlag.reason === "non_js_ts_repo") {
      flagsCell = "`wired: non_js_ts`";
    } else if (firstFlag.reason === "no_references_found") {
      const scanned =
        firstFlag.candidates_scanned !== undefined
          ? ` (${firstFlag.candidates_scanned} scanned)`
          : "";
      flagsCell = `\`wired: no_references_found${scanned}\``;
    } else if (firstFlag.reason === "depth_limit") {
      flagsCell = `\`wired: ~depth_limit (depth ${firstFlag.depth_reached})\``;
    } else if (firstFlag.reason === "file_not_found" && firstFlag.level === "exists") {
      flagsCell = "`file_not_found`";
    } else if (firstFlag.reason === "below_min_lines") {
      flagsCell = `\`below_min_lines (${firstFlag.actual}/${firstFlag.expected})\``;
    } else if (firstFlag.regex_name) {
      flagsCell = `\`${firstFlag.regex_name}\` at :${firstFlag.line_number}`;
    } else if (firstFlag.reason) {
      flagsCell = `\`${firstFlag.reason}\``;
    }
  }

  const artifactCell =
    row.path.length > 50 ? "..." + row.path.slice(-47) : row.path;
  return `| ${row.sourceTask || "?"} | ${artifactCell} | ${existsCell} | ${subCell} | ${wiredCell} | ${flagsCell} |`;
}

/** Render the Flags narrative section (empty string when no failing rows). */
function renderFlagsSection(rows: SliceRow[]): string {
  const failingRows = rows.filter(
    (row) =>
      row.exists === false ||
      row.substantive === false ||
      row.wired === false ||
      row.wired === "approximate" ||
      row.test_quality === false ||
      (row.flags &&
        row.flags.some(
          (f) =>
            f.reason &&
            ![
              "non_js_ts_repo",
              "legacy_schema",
              "no_references_found",
              "depth_limit",
            ].includes(f.reason),
        )),
  );

  if (failingRows.length === 0) return "";

  const parts: string[] = ["## Flags", ""];
  for (const row of failingRows) {
    parts.push(`### ${row.path}`);
    parts.push("");
    const tqFlags = (row.flags || []).filter((f) => f.level === "test-quality");
    const otherFlags = (row.flags || []).filter((f) => f.level !== "test-quality");

    for (const flag of otherFlags) {
      if (flag.regex_name) {
        parts.push(
          `- **${flag.regex_name}** at line ${flag.line_number}: \`${flag.matched_text}\``,
        );
      } else if (flag.reason === "depth_limit") {
        parts.push(
          `- **wired: ~** depth_limit reached at depth ${flag.depth_reached} (${flag.candidates_scanned} candidates scanned). Chain may exist beyond depth-2 cap — human triage advised.`,
        );
      } else if (flag.reason === "no_references_found") {
        parts.push(
          `- **wired: ✗** no import/require/export reference found in ${flag.candidates_scanned} candidates scanned.`,
        );
      } else if (flag.reason) {
        const detail = flag.error ? ` — ${flag.error}` : "";
        const lines =
          flag.actual !== undefined
            ? ` (actual: ${flag.actual}, expected: ${flag.expected})`
            : "";
        parts.push(`- **${flag.reason}**${lines}${detail}`);
      }
    }

    if (tqFlags.length > 0) {
      parts.push("");
      parts.push("**Test-quality**");
      for (const flag of tqFlags) {
        if (flag.reason === "no-assertion") {
          parts.push("- **no-assertion** — file has no `expect()` or `assert()` calls");
        } else if (flag.reason === "disabled-test") {
          parts.push(
            `- **disabled-test** (${flag.regex_name}) at line ${flag.line_number}: \`${flag.matched_text}\``,
          );
        } else if (flag.reason === "weak-assertion") {
          parts.push(
            `- **weak-assertion** (${flag.regex_name}) at line ${flag.line_number}: \`${flag.matched_text}\``,
          );
        } else if (flag.reason === "circular-assertion") {
          parts.push(
            `- **circular-assertion** (${flag.regex_name}) at line ${flag.line_number}: \`${flag.matched_text}\``,
          );
        } else if (flag.reason === "audit-error") {
          parts.push(
            `- **audit-error** — ${flag.error || "unknown error during test-quality scan"}`,
          );
        } else if (flag.reason) {
          parts.push(
            `- **${flag.reason}** (${flag.regex_name || ""}) at line ${flag.line_number || "?"}`,
          );
        }
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}

// ── writeVerification (ATOMIC, idempotent) ───────────────────────────────────────

export interface WriteResult {
  path: string;
  created: boolean;
}

/**
 * Persist the rendered markdown to
 * `.gsd/milestones/<mid>/slices/<slice>/<slice>-VERIFICATION.md` via `writeFileAtomic`
 * (temp + rename). Idempotent: if the target already holds byte-identical content the
 * write is skipped (`created: false`) — the pre-mutation compare (S04-R1/R3).
 */
export function writeVerification(
  cwd: string,
  mid: string,
  slice: string,
  md: string,
): WriteResult {
  const outPath = path.join(sliceDirOf(cwd, mid, slice), `${slice}-VERIFICATION.md`);

  if (fs.existsSync(outPath)) {
    try {
      if (fs.readFileSync(outPath, "utf-8") === md) {
        return { path: outPath, created: false };
      }
    } catch {
      // unreadable — fall through and rewrite
    }
  }

  writeFileAtomic(outPath, md);
  return { path: outPath, created: true };
}

// ── collectExpectedOutputs ───────────────────────────────────────────────────────

/**
 * Collect the deduplicated union of `expected_output` across every structured task
 * plan in a slice, in first-seen order. Reuses `discoverTaskPlans` + the shared
 * `must-haves.ts` parser; legacy/malformed/unreadable plans contribute nothing
 * (never throws).
 */
export function collectExpectedOutputs(
  cwd: string,
  mid: string,
  slice: string,
): string[] {
  const sliceDir = sliceDirOf(cwd, mid, slice);
  const { plans } = discoverTaskPlans(sliceDir);

  const seen = new Set<string>();
  const out: string[] = [];

  for (const { absPath } of plans) {
    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }
    if (!hasStructuredMustHaves(content)) continue;
    let mustHaves: MustHaves;
    try {
      mustHaves = parseMustHaves(content);
    } catch {
      continue;
    }
    for (const p of mustHaves.expected_output || []) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }

  return out;
}
