/**
 * `/forge init` — bootstrap `.gsd/` in a virgin project + idempotent
 * doctor-lite for an existing one (S03/T01).
 *
 * No `.gsd/` at `ctx.cwd` → BOOTSTRAP: creates the minimal skeleton (4 files
 * + 3 fragment-store dirs) the rest of the extension expects
 * (`state/store.ts`, `prefs.ts`, `auto/models-config.ts`). `.gsd/` already
 * there → DOCTOR-LITE: a read-only exists/missing report, zero writes,
 * unless `--repair` is given, which creates ONLY the missing items — never
 * touching anything that already exists (the zero-overwrite contract is
 * STRUCTURAL: every file write goes through the OS `wx` flag, which refuses
 * to open a path that already exists, rather than relying on an
 * `existsSync` check as a convention that could be raced or forgotten).
 *
 * `.gitignore` is untouched by default (a project's `.gsd/` is meant to be
 * committed, D-forge); `--gitignore` appends a `.gsd/` entry, once, never
 * duplicated.
 *
 * This is I/O-local, direct-dispatch-free — like `migrate`, NOT like
 * `fix`/`research-models` (no `ComposableUnit`, no `newSession`, no worker
 * dispatch). No interactive question flow: a manifest heuristic seeds
 * `PROJECT.md`, and any refinement is a free-text edit afterwards.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { serializeState } from "../state/serialize.js";
import { isPrintHeadlessContext } from "./forge-command.js";

// ── Skeleton definition — the 4 files + 3 fragment-store dirs ───────────────

type InitItemKind = "file" | "dir";

interface InitItemDef {
  key: string;
  /** Path relative to `.gsd/`. */
  relPath: string;
  kind: InitItemKind;
}

const INIT_ITEMS: readonly InitItemDef[] = [
  { key: "PROJECT.md", relPath: "PROJECT.md", kind: "file" },
  { key: "STATE.md", relPath: "STATE.md", kind: "file" },
  { key: "prefs.md", relPath: "prefs.md", kind: "file" },
  { key: "models.md", relPath: "models.md", kind: "file" },
  { key: "ledger", relPath: "ledger", kind: "dir" },
  { key: "decisions", relPath: "decisions", kind: "dir" },
  { key: "memory", relPath: "memory", kind: "dir" },
];

export interface InitItemStatus {
  key: string;
  /** Display label, e.g. `.gsd/PROJECT.md` or `.gsd/ledger/`. */
  label: string;
  path: string;
  kind: InitItemKind;
  status: "exists" | "missing" | "conflict";
}

export interface InitReport {
  gsdExists: boolean;
  items: InitItemStatus[];
}

function labelFor(def: InitItemDef): string {
  return `.gsd/${def.relPath}${def.kind === "dir" ? "/" : ""}`;
}

/**
 * Exists/missing status for each of the 7 skeleton items. Never throws — a
 * per-item `statSync` failure (permission, race) degrades that item to
 * `missing` rather than raising, same discipline as `buildMigrateReport`.
 */
export function buildInitReport(cwd: string): InitReport {
  const gsdDir = join(cwd, ".gsd");
  const gsdExists = existsSync(gsdDir);

  const items: InitItemStatus[] = INIT_ITEMS.map((def) => {
    const path = join(gsdDir, def.relPath);
    let exists = false;
    try {
      if (existsSync(path)) {
        const st = statSync(path);
        exists = def.kind === "dir" ? st.isDirectory() : st.isFile();
      }
    } catch {
      exists = false;
    }
    // S03-R3 (review, conceded): a path that EXISTS but with the wrong type
    // (file where a dir belongs, or vice versa) used to be reported as merely
    // "missing" — and repair then died with EISDIR/EEXIST instead of
    // explaining. Surface it as an explicit conflict.
    let conflict = false;
    try {
      if (!exists && existsSync(path)) conflict = true;
    } catch {
      /* stat raced away — keep missing */
    }
    return {
      key: def.key,
      label: labelFor(def),
      path,
      kind: def.kind,
      status: exists ? "exists" : conflict ? "conflict" : "missing",
    };
  });

  return { gsdExists, items };
}

// ── detectStack — manifest heuristic, pure ──────────────────────────────────

/**
 * Heuristic stack detection by manifest presence at `cwd` (not recursive —
 * a virgin project's manifest lives at its root). Multiple manifests
 * coexist as a list; none found → `[]` (the PROJECT.md template degrades to
 * a commented placeholder). Never throws — `existsSync` doesn't raise for a
 * missing path.
 */
export function detectStack(cwd: string): string[] {
  const stacks: string[] = [];
  if (existsSync(join(cwd, "package.json"))) stacks.push("Node.js");
  if (existsSync(join(cwd, "pyproject.toml"))) stacks.push("Python");
  if (existsSync(join(cwd, "go.mod"))) stacks.push("Go");
  if (existsSync(join(cwd, "Cargo.toml"))) stacks.push("Rust");
  return stacks;
}

/**
 * Best-effort `name`/`description` seed from `package.json`, for the
 * PROJECT.md template only — NOT part of `detectStack`'s own contract
 * (which only reports stack presence). Degrades to `{}` on any read/parse
 * failure or missing/non-string fields — never throws.
 */
function readPackageManifestMeta(cwd: string): { name?: string; description?: string } {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      name?: unknown;
      description?: unknown;
    };
    const out: { name?: string; description?: string } = {};
    if (typeof parsed.name === "string" && parsed.name.trim()) out.name = parsed.name.trim();
    if (typeof parsed.description === "string" && parsed.description.trim()) {
      out.description = parsed.description.trim();
    }
    return out;
  } catch {
    return {};
  }
}

// ── Templates — inline, 100%-commented where the parser must read "empty" ───

function buildProjectMdTemplate(cwd: string, stacks: string[]): string {
  const meta = readPackageManifestMeta(cwd);
  const name = meta.name ?? basename(cwd);
  const descriptionLine = meta.description ?? "<!-- descreva o projeto em 1-2 frases -->";
  const stackSection =
    stacks.length > 0
      ? stacks.map((s) => `- ${s}`).join("\n")
      : "<!-- nenhuma stack detectada automaticamente (package.json/pyproject.toml/go.mod/Cargo.toml) — edite esta seção -->";

  return [
    `# PROJECT — ${name}`,
    "",
    "## O que é",
    descriptionLine,
    "",
    "## Stack",
    stackSection,
    "",
  ].join("\n");
}

// `parsePrefsBlock` (prefs.ts) only matches `^[A-Za-z_][\w-]*:` — a `#`-led
// line never matches, so this parses to an empty ForgePrefs, no warnings.
const PREFS_TEMPLATE = [
  "# Forge prefs (repo)",
  "",
  "```yaml",
  "# unit_model_plan_slice: claude-code/claude-opus-4-8",
  "# unit_model_execute_task: claude-code/claude-sonnet-5",
  "# unit_timeout_ms: 1200000",
  "```",
  "",
].join("\n");

// `parseModelsConfig` (auto/models-config.ts) strips `#...` before matching
// section headers — a fully commented block yields `emptyConfig()`, no
// duplicate-key/malformed-ref/undefined-pool warnings. Shape mirrors this
// repo's own `.gsd/models.md`.
const MODELS_TEMPLATE = [
  "# Forge models — role×pool (repo)",
  "",
  "```yaml",
  "# models:",
  "#   pools:",
  "#     claude-heavy: [claude-code/claude-fable-5, claude-code/claude-opus-4-8]",
  "#     claude-exec: [claude-code/claude-sonnet-5, claude-code/claude-opus-4-8]",
  "#   roles:",
  "#     planner: [claude-heavy]",
  "#     executor: [claude-exec]",
  "#     reviewer: [claude-heavy]",
  "#   constraints:",
  "#     reviewer_not_author: family",
  "#     on_missing_pool: degrade+warn",
  "```",
  "",
].join("\n");

function templateContentFor(key: string, cwd: string, stacks: string[]): string {
  switch (key) {
    case "PROJECT.md":
      return buildProjectMdTemplate(cwd, stacks);
    case "STATE.md":
      // Empty-valid STATE.md — `parseState` round-trips it with `milestone: ""`,
      // the exact state `runAuto` already degrades cleanly from (M1-D4).
      return serializeState({ milestone: "" });
    case "prefs.md":
      return PREFS_TEMPLATE;
    case "models.md":
      return MODELS_TEMPLATE;
    default:
      return "";
  }
}

// ── Structural zero-overwrite write ─────────────────────────────────────────

/**
 * Writes `content` to `path` ONLY if it doesn't already exist — enforced by
 * the OS `wx` open flag, not an `existsSync` convention (a convention can be
 * raced or simply forgotten in a future edit; `wx` cannot). Returns whether
 * the write actually happened.
 */
function writeFileIfMissing(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

// ── .gitignore — opt-in only ─────────────────────────────────────────────────

export interface GitignoreApplyResult {
  path: string;
  /** True when the `.gsd/` entry was appended by this call. */
  added: boolean;
  /** True when the entry was already present (implies `added: false`). */
  alreadyPresent: boolean;
}

/**
 * Appends a `.gsd/` line to `<cwd>/.gitignore`, creating the file if it
 * doesn't exist. Never duplicates: a pre-existing `.gsd/` or `.gsd` line
 * (exact match, ignoring surrounding whitespace) short-circuits to a no-op.
 */
function appendGitignoreEntry(cwd: string): GitignoreApplyResult {
  const path = join(cwd, ".gitignore");
  const existed = existsSync(path);
  const raw = existed ? readFileSync(path, "utf8") : "";
  const alreadyPresent = raw.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === ".gsd/" || trimmed === ".gsd";
  });
  if (alreadyPresent) return { path, added: false, alreadyPresent: true };

  // S03-R1 (review, conceded): append-only write — a whole-file
  // read-modify-writeFileSync could silently DISCARD content another process
  // (editor save, concurrent init) wrote between our read and our write.
  // appendFileSync never clobbers foreign content; the residual race is a
  // harmless duplicate `.gsd/` line, not data loss.
  const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${prefix}.gsd/\n`);
  return { path, added: true, alreadyPresent: false };
}

// ── applyInit — the only writer ─────────────────────────────────────────────

export interface InitApplyResult {
  mode: "bootstrap" | "repair";
  /** Items that were missing and got created just now. */
  created: InitItemStatus[];
  /** Items that already existed and were left untouched. */
  skipped: InitItemStatus[];
  gitignore?: GitignoreApplyResult;
}

/**
 * Creates ONLY the missing skeleton items (never reads `opts.repair` to
 * decide WHETHER to write — the caller already decided that by choosing to
 * call this at all; `opts.repair` only labels the resulting report).
 * `opts.gitignore` optionally appends the `.gitignore` entry in the same
 * call. Idempotent and safe to call repeatedly.
 */
export function applyInit(
  cwd: string,
  opts: { repair?: boolean; gitignore?: boolean } = {},
): InitApplyResult {
  const gsdDir = join(cwd, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  const stacks = detectStack(cwd);
  const report = buildInitReport(cwd);

  const created: InitItemStatus[] = [];
  const skipped: InitItemStatus[] = [];

  for (let i = 0; i < INIT_ITEMS.length; i++) {
    const def = INIT_ITEMS[i];
    const item = report.items[i];

    if (item.status === "exists") {
      // S03-R2 (review, conceded): an existing dir may have lost its
      // `.gitkeep` (git can't preserve empty dirs) — --repair used to skip it
      // and still report a "complete" skeleton. Re-ensure the keep file.
      if (def.kind === "dir") {
        try {
          writeFileIfMissing(join(item.path, ".gitkeep"), "");
        } catch {
          /* best-effort — the dir itself exists */
        }
      }
      skipped.push(item);
      continue;
    }

    if (item.status === "conflict") {
      // S03-R3: never mkdir/write over a wrong-type path — that's the
      // EISDIR/EEXIST crash. Left untouched; the report names the conflict.
      skipped.push(item);
      continue;
    }

    if (def.kind === "dir") {
      mkdirSync(item.path, { recursive: true });
      writeFileIfMissing(join(item.path, ".gitkeep"), "");
    } else {
      writeFileIfMissing(item.path, templateContentFor(def.key, cwd, stacks));
    }
    created.push({ ...item, status: "exists" });
  }

  const result: InitApplyResult = {
    mode: opts.repair ? "repair" : "bootstrap",
    created,
    skipped,
  };
  if (opts.gitignore) {
    result.gitignore = appendGitignoreEntry(cwd);
  }
  return result;
}

// ── formatInitReport — pt-BR rendering, one branch per mode ─────────────────

export type InitReportView =
  | { mode: "bootstrap"; result: InitApplyResult }
  | { mode: "doctor"; report: InitReport; gitignore?: GitignoreApplyResult }
  | { mode: "repair"; result: InitApplyResult };

function formatGitignoreLine(g: GitignoreApplyResult): string {
  if (g.added) return "  ✓ .gitignore: entrada '.gsd/' adicionada.";
  return "  · .gitignore: entrada '.gsd/' já presente (nada a fazer).";
}

export function formatInitReport(view: InitReportView): string {
  switch (view.mode) {
    case "bootstrap": {
      const lines = ["/forge init: esqueleto .gsd/ criado."];
      for (const item of view.result.created) lines.push(`  ✓ criado: ${item.label}`);
      if (view.result.gitignore) lines.push(formatGitignoreLine(view.result.gitignore));
      return lines.join("\n");
    }
    case "doctor": {
      const lines = ["/forge init — doctor-lite (.gsd/ já existe):"];
      let anyMissing = false;
      for (const item of view.report.items) {
        if (item.status === "missing") anyMissing = true;
        const glyph =
          item.status === "exists" ? "✓ existe" : item.status === "conflict" ? "⚠ conflito de tipo (resolva manualmente)" : "✗ falta";
        lines.push(`  ${glyph}  ${item.label}`);
      }
      if (view.gitignore) lines.push(formatGitignoreLine(view.gitignore));
      if (anyMissing) lines.push("", "Rode '/forge init --repair' para criar apenas o que falta.");
      return lines.join("\n");
    }
    case "repair": {
      const lines = ["/forge init --repair:"];
      const conflicts = view.result.skipped.filter((item) => item.status === "conflict");
      const existed = view.result.skipped.filter((item) => item.status !== "conflict");
      if (view.result.created.length === 0 && conflicts.length === 0) {
        lines.push("  nada faltava — .gsd/ já está completo.");
      } else {
        for (const item of view.result.created) lines.push(`  ✓ criado: ${item.label}`);
      }
      for (const item of existed) lines.push(`  · já existia (mantido): ${item.label}`);
      for (const item of conflicts) lines.push(`  ⚠ conflito de tipo (resolva manualmente): ${item.label}`);
      if (view.result.gitignore) lines.push(formatGitignoreLine(view.result.gitignore));
      return lines.join("\n");
    }
  }
}

// ── runInitCommand ───────────────────────────────────────────────────────────

/**
 * Run `/forge init [--repair] [--gitignore]`. No `.gsd/` at `ctx.cwd` →
 * bootstrap (always creates the full skeleton). `.gsd/` present → doctor-lite
 * report (zero writes) unless `--repair` is given, which creates only what's
 * missing. `--gitignore` is independent of the above — it appends the
 * `.gsd/` entry whenever passed, in every mode. No interactive prompts, ever.
 */
export function runInitCommand(ctx: ExtensionCommandContext, rest: string[]): void {
  const cwd = ctx.cwd;
  const repair = rest.includes("--repair");
  const gitignore = rest.includes("--gitignore");
  const gsdExists = existsSync(join(cwd, ".gsd"));

  let text: string;
  if (!gsdExists) {
    const result = applyInit(cwd, { repair: false, gitignore });
    text = formatInitReport({ mode: "bootstrap", result });
  } else if (repair) {
    const result = applyInit(cwd, { repair: true, gitignore });
    text = formatInitReport({ mode: "repair", result });
  } else {
    const report = buildInitReport(cwd);
    const gitignoreResult = gitignore ? appendGitignoreEntry(cwd) : undefined;
    text = formatInitReport({ mode: "doctor", report, gitignore: gitignoreResult });
  }

  if (isPrintHeadlessContext(ctx)) process.stdout.write(text + "\n");
  else ctx.ui.notify(text, "info");
}
