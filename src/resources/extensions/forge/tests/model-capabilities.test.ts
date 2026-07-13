import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  TIER_ORDINAL,
  tierOf,
  capabilityScore,
  costRank,
  isFlatRateProvider,
  providerOf,
  type Tier,
} from "../auto/model-capabilities.ts";

describe("TIER_ORDINAL", () => {
  test("orders the 4 planner tiers strictly light < standard < heavy < max", () => {
    assert.ok(TIER_ORDINAL.light < TIER_ORDINAL.standard);
    assert.ok(TIER_ORDINAL.standard < TIER_ORDINAL.heavy);
    assert.ok(TIER_ORDINAL.heavy < TIER_ORDINAL.max);
  });

  test("covers exactly the 4 tiers from the planner contract", () => {
    assert.deepEqual(Object.keys(TIER_ORDINAL).sort(), ["heavy", "light", "max", "standard"]);
  });
});

describe("providerOf", () => {
  test("returns the prefix before the first slash", () => {
    assert.equal(providerOf("claude-code/claude-opus-4-8"), "claude-code");
    assert.equal(providerOf("openai/gpt-5-mini"), "openai");
  });

  test("returns the ref verbatim when there is no slash", () => {
    assert.equal(providerOf("no-slash-ref"), "no-slash-ref");
  });
});

describe("tierOf", () => {
  test("returns the declared tier for a known ref", () => {
    assert.equal(tierOf("claude-code/claude-opus-4-8"), "max");
    assert.equal(tierOf("claude-code/claude-sonnet-5"), "standard");
    assert.equal(tierOf("openai/gpt-5.5"), "max");
    assert.equal(tierOf("openai/gpt-5-mini"), "light");
  });

  test("never throws and returns a deterministic default tier for an unknown ref", () => {
    let tier: Tier | undefined;
    assert.doesNotThrow(() => {
      tier = tierOf("unknown-provider/unknown-model");
    });
    assert.equal(tier, tierOf("unknown-provider/unknown-model"));
    assert.ok(tier === "light" || tier === "standard" || tier === "heavy" || tier === "max");
  });
});

describe("capabilityScore", () => {
  test("returns a non-negative score for known refs, opus/gpt-5.5 above the lighter sibling", () => {
    const opus = capabilityScore("claude-code/claude-opus-4-8");
    const sonnet = capabilityScore("claude-code/claude-sonnet-5");
    const gpt55 = capabilityScore("openai/gpt-5.5");
    const gptMini = capabilityScore("openai/gpt-5-mini");

    assert.ok(opus >= 0);
    assert.ok(sonnet >= 0);
    assert.ok(gpt55 >= 0);
    assert.ok(gptMini >= 0);
    assert.ok(opus > sonnet);
    assert.ok(gpt55 > gptMini);
  });

  test("returns a non-negative deterministic default for an unknown ref", () => {
    const first = capabilityScore("unknown-provider/unknown-model");
    const second = capabilityScore("unknown-provider/unknown-model");
    assert.ok(first >= 0);
    assert.equal(first, second);
  });
});

describe("costRank", () => {
  test("returns a non-negative rank for known refs, flagship above the lighter sibling", () => {
    const opus = costRank("claude-code/claude-opus-4-8");
    const sonnet = costRank("claude-code/claude-sonnet-5");
    const gpt55 = costRank("openai/gpt-5.5");
    const gptMini = costRank("openai/gpt-5-mini");

    assert.ok(opus >= 0);
    assert.ok(sonnet >= 0);
    assert.ok(gpt55 >= 0);
    assert.ok(gptMini >= 0);
    assert.ok(opus > sonnet);
    assert.ok(gpt55 > gptMini);
  });

  test("returns a non-negative deterministic default for an unknown ref", () => {
    const first = costRank("unknown-provider/unknown-model");
    const second = costRank("unknown-provider/unknown-model");
    assert.ok(first >= 0);
    assert.equal(first, second);
  });
});

describe("isFlatRateProvider", () => {
  test("is true for claude-code (subscription, no marginal cost)", () => {
    assert.equal(isFlatRateProvider("claude-code"), true);
  });

  test("is false for openai (pay-per-token)", () => {
    assert.equal(isFlatRateProvider("openai"), false);
  });

  test("defaults to false (pay-per-token) for an unrecognized provider", () => {
    assert.equal(isFlatRateProvider("some-unknown-provider"), false);
  });
});

describe("determinism", () => {
  test("repeated calls with the same ref/provider always agree", () => {
    const ref = "claude-code/claude-opus-4-8";
    assert.equal(tierOf(ref), tierOf(ref));
    assert.equal(capabilityScore(ref), capabilityScore(ref));
    assert.equal(costRank(ref), costRank(ref));
    assert.equal(isFlatRateProvider("openai"), isFlatRateProvider("openai"));
  });
});
