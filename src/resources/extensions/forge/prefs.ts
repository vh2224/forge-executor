/**
 * Forge prefs — 4-layer last-wins cascade (read-only).
 *
 * Precedence (S01-PLAN §a, lowest → highest):
 *   1. ~/.claude/forge-agent-prefs.md   (legacy 1.0 compat, read-only)
 *   2. gsdHome()/prefs.md               (M1-D1 user scope: ~/.forge or ~/.gsd)
 *   3. .gsd/prefs.md                    (repo, committed)
 *   4. .gsd/prefs.local.md              (repo, gitignored — highest precedence)
 *
 * Later layers overwrite keys set by earlier layers (shallow merge). Missing
 * layers are ignored without error. Unknown keys (e.g. `retry:`, forward for
 * S03) are tolerated — the parser is a minimal regex-based block reader, not
 * a YAML implementation (no new dependency).
 *
 * D3: this module only reads. The single writer of forge state is the S02 store.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gsdHome } from "../shared/compat/gsd-home.js";

export type ForgePrefs = Record<string, string | string[]>;

export interface PrefsSource {
  /** Absolute path to the prefs file. */
  path: string;
  /** Short label used in `/forge status` output. */
  label: string;
}

/** Ordered list of the 4 cascade layers, lowest precedence first. */
export function prefsSources(cwd: string = process.cwd()): PrefsSource[] {
  return [
    { path: path.join(os.homedir(), ".claude", "forge-agent-prefs.md"), label: "legacy ~/.claude" },
    { path: path.join(gsdHome(), "prefs.md"), label: "user (gsdHome)" },
    { path: path.join(cwd, ".gsd", "prefs.md"), label: "repo" },
    { path: path.join(cwd, ".gsd", "prefs.local.md"), label: "local" },
  ];
}

/**
 * Parses flat `key: value` lines and indented list blocks
 * (`key:\n  - a\n  - b`) into a shallow object. Unrecognized lines are
 * ignored — this is intentionally not a general YAML parser.
 */
export function parsePrefsBlock(raw: string): ForgePrefs {
  const out: ForgePrefs = {};
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const flat = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.+?)[ \t]*$/);
    const listHead = line.match(/^([A-Za-z_][\w-]*):[ \t]*$/);

    if (listHead) {
      const key = listHead[1];
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^[ \t]+-[ \t]*(.+?)[ \t]*$/.test(lines[j])) {
        const m = lines[j].match(/^[ \t]+-[ \t]*(.+?)[ \t]*$/);
        if (m) items.push(m[1]);
        j++;
      }
      if (items.length > 0) {
        out[key] = items;
        i = j - 1;
        continue;
      }
      // no indented list items followed — fall through, leave key unset.
      continue;
    }

    if (flat) {
      out[flat[1]] = flat[2];
    }
  }

  return out;
}

export interface ReadForgePrefsResult {
  prefs: ForgePrefs;
  /** Sources that existed and were readable, in precedence order (lowest→highest). */
  contributing: PrefsSource[];
}

/**
 * Resolves the 4-layer prefs cascade for `cwd`, last-wins. Missing files are
 * ignored silently; unreadable/unparseable content degrades to "contributed
 * nothing" rather than throwing. Returns `{}` when no layer exists.
 */
export function readForgePrefs(cwd: string = process.cwd()): ReadForgePrefsResult {
  const merged: ForgePrefs = {};
  const contributing: PrefsSource[] = [];

  for (const source of prefsSources(cwd)) {
    if (!existsSync(source.path)) continue;
    try {
      const raw = readFileSync(source.path, "utf8");
      const parsed = parsePrefsBlock(raw);
      Object.assign(merged, parsed);
      contributing.push(source);
    } catch {
      // unreadable file — skip this layer, keep going.
    }
  }

  return { prefs: merged, contributing };
}
