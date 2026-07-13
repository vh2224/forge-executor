/**
 * Forge MEMORY ranking — decay/score/cap/promotion + deterministic render (S07/T02).
 *
 * This is a NEW design for 2.0 — NOT a wholesale port of the 1.0
 * `scripts/forge-memory.js` decay/dedup heuristics. The formulas below
 * (exponential half-life decay, confidence x hits weighting, hits-based
 * promotion threshold) are our own decision for this slice (see
 * S07-PLAN §Notes "Idempotência" and the render-purity requirement echoed
 * from `merger.ts:renderChecker`).
 *
 * Pure runtime module: only node builtins + the sibling `memory-store.js`
 * (types + list/read wrappers). No `@gsd/*` import, no `gsd/` import.
 */

import type { MemoryFact, MemoryFragment } from "./memory-store.js";
import { listMemoryFragments, readMemoryFragment } from "./memory-store.js";

/** Default max number of facts kept in a ranked selection. */
export const DEFAULT_CAP = 50;

/**
 * Default half-life (in days) used by `decayFactor`: after this many days a
 * fact's score is multiplied by 0.5. Chosen as a coarse "roughly one
 * milestone cycle" horizon for this program — not derived from the 1.0
 * script, which had no decay at all.
 */
export const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * Default `hits` threshold at/above which a fact is considered eligible for
 * promotion into a hand-curated document (e.g. CLAUDE.md, deferred to M3).
 * `promotableFacts` only computes eligibility — it never writes anything.
 */
export const DEFAULT_PROMOTION_THRESHOLD = 3;

const MS_PER_DAY = 86_400_000;

/**
 * Exponential half-life decay factor: `0.5 ^ (ageDays / halfLifeDays)`.
 * Monotonically decreasing in `ageDays`: `decayFactor(0, h) === 1`,
 * `decayFactor(h, h) === 0.5`, and it approaches 0 as `ageDays` grows.
 * Negative ages (clock skew / future `created_at`) are clamped to 0 so a
 * fact never scores ABOVE "brand new".
 */
export function decayFactor(ageDays: number, halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS): number {
  const age = ageDays < 0 ? 0 : ageDays;
  const halfLife = halfLifeDays <= 0 ? DEFAULT_HALF_LIFE_DAYS : halfLifeDays;
  return Math.pow(0.5, age / halfLife);
}

/**
 * Score a single fact at time `now` (epoch ms). Age in days is derived from
 * `created_at` (ISO string); an invalid/missing `created_at` degrades to age
 * 0 (no decay applied — we cannot penalize a fact whose age we cannot
 * determine). `hits` is floored at 1 so a never-hit fact still contributes
 * its raw `confidence`.
 */
export function scoreFact(fact: MemoryFact, now: number = Date.now(), halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS): number {
  const parsed = Date.parse(fact.created_at);
  const ageDays = Number.isNaN(parsed) ? 0 : (now - parsed) / MS_PER_DAY;
  return fact.confidence * Math.max(fact.hits, 1) * decayFactor(ageDays, halfLifeDays);
}

export interface SelectMemoryFactsOptions {
  cap?: number;
  now?: number;
  halfLifeDays?: number;
}

/**
 * Flatten all facts across `fragments`, rank by `scoreFact` descending
 * (ties broken by `id.localeCompare` ascending — deterministic regardless of
 * fragment/file-system iteration order), and truncate at `cap`.
 */
export function selectMemoryFacts(fragments: MemoryFragment[], opts: SelectMemoryFactsOptions = {}): MemoryFact[] {
  const cap = opts.cap ?? DEFAULT_CAP;
  const now = opts.now ?? Date.now();
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;

  const all = fragments.flatMap((f) => f.facts);
  const ranked = [...all].sort((a, b) => {
    const scoreDiff = scoreFact(b, now, halfLifeDays) - scoreFact(a, now, halfLifeDays);
    if (scoreDiff !== 0) return scoreDiff;
    return a.id.localeCompare(b.id);
  });
  return ranked.slice(0, cap);
}

/**
 * Facts eligible for promotion into a hand-curated document: `hits >=
 * threshold`. This ONLY computes eligibility — it never writes CLAUDE.md or
 * any other file (deferred to a future milestone, M3).
 */
export function promotableFacts(facts: MemoryFact[], threshold: number = DEFAULT_PROMOTION_THRESHOLD): MemoryFact[] {
  return facts.filter((f) => f.hits >= threshold);
}

/**
 * Render the AUTO-MEMORY projection deterministically. PURE function: same
 * `(selected, promoted)` input always yields the same byte-identical output.
 * Never prints `score`/`created_at`/`hits` — only fact text — so the
 * projection stays stable across rebuilds even as decay/hit-counts shift.
 * Header is always present; zero facts renders header-only, mirroring
 * `merger.ts:renderChecker`'s empty-state discipline.
 */
export function renderAutoMemory(selected: MemoryFact[], promoted: MemoryFact[]): string {
  const lines: string[] = ["# Forge Auto-Memory", ""];
  lines.push("> Rebuilt from fragments. Never hand-edited.");
  lines.push("");

  if (selected.length === 0) {
    lines.push("_No memory yet._");
    return lines.join("\n") + "\n";
  }

  for (const fact of selected) {
    lines.push(`- ${fact.fact}`);
  }
  lines.push("");

  lines.push(`## Elegíveis para promoção (hits ≥ ${DEFAULT_PROMOTION_THRESHOLD})`);
  lines.push("");
  if (promoted.length === 0) {
    lines.push("_nenhuma_");
  } else {
    for (const fact of promoted) {
      lines.push(`- ${fact.fact}`);
    }
  }

  return lines.join("\n") + "\n";
}

export interface LoadRankedMemoryOptions {
  cap?: number;
  now?: number;
  halfLifeDays?: number;
  promotionThreshold?: number;
}

export interface RankedMemory {
  selected: MemoryFact[];
  promoted: MemoryFact[];
}

/**
 * Read every fragment from the memory store, rank/cap the flattened facts,
 * and compute promotion eligibility. Per-fragment reads are wrapped in a
 * try/catch — an unreadable/corrupt fragment is skipped rather than
 * aborting the whole load.
 */
export function loadRankedMemory(cwd: string, opts: LoadRankedMemoryOptions = {}): RankedMemory {
  const entries = listMemoryFragments(cwd);
  const fragments: MemoryFragment[] = [];
  for (const { unitId } of entries) {
    try {
      const frag = readMemoryFragment(cwd, unitId);
      if (frag) fragments.push(frag);
    } catch {
      // unreadable/corrupt fragment — skip, never abort the whole load
    }
  }

  const selected = selectMemoryFacts(fragments, {
    cap: opts.cap,
    now: opts.now,
    halfLifeDays: opts.halfLifeDays,
  });
  const promoted = promotableFacts(selected, opts.promotionThreshold);
  return { selected, promoted };
}

/**
 * Render the lean `## Project Memory` block injected into worker prompts —
 * NOT the full AUTO-MEMORY projection header (`renderAutoMemory`'s job).
 * PURE function: same `selected` input always yields the same byte-identical
 * output. Empty `selected` yields `""` so callers can skip the section
 * entirely rather than inject a header-only stub.
 *
 * Single source of truth for this block (R2, S07-REVIEW): both
 * `composeProjectMemory` (below) and `auto/loop.ts`'s dispatch path call
 * this renderer against the SAME `selected` array computed by
 * `loadRankedMemory`, so the two callers can never drift.
 */
export function renderProjectMemoryBlock(selected: MemoryFact[]): string {
  if (selected.length === 0) return "";

  const lines: string[] = ["## Project Memory", ""];
  for (const fact of selected) {
    lines.push(`- ${fact.fact}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Compose the lean `## Project Memory` block injected into worker prompts —
 * NOT the full AUTO-MEMORY projection header (`renderAutoMemory`'s job).
 * Empty store (or no ranked facts) yields `""` so callers can skip the
 * section entirely rather than inject a header-only stub.
 */
export function composeProjectMemory(cwd: string, opts: LoadRankedMemoryOptions = {}): string {
  const { selected } = loadRankedMemory(cwd, opts);
  return renderProjectMemoryBlock(selected);
}
