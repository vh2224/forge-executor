import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { rankPool, type RankOpts } from "../auto/model-rank.ts";

describe("rankPool — empty pool", () => {
  test("returns null for an empty eligible-refs list", () => {
    assert.equal(rankPool([], {}), null);
  });

  test("returns null for an empty list even with hint/budget opts set", () => {
    assert.equal(rankPool([], { tierHint: "light", budgetPressure: true }), null);
  });
});

describe("rankPool — (a) hint absent: byte-identical to S03 pool-order pick", () => {
  test("no opts ⇒ returns the pool's top ref (openai, non-flat-rate, isolates this from flat-rate suppression)", () => {
    const pool = ["openai/gpt-5.5", "openai/gpt-5-mini"];
    assert.equal(rankPool(pool, {}), pool[0]);
  });

  test("no opts, single-ref pool ⇒ that ref", () => {
    const pool = ["openai/gpt-5-mini"];
    assert.equal(rankPool(pool, {}), pool[0]);
  });
});

describe("rankPool — (b) downgrade-only: never ranks above the pool's teto", () => {
  test("hint above the pool's ceiling (light) is a no-op — result stays at the ceiling", () => {
    const pool = ["openai/gpt-5-mini"]; // ceiling = light (gpt-5-mini's declared tier)
    const opts: RankOpts = { tierHint: "max" };
    assert.equal(rankPool(pool, opts), pool[0]);
  });

  test("hint 'heavy' against a light-ceiling pool still never rises", () => {
    const pool = ["openai/gpt-5-mini"];
    assert.equal(rankPool(pool, { tierHint: "heavy" }), pool[0]);
  });
});

describe("rankPool — (c) hint below the teto descends", () => {
  test("hint 'light' on a pool whose top is max picks the light-tier ref", () => {
    const pool = ["openai/gpt-5.5", "openai/gpt-5-mini"]; // ceiling = max (gpt-5.5)
    assert.equal(rankPool(pool, { tierHint: "light" }), "openai/gpt-5-mini");
  });

  test("hint 'standard' on a pool whose top is max lands on the closest tier at/below standard", () => {
    // No standard-tier openai ref exists in the T01 table — the target (standard)
    // has no exact match, so the rank falls back to the highest tier <= target
    // present in the pool: light (gpt-5-mini), never max (gpt-5.5).
    const pool = ["openai/gpt-5.5", "openai/gpt-5-mini"];
    assert.equal(rankPool(pool, { tierHint: "standard" }), "openai/gpt-5-mini");
  });
});

describe("rankPool — (d) budget pressure forces a downgrade", () => {
  test("budget pressure alone (no hint) pushes the target below the ceiling and selects the lower ref", () => {
    const pool = ["openai/gpt-5.5", "openai/gpt-5-mini"]; // ceiling = max
    assert.equal(rankPool(pool, { budgetPressure: true }), "openai/gpt-5-mini");
  });

  test("budget pressure forces strictly below what the hint alone would have picked", () => {
    // hint alone (standard) would already fall back to gpt-5-mini (see above);
    // this asserts budget pressure composes with a hint without ever rising.
    const pool = ["openai/gpt-5.5", "openai/gpt-5-mini"];
    assert.equal(
      rankPool(pool, { tierHint: "standard", budgetPressure: true }),
      "openai/gpt-5-mini",
    );
  });
});

describe("rankPool — (e) budget pressure with no smaller candidate: never rises", () => {
  test("single-tier pool under budget pressure returns the only available ref, not null/higher", () => {
    const pool = ["openai/gpt-5.5"]; // only tier present is max
    assert.equal(rankPool(pool, { budgetPressure: true }), "openai/gpt-5.5");
  });
});

describe("rankPool — (f) flat-rate suppression short-circuits fine rank", () => {
  test("flat-rate top ref wins even with both a hint and budget pressure set", () => {
    const pool = ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"];
    const opts: RankOpts = { tierHint: "light", budgetPressure: true };
    assert.equal(rankPool(pool, opts), "claude-code/claude-opus-4-8");
  });

  test("flat-rate suppression applies even when a non-flat-rate lighter ref sits later in the pool", () => {
    const pool = ["claude-code/claude-opus-4-8", "openai/gpt-5-mini"];
    assert.equal(rankPool(pool, { tierHint: "light" }), "claude-code/claude-opus-4-8");
  });
});

describe("rankPool — (g) deterministic tie-break", () => {
  test("capabilityScore desc wins over pool order when both refs are at the target tier", () => {
    // Both max tier; gpt-5.5 is first in pool order but opus has the higher
    // capability score (95 > 90) — the tie-break must override plain order.
    const pool = ["openai/gpt-5.5", "claude-code/claude-opus-4-8"];
    assert.equal(rankPool(pool, {}), "claude-code/claude-opus-4-8");
  });

  test("full 3-way tie (capability, cost, both default) falls back to pool order — total, stable order", () => {
    const pool = ["openai/unknown-variant-a", "openai/unknown-variant-b"];
    assert.equal(rankPool(pool, {}), pool[0]);
  });
});

describe("rankPool — pure, deterministic", () => {
  test("repeated calls with the same args always agree", () => {
    const pool = ["openai/gpt-5.5", "openai/gpt-5-mini"];
    const opts: RankOpts = { tierHint: "light" };
    assert.equal(rankPool(pool, opts), rankPool(pool, opts));
  });

  test("does not mutate the input array", () => {
    const pool = ["openai/gpt-5.5", "openai/gpt-5-mini"];
    const snapshot = [...pool];
    rankPool(pool, { budgetPressure: true });
    assert.deepEqual(pool, snapshot);
  });
});

// ————— S03/T02: capability factor (D-S03-1) —————

/**
 * Simulates the S02 capability matrix as a pre-bound pure lookup — the same
 * shape T03 injects (`(d, r) => capabilityFor(matrix, d, r)`). Deliberately
 * does NOT import capability-matrix.ts: the rank only knows the injected
 * function, never the file format.
 */
function lookupFrom(
  table: Record<string, Record<string, number>>,
): (domain: string, ref: string) => number | undefined {
  return (domain, ref) => table[domain]?.[ref];
}

describe("rankPool — (h) byte-identity: capability factor absent or half-present changes nothing", () => {
  // The pools/opts of suites (a)-(f), each paired with its expected winner.
  const cases: Array<{ label: string; pool: string[]; opts: RankOpts; winner: string }> = [
    { label: "(a) no opts", pool: ["openai/gpt-5.5", "openai/gpt-5-mini"], opts: {}, winner: "openai/gpt-5.5" },
    { label: "(b) hint above ceiling", pool: ["openai/gpt-5-mini"], opts: { tierHint: "max" }, winner: "openai/gpt-5-mini" },
    { label: "(c) hint below teto", pool: ["openai/gpt-5.5", "openai/gpt-5-mini"], opts: { tierHint: "light" }, winner: "openai/gpt-5-mini" },
    { label: "(d) budget pressure", pool: ["openai/gpt-5.5", "openai/gpt-5-mini"], opts: { budgetPressure: true }, winner: "openai/gpt-5-mini" },
    { label: "(e) pressure, single tier", pool: ["openai/gpt-5.5"], opts: { budgetPressure: true }, winner: "openai/gpt-5.5" },
    { label: "(f) flat-rate head", pool: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"], opts: { tierHint: "light", budgetPressure: true }, winner: "claude-code/claude-opus-4-8" },
  ];
  const lookup = lookupFrom({
    backend: { "openai/gpt-5.5": 0.1, "openai/gpt-5-mini": 1.0, "claude-code/claude-sonnet-5": 1.0 },
  });

  for (const c of cases) {
    test(`${c.label}: domain+capabilityOf both absent ⇒ same winner`, () => {
      assert.equal(rankPool(c.pool, { ...c.opts }), c.winner);
    });

    test(`${c.label}: capabilityOf present but domain absent ⇒ same winner`, () => {
      assert.equal(rankPool(c.pool, { ...c.opts, capabilityOf: lookup }), c.winner);
    });

    test(`${c.label}: domain present but capabilityOf absent ⇒ same winner`, () => {
      assert.equal(rankPool(c.pool, { ...c.opts, domain: "backend" }), c.winner);
    });
  }

  test("half-present opts never invoke the lookup (structural branch, not value coincidence)", () => {
    let calls = 0;
    const spy = (domain: string, ref: string): number | undefined => {
      calls += 1;
      return 1.0;
    };
    rankPool(["openai/gpt-5.5", "openai/gpt-5-mini"], { capabilityOf: spy });
    assert.equal(calls, 0);
  });
});

describe("rankPool — (i) matrix reorders co-finalists per domain", () => {
  // Two refs UNKNOWN to the static table: both default to {tier: standard,
  // capability: 1, cost: 1} — a total static tie, so the matrix is the ONLY
  // discriminator between them.
  const pool = ["prov-a/model-x", "prov-b/model-y"];
  const matrix = {
    backend: { "prov-b/model-y": 0.9, "prov-a/model-x": 0.4 },
    frontend: { "prov-a/model-x": 0.9, "prov-b/model-y": 0.4 },
  };

  test("domain 'backend' flips the static pool-order tie toward the matrix's pick", () => {
    assert.equal(
      rankPool(pool, { domain: "backend", capabilityOf: lookupFrom(matrix) }),
      "prov-b/model-y",
    );
  });

  test("domain 'frontend' with inverted scores picks the other ref from the SAME pool", () => {
    assert.equal(
      rankPool(pool, { domain: "frontend", capabilityOf: lookupFrom(matrix) }),
      "prov-a/model-x",
    );
  });
});

describe("rankPool — (j) matrix miss = factor absent, never score 0", () => {
  const pool = ["prov-a/model-x", "prov-b/model-y"];

  test("matrix without the requested domain ⇒ winner identical to the no-opts case", () => {
    const matrix = { backend: { "prov-b/model-y": 0.9 } };
    const withDomain = rankPool(pool, { domain: "frontend", capabilityOf: lookupFrom(matrix) });
    assert.equal(withDomain, rankPool(pool, {}));
    assert.equal(withDomain, "prov-a/model-x");
  });

  test("matrix scoring only one ref high ⇒ the scored ref beats the unscored default", () => {
    const matrix = { backend: { "prov-b/model-y": 0.9 } };
    assert.equal(
      rankPool(pool, { domain: "backend", capabilityOf: lookupFrom(matrix) }),
      "prov-b/model-y",
    );
  });

  test("scored 0.5 LOSES to an unscored ref whose normalized static is higher (0.70)", () => {
    // sonnet is unscored → falls back to capabilityScore 70 / 100 = 0.70,
    // which outranks the scored 0.5 — presence of a score never auto-wins
    // over absence (the rejected 'presença vence ausência' design).
    // Head is prov-a (unknown provider, standard tier, not flat-rate), so
    // sonnet (standard) is a co-finalist and no short-circuit fires.
    const mixedPool = ["prov-a/model-x", "claude-code/claude-sonnet-5"];
    const matrix = { backend: { "prov-a/model-x": 0.5 } };
    assert.equal(
      rankPool(mixedPool, { domain: "backend", capabilityOf: lookupFrom(matrix) }),
      "claude-code/claude-sonnet-5",
    );
  });

  test("unscored refs keep their exact current relative order (monotone /100 fallback)", () => {
    // Neither ref scored for this domain: both fall back to static/100 —
    // opus (95) still beats gpt-5.5 (90), same winner as the pre-S03 tie-break.
    const staticPool = ["openai/gpt-5.5", "claude-code/claude-opus-4-8"];
    const matrix = { backend: { "prov-z/elsewhere": 1.0 } };
    assert.equal(
      rankPool(staticPool, { domain: "backend", capabilityOf: lookupFrom(matrix) }),
      rankPool(staticPool, {}),
    );
  });
});

describe("rankPool — (k) matrix never pierces the tier ceiling", () => {
  test("a 1.0 matrix score on a ref above the pool's teto cannot make it win", () => {
    // Head gpt-5-mini (light) ⇒ ceiling light; gpt-5.5 (max) is excluded from
    // candidates by tier selection BEFORE the tie-break ever sees it.
    const pool = ["openai/gpt-5-mini", "openai/gpt-5.5"];
    const matrix = { backend: { "openai/gpt-5.5": 1.0 } };
    assert.equal(
      rankPool(pool, { domain: "backend", capabilityOf: lookupFrom(matrix) }),
      "openai/gpt-5-mini",
    );
  });
});

describe("rankPool — (l) flat-rate suppression runs BEFORE the capability factor", () => {
  test("flat-rate head wins even when the matrix maximally favors another ref", () => {
    const pool = ["claude-code/claude-opus-4-8", "openai/gpt-5-mini"];
    const matrix = { backend: { "openai/gpt-5-mini": 1.0 } };
    assert.equal(
      rankPool(pool, { domain: "backend", capabilityOf: lookupFrom(matrix) }),
      "claude-code/claude-opus-4-8",
    );
  });

  test("the lookup is never invoked under the flat-rate short-circuit", () => {
    let calls = 0;
    const spy = (domain: string, ref: string): number | undefined => {
      calls += 1;
      return 1.0;
    };
    rankPool(["claude-code/claude-opus-4-8", "openai/gpt-5-mini"], {
      domain: "backend",
      capabilityOf: spy,
    });
    assert.equal(calls, 0);
  });
});
