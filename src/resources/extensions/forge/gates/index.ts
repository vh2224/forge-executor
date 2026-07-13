/**
 * Forge gates — public barrel.
 *
 * The single import surface the S04 advisory hook (`auto/loop.ts`) consumes:
 * the deterministic plan-checker (T01), the security skeleton scanner (T02),
 * and the CHECKER fragment store (T03). Mirrors `state/index.ts` — a pure
 * barrel that re-exports only its sibling gate modules; no `@gsd/*` runtime
 * import leaks through here.
 */

export * from "./plan-checker.js";
export * from "./security.js";
export * from "./checker-memory.js";
