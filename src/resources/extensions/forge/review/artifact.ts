/**
 * Forge review — artifact layer: the SINGLE owner of the `S##-REVIEW.md`
 * grammar. Native port of the forge 1.0 review workflow
 * (`shared/forge-review.md`) Steps 6 (render the dialogue), 7a/7b (the
 * conceded-fix / decision write-backs) and 9.1 (collect the still-pending items
 * for the milestone-final triage). Reader and writer share ONE grammar so there
 * is no drift between what is rendered and what is later parsed.
 *
 * Rewritten in the forge namespace — NEVER imported from the condemned `gsd/`
 * tree (B2). The pure resolution types come from `review/resolve.ts` (T01); the
 * atomic writer comes from `state/ledger.ts` (`writeFileAtomic`, S03).
 *
 * Design (S05-PLAN § D-S05-4, with the S04 review lessons baked in):
 *   - `renderReview`/`renderReviewStub` are PURE: no I/O, no `Date`. The
 *     `Reviewed:` stamp is INJECTED via `meta.reviewedOn` (the caller runs
 *     `date +%Y-%m-%d`; the 1.0 rule forbids `new Date()` inside the render).
 *   - `writeReview` is atomic (temp+rename) and IDEMPOTENT by PRE-mutation
 *     compare: byte-identical content already on disk → `{ created: false }`,
 *     zero writes (S04-R1). The path is milestone-namespaced BY CONSTRUCTION
 *     (S04-R2) and built directly with no `isValid()` gate so synthetic test
 *     ids work (gotcha S03/T07).
 *   - the write-backs are idempotent: re-applying the same value rewrites no
 *     bytes and returns `{ updated: false }` (S04-R3); an unknown R# is a
 *     `{ updated: false }` no-op, never a throw.
 *   - `collectPendingReviewItems` is tolerant: absent/unreadable/truncated
 *     artifacts are skipped, never fatal.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../state/ledger.js";
import type { ResolveReviewResult, ResolvedReviewItem } from "./resolve.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Everything the render needs that is NOT derivable from the resolution result.
 * `reviewedOn` is injected (never computed) so the render stays pure and the
 * golden output is deterministic. `rounds` echoes how many rebuttal rounds ran.
 */
export interface ReviewArtifactMeta {
  milestoneId: string;
  slice: string;
  sliceTitle: string;
  reviewedOn: string;
  rounds: number;
}

/** Posture of a still-pending item surfaced to the milestone-final triage. */
export type PendingReviewStatus = "open" | "conceded-sem-fix";

/**
 * One item the Step 9.1 collect hands to the operator before complete-milestone.
 *
 * `slice` carries the `S##` slice id for milestone-scoped collects
 * (`collectPendingReviewItems`/`collectPendingReviewBlocks`) and the loose
 * task's `TASK_ID` for task-store collects (`collectPendingTaskReviewItems`/
 * `collectPendingTaskReviewBlocks`, S03/T03) — the shape is intentionally
 * shared rather than forked, since the entire write-back (`applyDecision`/
 * `applyConcededFix`/`appendReviewFollowUps`) operates on `reviewPath` and is
 * already agnostic of what kind of id `slice` holds.
 */
export interface PendingReviewItem {
  slice: string;
  id: string;
  pathLine: string;
  claim: string;
  status: PendingReviewStatus;
}

/**
 * `PendingReviewItem` plus the verbatim `### R#` block text (header through the
 * last dialogue field) and the absolute path of the REVIEW.md it came from —
 * what `/forge fix` (T03) inlines into the review-fix prompt and later needs to
 * call `applyDecision`/`applyConcededFix` on.
 */
export interface PendingReviewBlock extends PendingReviewItem {
  dialogue: string;
  reviewPath: string;
}

// ── Grammar constants (the LOCKED marker strings — one source of truth) ─────────

/** The unfilled decision/fix placeholder both render and write-backs anchor on. */
const PENDING = "_pendente_";

/** Step 7b write-back: an OPEN item deferred to the milestone-final triage. */
const DECISION_DEFERRED = "deferido → triagem no fim da milestone";
/** Step 7a write-back: a CONCEDED item whose fix could not land. */
const CORRECTION_FAILED = "falhou — deferida para triagem final";
/** Legacy pre-triage marker (still honored by the Step 9.1 collect). */
const DECISION_DEFERRED_LEGACY = "deferido (auto-mode)";

// ── Path helper (milestone-namespaced by construction — S04-R2) ─────────────────

export function normCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/");
}

/**
 * Absolute path to `.gsd/milestones/<mid>/slices/<S##>/<S##>-REVIEW.md`. Built
 * directly, with NO `isValid()` gate (synthetic test ids must resolve — gotcha
 * S03/T07). Exported so T05 and the e2e reuse the exact same construction.
 */
export function reviewArtifactPath(cwd: string, milestoneId: string, slice: string): string {
  return join(normCwd(cwd), ".gsd", "milestones", milestoneId, "slices", slice, `${slice}-REVIEW.md`);
}

// ── Render (PURE — data injected, no Date, no I/O) ──────────────────────────────

/** Numeric-aware sort of `R#` ids (R2 before R10) with a string fallback. */
function byId(a: { id: string }, b: { id: string }): number {
  const na = Number(a.id.replace(/^R/i, ""));
  const nb = Number(b.id.replace(/^R/i, ""));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.id.localeCompare(b.id);
}

/** The shared header block (title + Slice/Milestone/Reviewed/Rounds + Outcome). */
function header(meta: ReviewArtifactMeta, outcome: string): string {
  return (
    `# ${meta.slice}: ${meta.sliceTitle} — Review (Dialectic)\n` +
    `**Slice:** ${meta.slice}  **Milestone:** ${meta.milestoneId}  ` +
    `**Reviewed:** ${meta.reviewedOn}  **Rounds:** ${meta.rounds}\n` +
    `**Outcome:** ${outcome}\n`
  );
}

function renderOpen(items: ResolvedReviewItem[]): string {
  const out: string[] = [
    "## Abertas — requerem decisão humana",
    "> O reviewer e o autor não chegaram a acordo. Você decide.",
  ];
  for (const it of items) {
    out.push(
      `### ${it.id} — \`${it.pathLine}\``,
      `- **Objeção:** ${it.claim} — _${it.challenge}_`,
      `- **Defesa:** ${it.defense.rationale}`,
      `- **Réplica:** ${it.rebuttal.rationale}`,
      `- **Decisão:** ${PENDING}`,
    );
  }
  return out.join("\n");
}

function renderConceded(items: ResolvedReviewItem[]): string {
  const out: string[] = ["## Concedidas — problema real, corrigido"];
  for (const it of items) {
    out.push(
      `### ${it.id} — \`${it.pathLine}\``,
      `- **Objeção:** ${it.claim}`,
      `- **Defesa:** conceded — ${it.defense.rationale}`,
      `- **Correção:** ${PENDING}`,
    );
  }
  return out.join("\n");
}

function renderResolved(items: ResolvedReviewItem[]): string {
  const out: string[] = ["## Resolvidas no debate — sem ação"];
  for (const it of items) {
    out.push(`- ${it.id} \`${it.pathLine}\` — ${it.rebuttal.rationale}`);
  }
  return out.join("\n");
}

/**
 * Render the `S##-REVIEW.md` artifact from a resolution result. PURE and
 * deterministic (parity with the Step 6 LOCKED template): sections with zero
 * items are OMITTED; `noFlags` produces the clean artifact. `Outcome` in the
 * header is `X resolved · Y conceded · Z open` computed from the counts.
 */
export function renderReview(meta: ReviewArtifactMeta, result: ResolveReviewResult): string {
  const { resolved, conceded, open } = result.counts;
  const outcome = `${resolved} resolved · ${conceded} conceded · ${open} open`;
  const head = header(meta, outcome);

  if (result.noFlags) {
    return `${head}\nReviewer found nothing to challenge.\n`;
  }

  const openItems = result.items.filter((i) => i.resolution === "open").sort(byId);
  const concededItems = result.items.filter((i) => i.resolution === "conceded").sort(byId);
  const resolvedItems = result.items.filter((i) => i.resolution === "resolved").sort(byId);

  const sections: string[] = [];
  if (openItems.length > 0) sections.push(renderOpen(openItems));
  if (concededItems.length > 0) sections.push(renderConceded(concededItems));
  if (resolvedItems.length > 0) sections.push(renderResolved(resolvedItems));

  // Header, then each non-empty section separated by a blank line. When every
  // section is empty (all items filtered out, e.g. counts drifting) the header
  // alone still forms a valid artifact.
  return sections.length > 0 ? `${head}\n${sections.join("\n\n")}\n` : `${head}`;
}

/**
 * Render the degenerate "review could not run" artifact (the Step 2 throw in the
 * orchestrator: the challenger itself failed). PURE — `reason` is the caller's
 * one-line explanation. Keeps the same header shape with an `Outcome` sentinel.
 */
export function renderReviewStub(meta: ReviewArtifactMeta, reason: string): string {
  const head = header(meta, "review could not run");
  return `${head}\n> Review could not run: ${reason}\n`;
}

// ── writeReview (atomic + idempotent by PRE-mutation compare — S04-R1) ──────────

/**
 * Write `content` to the milestone-namespaced `S##-REVIEW.md` atomically
 * (temp+rename via `writeFileAtomic`, which also `mkdir -p`s the directory).
 * Idempotent by PRE-mutation compare: if the target already holds byte-identical
 * content, returns `{ created: false }` with ZERO writes (S04-R1). Otherwise
 * writes and returns `{ created: true }`. The path carries the milestone id by
 * construction (S04-R2) and is built with no `isValid()` gate (gotcha S03/T07).
 */
export function writeReview(
  cwd: string,
  milestoneId: string,
  slice: string,
  content: string,
): { path: string; created: boolean } {
  const path = reviewArtifactPath(cwd, milestoneId, slice);

  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf-8") === content) return { path, created: false };
    } catch {
      // unreadable — fall through and (re)write
    }
  }

  writeFileAtomic(path, content);
  return { path, created: true };
}

// ── Block model (shared by the write-backs and the collect) ─────────────────────

/** A rendered `### R# — \`path:line\`` block and its half-open line range. */
interface ReviewBlock {
  id: string;
  pathLine: string;
  start: number; // index of the `### R#` header line
  end: number; // exclusive: next block header or next `## ` heading or EOF
}

const BLOCK_HEADER = /^###\s+(R\d+)\s+[—-]\s+`([^`]*)`/;
const SECTION_HEADER = /^##\s+\S/;

/** Locate every `### R#` block in the artifact, in file order. */
function reviewBlocks(lines: string[]): ReviewBlock[] {
  const blocks: ReviewBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BLOCK_HEADER.exec(lines[i]);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (BLOCK_HEADER.test(lines[j]) || SECTION_HEADER.test(lines[j])) {
        end = j;
        break;
      }
    }
    blocks.push({ id: m[1], pathLine: m[2], start: i, end });
  }
  return blocks;
}

/**
 * Replace, inside the `### R#` block whose id matches, the FIRST line that starts
 * with `fieldPrefix` (e.g. `- **Correção:**`) by `newLine`. Returns the mutated
 * lines and a tri-state `status`: `"changed"` (write needed), `"already"` (the
 * field already holds `newLine` — idempotent no-op, but the value IS correct),
 * or `"missing"` (the block or the field line isn't there — a REAL failure, not
 * idempotency). Callers that only care "did I write" treat `"changed"` as the
 * write signal; callers that care "is the value correctly in place" (R2) treat
 * `"changed"` and `"already"` the same, and `"missing"` as the failure.
 */
function replaceInBlock(
  lines: string[],
  id: string,
  fieldPrefix: string,
  newLine: string,
): { lines: string[]; status: "changed" | "already" | "missing" } {
  const block = reviewBlocks(lines).find((b) => b.id === id);
  if (!block) return { lines, status: "missing" };
  for (let i = block.start + 1; i < block.end; i++) {
    if (lines[i].startsWith(fieldPrefix)) {
      if (lines[i] === newLine) return { lines, status: "already" }; // idempotent no-op
      const next = lines.slice();
      next[i] = newLine;
      return { lines: next, status: "changed" };
    }
  }
  return { lines, status: "missing" };
}

/** Read the artifact into lines, or `null` if it is absent/unreadable. */
function readLines(path: string): string[] | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8").split("\n");
  } catch {
    return null;
  }
}

// ── Write-backs (Step 7a / 7b — idempotent, no-throw on unknown R#) ─────────────

/**
 * Step 7a write-back: stamp the `**Correção:**` line of a CONCEDED item.
 * `outcome` is `{ sha }` (the review-fix landed → `aplicada — commit <sha>`) or
 * `"failed"` (dispatch threw / non-done → `falhou — deferida para triagem
 * final`). Idempotent: re-applying the same value rewrites no bytes and returns
 * `{ updated: false }` (S04-R3). Unknown R# / missing line → `{ updated: false }`,
 * never a throw. The write, when it happens, is atomic.
 *
 * `alreadyApplied` (R2) additionally distinguishes the two `updated: false`
 * causes for callers that need to know whether the value IS correctly in
 * place: `true` when the field already held this exact value (idempotent
 * no-op), `false` when the block/field is missing (a real failure — the
 * artifact vanished, was rewritten, or its grammar changed underneath us).
 */
export function applyConcededFix(
  reviewPath: string,
  id: string,
  outcome: { sha: string } | "failed",
): { updated: boolean; alreadyApplied: boolean } {
  const lines = readLines(reviewPath);
  if (lines === null) return { updated: false, alreadyApplied: false };

  const value = outcome === "failed" ? CORRECTION_FAILED : `aplicada — commit ${outcome.sha}`;
  const newLine = `- **Correção:** ${value}`;
  const res = replaceInBlock(lines, id, "- **Correção:**", newLine);
  if (res.status === "missing") return { updated: false, alreadyApplied: false };
  if (res.status === "already") return { updated: false, alreadyApplied: true };

  writeFileAtomic(reviewPath, res.lines.join("\n"));
  return { updated: true, alreadyApplied: false };
}

/**
 * Step 7b write-back: stamp the `**Decisão:**` line of an OPEN item with the
 * human/auto decision text (e.g. the default `deferido → triagem no fim da
 * milestone`). Idempotent and no-throw on unknown R#, exactly like
 * `applyConcededFix`. Atomic write on change. `alreadyApplied` has the same
 * meaning as `applyConcededFix`'s (R2).
 */
export function applyDecision(
  reviewPath: string,
  id: string,
  decision: string,
): { updated: boolean; alreadyApplied: boolean } {
  const lines = readLines(reviewPath);
  if (lines === null) return { updated: false, alreadyApplied: false };

  const newLine = `- **Decisão:** ${decision}`;
  const res = replaceInBlock(lines, id, "- **Decisão:**", newLine);
  if (res.status === "missing") return { updated: false, alreadyApplied: false };
  if (res.status === "already") return { updated: false, alreadyApplied: true };

  writeFileAtomic(reviewPath, res.lines.join("\n"));
  return { updated: true, alreadyApplied: false };
}

// ── collectPendingReviewItems (Step 9.1 — tolerant scan) ────────────────────────

/** Strip the trailing ` — _<challenge>_` from an open item's objection text. */
function stripChallenge(claim: string): string {
  return claim.replace(/\s+[—-]\s+_.*_\s*$/, "").trim();
}

/** Value of the FIRST `fieldPrefix` line inside a block, or `null`. */
function fieldValue(lines: string[], block: ReviewBlock, fieldPrefix: string): string | null {
  for (let i = block.start + 1; i < block.end; i++) {
    if (lines[i].startsWith(fieldPrefix)) {
      return lines[i].slice(fieldPrefix.length).trim();
    }
  }
  return null;
}

/**
 * Resolve pending status from a block's `Decisão`/`Correção` field values, or
 * `null` if decided/n-a.
 *
 * PRODUCTION BUG fixed here (M8 close, 2026-07-12): the FRESH artifact state —
 * `renderReview` writes `_pendente_` into `Decisão:` (open items) and
 * `Correção:` (conceded items), and NOTHING ever rewrites those into the
 * defer markers below — was not recognized, so the milestone-final triage
 * journaled "nenhum item de review pendente" over 10 real items (7 conceded +
 * 3 open) and the finale digest rendered empty on its first real run. The
 * defer markers remain honored for the explicit write-back paths.
 */
function pendingStatus(decisao: string | null, correcao: string | null): PendingReviewStatus | null {
  if (decisao === PENDING || decisao === DECISION_DEFERRED || decisao === DECISION_DEFERRED_LEGACY) return "open";
  if (correcao === PENDING || correcao === CORRECTION_FAILED) return "conceded-sem-fix";
  return null;
}

/** One `slices/<S##>/<S##>-REVIEW.md` successfully read off disk. */
interface SliceReviewArtifact {
  slice: string;
  path: string;
  content: string;
}

/**
 * List every readable `slices/<S##>/<S##>-REVIEW.md` under the milestone, in
 * slice order. Shared scan behind `collectPendingReviewItems` and
 * `collectPendingReviewBlocks` — absent slices dir, absent artifact, and
 * unreadable artifact are all skipped, never fatal.
 */
function listSliceReviewArtifacts(cwd: string, milestoneId: string): SliceReviewArtifact[] {
  const slicesDir = join(normCwd(cwd), ".gsd", "milestones", milestoneId, "slices");
  let entries: string[];
  try {
    entries = readdirSync(slicesDir);
  } catch {
    return []; // milestone has no slices dir yet — nothing to collect
  }

  const out: SliceReviewArtifact[] = [];
  for (const slice of entries.sort()) {
    if (!/^S\d+$/.test(slice)) continue;
    const path = join(slicesDir, slice, `${slice}-REVIEW.md`);
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue; // unreadable — skip, never throw
    }
    out.push({ slice, path, content });
  }
  return out;
}

/** Scan a single artifact's blocks and push any still-pending items. */
function collectFromArtifact(slice: string, content: string, out: PendingReviewItem[]): void {
  const lines = content.split("\n");
  for (const block of reviewBlocks(lines)) {
    const objecao = fieldValue(lines, block, "- **Objeção:**");
    if (objecao === null) continue; // truncated block — skip, never throw

    const status = pendingStatus(
      fieldValue(lines, block, "- **Decisão:**"),
      fieldValue(lines, block, "- **Correção:**"),
    );
    if (status === null) continue;

    out.push({
      slice,
      id: block.id,
      pathLine: block.pathLine,
      claim: stripChallenge(objecao),
      status,
    });
  }
}

/**
 * Step 9.1 collect: scan every `slices/<S##>/<S##>-REVIEW.md` under the milestone and
 * return the items still pending triage — OPEN items deferred by Step 7b
 * (`deferido → triagem no fim da milestone`), CONCEDED items whose fix failed
 * (`falhou — deferida para triagem final`), and the legacy `deferido
 * (auto-mode)` marker. Absent/unreadable/truncated artifacts are skipped; this
 * function NEVER throws.
 */
/**
 * S04-R1 (review, open → conceded pelo operador): an unreadable or
 * grammatically-broken `S##-REVIEW.md` used to be INDISTINGUISHABLE from a
 * milestone with zero pending reviews — the digest/finale would happily show
 * "all clear" over artifacts it could not parse. This returns one warning
 * line per problem so the digest can surface them: read failures, and files
 * where the visible `### R#` headings outnumber the blocks that actually
 * parse (grammar drift on any one block — not just total parse failure).
 */
export function collectReviewArtifactWarnings(cwd: string, milestoneId: string): string[] {
  const warnings: string[] = [];
  const slicesDir = join(normCwd(cwd), ".gsd", "milestones", milestoneId, "slices");
  let entries: string[];
  try {
    entries = readdirSync(slicesDir);
  } catch {
    return warnings;
  }
  for (const slice of entries.sort()) {
    if (!/^S\d+$/.test(slice)) continue;
    const path = join(slicesDir, slice, `${slice}-REVIEW.md`);
    if (!existsSync(path)) continue;
    let content: string | null = null;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      warnings.push(`${slice}: REVIEW.md ilegível — triagem manual em ${path}`);
      continue;
    }
    const headingCount = (content.match(/^### R\d+/gm) ?? []).length;
    if (headingCount > reviewBlocks(content.split("\n")).length) {
      warnings.push(`${slice}: REVIEW.md com blocos não-parseáveis — verifique ${path}`);
    }
  }
  return warnings;
}

export function collectPendingReviewItems(cwd: string, milestoneId: string): PendingReviewItem[] {
  const out: PendingReviewItem[] = [];
  for (const artifact of listSliceReviewArtifacts(cwd, milestoneId)) {
    collectFromArtifact(artifact.slice, artifact.content, out);
  }
  return out;
}

/** Scan a single artifact's blocks and push any still-pending items WITH verbatim dialogue. */
function collectBlocksFromArtifact(
  slice: string,
  reviewPath: string,
  content: string,
  idFilter: string | undefined,
  out: PendingReviewBlock[],
): void {
  const lines = content.split("\n");
  for (const block of reviewBlocks(lines)) {
    if (idFilter && idFilter !== block.id) continue;

    const objecao = fieldValue(lines, block, "- **Objeção:**");
    if (objecao === null) continue; // truncated block — skip, never throw

    const status = pendingStatus(
      fieldValue(lines, block, "- **Decisão:**"),
      fieldValue(lines, block, "- **Correção:**"),
    );
    if (status === null) continue;

    out.push({
      slice,
      id: block.id,
      pathLine: block.pathLine,
      claim: stripChallenge(objecao),
      status,
      dialogue: lines.slice(block.start, block.end).join("\n"),
      reviewPath,
    });
  }
}

/**
 * Same pending-triage scan as `collectPendingReviewItems`, but returns the
 * verbatim `### R#` block text (`dialogue`) and the origin REVIEW.md's absolute
 * path (`reviewPath`) each item came from — what `/forge fix` inlines into the
 * review-fix prompt and later needs for the write-back. Filterable by `slice`
 * and/or `id` (both optional; unmatched filters yield `[]`). Uses the exact same
 * markers/scan as `collectPendingReviewItems` — never throws.
 */
export function collectPendingReviewBlocks(
  cwd: string,
  milestoneId: string,
  filter?: { slice?: string; id?: string },
): PendingReviewBlock[] {
  const out: PendingReviewBlock[] = [];
  for (const artifact of listSliceReviewArtifacts(cwd, milestoneId)) {
    if (filter?.slice && filter.slice !== artifact.slice) continue;
    collectBlocksFromArtifact(artifact.slice, artifact.path, artifact.content, filter?.id, out);
  }
  return out;
}

// ── Task-store collectors (S03/T03) ─────────────────────────────────────────
//
// Loose tasks (`/forge task`, outside any milestone) get their own
// `<TASK_ID>-REVIEW.md` under `.gsd/tasks/<TASK_ID>/` (S03/T02). These
// collectors give `/forge fix` (S03/T03) eyes on that store, reusing the
// EXACT same block grammar and tolerant-read posture as the milestone-side
// collectors above — only the listing (task dir instead of slices dir) and
// the id that lands in `PendingReviewItem.slice` (TASK_ID instead of S##)
// differ. `reviewArtifactPath` stays milestone-only by design (Standards);
// the task-store path is built inline by `listTaskReviewArtifacts` instead
// of a sibling exported path helper, since (unlike the slice case) no other
// module needs to construct it independently of a listing.

/** One readable `.gsd/tasks/<taskId>/<taskId>-REVIEW.md` off disk. */
interface TaskReviewArtifact {
  taskId: string;
  path: string;
  content: string;
}

/**
 * List every readable `.gsd/tasks/<taskId>/<taskId>-REVIEW.md`, sorted by
 * `taskId` (timestamp ids sort chronologically, mirroring
 * `listSliceReviewArtifacts`'s slice sort). An absent `.gsd/tasks/` dir, a
 * task subdir with no `-REVIEW.md` yet (review hasn't run, or the task is
 * still mid-flight), and an unreadable artifact are all skipped — never
 * fatal (the tolerant-read posture documented across this file).
 */
function listTaskReviewArtifacts(cwd: string): TaskReviewArtifact[] {
  const tasksDir = join(normCwd(cwd), ".gsd", "tasks");
  let entries: string[];
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return []; // no .gsd/tasks/ yet — nothing to collect
  }

  const out: TaskReviewArtifact[] = [];
  for (const taskId of entries.sort()) {
    const path = join(tasksDir, taskId, `${taskId}-REVIEW.md`);
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue; // unreadable — skip, never throw
    }
    out.push({ taskId, path, content });
  }
  return out;
}

/**
 * Task-store sibling of `collectPendingReviewItems`: scans every readable
 * `.gsd/tasks/<taskId>/<taskId>-REVIEW.md` and returns the items still
 * pending triage, with `slice` holding each item's `TASK_ID` (see the
 * `PendingReviewItem` doc comment). Same markers, same tolerant-read
 * posture, never throws.
 */
export function collectPendingTaskReviewItems(cwd: string): PendingReviewItem[] {
  const out: PendingReviewItem[] = [];
  for (const artifact of listTaskReviewArtifacts(cwd)) {
    collectFromArtifact(artifact.taskId, artifact.content, out);
  }
  return out;
}

/**
 * Task-store sibling of `collectPendingReviewBlocks`: same pending-triage
 * scan as `collectPendingTaskReviewItems`, but returns the verbatim `### R#`
 * block text (`dialogue`) and the origin REVIEW.md's absolute path
 * (`reviewPath`) — what `/forge fix T-<id>` (S03/T04) will inline into the
 * review-fix prompt and later need for the write-back. Filterable by
 * `taskId` and/or `id` (both optional; unmatched filters yield `[]`). Never
 * throws.
 */
export function collectPendingTaskReviewBlocks(
  cwd: string,
  filter?: { taskId?: string; id?: string },
): PendingReviewBlock[] {
  const out: PendingReviewBlock[] = [];
  for (const artifact of listTaskReviewArtifacts(cwd)) {
    if (filter?.taskId && filter.taskId !== artifact.taskId) continue;
    collectBlocksFromArtifact(artifact.taskId, artifact.path, artifact.content, filter?.id, out);
  }
  return out;
}
