/**
 * Graceful compat shim: the gsd-workflow preferences layer no longer
 * exists. Consumers fall through to their non-gsd defaults.
 */
export function resolveSearchProviderFromPreferences(): string | null {
  return null;
}

export function loadEffectiveGSDPreferences(): { preferences?: unknown } | null {
  return null;
}
