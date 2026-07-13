/**
 * S09/T04 demo evidence — proves, on the REAL dispatch path (`runForgeLoop →
 * driver.ts's resolveDispatchAuthor → resolveModelForRole → rankUnion`, fake
 * driver only for the worker outcome, scaffolding copied verbatim from
 * `authorship-routing-e2e.test.ts` — CODING-STANDARDS §through-the-driver's
 * canonical referent), the exact addendum-bancada scenario S09-PLAN §Objetivo
 * names: a task declaring `domain: infra` routes to `openai-codex/gpt-5.6-terra`
 * (capability 0.90) over `claude-code/claude-sonnet-5` (capability 0.65) even
 * though `claude-exec` is the FIRST pool in `.gsd/models.md`'s declared order
 * — capability is the primary ranking factor, pool order is only the final
 * desempate. Two companion guard scenarios prove the legacy per-pool walk
 * stays byte-identical (no `rank_reason`/`domain` on the journal) whenever
 * judgment does not run: no `domain:` hint at all, and a domain hint with zero
 * matrix coverage.
 *
 * **Nota de honestidade (through-the-driver, não seam sintético):**
 * `resolveDispatchAuthor` (`auto/driver.ts`) — which builds the union, calls
 * `rankUnion`, and publishes `s.resolvedDispatchAuthor.rankReason/domain` — runs
 * INSIDE `runForgeLoop`, strictly BEFORE `deps.driver.dispatch(...)` is ever
 * invoked (`auto/loop.ts:1105` vs `:1249`). The fake driver below only stands
 * in for the actual worker turn (`newSession`/`forge_unit_result`); the model
 * resolution and journaling exercised here is the same production code every
 * real dispatch runs, matching the discipline `tests/loop.test.ts`'s S09/T03
 * suite already established for this exact fixture shape (`.gsd/models.md` +
 * `.gsd/CAPABILITIES.md` on disk, read by the real parsers, no mocked format).
 *
 * ATENÇÃO flaky S07 (Forward Intelligence, `slices/S07/S07-SUMMARY.md`): every
 * assertion below finds events by `kind`+`task` content, never by array index
 * — the fake-driver event-ordering race S07 diagnosed only bites index-based
 * lookups.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForgeLoop, type SessionDriver } from "../auto/loop.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { updateState } from "../state/store.ts";
import type { StateDoc } from "../state/types.ts";
import type { NextUnit } from "../state/dispatch.ts";
import { unitSlice } from "../state/dispatch.ts";
import type { UnitOutcome } from "../worker/rendezvous.ts";

const MID = "M-toy";
const SONNET = "claude-code/claude-sonnet-5";
const TERRA = "openai-codex/gpt-5.6-terra";

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-cross-pool-rank-e2e-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function milestoneDir(cwd: string): string {
  return join(cwd, ".gsd", "milestones", MID);
}

/** Write ROADMAP with a single pending slice S01 (matches loop.test.ts / authorship-routing-e2e.test.ts). */
function writeRoadmap(cwd: string): void {
  writeFileSync(
    join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
    `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | pending |\n`,
  );
}

/**
 * Write S01-PLAN.md + task dirs/plans for the given task ids. `extraFrontmatterLine`
 * is spliced verbatim into the task's frontmatter block (same knob T03 added
 * to `loop.test.ts`'s twin helper) — used here to attach `domain: infra\n` to
 * the execute-task under test without a second plan-writer.
 */
function writeSlicePlan(cwd: string, taskIds: string[], extraFrontmatterLine = ""): void {
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
      `---\nid: ${t}\nslice: S01\ntitle: "Task ${t}"\n${extraFrontmatterLine}must_haves:\n  truths:\n    - "task ${t} does its thing"\n  artifacts: []\n  key_links: []\n---\n\n# ${t}\n`,
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

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
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
 * `.gsd/models.md` routing `executor` to TWO pools, in DECLARED order:
 * `claude-exec` (sonnet) first, `gpt` (terra) second — same shape T03's
 * `writeExecutorTwoPoolConfig` (`loop.test.ts`) proves `readModelsConfig`
 * accepts. The bancada claim (S09-PLAN §Objetivo) depends on `claude-exec`
 * being FIRST: if terra still wins with the pools reversed, that would prove
 * nothing about capability beating declared order.
 */
function writeExecutorTwoPoolConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    `pools:\n  claude-exec:\n    - ${SONNET}\n  gpt:\n    - ${TERRA}\n\nroles:\n  executor:\n    - claude-exec\n    - gpt\n`,
  );
}

/**
 * `.gsd/CAPABILITIES.md` in the locked pipe-table format
 * (FORGE2-CAPABILITIES-FORMAT.md §2) — refs VERBATIM, byte-identical to
 * `models.md`'s pool refs.
 */
function writeCapabilitiesMatrix(cwd: string, rows: Array<[string, string, string]>): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  const body = rows.map(([d, m, s]) => `| ${d} | ${m} | ${s} |`).join("\n");
  writeFileSync(join(cwd, ".gsd", "CAPABILITIES.md"), `| domain | model | score |\n| --- | --- | --- |\n${body}\n`);
}

describe("S09/T04 through-the-driver — cross-pool rank por aptidão vs. legado byte-idêntico", () => {
  test("Cenário A (vitória cross-pool): domain: infra roteia p/ terra (0.90) mesmo com claude-exec na frente", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeExecutorTwoPoolConfig(cwd);
      writeCapabilitiesMatrix(cwd, [
        ["infra", SONNET, "0.65"],
        ["infra", TERRA, "0.90"],
      ]);

      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01"], "domain: infra\n"), outcome: done("planned") },
        { outcome: done("t01") },
        ...completionSteps(),
      ]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: () => {} });

      const dispatched = readEvents(cwd).find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
      assert.equal(dispatched!.model, TERRA, "capability (0.90) beats pool order — claude-exec was first, terra wins");
      assert.notEqual(dispatched!.model, SONNET, "pool-order-first (sonnet) did NOT win — this is the cross-pool claim");
      assert.equal(dispatched!.domain, "infra", "domain is journaled additively when judgment decided");
      assert.equal(typeof dispatched!.rank_reason, "string", "rank_reason is a string, not absent");
      assert.match(dispatched!.rank_reason as string, /^capability:infra/, "rank_reason cites capability as the deciding factor");
      assert.match(
        dispatched!.rank_reason as string,
        new RegExp(TERRA.replace(/[/.]/g, "\\$&")),
        "rank_reason names the winning ref",
      );

      const result = readEvents(cwd).find((e) => e.kind === "unit_result" && e.task === "T01");
      assert.ok(result, "unit_result for the execute-task (T01) exists in the journal");
      assert.equal(result!.model, TERRA, "the applied model matches the routed model in this fixture (no divergence injected)");
    });
  });

  test("Cenário B (guard, sem domain): plano SEM domain: -> primeiro pool (sonnet) vence, sem rank_reason/domain", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      // Same two-pool config + matrix as Cenário A — the ONLY difference is
      // the task plan carries no `domain:` frontmatter at all, so
      // `domainHintForUnit` degrades to `undefined` and the seam never even
      // reads CAPABILITIES.md (S03 guard, reused unchanged by S09).
      writeExecutorTwoPoolConfig(cwd);
      writeCapabilitiesMatrix(cwd, [
        ["infra", SONNET, "0.65"],
        ["infra", TERRA, "0.90"],
      ]);

      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01"]), outcome: done("planned") },
        { outcome: done("t01") },
        ...completionSteps(),
      ]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: () => {} });

      const dispatched = readEvents(cwd).find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
      assert.equal(dispatched!.model, SONNET, "no domain hint -> legacy per-pool walk, first pool (claude-exec) wins");
      assert.equal("rank_reason" in dispatched!, false, "rank_reason must be genuinely ABSENT, never \"\"");
      assert.equal("domain" in dispatched!, false, "domain must be genuinely ABSENT, never \"\"");
    });
  });

  test("Cenário C (guard, cobertura ausente): domain: infra mas matriz SEM infra -> idem legado, byte-identidade do princípio 5", async () => {
    await withSandboxAsync(async (cwd) => {
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      mkdirSync(milestoneDir(cwd), { recursive: true });
      writeRoadmap(cwd);
      writeExecutorTwoPoolConfig(cwd);
      // The task DECLARES `domain: infra`, but the matrix on disk only scores
      // an unrelated domain for neither pool ref — zero candidates in the
      // union carry a matrix score for "infra", so `rankUnion` returns `null`
      // (the guard) and the caller falls back to the legacy per-pool walk,
      // byte-identically to Cenário B — same journaled shape, same winner.
      writeCapabilitiesMatrix(cwd, [["docs", SONNET, "0.99"]]);

      const driver = fakeDriver(cwd, [
        { onDispatch: (c) => writeSlicePlan(c, ["T01"], "domain: infra\n"), outcome: done("planned") },
        { outcome: done("t01") },
        ...completionSteps(),
      ]);
      const s = makeSession(cwd);
      await runForgeLoop(s, { cwd, driver, notify: () => {} });

      const dispatched = readEvents(cwd).find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.ok(dispatched, "unit_dispatched for the execute-task (T01) exists in the journal");
      assert.equal(dispatched!.model, SONNET, "zero coverage for the declared domain -> legacy per-pool walk, first pool wins");
      assert.equal("rank_reason" in dispatched!, false, "rank_reason must be genuinely ABSENT — the domain hint alone never triggers judgment without coverage");
      assert.equal("domain" in dispatched!, false, "domain must be genuinely ABSENT under the coverage guard");
    });
  });
});
