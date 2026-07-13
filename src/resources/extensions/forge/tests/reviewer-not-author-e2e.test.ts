/**
 * S02/T03 demo evidence — proves, on the REAL dispatch path
 * (`runForgeLoop → driver → journal`, fake driver, no real pi session —
 * scaffolding copied verbatim from `tests/authorship-routing-e2e.test.ts`,
 * S01/T02), the exact scenario named by ROADMAP §Demos S02: a reviewer whose
 * author family is `claude` (journaled REAL by the loop for an `execute-task`
 * unit), with `.gsd/models.md` routing the reviewer's every non-Claude
 * candidate through an injected `AvailabilityProbe` that marks them all
 * unavailable, a Claude-baseline session, and `on_missing_pool: degrade+warn`
 * → `resolveModelForRole("reviewer", …)` returns `BLOCKED` with
 * `violation: "reviewer_not_author"` and logs the distinct VIOLATION warn —
 * it never degrades silently back into the author's own family `claude`.
 *
 * **Nota de honestidade (through-the-driver, referente real; PROIBIDO
 * SILENCIAR — S02-PLAN §"Decisão explícita"):** no `NextUnit['type']` maps to
 * the `reviewer` role (`unitTypeToRole`, S04 decisão B) — the loop's real
 * dispatch path never resolves a reviewer today. So this test drives
 * `runForgeLoop` for real (fake driver, real `.gsd/models.md` on disk, real
 * `.gsd/forge/events.jsonl` journal written by the loop) to produce a REAL
 * authored `execute-task` — the SAME journal/config sources
 * `authorship-routing-e2e.test.ts` (S01/T02) proved the loop writes on the
 * production path — and only THEN injects the `reviewer` role directly into
 * `resolveModelForRole`, feeding it `authorFamily` derived from the real
 * journal via `authorFamilyForSlice(readEvents(cwd), slice)` (the production
 * `readEvents`, `state/store.ts` — never a hand-built `ForgeEvent[]`) and
 * `config` read straight off disk via `readModelsConfig(cwd)`. This is the
 * ONLY honest way to exercise the reviewer fail-closed path today; wiring a
 * reviewer/advocate unit-type into the dispatch is out of this milestone's
 * scope (S02-PLAN §"Por que NÃO criar unit-type" / CONTEXT §"Fora de
 * escopo") — declared here, not silenced.
 *
 * No real provider credential is read anywhere in this file: all refs are
 * synthetic `claude-code/*`/`openai/*` strings, and non-Claude
 * unavailability is driven entirely by an injected `unavailableRefsProbe`
 * (`auto/availability.ts`), never a real credential/network lookup.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForgeLoop, type SessionDriver } from "../auto/loop.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { updateState, readEvents } from "../state/store.ts";
import type { StateDoc } from "../state/types.ts";
import type { NextUnit } from "../state/dispatch.ts";
import { unitSlice } from "../state/dispatch.ts";
import type { UnitOutcome } from "../worker/rendezvous.ts";
import { resolveModelForRole } from "../auto/role.ts";
import { readModelsConfig } from "../auto/models-config.ts";
import { authorFamilyForSlice } from "../auto/reviewer-independence.ts";
import { unavailableRefsProbe } from "../auto/availability.ts";

const MID = "M-toy";
const SLICE = "S01";

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-reviewer-not-author-e2e-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function milestoneDir(cwd: string): string {
  return join(cwd, ".gsd", "milestones", MID);
}

/** Write ROADMAP with a single pending slice S01 (same shape as authorship-routing-e2e.test.ts). */
function writeRoadmap(cwd: string): void {
  writeFileSync(
    join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
    `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | pending |\n`,
  );
}

/** Write S01-PLAN.md + task dirs/plans for the given task ids (simulates the planner). */
function writeSlicePlan(cwd: string, taskIds: string[]): void {
  const slicesDir = join(milestoneDir(cwd), "slices", "S01");
  mkdirSync(slicesDir, { recursive: true });
  writeFileSync(
    join(slicesDir, "S01-PLAN.md"),
    `---\nid: S01\nmilestone: ${MID}\ntitle: "Primeira slice"\n---\n\n# S01 plan\n`,
  );
  for (const t of taskIds) {
    mkdirSync(join(slicesDir, "tasks", t), { recursive: true });
    writeFileSync(
      join(slicesDir, "tasks", t, `${t}-PLAN.md`),
      `---\nid: ${t}\nslice: S01\ntitle: "Task ${t}"\nmust_haves:\n  truths:\n    - "task ${t} does its thing"\n  artifacts: []\n  key_links: []\n---\n\n# ${t}\n`,
    );
  }
}

function writeSliceSummary(cwd: string, slice = "S01"): void {
  writeFileSync(join(milestoneDir(cwd), "slices", slice, `${slice}-SUMMARY.md`), `# ${slice} summary\n`);
}

function writeMilestoneSummary(cwd: string): void {
  writeFileSync(join(milestoneDir(cwd), `${MID}-SUMMARY.md`), `# ${MID} summary\n`);
}

/** The complete-slice + complete-milestone steps the fake driver plays after the tasks. */
function completionSteps(): Step[] {
  return [
    { onDispatch: (c, u) => writeSliceSummary(c, unitSlice(u)), outcome: done("slice summary written") },
    { onDispatch: (c) => writeMilestoneSummary(c), outcome: done("milestone summary written") },
  ];
}

interface Step {
  onDispatch?: (cwd: string, unit: NextUnit, prompt: string) => void;
  outcome: UnitOutcome;
}

function fakeDriver(cwd: string, steps: Step[]): SessionDriver & { prompts: string[]; units: NextUnit[] } {
  const prompts: string[] = [];
  const units: NextUnit[] = [];
  let i = 0;
  return {
    prompts,
    units,
    async dispatch(unit: NextUnit, prompt: string): Promise<UnitOutcome> {
      const step = steps[i++];
      assert.ok(step, `fake driver ran out of scripted steps at dispatch #${i}`);
      prompts.push(prompt);
      units.push(unit);
      step.onDispatch?.(cwd, unit, prompt);
      return step.outcome;
    },
  };
}

function done(summary = "ok"): UnitOutcome {
  return { kind: "result", result: { status: "done", summary, artifacts: [] } };
}

function makeSession(cwd: string): ForgeAutoSession {
  const s = new ForgeAutoSession();
  s.active = true;
  s.cwd = cwd;
  return s;
}

/**
 * The role×pool config `.gsd/models.md` (`auto/models-config.ts:56-206`
 * format) driving the S02 §Demos scenario: two real families (`claude` +
 * `gpt`), `executor` routed to `claude` (so the loop journals `family:
 * claude` authorship on the `execute-task` below), `reviewer` offered BOTH
 * pools (gpt first, claude second — so the test proves the adversarial
 * filter + availability probe together empty it, not just pool order), and
 * `reviewer_not_author: family` + `on_missing_pool: degrade+warn` active —
 * the literal ROADMAP §Demos S02 constraint pair.
 */
function writeReviewerNotAuthorConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    [
      "pools:",
      "  claude:",
      "    - claude-code/claude-opus-4-8",
      "    - claude-code/claude-sonnet-5",
      "  gpt:",
      "    - openai/gpt-5.5",
      "    - openai/gpt-5-mini",
      "",
      "roles:",
      "  executor:",
      "    - claude",
      "  reviewer:",
      "    - gpt",
      "    - claude",
      "",
      "constraints:",
      "  reviewer_not_author: family",
      "  on_missing_pool: degrade+warn",
      "",
    ].join("\n"),
  );
}

describe("S02/T03 through-the-driver — reviewer com autor claude, candidatos não-Claude indisponíveis => BLOCKED+violação", () => {
  test("cenário literal ROADMAP §Demos S02: authorFamily='claude', pool do reviewer sem alternativa disponível, baseline Claude, degrade+warn => BLOCKED + violação (não degrada p/ claude)", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeSlicePlan(cwd, ["T01"]);
      writeReviewerNotAuthorConfig(cwd);

      const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
      const s = makeSession(cwd);
      // Baseline Claude — the literal S02 demo scenario ("sessão baseline
      // Claude"). Also the model `execute-task`'s role×pool routing (executor
      // -> claude) will resolve to, so the loop journals `family: claude`
      // authorship for real.
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;

      await runForgeLoop(s, { cwd, driver });

      // Step 1 — the authorship the loop journaled for REAL is claude, not a
      // fabricated ForgeEvent[]. `readEvents` here is the production reader
      // (`state/store.ts`), the same one `authorFamilyForSlice`'s real
      // call-site would use.
      const events = readEvents(cwd);
      const dispatched = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the real journal");
      assert.equal(dispatched.model, "claude-code/claude-opus-4-8");
      assert.equal(dispatched.provider, "claude-code");
      assert.equal(dispatched.family, "claude");

      const result = events.find((e) => e.kind === "unit_result" && e.task === "T01");
      assert.ok(result, "unit_result for the execute-task (T01) exists in the real journal");
      assert.equal(result.family, "claude");

      // Step 2 — derive authorFamily from the REAL journal (never fabricated)
      // and config from the REAL on-disk file, exactly as the S02-PLAN
      // "Decisão explícita" prescribes for the injected reviewer resolution.
      const authorFamily = authorFamilyForSlice(events, SLICE);
      assert.equal(authorFamily, "claude", "authorFamily is derived from the loop's REAL journal, not fabricated");

      const config = readModelsConfig(cwd);
      assert.deepEqual(config.constraints, { reviewer_not_author: "family", on_missing_pool: "degrade+warn" });

      // Step 3 — the reviewer role has no dispatch call-site (no NextUnit
      // maps to it); inject it directly per the declared decision above. All
      // non-Claude candidates are marked unavailable via the injected probe —
      // the literal S02 scenario ("todos os candidatos não-Claude
      // indisponíveis").
      const reviewedUnit: NextUnit = { type: "execute-task", slice: SLICE, task: "T99" };
      const availabilityProbe = unavailableRefsProbe(["openai/gpt-5.5", "openai/gpt-5-mini"]);

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      let actual: ReturnType<typeof resolveModelForRole>;
      try {
        actual = resolveModelForRole("reviewer", reviewedUnit, {
          session: s,
          config,
          authorFamily,
          availabilityProbe,
        });
      } finally {
        console.warn = originalWarn;
      }

      // BLOCKED + violation — NOT degraded to claude (the author's own
      // family), which is what the pre-S02/T01 bug would have silently
      // returned via the Claude baseline.
      assert.deepEqual(actual, { model: null, provider: null, family: null, violation: "reviewer_not_author" });
      assert.notEqual(actual.family, "claude", "the reviewer must never resolve back into the author's own family");

      assert.equal(warnings.length, 1, "exactly one warn is emitted — never both the violation and the generic degrade warn");
      assert.match(warnings[0], /VIOLATION reviewer_not_author/, "the warn must cite the violation, not the generic degrade text");
      assert.match(warnings[0], /claude/, "the warn must cite the author family the degrade collided with");
      assert.doesNotMatch(
        warnings[0],
        /degrading to pool-of-one/,
        "the violation warn is textually distinct from the generic degrade warn",
      );
    });
  });
});
