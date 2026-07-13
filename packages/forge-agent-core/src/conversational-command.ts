/**
 * Reserved custom-message type used to defer a conversational Forge command
 * until the current agent turn has settled.
 */
export const FORGE_COMMAND_REQUEST_TYPE = "forge-command-request";

/** The intentionally small, cross-module payload for a deferred command. */
export interface CommandRequestDetails {
	command: string;
}

/**
 * Extract a safe command line from an untrusted custom-message payload.
 *
 * The host validates command registration separately. This parser only owns the
 * wire-format boundary, so extensions and the host can share it without sharing
 * module identity.
 */
export function parseCommandRequest(details: unknown): string | null {
	if (typeof details !== "object" || details === null || Array.isArray(details)) {
		return null;
	}

	const command = (details as Partial<CommandRequestDetails>).command;
	if (typeof command !== "string" || command.length === 0) {
		return null;
	}
	if (!command.startsWith("/") || /[\r\n]/.test(command)) {
		return null;
	}

	return command;
}
