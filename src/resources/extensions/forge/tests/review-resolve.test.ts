import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveReview } from "../review/resolve.ts";
import type {
  ReviewObjection,
  ReviewVerdict,
  AdvocateVerdictKind,
  RebuttalVerdictKind,
  Resolution,
} from "../review/resolve.ts";

// Pure truth-table tests: synthetic objections/verdicts only, no filesystem.
// Ids are synthetic (R1, R2, ...) — the resolve machine never gates on id shape.

function obj(id: string, over: Partial<ReviewObjection> = {}): ReviewObjection {
  return {
    id,
    pathLine: `src/${id}.ts:1`,
    severity: "high",
    claim: `claim ${id}`,
    suggestedFix: `fix ${id}`,
    challenge: `challenge ${id}?`,
    ...over,
  };
}

function adv(
  id: string,
  verdict: AdvocateVerdictKind,
): ReviewVerdict<AdvocateVerdictKind> {
  return { id, verdict, rationale: `advocate ${verdict}` };
}

function reb(
  id: string,
  verdict: RebuttalVerdictKind,
): ReviewVerdict<RebuttalVerdictKind> {
  return { id, verdict, rationale: `rebuttal ${verdict}` };
}

// ── The exhaustive 3×3: advocate × rebuttal (Step 5 truth table) ─────────────
describe("resolveReview truth table (3×3 advocate × rebuttal, rounds=1)", () => {
  const advocates: AdvocateVerdictKind[] = ["refuted", "conceded", "open"];
  const rebuttals: RebuttalVerdictKind[] = [
    "maintained",
    "withdrawn",
    "conceded",
  ];

  // Expected resolution keyed by `${advocate}/${rebuttal}` — explicit per line.
  // advocate conceded wins outright; else rebuttal withdrawn resolves; else open.
  const expected: Record<string, Resolution> = {
    "refuted/maintained": "open",
    "refuted/withdrawn": "resolved",
    "refuted/conceded": "open",
    "conceded/maintained": "conceded",
    "conceded/withdrawn": "conceded",
    "conceded/conceded": "conceded",
    "open/maintained": "open",
    "open/withdrawn": "resolved",
    "open/conceded": "open",
  };

  for (const a of advocates) {
    for (const r of rebuttals) {
      const key = `${a}/${r}`;
      test(`advocate ${a} × rebuttal ${r} → ${expected[key]}`, () => {
        const out = resolveReview([obj("R1")], [adv("R1", a)], [[reb("R1", r)]], 1);
        assert.equal(out.noFlags, false);
        assert.equal(out.items.length, 1);
        assert.equal(out.items[0].resolution, expected[key]);
        assert.equal(out.items[0].defense.verdict, a);
        assert.equal(out.items[0].rebuttal.verdict, r);
        // counts invariant holds on every output.
        assert.equal(
          out.counts.resolved + out.counts.conceded + out.counts.open,
          out.items.length,
        );
      });
    }
  }
});

// ── rounds == 0 → every rebuttal treated as maintained ───────────────────────
describe("resolveReview rounds handling", () => {
  test("rounds == 0 ignores rebuttal rounds → all maintained", () => {
    // Even though a withdrawn verdict is supplied, rounds=0 means no round is
    // applied → the default `maintained` stands → refuted+maintained = open.
    const out = resolveReview(
      [obj("R1")],
      [adv("R1", "refuted")],
      [[reb("R1", "withdrawn")]],
      0,
    );
    assert.equal(out.items[0].rebuttal.verdict, "maintained");
    assert.equal(out.items[0].resolution, "open");
  });

  test("rounds == 1 applies the single provided round", () => {
    const out = resolveReview(
      [obj("R1")],
      [adv("R1", "refuted")],
      [[reb("R1", "withdrawn")]],
      1,
    );
    assert.equal(out.items[0].rebuttal.verdict, "withdrawn");
    assert.equal(out.items[0].resolution, "resolved");
  });

  test("non-integer rounds defaults to 1 (parity with 1.0 script)", () => {
    const out = resolveReview(
      [obj("R1")],
      [adv("R1", "refuted")],
      [[reb("R1", "withdrawn")]],
      Number.NaN,
    );
    assert.equal(out.items[0].rebuttal.verdict, "withdrawn");
  });

  test("negative rounds clamped to 0 → maintained", () => {
    const out = resolveReview(
      [obj("R1")],
      [adv("R1", "refuted")],
      [[reb("R1", "withdrawn")]],
      -5,
    );
    assert.equal(out.items[0].rebuttal.verdict, "maintained");
  });
});

// ── last-round-wins over 2 rounds ────────────────────────────────────────────
describe("resolveReview last-round-wins", () => {
  test("2 rounds: the last round carrying a verdict wins", () => {
    const out = resolveReview(
      [obj("R1")],
      [adv("R1", "refuted")],
      [[reb("R1", "withdrawn")], [reb("R1", "maintained")]],
      2,
    );
    // round 1 said withdrawn, round 2 said maintained → maintained wins → open.
    assert.equal(out.items[0].rebuttal.verdict, "maintained");
    assert.equal(out.items[0].resolution, "open");
  });

  test("2 rounds: a later round that omits an id keeps the earlier verdict", () => {
    const out = resolveReview(
      [obj("R1"), obj("R2")],
      [adv("R1", "refuted"), adv("R2", "refuted")],
      [
        [reb("R1", "withdrawn"), reb("R2", "withdrawn")],
        [reb("R1", "maintained")], // round 2 omits R2
      ],
      2,
    );
    assert.equal(out.items[0].rebuttal.verdict, "maintained"); // R1 overwritten
    assert.equal(out.items[1].rebuttal.verdict, "withdrawn"); // R2 kept from r1
  });
});

// ── Normalizations from the 1.0 workflow script ──────────────────────────────
describe("resolveReview normalizations", () => {
  test("advocate verdict absent → open with 'defesa indisponivel' rationale", () => {
    const out = resolveReview([obj("R1")], [], [[reb("R1", "maintained")]], 1);
    assert.equal(out.items[0].defense.verdict, "open");
    assert.match(out.items[0].defense.rationale, /defesa indisponivel/);
    assert.equal(out.items[0].resolution, "open");
  });

  test("rebuttal verdict absent → maintained (conservative)", () => {
    const out = resolveReview(
      [obj("R1")],
      [adv("R1", "refuted")],
      [[]], // a round that carries no verdict for R1
      1,
    );
    assert.equal(out.items[0].rebuttal.verdict, "maintained");
    assert.match(out.items[0].rebuttal.rationale, /sem replica/);
  });

  test("no rebuttal rounds at all → maintained", () => {
    const out = resolveReview([obj("R1")], [adv("R1", "open")], [], 1);
    assert.equal(out.items[0].rebuttal.verdict, "maintained");
  });

  // Duplicate advocate verdict — fail-before/pass-after: first-occurrence-kept.
  // With first-wins (correct) the resolution follows the FIRST verdict; break it
  // to last-wins and this assertion flips → the test guards the invariant.
  test("duplicate advocate verdict → first occurrence kept + warning", () => {
    const out = resolveReview(
      [obj("R1")],
      [adv("R1", "refuted"), adv("R1", "conceded")], // first refuted wins
      [[reb("R1", "maintained")]],
      1,
    );
    assert.equal(out.items[0].defense.verdict, "refuted");
    // refuted + maintained → open. Had last-wins leaked, this would be conceded.
    assert.equal(out.items[0].resolution, "open");
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /duplicate advocate verdict for R1/);
  });

  test("advocate verdict for unknown id → ignored + warning", () => {
    const out = resolveReview(
      [obj("R1")],
      [adv("R1", "refuted"), adv("R99", "conceded")], // R99 not an objection
      [[reb("R1", "maintained")]],
      1,
    );
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].defense.verdict, "refuted");
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /unknown id R99/);
  });

  test("rebuttal verdict for unknown id → ignored + warning", () => {
    const out = resolveReview(
      [obj("R1")],
      [adv("R1", "refuted")],
      [[reb("R1", "maintained"), reb("R99", "withdrawn")]],
      1,
    );
    assert.equal(out.items.length, 1);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /unknown id R99/);
  });
});

// ── noFlags path (Step 2) ────────────────────────────────────────────────────
describe("resolveReview noFlags", () => {
  test("zero objections → noFlags with empty items and zeroed counts", () => {
    const out = resolveReview([], [], [], 1);
    assert.deepStrictEqual(out, {
      noFlags: true,
      items: [],
      counts: { resolved: 0, conceded: 0, open: 0 },
      warnings: [],
    });
  });

  test("non-empty objections never set noFlags", () => {
    const out = resolveReview([obj("R1")], [adv("R1", "conceded")], [], 1);
    assert.equal(out.noFlags, false);
  });
});

// ── counts invariant + item ordering ─────────────────────────────────────────
describe("resolveReview counts invariant and ordering", () => {
  test("counts sum equals items.length across a mixed set", () => {
    const objections = [obj("R1"), obj("R2"), obj("R3"), obj("R4")];
    const out = resolveReview(
      objections,
      [
        adv("R1", "conceded"), // → conceded
        adv("R2", "refuted"), // + withdrawn → resolved
        adv("R3", "refuted"), // + maintained → open
        adv("R4", "open"), // + withdrawn → resolved
      ],
      [
        [
          reb("R2", "withdrawn"),
          reb("R3", "maintained"),
          reb("R4", "withdrawn"),
        ],
      ],
      1,
    );
    assert.equal(out.counts.conceded, 1);
    assert.equal(out.counts.resolved, 2);
    assert.equal(out.counts.open, 1);
    assert.equal(
      out.counts.resolved + out.counts.conceded + out.counts.open,
      out.items.length,
    );
    // items preserve objection order.
    assert.deepStrictEqual(
      out.items.map((i) => i.id),
      ["R1", "R2", "R3", "R4"],
    );
  });
});

// ── determinism (pure function) ──────────────────────────────────────────────
describe("resolveReview determinism", () => {
  test("same inputs → deeply equal outputs (no I/O, no Date, no random)", () => {
    const objections = [obj("R1"), obj("R2")];
    const defense = [adv("R1", "conceded"), adv("R2", "refuted")];
    const rounds: ReviewVerdict<RebuttalVerdictKind>[][] = [
      [reb("R2", "withdrawn")],
    ];
    const a = resolveReview(objections, defense, rounds, 1);
    const b = resolveReview(objections, defense, rounds, 1);
    assert.deepStrictEqual(a, b);
  });
});
