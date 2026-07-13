/**
 * Forge Extension — bundled, tier:core
 *
 * Registers the `/forge` command (status|help|auto|next). Bootstrap is defensive
 * (per-subsystem try/catch — see bootstrap/register-extension.ts) so a failing
 * handler never blocks TUI boot, including when `.gsd/` does not exist yet.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerForgeExtension } from "./bootstrap/register-extension.js";

export default function (pi: ExtensionAPI) {
  registerForgeExtension(pi);
}
