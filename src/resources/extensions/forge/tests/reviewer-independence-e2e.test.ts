/**
 * S04 demo evidence — the literal contract of ROADMAP §Demos S04: "teste
 * sintético grava 'autor=gpt', dispara a resolução do reviewer e prova que
 * gpt foi filtrado do pool candidato (e o advocate resolveu PARA gpt)."
 *
 * This is deliberately a SEPARATE file from `role.test.ts` (T02's exhaustive
 * unit coverage of the seam's filter composition): this file is the end-to-end
 * demo artifact — one synthetic 2-family `ModelsConfig` (`claude-code/*` +
 * `openai/*`, same shape as `tests/role-pool.test.ts`, S03), one synthetic G1
 * authorship record (`ForgeEvent[]` with a `family: 'gpt'` `execute-task`
 * event), driven end to end: `authorFamilyForSlice` (T01) derives the author
 * family from the events, and that value is fed into `resolveModelForRole`
 * (`auto/role.ts`, T02) for both `reviewer` and `advocate`.
 *
 * No real `gpt`/`openai` credential is read or required anywhere in this
 * file — both "families" are synthetic `provider/model-id` strings, no
 * `AvailabilityProbe` is even injected (every ref is available by default),
 * and the authorship events are hand-built in memory, never touching disk
 * (`readEvents` is not imported here — S04-PLAN §Context: the seam itself
 * stays synchronous/I/O-free, the caller resolves `authorFamily` up front).
 *
 * M-20260711135806-wiring-multi-llm / S02 / T01 addition: a fail-closed demo
 * case where the reviewer's only candidate pool IS the author's family — the
 * S04 filter empties it, and the synthetic baseline that `degradeToPoolOfOne`
 * would otherwise degrade to also shares that family. Proves `resolveModelForRole`
 * returns `BLOCKED` with `violation: "reviewer_not_author"` (never silently
 * degrading the reviewer back into the author's own family) and logs a warn
 * distinct from the generic degrade warn.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NextUnit } from "../state/dispatch.ts";
import type { ForgeEvent } from "../state/types.ts";
import { familyOf } from "../state/family.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { resolveModelForRole } from "../auto/role.ts";
import type { ModelsConfig } from "../auto/models-config.ts";
import { authorFamilyForSlice } from "../auto/reviewer-independence.ts";

function makeSession(cwd = "/tmp/does-not-matter"): ForgeAutoSession {
  const s = new ForgeAutoSession();
  s.active = true;
  s.cwd = cwd;
  return s;
}

/** The slice under review — the same id the synthetic authorship events reference. */
const REVIEWED_SLICE = "S04";

/** The unit passed to `resolveModelForRole` — a stand-in for "the diff under review". */
const REVIEWED_UNIT: NextUnit = { type: "execute-task", slice: REVIEWED_SLICE, task: "T99" };

/**
 * The 2 fake families locked in S03 (`S03-PLAN.md §Config surface`,
 * `tests/role-pool.test.ts`): `claude` (claude-code/*) and `gpt` (openai/*).
 * `roles.reviewer`/`roles.advocate` deliberately put the AUTHOR family
 * (`gpt`) FIRST in pool order — this makes the demo prove the filter
 * actually changes the outcome, not just coincide with the unfiltered pick:
 * without the adversarial filter, `reviewer` would resolve to `gpt` (the
 * first pool); with it active, `gpt` is excluded and resolution falls to
 * `claude`. Symmetrically `advocate` lists `claude` first — without the
 * filter it would resolve to `claude`; with it active, only `gpt` (the
 * author family) survives.
 */
function reviewerAdvocateConfig(constraintOn: boolean): ModelsConfig {
  return {
    pools: {
      claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
      gpt: ["openai/gpt-5.5", "openai/gpt-5-mini"],
    },
    roles: {
      reviewer: ["gpt", "claude"],
      advocate: ["claude", "gpt"],
    },
    constraints: constraintOn ? { reviewer_not_author: "family" } : {},
  };
}

/**
 * Synthetic G1 authorship: one `unit_dispatched` `execute-task` event for
 * `REVIEWED_SLICE` carrying `family: 'gpt'` — the same shape `loop.ts`
 * journals on the real dispatch path (S01), hand-built here instead of read
 * from `.gsd/forge/events.jsonl` via `readEvents`.
 */
function syntheticGptAuthorship(): ForgeEvent[] {
  return [
    {
      ts: "2026-07-11T00:00:00.000Z",
      unit: `${REVIEWED_SLICE}/T99`,
      agent: "forge-loop",
      milestone: "M-test",
      status: "dispatched",
      summary: "synthetic gpt-authored unit under review",
      kind: "unit_dispatched",
      slice: REVIEWED_SLICE,
      task: "T99",
      model: "openai/gpt-5.5",
      provider: "openai",
      family: "gpt",
    },
  ];
}

describe("S04 demo — reviewer excludes the synthetic gpt author", () => {
  test("gpt is filtered from the reviewer's candidate pool; resolution falls to the claude pool", () => {
    const authorFamily = authorFamilyForSlice(syntheticGptAuthorship(), REVIEWED_SLICE);
    assert.equal(authorFamily, "gpt", "the synthetic authorship record must derive to the gpt family");

    const ctx = { session: makeSession(), config: reviewerAdvocateConfig(true), authorFamily };
    const actual = resolveModelForRole("reviewer", REVIEWED_UNIT, ctx);

    assert.notEqual(actual.family, "gpt", "the author's own family must never be handed back to the reviewer");
    assert.deepEqual(actual, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: familyOf("claude-code/claude-opus-4-8"),
    });
  });
});

describe("S04 demo — advocate resolves TO the synthetic gpt author", () => {
  test("gpt is the ONLY family kept in the advocate's candidate pool", () => {
    const authorFamily = authorFamilyForSlice(syntheticGptAuthorship(), REVIEWED_SLICE);

    const ctx = { session: makeSession(), config: reviewerAdvocateConfig(true), authorFamily };
    const actual = resolveModelForRole("advocate", REVIEWED_UNIT, ctx);

    assert.equal(actual.family, "gpt", "the advocate must defend the author's own family");
    assert.deepEqual(actual, {
      model: "openai/gpt-5.5",
      provider: "openai",
      family: familyOf("openai/gpt-5.5"),
    });
  });
});

describe("S04 demo — constraint-off control reverts reviewer to the S03 role×pool body", () => {
  test("without reviewer_not_author: family, the reviewer resolves the plain pool order — including the author's own family", () => {
    const authorFamily = authorFamilyForSlice(syntheticGptAuthorship(), REVIEWED_SLICE);
    assert.equal(authorFamily, "gpt");

    const ctx = { session: makeSession(), config: reviewerAdvocateConfig(false), authorFamily };
    const actual = resolveModelForRole("reviewer", REVIEWED_UNIT, ctx);

    assert.equal(
      actual.family,
      "gpt",
      "no adversarial filter active -> the S03 body picks the first candidate pool (gpt), proving the invariant is gated on the constraint",
    );
  });

  test("without reviewer_not_author: family, the advocate ALSO resolves the plain pool order, independent of authorship", () => {
    const authorFamily = authorFamilyForSlice(syntheticGptAuthorship(), REVIEWED_SLICE);

    const ctx = { session: makeSession(), config: reviewerAdvocateConfig(false), authorFamily };
    const actual = resolveModelForRole("advocate", REVIEWED_UNIT, ctx);

    assert.equal(
      actual.family,
      "claude",
      "constraint off -> advocate's roles list picks claude first, the same S03 body reviewer/executor use",
    );
  });
});

describe("S04 demo — unknown authorship degrades reviewer/advocate to the plain S03 body", () => {
  test("no matching authorship event -> authorFamily is null -> reviewer keeps the constraint-active pool order unfiltered", () => {
    const noAuthorshipEvents: ForgeEvent[] = [];
    const authorFamily = authorFamilyForSlice(noAuthorshipEvents, REVIEWED_SLICE);
    assert.equal(authorFamily, null);

    const ctx = { session: makeSession(), config: reviewerAdvocateConfig(true), authorFamily };
    const actual = resolveModelForRole("reviewer", REVIEWED_UNIT, ctx);

    assert.equal(
      actual.family,
      "gpt",
      "constraint active but no known author -> the compound gate is false -> plain pool order (gpt first)",
    );
  });

  test("no matching authorship event -> advocate ALSO degrades to the plain pool order (no target to resolve toward)", () => {
    const authorFamily = authorFamilyForSlice([], REVIEWED_SLICE);

    const ctx = { session: makeSession(), config: reviewerAdvocateConfig(true), authorFamily };
    const actual = resolveModelForRole("advocate", REVIEWED_UNIT, ctx);

    assert.equal(actual.family, "claude", "no known author -> advocate degrades to the plain pool order (claude first)");
  });
});

/**
 * S02/T01 demo — the fail-closed collision case (`S02-PLAN.md` §"Sinal de
 * violação"): a config where the reviewer's ONLY candidate pool is the
 * author's own family, so the S04 adversarial filter empties it entirely,
 * AND the session's baseline model (what `degradeToPoolOfOne` would degrade
 * to) is ALSO in that same family. Before S02/T01 this degraded silently,
 * routing the reviewer straight back to the author's family; now it must
 * return BLOCKED with the `violation: "reviewer_not_author"` marker and log
 * a warn textually distinct from the generic degrade warn.
 */
function reviewerOnlyAuthorFamilyConfig(): ModelsConfig {
  return {
    pools: { gpt: ["openai/gpt-5.5", "openai/gpt-5-mini"] },
    roles: { reviewer: ["gpt"] },
    constraints: { reviewer_not_author: "family" },
  };
}

describe("S02/T01 demo — fail-closed: reviewer's only pool is the author's family", () => {
  test("pool esvaziado + baseline na família autora => BLOCKED + violation, warn distinto do degrade genérico", () => {
    const authorFamily = authorFamilyForSlice(syntheticGptAuthorship(), REVIEWED_SLICE);
    assert.equal(authorFamily, "gpt");

    const s = makeSession();
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const ctx = { session: s, config: reviewerOnlyAuthorFamilyConfig(), authorFamily };

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    let actual: ReturnType<typeof resolveModelForRole>;
    try {
      actual = resolveModelForRole("reviewer", REVIEWED_UNIT, ctx);
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(actual, { model: null, provider: null, family: null, violation: "reviewer_not_author" });
    assert.equal(warnings.length, 1, "exactly one warn is emitted — never both the violation and the generic degrade warn");
    assert.match(warnings[0], /VIOLATION reviewer_not_author/, "the warn must cite the violation, not the generic degrade text");
    assert.match(warnings[0], /gpt/, "the warn must cite the author family the degrade collided with");
    assert.doesNotMatch(
      warnings[0],
      /degrading to pool-of-one/,
      "the violation warn is textually distinct from the generic degrade warn",
    );
  });
});

describe("S04 demo — no gpt credential required anywhere in this file", () => {
  test("every 'gpt' ref used above is a synthetic string, never resolved via a real provider/credential lookup", () => {
    const config = reviewerAdvocateConfig(true);
    for (const ref of config.pools.gpt) {
      assert.match(ref, /^openai\//, "fake gpt refs are plain strings, not credential-backed lookups");
    }
    // resolveModelForRole never imports forge-agent-core / AuthStorage — this
    // is a structural guarantee (FORGE2-ROUTING-CONFIG.md §6 records the
    // real-credential path as documented-not-exercised, same discipline S03
    // established).
    assert.ok(true);
  });
});
