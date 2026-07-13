import { execFileSync } from "node:child_process";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { findExactModelReferenceMatch } from "@gsd/pi-coding-agent/core/model-resolver.js";
import { getForgeAutoSession } from "../auto/session.js";
import { writeFileAtomic } from "../state/ledger.js";
import type { NextUnit } from "../state/dispatch.js";
import {
  resolveReview,
  type ResolveReviewResult,
  type ReviewObjection,
  type ReviewVerdict,
} from "./resolve.js";
import {
  advocatePrompt,
  challengerPrompt,
  rebuttalPrompt,
  renderDefenseText,
  renderObjectionsText,
} from "./prompts.js";
import { parseObjections, parseVerdicts } from "./parse.js";
import {
  renderReview,
  renderReviewStub,
  writeReview,
  type ReviewArtifactMeta,
} from "./artifact.js";
import { readReviewPrefs } from "./review-prefs.js";
import { readEvents } from "../state/store.js";
import type { ForgeEvent } from "../state/types.js";
import { resolveModelForRole, type ResolveModelCtx } from "../auto/role.js";

export interface ReviewDispatchOptions {
  workingDir: string;
  model: string | null;
  provider: string | null;
}

/** Injectable seam for review workers. Review workers return text, never a unit result. */
export interface ReviewDispatcher {
  dispatch(prompt: string, opts: ReviewDispatchOptions): Promise<string | null>;
}

function assistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const value = message as { role?: string; content?: unknown };
  if (value.role !== "assistant" || !Array.isArray(value.content)) return null;
  return value.content
    .filter((part): part is { type: string; text: string } =>
      Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string"),
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * Fail-closed cast signal: the resolved review model could not be applied to
 * the fresh session (registry miss, host refusal, or post-turn authorship
 * mismatch). The dialectic converts this into a DECLARED stub — silently
 * running the turn on the session's default model re-creates the exact
 * violation `reviewer_not_author` exists to prevent (a Fable session
 * "reviewing" Fable-family code while the artifact filename claims gpt —
 * seleção≠consumo, 5ª recorrência da classe).
 */
export class ReviewModelCastError extends Error {}

/**
 * Non-cast dispatch failure with the REAL reason preserved (S04 finding: the
 * generic `catch { return null }` swallowed everything, so every stub read
 * "challenger falhou" with zero diagnostic surface — the newSession never even
 * created a session file and nobody could say why). The dialectic prints the
 * detail into the stub/warning, making the artifact the diagnostic.
 */
export class ReviewDispatchError extends Error {}

interface CapturedAssistant {
  text: string | null;
  model: string | null;
}

type BranchReader = { getBranch(): unknown[] };

/**
 * Last assistant message WITH text on the current branch, read from the fresh
 * session's transcript AFTER the turn settled (`sendMessage` with
 * `triggerTurn` awaits the whole turn — `agent-session-prompt.ts:418`). The
 * `model` field is the same authorship the TUI badge renders
 * (`assistant-message.ts`), so verification uses the authoritative source.
 * `ReplacedSessionContext` exposes NO event subscription — a `message_end`
 * listener on it is a silent no-op (root cause of every historical
 * "challenger falhou" stub).
 */
export function lastAssistantMessage(sm: BranchReader): CapturedAssistant {
  try {
    const entries = sm.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as { type?: string; message?: unknown } | undefined;
      if (entry?.type !== "message") continue;
      const text = assistantText(entry.message);
      if (text !== null && text.trim().length > 0) {
        const model = (entry.message as { model?: unknown }).model;
        return { text, model: typeof model === "string" ? model : null };
      }
    }
  } catch {
    // Read-only capture; a malformed branch degrades to the "falhou" stub.
  }
  return { text: null, model: null };
}

/**
 * Production read-only review turn, isolated from the unit rendezvous protocol.
 *
 * Model cast is FAIL-CLOSED and verified: the ref resolved by
 * `resolveModelForRole` is applied via the fresh instance's live `pi`
 * (`s.livePi`, republished by the `session_start` hook that runs BEFORE
 * `withSession` — B3), and the turn's authored model is checked against the
 * request afterwards. Any miss throws `ReviewModelCastError` instead of
 * letting the turn run on the session's default family. The applied model is
 * restored to the pre-dispatch baseline afterwards (`setModel` persists across
 * `newSession` replacements — R2), and `s.cmdCtx` is re-pointed inside
 * `withSession` exactly like the driver, so the SECOND dispatch of a dialectic
 * (advocate after challenger) never calls into a stale context.
 */
export function productionReviewDispatcher(ctx: ExtensionCommandContext): ReviewDispatcher {
  // Captured once, while `ctx` is still fresh: the model every review turn
  // restores on exit (mirror of `runAuto`'s baselineModel restore).
  const baseline = ctx.model;
  return {
    async dispatch(prompt, opts) {
      const s = getForgeAutoSession();
      // B3: after ANY prior `newSession` (a worker, or the previous review
      // turn) the captured `ctx` is stale and its members throw. The container
      // `cmdCtx` is re-pointed inside every `withSession` — prefer it.
      const live = s.cmdCtx ?? ctx;
      let captured: CapturedAssistant = { text: null, model: null };
      let castFailure: string | null = null;
      let applied = false;
      let toolsBeforeFilter: string[] | null = null;
      try {
        const outcome = await live.newSession({
          workspaceRoot: opts.workingDir,
          parentSession: s.runRootSessionPath ?? undefined,
          withSession: async (freshCtx) => {
            s.cmdCtx = freshCtx;
            let wantedId: string | null = null;
            const wanted = opts.model ?? opts.provider;
            if (wanted) {
              const pi = s.livePi;
              const target = pi
                ? findExactModelReferenceMatch(wanted, freshCtx.modelRegistry.getAll())
                : null;
              if (!pi || !target) {
                castFailure = `modelo '${wanted}' não aplicável (${pi ? "não encontrado no registry" : "sem handle live da sessão"})`;
                return; // fail closed — nunca rodar o turn na família errada
              }
              const ok = await pi.setModel(target);
              if (ok === false) {
                castFailure = `host recusou setModel('${wanted}')`;
                return;
              }
              applied = true;
              wantedId = typeof (target as { id?: unknown }).id === "string" ? (target as { id: string }).id : null;
            }
            // Reviews return TEXT, never a unit result (seam contract above).
            // The fresh session inherits the WORKER tool scope from the
            // session_start hook (`pendingUnitType` persists between
            // dispatches), and `forge_unit_result` is terminate:true — a
            // diligent reviewer calling it ends the turn with NO final text
            // (S05 finding: Luna investigated 10 tool rounds, then called
            // forge_unit_result and the turn terminated mute → stub). Strip
            // it, plus mutating and DELEGATING tools — the dialectic is
            // read-only and self-performed by contract (S06 finding: the
            // advocate saw the `subagent` tool + a 1.0 agent named
            // "forge-advocate" and delegated its whole defense to a
            // background job — every objection went undefended). This
            // pi-level filter only governs NATIVE providers; SDK-backed
            // sessions (claude-code) carry their own internal tools, which is
            // why the review prompts now also forbid delegation textually.
            // The pre-filter set is restored in `finally` (Luna's R2, S06):
            // without it a standalone `/forge review` permanently strips
            // write/edit from the interactive session.
            try {
              const activeTools = s.livePi?.getActiveTools() ?? [];
              toolsBeforeFilter = activeTools;
              s.livePi?.setActiveTools(
                activeTools.filter(
                  (name) =>
                    !/forge_unit_result/.test(name) && name !== "write" && name !== "edit" && name !== "subagent",
                ),
              );
            } catch {
              // Best-effort: the prompt contract still demands a text answer.
            }
            await freshCtx.sendMessage(
              { customType: "forge-review", content: prompt, display: false },
              { triggerTurn: true },
            );
            captured = lastAssistantMessage(freshCtx.sessionManager as unknown as BranchReader);
            if (wantedId && captured.model && captured.model !== wantedId) {
              castFailure = `turn autorado por '${captured.model}', esperado '${wantedId}'`;
            }
          },
        });
        if (castFailure) throw new ReviewModelCastError(castFailure);
        if (outcome.cancelled) throw new ReviewDispatchError("newSession cancelada (session_before_switch/abort)");
        if (captured.text === null) throw new ReviewDispatchError("turn concluiu sem texto de assistant capturável no transcript");
        return captured.text;
      } catch (err) {
        if (err instanceof ReviewModelCastError || err instanceof ReviewDispatchError) throw err;
        throw new ReviewDispatchError(`newSession lançou: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (applied && baseline) {
          try {
            await s.livePi?.setModel(baseline);
          } catch {
            // Restore is best-effort; the next unit dispatch re-applies its own.
          }
        }
        if (toolsBeforeFilter) {
          try {
            s.livePi?.setActiveTools(toolsBeforeFilter);
          } catch {
            // Best-effort; the next unit's session_start re-scopes anyway.
          }
        }
      }
    },
  };
}

export interface ReviewDialecticParams {
  cwd: string;
  milestoneId: string;
  slice: string;
  sliceTitle: string;
  unit: NextUnit;
  ctxForResolve: ResolveModelCtx;
  dispatcher: ReviewDispatcher;
  reviewedOn: string;
  rounds?: 0 | 1;
  authorFamily: string | null;
  artifactTarget?: { writePath: string };
  /**
   * Best-effort scope-level domain (`scopeDomainFor`, S05) — threaded to the
   * 3 prompt builders' `DOMAIN:` line only. Never touches `resolveModelForRole`
   * / the rank (D-S05-B): the reviewer/advocate resolution above uses only
   * `p.unit`/`p.ctxForResolve`/`p.authorFamily`, unchanged by this field.
   */
  domain?: string;
  /**
   * Loose-task scope (S03/T01): when set, `computeReviewDiffCmd` diffs the
   * task's own journaled `task_dispatched`→`task_result` range instead of the
   * milestone/slice range. Absent → current milestone/slice behavior
   * unchanged (byte-identical).
   */
  taskId?: string;
}

export interface ReviewDialecticResult {
  result: ResolveReviewResult;
  challengerFamily: string | null;
  warnings: string[];
}

function emptyResult(): ResolveReviewResult {
  return { noFlags: true, items: [], counts: { resolved: 0, conceded: 0, open: 0 }, warnings: [] };
}

function meta(p: ReviewDialecticParams, rounds: number): ReviewArtifactMeta {
  return { milestoneId: p.milestoneId, slice: p.slice, sliceTitle: p.sliceTitle, reviewedOn: p.reviewedOn, rounds };
}

function persist(p: ReviewDialecticParams, content: string): void {
  if (p.artifactTarget) writeFileAtomic(p.artifactTarget.writePath, content);
  else writeReview(p.cwd, p.milestoneId, p.slice, content);
}

function stub(p: ReviewDialecticParams, rounds: number, reason: string, warnings: string[] = []): ReviewDialecticResult {
  persist(p, renderReviewStub(meta(p, rounds), reason));
  return { result: emptyResult(), challengerFamily: null, warnings: [...warnings, reason] };
}

/**
 * Shared base/end walk (S03/T01 DRY Guard): first `dispatchedKind` sha is the
 * base, last `resultKind` sha is the end (HEAD when the scope's last event
 * carried no sha). Both the milestone/slice scope (`unit_dispatched`/
 * `unit_result`) and the task scope (`task_dispatched`/`task_result`) reduce
 * to this same walk over an already-filtered event slice.
 *
 * `onEmptyRange` (S03-REVIEW R1) governs what happens when the scope produced
 * no commits (`base === to`): `"null"` (default, milestone/slice — unchanged)
 * defers entirely to the caller's branch-heuristic fallback; `"base"` (task
 * scope only) instead returns `git diff <base>`, which stays anchored to the
 * task's own baseline and still captures the worker's uncommitted changes —
 * strictly better-scoped than the merge-base heuristic's three-dot diff
 * against an unrelated branch history.
 */
function shaRangeDiffCmd(
  cwd: string,
  events: ForgeEvent[],
  dispatchedKind: string,
  resultKind: string,
  onEmptyRange: "null" | "base" = "null",
): string | null {
  let base: string | null = null;
  let end: string | null = null;
  for (const e of events) {
    if (!e.sha) continue;
    if (e.kind === dispatchedKind && base === null) base = e.sha;
    if (e.kind === resultKind) end = e.sha;
  }
  if (!base) return null;
  const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const to = end ?? head;
  if (base === to) return onEmptyRange === "base" ? `git diff ${base}` : null;
  return `git diff ${base}..${to}`;
}

/**
 * Journal-derived commit range for a review scope ("G1 do git", fix batch
 * pós-M6). The loop stamps `sha` on `unit_dispatched`/`unit_result`; the FIRST
 * dispatched sha of the scope is HEAD *before* its work (the base), the LAST
 * result sha is HEAD after (the end). Returns null when the journal carries no
 * usable shas (legacy runs) — callers fall back to the branch heuristic.
 *
 * `taskId` (S03/T01) selects a DIFFERENT event family entirely: loose-task
 * dispatch (`commands/task-command.ts`) journals `task_dispatched`/
 * `task_result`, matched by `e.task` — NOT `e.milestone`, since a loose task
 * may carry `milestone: ""` (S02-PLAN Interpretation Decision 3). When
 * `taskId` is present it takes priority over the milestone/slice matcher.
 */
function journalRangeDiffCmd(
  cwd: string,
  scope: { milestoneId: string; slice?: string; taskId?: string },
): string | null {
  try {
    if (scope.taskId) {
      const events = readEvents(cwd).filter(
        (e) => e.task === scope.taskId && (e.kind === "task_dispatched" || e.kind === "task_result"),
      );
      return shaRangeDiffCmd(cwd, events, "task_dispatched", "task_result", "base");
    }
    const events = readEvents(cwd).filter(
      (e) =>
        e.milestone === scope.milestoneId &&
        (!scope.slice || e.slice === scope.slice || (e.unit ?? "").includes(scope.slice)),
    );
    return shaRangeDiffCmd(cwd, events, "unit_dispatched", "unit_result");
  } catch {
    return null;
  }
}

/**
 * Return the stable diff command used by review prompts. When `scope` is given
 * and the journal carries per-unit shas, the exact commit range wins — this is
 * what makes the review see same-branch flows (commits straight onto main),
 * where the merge-base heuristic below degenerates to an empty working-tree
 * diff (M6 ceremony finding #1). `scope.taskId` (S03/T01) scopes to a loose
 * task's own dispatch range instead of a milestone/slice.
 */
export function computeReviewDiffCmd(
  cwd: string,
  scope?: { milestoneId: string; slice?: string; taskId?: string },
): string {
  if (scope) {
    const ranged = journalRangeDiffCmd(cwd, scope);
    if (ranged) return ranged;
  }
  for (const branch of ["main", "master"]) {
    try {
      const base = execFileSync("git", ["-C", cwd, "merge-base", "HEAD", branch], { encoding: "utf8" }).trim();
      if (base && base !== execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()) {
        return `git diff ${base}...HEAD`;
      }
    } catch {
      // Try the next conventional branch, then the local fallback.
    }
  }
  return "git diff HEAD";
}

function diffHasFiles(cwd: string, command: string): boolean {
  try {
    const args = command.split(/\s+/).slice(2);
    const names = execFileSync("git", ["-C", cwd, "diff", "--name-only", ...args], { encoding: "utf8" }).trim();
    return names.length > 0;
  } catch {
    // A repository without the selected merge-base still has a reviewable
    // working-tree diff; use the documented local fallback before giving up.
    try {
      return execFileSync("git", ["-C", cwd, "diff", "--name-only", "HEAD"], { encoding: "utf8" }).trim().length > 0;
    } catch {
      return false;
    }
  }
}

function dispatchOptions(model: string | null, provider: string | null, cwd: string): ReviewDispatchOptions {
  return { workingDir: cwd, model, provider };
}

/**
 * Monotonic epoch for `reviewActivity` publications (S04/T02, D16/M1R-1).
 * Reviews never arm a rendezvous, so the container's `currentRendezvousToken`
 * cannot gate this field — each turn stamps its OWN token here instead, and
 * `clearReviewActivity` only wipes the field when it still carries that exact
 * token, so a delayed clear from an abandoned turn can never erase a newer
 * turn's publish.
 */
let reviewActivityEpoch = 0;

/**
 * Best-effort fan-out to every registered `reviewActivityListeners` callback
 * (REVIEW-FIX S04/R1) — invoked right after `reviewActivity` is mutated so a
 * widget renders the change immediately instead of waiting for an unrelated
 * session/tool/message event. One listener throwing must never stop the rest
 * from running or affect the dialectic — each call is individually guarded.
 */
function notifyReviewActivityListeners(): void {
  let listeners: Set<() => void>;
  try {
    listeners = getForgeAutoSession().reviewActivityListeners;
  } catch {
    return;
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Best-effort, display-only — one widget's render failure must never affect another's or the dialectic.
    }
  }
}

/**
 * Best-effort publish of an in-flight review turn's identity onto the
 * container for the strip/panel to render (S04/T02). `role` is the TURN
 * (`challenger`/`advocate`/`rebuttal`), never the dispatch `Role`. Display-only
 * and never allowed to affect the dialectic — a publish failure is swallowed,
 * same posture as journaling. Returns the token it stamped, for the paired
 * `clearReviewActivity` call.
 */
function publishReviewActivity(
  role: "challenger" | "advocate" | "rebuttal",
  resolved: { model: string | null; family: string | null },
  scope: string,
): number {
  const token = ++reviewActivityEpoch;
  try {
    getForgeAutoSession().reviewActivity = { role, model: resolved.model, family: resolved.family, scope, token };
  } catch {
    // Best-effort, display-only (S04/T02) — a publish failure must never affect the dialectic.
  }
  notifyReviewActivityListeners();
  return token;
}

/**
 * Clears `reviewActivity` ONLY if it still carries `token` — the token
 * correlation that makes the clear safe against a newer turn's publish
 * (D16/M1R-1). Best-effort, same posture as `publishReviewActivity`.
 */
function clearReviewActivity(token: number): void {
  try {
    const s = getForgeAutoSession();
    if (s.reviewActivity?.token === token) s.reviewActivity = null;
  } catch {
    // Best-effort, display-only (S04/T02).
  }
  notifyReviewActivityListeners();
}

/** Run the complete challenge/defense/rebuttal dialectic; failures are lateral and never throw. */
export async function runReviewDialectic(p: ReviewDialecticParams): Promise<ReviewDialecticResult> {
  const rounds = p.rounds ?? readReviewPrefs(p.cwd).rounds;
  const diffCmd = computeReviewDiffCmd(p.cwd, {
    milestoneId: p.milestoneId,
    slice: p.slice !== p.milestoneId ? p.slice : undefined,
    taskId: p.taskId,
  });
  if (!diffHasFiles(p.cwd, diffCmd)) return stub(p, rounds, "sem diff para revisar");

  const reviewer = resolveModelForRole("reviewer", p.unit, { ...p.ctxForResolve, authorFamily: p.authorFamily });
  if (!reviewer.model) return stub(p, rounds, "reviewer não elencável");
  const warnings: string[] = [];
  const reviewScope = p.taskId ?? p.slice;
  let challengeText: string | null;
  const challengerToken = publishReviewActivity("challenger", reviewer, reviewScope);
  try {
    try {
      challengeText = await p.dispatcher.dispatch(
        challengerPrompt({ workingDir: p.cwd, unit: `${p.slice}/${p.unit.type}`, diffCmd, domain: p.domain }),
        dispatchOptions(reviewer.model, reviewer.provider, p.cwd),
      );
    } catch (err) {
      // Fail-closed cast: a challenger that cannot run on the resolved family
      // must be a DECLARED stub, never a silent same-family review.
      if (err instanceof ReviewModelCastError) {
        return stub(p, rounds, `challenger não aplicável: ${err.message}`, warnings);
      }
      // Diagnostic-preserving failure: the stub carries the REAL reason (S04
      // finding — a bare "challenger falhou" is undebuggable).
      if (err instanceof ReviewDispatchError) {
        return stub(p, rounds, `challenger falhou: ${err.message}`, warnings);
      }
      challengeText = null;
    }
  } finally {
    clearReviewActivity(challengerToken);
  }
  if (challengeText === null) return stub(p, rounds, "challenger falhou", warnings);

  const parsedChallenge = parseObjections(challengeText);
  warnings.push(...parsedChallenge.warnings);
  if (parsedChallenge.noFlags || parsedChallenge.objections.length === 0) {
    const result = emptyResult();
    persist(p, renderReview(meta(p, rounds), result));
    return { result, challengerFamily: reviewer.family, warnings };
  }

  const objections: ReviewObjection[] = parsedChallenge.objections;
  const advocate = resolveModelForRole("advocate", p.unit, { ...p.ctxForResolve, authorFamily: p.authorFamily });
  let defenseText: string | null;
  let advocateFailReason = "advocate falhou";
  const advocateToken = publishReviewActivity("advocate", advocate, reviewScope);
  try {
    try {
      defenseText = await p.dispatcher.dispatch(
        advocatePrompt({ workingDir: p.cwd, unit: `${p.slice}/${p.unit.type}`, diffCmd, objectionsText: renderObjectionsText(objections), domain: p.domain }),
        dispatchOptions(advocate.model, advocate.provider, p.cwd),
      );
    } catch (err) {
      if (err instanceof ReviewModelCastError) advocateFailReason = `advocate não aplicável: ${err.message}`;
      else if (err instanceof ReviewDispatchError) advocateFailReason = `advocate falhou: ${err.message}`;
      defenseText = null;
    }
  } finally {
    clearReviewActivity(advocateToken);
  }
  const defense = defenseText === null ? [] : parseVerdicts(defenseText, ["refuted", "conceded", "open"] as const).verdicts;
  if (defenseText === null) warnings.push(advocateFailReason);
  else warnings.push(...parseVerdicts(defenseText, ["refuted", "conceded", "open"] as const).warnings);

  const rebuttalRounds: ReviewVerdict<"maintained" | "withdrawn" | "conceded">[][] = [];
  if (rounds >= 1) {
    let rebuttalText: string | null;
    let rebuttalFailReason = "rebuttal falhou";
    const rebuttalToken = publishReviewActivity("rebuttal", reviewer, reviewScope);
    try {
      try {
        rebuttalText = await p.dispatcher.dispatch(
          rebuttalPrompt({ workingDir: p.cwd, unit: `${p.slice}/${p.unit.type}`, diffCmd, objectionsText: renderObjectionsText(objections), defenseText: renderDefenseText(defense), domain: p.domain }),
          dispatchOptions(reviewer.model, reviewer.provider, p.cwd),
        );
      } catch (err) {
        if (err instanceof ReviewModelCastError) rebuttalFailReason = `rebuttal não aplicável: ${err.message}`;
        else if (err instanceof ReviewDispatchError) rebuttalFailReason = `rebuttal falhou: ${err.message}`;
        rebuttalText = null;
      }
    } finally {
      clearReviewActivity(rebuttalToken);
    }
    if (rebuttalText === null) warnings.push(rebuttalFailReason);
    else {
      const parsed = parseVerdicts(rebuttalText, ["maintained", "withdrawn", "conceded"] as const);
      rebuttalRounds.push(parsed.verdicts);
      warnings.push(...parsed.warnings);
    }
  }

  const result = resolveReview(objections, defense, rebuttalRounds, rounds);
  warnings.push(...result.warnings);
  persist(p, renderReview(meta(p, rounds), result));
  return { result, challengerFamily: reviewer.family, warnings };
}
