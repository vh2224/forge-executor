import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchUnitViaNewSession, journalReviewerNotAuthorViolation, resolveDispatchAuthor } from "../auto/driver.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { roleForUnit } from "../auto/role.ts";
import { tierHintForUnit, effortHintForUnit, domainHintForUnit } from "../auto/rank-hint.ts";
import type { NextUnit } from "../state/index.ts";
import type { ComposableUnit } from "../prompts/compose.ts";
import { updateState } from "../state/store.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";
import { getWorkerMcpRecord } from "../worker/mcp-bridge.ts";
import { CredentialRotator, type CredentialSource } from "@forge/agent-core/credential-rotation.js";

/**
 * M-20260711135806-wiring-multi-llm / S02 / T02 — `driver.ts` is the call-site
 * S02-PLAN names as the swallow risk: a BLOCKED `resolveModelForRole` result
 * (`resolved.model === null`) only zeroes `pendingUnitModel`, so the hook
 * applies nothing and the session silently runs on baseline. This proves that
 * when the BLOCKED carries T01's `violation: "reviewer_not_author"` marker,
 * the driver journals it distinctly via `journalReviewerNotAuthorViolation`
 * (kind `reviewer_not_author_violation`) — never conflated with the generic
 * `on_missing_pool: "block"` BLOCKED (no marker, no such event) or a normal
 * degrade (role.ts's own console.warn, not a journal event).
 *
 * Honesty note (T02-PLAN step 5, "fake do seam"): no production `NextUnit`
 * type resolves as `reviewer`/`advocate` (`roleForUnit` has no entry for
 * either — S04 decisão B), so `dispatchUnitViaNewSession`'s own call to
 * `resolveModelForRole` can never actually produce a `violation` marker
 * through the real dispatch path today. The exported signaling helper is
 * therefore exercised directly with the role a real `resolve("reviewer", ...)`
 * collision would carry, rather than fabricating a fake `resolveModelForRole`
 * import or a config on disk that a real call-site can never reach. The third
 * test below proves the real call-site's non-regression: an ordinary
 * execute-task dispatch never journals this kind.
 */

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("driver: reviewer_not_author violation signal (S02/T02)", () => {
  test("journalReviewerNotAuthorViolation appends a distinct BLOCKED-violation event, not the generic degrade/dispatch shape", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-violation-"));
    try {
      const s = new ForgeAutoSession();
      s.cwd = cwd;
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };

      journalReviewerNotAuthorViolation(s, unit, "reviewer");

      const events = readEvents(cwd);
      assert.equal(events.length, 1, "exactly one event journaled");
      const ev = events[0];
      assert.equal(ev.kind, "reviewer_not_author_violation");
      assert.equal(ev.status, "blocked");
      assert.equal(ev.unit, "S01/T01");
      assert.equal(ev.task, "T01");
      assert.match(String(ev.summary), /reviewer_not_author/, "summary cites the violation by name");
      assert.doesNotMatch(
        String(ev.summary),
        /degrading to pool-of-one/,
        "must not read like the generic degrade warn",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("journalReviewerNotAuthorViolation is best-effort: a blocked journal write never throws", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-violation-blocked-"));
    try {
      // `.gsd` exists as a plain FILE, not a directory — appendEvent's
      // `mkdirSync(dirname(path), { recursive: true })` fails with ENOTDIR,
      // proving the try/catch actually shields a real write failure.
      writeFileSync(join(cwd, ".gsd"), "not a directory");
      const s = new ForgeAutoSession();
      s.cwd = cwd;
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      assert.doesNotThrow(() => journalReviewerNotAuthorViolation(s, unit, "reviewer"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("non-regression: a normal execute-task dispatch through dispatchUnitViaNewSession never journals a reviewer_not_author_violation event", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-no-violation-"));
    try {
      const s = new ForgeAutoSession();
      s.cwd = cwd;

      // Same R1-fixed fast-pause shape as driver-fast-pause.test.ts: a worker
      // turn that throws resolves a synthetic `blocked` outcome quickly,
      // without needing a real rendezvous delivery — the resolution block
      // under test runs regardless of how the dispatch itself concludes.
      const freshCtx = {
        abort() {},
        async sendMessage(): Promise<void> {
          throw new Error("boom: worker turn failed inside sendMessage");
        },
      };
      const cmdCtx = {
        abort() {},
        model: undefined,
        async newSession(opts: { withSession: (ctx: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
          let failure: { error: unknown } | undefined;
          try {
            await opts.withSession(freshCtx);
          } catch (error) {
            failure = { error };
          }
          if (failure) throw failure.error;
          return { cancelled: false };
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = cmdCtx as any;

      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      await dispatchUnitViaNewSession(s, unit, "prompt");

      const kinds = readEvents(cwd).map((e) => e.kind);
      assert.ok(
        !kinds.includes("reviewer_not_author_violation"),
        "roleForUnit(execute-task) is always executor — the real dispatch path can never trigger the violation branch",
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * S03/T01 — the rotator threading proof: `dispatchUnitViaNewSession`'s
 * resolution block reads `s.credentialRotator`, selects a credential for the
 * WINNING provider, publishes `{ provider, index, identity }` (S04/T02 widens
 * this to identity, read straight off `selectCredential`'s return — never
 * re-derived), and injects `providerAvailabilityProbe` into the seam's ctx —
 * all while the no-rotator path (every pre-S03 caller) stays byte-identical
 * to S02.
 *
 * Fakes mirror `packages/forge-agent-core/src/credential-rotation-e2e.test.ts`
 * (`apiKey`/`fakeAuthStorage`, synthetic-only credentials — never a real key)
 * and this file's own fast-pause `cmdCtx`/`freshCtx` shape (a `sendMessage`
 * that throws settles the dispatch synchronously, no real rendezvous
 * delivery needed — the resolution block under test runs regardless of how
 * the dispatch itself concludes).
 */

function apiKey(key: string) {
  return { type: "api_key" as const, key };
}

function fakeAuthStorage(data: Record<string, ReturnType<typeof apiKey>[]>): CredentialSource {
  return {
    getCredentialsForProvider: (provider: string) => data[provider] ?? [],
  };
}

/** Fast-settling fake `cmdCtx` — same shape as the non-regression test above. */
function fakeCmdCtx(model: { id: string; provider: string } | undefined) {
  const freshCtx = {
    abort() {},
    async sendMessage(): Promise<void> {
      throw new Error("boom: worker turn failed inside sendMessage");
    },
  };
  return {
    abort() {},
    model,
    async newSession(opts: { withSession: (ctx: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
      let failure: { error: unknown } | undefined;
      try {
        await opts.withSession(freshCtx);
      } catch (error) {
        failure = { error };
      }
      if (failure) throw failure.error;
      return { cancelled: false };
    },
  };
}

/** `.gsd/models.md` routing `executor` to a single-ref `openai` pool (`authorship-routing-e2e.test.ts` shape). */
function writeExecutorRoutesToOpenaiConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "pools:\n  primary:\n    - openai/gpt-5.5\n\nroles:\n  executor:\n    - primary\n",
  );
}

describe("driver: CredentialRotator threading (S03/T01)", () => {
  test("no rotator on the container: resolveModelForRole gets { session } only, selectedCredential stays null (byte-identical to S02)", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-no-rotator-"));
    try {
      const s = new ForgeAutoSession();
      s.cwd = cwd;
      s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
      assert.equal(s.credentialRotator, null, "no rotator published on this container");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = fakeCmdCtx(undefined) as any;
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      await dispatchUnitViaNewSession(s, unit, "prompt");

      assert.equal(s.selectedCredential, null, "no rotator -> nothing selected, ever");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("with a rotator, nothing exhausted: selects index 0 for the winning provider and publishes { provider, index, identity }", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-rotator-select-"));
    try {
      writeExecutorRoutesToOpenaiConfig(cwd);
      const credA = apiKey("fake-openai-A");
      const credB = apiKey("fake-openai-B");
      const rotator = new CredentialRotator(fakeAuthStorage({ openai: [credA, credB] }));

      const s = new ForgeAutoSession();
      s.cwd = cwd;
      s.credentialRotator = rotator;
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = fakeCmdCtx(undefined) as any;
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      await dispatchUnitViaNewSession(s, unit, "prompt");

      // The pool's single ref wins (nothing exhausted -> available), so the
      // seam picks "openai" — not the Claude baseline — and the rotator
      // selects the first (index 0) of its two credentials for it.
      assert.equal(s.pendingUnitModel, "openai/gpt-5.5", "pool ref wins over the Claude baseline");
      assert.deepEqual(s.selectedCredential, { provider: "openai", index: 0, identity: "fake-openai-A", token: s.currentRendezvousToken! });
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("S04/T02: reorder between two dispatches still targets the credential by identity, not by its new array position", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-rotator-reorder-"));
    try {
      writeExecutorRoutesToOpenaiConfig(cwd);
      const credA = apiKey("fake-openai-A");
      const credB = apiKey("fake-openai-B");
      // Mutable in place (same object the rotator's `CredentialSource` reads
      // on every call) so it can be reordered between the two dispatches
      // below without swapping out the rotator or the fake source.
      const data: Record<string, ReturnType<typeof apiKey>[]> = { openai: [credA, credB] };
      const rotator = new CredentialRotator(fakeAuthStorage(data));

      const s = new ForgeAutoSession();
      s.cwd = cwd;
      s.credentialRotator = rotator;
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = fakeCmdCtx(undefined) as any;
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      await dispatchUnitViaNewSession(s, unit, "prompt");

      assert.deepEqual(
        s.selectedCredential,
        { provider: "openai", index: 0, identity: "fake-openai-A", token: s.currentRendezvousToken! },
        "first dispatch picks credA at its current index 0",
      );
      // Close the loop on the credential the driver actually published —
      // exactly what the real message_end hook does, using the identity, not
      // the index — then reorder the array before the next dispatch.
      rotator.markExhausted("openai", s.selectedCredential!.identity, Date.now());
      data.openai = [credB, credA];

      await dispatchUnitViaNewSession(s, unit, "prompt");

      assert.deepEqual(
        s.selectedCredential,
        { provider: "openai", index: 0, identity: "fake-openai-B", token: s.currentRendezvousToken! },
        "second dispatch skips the still-cooling credA (now at index 1) and picks credB by identity, regardless of the reorder",
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("with a rotator, provider fully exhausted: providerAvailabilityProbe filters the pool ref out and resolution degrades", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-rotator-exhausted-"));
    try {
      writeExecutorRoutesToOpenaiConfig(cwd);
      const credA = apiKey("fake-openai-A");
      const credB = apiKey("fake-openai-B");
      const rotator = new CredentialRotator(fakeAuthStorage({ openai: [credA, credB] }));
      const nowMs = Date.now();
      // Both openai credentials cooling down -> providerAvailabilityProbe
      // reports "openai/gpt-5.5" unavailable, so the pool's only ref is
      // filtered out and resolution falls through to on_missing_pool's
      // degrade. The degrade candidate itself resolves to null/null (the
      // pre-existing S02/T02 contract: cmdCtx/baselineModel are deliberately
      // nulled around this exact call so only the pure `resolveUnitModel`
      // branch is reachable — unrelated to and unchanged by S03/T01).
      rotator.markExhausted("openai", "fake-openai-A", nowMs);
      rotator.markExhausted("openai", "fake-openai-B", nowMs);

      const s = new ForgeAutoSession();
      s.cwd = cwd;
      s.credentialRotator = rotator;
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = fakeCmdCtx(undefined) as any;
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      await dispatchUnitViaNewSession(s, unit, "prompt");

      assert.equal(
        s.pendingUnitModel,
        null,
        "the exhausted openai pool ref was filtered by the probe, and the degrade candidate resolves to null (no live baseline reachable at this call)",
      );
      assert.equal(
        s.selectedCredential,
        null,
        "resolved.provider is null -> nothing to select, the probe's filtering is the reason no credential is picked",
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * S07/T02 — through-the-driver proof that T01's threading actually reaches
 * the seam via the real dispatch path (`dispatchUnitViaNewSession`), not a
 * synthetic `ResolveModelCtx` handed straight to `resolveModelForRole`/
 * `rankPool`. Three cases:
 *
 * 1. Downgrade demo (ROADMAP §S07): a two-tier `openai` pool (`gpt-5.5`=max
 *    first, `gpt-5-mini`=light second) plus a real on-disk `T##-PLAN.md`
 *    carrying `tier: light` frontmatter downgrades `pendingUnitModel` below
 *    the pool's declared ceiling.
 * 2. Control: same pool, no `tier` hint on the plan -> the pool ceiling wins,
 *    byte-identical to pre-S07 — pins that Case 1's downgrade came FROM the
 *    hint, not from anything else.
 * 3. `FORGE_BUDGET_PRESSURE` reaches the seam through the same call-site and
 *    lowers the pick one tier below the ceiling, with no `tier` hint present
 *    (isolating the budget-pressure effect).
 *
 * The pool's top ref is `openai` (pay-per-token, `PROVIDER_FLAT_RATE.openai
 * === false`) — NEVER `claude-code` (flat-rate). `rankPool`'s flat-rate
 * short-circuit returns the top ref immediately for a flat-rate provider,
 * which would suppress both the tier hint and budget pressure and make the
 * downgrade unobservable (`model-rank.ts:99-101`).
 */

/** `.gsd/models.md` routing `executor` to a TWO-ref `openai` pool, ceiling (max) first — needed to observe a downgrade (S07/T02; `writeExecutorRoutesToOpenaiConfig` above is single-ref, insufficient here). */
function writeTwoTierExecutorPoolConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "pools:\n  primary:\n    - openai/gpt-5.5\n    - openai/gpt-5-mini\n\nroles:\n  executor:\n    - primary\n",
  );
}

/**
 * Writes a REAL STATE.md (via `updateState`, the same module `tierHintForUnit`
 * reads through `readState`) with `milestone` set, plus a real
 * `T##-PLAN.md` at the exact path `tierHintForUnit` computes
 * (`rank-hint.ts:59-69`) — with `tier: <tier>` frontmatter when `tier` is
 * passed, or no `tier` key at all when omitted (the control case).
 */
function writeTaskPlanWithTier(cwd: string, milestone: string, slice: string, task: string, tier?: string): void {
  writeTaskPlanWithFrontmatter(cwd, milestone, slice, task, tier !== undefined ? `tier: ${tier}\n` : "");
}

/** Shared body of the plan-writing fixtures (S01/T03 DRY): real STATE.md via
 *  `updateState` + a real `T##-PLAN.md` with `extraFrontmatterLines` spliced
 *  into the frontmatter block (empty string = bare frontmatter, the control). */
function writeTaskPlanWithFrontmatter(
  cwd: string,
  milestone: string,
  slice: string,
  task: string,
  extraFrontmatterLines: string,
): void {
  updateState(cwd, (state) => ({ ...state, milestone }));
  const dir = join(cwd, ".gsd", "milestones", milestone, "slices", slice, "tasks", task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task}-PLAN.md`), `---\nid: ${task}\n${extraFrontmatterLines}---\n\n# ${task}\n`);
}

describe("driver: tierHint + budgetPressure threading (S07/T01)", () => {
  test("downgrade demo: pool ceiling-first (max) + T##-PLAN tier: light hint -> pendingUnitModel is the light ref, NOT the pool ceiling", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-tierhint-downgrade-"));
    try {
      writeTwoTierExecutorPoolConfig(cwd);
      writeTaskPlanWithTier(cwd, "M-fake-tierhint-downgrade", "S01", "T01", "light");

      const s = new ForgeAutoSession();
      s.cwd = cwd;
      // Baseline is claude-code (flat-rate) — irrelevant here, the pool ref wins
      // over the baseline regardless (same as the S03 rotator-select test above).
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = fakeCmdCtx(undefined) as any;
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      await dispatchUnitViaNewSession(s, unit, "prompt");

      // `openai` is pay-per-token, so `rankPool` does NOT flat-rate
      // short-circuit on the pool's top ref — the `tier: light` hint read
      // off the real T##-PLAN.md through `tierHintForUnit` reaches the seam
      // and downgrades the pick from the ceiling (max, gpt-5.5) to light
      // (gpt-5-mini).
      assert.equal(
        s.pendingUnitModel,
        "openai/gpt-5-mini",
        "tier: light hint downgrades the pick below the pool ceiling (openai/gpt-5.5)",
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("control: same pool, no tier hint on the T##-PLAN.md -> pendingUnitModel stays the pool ceiling (byte-identical to pre-S07)", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-tierhint-control-"));
    try {
      writeTwoTierExecutorPoolConfig(cwd);
      writeTaskPlanWithTier(cwd, "M-fake-tierhint-control", "S01", "T01");

      const s = new ForgeAutoSession();
      s.cwd = cwd;
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = fakeCmdCtx(undefined) as any;
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      await dispatchUnitViaNewSession(s, unit, "prompt");

      assert.equal(
        s.pendingUnitModel,
        "openai/gpt-5.5",
        "no tier hint -> the pool ceiling wins, same as pre-S07 (pins that Case 1's downgrade came from the hint)",
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("through-the-driver: FORGE_BUDGET_PRESSURE reaches the seam and lowers the pick one tier below the ceiling, env restored in finally", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    const prevBudget = process.env.FORGE_BUDGET_PRESSURE;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    process.env.FORGE_BUDGET_PRESSURE = "1";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-budgetpressure-"));
    try {
      writeTwoTierExecutorPoolConfig(cwd);
      // No `tier` hint on the plan — isolates budgetPressure's effect from T01.
      writeTaskPlanWithTier(cwd, "M-fake-budgetpressure", "S01", "T01");

      const s = new ForgeAutoSession();
      s.cwd = cwd;
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = fakeCmdCtx(undefined) as any;
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      await dispatchUnitViaNewSession(s, unit, "prompt");

      // `rankPool` lowers the target one ordinal below the ceiling (max ->
      // heavy), clamped to the lowest tier actually present in the pool
      // (`model-rank.ts:109-115`); no ref sits at "heavy" in this two-tier
      // pool, so the closest present tier at-or-below the target wins: light
      // (gpt-5-mini) — one full step down from the max ceiling.
      assert.equal(
        s.pendingUnitModel,
        "openai/gpt-5-mini",
        "budgetPressure lowers the pick below the pool ceiling (openai/gpt-5.5), with no tier hint involved",
      );
    } finally {
      if (prevBudget === undefined) delete process.env.FORGE_BUDGET_PRESSURE;
      else process.env.FORGE_BUDGET_PRESSURE = prevBudget;
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * S01/T03 — effort resolution + tokenized stamping on the dispatch path:
 * `resolveDispatchAuthor` publishes `s.resolvedDispatchEffort` (frontmatter >
 * prefs role default, `effort_max` ceiling applied — the pure T01 resolver fed
 * with the real on-disk sandbox), and `dispatchUnitViaNewSession` stamps
 * `pendingUnitEffort`/`pendingUnitEffortToken` with THIS dispatch's rendezvous
 * token. With no effort config anywhere, both stay null and no token is
 * stamped — the byte-identity precondition (D-S01-3).
 *
 * The user-scope prefs layers (~/.claude + gsdHome()) are isolated per test —
 * same fixture discipline as `prefs.test.ts` — so a real prefs file on the
 * machine running these tests can never contaminate the resolution.
 */
async function withIsolatedHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
  const fakeHome = mkdtempSync(join(tmpdir(), "forge-driver-effort-home-"));
  const prevHome = process.env.HOME;
  const prevForgeHome = process.env.FORGE_HOME;
  process.env.HOME = fakeHome;
  process.env.FORGE_HOME = join(fakeHome, ".forge");
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevForgeHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevForgeHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

describe("driver: effort resolution + tokenized stamping (S01/T03)", () => {
  test("resolveDispatchAuthor publishes resolvedDispatchEffort from frontmatter + prefs, effort_max ceiling recorded in the reason", async () => {
    await withIsolatedHomeAsync(async () => {
      const cwd = mkdtempSync(join(tmpdir(), "forge-driver-effort-resolve-"));
      try {
        writeTaskPlanWithFrontmatter(cwd, "M-fake-effort-resolve", "S01", "T01", "effort: high\n");
        writeFileSync(join(cwd, ".gsd", "prefs.md"), "effort_max: medium\n");

        const s = new ForgeAutoSession();
        s.cwd = cwd;
        const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
        resolveDispatchAuthor(s, unit, Date.now());

        assert.deepEqual(
          s.resolvedDispatchEffort,
          { level: "medium", reason: "task-frontmatter; capped high→medium by effort_max" },
          "frontmatter hint resolved, demoted by the prefs effort_max ceiling, demotion audited in the reason",
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  test("through-the-driver: dispatch stamps pendingUnitEffort with THIS dispatch's rendezvous token, applied fields cleared", async () => {
    await withIsolatedHomeAsync(async () => {
      const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
      process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
      const cwd = mkdtempSync(join(tmpdir(), "forge-driver-effort-stamp-"));
      try {
        writeTaskPlanWithFrontmatter(cwd, "M-fake-effort-stamp", "S01", "T01", "effort: xhigh\n");

        const s = new ForgeAutoSession();
        s.cwd = cwd;
        // Simulate stale applied leftovers from a prior unit — the dispatch
        // block must clear them alongside the model's applied fields.
        s.appliedUnitEffort = { level: "low", clamped: null };
        s.appliedUnitEffortToken = 999;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        s.cmdCtx = fakeCmdCtx(undefined) as any;
        const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
        await dispatchUnitViaNewSession(s, unit, "prompt");

        assert.deepEqual(
          s.pendingUnitEffort,
          { level: "xhigh", reason: "task-frontmatter" },
          "the resolved effort is what the dispatch block stamps for the hook",
        );
        assert.equal(
          s.pendingUnitEffortToken,
          s.currentRendezvousToken,
          "stamped with the rendezvous token minted for THIS dispatch (MEM001/D16)",
        );
        assert.equal(s.appliedUnitEffort, null, "stale applied effort cleared before arming the hook");
        assert.equal(s.appliedUnitEffortToken, null);
      } finally {
        if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
        else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  test("byte-identity: no effort config anywhere -> resolvedDispatchEffort null, pending null, NO token stamped", async () => {
    await withIsolatedHomeAsync(async () => {
      const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
      process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
      const cwd = mkdtempSync(join(tmpdir(), "forge-driver-effort-none-"));
      try {
        // Plan exists (control shape) but carries no `effort:` key; no prefs file.
        writeTaskPlanWithFrontmatter(cwd, "M-fake-effort-none", "S01", "T01", "");

        const s = new ForgeAutoSession();
        s.cwd = cwd;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        s.cmdCtx = fakeCmdCtx(undefined) as any;
        const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
        await dispatchUnitViaNewSession(s, unit, "prompt");

        assert.equal(s.resolvedDispatchEffort, null, "nothing resolved without config (byte-identity path)");
        assert.equal(s.pendingUnitEffort, null, "nothing pending for the hook");
        assert.equal(s.pendingUnitEffortToken, null, "no token stamped when there is no effort to apply");
      } finally {
        if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
        else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});

/**
 * S03 do milestone capacidade-esforço / T03 — `resolveDispatchAuthor` threads
 * the planner's `domain:` frontmatter into the seam (`domainHintForUnit` at
 * the same call-site and with the same caller-side discipline as
 * `tierHintForUnit`), and the seam resolves the on-disk S02 matrix
 * (`.gsd/CAPABILITIES.md`) to reorder co-finalists within the pool. The pool
 * holds two refs UNKNOWN to the static table (default standard/1/1 — tie on
 * everything except pool order) with a non-flat-rate head, so the matrix is
 * the only discriminator; without the `domain:` frontmatter the head wins,
 * byte-identical to pre-S03 (mirrors the tierHint downgrade/control pair
 * above).
 */

/** `.gsd/models.md` routing `executor` to two co-finalist refs unknown to the static table (head non-flat-rate). */
function writeCoFinalistExecutorPoolConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "pools:\n  unknowns:\n    - prov-a/model-x\n    - prov-b/model-y\n\nroles:\n  executor:\n    - unknowns\n",
  );
}

/** `.gsd/CAPABILITIES.md` scoring the NON-head ref (prov-b/model-y) as the backend favorite. */
function writeBackendCapabilitiesMatrix(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "CAPABILITIES.md"),
    [
      "| domain | model | score |",
      "| --- | --- | --- |",
      "| backend | prov-a/model-x | 0.20 |",
      "| backend | prov-b/model-y | 0.95 |",
    ].join("\n"),
  );
}

describe("driver: domain hint threading (S03 capacidade-esforço / T03)", () => {
  test("T##-PLAN domain: backend + .gsd/CAPABILITIES.md -> resolvedDispatchAuthor.model is the matrix favorite, not the pool head", async () => {
    await withIsolatedHomeAsync(async () => {
      const cwd = mkdtempSync(join(tmpdir(), "forge-driver-domain-hint-"));
      try {
        writeCoFinalistExecutorPoolConfig(cwd);
        writeBackendCapabilitiesMatrix(cwd);
        writeTaskPlanWithFrontmatter(cwd, "M-fake-domain-hint", "S01", "T01", "domain: backend\n");

        const s = new ForgeAutoSession();
        s.cwd = cwd;
        const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
        resolveDispatchAuthor(s, unit, Date.now());

        assert.equal(
          s.resolvedDispatchAuthor?.model,
          "prov-b/model-y",
          "the domain hint read off the real T##-PLAN.md reached the seam and the on-disk matrix reordered the co-finalists",
        );
        assert.equal(s.pendingUnitModel, "prov-b/model-y", "the pending model follows the same resolution");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  test("control: same pool + same on-disk matrix, NO domain frontmatter -> the pool head wins (byte-identical to pre-S03)", async () => {
    await withIsolatedHomeAsync(async () => {
      const cwd = mkdtempSync(join(tmpdir(), "forge-driver-domain-control-"));
      try {
        writeCoFinalistExecutorPoolConfig(cwd);
        writeBackendCapabilitiesMatrix(cwd);
        writeTaskPlanWithFrontmatter(cwd, "M-fake-domain-control", "S01", "T01", "");

        const s = new ForgeAutoSession();
        s.cwd = cwd;
        const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
        resolveDispatchAuthor(s, unit, Date.now());

        assert.equal(
          s.resolvedDispatchAuthor?.model,
          "prov-a/model-x",
          "without the domain: frontmatter the matrix on disk is never consulted — pins that Case 1's reorder came from the hint",
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});

/**
 * S04/T03 (D-S04-2) — the dispatch spine accepts a `ComposableUnit`:
 * `{ type: "research-models" }` (the first slice-less, repo-level variant)
 * flows through `dispatchUnitViaNewSession`'s REAL machinery — rendezvous +
 * token, authorship resolution (tolerant `roleForUnit` fallback → the
 * executor pool), MCP publish window, per-dispatch teardown — with no cast
 * and no parallel dispatcher. Unlike the fast-pause fakes above (whose
 * `sendMessage` throws), this fake worker DELIVERS a result into the armed
 * rendezvous via `deliverUnitResult` + the container's live token, proving
 * the delivered-outcome path end to end for the new variant.
 */
describe("driver: research-models dispatch through the ComposableUnit spine (S04/T03)", () => {
  test("dispatch of { type: 'research-models' } publishes pendingUnitType, resolves authorship under the executor pool, and returns the delivered outcome", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-driver-research-models-"));
    try {
      // The executor pool routes to openai — reaching it proves the tolerant
      // roleForUnit fallback resolved "executor" through the real call-site.
      writeExecutorRoutesToOpenaiConfig(cwd);

      const s = new ForgeAutoSession();
      s.cwd = cwd;
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      // Worker fake: observe the published pending unit type and commit a
      // result through THIS dispatch's armed rendezvous (token off the live
      // container, exactly where `worker/unit-result.ts` correlates it).
      let pendingTypeInsideWorker: string | null = null;
      const freshCtx = {
        abort() {},
        async sendMessage(): Promise<void> {
          pendingTypeInsideWorker = s.pendingUnitType;
          deliverUnitResult(
            { status: "done", summary: "matriz atualizada", artifacts: [".gsd/CAPABILITIES.md"] },
            s.currentRendezvousToken ?? undefined,
          );
        },
      };
      const cmdCtx = {
        abort() {},
        model: undefined,
        async newSession(opts: { withSession: (ctx: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
          await opts.withSession(freshCtx);
          return { cancelled: false };
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = cmdCtx as any;

      const unit: ComposableUnit = { type: "research-models" };
      const outcome = await dispatchUnitViaNewSession(s, unit, "prompt");

      assert.equal(
        pendingTypeInsideWorker,
        "research-models",
        "the pending unit type was published BEFORE newSession, for the fresh instance's session_start scoping",
      );
      assert.equal(outcome.kind, "result", "the delivered rendezvous result settles the dispatch");
      assert.equal(
        outcome.kind === "result" ? outcome.result.status : undefined,
        "done",
        "the outcome is the worker's own delivered payload",
      );
      assert.equal(
        s.resolvedDispatchAuthor?.model,
        "openai/gpt-5.5",
        "authorship resolved through the executor role's pool — the tolerant roleForUnit fallback routed the unknown-to-the-table type as executor",
      );
      assert.equal(s.resolvedDispatchAuthor?.provider, "openai");
      assert.equal(s.pendingUnitModel, "openai/gpt-5.5", "the pending model follows the same resolution");

      // Per-dispatch teardown, same shape the neighbor cases rely on: the MCP
      // publish window is closed in the driver's finally, and the in-flight
      // dispatch slot clears once the abandoned turn settles.
      assert.equal(getWorkerMcpRecord(), null, "the worker MCP record is cleared exactly once per dispatch");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(s.pendingDispatch, null, "the R2 in-flight slot is cleared after the dispatch settles");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("roleForUnit maps research-models to researcher (M8/S01); hint readers return undefined for the non-execute-task unit", () => {
    // M8/S01 (canal X): research-models ganhou papel dedicado `researcher` —
    // sem entrada `researcher:` no models.md a RESOLUÇÃO ainda degrada para os
    // pools de executor (byte-compat), mas o PAPEL agora é researcher. O
    // fallback tolerante D-S04-3 continua coberto pelo tipo desconhecido abaixo.
    const unit: ComposableUnit = { type: "research-models" };
    assert.equal(roleForUnit(unit), "researcher", "research-models routes through the dedicated researcher role (M8/S01)");
    assert.equal(
      roleForUnit({ type: "unknown-future-unit" } as unknown as ComposableUnit),
      "executor",
      "tolerant lookup: no unitTypeToRole entry -> executor (D-S04-3)",
    );
    // The readers' `unit.type !== "execute-task"` narrowing returns before any
    // filesystem access — a nonexistent cwd proves no read is even attempted.
    assert.equal(tierHintForUnit("/nonexistent-cwd", unit), undefined);
    assert.equal(effortHintForUnit("/nonexistent-cwd", unit), undefined);
    assert.equal(domainHintForUnit("/nonexistent-cwd", unit), undefined);
  });
});
