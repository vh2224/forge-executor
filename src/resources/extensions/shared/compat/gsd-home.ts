import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolves the agent home directory. Real implementation (not a shim
 * fallback): consumers such as mcp-client read `mcp.json` from this path.
 *
 * Precedence (D12): FORGE_HOME > GSD_HOME > ~/.forge (if it exists) >
 * ~/.gsd (read-fallback for pre-D12 installs) > ~/.forge (new-install default).
 */
export function gsdHome(): string {
  if (process.env.FORGE_HOME) return path.resolve(process.env.FORGE_HOME);
  if (process.env.GSD_HOME) return path.resolve(process.env.GSD_HOME);
  const forgeDir = path.join(os.homedir(), ".forge");
  const gsdDir = path.join(os.homedir(), ".gsd");
  if (existsSync(forgeDir)) return forgeDir;
  if (existsSync(gsdDir)) return gsdDir;
  return forgeDir;
}
