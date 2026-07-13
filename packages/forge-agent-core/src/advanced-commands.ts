import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the Forge home without depending on the condemned Forge extension.
 * This mirrors the shared compatibility rule used by the extension prefs.
 */
function resolveForgeHome(): string {
	if (process.env.FORGE_HOME) return path.resolve(process.env.FORGE_HOME);
	if (process.env.GSD_HOME) return path.resolve(process.env.GSD_HOME);

	const forgeHome = path.join(os.homedir(), ".forge");
	const gsdHome = path.join(os.homedir(), ".gsd");
	if (existsSync(forgeHome)) return forgeHome;
	if (existsSync(gsdHome)) return gsdHome;
	return forgeHome;
}

function preferenceSources(cwd: string): string[] {
	return [
		path.join(os.homedir(), ".claude", "forge-agent-prefs.md"),
		path.join(resolveForgeHome(), "prefs.md"),
		path.join(cwd, ".gsd", "prefs.md"),
		path.join(cwd, ".gsd", "prefs.local.md"),
	];
}

const ADVANCED_COMMANDS = /^(true|yes|1|on)$/i;

/**
 * Read the Forge command-palette preference using the four-layer, last-wins
 * prefs cascade. Files are deliberately parsed as flat key/value lines only.
 * A missing or unreadable layer contributes nothing and never aborts startup.
 */
export function readAdvancedCommandsPref(cwd: string = process.cwd()): boolean {
	let enabled = false;

	for (const source of preferenceSources(cwd)) {
		try {
			if (!existsSync(source)) continue;
			const raw = readFileSync(source, "utf8");
			for (const line of raw.split(/\r?\n/)) {
				const match = line.match(/^advanced_commands:\s*(.+?)\s*$/);
				if (match) enabled = ADVANCED_COMMANDS.test(match[1]);
			}
		} catch {
			// An unreadable preference layer is equivalent to an absent layer.
		}
	}

	return enabled;
}
