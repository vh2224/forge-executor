import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runReviewDialectic, computeReviewDiffCmd, type ReviewDispatcher } from "../review/dispatch.js";
import { challengerPrompt, advocatePrompt, rebuttalPrompt, renderObjectionsText, renderDefenseText } from "../review/prompts.js";
import { parseObjections, parseVerdicts } from "../review/parse.js";
import type { ResolveModelCtx } from "../auto/role.js";
import { appendEvent } from "../state/store.js";
import type { ForgeEvent } from "../state/types.js";

function sandbox(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-review-"));
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
  writeFileSync(join(cwd, "changed.ts"), "export const changed = true;\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  writeFileSync(join(cwd, "changed.ts"), "export const changed = false;\n");
  return cwd;
}

function context(cwd: string): ResolveModelCtx {
  return {
    session: { cwd } as ResolveModelCtx["session"],
    config: {
      pools: { claude: ["claude/sonnet"], gpt: ["openai/gpt-5"] },
      roles: { reviewer: ["gpt"], advocate: ["claude"] },
      constraints: { reviewer_not_author: "family", on_missing_pool: "block" },
    },
  };
}

const challenge = "### High\n- R1 `src/a.ts:4` — bug — suggested fix: guard it — challenge: is this safe?\n- R2 `src/b.ts:8` — risk — suggested fix: validate — challenge: can this fail?";
const defense = "R1: conceded — yes, this is a bug\nR2: refuted — the caller guarantees it";
const rebuttal = "R1: conceded — carried through\nR2: withdrawn — guarantee is sufficient";

function dispatcher(...answers: Array<string | null>): { dispatcher: ReviewDispatcher; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    dispatcher: {
      async dispatch(prompt, opts) {
        calls.push(`${opts.provider}:${prompt.slice(0, 20)}`);
        return answers.shift() ?? null;
      },
    },
  };
}

/** Same seam as {@link dispatcher} but captures full prompt text for the S05/T03 domain assertions. */
function promptCapturingDispatcher(...answers: Array<string | null>): { dispatcher: ReviewDispatcher; prompts: string[]; providers: (string | null)[] } {
  const prompts: string[] = [];
  const providers: (string | null)[] = [];
  return {
    prompts,
    providers,
    dispatcher: {
      async dispatch(prompt, opts) {
        prompts.push(prompt);
        providers.push(opts.provider);
        return answers.shift() ?? null;
      },
    },
  };
}

function params(cwd: string, d: ReviewDispatcher, rounds: 0 | 1 = 1) {
  return {
    cwd, milestoneId: "M-test", slice: "S03", sliceTitle: "Review", unit: { type: "execute-task", slice: "S03", task: "T01" } as const,
    ctxForResolve: context(cwd), dispatcher: d, reviewedOn: "2026-07-11", rounds, authorFamily: "claude",
  };
}

function head(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** S03/T01 synthetic journal event — `task`/`kind`/`sha` are the only fields these tests vary. */
function taskEvent(overrides: Partial<ForgeEvent> & { kind: string }): ForgeEvent {
  return {
    ts: "2026-07-12T00:00:00.000Z",
    unit: "task-plan",
    agent: "forge-command",
    milestone: "",
    status: "dispatched",
    summary: "synthetic",
    ...overrides,
  };
}

test("NO_FLAGS writes a clean artifact and never dispatches advocate", async () => {
  const cwd = sandbox();
  const fake = dispatcher("NO_FLAGS");
  const result = await runReviewDialectic(params(cwd, fake.dispatcher));
  assert.equal(fake.calls.length, 1);
  assert.equal(result.result.noFlags, true);
  assert.match(readFileSync(join(cwd, ".gsd/milestones/M-test/slices/S03/S03-REVIEW.md"), "utf8"), /Reviewer found nothing/);
});

test("full dialectic casts reviewer cross-family and resolves counts", async () => {
  const cwd = sandbox();
  const fake = dispatcher(challenge, defense, rebuttal);
  const result = await runReviewDialectic(params(cwd, fake.dispatcher));
  assert.equal(fake.calls.length, 3);
  assert.match(fake.calls[0], /openai/);
  assert.match(fake.calls[1], /claude/);
  assert.match(fake.calls[2], /openai/);
  assert.deepEqual(result.result.counts, { resolved: 1, conceded: 1, open: 0 });
  assert.equal(result.challengerFamily, "gpt");
});

test("challenger failure is stubbed and does not escape", async () => {
  const cwd = sandbox();
  const fake = dispatcher(null);
  const result = await runReviewDialectic(params(cwd, fake.dispatcher));
  assert.equal(fake.calls.length, 1);
  assert.equal(result.result.noFlags, true);
  assert.match(readFileSync(join(cwd, ".gsd/milestones/M-test/slices/S03/S03-REVIEW.md"), "utf8"), /could not run/);
});

test("rounds zero skips rebuttal and defaults objections to maintained", async () => {
  const cwd = sandbox();
  const fake = dispatcher(challenge, defense);
  const result = await runReviewDialectic(params(cwd, fake.dispatcher, 0));
  assert.equal(fake.calls.length, 2);
  assert.equal(result.result.counts.conceded, 1);
  assert.equal(result.result.counts.open, 1);
});

test("empty diff produces an artifact without dispatch", async () => {
  const cwd = sandbox();
  const fake = dispatcher(challenge, defense, rebuttal);
  execFileSync("git", ["-C", cwd, "checkout", "--", "changed.ts"]);
  const result = await runReviewDialectic(params(cwd, fake.dispatcher));
  assert.equal(fake.calls.length, 0);
  assert.match(readFileSync(join(cwd, ".gsd/milestones/M-test/slices/S03/S03-REVIEW.md"), "utf8"), /sem diff para revisar/);
  assert.equal(result.result.noFlags, true);
});

test("artifactTarget redirects the same dialectic writer", async () => {
  const cwd = sandbox();
  const target = join(cwd, "docs", "forge", "target-REVIEW-gpt.md");
  const fake = dispatcher("NO_FLAGS");
  await runReviewDialectic({ ...params(cwd, fake.dispatcher), artifactTarget: { writePath: target } });
  assert.match(readFileSync(target, "utf8"), /Reviewed:\*\* 2026-07-11/);
});

test("S05/T03: domain threads a DOMAIN line into all 3 dialectic prompts", async () => {
  const cwd = sandbox();
  const fake = promptCapturingDispatcher(challenge, defense, rebuttal);
  await runReviewDialectic({ ...params(cwd, fake.dispatcher), domain: "infra" });
  assert.equal(fake.prompts.length, 3);
  for (const prompt of fake.prompts) {
    assert.match(prompt, /\nDOMAIN: infra \(larger-scope context — pick review lenses accordingly\)\nDIFF_CMD:/);
  }
});

test("S05/T03: without domain, prompts are byte-identical to direct builder calls", async () => {
  const cwd = sandbox();
  const fake = promptCapturingDispatcher(challenge, defense, rebuttal);
  await runReviewDialectic(params(cwd, fake.dispatcher));
  assert.equal(fake.prompts.length, 3);

  const diffCmd = computeReviewDiffCmd(cwd, { milestoneId: "M-test", slice: "S03" });
  const unit = "S03/execute-task";
  const objections = parseObjections(challenge).objections;
  const defenseVerdicts = parseVerdicts(defense, ["refuted", "conceded", "open"] as const).verdicts;

  assert.equal(fake.prompts[0], challengerPrompt({ workingDir: cwd, unit, diffCmd }));
  assert.equal(
    fake.prompts[1],
    advocatePrompt({ workingDir: cwd, unit, diffCmd, objectionsText: renderObjectionsText(objections) }),
  );
  assert.equal(
    fake.prompts[2],
    rebuttalPrompt({
      workingDir: cwd,
      unit,
      diffCmd,
      objectionsText: renderObjectionsText(objections),
      defenseText: renderDefenseText(defenseVerdicts),
    }),
  );
  for (const prompt of fake.prompts) assert.ok(!prompt.includes("DOMAIN:"));
});

test("S05/T03: domain never influences reviewer model resolution", async () => {
  const cwd = sandbox();
  const withoutDomain = promptCapturingDispatcher(challenge, defense, rebuttal);
  const baseline = await runReviewDialectic(params(cwd, withoutDomain.dispatcher));

  const withDomain = promptCapturingDispatcher(challenge, defense, rebuttal);
  const withDomainResult = await runReviewDialectic({ ...params(cwd, withDomain.dispatcher), domain: "infra" });

  assert.equal(withDomainResult.challengerFamily, baseline.challengerFamily);
  assert.deepEqual(withDomain.providers, withoutDomain.providers);
});

test("S03/T01: taskId scope returns first task_dispatched..last task_result sha, ignoring foreign tasks/kinds and milestone equality", () => {
  const cwd = sandbox();
  const shaBefore = head(cwd);
  appendEvent(cwd, taskEvent({ kind: "task_dispatched", task: "T-1", sha: shaBefore, milestone: "" }));
  // Foreign task and wrong kinds — must never influence the T-1 range.
  appendEvent(cwd, taskEvent({ kind: "task_dispatched", task: "T-999", sha: "deadbeef" }));
  appendEvent(cwd, taskEvent({ kind: "unit_dispatched", task: "T-1", sha: "deadbeef" }));

  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "task change"]);
  const shaAfter = head(cwd);
  appendEvent(cwd, taskEvent({ kind: "task_result", task: "T-1", sha: shaAfter, milestone: "" }));
  appendEvent(cwd, taskEvent({ kind: "task_result", task: "T-999", sha: "deadbeef" }));
  appendEvent(cwd, taskEvent({ kind: "unit_result", task: "T-1", sha: "deadbeef" }));

  // milestoneId does NOT match the task events' `milestone: ""` — proves the
  // taskId matcher ignores milestone equality entirely.
  const diffCmd = computeReviewDiffCmd(cwd, { milestoneId: "M-nonexistent-mismatch", taskId: "T-1" });
  assert.equal(diffCmd, `git diff ${shaBefore}..${shaAfter}`);
});

test("S03/T01: taskId scope with no matching events falls back to the same branch heuristic as the no-taskId scope", () => {
  const cwd = sandbox();
  const withTask = computeReviewDiffCmd(cwd, { milestoneId: "M-test", taskId: "T-nonexistent" });
  const withoutTask = computeReviewDiffCmd(cwd, { milestoneId: "M-test" });
  assert.equal(withTask, withoutTask);
});

test("S03/T01 regression: milestone/slice scope sha range (unit_dispatched/unit_result) is unchanged by the taskId refactor", () => {
  const cwd = sandbox();
  const shaBefore = head(cwd);
  appendEvent(cwd, taskEvent({ kind: "unit_dispatched", milestone: "M-test", slice: "S03", sha: shaBefore }));
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "unit change"]);
  const shaAfter = head(cwd);
  appendEvent(cwd, taskEvent({ kind: "unit_result", milestone: "M-test", slice: "S03", sha: shaAfter }));

  const diffCmd = computeReviewDiffCmd(cwd, { milestoneId: "M-test", slice: "S03" });
  assert.equal(diffCmd, `git diff ${shaBefore}..${shaAfter}`);

  const diffCmdExplicitNoTask = computeReviewDiffCmd(cwd, { milestoneId: "M-test", slice: "S03", taskId: undefined });
  assert.equal(diffCmdExplicitNoTask, diffCmd, "an absent taskId is byte-identical to no taskId field at all");
});

test("S03/T01: runReviewDialectic threads taskId into the task-scoped diff command", async () => {
  const cwd = sandbox();
  const shaBefore = head(cwd);
  appendEvent(cwd, taskEvent({ kind: "task_dispatched", unit: "task-execute", task: "T-loose-1", sha: shaBefore }));
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "task change"]);
  const shaAfter = head(cwd);
  appendEvent(cwd, taskEvent({ kind: "task_result", unit: "task-execute", task: "T-loose-1", sha: shaAfter }));

  const fake = promptCapturingDispatcher("NO_FLAGS");
  await runReviewDialectic({ ...params(cwd, fake.dispatcher), taskId: "T-loose-1" });

  assert.equal(fake.prompts.length, 1, "the challenger ran — the task range diff is non-empty");
  assert.match(fake.prompts[0]!, new RegExp(`DIFF_CMD: git diff ${shaBefore}\\.\\.${shaAfter}`));
});
