/**
 * S05/T04 demo evidence — proves, on the REAL dispatch path (`runForgeLoop`,
 * fake `SessionDriver`/`ReviewDispatcher`, no real pi session — scaffolding
 * copied verbatim from `tests/domain-routing-e2e.test.ts` and
 * `tests/review-dialectic-driver-e2e.test.ts`), the four scenarios named by
 * ROADMAP §S05's demo:
 *
 * (A) a `domain:` declared in the ROADMAP's YAML frontmatter appears in the
 *     composed `plan-slice` prompt (`composeInfoFor` → `scopeDomainFor` →
 *     `composePrompt`'s `identityBlock`, T01/T02), captured on the exact
 *     prompt string the production loop hands the driver.
 * (B) the same scope domain appears in the review gate's REAL challenger
 *     prompt (`runReviewGate` → `runReviewDialectic` → `challengerPrompt`,
 *     T03), captured via a fake `ReviewDispatcher`.
 * (C) byte-identidade: with no `domain:` declared anywhere in the scope
 *     (ROADMAP/CONTEXT/S##-CONTEXT), neither surface gains a line — a
 *     negative sweep over every captured prompt on both surfaces, plus a
 *     structural comparison proving the journaled event sequence is
 *     unchanged whether or not a scope domain is declared (D-S05-B: the
 *     scope domain never touches the rank, so it must never touch the
 *     journal either).
 * (D) precedência D-S05-A: `S##-CONTEXT.md`'s `domain:` wins over the
 *     ROADMAP's when both are declared.
 *
 * **Nota de honestidade (through-the-driver, não seam sintético):** the fake
 * driver/dispatcher never resolve or compose anything themselves — every
 * prompt asserted on here is produced by `runForgeLoop`'s own
 * `composeInfoFor`/`composePrompt` (plan-slice) or `runReviewGate`/
 * `runReviewDialectic`/`challengerPrompt` (review), which read the REAL
 * ROADMAP/CONTEXT files off the sandbox disk via `scopeDomainFor` (T01) —
 * the exact call-sites production uses.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForgeLoop, type SessionDriver } from "../auto/loop.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { updateState, readEvents } from "../state/store.ts";
import type { StateDoc, ForgeEvent } from "../state/types.ts";
import type { NextUnit } from "../state/dispatch.ts";
import type { UnitOutcome } from "../worker/rendezvous.ts";
import type { ReviewDispatchOptions, ReviewDispatcher } from "../review/dispatch.ts";

const MID = "M-scope-domain";
const SLICE = "S01";

function milestoneDir(cwd: string): string {
  return join(cwd, ".gsd", "milestones", MID);
}

function done(summary: string): UnitOutcome {
  return { kind: "result", result: { status: "done", summary, artifacts: [] } };
}

async function withSandboxAsync<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-scope-domain-e2e-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeSession(cwd: string): ForgeAutoSession {
  const s = new ForgeAutoSession();
  s.active = true;
  s.cwd = cwd;
  return s;
}

const SHA_HEX_40 = /^[0-9a-f]{40}$/;

/**
 * Root cause (S07-DIAGNOSIS.md, S07/T02): Cenário C's `deepEqual` compared two
 * INDEPENDENTLY-SEEDED git sandboxes (two separate `seedGit` calls, review
 * pair). `stampUnitSha` (loop.ts:172-182, "G1 do git") correctly stamps each
 * sandbox's real HEAD sha on every unit lifecycle event — two distinct git
 * roots can only share a sha if their commits land in the same wall-clock
 * second (git's commit-timestamp granularity), so `sha` is legitimately
 * volatile ACROSS sandboxes even though nothing about scope-domain routing
 * touched it (D-S05-B intact). The old helper only stripped `ts`, never
 * `sha`, so the ~1/3 flake was TEST over-assertion, not a product race. Fix:
 * `stripVolatile` strips `sha` too before the structural compare;
 * `assertShaStamped` proves the field was genuinely produced (shape, not
 * cross-sandbox value) so the proof doesn't silently pass if `stampUnitSha`
 * stopped firing.
 */
function stripVolatile(events: ForgeEvent[]): Array<Omit<ForgeEvent, "ts" | "sha">> {
  return events.map((e) => {
    const { ts, sha, ...rest } = e as ForgeEvent & { ts: unknown; sha?: unknown };
    return rest;
  });
}

/**
 * Proves every unit lifecycle event carries the REAL `HEAD` sha of THIS
 * sandbox's own git repo (i.e. `stampUnitSha` genuinely ran `git rev-parse
 * HEAD` against this sandbox, not a stale/hard-coded/wrong-repo value) —
 * `expectedSha` is captured by the caller straight off the same sandbox right
 * after `seedGit` (S07-REVIEW R1: shape-only checks pass even for a
 * hard-coded 40-hex sha, so the comparison must be against this sandbox's own
 * captured HEAD, never merely `SHA_HEX_40` shape).
 */
function assertShaStamped(events: ForgeEvent[], expectedSha: string, label: string): void {
  assert.match(expectedSha, SHA_HEX_40, `${label}: sanity — the sandbox's own captured HEAD sha is well-shaped`);
  const lifecycle = events.filter((e) => e.kind === "unit_dispatched" || e.kind === "unit_result" || e.kind === "unit_timeout");
  assert.ok(lifecycle.length > 0, `${label}: sanity — at least one unit lifecycle event exists to check`);
  for (const e of lifecycle) {
    const sha = (e as ForgeEvent & { sha?: unknown }).sha;
    assert.equal(sha, expectedSha, `${label}: every unit lifecycle event must carry THIS sandbox's own stamped HEAD sha (stampUnitSha, G1 do git)`);
  }
}

// ── Scenario A/C/D fixtures: a plan-slice-first sandbox (no S##-PLAN.md yet,
// so `deriveNextUnit` dispatches `plan-slice` as the FIRST unit) ───────────

/** ROADMAP with one pending slice, optional YAML frontmatter `domain:`. */
function writeRoadmap(cwd: string, roadmapDomain?: string): void {
  const fm = roadmapDomain ? `---\nmilestone: ${MID}\ndomain: ${roadmapDomain}\n---\n\n` : "";
  writeFileSync(
    join(milestoneDir(cwd), `${MID}-ROADMAP.md`),
    `${fm}# Scope domain toy\n\n## Slices\n\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| ${SLICE} | Slice única | med | — | pending |\n`,
  );
}

function seedPlanSliceSandbox(cwd: string, opts: { roadmapDomain?: string; sliceContextDomain?: string } = {}): void {
  updateState(cwd, () => ({ milestone: MID }) as StateDoc);
  mkdirSync(join(milestoneDir(cwd), "slices", SLICE), { recursive: true });
  writeRoadmap(cwd, opts.roadmapDomain);
  if (opts.sliceContextDomain) {
    writeFileSync(
      join(milestoneDir(cwd), "slices", SLICE, `${SLICE}-CONTEXT.md`),
      `---\ndomain: ${opts.sliceContextDomain}\n---\n\n# ${SLICE} context\n`,
    );
  }
}

/** Simulates what the real `plan-slice` worker writes: the slice plan + one task plan. */
function writeSlicePlanFiles(cwd: string, slice: string): void {
  const sliceDir = join(milestoneDir(cwd), "slices", slice);
  mkdirSync(join(sliceDir, "tasks", "T01"), { recursive: true });
  writeFileSync(
    join(sliceDir, `${slice}-PLAN.md`),
    `---\nid: ${slice}\nmilestone: ${MID}\ntitle: "Slice única"\n---\n\n# ${slice} plan\n`,
  );
  writeFileSync(
    join(sliceDir, "tasks", "T01", "T01-PLAN.md"),
    `---\nid: T01\nslice: ${slice}\nmust_haves:\n  truths:\n    - "task T01 does its thing"\n  artifacts: []\n  key_links: []\n---\n\n# T01\n`,
  );
}

/** Drives plan-slice → execute-task → complete-slice → complete-milestone, capturing every prompt. */
function fakeDriver(cwd: string): SessionDriver & { prompts: string[]; units: NextUnit[] } {
  const prompts: string[] = [];
  const units: NextUnit[] = [];
  return {
    prompts,
    units,
    async dispatch(unit: NextUnit, prompt: string): Promise<UnitOutcome> {
      prompts.push(prompt);
      units.push(unit);
      if (unit.type === "plan-slice") {
        writeSlicePlanFiles(cwd, unit.slice);
      } else if (unit.type === "complete-slice") {
        writeFileSync(join(milestoneDir(cwd), "slices", unit.slice, `${unit.slice}-SUMMARY.md`), `# ${unit.slice} summary\n`);
      } else if (unit.type === "complete-milestone") {
        writeFileSync(join(milestoneDir(cwd), `${MID}-SUMMARY.md`), `# ${MID} summary\n`);
      }
      return done(`${unit.type} done`);
    },
  };
}

async function runPlanSliceFlow(
  opts: { roadmapDomain?: string; sliceContextDomain?: string } = {},
): Promise<{ prompts: string[]; units: NextUnit[]; events: ForgeEvent[] }> {
  return withSandboxAsync(async (cwd) => {
    seedPlanSliceSandbox(cwd, opts);
    const driver = fakeDriver(cwd);
    const s = makeSession(cwd);
    await runForgeLoop(s, { cwd, driver });
    return { prompts: driver.prompts, units: driver.units, events: readEvents(cwd) };
  });
}

// ── Scenario B/C fixtures: a review-gate sandbox (task already planned+done,
// so the NEXT unit is `complete-slice` and the per-slice review gate fires
// right before it — same shape as `review-dialectic-driver-e2e.test.ts`) ──

function seedGit(cwd: string): void {
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Forge Test"]);
  writeFileSync(join(cwd, "baseline.txt"), "baseline\n");
  execFileSync("git", ["-C", cwd, "add", "baseline.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "baseline"]);
}

function writeReviewFixtures(cwd: string, opts: { roadmapDomain?: string; sliceContextDomain?: string } = {}): void {
  const md = milestoneDir(cwd);
  mkdirSync(join(md, "slices", SLICE, "tasks", "T01"), { recursive: true });
  writeRoadmap(cwd, opts.roadmapDomain);
  if (opts.sliceContextDomain) {
    writeFileSync(
      join(md, "slices", SLICE, `${SLICE}-CONTEXT.md`),
      `---\ndomain: ${opts.sliceContextDomain}\n---\n\n# ${SLICE} context\n`,
    );
  }
  writeFileSync(join(md, "slices", SLICE, `${SLICE}-PLAN.md`), `---\nid: ${SLICE}\ntitle: Review slice\n---\n# ${SLICE}\n`);
  writeFileSync(
    join(md, "slices", SLICE, "tasks", "T01", "T01-PLAN.md"),
    "---\nid: T01\nslice: S01\ntier: standard\nmust_haves:\n  truths:\n    - task executes\n  artifacts: []\n  key_links: []\n---\n# T01\n",
  );
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    [
      "pools:",
      "  claude:",
      "    - claude-code/claude-opus-4-8",
      "  gpt:",
      "    - openai/gpt-5.5",
      "",
      "roles:",
      "  executor: [claude]",
      "  completer: [claude]",
      "  reviewer: [gpt, claude]",
      "  advocate: [claude, gpt]",
      "",
      "constraints:",
      "  reviewer_not_author: family",
      "  on_missing_pool: degrade+warn",
      "",
    ].join("\n"),
  );
  writeFileSync(join(cwd, ".gsd", "prefs.md"), "review:\n  mode: enabled\n  rounds: 1\n  ask_in_auto: defer\n");
  writeFileSync(join(cwd, "baseline.txt"), "fixture change\n");
}

/** Records every prompt handed to the review dispatcher — the challenger turn is always the FIRST call. */
class ScriptedReviewDispatcher implements ReviewDispatcher {
  readonly prompts: string[] = [];
  readonly calls: ReviewDispatchOptions[] = [];
  async dispatch(prompt: string, opts: ReviewDispatchOptions): Promise<string> {
    this.prompts.push(prompt);
    this.calls.push(opts);
    if (prompt.includes("DEFENSE:")) return "### Rebuttal\n- R1: conceded — carried through\n";
    if (prompt.includes("OBJECTIONS:")) return "### Defense\n- R1: conceded — real issue\n";
    return "### High\n- R1 `src/example.ts:10` — unsafe claim — suggested fix: validate input — challenge: can this fail?\n";
  }
}

function makeReviewDriver(cwd: string): SessionDriver & { units: NextUnit[] } {
  const units: NextUnit[] = [];
  return {
    units,
    async dispatch(unit) {
      units.push(unit);
      if (unit.type === "complete-slice") {
        writeFileSync(join(milestoneDir(cwd), "slices", SLICE, `${SLICE}-SUMMARY.md`), "# S01 summary\n");
      } else if (unit.type === "complete-milestone") {
        writeFileSync(join(milestoneDir(cwd), `${MID}-SUMMARY.md`), "# milestone summary\n");
      }
      return done(`${unit.type} done`);
    },
  };
}

async function runReviewFlow(
  opts: { roadmapDomain?: string; sliceContextDomain?: string } = {},
): Promise<{ reviewPrompts: string[]; events: ForgeEvent[]; headSha: string }> {
  return withSandboxAsync(async (cwd) => {
    mkdirSync(join(cwd, ".gsd"), { recursive: true });
    updateState(cwd, () => ({ milestone: MID }) as StateDoc);
    seedGit(cwd);
    // Captured straight off this sandbox's own repo, right after seedGit's single
    // "baseline" commit — writeReviewFixtures below never commits again, so this
    // stays HEAD for the whole flow (S07-REVIEW R1: proves stampUnitSha stamped
    // THIS sandbox's real sha, not merely a well-shaped one).
    const headSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeReviewFixtures(cwd, opts);
    const s = makeSession(cwd);
    s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;
    const review = new ScriptedReviewDispatcher();
    const driver = makeReviewDriver(cwd);
    await runForgeLoop(s, { cwd, driver, reviewDispatcher: review, interactive: false });
    return { reviewPrompts: review.prompts, events: readEvents(cwd), headSha };
  });
}

const IDENTITY_DOMAIN_LINE = /^- Domain \(larger scope\): `([^`]+)`/m;
const REVIEW_DOMAIN_LINE = /^DOMAIN: ([^\s(]+) \(larger-scope context/m;

describe("S05/T04 through-the-driver — scope domain nos prompts de plan-slice e do reviewer, byte-identidade, precedência", () => {
  test("Cenário A: ROADMAP `domain: backend` → dispatch real de plan-slice compõe o prompt com a linha de scope domain", async () => {
    const { prompts, units } = await runPlanSliceFlow({ roadmapDomain: "backend" });

    assert.equal(units[0]?.type, "plan-slice", "the first unit dispatched is plan-slice — no S01-PLAN.md exists yet");
    const planSlicePrompt = prompts[0] ?? "";
    assert.match(
      planSlicePrompt,
      /^- Domain \(larger scope\): `backend` — informs your judgement; per-task `domain:` frontmatter is what routes\.$/m,
      "the composed plan-slice prompt carries the exact scope domain identity line with the ROADMAP's value",
    );
  });

  test("Cenário B: review gate real (dispatcher fake) → challenger prompt carrega DOMAIN: quando o escopo declara domain", async () => {
    const { reviewPrompts } = await runReviewFlow({ roadmapDomain: "backend" });

    assert.ok(reviewPrompts.length >= 1, "the review dispatcher was actually invoked through the production review gate");
    const challengerPrompt = reviewPrompts[0] ?? "";
    assert.doesNotMatch(challengerPrompt, /OBJECTIONS:|DEFENSE:/, "the first captured prompt is the challenger turn, not advocate/rebuttal");
    assert.match(
      challengerPrompt,
      /^DOMAIN: backend \(larger-scope context — pick review lenses accordingly\)$/m,
      "the challenger prompt carries the DOMAIN: line with the scope domain value",
    );
  });

  test("Cenário C (byte-identidade): sem `domain:` em lugar nenhum → nenhuma linha de scope-domain nos prompts, e o fluxo do loop é idêntico", async () => {
    // Plan-slice surface: control (domain declared) vs subject (nothing declared).
    const control = await runPlanSliceFlow({ roadmapDomain: "backend" });
    const subject = await runPlanSliceFlow({});

    assert.match(control.prompts[0] ?? "", IDENTITY_DOMAIN_LINE, "sanity: the control run's negative-absence check below is not vacuous");
    for (const p of subject.prompts) {
      assert.doesNotMatch(p, IDENTITY_DOMAIN_LINE, "no scope-domain identity line appears anywhere when nothing declares a domain");
    }
    assert.deepEqual(
      stripVolatile(subject.events),
      stripVolatile(control.events),
      "the journaled event sequence (kind/unit/model/family/…) is byte-identical whether or not a scope domain is declared — D-S05-B: scope domain never touches the rank or the journal (sha excluded: real per-sandbox git HEAD, asserted separately by shape, never by cross-sandbox value — S07-DIAGNOSIS.md)",
    );

    // Review surface: same control/subject pairing over the challenger prompt.
    const controlReview = await runReviewFlow({ roadmapDomain: "backend" });
    const subjectReview = await runReviewFlow({});

    assert.match(controlReview.reviewPrompts[0] ?? "", REVIEW_DOMAIN_LINE, "sanity: the control review run's negative-absence check below is not vacuous");
    for (const p of subjectReview.reviewPrompts) {
      assert.doesNotMatch(p, REVIEW_DOMAIN_LINE, "no DOMAIN: line appears in any reviewer prompt when nothing declares a domain");
    }
    assertShaStamped(controlReview.events, controlReview.headSha, "control review");
    assertShaStamped(subjectReview.events, subjectReview.headSha, "subject review");
    assert.deepEqual(
      stripVolatile(subjectReview.events),
      stripVolatile(controlReview.events),
      "the review flow's journaled event sequence is byte-identical whether or not a scope domain is declared (sha excluded: real per-sandbox git HEAD, proven stamped above by shape, never compared by cross-sandbox value — S07-DIAGNOSIS.md)",
    );
  });

  test("Cenário D (precedência D-S05-A): S01-CONTEXT `domain: frontend` + ROADMAP `domain: backend` → o prompt carrega frontend", async () => {
    const { prompts } = await runPlanSliceFlow({ roadmapDomain: "backend", sliceContextDomain: "frontend" });

    const planSlicePrompt = prompts[0] ?? "";
    assert.match(
      planSlicePrompt,
      /^- Domain \(larger scope\): `frontend` —/m,
      "the slice-level S01-CONTEXT.md's domain wins over the milestone ROADMAP's, per D-S05-A precedence",
    );
    assert.doesNotMatch(planSlicePrompt, /`backend`/, "the ROADMAP's losing value never surfaces in the composed prompt");
  });
});
