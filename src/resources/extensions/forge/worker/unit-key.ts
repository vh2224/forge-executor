/**
 * `worker/unit-key.ts` — the single source of the stable unit-key format
 * (`slice/task` for execute-task, `plan/slice` for plan-slice).
 *
 * Extracted so BOTH the in-process commit point (`worker/unit-result.ts`) and
 * the SDK/externalCli MCP bridge (`worker/mcp-bridge.ts`) journal
 * `stale_rendezvous_delivery` events under the SAME key, mirroring
 * `auto/loop.ts`'s `unitKey` / `driver.ts`'s `journalStaleCancel` format.
 * A duplicated formatter here would drift the two delivery paths' journals.
 */

// S04/T03 (D-S04-2): widened type-only with the dispatch spine — the key
// consumers read the unit off `ForgeAutoSession.currentUnit`, which now
// carries any `ComposableUnit`; the switch's `default` arm already covers
// every non-loop variant.
import type { ComposableUnit } from "../prompts/compose.js";
import { unitSlice } from "../state/index.js";

/**
 * Stable unit key: `slice/task` for execute-task, `complete/<slice>` for
 * complete-slice, `complete/<milestone>` for complete-milestone, `plan/<slice>`
 * for plan-slice. Mirrors `auto/loop.ts`'s `unitKey` EXACTLY.
 *
 * R1 (S03 review-fix): the completion variants MUST carry their own `complete/`
 * key — a bare `plan/<slice>` fallback collided a `complete-slice` result with
 * the `plan-slice` result for the same slice in `detectUnreconciledResults`'
 * dedup map, so the resume replay could drop the (later, meaningful) completion
 * flip. Distinct keys keep each unit's tail-wins entry independent.
 */
export function unitKeyOf(unit: ComposableUnit): string {
	switch (unit.type) {
		case "execute-task":
			return `${unit.slice}/${unit.task}`;
		case "complete-slice":
			return `complete/${unit.slice}`;
		case "complete-milestone":
			return `complete/${unit.milestone}`;
		default:
			return `plan/${unitSlice(unit)}`;
	}
}
