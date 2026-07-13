/**
 * Forge must-haves — structured `must_haves:` schema detection + parser.
 *
 * Port of `forge-agent/scripts/forge-must-haves.js` (1.0 JS) to TS estrito ESM.
 *
 * Exports:
 *   hasStructuredMustHaves(content) → boolean
 *   parseMustHaves(content) → MustHaves
 *
 * Pure module: no filesystem/OS dependency, no `@gsd/*` runtime import — only
 * builtins-free string parsing plus the shared frontmatter splitter.
 */

import { splitFrontmatter } from "../../shared/frontmatter.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Artifact {
  path: string;
  provides: string;
  min_lines: number;
  stub_patterns?: string[];
}

export interface KeyLink {
  from: string;
  to: string;
  via: string;
}

export interface MustHaves {
  truths: string[];
  artifacts: Artifact[];
  key_links: KeyLink[];
  expected_output: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

// 1 MB size cap (prevents catastrophic backtracking) — mirrors the source CLI guard.
// Not enforced inside the pure parser (that's a caller/CLI concern), kept here for
// parity/documentation with the 1.0 script.
export const MAX_FRONTMATTER_FILE_SIZE = 1024 * 1024;

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Extract the raw YAML frontmatter block (between the first pair of `---`).
 * Reuses the shared `splitFrontmatter` (S01) to avoid a second hand-rolled
 * frontmatter reader — reconstructs the joined string the 1.0 regex-based
 * `extractFrontmatter` returned (frontmatter text, delimiters excluded).
 */
function extractFrontmatter(content: string): string | null {
  const [fmLines] = splitFrontmatter(content);
  if (!fmLines) return null;
  return fmLines.join("\n");
}

/**
 * Extract the indented sub-block that belongs to a top-level YAML key.
 * Only captures lines that are strictly indented relative to the key (column 0).
 */
function extractSubBlock(yaml: string, key: string): string | null {
  const lines = yaml.split("\n");
  let capturing = false;
  const collected: string[] = [];

  for (const line of lines) {
    if (!capturing) {
      if (line === `${key}:` || line.startsWith(`${key}: `)) {
        capturing = true;
      }
      continue;
    }
    // Capture lines that start with whitespace (indented children)
    if (/^[ \t]/.test(line)) {
      collected.push(line);
    } else {
      // Non-indented line means we've left the block
      break;
    }
  }

  return collected.length > 0 ? collected.join("\n") : null;
}

/**
 * Extract a simple scalar or inline array value from a top-level key.
 * Returns `undefined` if the key is absent, `null` as a sentinel meaning
 * "has key but no inline value" (caller falls back to `extractSubBlock`),
 * an array for inline `[...]` syntax, or a (quote-stripped) string scalar.
 */
function extractTopLevelValue(yaml: string, key: string): string | string[] | null | undefined {
  // Use [ \t]* (space/tab only) — NOT \s — to avoid matching across newlines
  const re = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m");
  const m = yaml.match(re);
  if (!m) return undefined;
  const val = m[1].trim();
  if (val.startsWith("[")) {
    const inner = val.replace(/^\[|\]$/g, "");
    if (!inner.trim()) return [];
    return inner
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (val === "") {
    // Multi-line — caller uses extractSubBlock
    return null; // sentinel: "has key but no inline value"
  }
  return val.replace(/^["']|["']$/g, "");
}

/**
 * Parse a multi-line YAML array of strings from an indented block.
 * Each item is a "  - value" line.
 */
function parseStringArray(block: string): string[] {
  return block
    .split("\n")
    .filter((l) => /^\s+-\s+/.test(l))
    .map((l) => l.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""));
}

/**
 * Parse a single YAML field value: inline array, number, or string.
 */
function parseFieldValue(val: string): string | number | string[] {
  if (val.startsWith("[")) {
    const inner = val.replace(/^\[|\]$/g, "");
    if (!inner.trim()) return [];
    return inner
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const n = Number(val);
  if (!isNaN(n) && val !== "") return n;
  return val.replace(/^["']|["']$/g, "");
}

/**
 * Parse a multi-line YAML array of objects from an indented block.
 * Handles items starting with "  - key: val" and continued fields "    key2: val2".
 * Field values may be inline arrays "[a, b]", or a block-sequence (empty value
 * followed by deeper-indented "- item" lines, e.g. `stub_patterns:`).
 */
function parseObjectArray(block: string): Record<string, unknown>[] {
  const lines = block.split("\n");
  const items: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | null = null;
  // pending block-sequence state: tracks a field whose value is an indented block array
  let pending: { fieldName: string; fieldIndent: number } | null = null;

  for (const line of lines) {
    if (!line.trim()) continue; // skip blank lines — do NOT close pending state

    // Skip comment lines — do NOT close pending state (Pitfall 4)
    if (line.trimStart().startsWith("#")) continue;

    // If pending block-sequence is active, check for sequence items BEFORE the new-item check.
    // (HIGH fix: itemMatch ran first, so "- TODO: fix" inside stub_patterns was mis-parsed as a
    // new artifact. The pending field must claim any deeper-indented seq-dash line first.)
    if (pending) {
      const seqMatch = line.match(/^(\s+)-\s+(.*)/);
      if (seqMatch) {
        const itemIndent = seqMatch[1].length;
        if (itemIndent > pending.fieldIndent) {
          // Collect this item into the pending array field
          const raw = seqMatch[2].trim().replace(/^["']|["']$/g, "");
          if (current && !Array.isArray(current[pending.fieldName])) {
            current[pending.fieldName] = [];
          }
          (current![pending.fieldName] as string[]).push(raw);
          continue;
        }
        // MEDIUM fix: seq-dash found but not deeper than pending field — close pending
        // deterministically and fall through to re-evaluate as a new item/field below.
        pending = null;
        // (no continue — let the line fall through to itemMatch/fieldMatch below)
      }
    }

    // New item: "  - key: value" (2+ spaces + dash)
    const itemMatch = line.match(/^(\s+)-\s+(\w[\w_-]*):\s*(.*)/);
    if (itemMatch) {
      // Close any pending block-sequence state
      pending = null;
      if (current) items.push(current);
      current = {};
      current[itemMatch[2]] = parseFieldValue(itemMatch[3].trim());
      continue;
    }

    // Continuation field: "    key: value" (4+ spaces, no dash)
    const fieldMatch = line.match(/^(\s{4,})(\w[\w_-]*):\s*(.*)/);
    if (fieldMatch && current) {
      const fieldIndent = fieldMatch[1].length;
      const fieldValue = fieldMatch[3].trim();

      if (fieldValue === "") {
        // Empty value — enter pending block-sequence state
        pending = { fieldName: fieldMatch[2], fieldIndent };
        // Initialize to empty array (will be populated by subsequent sequence lines)
        current[fieldMatch[2]] = [];
      } else {
        // Non-empty value — close pending state and assign normally
        pending = null;
        current[fieldMatch[2]] = parseFieldValue(fieldValue);
      }
      continue;
    }

    // Any other line that doesn't match closes pending state
    if (pending) pending = null;
  }

  if (current) items.push(current);
  return items;
}

/**
 * Parse a named key's sub-block as an array (strings or objects).
 * Determines array type by checking if the first item line has "key: val"
 * shape (object) or a plain value (string).
 */
function parseArrayKey(yaml: string, key: string): string[] | Record<string, unknown>[] | undefined {
  // Patch #1: probe for inline array BEFORE falling through to extractSubBlock.
  // extractTopLevelValue returns [] or [a,b] for inline arrays, null for empty-value (block form),
  // undefined for absent key, or a scalar string for non-array inline values.
  // Short-circuit only when the probe returns an actual Array — covers `key: []` and `key: [a, b]`
  // at any nesting depth (Pitfall 6: must come before extractSubBlock, not after).
  const inlineProbe = extractTopLevelValue(yaml, key);
  if (Array.isArray(inlineProbe)) return inlineProbe;

  const block = extractSubBlock(yaml, key);
  if (!block) return undefined;

  // Detect array type from first item line
  const firstItem = block.split("\n").find((l) => /^\s+-\s+/.test(l));
  if (!firstItem) return [];

  const isObject = /^\s+-\s+\w[\w_-]*:/.test(firstItem);
  return isObject ? parseObjectArray(block) : parseStringArray(block);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect whether a T##-PLAN.md has a structured `must_haves:` block at YAML root.
 * This is a presence check only — does NOT validate shape.
 */
export function hasStructuredMustHaves(content: string): boolean {
  const fm = extractFrontmatter(content);
  if (!fm) return false;
  // must_haves: at column 0 (either followed by newline or space)
  return /^must_haves:\s*(\n|$)/m.test(fm);
}

/**
 * Parse the `must_haves:` block and `expected_output:` array from a structured plan.
 * Callers MUST check `hasStructuredMustHaves` first; throws if called on legacy plans.
 *
 * Throws Error("malformed must_haves schema: <field> — <reason>") on invalid shape.
 * Throws Error("plan is legacy — use hasStructuredMustHaves to pre-check") for legacy plans.
 */
export function parseMustHaves(content: string): MustHaves {
  if (!hasStructuredMustHaves(content)) {
    throw new Error("plan is legacy — use hasStructuredMustHaves to pre-check");
  }

  const fm = extractFrontmatter(content) as string;

  // Extract the must_haves sub-block to operate on its nested keys
  const mustHavesBlock = extractSubBlock(fm, "must_haves");
  if (!mustHavesBlock) {
    throw new Error("malformed must_haves schema: must_haves — block is empty");
  }

  // Dedent the must_haves sub-block by 2 spaces to treat as "top-level" for parseArrayKey
  const dedented = mustHavesBlock.replace(/^ {2}/gm, "");

  // Validate truths
  const truths = parseArrayKey(dedented, "truths");
  if (!Array.isArray(truths)) {
    throw new Error("malformed must_haves schema: truths — must be an array of strings");
  }
  for (const t of truths) {
    if (typeof t !== "string") {
      throw new Error("malformed must_haves schema: truths[] — each item must be a string");
    }
  }

  // Validate artifacts
  const artifactsRaw = parseArrayKey(dedented, "artifacts");
  if (!Array.isArray(artifactsRaw)) {
    throw new Error("malformed must_haves schema: artifacts — must be an array of objects");
  }
  for (let i = 0; i < artifactsRaw.length; i++) {
    const a = artifactsRaw[i] as Record<string, unknown>;
    if (typeof a !== "object" || a === null) {
      throw new Error(`malformed must_haves schema: artifacts[${i}] — must be an object`);
    }
    if (!a.path || typeof a.path !== "string") {
      throw new Error(`malformed must_haves schema: artifacts[${i}].path — required string field missing`);
    }
    if (!a.provides || typeof a.provides !== "string") {
      throw new Error(`malformed must_haves schema: artifacts[${i}].provides — required string field missing`);
    }
    if (a.min_lines === undefined || typeof a.min_lines !== "number") {
      throw new Error(`malformed must_haves schema: artifacts[${i}].min_lines — required number field missing`);
    }
    if (a.stub_patterns !== undefined && !Array.isArray(a.stub_patterns)) {
      throw new Error(`malformed must_haves schema: artifacts[${i}].stub_patterns — must be an array if present`);
    }
  }
  const artifacts = artifactsRaw as unknown as Artifact[];

  // Validate key_links
  const keyLinksRaw = parseArrayKey(dedented, "key_links");
  if (!Array.isArray(keyLinksRaw)) {
    throw new Error("malformed must_haves schema: key_links — must be an array of objects");
  }
  for (let i = 0; i < keyLinksRaw.length; i++) {
    const kl = keyLinksRaw[i] as Record<string, unknown>;
    if (typeof kl !== "object" || kl === null) {
      throw new Error(`malformed must_haves schema: key_links[${i}] — must be an object`);
    }
    if (!kl.from || typeof kl.from !== "string") {
      throw new Error(`malformed must_haves schema: key_links[${i}].from — required field missing`);
    }
    if (!kl.to || typeof kl.to !== "string") {
      throw new Error(`malformed must_haves schema: key_links[${i}].to — required field missing`);
    }
    if (!kl.via || typeof kl.via !== "string") {
      throw new Error(`malformed must_haves schema: key_links[${i}].via — required field missing`);
    }
  }
  const keyLinks = keyLinksRaw as unknown as KeyLink[];

  // Validate expected_output (top-level key, sibling to must_haves)
  const expectedOutputInline = extractTopLevelValue(fm, "expected_output");
  let expectedOutput: unknown[];
  if (expectedOutputInline === undefined) {
    expectedOutput = [];
  } else if (Array.isArray(expectedOutputInline)) {
    expectedOutput = expectedOutputInline;
  } else if (expectedOutputInline === null) {
    // Multi-line array
    const arr = parseArrayKey(fm, "expected_output") as string[] | undefined;
    expectedOutput = arr !== undefined ? arr : [];
  } else {
    expectedOutput = [String(expectedOutputInline)];
  }

  if (!Array.isArray(expectedOutput)) {
    throw new Error("malformed must_haves schema: expected_output — must be an array of strings");
  }
  for (const p of expectedOutput) {
    if (typeof p !== "string") {
      throw new Error("malformed must_haves schema: expected_output[] — each item must be a string");
    }
  }

  return {
    truths: truths as string[],
    artifacts,
    key_links: keyLinks,
    expected_output: expectedOutput as string[],
  };
}
