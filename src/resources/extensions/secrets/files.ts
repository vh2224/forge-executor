/**
 * secrets/files.ts — fresh local shim for get-secrets-from-user.
 *
 * D2: minimal graceful manifest parse/format matching consumer signatures.
 * Dormant until harvested/expanded in M3.
 */

import type { SecretsManifest, SecretsManifestEntry, SecretsEntryStatus } from "./types.js";

const VALID_STATUSES: SecretsEntryStatus[] = ["pending", "collected", "skipped"];

/**
 * Parse a SECRETS manifest markdown/text blob into structured entries.
 * Minimal graceful implementation: expects one entry per non-empty line in
 * the form `key|status|formatHint|guidance1;guidance2`. Returns an empty
 * entries list for absent/empty/unrecognized content rather than throwing.
 */
export function parseSecretsManifest(content: string): SecretsManifest {
	if (!content || content.trim().length === 0) {
		return { entries: [] };
	}
	const entries: SecretsManifestEntry[] = [];
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const [key, statusRaw, formatHint, guidanceRaw] = line.split("|");
		if (!key) continue;
		const status = VALID_STATUSES.includes(statusRaw as SecretsEntryStatus)
			? (statusRaw as SecretsEntryStatus)
			: "pending";
		const guidance = guidanceRaw ? guidanceRaw.split(";").filter(Boolean) : [];
		entries.push({
			key: key.trim(),
			status,
			formatHint: formatHint ? formatHint.trim() : undefined,
			guidance,
		});
	}
	return { entries };
}

/**
 * Format a SecretsManifest back into the same line-based textual form
 * parseSecretsManifest reads.
 */
export function formatSecretsManifest(manifest: SecretsManifest): string {
	return manifest.entries
		.map((entry) => `${entry.key}|${entry.status}|${entry.formatHint ?? ""}|${entry.guidance.join(";")}`)
		.join("\n") + (manifest.entries.length > 0 ? "\n" : "");
}
