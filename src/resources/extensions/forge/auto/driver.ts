/**
 * `auto/driver.ts` — the production `SessionDriver`: the ONE and ONLY call-site
 * of `ctx.newSession()` in the whole S03 slice (B2).
 *
 * It is deliberately THIN: it owns no decision logic (that lives in the pure
 * `auto/housekeeping.ts` brain and the `auto/loop.ts` iteration). Its single job
 * is to translate "run this unit's prompt in a fresh worker session" into the
 * `newSession` + `withSession` + `sendMessage(triggerTurn)` dance and hand the
 * loop back a resolved `UnitOutcome`. Its correctness is proven end-to-end by
 * the T06 e2e; the loop's logic is unit-tested with a FAKE driver.
 *
 * ── B1 rendezvous ordering ──────────────────────────────────────────────────
 * The result-delivery rendezvous is ARMED BEFORE `newSession` is called. The
 * `forge_unit_result` tool runs in the fresh instance post-rebind and delivers
 * into the module-level rendezvous singleton, which resolves the promise the
 * loop (in the original closure) is awaiting. Arming first guarantees the tool
 * always has a pending rendezvous to deliver into.
 *
 * ── B3 stale-handle rule ────────────────────────────────────────────────────
 * Inside `withSession`, `s.cmdCtx` is re-pointed to the FRESH `ReplacedSession
 * Context`. From that moment the fresh ctx is the only session handle used for
 * session-bound work; the pre-switch handle is stale and never touched again.
 *
 * ── B4 no-hang ──────────────────────────────────────────────────────────────
 * `newSession()` runs the whole worker turn before it resolves, so the
 * rendezvous timeout alone is not a real ceiling — a worker that never emits a
 * result would hang the un-timed await. The dispatch is therefore RACED against
 * a wall-clock timer (`resolveUnitTimeoutMs`): on timeout we `abort()` the live
 * turn, drop the abandoned rendezvous, and resolve a synthetic `{ kind:
 * "timeout" }` without awaiting the hung `newSession()`. A cancelled
 * `newSession` short-circuits to a synthetic `blocked` outcome the same way.
 */

// S04/T03 (D-S04-2): the dispatch spine accepts any `ComposableUnit` — a
// type-only widening (layer precedent: `auto/loop.ts` imports from
// `prompts/compose.js`); every existing narrowing below stays intact.
import type { ComposableUnit } from "../prompts/compose.js";
import { appendEvent, unitSlice } from "../state/index.js";
import { armRendezvous, cancelRendezvous, type UnitOutcome } from "../worker/rendezvous.js";
import { clearWorkerMcp, publishWorkerMcp } from "../worker/mcp-bridge.js";
import { type ForgeAutoSession, resolveUnitTimeoutMs } from "./session.js";
import type { ForgeLoopEvent } from "./housekeeping.js";
import { resolveModelForRole, roleForUnit, type ResolveModelCtx } from "./role.js";
import { injectableRequestKey, providerAvailabilityProbe } from "@forge/agent-core/credential-rotation.js";
import { domainHintForUnit, effortHintForUnit, tierHintForUnit } from "./rank-hint.js";
import { resolveUnitEffort } from "./effort.js";
import { effortCeilingFor, observedEffortCeilings } from "./effort-ceiling.js";
import { readForgePrefs, type ForgePrefs } from "../prefs.js";

/**
 * R2 (review-fix): upper bound on how long the NEXT dispatch waits for a prior
 * abandoned dispatch (early-settle/ceiling) to unwind before proceeding. Keeps
 * two `newSession` calls on the same host from overlapping un-serialized, while
 * never re-introducing a hang (B4): a prior turn is already `abort()`-ed on the
 * abandoning path, so it should unwind well within this grace; if it is
 * genuinely stuck we give up and proceed rather than block forever.
 */
const SERIALIZE_GRACE_MS = 5_000;

/**
 * Resolve and publish the model authority for one dispatch before its journal
 * event is written. The caller supplies the dispatch timestamp so availability
 * probing is deterministic; credential selection remains in the driver.
 */
export function resolveDispatchAuthor(
  s: ForgeAutoSession,
  unit: ComposableUnit,
  nowMs: number,
): ReturnType<typeof resolveModelForRole> {
  const savedCmdCtx = s.cmdCtx;
  const savedBaselineModel = s.baselineModel;
  s.pendingUnitModel = null;
  s.pendingUnitModelToken = null;
  s.cmdCtx = null;
  s.baselineModel = undefined;

  const role = roleForUnit(unit);
  const tierHint = tierHintForUnit(s.cwd, unit);
  const domainHint = domainHintForUnit(s.cwd, unit);
  const budgetPressure = process.env.FORGE_BUDGET_PRESSURE ? true : false;

  // S01 effort axis, REORDERED ahead of the seam call (S09/T03): resolving
  // the unit's effort here — rather than after, as pre-T03 — lets its LEVEL
  // feed `rankUnion`'s ε-group clamp-penalty tie-break as `requestedEffort`
  // below without changing the value the loop later journals under `effort`
  // (`resolveUnitEffort` is a pure function of `{taskHint, role, prefs}`, so
  // computing it earlier yields the identical `ResolvedEffort` — the
  // byte-identity precondition D-S01-3 holds). Best-effort with the same
  // caller-side discipline as `tierHint`: resolution NEVER throws — a prefs
  // or frontmatter read failure degrades to "no effort", keeping the
  // no-config dispatch path byte-identical.
  let resolvedEffort: ReturnType<typeof resolveUnitEffort> = undefined;
  try {
    const effortHint = effortHintForUnit(s.cwd, unit);
    let prefs: ForgePrefs;
    try {
      prefs = readForgePrefs(s.cwd).prefs;
    } catch {
      prefs = {};
    }
    resolvedEffort = resolveUnitEffort({ ...(effortHint ? { taskHint: effortHint } : {}), role, prefs });
  } catch {
    resolvedEffort = undefined;
  }
  s.resolvedDispatchEffort = resolvedEffort ?? null;

  // S09/T03 (S09-PLAN decision 4): pre-resolve the observed effort ceiling
  // per ref ONCE, ONLY when a domain hint exists — mirrors the CAPABILITIES
  // read's own guard (`role.ts`'s `capabilityOf`, S03 discipline): an absent
  // domain never even reads the journal. `observedEffortCeilings` is itself
  // total try/catch (never throws, degrades to an empty map); `rankUnion`
  // never reads the fs — it only calls the pure, pre-bound lookup below.
  const ceilings = domainHint !== undefined ? observedEffortCeilings(s.cwd) : undefined;
  const effortCeilingOf = ceilings ? (ref: string) => effortCeilingFor(ceilings, ref) : undefined;

  const resolveCtx: ResolveModelCtx = {
    session: s,
    tierHint,
    domain: domainHint,
    budgetPressure,
    ...(resolvedEffort ? { requestedEffort: resolvedEffort.level } : {}),
    ...(effortCeilingOf ? { effortCeilingOf } : {}),
    ...(s.credentialRotator
      ? {
          availabilityProbe: providerAvailabilityProbe(
            s.credentialRotator,
            nowMs,
            s.providerReadiness ?? undefined,
          ),
        }
      : {}),
  };
  const resolved = resolveModelForRole(role, unit, resolveCtx);

  s.cmdCtx = savedCmdCtx;
  s.baselineModel = savedBaselineModel;
  s.pendingUnitModel = resolved.model;
  s.resolvedDispatchAuthor = {
    provider: resolved.provider,
    model: resolved.model,
    family: resolved.family,
    ...(resolved.violation ? { violation: resolved.violation } : {}),
    // S09/T03 (addendum §6): additive, present ONLY when the cross-pool
    // judgment decided (`resolved.rank_reason` is only ever set from that
    // branch — `role.ts`'s invariant guarantees `domainHint` is defined
    // whenever it is). Consumed synchronously within THIS dispatch by
    // `loop.ts`'s `dispatchedEvent` — the documented token-free exception
    // (`.gsd/CODING-STANDARDS.md:112` §"Campo por-dispatch exige
    // token/epoch"), same as this field's untokened siblings above.
    ...(resolved.rank_reason
      ? { rankReason: resolved.rank_reason, domain: domainHint as string }
      : {}),
  };

  return resolved;
}

/**
 * M1R-1: journal a stale rendezvous-cancel (a cancel whose token no longer
 * matches the currently pending arm — i.e. it targets an abandoned/replaced
 * attempt). Best-effort only — never throws, never blocks the dispatch path.
 */
function journalStaleCancel(s: ForgeAutoSession, unit: ComposableUnit, token: number): void {
	const ev: ForgeLoopEvent = {
		ts: new Date().toISOString(),
		kind: "stale_rendezvous_cancel",
		unit: unit.type === "execute-task" ? `${unit.slice}/${unit.task}` : `plan/${unitSlice(unit)}`,
		agent: "forge-loop",
		milestone: "",
		status: "stale",
		summary: `Cancel tardio (token ${token}) ignorado — rendezvous já pertence a outra tentativa.`,
		slice: unitSlice(unit),
	};
	if (unit.type === "execute-task") ev.task = unit.task;
	try {
		appendEvent(s.cwd, ev);
	} catch {
		/* best-effort journaling — never blocks the dispatch path */
	}
}

/** Cancel `token`'s rendezvous and journal if it turned out to be stale (M1R-1). */
function cancelAndJournal(s: ForgeAutoSession, unit: ComposableUnit, token: number): void {
	if (cancelRendezvous(token) === "stale") {
		journalStaleCancel(s, unit, token);
	}
}

/**
 * S02/T02: journal a `resolveModelForRole` BLOCKED-by-violation resolve
 * (`resolved.violation === "reviewer_not_author"`, T01's marker) distinctly
 * from the generic `on_missing_pool: "block"` BLOCKED (no marker, never
 * journals this kind) and from a normal degrade (role.ts's own console.warn,
 * not a journal event). This IS the single dedicated-event signaling point
 * for the violation (loop.ts's own call-site notifies the operator via
 * `notify` instead of a second journal write — see
 * `notifyReviewerNotAuthorViolation` in `loop.ts`; one journal write + one
 * notify, never a duplicate of either). Best-effort only — never throws,
 * never blocks the dispatch path (`follows: best-effort-journal`,
 * `journalStaleCancel` above).
 *
 * INERT today: no production unit-type resolves as reviewer/advocate
 * (`roleForUnit` has no entry for either — S04 decisão B), so
 * `resolved.violation` is never set on the real dispatch path; this exists
 * so the signal is never silently swallowed once M3 wires those roles in.
 */
export function journalReviewerNotAuthorViolation(s: ForgeAutoSession, unit: ComposableUnit, role: string): void {
	const ev: ForgeLoopEvent = {
		ts: new Date().toISOString(),
		kind: "reviewer_not_author_violation",
		unit: unit.type === "execute-task" ? `${unit.slice}/${unit.task}` : `plan/${unitSlice(unit)}`,
		agent: "forge-loop",
		milestone: "",
		status: "blocked",
		summary: `BLOCKED reviewer_not_author — resolve para role "${role}" colidiu com a família autora; pendingUnitModel permanece null (nenhum modelo de autoria aplicado, NÃO é um degrade genérico).`,
		slice: unitSlice(unit),
	};
	if (unit.type === "execute-task") ev.task = unit.task;
	try {
		appendEvent(s.cwd, ev);
	} catch {
		/* best-effort journaling — never blocks the dispatch path */
	}
}

/**
 * Dispatch one unit in a FRESH worker session and resolve with its outcome.
 *
 * ÚNICO call-site de `newSession` do slice (B2); nunca usa um handle de sessão
 * capturado pré-switch (B3); nunca pendura (B4 — a rendezvous embute o timeout).
 */
export async function dispatchUnitViaNewSession(
  s: ForgeAutoSession,
  unit: ComposableUnit,
  prompt: string,
): Promise<UnitOutcome> {
  if (!s.cmdCtx) {
    throw new Error("dispatchUnitViaNewSession: no live cmdCtx on the container");
  }

  // ── R2 serialize against an abandoned prior dispatch ─────────────────────
  // A prior dispatch that early-settled (delivery) or hit the wall-clock ceiling
  // RETURNED while its `newSession` turn was still draining (best-effort
  // aborted). `settleCurrentTurnForSessionTransition` in forge-agent-core is NOT
  // a mutex against a SECOND `newSession()` whose FIRST has not unwound. So wait
  // for that residual turn to settle BEFORE arming this dispatch's rendezvous and
  // calling `newSession` again on the same host — bounded by `SERIALIZE_GRACE_MS`
  // so a genuinely hung (already-aborted, B4) prior turn can never re-introduce a
  // hang. Doing this BEFORE `armRendezvous` also means a late delivery/cancel from
  // the prior turn can never land on THIS dispatch's fresh arm.
  const prior = s.pendingDispatch;
  if (prior) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SERIALIZE_GRACE_MS);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      void prior.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  }

  // Publish the pending unit's scope/model so the FRESH instance's
  // `session_start` hook (which runs before `withSession`) can scope tools and
  // apply the per-unit model against its own live `pi` (B3-safe).
  s.pendingUnitType = unit.type;
  // G1/T01: `s.appliedUnitModel` (the model the hook DE FATO applied, vs. this
  // block's `pendingUnitModel` — merely resolved) is published from the HOOK
  // side (`register-extension.ts`), not here — the hook is the only writer
  // that observes `setModel`'s outcome (success / not-found / throw). The
  // driver's part is just making sure it STARTS clear before arming this
  // dispatch; idempotent with the loop's own per-iteration reset (`loop.ts`).
  // G2 seam (S02/T02): resolve via `resolveModelForRole` instead of calling
  // `resolveUnitModel` directly, so the model applied at `session_start`
  // originates from the seam. `pendingUnitModel` must stay "per-unit pref or
  // null" — never the live session's fallback model (that would make the hook
  // re-apply the session's own model as if it were a per-unit override, per
  // the T02-PLAN "Nota de contrato" pitfall). `effectiveModelFor`'s fallback
  // chain reads `s.cmdCtx`/`s.baselineModel`/`s.pendingUnitModel` off the SAME
  // live session object the seam is given, so those three fields are saved,
  // cleared, and restored around this single synchronous call — leaving only
  // the pure `resolveUnitModel(cwd, unitType)` branch reachable, which is
  // exactly what this call site published before the rewire.
  const timeoutMs = resolveUnitTimeoutMs(s.cwd);

  // Arm after R2 serialization but before credential selection so the
  // selection carries the exact rendezvous epoch for this dispatch.
  const { token, outcome } = armRendezvous(timeoutMs);
  s.currentRendezvousToken = token;

  let runtimeOverrideProvider: string | null = null;
  {
    // The loop publishes this before journaling. Keep a compatibility fallback
    // for direct driver callers; the production loop never takes this branch.
    const published = s.currentUnit === unit ? s.resolvedDispatchAuthor : null;
    const resolved = published ?? resolveDispatchAuthor(s, unit, Date.now());
    const nowMs = Date.now();
    const role = roleForUnit(unit);
    // This clear deliberately happens AFTER reading the published author: the
    // resolution is the loop's pre-dispatch value, while these fields belong to
    // the driver's credential/application window.
    s.selectedCredential = null;
    s.appliedUnitModel = null;
    s.appliedUnitModelToken = null;
    s.pendingUnitModel = resolved.model;
    s.pendingUnitModelToken = token;
    // S01 effort axis (mirror of the published-author read above): the effort
    // was published by the same `resolveDispatchAuthor` call that produced
    // `resolved` — the loop's pre-journal one, or this block's fallback
    // re-resolution — so the container field is THIS unit's resolution in both
    // branches. Stamp it with THIS dispatch's rendezvous token (MEM001/D16:
    // a stale `session_start` hook must never consume it); with no effort
    // resolved, pending stays null and NO token is stamped, so the hook's
    // effort block never runs (byte-identity, D-S01-3).
    s.appliedUnitEffort = null;
    s.appliedUnitEffortToken = null;
    const resolvedEffort = s.resolvedDispatchEffort;
    s.pendingUnitEffort = resolvedEffort;
    s.pendingUnitEffortToken = resolvedEffort ? token : null;

    if (s.credentialRotator && resolved.provider) {
      const sel = s.credentialRotator.selectCredential(resolved.provider, nowMs);
      if (sel != null) {
        s.selectedCredential = {
          provider: resolved.provider,
          index: sel.index,
          identity: sel.identity,
          token,
        };
        const requestKey = injectableRequestKey(sel.credential);
        if (requestKey !== null && s.authStorageForOverride) {
          s.authStorageForOverride.setRuntimeApiKey(resolved.provider, requestKey);
          runtimeOverrideProvider = resolved.provider;
        }
      }
    }
    if (resolved.violation === "reviewer_not_author") {
      journalReviewerNotAuthorViolation(s, unit, role);
    }
  }

  // The rendezvous was armed above, immediately after R2 serialization and
  // before selection, so selectedCredential is correlated with this token.

  // externalCli (claude-code / SDK) delivery path: publish the record for THIS
  // dispatch with the token JUST minted, immediately after `armRendezvous`. The
  // provider reads this slot at query-BUILD time (inside the dispatch window)
  // and constructs the in-process SDK MCP server with the token FROZEN into its
  // handler closure (B1/MEM001 — see `worker/mcp-bridge.ts`). The publish window
  // is EXACTLY the dispatch window: we clear the slot in the `finally` below so
  // every exit path (result, timeout, cancelled, worker_turn_error) leaves it
  // inert. A zombie query surviving past the clear still holds the server built
  // WITHIN the window, with its token frozen — a late delivery is therefore
  // stale by construction and can never corrupt the retry's rendezvous. The slot
  // is never read at delivery time.
  publishWorkerMcp(token);
  const cmdCtx = s.cmdCtx;

  // ── B4 real wall-clock ceiling (R1-a) ────────────────────────────────────
  // `newSession()` runs the ENTIRE worker turn before it resolves — a worker
  // that loops in bash/edit and never emits `forge_unit_result` would hang the
  // await forever (bash has no default timeout; the loop has no maxSteps). The
  // rendezvous timeout alone is NOT a real ceiling: its timer fires, but we are
  // still stuck on the un-timed `await newSession(...)`. So we race the whole
  // dispatch against a wall-clock timer: on timeout we `abort()` the live turn,
  // drop the abandoned rendezvous, and resolve a synthetic timeout WITHOUT
  // awaiting the hung `newSession()`.
  // R4 (review-fix): once the race is decided by an early-settle (real delivery)
  // or the wall-clock ceiling, the abandoned IIFE below may STILL reject/resolve
  // late (its `newSession` unwinding post-abort). Left ungated, its catch/
  // `res.cancelled` branch would call `cancelAndJournal` with THIS attempt's
  // (now-consumed or ceiling-dropped) token against a rendezvous that may already
  // belong to the NEXT unit → a spurious `stale_rendezvous_cancel` for a unit
  // that actually completed (contradicting FORGE2-S01-ACCEPTANCE #6), or a double
  // cancel. This flag makes the late continuation a no-op on those branches.
  let settled = false;

  const dispatch = (async (): Promise<UnitOutcome> => {
    let res: Awaited<ReturnType<typeof cmdCtx.newSession>>;
    try {
      res = await cmdCtx.newSession({
        workspaceRoot: s.cwd,
        parentSession: s.runRootSessionPath ?? undefined,
        withSession: async (freshCtx) => {
          // B3: re-point the container at the live fresh context. From here on
          // the fresh ctx is the only session handle used for session-bound work.
          s.cmdCtx = freshCtx;
          await freshCtx.sendMessage(
            { customType: "forge-dispatch", content: prompt, display: false },
            { triggerTurn: true },
          );
        },
      });
    } catch {
      // R1 (S04 review): a worker-turn error (e.g. transient API/network
      // failure inside `sendMessage`) escapes `withSession` and rejects
      // `newSession`. Left uncaught, this would blow past the IIFE, race,
      // and both bare try/finally chains up the stack (loop.ts, driver
      // caller) as an unhandled rejection that aborts `/forge auto` with no
      // blocked journal. Drop the now-abandoned rendezvous (mirrors the
      // `cancelled` branch below) and synthesize a blocked outcome so the
      // SAME outcome promise `Promise.race` resolves is routed to a clean
      // pause instead. R4: skip the cancel entirely if the race was already
      // decided (early-settle/ceiling) — this reject is the abandoned turn
      // unwinding, and its rendezvous is already consumed/dropped.
      if (!settled) cancelAndJournal(s, unit, token);
      return {
        kind: "result",
        result: {
          status: "blocked",
          summary: "Sessão do worker falhou antes do dispatch.",
          artifacts: [],
          reason: "worker_turn_error",
        },
      };
    }

    if (res.cancelled) {
      // The worker session never started — do not wait on the armed rendezvous
      // (it would only resolve at timeout). Drop it now (R3) and synthesize a
      // blocked outcome so the loop pauses cleanly (B4). R4: skip if the race
      // was already decided — a late `cancelled` from the abandoned turn must
      // not journal a spurious stale cancel against the next unit's rendezvous.
      if (!settled) cancelAndJournal(s, unit, token);
      return {
        kind: "result",
        result: {
          status: "blocked",
          summary: "Sessão do worker cancelada antes do dispatch.",
          artifacts: [],
          reason: "session_cancelled",
        },
      };
    }

    // The rendezvous already embeds the timeout — resolves either with the
    // delivered result or with `{ kind: "timeout" }`.
    return outcome;
  })();

  // R2: publish this dispatch as the in-flight one so the NEXT dispatch can
  // serialize against it (see the top-of-function grace wait). Clear it once it
  // settles, but only if it is still THIS dispatch (a later dispatch may have
  // overwritten the slot already).
  s.pendingDispatch = dispatch;
  void dispatch.finally(() => {
    if (s.pendingDispatch === dispatch) s.pendingDispatch = null;
  });

  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const ceilingHit = new Promise<UnitOutcome>((resolve) => {
    ceiling = setTimeout(() => {
      // Wall-clock ceiling reached before the worker turn returned. Interrupt
      // any live streaming turn/tool, drop the abandoned rendezvous (no double
      // resolve — cancelRendezvous never resolves), and settle as a timeout.
      settled = true;
      try {
        s.cmdCtx?.abort();
      } catch {
        /* best-effort — the ceiling still resolves regardless */
      }
      cancelAndJournal(s, unit, token);
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });

  // ── E2E-2/W1 early-settle on delivery (Fix 3) ────────────────────────────
  // `dispatch` above only returns `outcome` AFTER `await newSession(...)`
  // unwinds. But an externalCli (SDK) worker commits its result through the MCP
  // rendezvous while its residual turn is still draining — leaving `dispatch`
  // blocked on the un-returned `newSession` and the whole unit stuck for
  // O(turn) past a delivery that already happened (the measured 14-16min-vs-10
  // symptom). So we ALSO race the rendezvous `outcome` directly: a real
  // delivery settles the dispatch immediately and aborts the residual turn
  // best-effort. A `timeout` outcome is deliberately swallowed here — the
  // ceiling stays the single canonical timeout path (same `timeoutMs`; avoids a
  // double abort/cancel). In-process (`terminate:true`) already ends the turn,
  // so this is a harmless no-op there.
  const earlySettle: Promise<UnitOutcome> = outcome.then((o) => {
    if (o.kind === "result") {
      settled = true;
      try {
        s.cmdCtx?.abort();
      } catch {
        /* best-effort — the delivered result settles the dispatch regardless */
      }
      return o;
    }
    // Timeout: let the ceiling own it. Never settle the race from here.
    return new Promise<UnitOutcome>(() => {});
  });

  try {
    return await Promise.race([dispatch, ceilingHit, earlySettle]);
  } finally {
    if (ceiling) clearTimeout(ceiling);
    // S01/T01: never let a selected credential override leak into the next
    // unit, including timeout/cancellation paths.
    if (runtimeOverrideProvider !== null && s.authStorageForOverride) {
      try {
        s.authStorageForOverride.removeRuntimeApiKey(runtimeOverrideProvider);
      } catch {
        /* best-effort cleanup — never block dispatch teardown */
      }
    }
    // Close the publish window with the dispatch window (B1). All exit paths —
    // delivered result, timeout, cancelled session, worker_turn_error — funnel
    // through here, so the record is always cleared exactly once per dispatch.
    clearWorkerMcp();
  }
}
