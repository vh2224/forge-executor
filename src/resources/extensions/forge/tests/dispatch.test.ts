import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deriveNextUnit } from "../state/dispatch.ts";
import type { PlansBySlice } from "../state/dispatch.ts";
import type { StateDoc, RoadmapSlice } from "../state/types.ts";
import { parseRoadmap } from "../state/parse.ts";

// Pure dispatch tests: no filesystem, synthetic state/roadmap/plans only.

function slice(id: string, status: string, depends: string[] = []): RoadmapSlice {
  return { id, name: `slice ${id}`, risk: "med", depends, status };
}

const EMPTY_STATE: StateDoc = { milestone: "M-1" };

describe("deriveNextUnit dispatch table", () => {
  // ── (a) not-done slice with no plan → plan-slice ───────────────────────────
  test("(a) first pending slice without a plan → plan-slice", () => {
    const roadmap = [slice("S01", "pending"), slice("S02", "pending")];
    const next = deriveNextUnit(EMPTY_STATE, roadmap, {});
    assert.deepStrictEqual(next, { type: "plan-slice", slice: "S01" });
  });

  test("(a) skips a done slice and plans the next unplanned one", () => {
    const roadmap = [slice("S01", "done"), slice("S02", "pending")];
    const next = deriveNextUnit(EMPTY_STATE, roadmap, {});
    assert.deepStrictEqual(next, { type: "plan-slice", slice: "S02" });
  });

  test("(a) an empty tasks list still counts as planned=false when planned flag is false", () => {
    const roadmap = [slice("S01", "pending")];
    const plans: PlansBySlice = { S01: { planned: false, tasks: [] } };
    const next = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    assert.deepStrictEqual(next, { type: "plan-slice", slice: "S01" });
  });

  // ── (b) planned slice with a pending task → execute-task ───────────────────
  test("(b) planned slice with a pending task → execute-task (first pending)", () => {
    const roadmap = [slice("S01", "pending")];
    const plans: PlansBySlice = {
      S01: {
        planned: true,
        tasks: [
          { id: "T01", status: "done" },
          { id: "T02", status: "pending" },
          { id: "T03", status: "pending" },
        ],
      },
    };
    const next = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    assert.deepStrictEqual(next, { type: "execute-task", slice: "S01", task: "T02" });
  });

  test("(b) planned slice with all tasks done + no SUMMARY → complete-slice (S03 gate)", () => {
    const roadmap = [slice("S01", "pending"), slice("S02", "pending")];
    const plans: PlansBySlice = {
      S01: {
        planned: true,
        tasks: [
          { id: "T01", status: "done" },
          { id: "T02", status: "done" },
        ],
      },
    };
    const next = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    assert.deepStrictEqual(next, { type: "complete-slice", slice: "S01" });
  });

  test("(b) planned slice with all tasks done but SUMMARY already written falls through to the next slice", () => {
    const roadmap = [slice("S01", "pending"), slice("S02", "pending")];
    const plans: PlansBySlice = {
      S01: {
        planned: true,
        summaryWritten: true,
        tasks: [
          { id: "T01", status: "done" },
          { id: "T02", status: "done" },
        ],
      },
    };
    const next = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    assert.deepStrictEqual(next, { type: "plan-slice", slice: "S02" });
  });

  // ── (c) all slices done → complete-milestone / null ────────────────────────
  test("(c) every slice done + milestone open + no M-SUMMARY → complete-milestone", () => {
    const roadmap = [slice("S01", "done"), slice("S02", "done")];
    const next = deriveNextUnit(EMPTY_STATE, roadmap, {});
    assert.deepStrictEqual(next, { type: "complete-milestone", milestone: "M-1" });
  });

  test("(c) every slice done but M-SUMMARY already written → null", () => {
    const roadmap = [slice("S01", "done"), slice("S02", "done")];
    const next = deriveNextUnit(EMPTY_STATE, roadmap, {}, { milestoneSummaryWritten: true });
    assert.equal(next, null);
  });

  test("(c) every slice done and milestone unit already flipped done → null", () => {
    const roadmap = [slice("S01", "done"), slice("S02", "done")];
    const state: StateDoc = {
      milestone: "M-1",
      units: [{ id: "M-1", type: "milestone", status: "done" }],
    };
    const next = deriveNextUnit(state, roadmap, {});
    assert.equal(next, null);
  });

  test("(c) planned slice all done + SUMMARY written but slice not yet flipped → null (flip-pending window)", () => {
    // SUMMARY exists (complete-slice ran) but the STATE flip hasn't landed yet
    // (the window until T02 migrates the flip). Dispatch must NOT re-emit
    // complete-slice, and the milestone isn't fully complete → null.
    const roadmap = [slice("S01", "pending")];
    const plans: PlansBySlice = {
      S01: { planned: true, summaryWritten: true, tasks: [{ id: "T01", status: "done" }] },
    };
    const next = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    assert.equal(next, null);
  });

  test("empty roadmap → null", () => {
    assert.equal(deriveNextUnit(EMPTY_STATE, [], {}), null);
  });

  // ── STATE unit override ────────────────────────────────────────────────────
  test("a slice marked done in STATE units is treated as complete even if roadmap says pending", () => {
    const roadmap = [slice("S01", "pending"), slice("S02", "pending")];
    const state: StateDoc = {
      milestone: "M-1",
      units: [{ id: "S01", type: "slice", status: "done" }],
    };
    const next = deriveNextUnit(state, roadmap, {});
    assert.deepStrictEqual(next, { type: "plan-slice", slice: "S02" });
  });

  test("plans argument defaults to empty when omitted → plan-slice on first pending", () => {
    const roadmap = [slice("S01", "pending")];
    const next = deriveNextUnit(EMPTY_STATE, roadmap);
    assert.deepStrictEqual(next, { type: "plan-slice", slice: "S01" });
  });

  test("deterministic: repeated calls yield identical results", () => {
    const roadmap = [slice("S01", "done"), slice("S02", "pending")];
    const plans: PlansBySlice = {
      S02: { planned: true, tasks: [{ id: "T01", status: "pending" }] },
    };
    const a = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    const b = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a, { type: "execute-task", slice: "S02", task: "T01" });
  });

  // ── depends: topological order (M1R-5) ─────────────────────────────────────
  test("out-of-order roadmap (B before A, B depends A) resolves A first", () => {
    const roadmap = [slice("B", "pending", ["A"]), slice("A", "pending")];
    const next = deriveNextUnit(EMPTY_STATE, roadmap, {});
    assert.deepStrictEqual(next, { type: "plan-slice", slice: "A" });
  });

  test("a dependent slice is never dispatched while its dependency is pending", () => {
    const roadmap = [slice("A", "pending"), slice("B", "pending", ["A"])];
    const plans: PlansBySlice = {
      A: { planned: true, tasks: [{ id: "T01", status: "pending" }] },
      B: { planned: true, tasks: [{ id: "T01", status: "pending" }] },
    };
    const next = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    // A is dispatchable (no deps); B must not be picked even though it
    // appears later and is fully planned.
    assert.deepStrictEqual(next, { type: "execute-task", slice: "A", task: "T01" });
  });

  test("a cycle of depends (A→B, B→A) throws a clear Error, never returns null", () => {
    const roadmap = [slice("A", "pending", ["B"]), slice("B", "pending", ["A"])];
    assert.throws(() => deriveNextUnit(EMPTY_STATE, roadmap, {}), /dependência insolúvel/);
  });

  test("topo-ordered roadmap (happy path) is unaffected by the deps check", () => {
    const roadmap = [
      slice("A", "done"),
      slice("B", "pending", ["A"]),
      slice("C", "pending", ["B"]),
    ];
    const next = deriveNextUnit(EMPTY_STATE, roadmap, {});
    assert.deepStrictEqual(next, { type: "plan-slice", slice: "B" });
  });

  test("a depends id absent from the roadmap is treated as unsatisfied, not ignored", () => {
    const roadmap = [slice("A", "pending", ["GHOST"])];
    assert.throws(() => deriveNextUnit(EMPTY_STATE, roadmap, {}), /dependência insolúvel/);
  });

  // ── R4: stuck-non-cyclic slice vs genuine cycle ────────────────────────────
  test("R4: a stuck slice (tasks all done, status not flipped) with a dependent → null, NOT a throw", () => {
    // A is stuck (F4): fully planned, every task done, but the slice status
    // never flipped to `done`. B depends on A. The pre-R4 code pushed B into
    // blockedIds and threw a spurious "cycle" — crashing `/forge auto`. There is
    // NO real cycle here (A depends on nothing), so deriveNextUnit must return
    // null and let reconcileCompletion degrade the stuck slice safely.
    // A is stuck in the flip-pending window: SUMMARY written (so dispatch does
    // NOT re-emit complete-slice) but the STATE flip hasn't landed, so A falls
    // through and B is blocked on it. No real cycle → null, never a throw.
    const roadmap = [slice("A", "pending"), slice("B", "pending", ["A"])];
    const plans: PlansBySlice = {
      A: { planned: true, summaryWritten: true, tasks: [{ id: "T01", status: "done" }] },
      B: { planned: true, tasks: [{ id: "T01", status: "pending" }] },
    };
    assert.equal(
      deriveNextUnit(EMPTY_STATE, roadmap, plans),
      null,
      "a non-cyclic stuck-slice block must return null, never throw",
    );
  });

  test("R4: a genuine 3-node cycle (A→B→C→A) still throws a clear Error", () => {
    const roadmap = [
      slice("A", "pending", ["C"]),
      slice("B", "pending", ["A"]),
      slice("C", "pending", ["B"]),
    ];
    assert.throws(() => deriveNextUnit(EMPTY_STATE, roadmap, {}), /dependência insolúvel/);
  });

  // aceite #4 — depends: caminho INTEGRADO ROADMAP.md real (via parseRoadmap) →
  // deriveNextUnit, não apenas o RoadmapSlice[] sintético acima. Fecha o gap:
  // a fronteira unit-level já era coberta (M1R-5, casos acima), mas nenhum
  // caso saía de uma tabela markdown real fora de ordem.
  test("aceite #4 — depends: ROADMAP.md real fora de ordem (B antes de A, B depends A) via parseRoadmap resolve A primeiro", () => {
    const md = [
      "# Toy roadmap",
      "",
      "| ID | Nome | Risk | Depends | Status |",
      "|----|------|------|---------|--------|",
      "| S02 | Slice B | med | S01 | pending |",
      "| S01 | Slice A | med | — | pending |",
      "",
    ].join("\n");
    const roadmap = parseRoadmap(md);
    assert.deepStrictEqual(
      roadmap.map((s) => s.id),
      ["S02", "S01"],
      "row order in the markdown table is preserved by parseRoadmap (S02 before S01)",
    );
    const next = deriveNextUnit(EMPTY_STATE, roadmap, {});
    assert.deepStrictEqual(
      next,
      { type: "plan-slice", slice: "S01" },
      "S01 must be derived first even though S02 appears earlier in the real markdown table",
    );
  });

  test("depends satisfied via STATE unit override (not just roadmap row status)", () => {
    const roadmap = [slice("A", "pending"), slice("B", "pending", ["A"])];
    const state: StateDoc = {
      milestone: "M-1",
      units: [{ id: "A", type: "slice", status: "done" }],
    };
    const next = deriveNextUnit(state, roadmap, {});
    assert.deepStrictEqual(next, { type: "plan-slice", slice: "B" });
  });
});

// ── S03: completion-unit gates ───────────────────────────────────────────────
describe("deriveNextUnit completion gates (S03)", () => {
  test("complete-slice fires for the FIRST all-done, summary-less slice in roadmap order", () => {
    const roadmap = [slice("S01", "pending"), slice("S02", "pending")];
    const plans: PlansBySlice = {
      S01: { planned: true, tasks: [{ id: "T01", status: "done" }] },
      S02: { planned: true, tasks: [{ id: "T01", status: "done" }] },
    };
    const next = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    assert.deepStrictEqual(next, { type: "complete-slice", slice: "S01" });
  });

  test("a planned slice with ZERO tasks never emits complete-slice (falls through)", () => {
    // planned=true, tasks=[] → not a completable slice; falls through and, with
    // no other work and roadmap not fully complete, yields null.
    const roadmap = [slice("S01", "pending")];
    const plans: PlansBySlice = { S01: { planned: true, tasks: [] } };
    assert.equal(deriveNextUnit(EMPTY_STATE, roadmap, plans), null);
  });

  test("a pending task still wins over the completion gate → execute-task", () => {
    const roadmap = [slice("S01", "pending")];
    const plans: PlansBySlice = {
      S01: {
        planned: true,
        tasks: [
          { id: "T01", status: "done" },
          { id: "T02", status: "pending" },
        ],
      },
    };
    const next = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    assert.deepStrictEqual(next, { type: "execute-task", slice: "S01", task: "T02" });
  });

  test("complete-slice for an earlier slice precedes complete-milestone", () => {
    // S01 done+flipped, S02 all tasks done but no SUMMARY → complete-slice S02
    // must win over any milestone-close consideration.
    const roadmap = [slice("S01", "done"), slice("S02", "pending")];
    const plans: PlansBySlice = {
      S02: { planned: true, tasks: [{ id: "T01", status: "done" }] },
    };
    const next = deriveNextUnit(EMPTY_STATE, roadmap, plans);
    assert.deepStrictEqual(next, { type: "complete-slice", slice: "S02" });
  });

  test("complete-milestone carries the milestone id from state.milestone", () => {
    const roadmap = [slice("S01", "done")];
    const state: StateDoc = { milestone: "M-XYZ" };
    const next = deriveNextUnit(state, roadmap, {});
    assert.deepStrictEqual(next, { type: "complete-milestone", milestone: "M-XYZ" });
  });

  test("empty roadmap is NOT a completed milestone → null (no vacuous complete-milestone)", () => {
    assert.equal(deriveNextUnit(EMPTY_STATE, [], {}), null);
  });
});

test("task ids do NOT collide across slices — S01's done T01 never satisfies S02/T01 (slice-qualified units)", () => {
  // Seen live 2026-07-11 (M3 forge-merge): after S01 completed, STATE held
  // T01..T04 done (from S01); deriving S02 (5 tasks) skipped straight to T05
  // because persistedUnitStatus matched task entries by bare id.
  const roadmap = [
    { id: "S01", name: "a", risk: "low", depends: [], status: "done" },
    { id: "S02", name: "b", risk: "high", depends: ["S01"], status: "pending" },
  ] as never;
  const state = {
    milestone: "M-x",
    units: [
      { id: "S01", type: "slice", status: "done" },
      { id: "T01", type: "task", status: "done", slice: "S01" },
      { id: "T02", type: "task", status: "done", slice: "S01" },
    ],
  } as never;
  const plans = {
    S01: { planned: true, tasks: [{ id: "T01", status: "done" }, { id: "T02", status: "done" }], summaryWritten: true },
    S02: { planned: true, tasks: [{ id: "T01", status: "pending" }, { id: "T02", status: "pending" }], summaryWritten: false },
  } as never;
  const next = deriveNextUnit(state, roadmap, plans, {});
  assert.deepEqual(next, { type: "execute-task", slice: "S02", task: "T01" });
});
