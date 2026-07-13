/**
 * Dispatch decisions cross a newSession boundary, so their reader must be able
 * to reject a value published by an older dispatch. These are deliberately
 * explicit: adding a session field requires deciding which side of that
 * boundary it belongs to instead of relying on a naming heuristic.
 */
export const PER_DISPATCH_FIELDS = [
  "pendingUnitModel", // per-unit model consumed by the fresh session_start hook
  "appliedUnitModel", // model actually applied, read by result authorship
  "selectedCredential", // credential used by post-dispatch cooldown handling
  "resolvedDispatchAuthor", // consumed synchronously by the driver in-dispatch
  "providerReadiness", // immutable run-scoped readiness (D16)
  "pendingUnitEffort", // per-unit resolved effort consumed by the fresh session_start hook (S01)
  "appliedUnitEffort", // effort actually applied by the hook, read by result authorship (S01)
  "resolvedDispatchEffort", // consumed synchronously by the driver/loop in-dispatch (S01)
  "effortApplied", // run-scoped restore gate, mirror of modelApplied (S01)
  "baselineThinkingLevel", // run-scoped restore baseline, mirror of baselineModel (S01)
  "reviewActivity", // per-turn review identity, self-carries its own inline `token` epoch (S04/T01, D16/M1R-1)
] as const;

/** Run-scoped coordination and infrastructure, not a dispatch decision. */
export const NON_DISPATCH_FIELDS = [
  "active",
  "cmdCtx",
  "cwd",
  "milestoneId",
  "currentUnit",
  "currentRendezvousToken",
  "retryCount",
  "pendingUnitType",
  "pendingUnitModelToken",
  "appliedUnitModelToken",
  "pendingUnitEffortToken",
  "appliedUnitEffortToken",
  "credentialRotator",
  "authStorageForOverride",
  "pendingDispatch",
  "defaultActiveTools",
  "livePi",
  "baselineModel",
  "modelApplied",
  "onUnitChange",
  "unitTokens",
  "workerStream",
] as const;

/**
 * Exceptions to the token rule must state why a stale post-session read is
 * impossible or irrelevant. Keep this list small and reviewable (D16).
 */
export const ACCEPTED_WITHOUT_TOKEN: Record<string, string> = {
  resolvedDispatchAuthor:
    "consumed synchronously by the driver in-dispatch (session.ts doc-comment) — no post-newSession stale read",
  providerReadiness:
    "run-scoped immutable readiness signal (D16); does not affect authorship/cooldown/STATE",
  resolvedDispatchEffort:
    "consumed synchronously by the driver/loop in-dispatch (session.ts doc-comment) — no post-newSession stale read, same class as resolvedDispatchAuthor",
  effortApplied:
    "run-scoped restore gate for the post-loop baseline restore (same class as modelApplied); never read per-dispatch",
  baselineThinkingLevel:
    "run-scoped restore baseline captured once per run (same class as baselineModel); never read per-dispatch",
};

export type StructuralConfig = {
  perDispatch: readonly string[];
  nonDispatch: readonly string[];
  allowlist: Readonly<Record<string, string>>;
};

/** Extract class fields from source, retaining each declaration for inline-token checks. */
function extractFields(sourceText: string): Map<string, string> {
  const namedClass = sourceText.indexOf("class ForgeAutoSession");
  const classStart = namedClass >= 0 ? namedClass : sourceText.search(/class\s+\w+\s*\{/);
  if (classStart < 0) return new Map();
  const classBodyStart = sourceText.indexOf("{", classStart) + 1;
  const resetStart = sourceText.indexOf("\n  reset(", classBodyStart);
  const classBody = sourceText.slice(classBodyStart, resetStart < 0 ? sourceText.length : resetStart);
  const fields = new Map<string, string>();
  const declarations = [...classBody.matchAll(/^  (\w+)\s*(?::[\s\S]*?)?\s*=/gm)];
  for (const [index, match] of declarations.entries()) {
    const end = declarations[index + 1]?.index ?? classBody.length;
    fields.set(match[1], classBody.slice(match.index, end));
  }
  return fields;
}

/**
 * Structural guard for CODING-STANDARDS §"Campo por-dispatch exige token/epoch".
 * It is pure so the regression test can exercise exactly the production check.
 */
export function checkPerDispatchTokens(
  sourceText: string,
  config: StructuralConfig,
): { failures: string[] } {
  const fields = extractFields(sourceText);
  const perDispatch = new Set(config.perDispatch);
  const nonDispatch = new Set(config.nonDispatch);
  const allowlist = new Set(Object.keys(config.allowlist));
  const failures: string[] = [];

  for (const field of fields.keys()) {
    if (!perDispatch.has(field) && !nonDispatch.has(field)) {
      failures.push(`Unclassified ForgeAutoSession field ${field}; classify it as per-dispatch or non-dispatch.`);
    }
  }
  for (const field of [...perDispatch, ...nonDispatch, ...allowlist]) {
    if (!fields.has(field)) failures.push(`Classification references missing ForgeAutoSession field ${field}.`);
  }
  for (const [field, reason] of Object.entries(config.allowlist)) {
    if (!reason.trim()) failures.push(`Allowlist entry ${field} must carry a written justification.`);
  }

  for (const field of perDispatch) {
    if (allowlist.has(field)) continue;
    const declaration = fields.get(field);
    const companion = fields.has(`${field}Token`);
    const inlineToken = declaration !== undefined && /\btoken\s*\??\s*:/u.test(declaration);
    if (!companion && !inlineToken) {
      failures.push(
        `${field} is a per-dispatch field without a token pairing; see CODING-STANDARDS §"Campo por-dispatch exige token/epoch".`,
      );
    }
  }
  return { failures };
}
