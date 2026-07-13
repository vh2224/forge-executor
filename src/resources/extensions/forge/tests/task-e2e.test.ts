/**
 * S02/T04 — through-the-driver e2e for `/forge task "<descrição>"` (ROADMAP
 * §S02 demo). Same seam family as `research-models-e2e.test.ts`/
 * `authorship-routing-e2e.test.ts`: only `ExtensionCommandContext.newSession`/
 * `withSession`/`sendMessage` is a fake, worker-compliant stand-in — the rest
 * of the spine (`resolveDispatchAuthor` → `composePrompt` →
 * `dispatchUnitViaNewSession`, both phases) is the REAL production code in
 * `commands/task-command.ts`. This is the CODING-STANDARDS §through-the-driver
 * referent for S02's production claims — `task-command.test.ts` already
 * exercises the same spine at the unit-test grain (T02/T03); this file is the
 * dedicated e2e proof of the PRODUCT end to end.
 *
 * Three scenarios (S02/T04):
 *
 * (A) Happy path — a `.gsd/models.md` config routes `planner` and `executor`
 *     to two DISTINCT model pools (mirrors `authorship-routing-e2e.test.ts`'s
 *     technique for proving role×pool resolution on the real journal, not a
 *     synthetic seam). Asserts: store + TASK.md created, task-plan dispatched
 *     under the resolved planner-pool author, task-execute dispatched under
 *     the resolved executor-pool author, both `task_dispatched`/`task_result`
 *     pairs journaled with the correct per-phase authorship, ZERO
 *     `unit_dispatched`/`unit_result` events anywhere in the journal, and a
 *     pre-seeded ACTIVE-milestone `.gsd/STATE.md` left byte-identical — the
 *     loose task never feeds milestone state.
 *
 * (B) Failure path — the task-plan worker never delivers a
 *     `forge_unit_result` (a short `FORGE_UNIT_TIMEOUT_MS` ceiling, same
 *     technique as `loop.test.ts`'s "a worker that never delivers resolves as
 *     a timeout" case). Asserts: task-execute is NEVER dispatched, and the
 *     journal carries a `task_result` for `task-plan` with `status:
 *     "timeout"` — no second phase, no silent hang.
 *
 * (C) Advisory-warn case (D-S04-1, cheap) — the task-plan worker writes
 *     `<TASK_ID>-PLAN.md` WITHOUT `domain:`/`effort:` frontmatter. Asserts:
 *     the advisory warning notify fires AND task-execute still dispatches —
 *     the S01 frontmatter-compliance check never blocks, captured end to end
 *     through the real command rather than only at `checkTaskPlanFrontmatterAdvisory`'s
 *     own unit grain.
 *
 * Two more scenarios (S03/T06 — cockpit-v2's through-the-driver referent for
 * the whole slice: task→review→fix→status):
 *
 * (D) Review chain — the SAME `runTaskCommand` spine as (A), but the fake
 *     `task-execute` handler makes a REAL git commit before delivering `done`,
 *     and a fake `ReviewDispatcher` (distinguished by prompt content —
 *     challenger/advocate/rebuttal) returns canned text carrying one real
 *     objection. Asserts: `<TASK_ID>-REVIEW.md` lands in the store with the
 *     objection (a real dialectic render, never a stub); `task_dispatched`/
 *     `task_result` carry `task`+`sha`; the range implied by the FIRST
 *     dispatched sha and the LAST result sha equals the pre-execute HEAD and
 *     the real execute commit (S03/T01's journaled range); every dialectic
 *     phase's prompt inlines that exact `git diff <base>..<end>` command;
 *     `.gsd/STATE.md` (pre-seeded ACTIVE milestone) stays byte-identical;
 *     zero `unit_dispatched`/`unit_result`; `/forge status` lists the task at
 *     the `revisada` stage.
 *
 * (E) Fix — `/forge fix T-<id>` against a hand-built task REVIEW.md (one open
 *     item, same shape (D) would have produced) dispatches through
 *     `runFixCommand`'s task branch. Asserts: exactly one dispatch; the
 *     prompt carries `.gsd/tasks/<id>/` paths and the item's verbatim
 *     dialogue; the worker's `R1: corrigida (commit <real sha>)` decision
 *     flips the REVIEW.md marker; `review_fix_dispatched`/`review_fix_result`
 *     carry `task`; `.gsd/STATE.md` is ABSENT before AND after (loose-task
 *     fix is repo-level, S03-PLAN Interpretation Decision 4); zero
 *     `unit_dispatched`/`unit_result`; `/forge status` lists the task at the
 *     `revisada` stage.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { runTaskCommand } from "../commands/task-command.ts";
import { runFixCommand } from "../commands/fix-command.ts";
import { formatStatus } from "../commands/forge-command.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";
import { familyOf } from "../state/family.ts";
import { renderReview } from "../review/artifact.ts";
import type { ReviewDispatcher } from "../review/dispatch.ts";
import type { ResolveReviewResult, ResolvedReviewItem } from "../review/resolve.ts";

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function listTaskDirs(cwd: string): string[] {
  const tasksDir = join(cwd, ".gsd", "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir);
}

/** The lone task dir minted by `runTaskCommand` in these single-invocation tests. */
function soleTaskId(cwd: string): string {
  const dirs = listTaskDirs(cwd);
  if (dirs.length !== 1) throw new Error(`expected exactly one task dir, found ${dirs.length}`);
  return dirs[0]!;
}

function planPath(cwd: string, taskId: string): string {
  return join(cwd, ".gsd", "tasks", taskId, `${taskId}-PLAN.md`);
}

function summaryPath(cwd: string, taskId: string): string {
  return join(cwd, ".gsd", "tasks", taskId, `${taskId}-SUMMARY.md`);
}

/**
 * A well-formed PLAN.md — valid `domain:`/`effort:` frontmatter, no advisory
 * warning should fire, and >10 non-blank lines (R3's `verifyTaskPlan` floor).
 */
function writeCompliantPlan(cwd: string, taskId: string): void {
  writeFileSync(
    planPath(cwd, taskId),
    [
      "---",
      "domain: infra",
      "effort: low",
      "---",
      "",
      "# Plan",
      "",
      "## Goal",
      "",
      "Fix the thing.",
      "",
      "## Steps",
      "",
      "1. Do the fix.",
      "2. Verify it.",
      "3. Run tests.",
      "",
    ].join("\n"),
  );
}

/** A substantive SUMMARY.md — well over the 10-line floor. */
function writeSubstantiveSummary(cwd: string, taskId: string): void {
  const lines = ["---", "id: T-fake", "---", "", "Executed by: fake", "", "## What Happened", ""];
  for (let i = 0; i < 10; i++) lines.push(`- detail line ${i}`);
  writeFileSync(summaryPath(cwd, taskId), lines.join("\n"));
}

/**
 * `.gsd/models.md` routing `planner` and `executor` to two DISTINCT pools —
 * proves the journaled authorship is the ROLE-resolved model, not a session
 * baseline or a single shared pool (same technique as
 * `authorship-routing-e2e.test.ts`'s `writeExecutorRoutesToGptConfig`).
 */
const PLANNER_MODEL = "openai/gpt-5.5";
const EXECUTOR_MODEL = "anthropic/claude-haiku-4-5";

function writeRolePoolConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    [
      "pools:",
      "  planner-pool:",
      `    - ${PLANNER_MODEL}`,
      "  executor-pool:",
      `    - ${EXECUTOR_MODEL}`,
      "",
      "roles:",
      "  planner:",
      "    - planner-pool",
      "  executor:",
      "    - executor-pool",
      "",
    ].join("\n"),
  );
}

/**
 * A fake command context whose `newSession` runs `onSendMessage`
 * synchronously — no real pi session involved. RECURSIVE: the driver's B3
 * stale-handle rule re-points `session.cmdCtx` at the `withSession`
 * callback's fresh context after every dispatch, so a SECOND phase's
 * `dispatchUnitViaNewSession` call reads that fresh context as its own
 * `cmdCtx` — it must expose the same `newSession`/`sendMessage`/`abort` shape,
 * or a chained second dispatch (`task-execute` after `task-plan`) throws
 * internally and silently resolves `blocked` instead of ever reaching
 * `onSendMessage` a second time (same fixture as `task-command.test.ts`'s
 * T03 addition — this file duplicates it locally rather than importing from a
 * sibling test file, per the e2e's independence from the unit-test grain).
 */
function fakeCtx(
  cwd: string,
  onSendMessage: (content: string) => void,
): { ctx: ExtensionCommandContext; notifications: Array<[string, string]> } {
  const notifications: Array<[string, string]> = [];
  function makeSessionLike(): unknown {
    return {
      cwd,
      hasUI: true,
      ui: {
        notify: (message: string, level: string) => {
          notifications.push([message, level]);
        },
      },
      model: undefined,
      abort() {},
      async sendMessage(msg: { content: string }): Promise<void> {
        onSendMessage(msg.content);
      },
      async newSession(opts: { withSession: (fresh: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
        const freshCtx = makeSessionLike();
        await opts.withSession(freshCtx);
        return { cancelled: false };
      },
    };
  }
  const ctx = makeSessionLike() as ExtensionCommandContext;
  return { ctx, notifications };
}

/**
 * S03/T02 — minimal `roles.reviewer`/`roles.advocate` config so
 * `resolveModelForRole` (called internally by `runReviewDialectic`) resolves a
 * non-null model in this fake-driver harness — duplicated locally from
 * `task-command.test.ts`'s fixture of the same name, per this file's own
 * convention of independence from the unit-test grain.
 */
const reviewModelsConfig = {
  pools: { main: ["claude-code/claude-opus-4-8"] },
  roles: { reviewer: ["main"], advocate: ["main"] },
  constraints: {},
};

/**
 * git repo with one tracked, committed file; returns the seed commit's HEAD
 * sha. Duplicated locally from `task-command.test.ts`'s `initTrackedGitRepo`/
 * `review-fix-e2e.test.ts`'s `initGitRepoWithCommit` — same shape, this
 * file's own copy.
 */
function initTrackedGitRepo(cwd: string): string {
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
  writeFileSync(join(cwd, "tracked.txt"), "seed\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "seed"]);
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** A resolved review item with sensible defaults — same shape as `review-fix-e2e.test.ts`'s local `item()` helper. */
function taskReviewItem(
  id: string,
  resolution: ResolvedReviewItem["resolution"],
  over: Partial<ResolvedReviewItem> = {},
): ResolvedReviewItem {
  return {
    id,
    pathLine: `src/${id}.ts:10`,
    severity: "high",
    claim: `claim ${id}`,
    suggestedFix: `fix ${id}`,
    challenge: `challenge ${id}?`,
    defense: { verdict: "refuted", rationale: `defense ${id}` },
    rebuttal: { verdict: "maintained", rationale: `rebuttal ${id}` },
    resolution,
    ...over,
  };
}

function taskReviewResult(items: ResolvedReviewItem[]): ResolveReviewResult {
  const counts = { resolved: 0, conceded: 0, open: 0 };
  for (const i of items) counts[i.resolution]++;
  return { noFlags: items.length === 0, items, counts, warnings: [] };
}

/** Hand-builds `.gsd/tasks/<taskId>/<taskId>-REVIEW.md` with one still-open R1 item — the fixture (E) dispatches a fix against. */
function seedTaskReview(cwd: string, taskId: string): void {
  const md = renderReview(
    { milestoneId: "", slice: taskId, sliceTitle: "fix e2e da task", reviewedOn: "2026-07-12", rounds: 1 },
    taskReviewResult([taskReviewItem("R1", "open")]),
  );
  const dir = join(cwd, ".gsd", "tasks", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}-REVIEW.md`), md, "utf-8");
}

/**
 * Pins `ids.format` to `timestamp` via `.gsd/prefs.local.md` — the highest-
 * precedence layer in the `readForgePrefs` cascade (S02-REVIEW R5) — so every
 * `T-<14-digit>` assertion in this file is isolated from a runner's home-level
 * `ids: sequential` pref instead of depending on the ambient environment.
 */
function seedTimestampIdPref(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(join(cwd, ".gsd", "prefs.local.md"), "ids: timestamp\n");
}

describe("S02/T04 — /forge task e2e (through-the-driver)", () => {
  test("(A) happy path: store + TASK.md, plan→planner and execute→executor authorship journaled, zero unit_* events, STATE.md byte-identical", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-e2e-happy-"));
    seedTimestampIdPref(cwd);
    try {
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      const statePath = join(cwd, ".gsd", "STATE.md");
      writeFileSync(statePath, "milestone: M-active-preexisting\nphase: execute\n");
      const stateBefore = readFileSync(statePath);

      writeRolePoolConfig(cwd);

      const session = new ForgeAutoSession();
      const capturedPrompts: string[] = [];
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        capturedPrompts.push(content);
        const taskId = soleTaskId(cwd);
        if (content.includes("# Unit: task-plan")) {
          writeCompliantPlan(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "plano escrito", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        } else if (content.includes("# Unit: task-execute")) {
          writeSubstantiveSummary(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "task executada", artifacts: ["src/foo.ts"] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      await assert.doesNotReject(runTaskCommand(ctx, ["migrar", "parser", "de", "datas"], session));

      // Store + ID format.
      const taskDirs = listTaskDirs(cwd);
      assert.equal(taskDirs.length, 1, "exactly one task store was created");
      const taskId = taskDirs[0]!;
      assert.match(taskId, /^T-\d{14}(-[a-z0-9-]+)?$/);

      const taskMdPath = join(cwd, ".gsd", "tasks", taskId, `${taskId}-TASK.md`);
      assert.ok(existsSync(taskMdPath), "TASK.md was written");
      assert.match(readFileSync(taskMdPath, "utf8"), /migrar parser de datas/);

      // Both phases actually dispatched, in order, through the real driver.
      assert.equal(capturedPrompts.length, 2, "both phases dispatched exactly once each");
      assert.match(capturedPrompts[0]!, /# Unit: task-plan/);
      assert.match(capturedPrompts[1]!, /# Unit: task-execute/);

      // Both artifacts landed on disk (written by the fake workers, verified
      // by the command's own PLAN.md gate / SUMMARY.md check).
      assert.ok(existsSync(planPath(cwd, taskId)), "PLAN.md landed on disk");
      assert.ok(existsSync(summaryPath(cwd, taskId)), "SUMMARY.md landed on disk");

      // Journal: task_dispatched/task_result pairs for BOTH phases, in order,
      // each carrying the ROLE-resolved authorship (not a shared/baseline model).
      const events = readEvents(cwd);
      const relevant = events.filter((e) => e.kind === "task_dispatched" || e.kind === "task_result");
      assert.deepEqual(
        relevant.map((e) => [e.kind, e.unit]),
        [
          ["task_dispatched", "task-plan"],
          ["task_result", "task-plan"],
          ["task_dispatched", "task-execute"],
          ["task_result", "task-execute"],
        ],
        "all 4 events appear, in order",
      );

      const planDispatched = events.find((e) => e.kind === "task_dispatched" && e.unit === "task-plan");
      assert.ok(planDispatched, "task-plan dispatch journaled");
      assert.equal(planDispatched!.model, PLANNER_MODEL, "task-plan resolved through the PLANNER pool");
      assert.equal(planDispatched!.provider, "openai");
      assert.equal(planDispatched!.family, familyOf(PLANNER_MODEL));

      const executeDispatched = events.find((e) => e.kind === "task_dispatched" && e.unit === "task-execute");
      assert.ok(executeDispatched, "task-execute dispatch journaled");
      assert.equal(executeDispatched!.model, EXECUTOR_MODEL, "task-execute resolved through the EXECUTOR pool");
      assert.equal(executeDispatched!.provider, "anthropic");
      assert.equal(executeDispatched!.family, familyOf(EXECUTOR_MODEL));

      assert.notEqual(
        planDispatched!.model,
        executeDispatched!.model,
        "the two phases resolved DIFFERENT models — proves per-role pool resolution, not a single shared author",
      );

      // ZERO unit_dispatched/unit_result anywhere in the journal — this loose
      // task never touches the loop's own dispatch kinds (D-S04-4 family).
      const kinds = events.map((e) => e.kind);
      assert.ok(!kinds.includes("unit_dispatched"), "unit_dispatched never appears for the whole invocation");
      assert.ok(!kinds.includes("unit_result"), "unit_result never appears for the whole invocation");

      // .gsd/STATE.md (pre-seeded ACTIVE milestone) is byte-identical — the
      // loose task never feeds milestone state.
      const stateAfter = readFileSync(statePath);
      assert.ok(stateBefore.equals(stateAfter), "STATE.md is byte-identical after the full plan→execute invocation");

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "info");
      assert.match(finalNote[0], new RegExp(`^/forge task ${taskId}: done — task executada \\(src/foo\\.ts\\)$`));

      assert.equal(session.active, false, "the finally ran after both phases — session reset");
      assert.equal(session.cmdCtx, null, "reset() cleared cmdCtx");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(B) failure path: plan-phase timeout → no execute dispatch, task_result status=timeout journaled", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "60";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-e2e-timeout-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      let dispatchCount = 0;
      const { ctx, notifications } = fakeCtx(cwd, () => {
        // The worker only narrates, never emits forge_unit_result — the
        // dispatch must resolve via the wall-clock ceiling (B4), not hang.
        dispatchCount++;
      });

      const start = Date.now();
      await assert.doesNotReject(runTaskCommand(ctx, ["tarefa", "que", "trava"], session));
      assert.ok(Date.now() - start < 5000, "resolved promptly at the short timeout ceiling, not a real hang");

      // Only ONE dispatch happened — task-execute never fires after a timeout.
      assert.equal(dispatchCount, 1, "only the plan phase was dispatched");

      const taskId = soleTaskId(cwd);
      assert.ok(!existsSync(planPath(cwd, taskId)), "PLAN.md was never written by the hung worker");

      const events = readEvents(cwd);
      const kinds = events.map((e) => e.kind);
      assert.ok(kinds.includes("task_dispatched"), "task_dispatched journaled for the plan phase");
      assert.ok(kinds.includes("task_result"), "task_result journaled for the plan phase");
      assert.ok(!events.some((e) => e.unit === "task-execute"), "no task-execute journal entries — never dispatched");

      const planResult = events.find((e) => e.kind === "task_result" && e.unit === "task-plan");
      assert.ok(planResult, "task_result for task-plan exists");
      assert.equal(planResult!.status, "timeout", "the synthetic timeout outcome is journaled verbatim");

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "warning");
      assert.match(finalNote[0], /plano não concluído \(timeout\) — execução não despachada\./);

      assert.equal(session.active, false, "the finally ran even on a timed-out plan phase");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(C) advisory-warn (D-S04-1): PLAN.md missing domain:/effort: → warning notify fires AND execute still dispatches", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-e2e-advisory-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        const taskId = soleTaskId(cwd);
        if (content.includes("# Unit: task-plan")) {
          // No frontmatter at all — domain:/effort: both absent — but still
          // >10 non-blank lines so R3's `verifyTaskPlan` substance gate passes.
          writeFileSync(
            planPath(cwd, taskId),
            "# Plan\n\n## Goal\n\nDo the thing.\n\n## Steps\n\n1. Step one.\n2. Step two.\n3. Step three.\n4. Step four.\n5. Step five.\n6. Step six.\n7. Step seven.\n",
          );
          deliverUnitResult(
            { status: "done", summary: "plano escrito sem frontmatter", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        } else if (content.includes("# Unit: task-execute")) {
          writeSubstantiveSummary(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "task executada", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      await assert.doesNotReject(runTaskCommand(ctx, ["tarefa", "sem", "frontmatter", "no", "plano"], session));

      const warnNote = notifications.find(([msg]) => msg.startsWith("⚠ plano da task sem domain:/effort:"));
      assert.ok(warnNote, "the advisory warning fired");
      assert.equal(warnNote?.[1], "warning");

      // Execute STILL dispatched — the advisory check never blocks (D-S04-1).
      const events = readEvents(cwd);
      assert.ok(events.some((e) => e.kind === "task_dispatched" && e.unit === "task-execute"), "execute was dispatched");
      assert.ok(events.some((e) => e.kind === "task_result" && e.unit === "task-execute"), "execute journaled a result");

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "info");
      assert.match(finalNote[0], /done — task executada/);
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("S03/T06 — /forge task→review→fix→status e2e (through-the-driver)", () => {
  test("(D) review chain: real commit in execute → REVIEW.md in the store, range = journaled shas", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-e2e-review-"));
    seedTimestampIdPref(cwd);
    try {
      const originalHead = initTrackedGitRepo(cwd);

      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      const statePath = join(cwd, ".gsd", "STATE.md");
      writeFileSync(statePath, "milestone: M-active-preexisting\nphase: execute\n");
      const stateBefore = readFileSync(statePath);

      const session = new ForgeAutoSession();
      const capturedReviewPrompts: string[] = [];
      let executeCommitSha = "";
      const { ctx } = fakeCtx(cwd, (content) => {
        const taskId = soleTaskId(cwd);
        if (content.includes("# Unit: task-plan")) {
          writeCompliantPlan(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "plano escrito", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        } else if (content.includes("# Unit: task-execute")) {
          writeSubstantiveSummary(cwd, taskId);
          // A REAL commit during execute — this is the journaled range the review must diff.
          writeFileSync(join(cwd, "src-change.txt"), "mudanca real\n");
          execFileSync("git", ["-C", cwd, "add", "."]);
          execFileSync("git", ["-C", cwd, "commit", "-qm", "task execute change"]);
          executeCommitSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
          deliverUnitResult(
            { status: "done", summary: "task executada", artifacts: ["src-change.txt"] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      // Fake ReviewDispatcher — distinguishes challenger/advocate/rebuttal by
      // prompt content (each phase's prompt opens with a distinct persona
      // sentence — see review/prompts.ts) and returns canned text carrying
      // ONE real objection, so the artifact is a genuine dialectic render.
      const dialecticDispatcher: ReviewDispatcher = {
        dispatch: async (prompt) => {
          capturedReviewPrompts.push(prompt);
          if (prompt.includes("You are an adversarial senior code reviewer")) {
            return "### High\n- R1 `src-change.txt:1` — validação ausente — suggested fix: adicionar checagem — challenge: isso quebra em produção?\n";
          }
          if (prompt.includes("You are the engineer who wrote the code under review")) {
            return "### Defense\n- R1: open — `src-change.txt:1` — genuine tradeoff, ambos os lados válidos\n";
          }
          // Rebuttal mode (the dialectic's third and last phase, rounds=1 default).
          return "### Rebuttal\n- R1: maintained — a checagem continua ausente\n";
        },
      };

      await assert.doesNotReject(
        runTaskCommand(ctx, ["revisar", "cadeia", "completa"], session, {
          reviewDispatcher: dialecticDispatcher,
          resolveContext: { session, config: reviewModelsConfig },
        }),
      );

      const taskId = soleTaskId(cwd);
      const reviewFile = join(cwd, ".gsd", "tasks", taskId, `${taskId}-REVIEW.md`);
      assert.ok(existsSync(reviewFile), "REVIEW.md landed in the store");
      const reviewContent = readFileSync(reviewFile, "utf8");
      assert.match(reviewContent, /validação ausente/, "the objection's claim text landed in the artifact");
      assert.match(reviewContent, /### R1/, "R1's block is a real dialectic render");
      assert.doesNotMatch(reviewContent, /Review could not run/, "not a declared stub");

      // task_dispatched/task_result carry task+sha (S03/T01).
      const events = readEvents(cwd);
      const taskEvents = events.filter((e) => e.task === taskId);
      assert.equal(taskEvents.length, 4, "both phases journaled their task_dispatched/task_result pair");
      for (const e of taskEvents) assert.equal(e.task, taskId, "every task-scoped event carries the task id");

      const planDispatched = taskEvents.find((e) => e.kind === "task_dispatched" && e.unit === "task-plan");
      assert.ok(planDispatched, "task-plan dispatch journaled");
      assert.equal(planDispatched!.sha, originalHead, "the FIRST dispatched sha is the pre-execute HEAD");

      const executeResult = taskEvents.find((e) => e.kind === "task_result" && e.unit === "task-execute");
      assert.ok(executeResult, "task-execute result journaled");
      assert.notEqual(originalHead, executeCommitSha, "a real commit landed during execute");
      assert.equal(executeResult!.sha, executeCommitSha, "the LAST result sha is the real execute commit");

      // Every dialectic phase's prompt carries the exact journaled base..end range.
      assert.ok(capturedReviewPrompts.length >= 3, "challenger, advocate and rebuttal were all dispatched");
      const diffRangeRe = new RegExp(`DIFF_CMD: git diff ${originalHead}\\.\\.${executeCommitSha}`);
      for (const prompt of capturedReviewPrompts) {
        assert.match(prompt, diffRangeRe, "the dialectic diffed the task's exact journaled commit range");
      }

      // .gsd/STATE.md (pre-seeded ACTIVE milestone) byte-identical.
      assert.ok(
        readFileSync(statePath).equals(stateBefore),
        "STATE.md is byte-identical after the full task→review chain",
      );

      // ZERO unit_dispatched/unit_result anywhere.
      const kinds = events.map((e) => e.kind);
      assert.ok(!kinds.includes("unit_dispatched"), "unit_dispatched never appears");
      assert.ok(!kinds.includes("unit_result"), "unit_result never appears");

      // /forge status lists the loose task at its (revisada) stage.
      const statusText = formatStatus(cwd);
      assert.match(statusText, new RegExp(`${taskId} — revisada`), "status lists the task at the revisada stage");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(E) fix: /forge fix T-<id> dispatches once through the driver, task paths in the prompt, write-back applied", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-e2e-fix-"));
    seedTimestampIdPref(cwd);
    try {
      const taskId = "T-20260712100000-fix-e2e";
      seedTaskReview(cwd, taskId);
      const sha = initTrackedGitRepo(cwd); // R3: isRealCommit needs a real repo/commit

      const statePath = join(cwd, ".gsd", "STATE.md");
      assert.ok(!existsSync(statePath), "no STATE.md — the fixture starts repo-level, no active milestone");

      const session = new ForgeAutoSession();
      let capturedPrompt = "";
      let dispatchCount = 0;
      const { ctx } = fakeCtx(cwd, (content) => {
        dispatchCount++;
        capturedPrompt = content;
        deliverUnitResult(
          { status: "done", summary: `R1: corrigida (commit ${sha})`, artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runFixCommand(ctx, [taskId], session));

      assert.equal(dispatchCount, 1, "exactly one dispatch through the driver");
      assert.match(capturedPrompt, new RegExp(`\\.gsd/tasks/${taskId}/`), "prompt carries task-scoped paths");
      assert.match(capturedPrompt, /claim R1/, "the pending item's verbatim dialogue was inlined");

      const reviewFile = join(cwd, ".gsd", "tasks", taskId, `${taskId}-REVIEW.md`);
      const raw = readFileSync(reviewFile, "utf-8");
      assert.match(
        raw,
        new RegExp(`- \\*\\*Decisão:\\*\\* corrigida \\(commit ${sha}\\)`),
        "the worker's decision flipped the REVIEW.md marker",
      );

      // Journal advisory-only, task-stamped (S03/T04).
      const events = readEvents(cwd);
      const kinds = events.map((e) => e.kind);
      assert.deepEqual(
        new Set(kinds),
        new Set(["review_fix_dispatched", "review_fix_result"]),
        "journal carries ONLY the two review-fix advisory kinds",
      );
      assert.ok(!kinds.includes("unit_dispatched"), "unit_dispatched never appears");
      assert.ok(!kinds.includes("unit_result"), "unit_result never appears");
      for (const e of events) assert.equal(e.task, taskId, "both advisory events carry the task id");

      // Loose-task fix is repo-level — STATE.md stays ABSENT before AND after.
      assert.ok(!existsSync(statePath), "STATE.md is still absent after the fix dispatch");

      // /forge status lists the loose task at its (revisada) stage.
      const statusText = formatStatus(cwd);
      assert.match(statusText, new RegExp(`${taskId} — revisada`), "status lists the task at the revisada stage");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
