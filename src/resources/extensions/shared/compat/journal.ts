/**
 * Graceful compat shim: journal emission is a no-op — the gsd journal
 * runtime no longer exists.
 */
export function emitJournalEvent(cwd: string, event: unknown): void {
  void cwd;
  void event;
}
