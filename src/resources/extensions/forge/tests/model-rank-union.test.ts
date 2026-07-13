import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { rankUnion, EPSILON, type UnionCandidate, type RankUnionOpts } from "../auto/model-rank-union.ts";

/** Small closed-world capability table for the tests below — not the real matrix file. */
function capabilityTable(scores: Record<string, number>): (domain: string, ref: string) => number | undefined {
  return (_domain, ref) => scores[ref];
}

describe("rankUnion — cross-pool win, order-independent (addendum principle 1)", () => {
  test("higher-score candidate wins the union even when its pool comes AFTER the lower-score pool", () => {
    const candidates: UnionCandidate[] = [
      { ref: "claude-code/claude-sonnet-5", poolIndex: 0, posIndex: 0 }, // earlier pool, lower score
      { ref: "openai-codex/gpt-5.6-terra", poolIndex: 1, posIndex: 0 }, // later pool, higher score
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({
        "openai-codex/gpt-5.6-terra": 0.9,
        "claude-code/claude-sonnet-5": 0.65,
      }),
    };
    const result = rankUnion(candidates, opts);
    assert.ok(result);
    assert.equal(result.ref, "openai-codex/gpt-5.6-terra");
    assert.equal(
      result.reason,
      "capability:infra openai-codex/gpt-5.6-terra 0.90 > claude-code/claude-sonnet-5 0.65",
    );
  });

  test("pool order reversed still picks the same winner (rank is order-independent)", () => {
    const candidates: UnionCandidate[] = [
      { ref: "openai-codex/gpt-5.6-terra", poolIndex: 0, posIndex: 0 },
      { ref: "claude-code/claude-sonnet-5", poolIndex: 1, posIndex: 0 },
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({
        "openai-codex/gpt-5.6-terra": 0.9,
        "claude-code/claude-sonnet-5": 0.65,
      }),
    };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.ref, "openai-codex/gpt-5.6-terra");
  });
});

describe("rankUnion — guard: zero scored candidates", () => {
  test("no candidate has a matrix row for the domain ⇒ null (caller falls back to legacy walk)", () => {
    const candidates: UnionCandidate[] = [
      { ref: "claude-code/claude-sonnet-5", poolIndex: 0, posIndex: 0 },
      { ref: "openai/gpt-5.5", poolIndex: 1, posIndex: 0 },
    ];
    const opts: RankUnionOpts = { domain: "infra", capabilityOf: () => undefined };
    assert.equal(rankUnion(candidates, opts), null);
  });

  test("empty candidate list ⇒ null", () => {
    const opts: RankUnionOpts = { domain: "infra", capabilityOf: () => 0.5 };
    assert.equal(rankUnion([], opts), null);
  });
});

describe("rankUnion — ε-group: clamp penalty decides", () => {
  test("non-clamped candidate wins over a higher-scored but clamped rival within ε", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/high-score-clamped", poolIndex: 0, posIndex: 0 },
      { ref: "provider/lower-score-open", poolIndex: 1, posIndex: 0 },
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({
        "provider/high-score-clamped": 0.88,
        "provider/lower-score-open": 0.85, // Δ = 0.03 ≤ EPSILON
      }),
      requestedEffort: "high",
      effortCeilingOf: (ref) => (ref === "provider/high-score-clamped" ? "medium" : "high"),
    };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.ref, "provider/lower-score-open");
    assert.match(result!.reason, /\(provider\/high-score-clamped clamped medium\)$/);
    // Winner (0.85) scores BELOW the clamped runner-up (0.88) — a tie-break, not a score
    // comparison, so the reason must use "vs", never ">" (R1: ">" would assert a false
    // capability ordering the scores contradict).
    assert.equal(
      result?.reason,
      "capability:infra provider/lower-score-open 0.85 vs provider/high-score-clamped 0.88 (provider/high-score-clamped clamped medium)",
    );
  });

  test("no observation for a candidate's ceiling never invents a penalty (decision 4)", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/unobserved", poolIndex: 0, posIndex: 0 },
      { ref: "provider/observed-open", poolIndex: 1, posIndex: 0 },
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({
        "provider/unobserved": 0.88,
        "provider/observed-open": 0.85,
      }),
      requestedEffort: "high",
      effortCeilingOf: (ref) => (ref === "provider/observed-open" ? "high" : undefined),
    };
    const result = rankUnion(candidates, opts);
    // Neither candidate is penalized (unobserved ⇒ 0, observed-and-sufficient ⇒ 0) —
    // falls through to cost/order, not a clamp verdict for the higher scorer.
    assert.equal(result?.ref, "provider/unobserved");
  });
});

describe("rankUnion — ε-group: cost tie-break", () => {
  test("cheaper candidate wins within ε when clamp does not discriminate", () => {
    const candidates: UnionCandidate[] = [
      { ref: "claude-code/claude-opus-4-8", poolIndex: 0, posIndex: 0 }, // costRank 90
      { ref: "openai/gpt-5.5", poolIndex: 1, posIndex: 0 }, // costRank 85
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({
        "claude-code/claude-opus-4-8": 0.82,
        "openai/gpt-5.5": 0.8, // Δ = 0.02 ≤ EPSILON
      }),
    };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.ref, "openai/gpt-5.5");
    assert.match(result!.reason, /\(cost tie-break\)$/);
  });
});

describe("rankUnion — ε-group: declared-order tie-break", () => {
  test("equal cost (both fall back to the default profile) ⇒ earlier (poolIndex, posIndex) wins", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/second", poolIndex: 1, posIndex: 0 },
      { ref: "provider/first", poolIndex: 0, posIndex: 0 },
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({
        "provider/second": 0.7,
        "provider/first": 0.68, // Δ = 0.02 ≤ EPSILON; neither ref is in model-capabilities.ts ⇒ equal default cost
      }),
    };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.ref, "provider/first");
    assert.match(result!.reason, /\(declared-order tie-break\)$/);
  });

  test("posIndex breaks the tie within the same pool", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/pos-1", poolIndex: 0, posIndex: 1 },
      { ref: "provider/pos-0", poolIndex: 0, posIndex: 0 },
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({ "provider/pos-1": 0.5, "provider/pos-0": 0.5 }),
    };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.ref, "provider/pos-0");
  });
});

describe("rankUnion — un-judged candidates never win over a scored candidate", () => {
  test("a declared-first, un-judged candidate still loses to a low-scored candidate declared later", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/no-row-in-matrix", poolIndex: 0, posIndex: 0 },
      { ref: "provider/barely-scored", poolIndex: 1, posIndex: 0 },
      { ref: "provider/also-no-row", poolIndex: 2, posIndex: 0 },
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({ "provider/barely-scored": 0.1 }),
    };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.ref, "provider/barely-scored");
  });
});

describe("rankUnion — score decides outright when Δ > EPSILON", () => {
  test("EPSILON is the curated 0.05 threshold (S09-PLAN decision 1)", () => {
    assert.equal(EPSILON, 0.05);
  });


  test("no clamp/cost/order annotation is appended when the gap is decisive on score alone", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/winner", poolIndex: 0, posIndex: 0 },
      { ref: "provider/runner-up", poolIndex: 1, posIndex: 0 },
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({ "provider/winner": 0.9, "provider/runner-up": 0.5 }),
    };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.reason, "capability:infra provider/winner 0.90 > provider/runner-up 0.50");
  });

  test("exact EPSILON boundary (Δ = 0.05) is treated as ε-group, not a decisive score gap", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/leader", poolIndex: 1, posIndex: 0 },
      { ref: "provider/edge", poolIndex: 0, posIndex: 0 },
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({ "provider/leader": 0.9, "provider/edge": 0.85 }),
    };
    const result = rankUnion(candidates, opts);
    // Both refs are unknown to model-capabilities.ts (equal default cost) ⇒ declared order decides,
    // and provider/edge (poolIndex 0) is earlier than provider/leader (poolIndex 1).
    assert.equal(result?.ref, "provider/edge");
    assert.match(result!.reason, /\(declared-order tie-break\)$/);
  });
});

describe("rankUnion — single scored candidate", () => {
  test("one scored candidate ⇒ reason has no runner-up clause", () => {
    const candidates: UnionCandidate[] = [{ ref: "provider/only", poolIndex: 0, posIndex: 0 }];
    const opts: RankUnionOpts = { domain: "infra", capabilityOf: capabilityTable({ "provider/only": 0.42 }) };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.ref, "provider/only");
    assert.equal(result?.reason, "capability:infra provider/only 0.42");
  });

  test("one scored candidate among several un-judged ones ⇒ still no runner-up clause", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/unjudged-a", poolIndex: 0, posIndex: 0 },
      { ref: "provider/only", poolIndex: 1, posIndex: 0 },
      { ref: "provider/unjudged-b", poolIndex: 2, posIndex: 0 },
    ];
    const opts: RankUnionOpts = { domain: "infra", capabilityOf: capabilityTable({ "provider/only": 0.42 }) };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.reason, "capability:infra provider/only 0.42");
  });
});

describe("rankUnion — effortCeilingOf absent (no clamp axis engaged)", () => {
  test("requestedEffort present but effortCeilingOf absent ⇒ falls through to cost/order, never throws", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/a", poolIndex: 0, posIndex: 0 },
      { ref: "provider/b", poolIndex: 1, posIndex: 0 },
    ];
    const opts: RankUnionOpts = {
      domain: "infra",
      capabilityOf: capabilityTable({ "provider/a": 0.6, "provider/b": 0.58 }),
      requestedEffort: "max",
    };
    assert.doesNotThrow(() => rankUnion(candidates, opts));
    const result = rankUnion(candidates, opts);
    assert.equal(result?.ref, "provider/a");
    assert.match(result!.reason, /\(declared-order tie-break\)$/);
  });
});

describe("rankUnion — duplicate ref across positions (caller precondition documented, not enforced)", () => {
  test("same ref at two positions is ranked as two independent candidates; earlier position wins the tie", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/dup", poolIndex: 1, posIndex: 0 },
      { ref: "provider/dup", poolIndex: 0, posIndex: 0 },
    ];
    const opts: RankUnionOpts = { domain: "infra", capabilityOf: capabilityTable({ "provider/dup": 0.5 }) };
    const result = rankUnion(candidates, opts);
    assert.equal(result?.ref, "provider/dup");
    // Reason cites the same ref on both sides of "vs" — a known, harmless quirk of an
    // undeduped input; documents the precondition rather than guarding against it. "vs" (not
    // ">") because this is a tie-break decision, not a score comparison.
    assert.equal(result?.reason, "capability:infra provider/dup 0.50 vs provider/dup 0.50 (declared-order tie-break)");
  });
});

describe("rankUnion — module purity", () => {
  test("is a plain function with no observable side effects across repeated calls", () => {
    const candidates: UnionCandidate[] = [
      { ref: "provider/x", poolIndex: 0, posIndex: 0 },
      { ref: "provider/y", poolIndex: 1, posIndex: 0 },
    ];
    const opts: RankUnionOpts = { domain: "infra", capabilityOf: capabilityTable({ "provider/x": 0.7, "provider/y": 0.2 }) };
    const first = rankUnion(candidates, opts);
    const second = rankUnion(candidates, opts);
    assert.deepEqual(first, second);
  });
});
