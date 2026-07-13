/**
 * `auto/models-config.ts` — dedicated nested config surface for role×pool
 * routing: `{ pools, roles, constraints }`.
 *
 * D3 (S02/T01, `session.ts:218`) locks `prefs.ts`'s `parsePrefsBlock` as
 * flat-only — it must NOT grow a nested YAML shape. S03 needs a real nested
 * surface (pools of `provider/model-id`, roles of ordered pool names, flat
 * constraints), so this module owns it end to end: its own file pair, its own
 * minimal parser, its own cascade. Nothing here imports or extends
 * `parsePrefsBlock`; the two parsers are intentionally unrelated code.
 *
 * Precedence (lowest → highest), mirroring the `prefsSources`/`readForgePrefs`
 * cascade shape (file-per-layer, tolerant, synchronous) but with only the two
 * project-scope layers — pool config is repo config, not user-scope:
 *   1. .gsd/models.md        (repo, committed)
 *   2. .gsd/models.local.md  (repo, gitignored — highest precedence)
 *
 * The parser recognizes ONLY the closed shape declared in S03-PLAN §Config
 * surface — a fenced ```yaml block containing `models: { pools, roles,
 * constraints }` — via a minimal line/indentation reader. It is not a
 * general-purpose YAML implementation (no new dependency, per repo iron
 * rule); lines outside the closed shape are ignored, same tolerance
 * discipline as `parsePrefsBlock`. `roles.reviewer` and
 * `constraints.reviewer_not_author` are parsed and preserved verbatim even
 * though S03 does not consume them — forward-compat for S04.
 *
 * S06/T01 addition (diagnostic, ADDITIVE only, never throws): the parser now
 * emits named `console.warn` diagnostics for three misconfiguration shapes
 * that used to degrade silently — a duplicate key (within one block, or a
 * layer overriding an earlier one), a malformed pool ref (not exactly one
 * `/` with non-empty sides), and a role referencing a pool name absent from
 * `config.pools` (covers case mismatch too — `GPT` vs `gpt` is diagnosed as
 * "undefined pool", never silently normalized). None of these change the
 * `ModelsConfig` returned by `parseModelsConfig`/`readModelsConfig` — same
 * last-wins values as before, now with a WARN alongside. The role→pool
 * cross-validation runs once per call: inside `parseModelsConfig` for a
 * single block, and again in `readModelsConfig` on the MERGED cascade result
 * (so a role in one layer pointing at a pool defined only in another layer
 * is not a false positive) — `readModelsConfig` does not call the exported
 * `parseModelsConfig` internally for this reason, see `parseModelsConfigBlock`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ModelsConfig = {
  pools: Record<string, string[]>;
  roles: Record<string, string[]>;
  constraints: Record<string, string>;
};

export interface ModelsConfigSource {
  /** Absolute path to the models config file. */
  path: string;
  /** Short label for this cascade layer. */
  label: string;
}

/** Ordered list of the 2 cascade layers, lowest precedence first. */
export function modelsConfigSources(cwd: string = process.cwd()): ModelsConfigSource[] {
  return [
    { path: path.join(cwd, ".gsd", "models.md"), label: "repo" },
    { path: path.join(cwd, ".gsd", "models.local.md"), label: "local" },
  ];
}

export function emptyConfig(): ModelsConfig {
  return { pools: {}, roles: {}, constraints: {} };
}

/** Strips a trailing `# comment` from a line before it is matched. */
function stripComment(line: string): string {
  return line.replace(/#.*$/, "");
}

/** A well-formed pool ref has exactly one `/` with non-empty sides. */
const POOL_REF_PATTERN = /^[^/]+\/[^/]+$/;

function warnDuplicateKey(key: string, section: string, detail: string): void {
  const suffix = detail ? ` (${detail})` : "";
  console.warn(
    `[forge] models-config: duplicate key "${key}" in ${section} — last-wins, later definition overrides earlier${suffix}`,
  );
}

function warnMalformedRef(ref: string, pool: string): void {
  console.warn(
    `[forge] models-config: malformed pool ref "${ref}" in pool "${pool}" — expected "provider/model-id"`,
  );
}

function warnUndefinedPool(role: string, poolName: string): void {
  console.warn(
    `[forge] models-config: role "${role}" references undefined pool "${poolName}" — check for a typo or case mismatch`,
  );
}

function warnUnterminatedList(key: string, section: string): void {
  console.warn(
    `[forge] models-config: unterminated list for key "${key}" in ${section} — missing closing "]", stopped before the next sibling`,
  );
}

/**
 * Assigns every key of `incoming` onto `target`, warning (named, ADDITIVE)
 * when a key already present in `target` is overwritten. `detail` qualifies
 * the warn for the caller's scope (empty for a same-block merge, a layer
 * label for a cascade merge) — the resulting value is always last-wins,
 * identical to a plain `Object.assign`.
 */
function mergeSectionWithWarn<T>(
  target: Record<string, T>,
  incoming: Record<string, T>,
  section: string,
  detail: string,
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (key in target) warnDuplicateKey(key, section, detail);
    target[key] = value;
  }
}

/**
 * Reads a `pools:` or `roles:` section body starting at `lines[start]`:
 * entries are `name: [a, b]` (inline list) or `name:` followed by an
 * indented dash-list (`  - a`). Stops at the first line dedented to
 * `sectionIndent` or shallower. Unrecognized lines inside the section are
 * skipped, not fatal. A key redefined within this same section body warns
 * (named, additive) before the later definition overwrites the earlier one.
 *
 * S01/R1 fix (polimento-cockpit): an explicit empty list (`name: []`, or
 * `name:` with no dash-lines under it) is preserved in `map` as `[]`, not
 * dropped. Absent-vs-present-but-empty must stay distinguishable — a
 * `researcher:` entry is only inferred from `executor` when the key is
 * missing altogether (`role.ts`'s `resolveModelForRole`), and a
 * `models.local.md` layer must be able to override a repo-level pool with an
 * explicit empty list in the cascade merge (`readModelsConfig`). Dropping
 * empty entries made both unreachable through file-backed config.
 */
function parseListSection(
  lines: string[],
  start: number,
  sectionIndent: number,
  section: "pools" | "roles",
): { map: Record<string, string[]>; next: number } {
  const map: Record<string, string[]> = {};
  let i = start;

  while (i < lines.length) {
    const line = stripComment(lines[i]);
    if (!line.trim()) {
      i++;
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= sectionIndent) break;

    const inline = line.match(/^\s*([A-Za-z_][\w-]*):\s*\[(.*)\]\s*$/);
    if (inline) {
      const items = inline[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (inline[1] in map) warnDuplicateKey(inline[1], section, "");
      map[inline[1]] = items;
      i++;
      continue;
    }

    // Prettier-formatted flow sequence: the bracket block spans MULTIPLE
    // lines (`key: [` items… `]`, or `key:` with `[` on the next line) —
    // exactly what format-on-save produces for a long inline list. Before
    // this branch (incident 2026-07-12) that shape silently parsed as an
    // EMPTY pool and routing degraded to pool-of-one with no warning.
    const openBracket = line.match(/^\s*([A-Za-z_][\w-]*):\s*\[(.*)$/);
    if (openBracket) {
      const key = openBracket[1];
      let buf = openBracket[2];
      let j = i + 1;
      // S05/R1 fix: bound accumulation to lines more-indented than this
      // section — a dedented sibling (e.g. the next section's header) before
      // a `]` means the list is unterminated, not that it extends forever.
      // Stop and warn instead of swallowing the sibling into this value.
      while (!buf.includes("]") && j < lines.length) {
        const contLine = stripComment(lines[j]);
        if (contLine.trim() && (contLine.match(/^(\s*)/)?.[1].length ?? 0) <= sectionIndent) break;
        buf += "," + contLine;
        j++;
      }
      if (!buf.includes("]")) warnUnterminatedList(key, section);
      const items = buf
        .slice(0, buf.indexOf("]") >= 0 ? buf.indexOf("]") : buf.length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (key in map) warnDuplicateKey(key, section, "");
      map[key] = items;
      i = j;
      continue;
    }

    const listHead = line.match(/^(\s*)([A-Za-z_][\w-]*):\s*$/);
    if (listHead) {
      const keyIndent = listHead[1].length;
      const key = listHead[2];
      const items: string[] = [];
      let j = i + 1;
      // `key:` followed by a bare `[` line — the other Prettier shape.
      {
        let k = j;
        while (k < lines.length && !stripComment(lines[k]).trim()) k++;
        const peek = k < lines.length ? stripComment(lines[k]).trim() : "";
        if (peek.startsWith("[")) {
          let buf = peek.slice(1);
          let m = k + 1;
          // S05/R1 fix: same unterminated-list bound as the openBracket
          // branch above — do not cross the section's dedent boundary.
          while (!buf.includes("]") && m < lines.length) {
            const contLine = stripComment(lines[m]);
            if (contLine.trim() && (contLine.match(/^(\s*)/)?.[1].length ?? 0) <= sectionIndent) break;
            buf += "," + contLine;
            m++;
          }
          if (!buf.includes("]")) warnUnterminatedList(key, section);
          const bracketItems = buf
            .slice(0, buf.indexOf("]") >= 0 ? buf.indexOf("]") : buf.length)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (key in map) warnDuplicateKey(key, section, "");
          map[key] = bracketItems;
          i = m;
          continue;
        }
      }
      while (j < lines.length) {
        const dashLine = stripComment(lines[j]);
        const dashIndent = dashLine.match(/^(\s*)/)?.[1].length ?? 0;
        const dashMatch = dashLine.match(/^\s*-\s*(.+?)\s*$/);
        if (dashMatch && dashIndent > keyIndent) {
          items.push(dashMatch[1]);
          j++;
        } else {
          break;
        }
      }
      if (key in map) warnDuplicateKey(key, section, "");
      map[key] = items;
      i = j;
      continue;
    }

    // unrecognized line inside the section — tolerant, skip and continue.
    i++;
  }

  return { map, next: i };
}

/**
 * Reads a `constraints:` section body: flat `key: value` lines. Same
 * dedent-stop, tolerance and duplicate-key-warn rules as `parseListSection`.
 */
function parseFlatSection(
  lines: string[],
  start: number,
  sectionIndent: number,
): { map: Record<string, string>; next: number } {
  const map: Record<string, string> = {};
  let i = start;

  while (i < lines.length) {
    const line = stripComment(lines[i]);
    if (!line.trim()) {
      i++;
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= sectionIndent) break;

    const flat = line.match(/^\s*([A-Za-z_][\w-]*):\s*(.+?)\s*$/);
    if (flat) {
      if (flat[1] in map) warnDuplicateKey(flat[1], "constraints", "");
      map[flat[1]] = flat[2];
    }
    i++;
  }

  return { map, next: i };
}

/** Warns (named, additive) for every pool item that isn't `provider/model-id`. */
function warnMalformedRefs(config: ModelsConfig): void {
  for (const [poolName, refs] of Object.entries(config.pools)) {
    for (const ref of refs) {
      if (!POOL_REF_PATTERN.test(ref)) warnMalformedRef(ref, poolName);
    }
  }
}

/**
 * Warns (named, additive) for every role→pool reference where the pool name
 * is absent from `config.pools` — covers typos and case mismatch (`GPT`
 * referenced, only `gpt` defined) without normalizing either side.
 */
function warnUndefinedPools(config: ModelsConfig): void {
  for (const [role, pools] of Object.entries(config.roles)) {
    for (const poolName of pools) {
      if (!(poolName in config.pools)) warnUndefinedPool(role, poolName);
    }
  }
}

/**
 * Parses the closed `{ pools, roles, constraints }` shape out of `raw` (see
 * `parseModelsConfig` for the full contract) without the role→pool
 * cross-validation warn — used internally by `readModelsConfig` so that
 * validation runs exactly once, on the MERGED cascade result, instead of
 * once per layer (which would false-positive whenever a role and its pool
 * are defined in different layers). Still warns for duplicate keys within
 * this block and for malformed pool refs — both are per-block diagnoses,
 * not cross-layer ones.
 */
function parseModelsConfigBlock(raw: string): ModelsConfig {
  const config = emptyConfig();

  const fenced = raw.match(/```ya?ml\r?\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const lines = body.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = stripComment(lines[i]);
    const sectionHead = line.match(/^(\s*)(pools|roles|constraints):\s*$/);
    if (!sectionHead) {
      i++;
      continue;
    }

    const indent = sectionHead[1].length;
    const key = sectionHead[2] as "pools" | "roles" | "constraints";

    if (key === "constraints") {
      const { map, next } = parseFlatSection(lines, i + 1, indent);
      mergeSectionWithWarn(config.constraints, map, "constraints", "");
      i = next;
    } else {
      const { map, next } = parseListSection(lines, i + 1, indent, key);
      mergeSectionWithWarn(config[key], map, key, "");
      i = next;
    }
  }

  warnMalformedRefs(config);
  return config;
}

/**
 * Parses the closed `{ pools, roles, constraints }` shape (S03-PLAN §Config
 * surface) out of `raw` — either the whole string, or the contents of its
 * first fenced ```yaml block, if present. Recognizes only `pools:`, `roles:`
 * and `constraints:` section headers wherever they appear (no requirement
 * that they sit under a literal `models:` line — tolerant, like
 * `parsePrefsBlock`). Never throws: malformed/empty input degrades to an
 * empty `ModelsConfig`.
 *
 * S06/T01: also warns (named, additive, never throws) for a duplicate key,
 * a malformed pool ref, or a role referencing a pool absent from this same
 * block's `config.pools` — the returned `ModelsConfig` is unchanged by any
 * of these warns.
 */
export function parseModelsConfig(raw: string): ModelsConfig {
  const config = parseModelsConfigBlock(raw);
  warnUndefinedPools(config);
  return config;
}

/**
 * Resolves the 2-layer models-config cascade for `cwd`, last-wins,
 * shallow-merged per section (a key set by `models.local.md` overwrites the
 * same key from `models.md`; keys it doesn't mention pass through
 * untouched). Missing files are ignored silently; unreadable/unparseable
 * content degrades that layer to "contributed nothing" rather than
 * throwing. Returns an empty `ModelsConfig` when no layer exists — the
 * caller (S03's `resolveModelForRole`) treats that identically to the S02
 * pool-of-one baseline.
 *
 * S06/T01: warns (named, additive, never throws) when a layer overwrites a
 * key already set by an earlier layer, and runs the role→pool
 * cross-validation once on the final MERGED config (see
 * `parseModelsConfigBlock` for why per-layer validation would false-positive
 * on roles and pools split across layers).
 */
export function readModelsConfig(cwd: string = process.cwd()): ModelsConfig {
  const merged = emptyConfig();

  for (const source of modelsConfigSources(cwd)) {
    if (!existsSync(source.path)) continue;
    try {
      const raw = readFileSync(source.path, "utf8");
      const parsed = parseModelsConfigBlock(raw);
      // A later layer overriding an earlier one is the SANCTIONED cascade
      // (user → repo → local, last wins) — the whole point of models.local.md.
      // Warning here spammed every config read (statusline, dispatch, TUI —
      // operator report 2026-07-12: "duplicate key planner" on every /forge
      // command) and read as an error for a working setup. Silent merge;
      // intra-file duplicates still warn inside `parseModelsConfigBlock`.
      Object.assign(merged.pools, parsed.pools);
      Object.assign(merged.roles, parsed.roles);
      Object.assign(merged.constraints, parsed.constraints);
    } catch {
      // unreadable file — skip this layer, keep going.
    }
  }

  warnUndefinedPools(merged);
  return merged;
}
