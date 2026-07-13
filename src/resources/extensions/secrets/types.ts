/**
 * secrets/types.ts — fresh local shim for get-secrets-from-user.
 *
 * D2: minimal shape reconstructed from consumer usage sites, never copied
 * from the deleted gsd source. Dormant until harvested/expanded in M3.
 */

export type SecretsEntryStatus = "pending" | "collected" | "skipped";

export interface SecretsManifestEntry {
	key: string;
	status: SecretsEntryStatus;
	formatHint?: string;
	guidance: string[];
}

export interface SecretsManifest {
	entries: SecretsManifestEntry[];
}
