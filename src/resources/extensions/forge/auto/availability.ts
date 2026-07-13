/**
 * `auto/availability.ts` — the injectable availability predicate the
 * "filtrar" step of `resolveModelForRole` (T03) consults to decide whether a
 * candidate `provider/model-id` ref is usable.
 *
 * S03 scope: synthetic + fork-side only. This module does NOT import
 * `forge-agent-core` (`isProviderAvailable`/`getCredentialsForProvider`,
 * `fallback-resolver.ts:144`) — that cross-build-boundary coupling (real
 * credentials via `AuthStorage`) is S06's gap, documented but not exercised
 * here (S03-PLAN §Availability). With no probe injected, every ref is
 * available — the absence-of-config path stays byte-identical to S02's
 * pool-of-one body, which never filters anything.
 */

/**
 * A synthetic availability predicate: given a flat `provider/model-id` ref
 * (the same shape `resolveUnitModel` returns, e.g. `"openai/gpt-5.5"`),
 * returns whether that ref should be treated as available. Tests inject one
 * to mark specific refs unavailable and drive the filter step without any
 * real credential lookup.
 */
export type AvailabilityProbe = (ref: string) => boolean;

/**
 * Whether `ref` (a flat `provider/model-id` string) is available.
 *
 * - No `probe` → `true` unconditionally — the default-permissive baseline
 *   that keeps the no-config path identical to S02 (nothing gets filtered
 *   out when no synthetic override is injected).
 * - `probe` present → delegates entirely to it; the probe decides.
 */
export function isModelAvailable(ref: string, probe?: AvailabilityProbe): boolean {
  if (!probe) return true;
  return probe(ref);
}

/**
 * Convenience constructor: builds an `AvailabilityProbe` that treats every
 * ref in `unavailableRefs` as unavailable and every other ref as available.
 * Not required by the minimal contract (a bare function IS a valid probe),
 * but the common shape synthetic tests reach for — "these N refs are down,
 * everything else is fine" — so it lives here once rather than being
 * re-inlined per test.
 */
export function unavailableRefsProbe(unavailableRefs: Iterable<string>): AvailabilityProbe {
  const blocked = new Set(unavailableRefs);
  return (ref: string) => !blocked.has(ref);
}
