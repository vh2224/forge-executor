/**
 * Forge migrate — `<mid>-ROADMAP.md` layout classifier + forge 1.0 slice parser.
 *
 * `forge migrate` (S03) needs to know, for a given `cwd`/`milestoneId`, which
 * physical shape of `<mid>-ROADMAP.md` it is looking at:
 *   - the 2.0-native "## Slices" pipe table (state/parse.ts:parseRoadmap
 *     already reads this — `deriveNextUnit` consumes its output directly)
 *   - the forge 1.0 prose+checkbox shape (`- [ ]/[x] **S01: Título**
 *     \`risk:X\` \`depends:[...]\`` inside "## Slices")
 *   - absent, or a shape neither of the above recognizes
 *
 * This module only classifies/parses — it never writes, never mutates, and
 * never throws (a migration dry-run must survive a directory tree it doesn't
 * fully understand, same discipline as `state-layout.ts`/`prefs-layout.ts`,
 * S01).
 *
 * Pure module: node builtins + `state/parse.ts:parseRoadmap` only (reused for
 * the pipe-table structural check, not reimplemented — see key_links in
 * T01-PLAN).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRoadmap } from "../state/parse.js";

export type RoadmapLayoutKind = "absent" | "twoPointZero" | "prose1x" | "unknown";

export interface RoadmapLayoutFinding {
  kind: RoadmapLayoutKind;
  path: string;
  detail: string;
}

export interface Roadmap1xSlice {
  id: string;
  name: string;
  risk: string;
  depends: string[];
  done: boolean;
}

const SLICES_HEADER = "## Slices";
/**
 * `- [ ]` / `- [x]` / `- [X]` **S01: Título** — the forge 1.0 slice-line anchor.
 * The name group is non-greedy up to the literal closing `**` (rather than
 * `[^*]+`) because real titles can carry a single literal `*` inside a
 * backtick span (e.g. `` `advisor.*` ``, seen in a real M003 fixture) —
 * excluding `*` outright would refuse to match those lines at all.
 */
const SLICE_LINE = /^-\s*\[([ xX])\]\s*\*\*(S\d+):\s*(.+?)\*\*/;
const RISK_TAG = /`risk:(\w+)`/;
const DEPENDS_TAG = /`depends:\[([^\]]*)\]`/;

/**
 * Slice the "## Slices" section out of a raw ROADMAP.md: everything after a
 * line starting with `## Slices` (tolerating a trailing suffix, e.g.
 * `## Slices (ordenados por afinidade...)`) up to — but not including — the
 * next line starting with `## `. Returns `""` when no such header exists.
 */
function extractSlicesSection(raw: string): string {
  const lines = raw.split("\n");
  const startIdx = lines.findIndex((line) => line.trim().startsWith(SLICES_HEADER));
  if (startIdx === -1) return "";

  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((line) => line.trim().startsWith("## "));
  const sectionLines = endIdx === -1 ? rest : rest.slice(0, endIdx);
  return sectionLines.join("\n");
}

/**
 * Parse the forge 1.0 prose+checkbox "## Slices" section into
 * `Roadmap1xSlice[]`, in order of appearance. A line matching the checkbox+id
 * anchor but missing a recognizable `risk:`/`depends:` tag on the SAME line
 * is skipped (not aborted) — same degrade-on-malformed discipline as the real
 * 2.0 parsers (`parseDecisionFragment` etc., S01/T03). Never throws.
 */
export function parseRoadmap1x(raw: string): Roadmap1xSlice[] {
  const section = extractSlicesSection(raw);
  if (section === "") return [];

  const slices: Roadmap1xSlice[] = [];

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    const sliceMatch = SLICE_LINE.exec(trimmed);
    if (!sliceMatch) continue;

    const riskMatch = RISK_TAG.exec(trimmed);
    const dependsMatch = DEPENDS_TAG.exec(trimmed);
    if (!riskMatch || !dependsMatch) continue;

    const [, checkbox, id, name] = sliceMatch;
    const dependsRaw = dependsMatch[1].trim();
    const depends = dependsRaw === "" ? [] : dependsRaw.split(",").map((s) => s.trim()).filter(Boolean);

    slices.push({
      id,
      name: name.trim(),
      risk: riskMatch[1],
      depends,
      done: checkbox.toLowerCase() === "x",
    });
  }

  return slices;
}

/**
 * Classify `<cwd>/.gsd/milestones/<milestoneId>/<milestoneId>-ROADMAP.md`.
 *
 * Order of checks: absent first, then the 2.0-native pipe table (via
 * `parseRoadmap` — the SAME structural check `deriveNextUnit`'s real input
 * relies on, not a second divergent heuristic), then the 1.0 prose+checkbox
 * shape (via `parseRoadmap1x` above), then unknown.
 */
export function classifyRoadmapLayout(cwd: string, milestoneId: string): RoadmapLayoutFinding {
  const path = join(cwd, ".gsd", "milestones", milestoneId, `${milestoneId}-ROADMAP.md`);

  if (!existsSync(path)) {
    return { kind: "absent", path, detail: `não existe ${milestoneId}-ROADMAP.md neste milestone` };
  }

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { kind: "unknown", path, detail: "arquivo existe mas não pôde ser lido" };
  }

  if (parseRoadmap(content).length > 0) {
    return {
      kind: "twoPointZero",
      path,
      detail: "seção \"## Slices\" em tabela pipe reconhecível por parseRoadmap (formato 2.0-nativo)",
    };
  }

  if (parseRoadmap1x(content).length > 0) {
    return {
      kind: "prose1x",
      path,
      detail: "seção \"## Slices\" em prosa+checkbox `- [ ]/[x] **S##: Título** `risk:X` `depends:[...]`` (formato forge 1.0)",
    };
  }

  return { kind: "unknown", path, detail: "conteúdo não bate nenhum padrão conhecido de ROADMAP.md" };
}
