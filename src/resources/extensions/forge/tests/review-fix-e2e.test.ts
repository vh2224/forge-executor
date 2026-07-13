/**
 * S02/T04 — through-the-driver proof for `/forge fix` (ROADMAP §S02). Like
 * `research-models-e2e.test.ts` (its template), this suite exercises the
 * REAL `dispatchUnitViaNewSession` (CODING-STANDARDS §Through-the-driver):
 * only the command-handler's `ExtensionCommandContext` (`newSession`/
 * `withSession`/`sendMessage`) is a fake, worker-compliant stand-in — the
 * exact seam `research-models-e2e.test.ts` and `tests/driver.test.ts` already
 * use. `deliverUnitResult` (the correlated rendezvous delivery) is real.
 *
 * (A) happy path: dispatch real, the composed prompt carries BOTH pending
 *     blocks' verbatim dialogue + the diff-range line + `REVIEW_FIX_PROMPT`'s
 *     body; the scripted worker reports one decision per item; the command's
 *     write-back lands the exact `- **Decisão:**`/`- **Correção:**` lines on
 *     disk; `collectPendingReviewItems` comes back empty; the journal carries
 *     ONLY the two advisory kinds (D-S02-5), never the loop's own
 *     `unit_dispatched`/`unit_result`; and the dispatched event's authorship
 *     comes from the resolved `executor` pool (D-S02-1/role fallback), not a
 *     hardcoded value.
 * (B) follow-up: a `follow-up (nota)` decision writes the fixed
 *     `follow-up (KNOWLEDGE)` marker to `S##-REVIEW.md` and appends the real
 *     note under `.gsd/KNOWLEDGE.md § Review follow-ups` (D-S02-4).
 * (C) alvo pontual: `S06:R1` inlines ONLY R1's block into the prompt — R2's
 *     block never reaches the payload.
 * (D) fronteira dura: `state/dispatch.ts` (`deriveNextUnit`'s source) never
 *     mentions `review-fix` — the auto-loop cannot auto-dispatch this unit
 *     even by accident (same technique as research-models-e2e's scenario B).
 * (E) guard de reentrância: an already-active session refuses to dispatch a
 *     second time.
 *
 * **Nota de honestidade** (same as research-models-e2e/T01-PLAN §Context):
 * every scripted worker below honors the D-S02-3 write-back contract (never
 * edits REVIEW.md/KNOWLEDGE.md itself, emits the exact decision grammar) —
 * this proves the PLUMBING (dispatch, payload, correlation, write-back), not
 * that a real LLM worker would never violate the prompt's instructions; a
 * non-compliant worker's items simply stay pending (falha segura).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { runFixCommand } from "../commands/fix-command.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";
import { updateState } from "../state/store.ts";
import {
  renderReview,
  applyDecision,
  applyConcededFix,
  reviewArtifactPath,
  collectPendingReviewItems,
  collectPendingReviewBlocks,
} from "../review/artifact.ts";
import type { ReviewArtifactMeta } from "../review/artifact.ts";
import type { ResolveReviewResult, ResolvedReviewItem } from "../review/resolve.ts";

const MID = "M-test";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "forge-fix-e2e-"));
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
  return { milestoneId: MID, slice, sliceTitle: "fix e2e target", reviewedOn: "2026-07-12", rounds: 1 };
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

/** Seeds S06 with one open item (R1, deferred marker) + one conceded-sem-fix item (R2, failed marker) — the exact must-have fixture shape. */
function seedS06(cwd: string): void {
  const md = renderReview(
    meta("S06"),
    result([item("R1", "open", { challenge: "real?" }), item("R2", "conceded")]),
  );
  writeArtifact(cwd, "S06", md);
  const path = reviewArtifactPath(cwd, MID, "S06");
  applyDecision(path, "R1", "deferido → triagem no fim da milestone");
  applyConcededFix(path, "R2", "failed");
}

function writeState(cwd: string, milestone: string): void {
  updateState(cwd, () => ({ milestone }));
}

/** Deterministic single-entry executor pool — so the dispatched event's authorship is asserted against a known ref, never guessed. */
function writeExecutorPoolConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "pools:\n  demo:\n    - prov-a/model-x\n\nroles:\n  executor:\n    - demo\n",
  );
}

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Walks up from this test file to the repo root (`pnpm-workspace.yaml`) — same pattern as `research-models-e2e.test.ts`. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("repo root (pnpm-workspace.yaml) not found above test file");
    }
    dir = parent;
  }
  return dir;
}

/** A fake command context whose `newSession` runs `onSendMessage` synchronously — no real pi session involved. */
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

/** A fake ctx that THROWS if `newSession` is ever called — proves no dispatch was attempted (guard scenarios). */
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
      throw new Error("newSession must not be called on a guarded path");
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

describe("S02/T04 — /forge fix through-the-driver", () => {
  test("(A) happy path: real dispatch, prompt carries both blocks + diff range + REVIEW_FIX_PROMPT body, write-back lands, pendências zeram, journal advisory-only, autoria via executor pool", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS06(cwd);
      writeExecutorPoolConfig(cwd);
      const sha = initGitRepoWithCommit(cwd); // R3: the sha reported below must resolve to a real commit

      const blocksBefore = collectPendingReviewBlocks(cwd, MID, { slice: "S06" });
      assert.equal(blocksBefore.length, 2, "sandbox seeded with R1 (open) + R2 (conceded-sem-fix)");

      const session = new ForgeAutoSession();
      let capturedPrompt = "";
      const { ctx } = fakeCtx(cwd, (content) => {
        capturedPrompt = content;
        deliverUnitResult(
          {
            status: "done",
            summary: `R1: manter (razão)\nR2: corrigida (commit ${sha})`,
            artifacts: [],
          },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runFixCommand(ctx, ["S06"], session));

      // Prompt carries both blocks' verbatim dialogue, the diff-range line
      // (sandbox has no journal/git — degrades to the documented fallback),
      // and REVIEW_FIX_PROMPT's body verbatim.
      for (const block of blocksBefore) {
        assert.ok(capturedPrompt.includes(block.dialogue), `prompt carries ${block.id}'s dialogue verbatim`);
      }
      assert.match(capturedPrompt, /Diff range: `git diff HEAD`/, "diff-range line inlined, degraded fallback");
      assert.match(capturedPrompt, /You are a GSD review-fix executor\./, "REVIEW_FIX_PROMPT body carried verbatim");
      assert.match(
        capturedPrompt,
        /^## Itens de review a corrigir \(inlinados\)$/m,
        "the conditional inline section header is rendered",
      );

      // Write-back landed exactly as the worker's decision lines dictated.
      const raw = readFileSync(reviewArtifactPath(cwd, MID, "S06"), "utf-8");
      assert.match(raw, /### R1[\s\S]*?- \*\*Decisão:\*\* manter \(razão\)/, "R1 Decisão gravada");
      assert.match(
        raw,
        new RegExp(`### R2[\\s\\S]*?- \\*\\*Correção:\\*\\* aplicada — commit ${sha}`),
        "R2 Correção gravada",
      );

      assert.deepEqual(collectPendingReviewItems(cwd, MID), [], "no pendências remain");

      // Journal is strictly advisory (D-S02-5) — the loop's own kinds never appear.
      const events = readEvents(cwd);
      const kinds = events.map((e) => e.kind);
      assert.deepEqual(
        new Set(kinds),
        new Set(["review_fix_dispatched", "review_fix_result"]),
        "journal carries ONLY the two review-fix advisory kinds",
      );
      assert.ok(!kinds.includes("unit_dispatched"), "the loop's own unit_dispatched kind never appears");
      assert.ok(!kinds.includes("unit_result"), "the loop's own unit_result kind never appears");

      // Authorship on review_fix_dispatched comes from the resolved executor pool.
      const dispatched = events.find((e) => e.kind === "review_fix_dispatched");
      assert.ok(dispatched, "review_fix_dispatched event was journaled");
      assert.equal(dispatched!.model, "prov-a/model-x", "authorship resolved via the configured executor pool");
      assert.equal(dispatched!.provider, "prov-a");

      assert.equal(session.active, false, "the finally ran — session reset");
      assert.equal(session.cmdCtx, null, "reset() cleared cmdCtx");
      assert.equal(session.currentUnit, null, "reset() cleared currentUnit");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(B) follow-up: 'R1: follow-up (nota)' grava '- **Decisão:** follow-up (KNOWLEDGE)' e KNOWLEDGE.md ganha a entrada", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS06(cwd);

      const session = new ForgeAutoSession();
      const { ctx } = fakeCtx(cwd, (_content) => {
        deliverUnitResult(
          { status: "done", summary: "R1: follow-up (extrair helper compartilhado)", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runFixCommand(ctx, ["S06:R1"], session));

      const raw = readFileSync(reviewArtifactPath(cwd, MID, "S06"), "utf-8");
      assert.match(raw, /- \*\*Decisão:\*\* follow-up \(KNOWLEDGE\)/, "the fixed marker replaces the open item's Decisão");

      const knowledgePath = join(cwd, ".gsd", "KNOWLEDGE.md");
      assert.ok(existsSync(knowledgePath), "KNOWLEDGE.md was created");
      const knowledge = readFileSync(knowledgePath, "utf-8");
      assert.match(knowledge, /## Review follow-ups/, "section created");
      assert.match(knowledge, /follow-up de S06 R1/, "entry references the item");
      assert.match(knowledge, /extrair helper compartilhado/, "the real note landed, not the fixed marker");

      // R2 was not targeted — remains pending untouched.
      const pending = collectPendingReviewItems(cwd, MID);
      assert.deepEqual(pending.map((p) => p.id).sort(), ["R2"]);
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(C) alvo pontual: /forge fix S06:R1 inlina SÓ o bloco R1 no prompt (R2 ausente do payload)", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS06(cwd);

      const session = new ForgeAutoSession();
      let capturedPrompt = "";
      const { ctx } = fakeCtx(cwd, (content) => {
        capturedPrompt = content;
        deliverUnitResult(
          { status: "done", summary: "R1: manter (ok)", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runFixCommand(ctx, ["S06:R1"], session));

      assert.match(capturedPrompt, /### R1 — `src\/R1\.ts:10`/, "R1's block is inlined");
      assert.doesNotMatch(capturedPrompt, /### R2\b/, "R2's block never reaches the payload");
      assert.doesNotMatch(capturedPrompt, /claim R2/, "R2's claim text never reaches the payload");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(D) fronteira dura: state/dispatch.ts (deriveNextUnit's source) has zero occurrences of 'review-fix'", () => {
    const src = readFileSync(
      join(repoRoot(), "src", "resources", "extensions", "forge", "state", "dispatch.ts"),
      "utf8",
    );
    assert.doesNotMatch(src, /review-fix/, "deriveNextUnit never learns about review-fix");
  });

  test("(E) reentrância: session.active=true ⇒ recusa sem despachar", async () => {
    const cwd = tmp();
    try {
      writeState(cwd, MID);
      seedS06(cwd);
      const session = new ForgeAutoSession();
      session.active = true; // simulate an already-running loop/dispatch
      const { ctx, notifications } = guardedFakeCtx(cwd);

      await assert.doesNotReject(runFixCommand(ctx, ["S06"], session));

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.[1], "warning");
      assert.match(notifications[0]?.[0] ?? "", /loop já ativo/);
      // The guard does not clobber the already-active session.
      assert.equal(session.active, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
