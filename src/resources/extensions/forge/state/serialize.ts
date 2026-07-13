/**
 * Forge state serializer — STATE.md writer for the 2.0 format the store defines
 * (a ```` ```yaml ```` fenced block, NOT frontmatter — Pitfall 3).
 *
 * `serializeState` is the round-trip counterpart of `parseState`: for any
 * `StateDoc` sample, `parseState(serializeState(x))` must deep-equal `x`.
 * `phase` is derived/serialized for read-compat/debug convenience — never a
 * separate source of truth (M1-D4).
 *
 * Pure module: no filesystem/OS dependency, no `@gsd/*` runtime import.
 */

import type { StateDoc } from "./types.js";

/**
 * Quote a scalar string when it contains characters that would otherwise be
 * ambiguous to the flat `key: value` reader (`parseFrontmatterMap`) — a colon,
 * a leading `#` comment marker, or leading/trailing whitespace/emptiness.
 * Uses `JSON.stringify` for standard double-quote escaping.
 */
function serializeScalar(value: string): string {
  if (value === "" || /[:#]/.test(value) || value !== value.trim()) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Serialize a `StateDoc` to STATE.md markdown with a fenced ```yaml block.
 * Keys are written in canonical order: milestone, phase, current_slice,
 * next_action, units.
 */
export function serializeState(doc: StateDoc): string {
  const lines: string[] = [];

  lines.push(`milestone: ${serializeScalar(doc.milestone)}`);

  if (doc.phase !== undefined) {
    lines.push(`phase: ${serializeScalar(doc.phase)}`);
  }
  if (doc.current_slice !== undefined) {
    lines.push(`current_slice: ${serializeScalar(doc.current_slice)}`);
  }
  if (doc.next_action !== undefined) {
    lines.push(`next_action: ${serializeScalar(doc.next_action)}`);
  }
  if (doc.units !== undefined) {
    if (doc.units.length === 0) {
      lines.push("units: []");
    } else {
      lines.push("units:");
      for (const unit of doc.units) {
        lines.push(`  - id: ${serializeScalar(unit.id)}`);
        lines.push(`    type: ${serializeScalar(unit.type)}`);
        lines.push(`    status: ${serializeScalar(unit.status)}`);
        if (unit.slice !== undefined) {
          lines.push(`    slice: ${serializeScalar(unit.slice)}`);
        }
      }
    }
  }

  const yamlBlock = lines.join("\n");

  return `# STATE\n\n\`\`\`yaml\n${yamlBlock}\n\`\`\`\n`;
}
