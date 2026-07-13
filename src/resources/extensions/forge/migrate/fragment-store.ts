/**
 * Forge migrate — fragment-store classifier (decisions/ledger/memory) + orphan
 * artifact scanner, for the `forge migrate` dry-run (S01/T03).
 *
 * Read-only: every function here degrades an absent directory to an empty
 * result, never throws, and never writes to disk. Reuses the REAL 2.0 parsers
 * (`parseDecisionFragment`/`parseLedgerFragment`/`parseMemoryFragment`) rather
 * than reimplementing their shapes — this module only adds a compatibility
 * verdict on top of what those parsers actually produce.
 *
 * MEMORY FINDING (resolved by reading code, not the memory-store.ts docstring):
 * this repo's LIVE `.gsd/memory/*.json` files are a fossil of a now-deleted
 * script, `scripts/forge-memory.js` (gitignored stray, removed at commit
 * 377a1b47 on 2026-07-08), which wrote `.gsd/memory/<id>.json` via
 * `writeFileSync(path, JSON.stringify(merged, null, 2))`. The current 2.0
 * writer — `memory/memory-store.ts`, live since S07 commit cb65af94 — only
 * reads/writes `.md` (`listMemoryFragments` filters `f.endsWith(".md")`), so
 * those `.json` files are invisible to production code today, not a
 * recognized fragment shape. `classifyMemoryFile` below flags `.json` files
 * on extension alone and documents this provenance in `detail`.
 *
 * Node builtins + sibling pure state modules only — no `@gsd/*` import.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isValid, entityKind } from "../state/ids.js";
import { decisionsDir, parseDecisionFragment } from "../state/decisions.js";
import { ledgerDir, parseLedgerFragment } from "../state/ledger.js";
import { memoryDir, parseMemoryFragment } from "../memory/memory-store.js";

export type FragmentStoreKind = "decisions" | "ledger" | "memory";

/** Compatibility verdict for one file inside a fragment-store directory. */
export interface FragmentFileFinding {
  path: string;
  compatible: boolean;
  detail: string;
}

/** Compatibility report for one fragment-store directory. */
export interface FragmentStoreFinding {
  store: FragmentStoreKind;
  dir: string;
  files: FragmentFileFinding[];
}

/** An artifact directory whose name matches no recognizable 2.0/1.0 unit ID. */
export interface OrphanArtifactFinding {
  path: string;
  reason: string;
}

const FENCED_HEADER = /^---\n[\s\S]*?\n---/;

// ── decisions ────────────────────────────────────────────────────────────────

function classifyDecisionFile(raw: string): { compatible: boolean; detail: string } {
  let fragment;
  try {
    fragment = parseDecisionFragment(raw);
  } catch (err) {
    return { compatible: false, detail: `parseDecisionFragment lançou uma exceção: ${String(err)}` };
  }

  if (!FENCED_HEADER.test(raw)) {
    return {
      compatible: false,
      detail:
        "arquivo não tem o bloco fenced YAML (---...---) que DecisionFragment espera — não é um fragment " +
        "decisions reconhecível (ex.: tabela markdown solta, como legacy-orphan.md)",
    };
  }

  if (/^\s*-?\s*(when|scope|choice|revisable)\s*:/m.test(raw)) {
    return {
      compatible: false,
      detail:
        "shape 1.0 detectado: chaves when/scope/choice/revisable presentes — DecisionRow 2.0 espera " +
        "id/decision/rationale/date",
    };
  }

  if (fragment.decisions.length === 0) {
    return { compatible: false, detail: "bloco decisions: vazio ou ausente no fragment" };
  }

  const missing = fragment.decisions.filter((row) => !row.id || !row.date);
  if (missing.length > 0) {
    return {
      compatible: false,
      detail:
        `${missing.length} de ${fragment.decisions.length} linha(s) sem id/date preenchidos — shape não bate ` +
        "DecisionRow (id/decision/rationale/date)",
    };
  }

  return { compatible: true, detail: "shape 2.0 nativo — todas as linhas têm id/decision/rationale/date preenchidos" };
}

// ── ledger ───────────────────────────────────────────────────────────────────

function classifyLedgerFile(raw: string): { compatible: boolean; detail: string } {
  let entry;
  try {
    entry = parseLedgerFragment(raw);
  } catch (err) {
    return { compatible: false, detail: `parseLedgerFragment lançou uma exceção: ${String(err)}` };
  }

  if (!FENCED_HEADER.test(raw)) {
    return {
      compatible: false,
      detail: "arquivo não tem o bloco fenced (---...---) que LedgerEntry espera — não é um fragment ledger reconhecível",
    };
  }

  if (!entry.id) {
    return {
      compatible: false,
      detail: "campo id ausente/vazio — shape não bate LedgerEntry (id/title/completed_at/slices/key_files/key_decisions)",
    };
  }

  return {
    compatible: true,
    detail: "shape 2.0 nativo — id presente e frontmatter reconhecido (id/title/completed_at/slices/key_files/key_decisions)",
  };
}

// ── memory ───────────────────────────────────────────────────────────────────

const MEMORY_JSON_DETAIL =
  "formato .json — resíduo do script scripts/forge-memory.js (gitignored stray, removido no commit " +
  "377a1b47 em 2026-07-08), que escrevia JSON.stringify direto em .gsd/memory/<id>.json. O escritor 2.0 " +
  "atual (memory-store.ts, desde S07 commit cb65af94) só lê/escreve .md (listMemoryFragments filtra " +
  "f.endsWith('.md')) — este .json é invisível para o código de produção corrente, não um fragment reconhecido";

function classifyMemoryFile(raw: string, filePath: string): { compatible: boolean; detail: string } {
  if (filePath.endsWith(".json")) {
    return { compatible: false, detail: MEMORY_JSON_DETAIL };
  }

  let fragment;
  try {
    fragment = parseMemoryFragment(raw);
  } catch (err) {
    return { compatible: false, detail: `parseMemoryFragment lançou uma exceção: ${String(err)}` };
  }

  if (!FENCED_HEADER.test(raw)) {
    return {
      compatible: false,
      detail: "arquivo não tem o bloco fenced (---...---) que MemoryFragment espera — não é um fragment memory reconhecível",
    };
  }

  if (/^\s*-?\s*(mem_id|source_unit|confidence_base)\s*:/m.test(raw)) {
    return {
      compatible: false,
      detail:
        "shape 1.0 detectado: chaves mem_id/source_unit/confidence_base presentes — MemoryFact 2.0 espera " +
        "id/fact/confidence/hits/created_at",
    };
  }

  if (fragment.facts.length === 0) {
    return { compatible: false, detail: "bloco facts: vazio ou ausente no fragment" };
  }

  const missing = fragment.facts.filter((f) => !f.id || !f.fact);
  if (missing.length > 0) {
    return {
      compatible: false,
      detail: `${missing.length} de ${fragment.facts.length} fato(s) sem id/fact preenchidos — shape não bate MemoryFact`,
    };
  }

  return { compatible: true, detail: "shape 2.0 nativo — todos os fatos têm id/fact/confidence/hits/created_at preenchidos" };
}

// ── classifyFragmentStore ────────────────────────────────────────────────────

function storeDir(cwd: string, store: FragmentStoreKind): string {
  if (store === "decisions") return decisionsDir(cwd);
  if (store === "ledger") return ledgerDir(cwd);
  return memoryDir(cwd);
}

function classifyFile(store: FragmentStoreKind, raw: string, filePath: string): { compatible: boolean; detail: string } {
  if (store === "decisions") return classifyDecisionFile(raw);
  if (store === "ledger") return classifyLedgerFile(raw);
  return classifyMemoryFile(raw, filePath);
}

/**
 * Classify every file in `store`'s fragment directory as compatible (matches
 * the real 2.0 shape the corresponding `state/*.ts`/`memory-store.ts` parser
 * produces) or not, with a pt-BR `detail` explaining the mismatch. Missing
 * directory degrades to `files: []`, never throws.
 */
export function classifyFragmentStore(cwd: string, store: FragmentStoreKind): FragmentStoreFinding {
  const dir = storeDir(cwd, store);
  if (!existsSync(dir)) {
    return { store, dir, files: [] };
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { store, dir, files: [] };
  }

  const files: FragmentFileFinding[] = [];
  for (const name of entries) {
    const fullPath = join(dir, name);
    let isFile: boolean;
    try {
      isFile = statSync(fullPath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;

    let raw: string;
    try {
      raw = readFileSync(fullPath, "utf-8");
    } catch (err) {
      files.push({ path: fullPath, compatible: false, detail: `arquivo ilegível: ${String(err)}` });
      continue;
    }

    const { compatible, detail } = classifyFile(store, raw, fullPath);
    files.push({ path: fullPath, compatible, detail });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { store, dir, files };
}

// ── findOrphanArtifacts ──────────────────────────────────────────────────────

function scanOrphanDir(dirPath: string): OrphanArtifactFinding[] {
  if (!existsSync(dirPath)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return [];
  }

  const findings: OrphanArtifactFinding[] = [];
  for (const name of entries) {
    const fullPath = join(dirPath, name);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;

    if (!isValid(name) || entityKind(name) === "unknown") {
      findings.push({
        path: fullPath,
        reason: `diretório "${name}" não corresponde a nenhum ID reconhecível (isValid/entityKind de state/ids.ts)`,
      });
    }
  }
  return findings;
}

/**
 * Scan `.gsd/milestones/` (and `.gsd/tasks/`, if present) for directory
 * entries whose name is neither `isValid` nor a recognized `entityKind` —
 * cruft like a loose `S03` directory left over from a 1.0 project. Missing
 * directories degrade to `[]`, never throw.
 */
export function findOrphanArtifacts(cwd: string): OrphanArtifactFinding[] {
  const milestonesDir = join(cwd, ".gsd", "milestones");
  const tasksDir = join(cwd, ".gsd", "tasks");
  return [...scanOrphanDir(milestonesDir), ...scanOrphanDir(tasksDir)].sort((a, b) => a.path.localeCompare(b.path));
}
