/**
 * S02/T02 — `/forge task` through-the-driver spine (ID + store + task-plan
 * dispatch + journaling). Same fake-driver seam as
 * `research-models-e2e.test.ts`/`tests/forge-command.test.ts`: only
 * `ExtensionCommandContext.newSession`/`withSession`/`sendMessage` is a fake,
 * worker-compliant stand-in — the rest of the spine (`resolveDispatchAuthor`
 * → `composePrompt` → `dispatchUnitViaNewSession`) is the REAL production
 * code.
 *
 * S02/T03 extends the same seam to TWO sequential dispatches per invocation
 * (`task-plan` then `task-execute`) — `onSendMessage` below branches on the
 * composed prompt's `# Unit: <type>` identity line to tell the phases apart,
 * and simulates the worker's own file writes (`<TASK_ID>-PLAN.md`,
 * `<TASK_ID>-SUMMARY.md`) the way a real worker would, since no real agent
 * runs in this fake-driver harness.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { runTaskCommand } from "../commands/task-command.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";
import type { ReviewDispatcher } from "../review/dispatch.ts";

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * A fake command context whose `newSession` runs `onSendMessage`
 * synchronously — no real pi session involved. RECURSIVE (S02/T03): the
 * driver's B3 stale-handle rule re-points `session.cmdCtx` at the `withSession`
 * callback's fresh context after every dispatch, so a SECOND phase's
 * `dispatchUnitViaNewSession` call reads that fresh context as its own
 * `cmdCtx` — it must expose the same `newSession`/`sendMessage` shape, or a
 * chained second dispatch (`task-execute` after `task-plan`) throws
 * `cmdCtx.newSession is not a function` and silently resolves `blocked`
 * instead of ever reaching `onSendMessage` a second time. A real
 * `ExtensionCommandContext` always has this shape at every session depth; a
 * production run never hits this — it is purely a fake-driver artifact.
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
 * Pins `ids.format` to `timestamp` via `.gsd/prefs.local.md` — the highest-
 * precedence layer in the `readForgePrefs` cascade (S02-REVIEW R5) — so every
 * `T-<14-digit>` assertion in this file is isolated from a runner's home-level
 * `ids: sequential` pref instead of depending on the ambient environment.
 */
function seedTimestampIdPref(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(join(cwd, ".gsd", "prefs.local.md"), "ids: timestamp\n");
}

describe("S02/T02 — /forge task", () => {
  test("empty description: pt-BR usage message, zero dispatch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-usage-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      let sendMessageCalled = false;
      const { ctx, notifications } = fakeCtx(cwd, () => {
        sendMessageCalled = true;
      });

      await runTaskCommand(ctx, [], session);

      assert.equal(sendMessageCalled, false, "no dispatch was attempted");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.[1], "warning");
      assert.match(notifications[0]?.[0] ?? "", /Uso: \/forge task/);
      assert.equal(session.active, false, "the guard never flips active for an empty description");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reentrância: session.active=true ⇒ warning, zero dispatch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-reentrant-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      session.active = true; // simulate an already-running loop/dispatch
      let sendMessageCalled = false;
      const { ctx, notifications } = fakeCtx(cwd, () => {
        sendMessageCalled = true;
      });

      await runTaskCommand(ctx, ["corrigir", "o", "parser", "X"], session);

      assert.equal(sendMessageCalled, false, "no dispatch was attempted");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.[1], "warning");
      assert.match(notifications[0]?.[0] ?? "", /loop já ativo/);
      assert.equal(session.active, true, "the guard does not clobber the already-active session");
      assert.ok(!existsSync(join(cwd, ".gsd", "tasks")), "no store was created for a rejected reentrant call");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("happy path: mints a T-<14-digit>-<slug> id, creates the store, dispatches task-plan, journals advisory kinds, never touches STATE.md", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-happy-"));
    seedTimestampIdPref(cwd);
    try {
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      const statePath = join(cwd, ".gsd", "STATE.md");
      writeFileSync(statePath, "milestone: M-preexisting\nphase: execute\n");
      const stateBefore = readFileSync(statePath);

      const session = new ForgeAutoSession();
      let capturedPrompt = "";
      const { ctx } = fakeCtx(cwd, (content) => {
        capturedPrompt = content;
        deliverUnitResult(
          { status: "done", summary: "plano escrito", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runTaskCommand(ctx, ['"corrigir', "o", 'parser X"'], session));

      // ID format: T-<14-digit UTC>-<slug ≤24>, minted via resolveTaskId.
      const taskDirs = listTaskDirs(cwd);
      assert.equal(taskDirs.length, 1, "exactly one task store was created");
      const taskId = taskDirs[0]!;
      assert.match(taskId, /^T-\d{14}(-[a-z0-9-]+)?$/);

      // Store + TASK.md created with the description, BEFORE the dispatch.
      const taskMdPath = join(cwd, ".gsd", "tasks", taskId, `${taskId}-TASK.md`);
      assert.ok(existsSync(taskMdPath), "TASK.md was written");
      const taskMd = readFileSync(taskMdPath, "utf8");
      assert.match(taskMd, /corrigir o parser X/, "the description survives quote-stripping");

      // The composed prompt for task-plan carries the TASK_ID and the TASK.md path.
      assert.match(capturedPrompt, /# Unit: task-plan/);
      assert.ok(capturedPrompt.includes(taskId), "prompt identity carries the taskId");
      assert.ok(capturedPrompt.includes(taskMdPath), "prompt names the TASK.md path to read");

      // Journal kinds: task_dispatched + task_result, unit "task-plan", NEVER unit_dispatched/unit_result.
      const events = readEvents(cwd);
      const kinds = events.map((e) => e.kind);
      assert.ok(kinds.includes("task_dispatched"), "task_dispatched journaled");
      assert.ok(kinds.includes("task_result"), "task_result journaled");
      assert.ok(!kinds.includes("unit_dispatched"), "the loop's own unit_dispatched kind never appears");
      assert.ok(!kinds.includes("unit_result"), "the loop's own unit_result kind never appears");
      const dispatchedEv = events.find((e) => e.kind === "task_dispatched");
      const resultEv = events.find((e) => e.kind === "task_result");
      assert.equal(dispatchedEv?.unit, "task-plan");
      assert.equal(resultEv?.unit, "task-plan");
      // S03/T01 — additive journal fields: `task` on both, no active git repo here.
      assert.equal(dispatchedEv?.task, taskId, "task_dispatched carries the TASK_ID in `task`");
      assert.equal(resultEv?.task, taskId, "task_result carries the TASK_ID in `task`");

      // .gsd/STATE.md is NEVER read-modify-written by this command — byte-compare.
      const stateAfter = readFileSync(statePath);
      assert.ok(stateBefore.equals(stateAfter), "STATE.md is byte-identical after /forge task");

      assert.equal(session.active, false, "the finally ran — session reset");
      assert.equal(session.cmdCtx, null, "reset() cleared cmdCtx");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("S03/T01: em um repo git, task_dispatched/task_result carregam sha de HEAD", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-sha-"));
    seedTimestampIdPref(cwd);
    try {
      execFileSync("git", ["-C", cwd, "init", "-q"]);
      execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
      writeFileSync(join(cwd, "seed.txt"), "seed\n");
      execFileSync("git", ["-C", cwd, "add", "."]);
      execFileSync("git", ["-C", cwd, "commit", "-qm", "seed"]);
      const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

      const session = new ForgeAutoSession();
      const { ctx } = fakeCtx(cwd, () => {
        deliverUnitResult(
          { status: "done", summary: "plano escrito", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runTaskCommand(ctx, ["corrigir", "algo"], session));

      const events = readEvents(cwd);
      const dispatchedEv = events.find((e) => e.kind === "task_dispatched");
      const resultEv = events.find((e) => e.kind === "task_result");
      assert.equal(dispatchedEv?.sha, head, "task_dispatched carries HEAD's sha");
      assert.equal(resultEv?.sha, head, "task_result carries HEAD's sha (no commits happened in between)");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("sem STATE.md: milestoneId degrada para \"\" — prompt composto omite '- Milestone:' e o dispatch prossegue", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-nostate-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      let capturedPrompt = "";
      const { ctx } = fakeCtx(cwd, (content) => {
        capturedPrompt = content;
        deliverUnitResult(
          { status: "blocked", summary: "sem contexto suficiente", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runTaskCommand(ctx, ["investigar", "bug", "Y"], session));

      assert.doesNotMatch(capturedPrompt, /- Milestone:/, "no active milestone — the identity line is omitted");
      assert.equal(session.active, false, "the finally ran even without STATE.md");
      assert.ok(!existsSync(join(cwd, ".gsd", "STATE.md")), "no STATE.md was created by this command");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

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

describe("S02/T03 — /forge task: execute chain + advisory check + SUMMARY verification", () => {
  test("plan done + PLAN.md on disk: execute dispatches in the same invocation, journals all 4 events in order", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t03-happy-"));
    seedTimestampIdPref(cwd);
    try {
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

      await assert.doesNotReject(runTaskCommand(ctx, ["corrigir", "o", "parser"], session));

      assert.equal(capturedPrompts.length, 2, "both phases dispatched exactly once each");
      assert.match(capturedPrompts[0]!, /# Unit: task-plan/);
      assert.match(capturedPrompts[1]!, /# Unit: task-execute/);

      const taskId = soleTaskId(cwd);
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
        "the 4 events appear, in order",
      );

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "info");
      assert.match(finalNote[0], new RegExp(`^/forge task ${taskId}: done — task executada \\(src/foo\\.ts\\)$`));

      assert.equal(session.active, false, "the finally ran after both phases");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("plan partial: execute is NOT dispatched, operator told why in pt-BR", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t03-partial-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      let dispatchCount = 0;
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        dispatchCount++;
        const taskId = soleTaskId(cwd);
        writeCompliantPlan(cwd, taskId); // the worker may still write a plan even on partial
        deliverUnitResult(
          { status: "partial", summary: "faltou detalhar riscos", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runTaskCommand(ctx, ["investigar", "bug", "Z"], session));

      assert.equal(dispatchCount, 1, "only the plan phase dispatched");
      const events = readEvents(cwd);
      assert.ok(!events.some((e) => e.unit === "task-execute"), "no task-execute journal entries");

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "warning");
      assert.match(finalNote[0], /plano não concluído \(partial\) — execução não despachada\./);
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("plan done but PLAN.md missing on disk: execute is NOT dispatched", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t03-noplan-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      let dispatchCount = 0;
      const { ctx, notifications } = fakeCtx(cwd, () => {
        dispatchCount++;
        // Reports done WITHOUT ever writing <TASK_ID>-PLAN.md.
        deliverUnitResult(
          { status: "done", summary: "disse que terminou", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runTaskCommand(ctx, ["tarefa", "sem", "plano"], session));

      assert.equal(dispatchCount, 1, "only the plan phase dispatched");
      const taskId = soleTaskId(cwd);
      assert.ok(!existsSync(planPath(cwd, taskId)), "PLAN.md was indeed never written");

      const events = readEvents(cwd);
      assert.ok(!events.some((e) => e.unit === "task-execute"), "no task-execute journal entries");

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "warning");
      assert.match(finalNote[0], new RegExp(`${taskId}-PLAN\\.md ausente — execução não despachada\\.`));
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("advisory warn fires on a PLAN.md missing domain:/effort:, but execute still dispatches (D-S04-1)", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t03-advisory-"));
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

      await assert.doesNotReject(runTaskCommand(ctx, ["tarefa", "sem", "frontmatter"], session));

      const warnNote = notifications.find(([msg]) => msg.startsWith("⚠ plano da task sem domain:/effort:"));
      assert.ok(warnNote, "the advisory warning fired");
      assert.equal(warnNote?.[1], "warning");

      // Execute STILL dispatched — the advisory check never blocks.
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

  test("SUMMARY.md missing after execute: outcome downgraded to a warning naming the gap, never reported clean", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t03-nosummary-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        const taskId = soleTaskId(cwd);
        if (content.includes("# Unit: task-plan")) {
          writeCompliantPlan(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "plano escrito", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        } else if (content.includes("# Unit: task-execute")) {
          // Reports done WITHOUT ever writing <TASK_ID>-SUMMARY.md.
          deliverUnitResult(
            { status: "done", summary: "disse que terminou", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      await assert.doesNotReject(runTaskCommand(ctx, ["tarefa", "sem", "summary"], session));

      const taskId = soleTaskId(cwd);
      assert.ok(!existsSync(summaryPath(cwd, taskId)), "SUMMARY.md was indeed never written");

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "warning", "a missing SUMMARY.md never reports clean success");
      assert.match(finalNote[0], new RegExp(`${taskId}-SUMMARY\\.md ausente`));
      assert.match(finalNote[0], /resultado não confiável/);
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("SUMMARY.md too thin (≤10 lines): also downgraded to a warning naming the gap", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t03-thinsummary-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        const taskId = soleTaskId(cwd);
        if (content.includes("# Unit: task-plan")) {
          writeCompliantPlan(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "plano escrito", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        } else if (content.includes("# Unit: task-execute")) {
          writeFileSync(summaryPath(cwd, taskId), "---\nid: X\n---\n\nExecuted by: fake\n\nFeito.\n");
          deliverUnitResult(
            { status: "done", summary: "task executada", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      await assert.doesNotReject(runTaskCommand(ctx, ["tarefa", "com", "summary", "fino"], session));

      const taskId = soleTaskId(cwd);
      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "warning");
      assert.match(finalNote[0], new RegExp(`${taskId}-SUMMARY\\.md tem apenas \\d+ linha\\(s\\)`));
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("STATE.md remains byte-identical across the whole plan→execute invocation", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t03-state-"));
    seedTimestampIdPref(cwd);
    try {
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      const statePath = join(cwd, ".gsd", "STATE.md");
      writeFileSync(statePath, "milestone: M-preexisting\nphase: execute\n");
      const stateBefore = readFileSync(statePath);

      const session = new ForgeAutoSession();
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
          deliverUnitResult(
            { status: "done", summary: "task executada", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      await assert.doesNotReject(runTaskCommand(ctx, ["tarefa", "state", "check"], session));

      const stateAfter = readFileSync(statePath);
      assert.ok(stateBefore.equals(stateAfter), "STATE.md is byte-identical after the full plan→execute invocation");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * S03/T02 — minimal `roles.reviewer`/`roles.advocate` config so
 * `resolveModelForRole` (called internally by `runReviewDialectic`) resolves
 * a non-null model in this fake-driver harness, which has no `.gsd/models.md`
 * on disk. Without this, resolution degrades to `effectiveModelFor`'s
 * `null` fallback and the fake `ReviewDispatcher` below is never actually
 * invoked — the dialectic would stub on "reviewer não elencável" first.
 */
const reviewModelsConfig = {
  pools: { main: ["claude-code/claude-opus-4-8"] },
  roles: { reviewer: ["main"], advocate: ["main"] },
  constraints: {},
};

/** A no-objections fake dispatcher — the dialectic's cheapest REAL (non-stub) path. */
function noFlagsDispatcher(): ReviewDispatcher {
  return { dispatch: async () => "NO_FLAGS\n" };
}

/** A dispatcher that always throws — proves the advisory posture end-to-end. */
function throwingDispatcher(message: string): ReviewDispatcher {
  return {
    dispatch: async () => {
      throw new Error(message);
    },
  };
}

/**
 * git repo with one tracked, committed file. S03/T02 review tests modify it
 * WITHOUT committing inside the fake `task-execute` handler, so
 * `runReviewDialectic`'s `diffHasFiles` sees a real diff: the task's own
 * journaled sha range collapses to "no commits happened between dispatch and
 * result" (same sha both ends), so `computeReviewDiffCmd` falls back to its
 * documented `git diff HEAD` working-tree heuristic, which does pick up the
 * uncommitted change.
 */
function initTrackedGitRepo(cwd: string): void {
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
  writeFileSync(join(cwd, "tracked.txt"), "seed\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "seed"]);
}

function reviewPath(cwd: string, taskId: string): string {
  return join(cwd, ".gsd", "tasks", taskId, `${taskId}-REVIEW.md`);
}

describe("S03/T02 — /forge task: review dialético phase", () => {
  test("execute done: REVIEW.md is written with a REAL (non-stub) dialectic outcome, outcome unchanged", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t02-review-done-"));
    seedTimestampIdPref(cwd);
    try {
      initTrackedGitRepo(cwd);
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        const taskId = soleTaskId(cwd);
        if (content.includes("# Unit: task-plan")) {
          writeCompliantPlan(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "plano escrito", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        } else if (content.includes("# Unit: task-execute")) {
          writeSubstantiveSummary(cwd, taskId);
          // Uncommitted change to a tracked file — gives the dialectic a real diff.
          writeFileSync(join(cwd, "tracked.txt"), "seed\nmudou\n");
          deliverUnitResult(
            { status: "done", summary: "task executada", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      await assert.doesNotReject(
        runTaskCommand(ctx, ["revisar", "algo"], session, {
          reviewDispatcher: noFlagsDispatcher(),
          resolveContext: { session, config: reviewModelsConfig },
        }),
      );

      const taskId = soleTaskId(cwd);
      const reviewFile = reviewPath(cwd, taskId);
      assert.ok(existsSync(reviewFile), "REVIEW.md was written to the store");
      const reviewContent = readFileSync(reviewFile, "utf8");
      assert.match(
        reviewContent,
        /Reviewer found nothing to challenge/,
        "the dialectic actually ran (not a declared stub)",
      );

      const reviewNote = notifications.find(([msg]) => msg.startsWith("⚖ Review de"));
      assert.ok(reviewNote, "the review outcome was notified");
      assert.ok(reviewNote![0].includes(`⚖ Review de ${taskId}: 0 resolvido(s), 0 concedido(s), 0 aberto(s) — `));
      assert.ok(reviewNote![0].includes(reviewFile));

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "info");
      assert.match(finalNote[0], /done — task executada/, "the review phase never mutates the reported outcome");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("execute non-done (blocked): REVIEW.md is still written — the review runs regardless of execute status", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t02-review-blocked-"));
    seedTimestampIdPref(cwd);
    try {
      initTrackedGitRepo(cwd);
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        const taskId = soleTaskId(cwd);
        if (content.includes("# Unit: task-plan")) {
          writeCompliantPlan(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "plano escrito", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        } else if (content.includes("# Unit: task-execute")) {
          writeSubstantiveSummary(cwd, taskId);
          writeFileSync(join(cwd, "tracked.txt"), "seed\nmudou\n");
          deliverUnitResult(
            { status: "blocked", summary: "faltou contexto", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      await assert.doesNotReject(
        runTaskCommand(ctx, ["revisar", "algo", "bloqueado"], session, {
          reviewDispatcher: noFlagsDispatcher(),
          resolveContext: { session, config: reviewModelsConfig },
        }),
      );

      const taskId = soleTaskId(cwd);
      assert.ok(existsSync(reviewPath(cwd, taskId)), "REVIEW.md was written even though execute did not report done");

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "warning");
      assert.match(finalNote[0], /blocked — faltou contexto/);
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("dispatcher throws: dialectic degrades to a declared stub, a pt-BR warning is surfaced, outcome unchanged", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t02-review-throw-"));
    seedTimestampIdPref(cwd);
    try {
      initTrackedGitRepo(cwd);
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        const taskId = soleTaskId(cwd);
        if (content.includes("# Unit: task-plan")) {
          writeCompliantPlan(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "plano escrito", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        } else if (content.includes("# Unit: task-execute")) {
          writeSubstantiveSummary(cwd, taskId);
          writeFileSync(join(cwd, "tracked.txt"), "seed\nmudou\n");
          deliverUnitResult(
            { status: "done", summary: "task executada", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      await assert.doesNotReject(
        runTaskCommand(ctx, ["revisar", "com", "dispatcher", "quebrado"], session, {
          reviewDispatcher: throwingDispatcher("challenger indisponível"),
          resolveContext: { session, config: reviewModelsConfig },
        }),
      );

      const taskId = soleTaskId(cwd);
      const reviewFile = reviewPath(cwd, taskId);
      assert.ok(existsSync(reviewFile), "REVIEW.md was still written — a declared stub");
      assert.match(readFileSync(reviewFile, "utf8"), /Review could not run/);

      const warnNote = notifications.find(([msg]) => msg.startsWith(`⚠ review de ${taskId}`));
      assert.ok(warnNote, "the dispatcher failure surfaced as a pt-BR warning");
      assert.equal(warnNote?.[1], "warning");

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "info");
      assert.match(finalNote[0], /done — task executada/, "the review failure never mutates the reported outcome");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("plan-gate failure: no execute dispatch ⇒ no review runs, no REVIEW.md is created", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t02-review-noplan-"));
    seedTimestampIdPref(cwd);
    try {
      const session = new ForgeAutoSession();
      const { ctx } = fakeCtx(cwd, () => {
        // Reports done WITHOUT ever writing <TASK_ID>-PLAN.md — the same gate T03 tests.
        deliverUnitResult(
          { status: "done", summary: "disse que terminou", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(
        runTaskCommand(ctx, ["tarefa", "sem", "plano", "review"], session, {
          reviewDispatcher: noFlagsDispatcher(),
          resolveContext: { session, config: reviewModelsConfig },
        }),
      );

      const taskId = soleTaskId(cwd);
      assert.ok(
        !existsSync(reviewPath(cwd, taskId)),
        "no REVIEW.md was created — the plan gate never let execute dispatch",
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("thin SUMMARY.md after execute: review still runs (REVIEW.md exists) AND the downgrade warning still fires last", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-task-t02-review-thinsummary-"));
    seedTimestampIdPref(cwd);
    try {
      initTrackedGitRepo(cwd);
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        const taskId = soleTaskId(cwd);
        if (content.includes("# Unit: task-plan")) {
          writeCompliantPlan(cwd, taskId);
          deliverUnitResult(
            { status: "done", summary: "plano escrito", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        } else if (content.includes("# Unit: task-execute")) {
          // Thin SUMMARY.md — under the >10 line floor.
          writeFileSync(summaryPath(cwd, taskId), "---\nid: X\n---\n\nExecuted by: fake\n\nFeito.\n");
          writeFileSync(join(cwd, "tracked.txt"), "seed\nmudou\n");
          deliverUnitResult(
            { status: "done", summary: "task executada", artifacts: [] },
            session.currentRendezvousToken ?? undefined,
          );
        }
      });

      await assert.doesNotReject(
        runTaskCommand(ctx, ["tarefa", "com", "summary", "fino", "e", "review"], session, {
          reviewDispatcher: noFlagsDispatcher(),
          resolveContext: { session, config: reviewModelsConfig },
        }),
      );

      const taskId = soleTaskId(cwd);
      assert.ok(existsSync(reviewPath(cwd, taskId)), "REVIEW.md was written despite the thin SUMMARY");

      const finalNote = notifications[notifications.length - 1];
      assert.ok(finalNote);
      assert.equal(finalNote[1], "warning");
      assert.match(finalNote[0], new RegExp(`${taskId}-SUMMARY\\.md tem apenas \\d+ linha\\(s\\)`));
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
