/**
 * Rendezvous — bridges the `forge_unit_result` tool handler (which runs in
 * a FRESH extension instance, post `newSession` rebind) back to the loop
 * that is still awaiting inside the ORIGINAL command-handler closure.
 *
 * Why module-level: `ctx.newSession()` is a session-REPLACEMENT, not a
 * spawn. It tears down the current runtime and rebinds extensions, so the
 * tool's `execute()` runs in a brand-new extension instance with a brand-new
 * `pi`/`ctx`. The Node module itself, however, stays cached across that
 * rebind — a module-level singleton is therefore the only object both the
 * pre-switch loop closure and the post-switch tool handler can reach in
 * common. This mirrors the gsd 1.0 `AutoSession` pattern (S03-PLAN § B1).
 *
 * Contract (B4 — no-hang guarantee):
 *  - `awaitUnitResult(timeoutMs)` NEVER rejects. It always resolves, either
 *    with the delivered result or with `{ kind: "timeout" }` once the timer
 *    fires. The loop must never be left hanging on an unresolved promise.
 *  - `deliverUnitResult(result, token?)` is tolerant of the "no pending
 *    rendezvous" case (worker called the tool outside of an active unit, or
 *    delivered twice) — it returns `"none"` instead of throwing.
 *
 * M1R-1 (review-fix): the single `pending` slot has no identity, so an
 * abandoned dispatch (ceiling timeout) whose IIFE catch/cancel fires LATE
 * can destroy or wrongly settle the RETRY's rendezvous. Every arm now gets a
 * monotonic `token`; `deliverUnitResult`/`cancelRendezvous` only act when the
 * caller's token matches the CURRENTLY pending one — a stale token is a
 * no-op (`"stale"`), never touching the live rendezvous.
 */

export type UnitResultPayload = {
	status: "done" | "partial" | "blocked";
	summary: string;
	artifacts: string[];
	reason?: string;
};

export type UnitOutcome =
	| { kind: "result"; result: UnitResultPayload }
	| { kind: "timeout" };

interface PendingRendezvous {
	resolve: (outcome: UnitOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
	/** Monotonic epoch token identifying THIS arm (M1R-1). */
	token: number;
}

/** Module-level singleton — survives session replacement (see header). */
let pending: PendingRendezvous | null = null;

/** Monotonic token counter — every `armRendezvous` call mints a fresh one. */
let tokenSeq = 0;

/**
 * Arm the rendezvous for the unit about to be dispatched, returning the
 * epoch `token` identifying this arm alongside the outcome promise. Callers
 * that later need to cancel/deliver against THIS specific arm (and not a
 * subsequent retry's) must hold onto and pass back this token.
 *
 * Resolves with `{ kind: "timeout" }` after `timeoutMs` if no delivery
 * happens in time — never rejects, never hangs (B4).
 */
export function armRendezvous(timeoutMs: number): { token: number; outcome: Promise<UnitOutcome> } {
	// A previous rendezvous that was never delivered (e.g. prior timeout
	// whose timer already fired but did not clear `pending` due to a race)
	// must not leak into this one — clear defensively.
	if (pending) {
		clearTimeout(pending.timer);
		pending = null;
	}

	const token = ++tokenSeq;
	const outcome = new Promise<UnitOutcome>((resolve) => {
		const timer = setTimeout(() => {
			pending = null;
			resolve({ kind: "timeout" });
		}, timeoutMs);

		pending = { resolve, timer, token };
	});

	return { token, outcome };
}

/**
 * Back-compat thin wrapper over `armRendezvous` — arms and returns only the
 * outcome promise, discarding the token. Preserves the pre-M1R-1 signature
 * for callers that do not need epoch correlation (e.g. existing tests).
 */
export function awaitUnitResult(timeoutMs: number): Promise<UnitOutcome> {
	return armRendezvous(timeoutMs).outcome;
}

/**
 * Called from inside the `forge_unit_result` tool's `execute()` — running in
 * the NEW extension instance post-rebind. Delivers into whatever rendezvous
 * is currently pending, reaching the loop's original closure via the
 * module-level singleton.
 *
 * `token` correlates the delivery to a specific arm (M1R-1): if provided and
 * it does not match the currently pending arm's token, the delivery is a
 * NO-OP (`"stale"`) — it neither resolves nor clears the live rendezvous
 * (which belongs to a different, later arm). `token` left `undefined`
 * delivers into whatever is currently pending, unconditionally (back-compat).
 *
 * Returns `"delivered"` on a successful settle, `"none"` if nothing was
 * pending, or `"stale"` on a token mismatch (tolerated — never throws, so a
 * stray/duplicate/late tool call cannot crash the worker session or corrupt
 * a subsequent rendezvous).
 */
export function deliverUnitResult(
	result: UnitResultPayload,
	token?: number,
): "delivered" | "none" | "stale" {
	if (!pending) {
		return "none";
	}
	if (token !== undefined && token !== pending.token) {
		return "stale";
	}

	clearTimeout(pending.timer);
	const { resolve } = pending;
	pending = null;
	resolve({ kind: "result", result });
	return "delivered";
}

/**
 * Cancel the armed rendezvous WITHOUT resolving it: clears the timer and drops
 * the singleton. Used on terminal dispatch paths where the outcome promise is
 * abandoned/unawaited (a cancelled `newSession`, or a wall-clock timeout that
 * already synthesised its own outcome). Deliberately does NOT call
 * `pending.resolve` — nobody is awaiting the outcome on those paths, and
 * resolving would risk a double-settle against the driver's own timeout guard.
 *
 * `token` correlates the cancel to a specific arm (M1R-1): if provided and it
 * does not match the currently pending arm's token, the cancel is a NO-OP
 * (`"stale"`) — a late cancel from an abandoned attempt must never drop a
 * SUBSEQUENT retry's live rendezvous. `token` left `undefined` cancels
 * whatever is currently pending, unconditionally (back-compat).
 */
export function cancelRendezvous(token?: number): "cancelled" | "none" | "stale" {
	if (!pending) {
		return "none";
	}
	if (token !== undefined && token !== pending.token) {
		return "stale";
	}

	clearTimeout(pending.timer);
	pending = null;
	return "cancelled";
}

/** Test/diagnostic helper: is a rendezvous currently armed? */
export function hasPendingRendezvous(): boolean {
	return pending !== null;
}
