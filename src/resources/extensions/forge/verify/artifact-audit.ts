/**
 * Forge artifact-audit — goal-backward artifact verifier (levels 1-3).
 *
 * Faithful TS estrito ESM port of the 1.0 `forge-agent/scripts/forge-verifier.js`
 * levels 1-3 (Exists / Substantive / Wired) plus the depth-2 import-chain walker.
 *
 * Level 4 (test-quality audit) is NOT implemented here — an optional injection
 * point (`opts.auditTestQuality`) is left for T02/T03 to fill; default: not run.
 *
 * Exports:
 *   verifyArtifact(mustHaves, sliceFiles, opts?) → { legacy, rows }
 *     Each row: { path, exists, substantive, wired, flags[] }
 *   checkExists / checkSubstantive / checkWired
 *   walkImports / extractImports / resolveSpec
 *   DEFAULT_STUB_REGEXES / IMPORT_PATTERNS / SUPPORTED_EXTENSIONS / JS_TS_EXTENSIONS
 *
 * Stub regex precedence order (evaluated in this exact order; first match wins per line):
 *   1. empty_function_body          — function foo() {}, () => {}, async () => {}
 *   2. return_null_function         — bare `return null;` at function-body indentation
 *   3. jsx_placeholder_onclick      — onClick={() => {}}
 *   4. jsx_placeholder_return_div   — `return <div />;` or `return <div></div>;`
 *
 * Short-circuit rules:
 *   Exists fails      → Substantive and Wired not evaluated (both stay null)
 *   Substantive fails → Wired not evaluated (Wired stays null)
 *
 * PURE module: only `node:fs` and `node:path` builtins + the shared MustHaves
 * types. No `@gsd/*` runtime import, no I/O writes.
 *
 * MEM004: line-scoped regexes use [ \t] not \s; `\Z` does not exist in JS.
 */

import fs from "node:fs";
import path from "node:path";

import type { Artifact, MustHaves } from "../state/must-haves.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** File extensions treated as JS/TS for stub detection and wired eligibility. */
export const JS_TS_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * Ordered list of supported extensions for import resolution.
 * Order: .js first (CJS-compat), then TS variants, then ESM-only.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".mjs",
  ".cjs",
];

export interface ImportPattern {
  name: string;
  regex: RegExp;
  description: string;
}

/**
 * Import pattern registry — capture group 1 is the import specifier in every entry.
 * Each regex uses the /g flag; `extractImports` resets `lastIndex` before use.
 */
export const IMPORT_PATTERNS: readonly ImportPattern[] = [
  {
    name: "import_from",
    regex: /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
    description: "ESM import ... from '<spec>'",
  },
  {
    name: "require_call",
    regex: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    description: "CJS require('<spec>')",
  },
  {
    name: "export_from",
    regex: /export\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
    description: "ESM re-export: export ... from '<spec>'",
  },
  {
    name: "export_star",
    regex: /export\s*\*\s*from\s+['"]([^'"]+)['"]/g,
    description: "ESM barrel: export * from '<spec>'",
  },
];

export interface StubRegex {
  name: string;
  regex: RegExp;
  description: string;
}

/**
 * Default stub-pattern registry.
 * Evaluated in this exact precedence order; first match per line wins.
 * Names are LOCKED — external VERIFICATION.md references them by name.
 */
export const DEFAULT_STUB_REGEXES: readonly StubRegex[] = [
  {
    name: "empty_function_body",
    // Matches a line whose entire content is an empty-body function/arrow declaration.
    regex:
      /^\s*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w*\s*\([^)]*\)|(?:(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?function\s*\w*\s*\([^)]*\)|(?:async\s+)?\([^)]*\)\s*=>))\s*\{\s*\}\s*;?\s*$/,
    description: "Function or arrow with completely empty body {}",
  },
  {
    name: "return_null_function",
    regex: /^\s*return\s+null\s*;?\s*$/,
    description: "Bare `return null;` indicating unimplemented function body",
  },
  {
    name: "jsx_placeholder_onclick",
    regex: /onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/,
    description: "JSX onClick={() => {}} empty handler placeholder",
  },
  {
    name: "jsx_placeholder_return_div",
    regex: /^\s*return\s+<div\s*\/?>(\s*<\/div>)?\s*;?\s*$/,
    description: "JSX stub: return <div /> or return <div></div>",
  },
];

// ── Result shapes ───────────────────────────────────────────────────────────

export interface Flag {
  level: string;
  reason?: string;
  regex_name?: string;
  line_number?: number;
  matched_text?: string;
  path?: string;
  actual?: number;
  expected?: number;
  depth_reached?: number;
  candidates_scanned?: number;
  [key: string]: unknown;
}

export interface WalkerInfo {
  candidates_scanned?: number;
  depth_reached?: number;
  pattern_name?: string;
  line_number?: number;
}

export type WiredVerdict = boolean | "approximate" | "skipped";

export interface ArtifactRow {
  path: string;
  exists: boolean | null;
  substantive: boolean | null;
  wired: WiredVerdict | null;
  flags: Flag[];
  walker_info?: WalkerInfo;
  test_quality?: boolean;
}

export interface VerifyResult {
  legacy: boolean;
  rows: ArtifactRow[];
}

/**
 * Optional test-quality auditor injection point (Level 4).
 * T02/T03 supply this; the default (`undefined`) means Level 4 does not run.
 */
export type TestQualityAuditor = (
  content: string,
  artifact: Artifact,
) => { pass: boolean; flags: Flag[] };

export interface VerifyOpts {
  cwd?: string;
  auditTestQuality?: TestQualityAuditor;
  isTestFile?: (artifactPath: string) => boolean;
}

// ── File cache ────────────────────────────────────────────────────────────────

/** Module-level cache map; cleared at each verifyArtifact() entry. */
let _fileCache = new Map<string, string | null>();

interface NodeError extends Error {
  code?: string;
}

/**
 * Read a file using the per-invocation cache.
 * Returns null if the file does not exist (ENOENT); other errors propagate.
 */
export function readFileCached(absPath: string): string | null {
  if (_fileCache.has(absPath)) {
    return _fileCache.get(absPath) ?? null;
  }
  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf-8");
  } catch (err) {
    if ((err as NodeError).code === "ENOENT") {
      _fileCache.set(absPath, null);
      return null;
    }
    throw err;
  }
  _fileCache.set(absPath, content);
  return content;
}

// ── Import-chain walker helpers ───────────────────────────────────────────────

export interface ExtractedImport {
  pattern_name: string;
  spec: string;
  line_number: number;
}

/**
 * Extract all import/require/export specifiers from file content.
 * Runs all IMPORT_PATTERNS; line numbers are 1-indexed.
 */
export function extractImports(content: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  for (const { name, regex } of IMPORT_PATTERNS) {
    regex.lastIndex = 0; // reset stateful global regex
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const spec = match[1];
      const lineNumber = content.slice(0, match.index).split("\n").length;
      results.push({ pattern_name: name, spec, line_number: lineNumber });
    }
  }
  return results;
}

/**
 * Resolve an import specifier relative to the importing file.
 * Returns the absolute normalised path if found, or null for bare/package specs
 * and specs that cannot be resolved to an existing file.
 */
export function resolveSpec(
  importerAbs: string,
  spec: string,
  _cwd?: string,
): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) {
    return null; // bare/package spec — skip
  }

  const base = path.resolve(path.dirname(importerAbs), spec);

  // Try base as-is first (may already have extension)
  if (
    SUPPORTED_EXTENSIONS.includes(path.extname(base).toLowerCase()) &&
    fs.existsSync(base)
  ) {
    return path.normalize(base);
  }

  // Try base + extension
  for (const ext of SUPPORTED_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) {
      return path.normalize(candidate);
    }
  }

  // Try base/index + extension (directory import)
  for (const ext of SUPPORTED_EXTENSIONS) {
    const candidate = path.join(base, "index" + ext);
    if (fs.existsSync(candidate)) {
      return path.normalize(candidate);
    }
  }

  return null;
}

export interface WalkResult {
  found: boolean;
  approximate?: boolean;
  reason?: string;
  depth_reached?: number;
  candidates_scanned: number;
  matching_file?: string;
  pattern_name?: string;
  line_number?: number;
}

export interface WalkOpts {
  cwd: string;
  depth?: number;
}

/**
 * BFS import-chain walker. Searches candidateFiles (and files reachable from them
 * up to `depth` hops) for any reference to targetAbs.
 * Distinguishes `depth_limit` (approximate) from `no_references_found`.
 */
export function walkImports(
  targetAbs: string,
  candidateFiles: string[],
  opts: WalkOpts,
): WalkResult {
  const cwd = opts.cwd;
  const maxDepth = opts.depth !== undefined ? opts.depth : 2;

  const visited = new Set<string>();
  let anyHopAtMaxDepth = false;

  // Queue entries: { file: absPath, hop: 1..maxDepth }
  const queue: { file: string; hop: number }[] = candidateFiles.map((f) => ({
    file: f,
    hop: 1,
  }));

  while (queue.length > 0) {
    const { file, hop } = queue.shift() as { file: string; hop: number };
    if (visited.has(file)) continue;
    visited.add(file);

    if (hop === maxDepth) {
      anyHopAtMaxDepth = true;
    }

    // Read content — swallow per-file errors (ENOENT etc.)
    let content: string | null;
    try {
      content = readFileCached(file);
    } catch {
      continue; // file unreadable — skip, counts as visited
    }
    if (content === null) continue;

    const imports = extractImports(content);
    for (const imp of imports) {
      const resolved = resolveSpec(file, imp.spec, cwd);
      if (resolved === null) continue;

      if (path.normalize(resolved) === path.normalize(targetAbs)) {
        return {
          found: true,
          depth_reached: hop,
          candidates_scanned: visited.size,
          matching_file: file,
          pattern_name: imp.pattern_name,
          line_number: imp.line_number,
        };
      }

      // Enqueue for next hop if within depth budget
      if (hop < maxDepth && !visited.has(resolved)) {
        queue.push({ file: resolved, hop: hop + 1 });
      }
    }
  }

  // Not found — distinguish depth_limit from no_references_found
  if (anyHopAtMaxDepth) {
    return {
      found: false,
      approximate: true,
      reason: "depth_limit",
      depth_reached: maxDepth,
      candidates_scanned: visited.size,
    };
  }

  return {
    found: false,
    approximate: false,
    reason: "no_references_found",
    candidates_scanned: visited.size,
  };
}

// ── Level 1: Exists ───────────────────────────────────────────────────────────

export interface ExistsResult {
  pass: boolean;
  flag?: Flag;
  content?: string;
  lineCount?: number;
}

/**
 * Level-1 check: does the artifact file exist and have content?
 * Signals `file_not_found` (absent) and `file_empty` (single blank line).
 */
export function checkExists(artifactPath: string, cwd: string): ExistsResult {
  const absPath = path.join(cwd, artifactPath);
  const content = readFileCached(absPath);

  if (content === null) {
    return {
      pass: false,
      flag: { level: "exists", reason: "file_not_found", path: artifactPath },
    };
  }

  const lines = content.split("\n");
  // Treat a file with only one empty line as empty
  if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === "")) {
    return {
      pass: false,
      flag: { level: "exists", reason: "file_empty", path: artifactPath },
    };
  }

  return { pass: true, content, lineCount: lines.length };
}

// ── Level 2: Substantive ──────────────────────────────────────────────────────

export interface SubstantiveResult {
  pass: boolean;
  flags?: Flag[];
}

/**
 * Level-2 check: is the artifact substantive (line count + no stub patterns)?
 *
 * stub_patterns behaviour:
 *   undefined  → use DEFAULT_STUB_REGEXES
 *   []         → detection disabled; only min_lines applies
 *   string[]   → compile extras, append to DEFAULT_STUB_REGEXES
 */
export function checkSubstantive(
  content: string,
  lineCount: number,
  artifact: Artifact,
): SubstantiveResult {
  const minLines = artifact.min_lines || 0;

  // ── min_lines gate ────────────────────────────────────────────────────────
  if (lineCount < minLines) {
    return {
      pass: false,
      flags: [
        {
          level: "substantive",
          reason: "below_min_lines",
          actual: lineCount,
          expected: minLines,
          path: artifact.path,
        },
      ],
    };
  }

  // ── Determine effective regex list ────────────────────────────────────────
  const stubPatterns = artifact.stub_patterns;
  let effectiveRegexes: readonly StubRegex[];

  if (Array.isArray(stubPatterns)) {
    if (stubPatterns.length === 0) {
      // Explicitly disabled for this artifact
      effectiveRegexes = [];
    } else {
      // Caller-supplied extras + defaults. stub_patterns are PLANNER-authored
      // free text — an invalid regex (seen live 2026-07-12: `todo(` →
      // "Invalid regular expression: /todo(/") used to throw here and abort
      // the WHOLE verify gate for the slice ("Verify advisory ignorado").
      // Fall back to a literal-escaped match — the author's evident intent —
      // and never let one bad pattern zero the gate's coverage.
      const extras: StubRegex[] = stubPatterns.map((src, i) => {
        try {
          return {
            name: `custom_stub_${i}`,
            regex: new RegExp(src),
            description: `Custom stub pattern: ${src}`,
          };
        } catch {
          const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return {
            name: `custom_stub_${i}_literal`,
            regex: new RegExp(escaped),
            description: `Custom stub pattern (literal fallback — invalid as regex): ${src}`,
          };
        }
      });
      effectiveRegexes = [...DEFAULT_STUB_REGEXES, ...extras];
    }
  } else {
    effectiveRegexes = DEFAULT_STUB_REGEXES;
  }

  if (effectiveRegexes.length === 0) {
    return { pass: true };
  }

  // ── Scan lines for stub patterns ──────────────────────────────────────────
  const lines = content.split("\n");
  const matchedFlags: Flag[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // First match per line wins (precedence order preserved in array)
    for (const { name, regex } of effectiveRegexes) {
      if (regex.test(line)) {
        matchedFlags.push({
          level: "substantive",
          regex_name: name,
          line_number: i + 1,
          matched_text: line.trim(),
          path: artifact.path,
        });
        break; // first match wins for this line
      }
    }
  }

  if (matchedFlags.length > 0) {
    return { pass: false, flags: matchedFlags };
  }

  return { pass: true };
}

// ── Level 3: Wired ────────────────────────────────────────────────────────────

export interface WiredResult {
  wired: WiredVerdict;
  flag?: Flag;
  walker_info?: WalkerInfo;
}

/**
 * Level-3 wired check — depth-2 import-chain scan.
 *
 * Returns wired: true | 'approximate' (depth limit) | false (no refs) |
 * 'skipped' (non-JS/TS artifact).
 */
export function checkWired(
  artifact: Artifact,
  nonJsTs: boolean,
  candidateFiles: string[],
  cwd: string,
): WiredResult {
  if (nonJsTs) {
    return {
      wired: "skipped",
      flag: { level: "wired", reason: "non_js_ts_repo", path: artifact.path },
    };
  }

  const artifactAbs = path.resolve(cwd, artifact.path);
  const result = walkImports(artifactAbs, candidateFiles, { cwd, depth: 2 });

  const walkerInfo: WalkerInfo = {
    candidates_scanned: result.candidates_scanned,
    depth_reached: result.depth_reached,
    pattern_name: result.pattern_name,
    line_number: result.line_number,
  };

  if (result.found) {
    return {
      wired: true,
      walker_info: walkerInfo,
    };
  }

  if (result.approximate) {
    return {
      wired: "approximate",
      flag: {
        level: "wired",
        reason: result.reason,
        depth_reached: result.depth_reached,
        candidates_scanned: result.candidates_scanned,
        path: artifact.path,
      },
      walker_info: walkerInfo,
    };
  }

  return {
    wired: false,
    flag: {
      level: "wired",
      reason: "no_references_found",
      candidates_scanned: result.candidates_scanned,
      path: artifact.path,
    },
    walker_info: walkerInfo,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the level 1-3 verification for all artifacts declared in a mustHaves block.
 *
 * Level 4 (test-quality) runs ONLY when `opts.auditTestQuality` is supplied AND
 * `opts.isTestFile(path)` returns true — this is the T02/T03 injection point.
 * By default Level 4 does not run and rows carry no `test_quality` field.
 */
export function verifyArtifact(
  mustHaves: MustHaves | null,
  sliceFiles: string[],
  opts?: VerifyOpts,
): VerifyResult {
  // Clear per-invocation file cache
  _fileCache = new Map<string, string | null>();

  const cwd = opts && opts.cwd ? opts.cwd : process.cwd();

  // ── Legacy / null input ───────────────────────────────────────────────────
  if (!mustHaves || !mustHaves.artifacts) {
    return {
      legacy: true,
      rows: [
        {
          path: "<unknown>",
          exists: null,
          substantive: null,
          wired: null,
          flags: [{ level: "schema", reason: "legacy_schema" }],
        },
      ],
    };
  }

  const artifacts = mustHaves.artifacts;

  // ── Build all artifact absolute paths for cross-reference ─────────────────
  const artifactAbsPaths = artifacts.map((a) => path.resolve(cwd, a.path));
  const extraAbsPaths = (Array.isArray(sliceFiles) ? sliceFiles : []).map((f) =>
    path.isAbsolute(f) ? f : path.resolve(cwd, f),
  );
  const allCandidateAbsPaths = Array.from(
    new Set([...artifactAbsPaths, ...extraAbsPaths]),
  );

  // ── Evaluate each artifact ────────────────────────────────────────────────
  const rows: ArtifactRow[] = [];

  for (const artifact of artifacts) {
    const artifactPath = artifact.path;
    const artifactAbs = path.resolve(cwd, artifactPath);

    // ── Level 1: Exists ───────────────────────────────────────────────────
    const existsResult = checkExists(artifactPath, cwd);

    if (!existsResult.pass) {
      rows.push({
        path: artifactPath,
        exists: false,
        substantive: null,
        wired: null,
        flags: existsResult.flag ? [existsResult.flag] : [],
      });
      continue; // short-circuit
    }

    const content = existsResult.content as string;
    const lineCount = existsResult.lineCount as number;

    // ── Level 2: Substantive ──────────────────────────────────────────────
    const subResult = checkSubstantive(content, lineCount, artifact);

    if (!subResult.pass) {
      rows.push({
        path: artifactPath,
        exists: true,
        substantive: false,
        wired: null,
        flags: subResult.flags || [],
      });
      continue; // short-circuit
    }

    // ── Level 3: Wired ────────────────────────────────────────────────────
    const isNonJsTs = !JS_TS_EXTENSIONS.has(
      path.extname(artifactPath).toLowerCase(),
    );
    // Candidate files: all artifacts and sliceFiles EXCEPT this artifact itself
    const candidateFiles = allCandidateAbsPaths.filter(
      (p) => path.normalize(p) !== path.normalize(artifactAbs),
    );
    const wiredResult = checkWired(artifact, isNonJsTs, candidateFiles, cwd);

    const rowFlags: Flag[] = [];
    if (wiredResult.flag) rowFlags.push(wiredResult.flag);

    // ── Level 4: Test-quality (optional injection point — T02/T03) ─────────
    // Advisory — never changes the level 1-3 verdict. Default: not run.
    let testQualityResult: { pass: boolean; flags: Flag[] } | null = null;
    if (
      opts &&
      opts.auditTestQuality &&
      opts.isTestFile &&
      opts.isTestFile(artifactPath)
    ) {
      testQualityResult = opts.auditTestQuality(content, artifact);
      if (!testQualityResult.pass) {
        rowFlags.push(...testQualityResult.flags);
      }
    }

    const row: ArtifactRow = {
      path: artifactPath,
      exists: true,
      substantive: true,
      wired: wiredResult.wired,
      walker_info: wiredResult.walker_info,
      flags: rowFlags,
    };
    if (testQualityResult !== null) {
      row.test_quality = testQualityResult.pass;
    }
    rows.push(row);
  }

  return { legacy: false, rows };
}
