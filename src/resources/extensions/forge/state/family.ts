/**
 * Forge LLM family helper — pure derivation of a "family" label from a
 * provider-slug or a `provider/model-id` string.
 *
 * Pure module: no filesystem/OS dependency, no `@gsd/*` runtime import, no
 * import from `packages/pi-*` (vendored) or `provider-capabilities.ts` —
 * `familyOf` is fork-side and pure by design (see S01 Decisões).
 *
 * Approach: exact-alias match on the normalized provider-slug, then a
 * secondary, anchored inference over the model-id segment, then a literal
 * fallback — never substring/`includes` matching (S05 fix: substring
 * matching on the old table let `not-openai` collide into `gpt` and
 * `claude-proxy-for-gpt` collide into `claude`).
 *
 * 1. Provider-slug equality against `PROVIDER_FAMILY` (canonical aliases).
 * 2. When the input has a `/` and step 1 missed, the model-id segment
 *    (after the first `/`) is checked against `MODEL_ID_FAMILY` by
 *    prefix/token-boundary (`^token(-|$)`), not `includes` — so a model id
 *    like `not-gpt-thing` does not collide into `gpt`.
 * 3. Deterministic fallback: the provider-slug itself, lowercased.
 */

// ── Provider-slug aliases — exact match (equality) on the normalized slug ──
// Add new providers here as they're onboarded (S03+).
const PROVIDER_FAMILY: ReadonlyMap<string, string> = new Map([
  ["claude-code", "claude"],
  ["anthropic", "claude"],
  ["claude", "claude"],
  ["openai", "gpt"],
  ["openai-codex", "gpt"],
  ["gpt", "gpt"],
  // xAI onboarded 2026-07-11 — first real second family (console.x.ai API).
  ["xai", "grok"],
  ["grok", "grok"],
]);

// ── Model-id family prefixes — anchored token-boundary match, NOT `includes` ──
// Secondary inference used only when the provider-slug itself is unknown.
const MODEL_ID_FAMILY: ReadonlyArray<{ readonly prefix: string; readonly family: string }> = [
  { prefix: "claude", family: "claude" },
  { prefix: "gpt", family: "gpt" },
  { prefix: "grok", family: "grok" },
];

/** True when `value` equals `prefix` or starts with `prefix` followed by `-`. */
function matchesTokenBoundary(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}-`);
}

/**
 * Derives the LLM family from a provider-slug or a `provider/model-id`
 * string. Case-insensitive input; output always lowercase.
 *
 * - `familyOf('claude-code/claude-opus-4-8') === 'claude'`
 * - `familyOf('openai/gpt-5.5') === 'gpt'`
 *
 * For unknown provider/model, falls back deterministically to the
 * provider-slug itself (lowercased) — NEVER throws, NEVER returns
 * `undefined` for non-empty input. Empty/whitespace-only input is the one
 * documented edge case: returns `""` rather than throwing.
 */
export function familyOf(providerOrModel: string): string {
  const raw = String(providerOrModel ?? "").trim();
  if (!raw) return "";

  const slashIndex = raw.indexOf("/");
  const slug = (slashIndex === -1 ? raw : raw.slice(0, slashIndex)).toLowerCase();

  const exact = PROVIDER_FAMILY.get(slug);
  if (exact) return exact;

  if (slashIndex !== -1) {
    const modelId = raw.slice(slashIndex + 1).toLowerCase();
    for (const entry of MODEL_ID_FAMILY) {
      if (matchesTokenBoundary(modelId, entry.prefix)) return entry.family;
    }
  }

  // Deterministic fallback: the provider-slug itself, lowercased.
  return slug;
}
