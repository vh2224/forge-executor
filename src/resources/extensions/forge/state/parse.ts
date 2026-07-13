/**
 * Forge state parsers — read-compat with the forge 1.0 markdown artifact layout.
 *
 * Exports:
 *   parseState(md)    → StateDoc   (fenced ```yaml block — the 2.0 STATE.md format)
 *   parseRoadmap(md)  → RoadmapSlice[]  (the "## Slices" table)
 *   parsePlan(md)     → PlanDoc    (frontmatter + must_haves via must-haves.ts)
 *   parseSummary(md)  → SummaryDoc (frontmatter)
 *
 * All four tolerate missing optional fields without throwing — malformed/absent
 * shapes degrade to defaults rather than raising, so a dispatch loop reading a
 * mixed fleet of 1.0 artifacts stays resilient (A6).
 *
 * Pure module: no filesystem/OS dependency, no `@gsd/*` runtime import.
 */

import { splitFrontmatter, parseFrontmatterMap } from "../../shared/frontmatter.js";
import { hasStructuredMustHaves, parseMustHaves } from "./must-haves.js";
import type { StateDoc, StateUnit, RoadmapSlice, PlanDoc, SummaryDoc } from "./types.js";

// ── parseState ────────────────────────────────────────────────────────────────

/**
 * Extract the first ```` ```yaml ... ``` ```` fenced block and parse its keys.
 * This is the 2.0 STATE.md format the store defines — NOT frontmatter (Pitfall 3).
 * The live `.gsd/STATE.md` (forge 1.0 dashboard) is a different, unrelated format
 * and is intentionally NOT parseable by this function.
 */
/**
 * State-local unescape for scalars written by `serializeScalar` (serialize.ts),
 * which quotes ambiguous values via `JSON.stringify`. `parseFrontmatterMap`
 * (shared) only strips the surrounding quote characters and does NOT unescape
 * `\"`/`\\`/`\n`, so any StateDoc scalar containing a literal `"` or `\` would
 * otherwise round-trip corrupted. Kept local to `parseState` (rather than
 * changing the shared `stripQuotes`) to avoid altering frontmatter semantics
 * for other consumers of `shared/frontmatter.ts` (e.g. must-haves.ts, ttsr).
 *
 * `parseFrontmatterMap` already stripped the surrounding quotes by the time
 * this runs, so we re-add them and attempt `JSON.parse`; on failure (e.g. the
 * value was never actually JSON-quoted — a hand-written STATE.md) fall back to
 * the value as-is.
 */
function unescapeStateScalar(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

export function parseState(md: string): StateDoc {
  const match = md.match(/```yaml\n([\s\S]*?)```/);
  if (!match) {
    return { milestone: "" };
  }
  const block = match[1].replace(/\n$/, "");
  const lines = block.split("\n");
  const map = parseFrontmatterMap(lines);

  const doc: StateDoc = {
    milestone: typeof map.milestone === "string" ? unescapeStateScalar(map.milestone) : "",
  };
  if (typeof map.phase === "string") doc.phase = unescapeStateScalar(map.phase);
  if (typeof map.current_slice === "string") doc.current_slice = unescapeStateScalar(map.current_slice);
  if (typeof map.next_action === "string") doc.next_action = unescapeStateScalar(map.next_action);

  if (Array.isArray(map.units)) {
    const units: StateUnit[] = [];
    for (const raw of map.units) {
      if (raw && typeof raw === "object") {
        const u = raw as Record<string, unknown>;
        if (typeof u.id === "string" && typeof u.type === "string" && typeof u.status === "string") {
          units.push({
            id: u.id,
            type: u.type as StateUnit["type"],
            status: u.status as StateUnit["status"],
            ...(typeof u.slice === "string" ? { slice: u.slice } : {}),
          });
        }
      }
    }
    doc.units = units;
  }

  return doc;
}

// ── parseRoadmap ──────────────────────────────────────────────────────────────

/**
 * Parse the "## Slices" markdown table into RoadmapSlice[]. Tolerates:
 *   - header/separator rows (skipped)
 *   - `**high**` bold-wrapped risk values (unwrapped)
 *   - empty/`—` depends → []
 *   - multi-value depends ("S01, S02") → ["S01", "S02"]
 */
export function parseRoadmap(md: string): RoadmapSlice[] {
  const lines = md.split("\n");
  const slices: RoadmapSlice[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;

    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 5) continue;

    const [id, name, risk, depends, status] = cells;

    // Skip header row ("ID" literal) and separator rows (all dashes/colons)
    if (id.toLowerCase() === "id") continue;
    if (/^:?-+:?$/.test(id)) continue;
    // Only accept rows whose ID cell looks like a slice ID (e.g. S01)
    if (!/^S\d+/i.test(id)) continue;

    const cleanRisk = risk.replace(/\*\*/g, "").trim();

    let dependsList: string[] = [];
    if (depends && depends !== "—" && depends !== "-") {
      dependsList = depends
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    slices.push({ id, name, risk: cleanRisk, depends: dependsList, status });
  }

  return slices;
}

// ── parsePlan ─────────────────────────────────────────────────────────────────

/**
 * Parse a T##-PLAN.md / S##-PLAN.md. Uses `splitFrontmatter` (shared) for the
 * frontmatter map, and `must-haves.ts` for the structured `must_haves:` block
 * when present. S##-PLAN.md files historically carry NO frontmatter at all
 * (free-text slice plans) — this degrades to an empty-defaults PlanDoc rather
 * than throwing.
 */
export function parsePlan(md: string): PlanDoc {
  const [fmLines] = splitFrontmatter(md);
  if (!fmLines) {
    return { id: "", depends: [] };
  }
  const map = parseFrontmatterMap(fmLines);

  const doc: PlanDoc = {
    id: typeof map.id === "string" ? map.id : "",
    depends: Array.isArray(map.depends) ? (map.depends.filter((d) => typeof d === "string") as string[]) : [],
  };
  if (typeof map.slice === "string") doc.slice = map.slice;
  if (typeof map.milestone === "string") doc.milestone = map.milestone;
  if (typeof map.title === "string") doc.title = map.title;
  if (Array.isArray(map.writes)) {
    doc.writes = map.writes.filter((w) => typeof w === "string") as string[];
  }

  if (hasStructuredMustHaves(md)) {
    doc.mustHaves = parseMustHaves(md);
  }

  return doc;
}

// ── parseSummary ──────────────────────────────────────────────────────────────

/**
 * Parse an S##-SUMMARY.md / T##-SUMMARY.md frontmatter block.
 */
export function parseSummary(md: string): SummaryDoc {
  const [fmLines] = splitFrontmatter(md);
  if (!fmLines) {
    return { id: "", provides: [], key_files: [] };
  }
  const map = parseFrontmatterMap(fmLines);

  return {
    id: typeof map.id === "string" ? map.id : "",
    provides: Array.isArray(map.provides) ? (map.provides.filter((p) => typeof p === "string") as string[]) : [],
    key_files: Array.isArray(map.key_files)
      ? (map.key_files.filter((k) => typeof k === "string") as string[])
      : [],
  };
}
