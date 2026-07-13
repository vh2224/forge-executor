/**
 * `auto/model-capabilities.ts` — pure fork-side data table for the D6 rank
 * (S05): tier ordinal, capability score, relative cost, and flat-rate flag
 * per provider/ref. `auto/model-rank.ts` (T02) composes these primitives
 * into the actual tier×capability×cost ordering; this module owns only the
 * declarative data plus tolerant getters over it — no ranking policy lives
 * here.
 *
 * There is no capability table in the fork prior to this task. The only
 * `provider-capabilities.ts` in the repo is `packages/pi-ai/src/providers/
 * provider-capabilities.ts`, and it is about tool-calling compatibility
 * (`toolCalling`, `maxTools`, `toolCallIdFormat`, `structuredOutput`), not
 * tier/cost/capability for routing. It is used here only as a *shape*
 * reference — declarative registry map + a tolerant getter that degrades to
 * a permissive default instead of throwing (`getProviderCapabilities`) — and
 * is deliberately NOT imported: the content (tiers, capability scores, cost
 * ranks) is new, fork-side, and synthetic.
 *
 * Pure module: no `pi-ai`, no `forge-agent-core`, no `fs`/network/OS access,
 * no `Date`, no `Math.random`. Every getter is deterministic — same ref/
 * provider in, same value out — and none of them ever throws; an unknown
 * ref or provider degrades to a declared default rather than raising.
 */

/**
 * The 4 tiers the planner's `plan-slice.ts` frontmatter contract emits
 * (`prompts/plan-slice.ts:154-163`, `tier: light|standard|heavy|max`,
 * default `standard` when omitted). Ordered strictly `light < standard <
 * heavy < max` so the rank can compare tiers with a plain integer
 * comparison (downgrade-only: never rank above the pool's declared
 * tier-teto).
 */
export type Tier = "light" | "standard" | "heavy" | "max";

/**
 * `Tier` → ordinal, comparable for downgrade-only rank logic. Lower ordinal
 * = lighter/cheaper tier. This is the ONLY place tier ordering is declared —
 * `auto/model-rank.ts` compares ordinals via this map, never a hand-rolled
 * `light|standard|heavy|max` string comparison.
 */
export const TIER_ORDINAL: Record<Tier, number> = {
  light: 0,
  standard: 1,
  heavy: 2,
  max: 3,
};

/**
 * Per-ref capability profile: declared tier, capability score, and relative
 * cost. Keyed by the full `provider/model-id` ref, matching the format
 * `resolveModelForRole`/`role.ts` already uses for pool entries.
 *
 * Numbers are ILLUSTRATIVE/SYNTHETIC, not measured — declared fork-side for
 * the 2 fake families this milestone proves the routing mechanics with
 * (`role-pool.test.ts`/CONTEXT §config): `claude-code/*` and `openai/*`.
 * `capability` is higher-is-more-capable; `cost` is higher-is-more-expensive
 * (a relative unit, not a real price). Within each family the flagship ref
 * (`claude-opus-4-8`, `gpt-5.5`) sits at a higher tier/capability/cost than
 * the lighter sibling (`claude-sonnet-5`, `gpt-5-mini`), so the D6 rank has
 * a real downgrade path to exercise inside each pool.
 */
export interface ModelCapabilityProfile {
  tier: Tier;
  capability: number;
  cost: number;
}

/**
 * The declarative capability table. Only the refs exercised by this
 * milestone's synthetic 2-family proof are populated; any other ref falls
 * through to the tolerant defaults below via `tierOf`/`capabilityScore`/
 * `costRank`.
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapabilityProfile> = {
  "claude-code/claude-opus-4-8": { tier: "max", capability: 95, cost: 90 },
  "claude-code/claude-sonnet-5": { tier: "standard", capability: 70, cost: 35 },
  "openai/gpt-5.5": { tier: "max", capability: 90, cost: 85 },
  "openai/gpt-5-mini": { tier: "light", capability: 45, cost: 15 },
};

/**
 * Default profile for a ref not present in `MODEL_CAPABILITIES` — a
 * permissive-but-deterministic middle ground (mirrors
 * `getProviderCapabilities`'s `DEFAULT_CAPABILITIES` philosophy: degrade
 * gracefully rather than throw or silently rank an unknown ref as either
 * the best or the worst available option).
 */
const DEFAULT_MODEL_CAPABILITY: ModelCapabilityProfile = {
  tier: "standard",
  capability: 1,
  cost: 1,
};

/**
 * Which providers are flat-rate (subscription — e.g. `claude-code` via a
 * Max plan, no marginal per-token cost) vs pay-per-token (e.g. `openai`).
 * This is the table `isFlatRateProvider` reads and the predicate S05's rank
 * uses to suppress fine-grained routing: a flat-rate provider has no
 * marginal cost to optimize, so the rank falls back to the pool's declared
 * top ref instead of rank-ordering by cost.
 *
 * Detecting a provider's real flat-rate status from live credential/plan
 * introspection is out of scope here (S06's credential-real axis); this
 * table declares the flag statically per known provider.
 */
export const PROVIDER_FLAT_RATE: Record<string, boolean> = {
  "claude-code": true,
  openai: false,
};

/** Default flat-rate status for a provider absent from `PROVIDER_FLAT_RATE`: pay-per-token. */
const DEFAULT_FLAT_RATE = false;

/**
 * Splits a `provider/model-id` ref into its provider prefix — the part
 * before the first `/`. Mirrors the same split `resolveModelForRole` already
 * performs inline (`auto/role.ts`) rather than introducing a second
 * derivation rule; a ref with no `/` is returned verbatim (treated as its
 * own provider), never throws.
 */
export function providerOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : ref;
}

/**
 * The declared tier for `ref`, or `DEFAULT_MODEL_CAPABILITY.tier` for a ref
 * absent from the table. Deterministic, never throws.
 */
export function tierOf(ref: string): Tier {
  return (MODEL_CAPABILITIES[ref] ?? DEFAULT_MODEL_CAPABILITY).tier;
}

/**
 * The declared capability score for `ref` — always `>= 0`, higher means more
 * capable. Falls back to `DEFAULT_MODEL_CAPABILITY.capability` for an
 * unknown ref. Deterministic, never throws.
 */
export function capabilityScore(ref: string): number {
  return (MODEL_CAPABILITIES[ref] ?? DEFAULT_MODEL_CAPABILITY).capability;
}

/**
 * The declared relative cost rank for `ref` — always `>= 0`, lower means
 * cheaper. Falls back to `DEFAULT_MODEL_CAPABILITY.cost` for an unknown ref.
 * Deterministic, never throws.
 */
export function costRank(ref: string): number {
  return (MODEL_CAPABILITIES[ref] ?? DEFAULT_MODEL_CAPABILITY).cost;
}

/**
 * Whether `provider` is flat-rate (subscription, no marginal per-token cost)
 * — the predicate S05's rank uses to suppress fine-grained cost routing.
 * `true` for `claude-code`, `false` for `openai`; an unrecognized provider
 * defaults to `DEFAULT_FLAT_RATE` (pay-per-token), the conservative
 * assumption that keeps cost-based routing active unless a provider is
 * explicitly known to be flat-rate. Deterministic, never throws.
 */
export function isFlatRateProvider(provider: string): boolean {
  return PROVIDER_FLAT_RATE[provider] ?? DEFAULT_FLAT_RATE;
}
