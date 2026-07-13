/**
 * `ui/identity.ts` — pure identity-derivation core shared by the strip
 * (unit-panel) and the footer (queue-widget) (S04/T01).
 *
 * ── Pure (no filesystem, no `pi`/`ctx`, no singleton import) ────────────────
 * Every helper takes the `ForgeAutoSession` instance as a parameter, so it is
 * testable against synthetic instances — never the module-level singleton.
 *
 * ── Never fabricates a model (G1) ────────────────────────────────────────────
 * `unitIdentity` reads ONLY already-published container fields, in strict
 * precedence: `appliedUnitModel` (gated by `appliedUnitModelToken ===
 * currentRendezvousToken` — a stale hook must never author a later dispatch),
 * then `resolvedDispatchAuthor.model`, then `null`. A `null` model is a valid
 * outcome — `formatIdentity` OMITS the segment entirely rather than render an
 * empty/fabricated placeholder.
 *
 * ── Review precedence (D16/M1R-1) ────────────────────────────────────────────
 * While `ForgeAutoSession.reviewActivity` is published, `currentIdentity`
 * prefers it over the unit identity — an in-flight dialectic turn is what the
 * operator is watching, even if a unit is nominally current.
 */

import type { ComposableUnit } from "../prompts/compose.js";
import { roleForUnit, type Role } from "../auto/role.js";
import { unitSlice } from "../state/index.js";
import type { ForgeAutoSession } from "../auto/session.js";

/** The turn label published on `ForgeAutoSession.reviewActivity` (T02) — distinct from the dispatch `Role`. */
type ReviewTurnRole = NonNullable<ForgeAutoSession["reviewActivity"]>["role"];

/** Every role label `currentIdentity` can surface — a dispatch `Role` or a review turn. */
export type IdentityRole = Role | ReviewTurnRole;

/**
 * Role → single-cell glyph. `challenger`/`advocate`/`rebuttal` (review turns)
 * and the dispatch `Role` `"advocate"` (direct dialectic dispatch) share `⚖`
 * (scales) — both are the same adversarial-review activity, just reached by
 * different callers. Remaining `Role` values, chosen for legibility:
 * `completer` → `✓` (wraps up a unit), `reviewer` → `◎` (inspects),
 * `researcher` → `⚗` (investigates). Typed as `Record<IdentityRole, string>`
 * so a future `Role`/turn addition fails to compile until glyphed here.
 */
const ROLE_GLYPH: Record<IdentityRole, string> = {
  executor: "⚒",
  planner: "✎",
  completer: "✓",
  reviewer: "◎",
  advocate: "⚖",
  researcher: "⚗",
  challenger: "⚖",
  rebuttal: "⚖",
};

/** The identity segments `formatIdentity` renders — the contract, not the exact prose. */
export interface Identity {
  glyph: string;
  role: IdentityRole;
  /** Short model label, or `null` when unknown — never a fabricated string (G1). */
  model: string | null;
  unitLabel: string;
}

/**
 * `provider/model-id` → short display label. `null` in → `null` out. Segment
 * after the FIRST `/` (no `/` → the ref itself); a redundant leading
 * `claude-` is stripped when a non-empty remainder follows (so a bare
 * `"claude-"` never collapses to an empty label).
 */
export function shortModelLabel(ref: string | null): string | null {
  if (ref === null) return null;
  const slash = ref.indexOf("/");
  const seg = slash === -1 ? ref : ref.slice(slash + 1);
  if (seg.startsWith("claude-")) {
    const stripped = seg.slice("claude-".length);
    if (stripped.length > 0) return stripped;
  }
  return seg;
}

/** Terse label for a unit — `S##/T##` for `execute-task`, else `<type> <unitSlice(unit)>`. Mirrors `unit-panel.ts`'s `describeUnit`. */
export function unitLabel(unit: ComposableUnit): string {
  return unit.type === "execute-task" ? `${unit.slice}/${unit.task}` : `${unit.type} ${unitSlice(unit)}`;
}

/**
 * Derive the in-flight UNIT's identity from already-published container
 * fields. `null` when no unit is current (idle). Model precedence: the
 * token-gated `appliedUnitModel`, then `resolvedDispatchAuthor.model`, then
 * `null` — never fabricated (G1).
 */
export function unitIdentity(s: ForgeAutoSession): Identity | null {
  const unit = s.currentUnit;
  if (!unit) return null;

  const role = roleForUnit(unit);
  const gatedApplied =
    s.appliedUnitModelToken !== null && s.appliedUnitModelToken === s.currentRendezvousToken
      ? s.appliedUnitModel
      : null;
  const model = gatedApplied ?? s.resolvedDispatchAuthor?.model ?? null;

  return {
    glyph: ROLE_GLYPH[role],
    role,
    model: shortModelLabel(model),
    unitLabel: unitLabel(unit),
  };
}

/** Derive the in-flight REVIEW turn's identity from `s.reviewActivity`. `null` when no review is in flight. */
export function reviewIdentity(s: ForgeAutoSession): Identity | null {
  const activity = s.reviewActivity;
  if (!activity) return null;

  return {
    glyph: ROLE_GLYPH[activity.role],
    role: activity.role,
    model: shortModelLabel(activity.model),
    unitLabel: activity.scope,
  };
}

/** The identity to display right now — review precedes unit (D16/M1R-1); `null` when idle. */
export function currentIdentity(s: ForgeAutoSession): Identity | null {
  return reviewIdentity(s) ?? unitIdentity(s);
}

/** `<glyph> <role> · <model> · <unitLabel>` — the model segment is OMITTED (never rendered empty) when `model` is `null`. */
export function formatIdentity(id: Identity): string {
  const segments = [`${id.glyph} ${id.role}`];
  if (id.model !== null) segments.push(id.model);
  segments.push(id.unitLabel);
  return segments.join(" · ");
}
