/**
 * secrets/paths.ts — fresh local shim for get-secrets-from-user.
 *
 * D2: minimal graceful path resolver. Dormant until harvested in M3.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve a milestone-scoped file path (e.g. the SECRETS manifest).
 * Minimal graceful implementation: joins base/milestoneId/<kind>.md and
 * returns it only if it exists, otherwise null.
 */
export function resolveMilestoneFile(base: string, milestoneId: string, kind: string): string | null {
	const candidate = join(base, milestoneId, `${kind}.md`);
	return existsSync(candidate) ? candidate : null;
}
