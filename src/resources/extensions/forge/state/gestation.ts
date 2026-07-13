import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MILESTONE_ID_RE = /^M-\d{14}/;

/** A milestone whose context is ready for the operator to start planning. */
export type GestationEntry = {
  milestoneId: string;
  contextPath: string;
};

/**
 * Lists context-authored milestones that have not yet received a ROADMAP.
 *
 * This is intentionally read-side and failure-tolerant: a malformed or
 * unreadable store entry must not prevent status commands from rendering.
 */
export function listGestations(cwd: string): GestationEntry[] {
  const milestonesDir = join(cwd, ".gsd", "milestones");
  let entries: Array<{ name: string; isDirectory(): boolean }>;

  try {
    entries = readdirSync(milestonesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const gestations: GestationEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !MILESTONE_ID_RE.test(entry.name)) continue;

    try {
      const milestoneDir = join(milestonesDir, entry.name);
      const contextPath = join(milestoneDir, `${entry.name}-CONTEXT.md`);
      const roadmapPath = join(milestoneDir, `${entry.name}-ROADMAP.md`);
      const hasContext = readFileSync(contextPath, "utf-8").split("\n").some((line) => line.trim().length > 0);
      if (hasContext && !existsSync(roadmapPath)) {
        gestations.push({ milestoneId: entry.name, contextPath });
      }
    } catch {
      // An unreadable milestone is omitted without affecting the rest.
    }
  }

  return gestations.sort((a, b) => b.milestoneId.localeCompare(a.milestoneId));
}
