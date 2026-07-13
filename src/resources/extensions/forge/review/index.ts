/**
 * Forge review — public barrel.
 *
 * The single import surface the S05 native review footprint consumes: the
 * deterministic dialectic resolver (T01), the prompt/parse pair (T02), the
 * artifact renderer/writer + pending-item collector (T03), and the prefs
 * cascade reader (T04). Also re-exports the loose-task pending-item
 * collectors (`collectPendingTaskReviewItems`/`collectPendingTaskReviewBlocks`,
 * cockpit-v2 S03/T03) that give `/forge fix` eyes on `.gsd/tasks/`. Mirrors
 * `gates/index.ts` — a pure barrel that re-exports only its sibling review
 * modules; no `@gsd/*` runtime import leaks through here.
 */

export * from "./resolve.js";
export * from "./parse.js";
export * from "./prompts.js";
export * from "./artifact.js";
export * from "./followups.js";
export * from "./review-prefs.js";
export * from "./dispatch.js";
