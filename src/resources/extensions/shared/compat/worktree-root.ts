/**
 * Graceful compat shim: gsd worktree detection no longer applies.
 */
export function isGsdWorktreePath(p: string): boolean {
  void p;
  return false;
}
