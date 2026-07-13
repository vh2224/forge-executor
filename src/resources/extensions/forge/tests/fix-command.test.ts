/**
 * S02/T03 — `/forge fix` command-level coverage: `parseFixTarget`/
 * `parseFixDecisions` (pure), list mode against real REVIEW.md fixtures,
 * `applyFixDecisions` write-back against REVIEW.md/KNOWLEDGE.md fixtures, and
 * every guard (no STATE.md, empty target, reentrancy).
 *
 * S03/T04 extends this file with the REAL `T-<id>` dispatch path (`newSession`
 * → `dispatchUnitViaNewSession`), following the same fake-driver seam
 * `review-fix-e2e.test.ts` uses for the slice path: a fake `ExtensionCommand
 * Context` whose `newSession` runs the scripted worker synchronously and
 * delivers via the real `deliverUnitResult` rendezvous. Every OTHER
 * `runFixCommand` case in this file hits an early-return guard — `newSession`
 * is never invoked there (a fake ctx that throws if it ever is proves this).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import {
  parseFixTarget,
  parseFixDecisions,
  applyFixDecisions,
  runFixCommand,
} from "../commands/fix-command.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";
import { updateState } from "../state/store.ts";
import {
  renderReview,
  applyDecision,
  applyConcededFix,
  reviewArtifactPath,
  collectPendingReviewBlocks,
  collectPendingTaskReviewItems,
  collectPendingTaskReviewBlocks,
  type ReviewArtifactMeta,
} from "../review/artifact.ts";
import type { ResolveReviewResult, ResolvedReviewItem } from "../review/resolve.ts";

const MID = "M-test";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "forge-fix-command-"));
}

/** R3: `isRealCommit` shells out to `git`, so a `corrigida (commit <sha>)` fixture needs a REAL repo + commit. */
function initGitRepoWithCommit(cwd: string): string {
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
  writeFileSync(join(cwd, ".gitkeep"), "");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "init"]);
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function meta(slice: string): ReviewArtifactMeta {
  return { milestoneId: MID, slice, sliceTitle: "fix target", reviewedOn: "2026-07-12", rounds: 1 };
}

function item(id: string, resolution: ResolvedReviewItem["resolution"], over: Partial<ResolvedReviewItem> = {}): ResolvedReviewItem {
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

function result(items: ResolvedReviewItem[]): ResolveReviewResult {
  const counts = { resolved: 0, conceded: 0, open: 0 };
  for (const i of items) counts[i.resolution]++;
  return { noFlags: items.length === 0, items, counts, warnings: [] };
}

function writeArtifact(cwd: string, slice: string, body: string): void {
  const dir = join(cwd, ".gsd", "milestones", MID, "slices", slice);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slice}-REVIEW.md`), body, "utf-8");
}

/** Seeds S05 with one open (R1), one conceded-sem-fix (R2), one DECIDED open (R3, must not appear). */
function seedS05(cwd: string): void {
  const md = renderReview(
    meta("S05"),
    result([
      item("R1", "open", { challenge: "real?" }),
      item("R2", "conceded"),
      item("R3", "open", { challenge: "also?" }),
    ]),
  );
  writeArtifact(cwd, "S05", md);
  const path = reviewArtifactPath(cwd, MID, "S05");
  applyDecision(path, "R1", "deferido → triagem no fim da milestone");
  applyConcededFix(path, "R2", "failed");
  applyDecision(path, "R3", "manter — falso positivo"); // decided: must NOT appear as pending
}

function writeState(cwd: string, milestone: string): void {
  updateState(cwd, () => ({ milestone }));
}

/** A fake ctx that captures notify() and THROWS if newSession is ever called — proves no dispatch was attempted. */
function guardedFakeCtx(cwd: string): { ctx: ExtensionCommandContext; notifications: Array<[string, string]> } {
  const notifications: Array<[string, string]> = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push([message, level]);
      },
    },
    model: undefined,
    async newSession(): Promise<never> {
      throw new Error("newSession must not be called on a guard early-return path");
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

/** A fake command context whose `newSession` runs `onSendMessage` synchronously — no real pi session involved (S03/T04, mirrors `review-fix-e2e.test.ts`). */
function fakeCtx(
  cwd: string,
  onSendMessage: (content: string) => void,
): { ctx: ExtensionCommandContext; notifications: Array<[string, string]> } {
  const notifications: Array<[string, string]> = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push([message, level]);
      },
    },
    model: undefined,
    async newSession(opts: { withSession: (fresh: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
      const freshCtx = {
        abort() {},
        async sendMessage(msg: { content: string }): Promise<void> {
          onSendMessage(msg.content);
        },
      };
      await opts.withSession(freshCtx);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

/** Reads `.gsd/forge/events.jsonl` (S03/T04, mirrors `review-fix-e2e.test.ts`). */
function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── parseFixTarget ───────────────────────────────────────────────────────────

describe("parseFixTarget", () => {
  test("accepts a bare slice, uppercased", () => {
    assert.deepEqual(parseFixTarget("s05"), { kind: "slice", slice: "S05" });
    assert.deepEqual(parseFixTarget("S12"), { kind: "slice", slice: "S12" });
  });

  test("accepts S##:R#, case-insensitive, uppercased", () => {
    assert.deepEqual(parseFixTarget("s05:r1"), { kind: "slice", slice: "S05", id: "R1" });
    assert.deepEqual(parseFixTarget("S05:R12"), { kind: "slice", slice: "S05", id: "R12" });
  });

  test("accepts T-<14digits>, normalizing the T-/digits, unchanged otherwise", () => {
    assert.deepEqual(parseFixTarget("T-20260709200551"), { kind: "task", taskId: "T-20260709200551" });
    assert.deepEqual(parseFixTarget("t-20260709200551"), { kind: "task", taskId: "T-20260709200551" });
  });

  // R4 (S03-REVIEW): `slugify()` (state/ids.ts) lowercases unconditionally, so
  // generated task IDs are lowercase-only — the slug must normalize to
  // lowercase here too, or acceptance only works by filesystem accident on
  // case-insensitive filesystems (APFS) and fails on case-sensitive ones.
  test("accepts T-<14digits>-<slug>, normalizing the slug's case to lowercase", () => {
    assert.deepEqual(parseFixTarget("T-20260709200551-m1-review-fix-m1r-1"), {
      kind: "task",
      taskId: "T-20260709200551-m1-review-fix-m1r-1",
    });
    assert.deepEqual(parseFixTarget("t-20260709200551-Mixed-Case"), {
      kind: "task",
      taskId: "T-20260709200551-mixed-case",
    });
  });

  test("accepts T-<id>:R#, case-insensitive on t-/r, uppercased R#", () => {
    assert.deepEqual(parseFixTarget("t-20260709200551-m1:r2"), {
      kind: "task",
      taskId: "T-20260709200551-m1",
      id: "R2",
    });
    assert.deepEqual(parseFixTarget("T-20260709200551:R12"), { kind: "task", taskId: "T-20260709200551", id: "R12" });
  });

  test("rejects malformed input (both grammars)", () => {
    assert.equal(parseFixTarget(""), null);
    assert.equal(parseFixTarget("S05:"), null);
    assert.equal(parseFixTarget("S05-R1"), null);
    assert.equal(parseFixTarget("slice05"), null);
    assert.equal(parseFixTarget("S05:X1"), null);
    assert.equal(parseFixTarget("garbage"), null);
    assert.equal(parseFixTarget("T-2026070920055"), null, "13 digits — too short");
    assert.equal(parseFixTarget("T-202607092005511"), null, "15 digits — too long, no slug separator");
    assert.equal(parseFixTarget("T-20260709200551:X1"), null, "bad R# grammar");
    assert.equal(parseFixTarget("TASK-20260709200551"), null, "legacy TASK- prefix not in this grammar");
  });
});

// ── parseFixDecisions ────────────────────────────────────────────────────────

describe("parseFixDecisions", () => {
  test("parses all three grammar forms", () => {
    const summary = [
      "R1: corrigida (commit a1b2c3d)",
      "R2: manter (falso positivo — a API já valida)",
      "R3: follow-up (extrair helper compartilhado)",
    ].join("\n");
    const decisions = parseFixDecisions(summary);
    assert.equal(decisions.size, 3);
    assert.deepEqual(decisions.get("R1"), { kind: "corrigida", detail: "commit a1b2c3d" });
    assert.deepEqual(decisions.get("R2"), { kind: "manter", detail: "falso positivo — a API já valida" });
    assert.deepEqual(decisions.get("R3"), { kind: "follow-up", detail: "extrair helper compartilhado" });
  });

  test("is case-insensitive on the id and kind, normalizes id to uppercase", () => {
    const decisions = parseFixDecisions("r1: CORRIGIDA (commit deadbeef)");
    assert.deepEqual(decisions.get("R1"), { kind: "corrigida", detail: "commit deadbeef" });
  });

  test("ignores unmatched/garbage lines, never throws", () => {
    const summary = [
      "some preamble text",
      "R1: corrigida (commit abc123)",
      "R2 - manter razão sem parênteses",
      "totally unrelated line",
      "",
    ].join("\n");
    assert.doesNotThrow(() => parseFixDecisions(summary));
    const decisions = parseFixDecisions(summary);
    assert.equal(decisions.size, 1);
    assert.ok(decisions.has("R1"));
    assert.ok(!decisions.has("R2"));
  });

  test("empty summary → empty map", () => {
    assert.equal(parseFixDecisions("").size, 0);
    assert.equal(parseFixDecisions("   \n  \n").size, 0);
  });

  test("last line for a repeated id wins", () => {
    const decisions = parseFixDecisions("R1: manter (primeira razão)\nR1: manter (segunda razão)");
    assert.equal(decisions.get("R1")?.detail, "segunda razão");
  });
});

// ── runFixCommand — list mode ────────────────────────────────────────────────

const TID = "T-20260709200551-m1-review-fix-m1r-1";

function taskReviewPath(cwd: string, taskId: string): string {
  return join(cwd, ".gsd", "tasks", taskId, `${taskId}-REVIEW.md`);
}

function writeTaskArtifact(cwd: string, taskId: string, body: string): void {
  const dir = join(cwd, ".gsd", "tasks", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}-REVIEW.md`), body, "utf-8");
}

/** Seeds `taskId` with one open (R1) and one conceded-sem-fix (R2) pendência. */
function seedTask(cwd: string, taskId: string): void {
  const md = renderReview(meta(taskId), result([item("R1", "open", { challenge: "real?" }), item("R2", "conceded")]));
  writeTaskArtifact(cwd, taskId, md);
}

describe("runFixCommand — list mode (no args)", () => {
  test("lists pending items (S##:R#, status, claim, REVIEW.md path) and the usage hint; excludes decided items", async () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, [], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      const [message] = notifications[0]!;
      assert.match(message, /S05:R1/);
      assert.match(message, /open/);
      assert.match(message, /claim R1/);
      assert.match(message, /S05:R2/);
      assert.match(message, /conceded-sem-fix/);
      assert.doesNotMatch(message, /S05:R3/, "the already-decided R3 must not appear as pending");
      assert.match(message, new RegExp(reviewArtifactPath(cwd, MID, "S05").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(message, /\/forge fix S## \| S##:R#/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("zero pendências ⇒ mensagem clara (byte-compat: same message with a milestone active and .gsd/tasks/ absent)", async () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, [], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]![0], /nenhuma pendência/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("sem STATE.md e sem tasks soltas ⇒ mesma mensagem de nenhuma pendência, nunca lança (degrade, não hard-return)", async () => {
    const cwd = tmp();
    try {
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await assert.doesNotReject(runFixCommand(ctx, [], new ForgeAutoSession()));

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]![1], "info");
      assert.match(notifications[0]![0], /nenhuma pendência/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("sem STATE.md mas com task solta pendente ⇒ degrada para listing task-only", async () => {
    const cwd = tmp();
    try {
      seedTask(cwd, TID);
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, [], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      const [message] = notifications[0]!;
      assert.match(message, new RegExp(`${TID}:R1`));
      assert.match(message, /open/);
      assert.match(message, new RegExp(`${TID}:R2`));
      assert.match(message, /conceded-sem-fix/);
      assert.match(message, new RegExp(taskReviewPath(cwd, TID).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(message, /Uso:.*T-<id>/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("com milestone ativo E task solta pendente ⇒ lista os dois universos", async () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      seedTask(cwd, TID);
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, [], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      const [message] = notifications[0]!;
      assert.match(message, /S05:R1/);
      assert.match(message, new RegExp(`${TID}:R1`));
      assert.match(message, new RegExp(`${TID}:R2`));
      assert.doesNotMatch(message, /S05:R3/, "the already-decided R3 must not appear as pending");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── runFixCommand — target guards ───────────────────────────────────────────

describe("runFixCommand — target guards (early-return, no dispatch)", () => {
  test("alvo inválido ⇒ warning com usage, zero dispatch", async () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, ["not-a-target"], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]![1], "warning");
      assert.match(notifications[0]![0], /alvo inválido/);
      assert.match(notifications[0]![0], /\/forge fix S## \| S##:R#/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("alvo sem pendências ⇒ warning, zero dispatch", async () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd); // S05 has pending items, S09 does not exist
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, ["S09"], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]![1], "warning");
      assert.match(notifications[0]![0], /nenhuma pendência/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("S##:R# de um item já decidido ⇒ warning, zero dispatch", async () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd); // R3 is decided
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, ["S05:R3"], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]![1], "warning");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("alvo de slice sem milestone ativo ⇒ erra com a mensagem atual, mesmo com task solta pendente (slice targets seguem milestone-bound)", async () => {
    const cwd = tmp();
    try {
      seedTask(cwd, TID); // proves the degrade doesn't leak into the slice-target guard
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, ["S05"], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]![1], "warning");
      assert.match(notifications[0]![0], /milestone ativo/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── runFixCommand — T-<id> target (S03/T03: guard + interim message; real dispatch is T04) ──

describe("runFixCommand — T-<id> target guards (repo-level, no milestone needed)", () => {
  test("T-<id> sem pendências ⇒ warning, zero dispatch, mesmo sem STATE.md", async () => {
    const cwd = tmp();
    try {
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, [TID], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]![1], "warning");
      assert.match(notifications[0]![0], /nenhuma pendência/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("T-<id>:R# filtra para o item específico", async () => {
    const cwd = tmp();
    try {
      seedTask(cwd, TID);
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await runFixCommand(ctx, [`${TID}:R99`], new ForgeAutoSession());

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]![0], /nenhuma pendência/, "R99 doesn't exist on this task's REVIEW.md");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── runFixCommand — T-<id> dispatch (S03/T04: through-the-driver, task-scoped write-back) ──

describe("runFixCommand — T-<id> dispatch (S03/T04)", () => {
  test("(A) happy path: no STATE.md, prompt carries task paths + diff range + REVIEW_FIX_PROMPT body, write-back lands on the task's REVIEW.md, pendências zeram", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = tmp();
    try {
      // No writeState() call at all — proves the repo-level degrade (S03-PLAN
      // Interpretation Decision 4/5): a task target dispatches with no active
      // milestone.
      seedTask(cwd, TID);
      const sha = initGitRepoWithCommit(cwd); // R3: the sha reported below must resolve to a real commit

      const blocksBefore = collectPendingTaskReviewBlocks(cwd, { taskId: TID });
      assert.equal(blocksBefore.length, 2, "sandbox seeded with R1 (open) + R2 (conceded-sem-fix)");

      const session = new ForgeAutoSession();
      let capturedPrompt = "";
      const { ctx } = fakeCtx(cwd, (content) => {
        capturedPrompt = content;
        deliverUnitResult(
          { status: "done", summary: `R1: manter (razão)\nR2: corrigida (commit ${sha})`, artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runFixCommand(ctx, [TID], session));

      // Prompt carries the task's own store paths (never .gsd/milestones/),
      // both blocks' verbatim dialogue, the degraded diff-range fallback (no
      // journaled task_dispatched/task_result events exist in this fixture),
      // and REVIEW_FIX_PROMPT's body verbatim.
      assert.match(capturedPrompt, new RegExp(`Task REVIEW.*${taskReviewPath(cwd, TID).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.doesNotMatch(capturedPrompt, /\.gsd\/milestones\//);
      for (const block of blocksBefore) {
        assert.ok(capturedPrompt.includes(block.dialogue), `prompt carries ${block.id}'s dialogue verbatim`);
      }
      assert.match(capturedPrompt, /Diff range: `git diff HEAD`/, "diff-range line inlined, degraded fallback");
      assert.match(capturedPrompt, /You are a GSD review-fix executor\./, "REVIEW_FIX_PROMPT body carried verbatim");
      assert.match(capturedPrompt, new RegExp(`^- Task: \`${TID}\`$`, "m"));
      assert.doesNotMatch(capturedPrompt, /^- Slice: /m);
      assert.doesNotMatch(capturedPrompt, /^- Milestone: /m);

      // Write-back landed exactly as the worker's decision lines dictated, on
      // the TASK's REVIEW.md.
      const raw = readFileSync(taskReviewPath(cwd, TID), "utf-8");
      assert.match(raw, /### R1[\s\S]*?- \*\*Decisão:\*\* manter \(razão\)/, "R1 Decisão gravada");
      assert.match(
        raw,
        new RegExp(`### R2[\\s\\S]*?- \\*\\*Correção:\\*\\* aplicada — commit ${sha}`),
        "R2 Correção gravada",
      );

      assert.deepEqual(collectPendingTaskReviewItems(cwd), [], "no pendências remain for this task");

      assert.equal(session.active, false, "the finally ran — session reset");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(B) follow-up: 'R1: follow-up (nota)' grava '- **Decisão:** follow-up (KNOWLEDGE)' com o TASK_ID na entrada do KNOWLEDGE.md", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = tmp();
    try {
      seedTask(cwd, TID);

      const session = new ForgeAutoSession();
      const { ctx } = fakeCtx(cwd, (_content) => {
        deliverUnitResult(
          { status: "done", summary: "R1: follow-up (extrair helper compartilhado)", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runFixCommand(ctx, [`${TID}:R1`], session));

      const raw = readFileSync(taskReviewPath(cwd, TID), "utf-8");
      assert.match(raw, /- \*\*Decisão:\*\* follow-up \(KNOWLEDGE\)/, "the fixed marker replaces the open item's Decisão");

      const knowledgePath = join(cwd, ".gsd", "KNOWLEDGE.md");
      assert.ok(existsSync(knowledgePath), "KNOWLEDGE.md was created");
      const knowledge = readFileSync(knowledgePath, "utf-8");
      assert.match(knowledge, /## Review follow-ups/, "section created");
      assert.match(knowledge, new RegExp(`follow-up de ${TID} R1`), "entry references the TASK_ID, not a slice");
      assert.match(knowledge, /extrair helper compartilhado/, "the real note landed, not the fixed marker");

      // R2 was not targeted — remains pending untouched.
      const pending = collectPendingTaskReviewItems(cwd);
      assert.deepEqual(pending.map((p) => p.id).sort(), ["R2"]);
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(C) journal parity: review_fix_dispatched/review_fix_result carry task:<TASK_ID> and a real sha, no unit_dispatched/unit_result leak", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = tmp();
    try {
      seedTask(cwd, TID);
      const sha = initGitRepoWithCommit(cwd);

      const session = new ForgeAutoSession();
      const { ctx } = fakeCtx(cwd, (_content) => {
        deliverUnitResult(
          { status: "done", summary: "R1: manter (razão)\nR2: manter (razão)", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runFixCommand(ctx, [TID], session));

      const events = readEvents(cwd);
      const kinds = new Set(events.map((e) => e.kind));
      assert.deepEqual(kinds, new Set(["review_fix_dispatched", "review_fix_result"]));

      const dispatched = events.find((e) => e.kind === "review_fix_dispatched");
      const result = events.find((e) => e.kind === "review_fix_result");
      assert.ok(dispatched, "review_fix_dispatched was journaled");
      assert.ok(result, "review_fix_result was journaled");
      assert.equal(dispatched!.task, TID);
      assert.equal(result!.task, TID);
      assert.equal(dispatched!.sha, sha, "best-effort HEAD sha stamped on dispatch");
      assert.equal(result!.sha, sha, "best-effort HEAD sha stamped on result");
      // Milestone-agnostic: no STATE.md was written for this fixture.
      assert.equal(dispatched!.milestone, "");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(D) slice-target regression: S## dispatch through the shared bootstrap/reentrancy helpers stays byte-compatible", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);

      const session = new ForgeAutoSession();
      const { ctx } = fakeCtx(cwd, (_content) => {
        deliverUnitResult(
          { status: "done", summary: "R1: manter (razão)", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runFixCommand(ctx, ["S05:R1"], session));

      const raw = readFileSync(reviewArtifactPath(cwd, MID, "S05"), "utf-8");
      assert.match(raw, /### R1[\s\S]*?- \*\*Decisão:\*\* manter \(razão\)/);

      const events = readEvents(cwd);
      const dispatched = events.find((e) => e.kind === "review_fix_dispatched");
      assert.ok(dispatched, "review_fix_dispatched was journaled for the slice path too");
      assert.equal(dispatched!.task, undefined, "slice targets never carry a task field");
      assert.equal(dispatched!.sha, undefined, "slice targets never carry a sha field (byte-compat with pre-T04)");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── runFixCommand — reentrancy guard ────────────────────────────────────────

describe("runFixCommand — reentrancy guard", () => {
  test("session.active=true ⇒ warning 'loop já ativo', zero dispatch, session left untouched", async () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      const { ctx, notifications } = guardedFakeCtx(cwd);
      const session = new ForgeAutoSession();
      session.active = true;

      await runFixCommand(ctx, ["S05"], session);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]![1], "warning");
      assert.match(notifications[0]![0], /loop já ativo/);
      assert.equal(session.active, true, "the guard does not clobber an already-active session");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── applyFixDecisions ────────────────────────────────────────────────────────

describe("applyFixDecisions", () => {
  test("open item + manter → Decisão gravada, applied", () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      const blocks = collectPendingReviewBlocks(cwd, MID, { slice: "S05" });
      const decisions = parseFixDecisions("R1: manter (falso positivo)\nR2: manter (n/a)");

      const { applied, pending } = applyFixDecisions(cwd, MID, blocks, decisions);

      assert.ok(applied.includes("R1"));
      const raw = readFileSync(reviewArtifactPath(cwd, MID, "S05"), "utf-8");
      assert.match(raw, /### R1[\s\S]*?- \*\*Decisão:\*\* manter \(falso positivo\)/);
      // R2 is conceded-sem-fix: "manter" does not apply to it (no Decisão field).
      assert.ok(pending.includes("R2"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("open item + follow-up → Decisão fixa 'follow-up (KNOWLEDGE)' + KNOWLEDGE.md appendado", () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      const blocks = collectPendingReviewBlocks(cwd, MID, { slice: "S05", id: "R1" });
      const decisions = parseFixDecisions("R1: follow-up (extrair helper compartilhado)");

      const { applied } = applyFixDecisions(cwd, MID, blocks, decisions);

      assert.deepEqual(applied, ["R1"]);
      const raw = readFileSync(reviewArtifactPath(cwd, MID, "S05"), "utf-8");
      assert.match(raw, /- \*\*Decisão:\*\* follow-up \(KNOWLEDGE\)/);

      const knowledgePath = join(cwd, ".gsd", "KNOWLEDGE.md");
      assert.ok(existsSync(knowledgePath), "KNOWLEDGE.md was created");
      const knowledge = readFileSync(knowledgePath, "utf-8");
      assert.match(knowledge, /## Review follow-ups/);
      assert.match(knowledge, /follow-up de S05 R1/);
      assert.match(knowledge, /extrair helper compartilhado/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("conceded-sem-fix + corrigida (commit X) → Correção gravada, applied", () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      const sha = initGitRepoWithCommit(cwd);
      const blocks = collectPendingReviewBlocks(cwd, MID, { slice: "S05", id: "R2" });
      const decisions = parseFixDecisions(`R2: corrigida (commit ${sha})`);

      const { applied, pending } = applyFixDecisions(cwd, MID, blocks, decisions);

      assert.deepEqual(applied, ["R2"]);
      assert.deepEqual(pending, []);
      const raw = readFileSync(reviewArtifactPath(cwd, MID, "S05"), "utf-8");
      assert.match(raw, new RegExp(`- \\*\\*Correção:\\*\\* aplicada — commit ${sha}`));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("R3: corrigida (commit <sha>) whose sha does NOT resolve to a real commit stays pending, never stamped", () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      initGitRepoWithCommit(cwd); // a real repo exists — the sha below is simply invented
      const blocks = collectPendingReviewBlocks(cwd, MID, { slice: "S05", id: "R2" });
      const decisions = parseFixDecisions("R2: corrigida (commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef)");

      const { applied, pending } = applyFixDecisions(cwd, MID, blocks, decisions);

      assert.deepEqual(applied, []);
      assert.deepEqual(pending, ["R2"]);
      const raw = readFileSync(reviewArtifactPath(cwd, MID, "S05"), "utf-8");
      assert.match(
        raw,
        /### R2[\s\S]*?- \*\*Correção:\*\* falhou — deferida para triagem final/,
        "an invented sha never overwrites the pre-existing Correção marker",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("R2: a write-back target that vanished between collection and write is NOT counted as applied", () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      const blocks = collectPendingReviewBlocks(cwd, MID, { slice: "S05", id: "R1" });
      // Simulate the artifact disappearing after the worker's dialogue was collected
      // but before the write-back runs (the exact race the R2 review item flagged).
      rmSync(reviewArtifactPath(cwd, MID, "S05"));

      const decisions = parseFixDecisions("R1: manter (razão)");
      const { applied, pending } = applyFixDecisions(cwd, MID, blocks, decisions);

      assert.deepEqual(applied, []);
      assert.deepEqual(pending, ["R1"], "a silently-ignored write failure must not be reported as applied");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("R1: a failed KNOWLEDGE.md append leaves the follow-up item pending, marker never flips", () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      // Force appendReviewFollowUps to fail: KNOWLEDGE.md's path is occupied by a directory.
      mkdirSync(join(cwd, ".gsd", "KNOWLEDGE.md"));

      const blocks = collectPendingReviewBlocks(cwd, MID, { slice: "S05", id: "R1" });
      const decisions = parseFixDecisions("R1: follow-up (nota que seria perdida)");

      const { applied, pending } = applyFixDecisions(cwd, MID, blocks, decisions);

      assert.deepEqual(applied, []);
      assert.deepEqual(pending, ["R1"]);
      const raw = readFileSync(reviewArtifactPath(cwd, MID, "S05"), "utf-8");
      assert.match(
        raw,
        /### R1[\s\S]*?- \*\*Decisão:\*\* deferido → triagem no fim da milestone/,
        "the REVIEW.md marker must NOT flip to 'follow-up (KNOWLEDGE)' when the KNOWLEDGE.md note failed to land",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("item sem decisão parseável permanece pendente", () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS05(cwd);
      const blocks = collectPendingReviewBlocks(cwd, MID, { slice: "S05" });
      const decisions = parseFixDecisions("garbage that matches nothing");

      const { applied, pending } = applyFixDecisions(cwd, MID, blocks, decisions);

      assert.deepEqual(applied, []);
      assert.deepEqual(pending.sort(), ["R1", "R2"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── router wiring ────────────────────────────────────────────────────────────

describe("/forge fix router wiring (forge-command.ts)", () => {
  function commandSource(): string {
    return readFileSync(join(process.cwd(), "src/resources/extensions/forge/commands/forge-command.ts"), "utf8");
  }

  test("SUBCOMMANDS/switch/help all know about fix", () => {
    const body = commandSource();
    assert.match(body, /"fix"/);
    assert.match(body, /case "fix":/);
    assert.match(body, /runFixCommand\(ctx, rest\)/);
    assert.match(body, /fix.*lista pendências de review/);
  });
});
