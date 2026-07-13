/** S03/T04: production-loop proof for the dialectic review gate. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForgeLoop, type SessionDriver } from "../auto/loop.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { updateState, readEvents } from "../state/store.ts";
import type { StateDoc } from "../state/types.ts";
import type { NextUnit } from "../state/dispatch.ts";
import { unitSlice } from "../state/dispatch.ts";
import type { UnitOutcome } from "../worker/rendezvous.ts";
import { reviewArtifactPath } from "../review/artifact.ts";
import type { ReviewDispatchOptions, ReviewDispatcher } from "../review/dispatch.ts";

const MID = "M-cockpit";
const SLICE = "S01";

function milestoneDir(cwd: string): string { return join(cwd, ".gsd", "milestones", MID); }
function done(summary: string): UnitOutcome {
  return { kind: "result", result: { status: "done", summary, artifacts: [] } };
}
function writeFixtures(cwd: string): void {
  const md = milestoneDir(cwd);
  mkdirSync(join(md, "slices", SLICE, "tasks", "T01"), { recursive: true });
  writeFileSync(join(md, `${MID}-ROADMAP.md`), "# Toy\n\n## Slices\n| ID | Nome | Risk | Depends | Status |\n|----|------|------|---------|--------|\n| S01 | Review slice | med | — | pending |\n");
  writeFileSync(join(md, "slices", SLICE, "S01-PLAN.md"), "---\nid: S01\ntitle: Review slice\n---\n# S01\n");
  writeFileSync(join(md, "slices", SLICE, "tasks", "T01", "T01-PLAN.md"), "---\nid: T01\nslice: S01\ntier: standard\nmust_haves:\n  truths:\n    - task executes\n  artifacts: []\n  key_links: []\n---\n# T01\n");
  writeFileSync(join(cwd, ".gsd", "models.md"), [
    "pools:", "  claude:", "    - claude-code/claude-opus-4-8", "  gpt:", "    - openai/gpt-5.5", "",
    "roles:", "  executor: [claude]", "  completer: [claude]", "  reviewer: [gpt, claude]", "  advocate: [claude, gpt]", "",
    "constraints:", "  reviewer_not_author: family", "  on_missing_pool: degrade+warn", "",
  ].join("\n"));
  writeFileSync(join(cwd, ".gsd", "prefs.md"), "review:\n  mode: enabled\n  rounds: 1\n  ask_in_auto: defer\n");
  // The review dispatcher intentionally reviews a real working-tree diff.
  writeFileSync(join(cwd, "baseline.txt"), "fixture change\n");
}

function seedGit(cwd: string): void {
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Forge Test"]);
  writeFileSync(join(cwd, "baseline.txt"), "baseline\n");
  execFileSync("git", ["-C", cwd, "add", "baseline.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "baseline"]);
}

class ScriptedReviewDispatcher implements ReviewDispatcher {
  readonly calls: ReviewDispatchOptions[] = [];
  async dispatch(prompt: string, opts: ReviewDispatchOptions): Promise<string> {
    this.calls.push(opts);
    if (prompt.includes("DEFENSE:")) return "### Rebuttal\n- R1: conceded — carried through\n- R2: maintained — still valid\n";
    if (prompt.includes("OBJECTIONS:")) return "### Defense\n- R1: conceded — real issue\n- R2: open — tradeoff\n";
    return "### High\n- R1 `src/example.ts:10` — unsafe claim — suggested fix: validate input — challenge: can this fail?\n### High\n- R2 `src/example.ts:20` — unclear claim — suggested fix: document behavior — challenge: is this intentional?\n";
  }
}

function makeDriver(cwd: string): SessionDriver & { units: NextUnit[] } {
  const units: NextUnit[] = [];
  return {
    units,
    async dispatch(unit) {
      units.push(unit);
      if (unit.type === "complete-slice") {
        writeFileSync(join(milestoneDir(cwd), "slices", SLICE, "S01-SUMMARY.md"), "# S01 summary\n");
      } else if (unit.type === "complete-milestone") {
        writeFileSync(join(milestoneDir(cwd), `${MID}-SUMMARY.md`), "# milestone summary\n");
      }
      return done(`${unit.type} done`);
    },
  };
}

async function withSandbox(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "forge-review-dialectic-driver-e2e-"));
  try { await fn(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

describe("S03/T04 — review dialectic through the production loop", () => {
  test("materializes the review before complete-slice and casts challenger across families", async () => {
    await withSandbox(async (cwd) => {
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      updateState(cwd, () => ({ milestone: MID }) as StateDoc);
      seedGit(cwd);
      writeFixtures(cwd);
      const session = new ForgeAutoSession();
      session.active = true;
      session.cwd = cwd;
      session.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;
      const review = new ScriptedReviewDispatcher();
      const driver = makeDriver(cwd);

      await runForgeLoop(session, { cwd, driver, reviewDispatcher: review, interactive: false });

      const artifact = reviewArtifactPath(cwd, MID, SLICE);
      assert.equal(existsSync(artifact), true);
      const text = readFileSync(artifact, "utf8");
      assert.match(text, /\*\*Outcome:\*\* 0 resolved · 1 conceded · 1 open/);
      assert.match(text, /## Abertas[\s\S]*R2/);
      assert.ok(driver.units.some((u) => u.type === "complete-slice"));
      assert.equal(review.calls[0]?.provider, "openai");
      assert.equal(review.calls[0]?.model, "openai/gpt-5.5");

      const events = readEvents(cwd);
      const reviewIndex = events.findIndex((e) => e.kind === "review" && e.slice === SLICE);
      const completionIndex = events.findIndex((e) => e.kind === "unit_dispatched" && e.unit === `complete/${SLICE}`);
      assert.ok(reviewIndex >= 0, "review event is journaled");
      assert.ok(completionIndex >= 0, "complete-slice dispatch is journaled");
      assert.ok(reviewIndex < completionIndex, "review precedes complete-slice dispatch");
      const authored = events.find((e) => e.kind === "unit_dispatched" && e.task === "T01");
      assert.equal(authored?.family, "claude");
    });
  });
});
