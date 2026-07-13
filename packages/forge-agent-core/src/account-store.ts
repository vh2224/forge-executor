import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	AuthCredential,
	AuthStorageData,
} from "@gsd/pi-coding-agent/core/auth-storage.js";
import { CredentialRotator, type CredentialSource } from "./credential-rotation.js";

export interface AccountView {
	index: number;
	type: AuthCredential["type"];
	label: string;
}

export type AccountCooldown = "ready" | "cooling" | "provider-backoff";

export interface AccountStatus {
	index: number;
	label: string;
	cooldown: AccountCooldown;
	cooldownMsRemaining?: number;
}

function redactedLabel(credential: AuthCredential): string {
	if (credential.type === "oauth") {
		return `oauth · …${credential.refresh.slice(-4)}`;
	}
	return "api_key · stored";
}

/** Lists credentials without returning any credential material. */
export function listAccounts(source: CredentialSource, provider: string): AccountView[] {
	return source.getCredentialsForProvider(provider).map((credential, index) => ({
		index,
		type: credential.type,
		label: redactedLabel(credential),
	}));
}

function readAuthData(authPath: string): AuthStorageData {
	if (!existsSync(authPath)) return {};
	const raw = readFileSync(authPath, "utf8").trim();
	if (raw.length === 0) return {};
	const parsed: unknown = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("auth.json must contain an object");
	}
	return parsed as AuthStorageData;
}

function credentialsAt(data: AuthStorageData, provider: string): AuthCredential[] {
	const value = data[provider];
	if (value === undefined) return [];
	return Array.isArray(value) ? [...value] : [value];
}

function writeAuthData(authPath: string, data: AuthStorageData): void {
	const directory = dirname(authPath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = `${authPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, authPath);
	} catch (error) {
		try {
			if (existsSync(temporaryPath)) {
				// Best-effort cleanup; preserve the original write error.
				unlinkSync(temporaryPath);
			}
		} catch {
			// Ignore cleanup failures.
		}
		throw error;
	}
}

/** Appends one credential, preserving all existing credentials for the provider. */
export function addAccount(authPath: string, provider: string, credential: AuthCredential): void {
	const data = readAuthData(authPath);
	data[provider] = [...credentialsAt(data, provider), credential];
	writeAuthData(authPath, data);
}

/** Removes one credential by its current array position. */
export function removeAccount(authPath: string, provider: string, index: number): void {
	const data = readAuthData(authPath);
	const credentials = credentialsAt(data, provider);
	if (!Number.isInteger(index) || index < 0 || index >= credentials.length) {
		throw new RangeError(`account index out of range: ${index}`);
	}
	credentials.splice(index, 1);
	if (credentials.length === 0) delete data[provider];
	else data[provider] = credentials;
	writeAuthData(authPath, data);
}

/**
 * Projects provider and per-account cooldown without consulting a wall clock.
 * The rotator owns identity lookup; this layer only exposes redacted views.
 */
export function describeAccountStatus(
	rotator: CredentialRotator,
	backoffMsRemaining: number,
	provider: string,
	accounts: AccountView[],
	nowMs: number,
): AccountStatus[] {
	return accounts.map((account) => {
		if (backoffMsRemaining > 0) {
			return { ...account, cooldown: "provider-backoff", cooldownMsRemaining: backoffMsRemaining };
		}
		return {
			...account,
			cooldown: rotator.isCoolingDown(provider, account.index, nowMs) ? "cooling" : "ready",
		};
	});
}

