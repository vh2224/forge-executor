/**
 * S03/T04 demo evidence — proves, on the REAL dispatch path (`runForgeLoop →
 * driver → journal`, fake driver, no real pi session — scaffolding copied
 * verbatim from `tests/effort-routing-e2e.test.ts`), the four scenarios named
 * by ROADMAP §S03's demo: (A) two tasks identical except for the `domain:`
 * frontmatter are dispatched with DIFFERENT models from the SAME pool — the
 * S02 capability matrix (`.gsd/CAPABILITIES.md`, read off the sandbox disk)
 * reorders the co-finalists per domain; (B) with no `domain:` and no
 * CAPABILITIES.md, the dispatched model is the pool head (current rank,
 * byte-identical) and NO journal event gains any domain-related key
 * (D-S03-3); (C) the matrix never pierces the pool's tier ceiling — a
 * max-tier ref with matrix score 1.0 loses to a light-tier head
 * (downgrade-only intact); (D) a flat-rate head short-circuits the rank
 * before the tie-break — the matrix favoring another ref changes nothing
 * (suppression intact).
 *
 * **Nota de honestidade (through-the-driver, não seam sintético):** the fake
 * driver never resolves the model itself — `runForgeLoop` calls
 * `resolveDispatchAuthor` (`auto/loop.ts`, pre-journal), which reads the REAL
 * `T##-PLAN.md` frontmatter off disk (`domainHintForUnit`, S03/T01), threads
 * it as `ResolveModelCtx.domain` (S03/T03), and the seam
 * (`resolveModelForRole`) reads the REAL `.gsd/models.md` and — only when the
 * domain hint is present — the REAL `.gsd/CAPABILITIES.md` (S02 parser),
 * injecting the pure lookup into `rankPool`'s finalist tie-break (S03/T02,
 * D-S03-1). The model recorded on `unit_dispatched` here is produced by
 * production code on the exact journaling path production uses — the
 * CODING-STANDARDS through-the-driver claim this slice's SUMMARY needs.
 *
 * **FI da S02 honored in the fixtures:** the refs in the sandbox
 * CAPABILITIES.md are byte-identical to the models.md pool refs — the lookup
 * is a VERBATIM case-sensitive match, and a silent miss would degenerate
 * scenario A into scenario B.
 *
 * The user-scope prefs layers (~/.claude + gsdHome()) are isolated per test —
 * `resolveDispatchAuthor` also resolves effort by reading prefs from HOME
 * (S01 FI: a real prefs file on this machine would contaminate scenario B's
 * absence assertion) — same fixture discipline as `tests/driver.test.ts`.
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

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-domain-routing-e2e-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Isolates the two user-scope prefs layers (`~/.claude/forge-agent-prefs.md`
 * and `gsdHome()/prefs.md`) behind a throwaway HOME/FORGE_HOME — the domain
 * resolution never reads prefs, but `resolveDispatchAuthor` resolves effort
 * from them on the same call, and scenario B asserts key-absence over EVERY
 * journal event (copied from `tests/effort-routing-e2e.test.ts`, S01/T04).
 */
async function withIsolatedHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
  const fakeHome = mkdtempSync(join(tmpdir(), "forge-domain-routing-e2e-home-"));
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

function milestoneDir(cwd: string): string {
  return join(cwd, ".gsd", "milestones", MID);
}

/** Write ROADMAP with a single pending slice S01 (matches effort-routing-e2e.test.ts). */
function writeRoadmap(cwd: string): void {
  writeFileSync(
    join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
    `# Toy milestone\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Primeira slice | med | — | pending |\n`,
  );
}

/** A task to plan: id + the frontmatter line spliced verbatim (e.g. `"domain: backend\n"`). */
interface TaskSpec {
  id: string;
  frontmatterLine?: string;
}

/**
 * Write S01-PLAN.md + task dirs/plans (simulates the planner). Each task's
 * frontmatter gets its OWN `frontmatterLine` spliced in verbatim — scenario A
 * needs two plans identical except for the `domain:` value, the exact input
 * the ROADMAP §S03 demo names. An empty/absent line writes the control plan
 * with NO `domain:` key at all, the file `domainHintForUnit` degrades to
 * `undefined` on.
 */
function writeSlicePlan(cwd: string, tasks: TaskSpec[]): void {
  const slicesDir = join(milestoneDir(cwd), "slices", "S01");
  mkdirSync(slicesDir, { recursive: true });
  writeFileSync(
    join(slicesDir, "S01-PLAN.md"),
    `---\nid: S01\nmilestone: ${MID}\ntitle: "Primeira slice"\n---\n\n# S01 plan\n`,
  );
  for (const t of tasks) {
    mkdirSync(join(slicesDir, "tasks", t.id), { recursive: true });
    writeFileSync(
      join(slicesDir, "tasks", t.id, `${t.id}-PLAN.md`),
      `---\nid: ${t.id}\nslice: S01\ntitle: "Task ${t.id}"\n${t.frontmatterLine ?? ""}must_haves:\n  truths:\n    - "task ${t.id} does its thing"\n  artifacts: []\n  key_links: []\n---\n\n# ${t.id}\n`,
    );
  }
}

/**
 * `.gsd/models.md` routing `executor` to the given pool refs, in order — the
 * FIRST ref is the pool head, i.e. the tier ceiling and the pre-S03 winner
 * (`auto/models-config.ts` format, same shape as authorship-routing-e2e).
 */
function writeExecutorPoolConfig(cwd: string, poolRefs: string[]): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  const refs = poolRefs.map((r) => `    - ${r}`).join("\n");
  writeFileSync(join(cwd, ".gsd", "models.md"), `pools:\n  demo:\n${refs}\n\nroles:\n  executor:\n    - demo\n`);
}

/**
 * `.gsd/CAPABILITIES.md` in the locked pipe-table format
 * (FORGE2-CAPABILITIES-FORMAT.md §2 — header + separator + one row per
 * `(domain, ref, score)` entry; refs VERBATIM, byte-identical to models.md).
 */
function writeCapabilitiesMatrix(cwd: string, rows: Array<[string, string, string]>): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  const body = rows.map(([d, m, s]) => `| ${d} | ${m} | ${s} |`).join("\n");
  writeFileSync(
    join(cwd, ".gsd", "CAPABILITIES.md"),
    `| domain | model | score |\n| --- | --- | --- |\n${body}\n`,
  );
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

/** Prepare the toy sandbox: STATE + ROADMAP + S01 with the given task specs. */
function seedSandbox(cwd: string, tasks: TaskSpec[]): void {
  updateState(cwd, () => ({ milestone: MID }) as StateDoc);
  mkdirSync(milestoneDir(cwd), { recursive: true });
  writeRoadmap(cwd);
  writeSlicePlan(cwd, tasks);
}

/** Find the `unit_dispatched` journal event for one execute-task by task id. */
function dispatchedFor(events: Array<Record<string, unknown>>, task: string): Record<string, unknown> {
  const ev = events.find((e) => e.kind === "unit_dispatched" && e.task === task);
  assert.ok(ev, `unit_dispatched for the execute-task (${task}) exists in the journal`);
  return ev;
}

/**
 * Keys scenario B sweeps for on EVERY event: D-S03-3 defers `domain` from the
 * journal entirely, so no S03-shaped key may appear anywhere (same absence
 * pattern as effort-routing-e2e's scenario D).
 */
const DOMAIN_KEYS = ["domain", "domain_reason", "capability", "capability_score"] as const;

/**
 * Two refs UNKNOWN to the static capability table (`model-capabilities.ts`):
 * both default to `{tier: standard, capability: 1, cost: 1}` — co-finalists
 * tied on everything except pool order, with a non-flat-rate head (unknown
 * provider defaults to pay-per-token), so the per-domain matrix is the ONLY
 * discriminator (S03-PLAN §Contexto).
 */
const CO_FINALIST_POOL = ["prov-a/model-x", "prov-b/model-y"];

describe("S03/T04 through-the-driver — domain no rank, byte-identidade, teto e supressão flat-rate", () => {
  test("Cenário A: `domain: backend` vs `domain: frontend` (resto idêntico) → modelos DIFERENTES do MESMO pool, matriz lida do disco", async () => {
    await withIsolatedHomeAsync(async () => {
      await withSandboxAsync(async (cwd) => {
        seedSandbox(cwd, [
          { id: "T01", frontmatterLine: "domain: backend\n" },
          { id: "T02", frontmatterLine: "domain: frontend\n" },
        ]);
        writeExecutorPoolConfig(cwd, CO_FINALIST_POOL);
        // Refs byte-identical to models.md (S02 FI: verbatim match) — backend
        // favors the NON-head ref, frontend favors the head, so the two tasks
        // MUST land on different pool members if the hint truly flows.
        writeCapabilitiesMatrix(cwd, [
          ["backend", "prov-b/model-y", "0.9"],
          ["backend", "prov-a/model-x", "0.4"],
          ["frontend", "prov-a/model-x", "0.9"],
          ["frontend", "prov-b/model-y", "0.4"],
        ]);

        const driver = fakeDriver(cwd, [{ outcome: done("t01") }, { outcome: done("t02") }, ...completionSteps()]);
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver });

        const events = readEvents(cwd);
        const t01 = dispatchedFor(events, "T01");
        const t02 = dispatchedFor(events, "T02");

        assert.equal(t01.model, "prov-b/model-y", "domain: backend → the matrix's backend favorite (non-head) wins");
        assert.equal(t02.model, "prov-a/model-x", "domain: frontend → the matrix's frontend favorite (head) wins");
        assert.notEqual(t01.model, t02.model, "two tasks identical except for domain: got DIFFERENT models");
        assert.ok(
          CO_FINALIST_POOL.includes(t01.model as string) && CO_FINALIST_POOL.includes(t02.model as string),
          "both dispatched models are members of the SAME configured pool — reorder within the pool, never outside it",
        );
      });
    });
  });

  test("Cenário B (byte-identidade): sem `domain:` e sem CAPABILITIES.md → head do pool p/ ambos E nenhuma chave nova em NENHUM evento", async () => {
    await withIsolatedHomeAsync(async () => {
      await withSandboxAsync(async (cwd) => {
        // Deliberately: plans with NO `domain:` key and NO `.gsd/CAPABILITIES.md`
        // — `domainHintForUnit` degrades to `undefined`, the seam never reads
        // the matrix (zero new I/O, D-S03-2), and the tie-break runs the exact
        // pre-S03 comparator: the pool head wins for both tasks.
        seedSandbox(cwd, [{ id: "T01" }, { id: "T02" }]);
        writeExecutorPoolConfig(cwd, CO_FINALIST_POOL);

        const driver = fakeDriver(cwd, [{ outcome: done("t01") }, { outcome: done("t02") }, ...completionSteps()]);
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver });

        const events = readEvents(cwd);
        assert.ok(events.length > 0, "the run journaled events (the absence assertion is not vacuous)");

        const t01 = dispatchedFor(events, "T01");
        const t02 = dispatchedFor(events, "T02");
        assert.equal(t01.model, "prov-a/model-x", "no domain/matrix — T01 gets the pool head, the pre-S03 rank");
        assert.equal(t02.model, "prov-a/model-x", "no domain/matrix — T02 gets the same head, nothing reorders");

        // D-S03-3: `domain` does NOT enter the journal in this slice — the
        // journal must be key-for-key identical to a pre-S03 run, proven on
        // EVERY event, not just the unit ones.
        for (const ev of events) {
          for (const key of DOMAIN_KEYS) {
            assert.equal(
              key in ev,
              false,
              `no-config byte-identity: event kind=${String(ev.kind)} must not carry "${key}"`,
            );
          }
        }
      });
    });
  });

  test("Cenário C (teto/downgrade-only): head light + matriz dando 1.0 a um ref max do mesmo pool → o head continua vencendo", async () => {
    await withIsolatedHomeAsync(async () => {
      await withSandboxAsync(async (cwd) => {
        seedSandbox(cwd, [{ id: "T01", frontmatterLine: "domain: backend\n" }]);
        // Head `openai/gpt-5-mini` is tier `light` in the static table ⇒ the
        // pool ceiling is light; `openai/gpt-5.5` (tier `max`) never reaches
        // the finalist set, so its perfect matrix score is unreachable — the
        // capability factor lives ONLY in the tie-break (D-S03-1 invariant).
        writeExecutorPoolConfig(cwd, ["openai/gpt-5-mini", "openai/gpt-5.5"]);
        writeCapabilitiesMatrix(cwd, [["backend", "openai/gpt-5.5", "1.0"]]);

        const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver });

        const t01 = dispatchedFor(readEvents(cwd), "T01");
        assert.equal(
          t01.model,
          "openai/gpt-5-mini",
          "a matrix score of 1.0 on a ref ABOVE the pool's tier ceiling does not pierce it — downgrade-only intact",
        );
      });
    });
  });

  test("Cenário D (supressão flat-rate): head claude-code (flat-rate) + matriz favorecendo outro ref → o head vence", async () => {
    await withIsolatedHomeAsync(async () => {
      await withSandboxAsync(async (cwd) => {
        seedSandbox(cwd, [{ id: "T01", frontmatterLine: "domain: backend\n" }]);
        // Head provider `claude-code` is flat-rate (`PROVIDER_FLAT_RATE`,
        // model-capabilities.ts) — the rank short-circuits to the head BEFORE
        // the tie-break, so the matrix's perfect score for `openai/gpt-5.5`
        // must change nothing (suppression runs before the factor, D-S03-1).
        writeExecutorPoolConfig(cwd, ["claude-code/claude-sonnet-5", "openai/gpt-5.5"]);
        writeCapabilitiesMatrix(cwd, [["backend", "openai/gpt-5.5", "1.0"]]);

        const driver = fakeDriver(cwd, [{ outcome: done("t01") }, ...completionSteps()]);
        const s = makeSession(cwd);
        await runForgeLoop(s, { cwd, driver });

        const t01 = dispatchedFor(readEvents(cwd), "T01");
        assert.equal(
          t01.model,
          "claude-code/claude-sonnet-5",
          "a flat-rate pool head suppresses fine-grained routing entirely — the matrix never gets to reorder",
        );
      });
    });
  });
});
