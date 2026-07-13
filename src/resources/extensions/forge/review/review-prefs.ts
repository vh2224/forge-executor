/**
 * Review prefs — nested `review:` block reader (Step 0 of the 1.0 review gate,
 * ported to a native cascade reader).
 *
 * Reuses `prefsSources(cwd)` from `../prefs.js` for the ordered list of cascade
 * files (legacy ~/.claude → user gsdHome → repo .gsd/prefs.md → repo
 * .gsd/prefs.local.md, last-wins). The **parsing** of the `review:` block is
 * intentionally separate from `parsePrefsBlock` in `prefs.ts`: that parser is
 * flat-only (decision #23) and reads top-level `key: value` / `key:\n  - a`
 * shapes. The `review:` block is a *nested* map (`review:\n  mode: enabled\n`),
 * which the flat parser cannot represent — so this module runs its own regex
 * extraction, mirroring the Step 0 script from `shared/forge-review.md` in the
 * 1.0 methodology, over the same cascade files.
 *
 * Two deliberate divergences from the 1.0 script (both are D-S05-6, in-scope
 * for the roadmap's reduced review surface):
 *   1. `rounds` is clamped to **0..1** here, not 0..3. The roadmap only ships a
 *      single review pass (0 = skip, 1 = one pass); multi-round debate loops
 *      from 1.0 are out of scope for this milestone.
 *   2. `style` and `engine` are parsed-and-ignored: `style: flags` (legacy
 *      single-pass mode) and `engine: workflow` (Workflow-tool routing) are
 *      1.0-only surface with no native equivalent in this harness yet. They
 *      are still recognized (so cascade files that set them don't cause the
 *      block to fail to parse) but do not appear on `ReviewPrefs`.
 */

import { existsSync, readFileSync } from "node:fs";
import { prefsSources } from "../prefs.js";

export interface ReviewPrefs {
  mode: "enabled" | "disabled";
  rounds: 0 | 1;
  askInAuto: "defer" | "pause";
  fixConceded: boolean;
}

const DEFAULTS: ReviewPrefs = {
  mode: "enabled",
  rounds: 1,
  askInAuto: "defer",
  fixConceded: true,
};

/** Matches the whole nested `review:` block (key + all indented child lines). */
const BLOCK_RE = /^review:[ \t]*\n((?:[ \t]+.*\n?)*)/m;

interface RawReviewFields {
  mode?: string;
  rounds?: string;
  askInAuto?: string;
  fixConceded?: string;
  // style/engine are extracted (so their presence doesn't confuse other
  // matches) but deliberately not surfaced on ReviewPrefs — see module doc.
  style?: string;
  engine?: string;
}

/** Extracts the raw (unvalidated) key/value pairs from one file's `review:` block. */
function parseReviewBlock(raw: string): RawReviewFields {
  const blockMatch = raw.match(BLOCK_RE);
  const block = blockMatch?.[1] ?? "";
  const fields: RawReviewFields = {};

  const mode = block.match(/^[ \t]+mode:[ \t]*(\w+)/m);
  if (mode) fields.mode = mode[1].toLowerCase();

  const style = block.match(/^[ \t]+style:[ \t]*(\w+)/m);
  if (style) fields.style = style[1].toLowerCase();

  const rounds = block.match(/^[ \t]+rounds:[ \t]*(\d+)/m);
  if (rounds) fields.rounds = rounds[1];

  const askInAuto = block.match(/^[ \t]+ask_in_auto:[ \t]*(\w+)/m);
  if (askInAuto) fields.askInAuto = askInAuto[1].toLowerCase();

  const fixConceded = block.match(/^[ \t]+fix_conceded:[ \t]*(\w+)/m);
  if (fixConceded) fields.fixConceded = fixConceded[1].toLowerCase();

  const engine = block.match(/^[ \t]+engine:[ \t]*(\w+)/m);
  if (engine) fields.engine = engine[1].toLowerCase();

  return fields;
}

/**
 * Reads the `review:` block across the prefs cascade for `cwd`, merging
 * last-wins **per key** (a file that only sets `rounds` does not reset
 * `mode` from an earlier layer). Missing files, unreadable files, and files
 * with no `review:` block are silently skipped — this function never throws.
 */
export function readReviewPrefs(cwd: string = process.cwd()): ReviewPrefs {
  const merged: RawReviewFields = {};

  for (const source of prefsSources(cwd)) {
    if (!existsSync(source.path)) continue;
    try {
      const raw = readFileSync(source.path, "utf8");
      const fields = parseReviewBlock(raw);
      Object.assign(merged, fields);
    } catch {
      // unreadable/malformed file — skip this layer, keep going.
    }
  }

  return validate(merged);
}

/** Applies 1.0-parity fallback-to-default validation, plus the D-S05-6 rounds clamp. */
function validate(fields: RawReviewFields): ReviewPrefs {
  const mode: ReviewPrefs["mode"] =
    fields.mode === "enabled" || fields.mode === "disabled" ? fields.mode : DEFAULTS.mode;

  const askInAuto: ReviewPrefs["askInAuto"] =
    fields.askInAuto === "defer" || fields.askInAuto === "pause" ? fields.askInAuto : DEFAULTS.askInAuto;

  const fixConceded = fields.fixConceded === undefined ? DEFAULTS.fixConceded : fields.fixConceded !== "false";

  let rounds: ReviewPrefs["rounds"] = DEFAULTS.rounds;
  if (fields.rounds !== undefined) {
    const parsed = Number.parseInt(fields.rounds, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      // D-S05-6: clamp to 0..1 (1.0 clamps to 0..3 — divergence is deliberate,
      // out-of-scope multi-round debate loops are not shipped by this roadmap).
      rounds = parsed > 1 ? 1 : (parsed as 0 | 1);
    }
  }

  return { mode, rounds, askInAuto, fixConceded };
}
