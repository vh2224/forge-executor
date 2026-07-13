/**
 * Forge state store — the SINGLE writer of forge state (D3).
 *
 * The orchestrator (and only the orchestrator) mutates state through this
 * module. Every STATE.md write is funneled through `updateState`, and every
 * journal line through `appendEvent`. This single-writer invariant is what lets
 * the rest of the system treat parsed state as an authoritative snapshot without
 * locking: there is exactly one process, running one mutation at a time.
 *
 * Atomicity (backs milestone acceptance #2 — kill -9 + relaunch resumes cleanly):
 * `updateState` never partial-writes STATE.md. It serializes into a sibling temp
 * file in the SAME directory, then `fs.renameSync`s it over the target. On POSIX
 * an intra-directory rename is atomic, so a crash mid-write leaves either the old
 * STATE.md or the new one — never a truncated/corrupt file. A cross-directory
 * rename is NOT atomic, so the temp file must live beside its target.
 *
 * This module performs I/O but stays pure of the harness runtime: no `@gsd/*`
 * import — only node builtins + the sibling pure modules (parse/serialize/types).
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseState } from "./parse.js";
import { serializeState } from "./serialize.js";
import type { StateDoc, ForgeEvent } from "./types.js";

/** Absolute path to the 2.0 STATE.md for a given working dir. */
function statePath(cwd: string): string {
  return join(cwd, ".gsd", "STATE.md");
}

/** Absolute path to the append-only journal for a given working dir. */
function journalPath(cwd: string): string {
  return join(cwd, ".gsd", "forge", "events.jsonl");
}

/**
 * Read the current STATE.md and return its parsed `StateDoc`, or an
 * empty-defaults doc (`{ milestone: "" }`) when the file does not yet exist.
 * A missing STATE.md is a normal first-run condition, not an error.
 */
export function readState(cwd: string): StateDoc {
  const path = statePath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { milestone: "" };
    }
    throw err;
  }
  return parseState(raw);
}

/**
 * The ONLY state writer (D3). Reads the current STATE.md (or an empty doc when
 * absent), applies the PURE `mutator` to derive the next `StateDoc`, serializes
 * it, and writes it ATOMICALLY via temp-file + `renameSync` in the same
 * directory.
 *
 * The `mutator` must be pure: given the current doc it returns the next doc. It
 * MUST NOT perform I/O or mutate its argument in place (return a fresh doc).
 *
 * Returns the freshly written `StateDoc` so callers can chain derivations.
 */
export function updateState(cwd: string, mutator: (state: StateDoc) => StateDoc): StateDoc {
  const target = statePath(cwd);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  const current = readState(cwd);
  const next = mutator(current);
  const serialized = serializeState(next);

  // Temp file MUST be a sibling of the target: an intra-directory rename is
  // atomic on POSIX; a cross-directory move is not. The pid+random suffix keeps
  // concurrent writers (should not happen under the single-writer invariant, but
  // defends against it) from clobbering each other's temp files.
  const tmp = join(dir, `.STATE.md.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, serialized, "utf-8");
    renameSync(tmp, target);
  } finally {
    // Best-effort cleanup: on the happy path the rename consumed `tmp`, so this
    // is a no-op; on a mid-write failure it removes the residual temp file so no
    // `.tmp` residue is ever left behind.
    rmSync(tmp, { force: true });
  }

  return next;
}

/**
 * Read the append-only journal (`.gsd/forge/events.jsonl`) and return the parsed
 * events in append order. This is the read side that resume-time replay
 * (`auto/replay.ts`) uses to DETECT a journaled `unit_result:done` that never
 * flipped STATE (the kill-9 window between `appendEvent` and `updateState`).
 *
 * Tolerant by construction — it NEVER throws:
 *  - absent journal (ENOENT, first run / never dispatched) → `[]`;
 *  - a malformed/partial line (e.g. a torn last line from a crash mid-append) is
 *    skipped rather than aborting the whole read;
 *  - blank lines are ignored.
 */
export function readEvents(cwd: string): ForgeEvent[] {
  const path = journalPath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: ForgeEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as ForgeEvent);
    } catch {
      // Skip a malformed line (torn write / hand-edited journal). Never throw:
      // a single bad line must not blind the loop to the rest of the journal.
    }
  }
  return events;
}

/**
 * Append exactly one JSON line to `.gsd/forge/events.jsonl` (the journal),
 * creating `.gsd/forge/` if absent. Append-only: existing lines are never
 * rewritten. Each event is serialized on a single line terminated by `\n`.
 */
export function appendEvent(cwd: string, event: ForgeEvent): void {
  const path = journalPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
}
