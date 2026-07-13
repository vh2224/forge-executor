/**
 * secrets/env-utils.ts — fresh local shim for get-secrets-from-user.
 *
 * D2: minimal graceful env-key check. Dormant until harvested in M3.
 */

import { readFile } from "node:fs/promises";

/**
 * Check which of the given keys already have a value set in the .env file
 * at envPath. Minimal graceful implementation: returns [] if the file is
 * missing or unreadable.
 */
export async function checkExistingEnvKeys(keys: string[], envPath: string): Promise<string[]> {
	let content: string;
	try {
		content = await readFile(envPath, "utf8");
	} catch {
		return [];
	}
	const existing: string[] = [];
	for (const key of keys) {
		const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*\\S`, "m");
		if (regex.test(content)) {
			existing.push(key);
		}
	}
	return existing;
}
