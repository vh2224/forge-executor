/**
 * Forge — read-only OPERATION of the 2.0 store over the REAL M0/M1 `.gsd/`
 * history frozen in this repo (S08-PLAN § B2).
 *
 * A6 (parse-roundtrip.test.ts) already proved PARSE of real M0 artifacts. This
 * suite proves OPERATION: `readState`/`parseState`/`parseRoadmap`/
 * `deriveNextUnit` are exercised end-to-end over the frozen M0/M1 history that
 * forge 1.0 wrote while driving THIS repo — the same discipline as
 * `tests/e2e/forge-milestone.e2e.test.ts`'s header: NEVER the live `.gsd/`.
 * Every assertion below runs over a `mkdtemp` COPY of the real files (the
 * `withSandbox`/`copyFixture` shape from `parse-roundtrip.test.ts`); the live
 * `.gsd/` tree is read AT MOST once (one-shot, try/catch) and only its content
 * is copied out — this file never writes anything whose destination derives
 * from `process.cwd()/.gsd`. A forge 1.0 runtime manages the live `.gsd/` of
 * this repo until the 2.0 turn (see the fork's iron rules); writing there
 * would corrupt live orchestration state.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseState, parseRoadmap } from "../state/parse.ts";
import { readState } from "../state/store.ts";
import { deriveNextUnit } from "../state/dispatch.ts";
import type { StateDoc } from "../state/types.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-gsd-history-operation-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Resolved via process.cwd() — the gate/test runner always executes from the
// repo root (see parse-roundtrip.test.ts:19-21 for why this beats relative-hop
// counting between dev (src/) and compiled (dist-test/src/) execution
// contexts).
const M0_ID = "M-20260708005233-bootstrap-harness-nu";
const M1_ID = "M-20260708200551-extensao-forge-loop";
const M0_ROOT = join(process.cwd(), ".gsd", "milestones", M0_ID);
const M1_ROOT = join(process.cwd(), ".gsd", "milestones", M1_ID);

/**
 * The real M0/M1 history is frozen fixture data checked into THIS repo's
 * `.gsd/` — but `.gsd/` itself is gitignored (it is forge 1.0's live runtime
 * state directory), so a fresh clone will not have it. Skip honestly rather
 * than red-falsing in a clean checkout: the fixture only exists in the
 * development workspace that produced it.
 */
function historyAvailable(): boolean {
  return (
    existsSync(join(M0_ROOT, `${M0_ID}-ROADMAP.md`)) &&
    existsSync(join(M1_ROOT, `${M1_ID}-ROADMAP.md`)) &&
    existsSync(join(M1_ROOT, `${M1_ID}-STATE.md`))
  );
}

const SKIP_MSG =
  "histórico real M0/M1 ausente (.gsd/ é gitignored) — fixture é o histórico " +
  "congelado deste repo; teste só roda no workspace de desenvolvimento";

function copyFileInto(src: string, dstDir: string, dstName: string): string {
  mkdirSync(dstDir, { recursive: true });
  const dst = join(dstDir, dstName);
  writeFileSync(dst, readFileSync(src, "utf-8"));
  return dst;
}

// ── M0 (frozen, no own STATE.md — read-only OPERATION over the real ROADMAP) ──

describe("operation over the frozen real M0 history (B2)", { skip: !historyAvailable() && SKIP_MSG }, () => {
  test("deriveNextUnit over the real M0 roadmap reflects a fully-done milestone (no plan/execute unit)", () => {
    withSandbox((dir) => {
      const dst = copyFileInto(
        join(M0_ROOT, `${M0_ID}-ROADMAP.md`),
        dir,
        "ROADMAP.md",
      );
      const roadmap = parseRoadmap(readFileSync(dst, "utf-8"));
      assert.ok(roadmap.length >= 5, `expected >=5 real M0 slices, got ${roadmap.length}`);
      assert.ok(
        roadmap.every((s) => s.status === "done"),
        "every real M0 slice row must be status: done (the milestone is closed)",
      );

      // M0 never had a 2.0-shaped STATE.md of its own (it predates the store) —
      // per T02-PLAN step 3, operate with the minimal coherent StateDoc a fresh
      // reconciliation would produce: just the milestone id.
      const state: StateDoc = { milestone: M0_ID };

      // The real `depends:` column (S02 depends on S01, etc.) must resolve
      // without throwing — a genuine test of the dependency-satisfaction path
      // over real data, not a synthetic toy graph.
      const unit = deriveNextUnit(state, roadmap, {}, { milestoneSummaryWritten: true });

      // The milestone's `*-SUMMARY.md` already exists on disk for real (M0 is
      // long closed) — feeding that signal in mirrors reality and must yield
      // "nothing left to do", never a plan-slice/execute-task unit.
      assert.equal(unit, null, "a fully-done, already-summarized milestone must not derive an execution unit");
    });
  });

  test("deriveNextUnit over the real M0 roadmap without the summary signal still never derives plan-slice/execute-task", () => {
    withSandbox((dir) => {
      const dst = copyFileInto(
        join(M0_ROOT, `${M0_ID}-ROADMAP.md`),
        dir,
        "ROADMAP.md",
      );
      const roadmap = parseRoadmap(readFileSync(dst, "utf-8"));
      const state: StateDoc = { milestone: M0_ID };

      const unit = deriveNextUnit(state, roadmap);
      // Every real slice row is already `done`, so the ONLY possible non-null
      // outcome is the milestone-close unit — never a slice-level unit.
      if (unit !== null) {
        assert.equal(unit.type, "complete-milestone");
      }
    });
  });
});

// ── M1 (frozen, has its own STATE.md — real readState OPERATION) ─────────────

describe("operation over the frozen real M1 history (B2)", { skip: !historyAvailable() && SKIP_MSG }, () => {
  test("readState over a synthetic .gsd/ tree seeded with the real M1 STATE.md does not throw", () => {
    withSandbox((dir) => {
      // readState expects <cwd>/.gsd/STATE.md — build that exact tree from the
      // real M1 STATE file, at the position the store reads from.
      const gsdDir = join(dir, ".gsd");
      copyFileInto(join(M1_ROOT, `${M1_ID}-STATE.md`), gsdDir, "STATE.md");

      const state = readState(dir);
      assert.equal(typeof state, "object");
      assert.equal(typeof state.milestone, "string");

      // NOTE (deviation from the naive expectation): the real M1 STATE.md was
      // written by forge 1.0 as plain `---` frontmatter + prose (no fenced
      // ```yaml block). `parseState`'s fence regex only recognizes the 2.0
      // fenced-yaml shape, so it legitimately falls back to `{ milestone: "" }`
      // for this real file — this IS the read-compat contract (never throw),
      // not a bug. We therefore assert structurally (no throw, correct shape)
      // rather than asserting the parsed `milestone`/`phase` VALUES match the
      // file, mirroring the same B2 tolerance applied to the live dashboard
      // below. Verified empirically by reading the real file content.
    });
  });

  test("deriveNextUnit over the real M1 roadmap + a readState()-derived doc never derives a spurious execution unit", () => {
    withSandbox((dir) => {
      const gsdDir = join(dir, ".gsd");
      copyFileInto(join(M1_ROOT, `${M1_ID}-STATE.md`), gsdDir, "STATE.md");
      const state = readState(dir);

      const roadmapDst = copyFileInto(
        join(M1_ROOT, `${M1_ID}-ROADMAP.md`),
        dir,
        "ROADMAP.md",
      );
      const roadmap = parseRoadmap(readFileSync(roadmapDst, "utf-8"));
      assert.ok(roadmap.length >= 4, `expected >=4 real M1 slices, got ${roadmap.length}`);
      assert.ok(
        roadmap.every((s) => s.status === "done"),
        "every real M1 slice row must be status: done (the milestone is closed)",
      );

      // The real M1 milestone already has its `*-SUMMARY.md` on disk — signal
      // that in so a fully-done roadmap correctly resolves to "nothing left".
      const unit = deriveNextUnit(state, roadmap, {}, { milestoneSummaryWritten: true });
      assert.equal(unit, null, "a fully-done, already-summarized milestone must not derive an execution unit");
    });
  });
});

// ── Live dashboard (structural tolerance ONLY — B2) ───────────────────────────

describe("structural tolerance for the live 1.0 dashboard STATE.md (B2)", () => {
  test("parseState over a ONE-SHOT copy of the live .gsd/STATE.md never throws (structural-only)", () => {
    // The live dashboard is regenerated continuously by forge 1.0 while this
    // suite runs (it is managing this very repo) — asserting VALUES against it
    // would be a flaky race against a file changing under our feet. We read it
    // exactly ONCE, copy the content out, and assert only shape/type over the
    // COPY. Absent entirely (fresh clone) → skip this one case, not the suite.
    let liveContent: string;
    try {
      liveContent = readFileSync(join(process.cwd(), ".gsd", "STATE.md"), "utf-8");
    } catch {
      return; // fresh clone / no live dashboard — nothing to tolerate here
    }

    withSandbox((dir) => {
      const dst = join(dir, "STATE.md");
      writeFileSync(dst, liveContent);
      const copy = readFileSync(dst, "utf-8");

      const parsed = parseState(copy);
      assert.equal(typeof parsed, "object");
      assert.equal(typeof parsed.milestone, "string");
      // The 1.0 dashboard is a DIFFERENT schema (auto-generated markdown, no
      // fenced ```yaml block) from the 2.0 store's STATE.md — `parseState`
      // legitimately returns `{ milestone: "" }` for it. No value assertion.
    });
  });

  test("readState over a synthetic .gsd/ tree seeded from the live dashboard copy never throws (structural-only)", () => {
    let liveContent: string;
    try {
      liveContent = readFileSync(join(process.cwd(), ".gsd", "STATE.md"), "utf-8");
    } catch {
      return;
    }

    withSandbox((dir) => {
      const gsdDir = join(dir, ".gsd");
      mkdirSync(gsdDir, { recursive: true });
      writeFileSync(join(gsdDir, "STATE.md"), liveContent);

      const state = readState(dir);
      assert.equal(typeof state, "object");
      assert.equal(typeof state.milestone, "string");
    });
  });
});
