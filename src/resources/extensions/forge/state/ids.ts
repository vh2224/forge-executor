/**
 * Forge IDs — pure ID core + prefs-backed resolution cascade.
 *
 * Port of `forge-agent/scripts/forge-ids.js` (1.0 JS) to TS estrito ESM.
 *
 * Generation format is controlled by the `ids.format` pref (timestamp | sequential,
 * default timestamp). Reading always accepts BOTH formats regardless of the pref.
 *
 * The pure core (below) has no filesystem/OS dependency — same input always
 * returns same output. The I/O layer (`readIdFormat`/`resolveMilestoneId`/
 * `resolveTaskId`/`listExistingIds`) consumes S01's `readForgePrefs` cascade
 * instead of re-implementing a second prefs reader.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { readForgePrefs } from "../prefs.js";

export type IdFormat = "timestamp" | "sequential";
export type IdClass = "legacy" | "timestamp";
export type EntityKind = "milestone" | "task" | "unknown";

// ── Stopwords — bilingual (pt-BR + en), checked-in constant, never derived at runtime ──
export const STOPWORDS: ReadonlySet<string> = Object.freeze(
  new Set([
    // Portuguese
    "de", "da", "do", "das", "dos", "o", "a", "os", "as",
    "com", "para", "por", "e", "em", "no", "na", "um", "uma",
    // English
    "the", "an", "of", "to", "for", "and", "in", "on", "at",
  ]),
);

// ── nowTimestamp ─────────────────────────────────────────────────────────────
// Returns 14-digit UTC timestamp: YYYYMMDDHHMMSS
// Always derived from toISOString() — never local time getters.
export function nowTimestamp(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

// ── slugify ──────────────────────────────────────────────────────────────────
// Pure function: same input always returns same output. No Date, no random, no I/O.
// Steps: lowercase → NFD accent-fold → strip non-alphanumeric → tokenize →
//        remove stopwords → join with '-' up to ~24 chars (word boundary) →
//        hard-slice fallback if single token exceeds 24 → '' if nothing left.
const SLUG_CAP = 24;

export function slugify(desc: string): string {
  // Lowercase and ASCII-fold diacritics via NFD decomposition
  const normalized = String(desc)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  // Replace non-alphanumeric with spaces, collapse, trim
  const cleaned = normalized.replace(/[^a-z0-9]+/g, " ").trim();

  if (!cleaned) return "";

  // Tokenize and remove stopwords
  const tokens = cleaned.split(" ").filter((t) => t && !STOPWORDS.has(t));

  if (tokens.length === 0) return "";

  // Join tokens up to SLUG_CAP characters at word boundary
  let result = "";
  for (const token of tokens) {
    const candidate = result ? `${result}-${token}` : token;
    if (candidate.length > SLUG_CAP) {
      // Would exceed cap — stop if we already have something
      if (result) break;
      // Single first token longer than cap: hard-slice fallback
      result = token.slice(0, SLUG_CAP).replace(/-+$/, "");
      break;
    }
    result = candidate;
  }

  // Final safety: hard-slice if somehow still over cap (edge case)
  if (result.length > SLUG_CAP) {
    result = result.slice(0, SLUG_CAP).replace(/-+$/, "");
  }

  return result;
}

// ── makeMilestoneId ──────────────────────────────────────────────────────────
export function makeMilestoneId(desc: string): string {
  const slug = slugify(desc);
  const ts = nowTimestamp();
  return slug ? `M-${ts}-${slug}` : `M-${ts}`;
}

// ── makeTaskId ───────────────────────────────────────────────────────────────
export function makeTaskId(desc: string): string {
  const slug = slugify(desc);
  const ts = nowTimestamp();
  return slug ? `T-${ts}-${slug}` : `T-${ts}`;
}

// ── nextSequentialMilestoneId ────────────────────────────────────────────────
// Pure: takes the list of existing IDs (directory names), returns the next
// legacy-style sequential ID — 'M001' if none exist, else max(M###) + 1.
// Timestamp-format IDs in the list are ignored (different namespace, no collision).
export function nextSequentialMilestoneId(existingIds: readonly string[] | undefined): string {
  let max = 0;
  for (const id of existingIds ?? []) {
    const m = String(id).match(/^M(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "M" + String(max + 1).padStart(3, "0");
}

// ── nextSequentialTaskId ─────────────────────────────────────────────────────
// Pure: same contract as nextSequentialMilestoneId, for legacy 'TASK-###' IDs.
export function nextSequentialTaskId(existingIds: readonly string[] | undefined): string {
  let max = 0;
  for (const id of existingIds ?? []) {
    const m = String(id).match(/^TASK-(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "TASK-" + String(max + 1).padStart(3, "0");
}

// ── classify ─────────────────────────────────────────────────────────────────
// Returns 'timestamp' for new-style IDs, 'legacy' otherwise.
// Conservative default: unknown patterns classified as 'legacy' so callers can
// handle errors via isValid() rather than crashing on unexpected input.
export function classify(id: string | null | undefined): IdClass {
  if (!id) return "legacy";
  const s = String(id);
  if (/^[MT]-\d{14}(-|$)/.test(s)) return "timestamp";
  // Dashed timestamp form: M-YYYYMMDD-HHMMSS / T-… / TASK-… (date and time
  // separated by a hyphen). Observed in the wild alongside the compact 14-digit
  // form — both encode a creation timestamp, so both classify as 'timestamp'.
  if (/^(?:M|T|TASK)-\d{8}-\d{6}(-|$)/i.test(s)) return "timestamp";
  // Legacy patterns: M005, M123, TASK-001, task-slug, etc.
  if (/^M\d+$/i.test(s)) return "legacy";
  if (/^TASK-\d+$/i.test(s)) return "legacy";
  if (/^task-/i.test(s)) return "legacy";
  // Default conservative: treat anything else as legacy
  return "legacy";
}

// ── isValid ──────────────────────────────────────────────────────────────────
export function isValid(id: string | null | undefined): boolean {
  if (!id) return false;
  const s = String(id);
  // New timestamp format — compact 14-digit (canonical generated form)
  if (/^[MT]-\d{14}(-[a-z0-9-]*)?$/.test(s)) return true;
  // Timestamp format — dashed date-time (M-YYYYMMDD-HHMMSS, T-…, TASK-…),
  // optionally followed by a slug. Read-compatible alternate of the compact form.
  if (/^(?:M|T|TASK)-\d{8}-\d{6}(-[a-z0-9-]*)?$/i.test(s)) return true;
  // Legacy formats
  if (/^M\d+$/i.test(s)) return true;
  if (/^TASK-\d+$/i.test(s)) return true;
  if (/^task-[a-z0-9-]+$/.test(s)) return true;
  return false;
}

// ── prefixGlob ───────────────────────────────────────────────────────────────
// For timestamp IDs: returns 'M-20260522143012*' (prefix + wildcard).
// For legacy IDs: returns the ID itself (exact match, no wildcard).
export function prefixGlob(id: string | null | undefined): string {
  if (!id) return String(id);
  const s = String(id);
  const m = s.match(/^([MT]-\d{14})/);
  if (m) return `${m[1]}*`;
  // Dashed timestamp form: glob on the M-YYYYMMDD-HHMMSS prefix.
  const dm = s.match(/^((?:M|T|TASK)-\d{8}-\d{6})/i);
  if (dm) return `${dm[1]}*`;
  return s; // legacy: exact match
}

// ── entityKind ───────────────────────────────────────────────────────────────
// Prefix-based detection: M prefix → milestone, T/TASK/task prefix → task.
export function entityKind(id: string | null | undefined): EntityKind {
  if (!id) return "unknown";
  const s = String(id);
  if (/^M-/.test(s) || /^M\d+$/i.test(s)) return "milestone";
  if (/^T-/.test(s) || /^TASK-/i.test(s) || /^task-/i.test(s)) return "task";
  return "unknown";
}

// ── I/O helpers — prefs cascade (via readForgePrefs) + .gsd scan ────────────
// These are the ONLY functions in this module that touch the filesystem.
// Kept separate from the pure core above so library consumers can stay pure.

/**
 * Resolves the `ids.format` pref through the S01 4-layer cascade
 * (`readForgePrefs`) — NOT a second hand-rolled reader. Invalid/absent
 * values silently fall back to 'timestamp'.
 *
 * NOTE: `prefs.ts`'s `parsePrefsBlock` is a flat `key: value` (+ dash-list)
 * reader, not a nested-YAML parser — a block like `ids:\n  format: x`
 * (indented `key: value`, no leading dash) does not parse into a nested
 * object. The representable shape under the current cascade is the flat
 * scalar key `ids: sequential`. This module reads that flat key.
 */
export function readIdFormat(cwd: string = process.cwd()): IdFormat {
  const { prefs } = readForgePrefs(cwd);
  const value = prefs["ids"];
  return value === "sequential" ? "sequential" : "timestamp";
}

// listExistingIds — collects candidate ID directory names for sequential numbering.
// Milestones: .gsd/milestones/ + .gsd/archive/ (archived ones still occupy their number).
// Tasks: .gsd/tasks/.
export function listExistingIds(cwd: string, kind: "milestone" | "task"): string[] {
  const dirs =
    kind === "milestone"
      ? [path.join(cwd, ".gsd", "milestones"), path.join(cwd, ".gsd", "archive")]
      : [path.join(cwd, ".gsd", "tasks")];
  const out: string[] = [];
  for (const d of dirs) {
    try {
      out.push(...readdirSync(d));
    } catch {
      // dir absent — skip
    }
  }
  return out;
}

// resolveMilestoneId / resolveTaskId — single entry point honoring the pref.
// formatOverride (from --format flag) wins over the pref when provided.
export function resolveMilestoneId(cwd: string, desc: string, formatOverride?: IdFormat): string {
  const format = formatOverride || readIdFormat(cwd);
  if (format === "sequential") {
    return nextSequentialMilestoneId(listExistingIds(cwd, "milestone"));
  }
  return makeMilestoneId(desc);
}

export function resolveTaskId(cwd: string, desc: string, formatOverride?: IdFormat): string {
  const format = formatOverride || readIdFormat(cwd);
  if (format === "sequential") {
    return nextSequentialTaskId(listExistingIds(cwd, "task"));
  }
  return makeTaskId(desc);
}
