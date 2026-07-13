/**
 * G2 contract test — proves `unitTypeToRole`/`roleForUnit` map all 4
 * `NextUnit['type']` variants to the right `Role` (unknown → `executor`), that
 * `resolveModelForRole`'s degrade fallback is byte-identical to
 * `effectiveModelFor` + `familyOf` — both the populated case (flat pref) and
 * the absent-fields guard (no model known → all three fields `null`, never
 * `""`/`"null"`, per the G1 invariant inherited from S01) — and (S03) that the
 * body now does real role×pool resolution: ordered pool/ref choose, the
 * availability filter, `on_missing_pool: degrade+warn|block`, and the
 * no-config-on-disk case degrading identically to S02.
 *
 * S04 addition: proves the `reviewer_not_author: family` adversarial filter
 * wired into the pool walk — reviewer excludes the author's family, advocate
 * targets it, both degrade to the untouched S03 body when the constraint is
 * off or the author is unknown, and an emptied pool still falls through to
 * `on_missing_pool` exactly as S03.
 *
 * S05 addition: proves the "rankear" step now runs `rankPool` (T02) AFTER
 * the S04/S03 filters — no hints reproduces the S03 pick byte-identically,
 * `ctx.tierHint`/`ctx.budgetPressure` reach `rankPool` and steer the pick
 * within the pool's downgrade-only teto, and the `reviewer_not_author`
 * invariant still holds when rank is layered on top (the author's family
 * stays excluded; rank only orders the surviving set).
 *
 * S01/T02 do polimento-cockpit addition: proves the `researcher` role —
 * `roleForUnit` routes `{ type: "research-models" }` to `"researcher"` (via
 * `directDispatchRole`, NOT `unitTypeToRole`, which stays exhaustive with no
 * new entry); with no `researcher:` entry in config, `resolveModelForRole`
 * is byte-identical to calling with `"executor"` on the same config (the
 * fallback swaps candidatePools, never spuriously degrades pool-of-one); and
 * with a `researcher: [pool]` entry present, that pool's ref wins over
 * whatever `executor` would have picked.
 *
 * S09/T02 addition: proves the cross-pool JUDGMENT mode (`rankUnion` wired
 * ahead of the per-pool walk) — a scored candidate from a LATER pool beats
 * an unscored/lower-scored candidate from the first pool (capability as the
 * PRIMARY factor, not a finalist tie-break); the guard (no domain, or a
 * domain with zero matrix coverage) is byte-identical to the legacy walk
 * INCLUDING warns (no double `warnUndefinedPool` from the union-construction
 * scan); the adversarial and availability filters still run per-pool BEFORE
 * the union; a ref duplicated across pools is deduped to its first
 * occurrence; and `rank_reason` is present only when judgment ran, never
 * `""`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextUnit } from "../state/dispatch.ts";
import type { ComposableUnit } from "../prompts/compose.ts";
import { familyOf } from "../state/family.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { effectiveModelFor } from "../auto/session.ts";
import { roleForUnit, unitTypeToRole, resolveModelForRole, type Role } from "../auto/role.ts";
import type { ModelsConfig } from "../auto/models-config.ts";
import { unavailableRefsProbe } from "../auto/availability.ts";
import { updateState } from "../state/store.ts";
import { tierHintForUnit } from "../auto/rank-hint.ts";
import { parseCapabilities, emptyCapabilities } from "../auto/capability-matrix.ts";

function makeSession(cwd: string): ForgeAutoSession {
  const s = new ForgeAutoSession();
  s.active = true;
  s.cwd = cwd;
  return s;
}

function emptyConfig(): ModelsConfig {
  return { pools: {}, roles: {}, constraints: {} };
}

function captureWarnings(fn: () => void): string[] {
  const original = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return messages;
}

function withScratchDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-role-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PLAN_SLICE: NextUnit = { type: "plan-slice", slice: "S01" };
const EXECUTE_TASK: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
const COMPLETE_SLICE: NextUnit = { type: "complete-slice", slice: "S01" };
const COMPLETE_MILESTONE: NextUnit = { type: "complete-milestone", milestone: "M-toy" };

describe("unitTypeToRole / roleForUnit — unit-type -> role map", () => {
  test("unitTypeToRole covers all 4 NextUnit variants", () => {
    assert.equal(unitTypeToRole["plan-slice"], "planner");
    assert.equal(unitTypeToRole["execute-task"], "executor");
    assert.equal(unitTypeToRole["complete-slice"], "completer");
    assert.equal(unitTypeToRole["complete-milestone"], "completer");
  });

  test("roleForUnit derives the same role as unitTypeToRole for each variant", () => {
    assert.equal(roleForUnit(PLAN_SLICE), "planner");
    assert.equal(roleForUnit(EXECUTE_TASK), "executor");
    assert.equal(roleForUnit(COMPLETE_SLICE), "completer");
    assert.equal(roleForUnit(COMPLETE_MILESTONE), "completer");
  });

  test("roleForUnit never throws and falls back to 'executor' for an unrecognized type", () => {
    const bogus = { type: "unknown-future-type" } as unknown as NextUnit;
    assert.doesNotThrow(() => roleForUnit(bogus));
    assert.equal(roleForUnit(bogus), "executor");
  });
});

describe("resolveModelForRole — degrade+warn fallback (S02 pool-of-one, no role×pool candidate)", () => {
  test("populated case: equals effectiveModelFor + familyOf for a flat-pref model, role is accepted but ignored", () => {
    // No live `.gsd` on disk is needed — `effectiveModelFor` falls back to
    // `cmdCtx.model`/`baselineModel` when no flat pref is set on disk, so we
    // drive the pool-of-one deterministically via `baselineModel` instead of
    // standing up a sandbox + prefs file (out of scope for this pure-seam test;
    // the real-dispatch flat-pref path is proven end-to-end by
    // `tests/authorship.test.ts`).
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;

    const ctx = { session: s };
    const expected = effectiveModelFor(s, EXECUTE_TASK);
    const expectedFamily = familyOf(expected.model as string);

    for (const role of ["planner", "executor", "completer"] as Role[]) {
      const actual = resolveModelForRole(role, EXECUTE_TASK, ctx);
      assert.deepEqual(actual, { model: expected.model, provider: expected.provider, family: expectedFamily });
    }
  });

  test("absent-fields guard: no model known (no pref, no cmdCtx, no baseline) -> model/provider/family all null", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, { model: null, provider: null, family: null });
  });
});

describe("resolveModelForRole — S03 role×pool: ordered choose + availability filter", () => {
  test("picks the first ref of the first candidate pool when everything is available", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: {
        claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
        gpt: ["openai/gpt-5.5"],
      },
      roles: { executor: ["claude", "gpt"] },
      constraints: {},
    };
    const ctx = { session: s, config };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: familyOf("claude-code/claude-opus-4-8"),
    });
  });

  test("availability filter skips an unavailable ref and picks the next ref in the same pool", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: { claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"] },
      roles: { executor: ["claude"] },
      constraints: {},
    };
    const availabilityProbe = unavailableRefsProbe(["claude-code/claude-opus-4-8"]);
    const ctx = { session: s, config, availabilityProbe };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "claude-code/claude-sonnet-5",
      provider: "claude-code",
      family: familyOf("claude-code/claude-sonnet-5"),
    });
  });

  test("when every ref in the first candidate pool is unavailable, falls through to the next candidate pool", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: {
        claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
        gpt: ["openai/gpt-5.5"],
      },
      roles: { executor: ["claude", "gpt"] },
      constraints: {},
    };
    const availabilityProbe = unavailableRefsProbe([
      "claude-code/claude-opus-4-8",
      "claude-code/claude-sonnet-5",
    ]);
    const ctx = { session: s, config, availabilityProbe };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "openai/gpt-5.5",
      provider: "openai",
      family: familyOf("openai/gpt-5.5"),
    });
  });

  test("role is consumed: planner and executor resolve to different models when their candidate pools differ", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: {
        claude: ["claude-code/claude-opus-4-8"],
        gpt: ["openai/gpt-5.5"],
      },
      roles: { planner: ["claude"], executor: ["gpt"] },
      constraints: {},
    };
    const ctx = { session: s, config };

    const planner = resolveModelForRole("planner", EXECUTE_TASK, ctx);
    const executor = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.equal(planner.model, "claude-code/claude-opus-4-8");
    assert.equal(executor.model, "openai/gpt-5.5");
    assert.notEqual(planner.model, executor.model);
  });

  test("reviewer role in config is never derived by S03's dispatch (unitTypeToRole has no reviewer entry)", () => {
    for (const type of Object.keys(unitTypeToRole) as NextUnit["type"][]) {
      assert.notEqual(unitTypeToRole[type], "reviewer");
    }
  });
});

describe("resolveModelForRole — on_missing_pool: degrade+warn | block", () => {
  test("on_missing_pool: degrade+warn (default) falls back to the pool-of-one body when the role has no roles entry", () => {
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const config: ModelsConfig = { pools: {}, roles: {}, constraints: {} };
    const ctx = { session: s, config };

    const expected = effectiveModelFor(s, EXECUTE_TASK);
    const expectedFamily = familyOf(expected.model as string);
    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, { model: expected.model, provider: expected.provider, family: expectedFamily });
  });

  test("on_missing_pool: degrade+warn (explicit) falls back to the pool-of-one body when no candidate is available", () => {
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const config: ModelsConfig = {
      pools: { claude: ["claude-code/claude-opus-4-8"] },
      roles: { executor: ["claude"] },
      constraints: { on_missing_pool: "degrade+warn" },
    };
    const availabilityProbe = unavailableRefsProbe(["claude-code/claude-opus-4-8"]);
    const ctx = { session: s, config, availabilityProbe };

    const expected = effectiveModelFor(s, EXECUTE_TASK);
    const expectedFamily = familyOf(expected.model as string);
    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, { model: expected.model, provider: expected.provider, family: expectedFamily });
  });

  test("on_missing_pool: block returns a blocked null result when no candidate is available, never falls back", () => {
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const config: ModelsConfig = {
      pools: { claude: ["claude-code/claude-opus-4-8"] },
      roles: { executor: ["claude"] },
      constraints: { on_missing_pool: "block" },
    };
    const availabilityProbe = unavailableRefsProbe(["claude-code/claude-opus-4-8"]);
    const ctx = { session: s, config, availabilityProbe };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, { model: null, provider: null, family: null });
  });

  test("on_missing_pool: block also applies when the role has no roles entry at all", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: {},
      roles: {},
      constraints: { on_missing_pool: "block" },
    };
    const ctx = { session: s, config };

    const actual = resolveModelForRole("planner", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, { model: null, provider: null, family: null });
  });

  test("family null guard: a blocked result's family is strictly null, never '' or the string 'null'", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = { pools: {}, roles: {}, constraints: { on_missing_pool: "block" } };
    const ctx = { session: s, config };

    const actual = resolveModelForRole("completer", EXECUTE_TASK, ctx);

    assert.strictEqual(actual.family, null);
    assert.notEqual(actual.family, "");
    assert.notEqual(actual.family, "null");
  });
});

describe("resolveModelForRole — S04 reviewer_not_author: family filter", () => {
  const REVIEW_UNIT: NextUnit = { type: "execute-task", slice: "S04", task: "T02" };
  function familyConfig(): ModelsConfig {
    return {
      pools: {
        claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
        gpt: ["openai/gpt-5.5"],
      },
      roles: { reviewer: ["claude", "gpt"], advocate: ["claude", "gpt"] },
      constraints: { reviewer_not_author: "family" },
    };
  }

  test("reviewer excludes every ref from the author's family and picks the first ref of the next pool", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s, config: familyConfig(), authorFamily: "claude" };

    const actual = resolveModelForRole("reviewer", REVIEW_UNIT, ctx);

    assert.deepEqual(actual, { model: "openai/gpt-5.5", provider: "openai", family: "gpt" });
  });

  test("advocate keeps only refs from the author's family and picks the first one", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s, config: familyConfig(), authorFamily: "claude" };

    const actual = resolveModelForRole("advocate", REVIEW_UNIT, ctx);

    assert.deepEqual(actual, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: "claude",
    });
  });

  test("constraint absent: reviewer/advocate resolution is byte-identical to the plain S03 role×pool body", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: familyConfig().pools,
      roles: familyConfig().roles,
      constraints: {}, // no reviewer_not_author
    };
    const withAuthor = { session: s, config, authorFamily: "claude" };
    const withoutFilterConfig = { session: s, config };

    for (const role of ["reviewer", "advocate"] as Role[]) {
      const filtered = resolveModelForRole(role, REVIEW_UNIT, withAuthor);
      const unfiltered = resolveModelForRole(role, REVIEW_UNIT, withoutFilterConfig);
      assert.deepEqual(filtered, unfiltered);
      assert.deepEqual(filtered, {
        model: "claude-code/claude-opus-4-8",
        provider: "claude-code",
        family: "claude",
      });
    }
  });

  test("authorFamily null: reviewer/advocate resolution degrades to the plain S03 role×pool body", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config = familyConfig();
    const withNullAuthor = { session: s, config, authorFamily: null };
    const noAuthor = { session: s, config };

    for (const role of ["reviewer", "advocate"] as Role[]) {
      const actual = resolveModelForRole(role, REVIEW_UNIT, withNullAuthor);
      const expected = resolveModelForRole(role, REVIEW_UNIT, noAuthor);
      assert.deepEqual(actual, expected);
      assert.deepEqual(actual, {
        model: "claude-code/claude-opus-4-8",
        provider: "claude-code",
        family: "claude",
      });
    }
  });

  test("authorFamily undefined (omitted): reviewer/advocate resolution degrades to the plain S03 role×pool body", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s, config: familyConfig() };

    const reviewer = resolveModelForRole("reviewer", REVIEW_UNIT, ctx);
    const advocate = resolveModelForRole("advocate", REVIEW_UNIT, ctx);

    assert.deepEqual(reviewer, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: "claude",
    });
    assert.deepEqual(advocate, reviewer);
  });

  test("S02/T01 re-pin: reviewer filter emptying every pool degrades ONLY because the degrade target's family differs from the author's", () => {
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const config: ModelsConfig = {
      pools: { claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"] },
      roles: { reviewer: ["claude"] },
      constraints: { reviewer_not_author: "family" },
    };
    const ctx = { session: s, config, authorFamily: "claude" };

    const expected = effectiveModelFor(s, REVIEW_UNIT);
    const expectedFamily = familyOf(expected.model as string);
    assert.notEqual(
      expectedFamily,
      "claude",
      "this case only degrades because the baseline (gpt) differs from the author (claude) — the collision case is covered separately below",
    );

    const actual = resolveModelForRole("reviewer", REVIEW_UNIT, ctx);

    assert.deepEqual(actual, { model: expected.model, provider: expected.provider, family: expectedFamily });
    assert.equal("violation" in actual, false, "no family collision -> no violation marker on the accepted degrade");
  });

  test("S02/T01 fail-closed: reviewer filter emptying every pool, degrade target family === author family -> BLOCKED + violation, never degrades", () => {
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const config: ModelsConfig = {
      pools: { gpt: ["openai/gpt-5.5"] },
      roles: { reviewer: ["gpt"] },
      constraints: { reviewer_not_author: "family" },
    };
    const ctx = { session: s, config, authorFamily: "gpt" };

    const wouldDegradeTo = effectiveModelFor(s, REVIEW_UNIT);
    assert.equal(
      familyOf(wouldDegradeTo.model as string),
      "gpt",
      "the baseline the seam would otherwise degrade to must share the author's family for this to be the collision case",
    );

    const actual = resolveModelForRole("reviewer", REVIEW_UNIT, ctx);

    assert.deepEqual(actual, { model: null, provider: null, family: null, violation: "reviewer_not_author" });
  });

  test("on_missing_pool: block applies to an advocate pool emptied by an unknown author family", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: { claude: ["claude-code/claude-opus-4-8"] },
      roles: { advocate: ["claude"] },
      constraints: { reviewer_not_author: "family", on_missing_pool: "block" },
    };
    const ctx = { session: s, config, authorFamily: "gpt" };

    const actual = resolveModelForRole("advocate", REVIEW_UNIT, ctx);

    assert.deepEqual(actual, { model: null, provider: null, family: null });
  });

  test("planner/executor/completer are never touched by the adversarial filter even with a matching authorFamily", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: { claude: ["claude-code/claude-opus-4-8"] },
      roles: { executor: ["claude"] },
      constraints: { reviewer_not_author: "family" },
    };
    const ctx = { session: s, config, authorFamily: "claude" };

    const actual = resolveModelForRole("executor", REVIEW_UNIT, ctx);

    assert.deepEqual(actual, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: "claude",
    });
  });
});

describe("resolveModelForRole — no config on disk == S02 degenerate baseline", () => {
  test("with no .gsd/models.md and no injected config, resolution equals the S02 pool-of-one body", () => {
    withScratchDir((cwd) => {
      const s = makeSession(cwd);
      s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
      const ctx = { session: s };

      const expected = effectiveModelFor(s, EXECUTE_TASK);
      const expectedFamily = familyOf(expected.model as string);
      const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

      assert.deepEqual(actual, { model: expected.model, provider: expected.provider, family: expectedFamily });
    });
  });

  test("with no .gsd/models.md, an explicitly empty injected config behaves the same as omitting config", () => {
    withScratchDir((cwd) => {
      const s = makeSession(cwd);
      const ctx = { session: s, config: emptyConfig() };

      const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

      assert.deepEqual(actual, { model: null, provider: null, family: null });
    });
  });
});

describe("resolveModelForRole — S06/T02: pool-inexistente (named WARN) vs pool-esgotado (silent fall-through)", () => {
  test("candidate pool name absent from config.pools emits a named WARN and still falls through to the next pool", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: { gpt: ["openai/gpt-5.5"] },
      roles: { executor: ["clawde", "gpt"] }, // typo: "clawde" is not a key of pools
      constraints: {},
    };
    const ctx = { session: s, config };

    let actual: ReturnType<typeof resolveModelForRole>;
    const warnings = captureWarnings(() => {
      actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);
    });

    assert.deepEqual(actual!, { model: "openai/gpt-5.5", provider: "openai", family: familyOf("openai/gpt-5.5") });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[forge\] resolveModelForRole:/);
    assert.match(warnings[0], /role "executor"/);
    assert.match(warnings[0], /undefined pool "clawde"/);
  });

  test("candidate pool name EXISTS in config.pools but every ref is unavailable: no undefined-pool WARN, silent fall-through", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: {
        claude: ["claude-code/claude-opus-4-8"],
        gpt: ["openai/gpt-5.5"],
      },
      roles: { executor: ["claude", "gpt"] },
      constraints: {},
    };
    const availabilityProbe = unavailableRefsProbe(["claude-code/claude-opus-4-8"]);
    const ctx = { session: s, config, availabilityProbe };

    let actual: ReturnType<typeof resolveModelForRole>;
    const warnings = captureWarnings(() => {
      actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);
    });

    assert.deepEqual(actual!, { model: "openai/gpt-5.5", provider: "openai", family: familyOf("openai/gpt-5.5") });
    assert.deepEqual(warnings, [], "an existing-but-exhausted pool must NOT emit the undefined-pool WARN");
  });

  test("successful resolve (pool exists, ref available) emits zero undefined-pool WARNs and returns the same winner as before", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: {
        claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
        gpt: ["openai/gpt-5.5"],
      },
      roles: { executor: ["claude", "gpt"] },
      constraints: {},
    };
    const ctx = { session: s, config };

    let actual: ReturnType<typeof resolveModelForRole>;
    const warnings = captureWarnings(() => {
      actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);
    });

    assert.deepEqual(actual!, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: familyOf("claude-code/claude-opus-4-8"),
    });
    assert.deepEqual(warnings, []);
  });

  test("role with no config.roles entry: no-config S03 path, never an undefined-pool WARN", () => {
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const config: ModelsConfig = {
      pools: { claude: ["claude-code/claude-opus-4-8"] },
      roles: {}, // "executor" has no entry at all
      constraints: {},
    };
    const ctx = { session: s, config };

    const expected = effectiveModelFor(s, EXECUTE_TASK);
    const expectedFamily = familyOf(expected.model as string);

    let actual: ReturnType<typeof resolveModelForRole>;
    const warnings = captureWarnings(() => {
      actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);
    });

    assert.deepEqual(actual!, { model: expected.model, provider: expected.provider, family: expectedFamily });
    assert.ok(
      warnings.every((w) => !w.includes("references undefined pool")),
      "no candidatePools walk happens (roles[role] is absent) -> no undefined-pool WARN can fire, though the generic degrade warn still does",
    );
  });

  test("an undefined pool that empties the walk still degrades exactly as before, with the generic degrade warn appended after the undefined-pool warn", () => {
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const config: ModelsConfig = {
      pools: {},
      roles: { executor: ["ghost-pool"] },
      constraints: {},
    };
    const ctx = { session: s, config };

    const expected = effectiveModelFor(s, EXECUTE_TASK);
    const expectedFamily = familyOf(expected.model as string);

    let actual: ReturnType<typeof resolveModelForRole>;
    const warnings = captureWarnings(() => {
      actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);
    });

    assert.deepEqual(actual!, { model: expected.model, provider: expected.provider, family: expectedFamily });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /undefined pool "ghost-pool"/);
    assert.match(warnings[1], /degrading to pool-of-one/);
  });
});

describe("resolveModelForRole — S05 rankPool wired into the rankear step", () => {
  // `openai` is NOT flat-rate (`PROVIDER_FLAT_RATE` in model-capabilities.ts),
  // unlike `claude-code` — a pool of only `openai` refs is the one that
  // actually exercises tierHint/budgetPressure rather than short-circuiting
  // to the flat-rate suppression path. `openai/gpt-5.5` is `max`,
  // `openai/gpt-5-mini` is `light` (T01's table) — a real two-tier gap.
  function gptOnlyConfig(): ModelsConfig {
    return {
      pools: { gpt: ["openai/gpt-5.5", "openai/gpt-5-mini"] },
      roles: { executor: ["gpt"] },
      constraints: {},
    };
  }

  test("(a) no hints, no budget pressure, non-flat-rate pool: picks the pool's declared top ref — byte-identical to S03", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s, config: gptOnlyConfig() };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "openai/gpt-5.5",
      provider: "openai",
      family: familyOf("openai/gpt-5.5"),
    });
  });

  test("(b) ctx.tierHint descends within the pool's teto", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s, config: gptOnlyConfig(), tierHint: "light" as const };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "openai/gpt-5-mini",
      provider: "openai",
      family: familyOf("openai/gpt-5-mini"),
    });
  });

  test("(c) ctx.budgetPressure forces a downgrade within the pool even without a tierHint", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s, config: gptOnlyConfig(), budgetPressure: true };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "openai/gpt-5-mini",
      provider: "openai",
      family: familyOf("openai/gpt-5-mini"),
    });
  });

  test("(d) reviewer_not_author + rank compose: author's family stays excluded, rank still orders the surviving pool", () => {
    const s = makeSession("/tmp/does-not-matter");
    const REVIEW_UNIT: NextUnit = { type: "execute-task", slice: "S05", task: "T03" };
    const config: ModelsConfig = {
      pools: {
        claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
        gpt: ["openai/gpt-5.5", "openai/gpt-5-mini"],
      },
      roles: { reviewer: ["claude", "gpt"] },
      constraints: { reviewer_not_author: "family" },
    };
    const ctx = { session: s, config, authorFamily: "claude", tierHint: "light" as const };

    const actual = resolveModelForRole("reviewer", REVIEW_UNIT, ctx);

    // The author's family (claude) is excluded from every pool — the `claude`
    // pool empties out entirely and is skipped, same as S04. The `gpt` pool
    // survives adversarial narrowing (it was never the author's family), and
    // the rank — not pool order — picks the winner within it via `tierHint`.
    assert.notEqual(actual.family, "claude");
    assert.deepEqual(actual, {
      model: "openai/gpt-5-mini",
      provider: "openai",
      family: "gpt",
    });
  });
});

describe("resolveModelForRole — S09/T02: cross-pool JUDGMENT mode (rankUnion wired into G2)", () => {
  const CROSS_POOL_UNIT: NextUnit = { type: "execute-task", slice: "S09", task: "T02" };
  const REVIEW_UNIT: NextUnit = { type: "execute-task", slice: "S09", task: "T02-review" };

  // Mirrors the addendum's worked example: "claude-exec" is the FIRST
  // declared pool (sonnet), "gpt" is the SECOND (terra) — the union must let
  // terra win on capability alone, despite pool order favoring sonnet.
  function crossPoolConfig(): ModelsConfig {
    return {
      pools: {
        "claude-exec": ["claude-code/claude-sonnet-5"],
        gpt: ["openai-codex/gpt-5.6-terra"],
      },
      roles: { executor: ["claude-exec", "gpt"] },
      constraints: {},
    };
  }

  // Real curated values from .gsd/CAPABILITIES.md's infra row (sonnet 0.65,
  // terra 0.90) — not arbitrary, so the ε=0.05 gap-is-decisive branch (T01)
  // is exercised with production-shaped numbers.
  const INFRA_MATRIX = parseCapabilities(
    [
      "| domain | model | score |",
      "| --- | --- | --- |",
      "| infra | claude-code/claude-sonnet-5 | 0.65 |",
      "| infra | openai-codex/gpt-5.6-terra | 0.90 |",
    ].join("\n"),
  );

  test("(a) terra (2nd pool, higher score) beats sonnet (1st pool) for domain infra — capability is the PRIMARY factor", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s, config: crossPoolConfig(), domain: "infra", capabilities: INFRA_MATRIX };

    const actual = resolveModelForRole("executor", CROSS_POOL_UNIT, ctx);

    assert.equal(actual.model, "openai-codex/gpt-5.6-terra");
    assert.equal(actual.provider, "openai-codex");
    assert.equal(actual.family, familyOf("openai-codex/gpt-5.6-terra"));
    assert.ok(actual.rank_reason && actual.rank_reason.length > 0, "rank_reason must be present and non-empty");
    assert.match(actual.rank_reason!, /^capability:infra/);
  });

  test("(b) same setup WITHOUT domain -> byte-identical to the legacy walk: sonnet (1st pool) wins, no rank_reason", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s, config: crossPoolConfig() };

    const actual = resolveModelForRole("executor", CROSS_POOL_UNIT, ctx);

    assert.deepEqual(actual, {
      model: "claude-code/claude-sonnet-5",
      provider: "claude-code",
      family: familyOf("claude-code/claude-sonnet-5"),
    });
    assert.equal("rank_reason" in actual, false);
  });

  test("(c) domain present but zero matrix coverage -> guard falls back, byte-identical to (b), no rank_reason", () => {
    const s = makeSession("/tmp/does-not-matter");
    const withoutDomain = { session: s, config: crossPoolConfig() };
    const withEmptyMatrix = {
      session: s,
      config: crossPoolConfig(),
      domain: "infra",
      capabilities: emptyCapabilities(),
    };

    const withoutActual = resolveModelForRole("executor", CROSS_POOL_UNIT, withoutDomain);
    const withEmptyActual = resolveModelForRole("executor", CROSS_POOL_UNIT, withEmptyMatrix);

    assert.deepEqual(withEmptyActual, withoutActual);
    assert.equal("rank_reason" in withEmptyActual, false);
  });

  test("(c-warn) guard byte-identity extends to warns: an undefined pool warns exactly once, never doubled by the union-construction scan", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: { gpt: ["openai-codex/gpt-5.6-terra"] },
      roles: { executor: ["clawde-exec", "gpt"] }, // typo: not a key of pools
      constraints: {},
    };

    let noDomainWarnings: string[] = [];
    const noDomainActual = (() => {
      let result!: ReturnType<typeof resolveModelForRole>;
      noDomainWarnings = captureWarnings(() => {
        result = resolveModelForRole("executor", CROSS_POOL_UNIT, { session: s, config });
      });
      return result;
    })();

    let zeroCoverageWarnings: string[] = [];
    const zeroCoverageActual = (() => {
      let result!: ReturnType<typeof resolveModelForRole>;
      zeroCoverageWarnings = captureWarnings(() => {
        result = resolveModelForRole("executor", CROSS_POOL_UNIT, {
          session: s,
          config,
          domain: "infra",
          capabilities: emptyCapabilities(),
        });
      });
      return result;
    })();

    assert.deepEqual(zeroCoverageActual, noDomainActual);
    assert.equal(noDomainWarnings.length, 1, "exactly one undefined-pool WARN, same as before S09");
    assert.deepEqual(
      zeroCoverageWarnings,
      noDomainWarnings,
      "the union-construction scan must not re-emit warnUndefinedPool — the guard path warns exactly once, not twice",
    );
  });

  test("(d) reviewer + authorFamily: the union excludes the author's family BEFORE the rank, even though it scores highest", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: {
        claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
        gpt: ["openai-codex/gpt-5.6-terra"],
      },
      roles: { reviewer: ["claude", "gpt"] },
      constraints: { reviewer_not_author: "family" },
    };
    const matrix = parseCapabilities(
      [
        "| domain | model | score |",
        "| --- | --- | --- |",
        "| infra | claude-code/claude-opus-4-8 | 0.95 |",
        "| infra | claude-code/claude-sonnet-5 | 0.65 |",
        "| infra | openai-codex/gpt-5.6-terra | 0.90 |",
      ].join("\n"),
    );
    const ctx = { session: s, config, domain: "infra", capabilities: matrix, authorFamily: "claude" };

    const actual = resolveModelForRole("reviewer", REVIEW_UNIT, ctx);

    assert.equal(
      actual.model,
      "openai-codex/gpt-5.6-terra",
      "opus scores highest (0.95) but shares the author's family — the adversarial filter excludes it before the union ever sees it",
    );
    assert.notEqual(actual.family, "claude");
    assert.ok(actual.rank_reason);
    assert.doesNotMatch(actual.rank_reason!, /opus|sonnet/, "an excluded-family ref must never appear in the reason");
  });

  test("(e) availability filter runs BEFORE the union: an unavailable higher-scored ref is excluded, the next scored ref wins", () => {
    const s = makeSession("/tmp/does-not-matter");
    const availabilityProbe = unavailableRefsProbe(["openai-codex/gpt-5.6-terra"]);
    const ctx = {
      session: s,
      config: crossPoolConfig(),
      domain: "infra",
      capabilities: INFRA_MATRIX,
      availabilityProbe,
    };

    const actual = resolveModelForRole("executor", CROSS_POOL_UNIT, ctx);

    assert.equal(actual.model, "claude-code/claude-sonnet-5", "terra is unavailable -> sonnet, the only surviving scored candidate, wins");
    assert.ok(actual.rank_reason && actual.rank_reason.length > 0, "(f) rank_reason is present and non-empty even with a single scored candidate");
  });

  test("(f) rank_reason is never the empty string across every judgment-mode result observed above", () => {
    const s = makeSession("/tmp/does-not-matter");
    const ctx = { session: s, config: crossPoolConfig(), domain: "infra", capabilities: INFRA_MATRIX };

    const actual = resolveModelForRole("executor", CROSS_POOL_UNIT, ctx);

    assert.notEqual(actual.rank_reason, "");
    assert.equal(typeof actual.rank_reason, "string");
  });

  test("dedupe: a ref duplicated across two pools counts once — the union's runner-up clause never self-compares the same ref", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: {
        poolA: ["openai-codex/gpt-5.6-terra"],
        poolB: ["openai-codex/gpt-5.6-terra"], // same ref, second pool
      },
      roles: { executor: ["poolA", "poolB"] },
      constraints: {},
    };
    const matrix = parseCapabilities(
      ["| domain | model | score |", "| --- | --- | --- |", "| infra | openai-codex/gpt-5.6-terra | 0.90 |"].join(
        "\n",
      ),
    );
    const ctx = { session: s, config, domain: "infra", capabilities: matrix };

    const actual = resolveModelForRole("executor", CROSS_POOL_UNIT, ctx);

    assert.equal(actual.model, "openai-codex/gpt-5.6-terra");
    assert.equal(
      actual.rank_reason,
      "capability:infra openai-codex/gpt-5.6-terra 0.90",
      "a single deduped candidate has no runner-up clause; a non-deduped union would self-compare the same ref twice",
    );
  });
});

describe("researcher role — S01/T02 do polimento-cockpit: union, roteamento, fallback byte-compat", () => {
  const RESEARCH_MODELS_UNIT: ComposableUnit = { type: "research-models" };

  function executorPoolConfig(): ModelsConfig {
    return {
      pools: {
        claude: ["claude-code/claude-opus-4-8"],
        gpt: ["openai/gpt-5.5"],
      },
      roles: { executor: ["claude", "gpt"] },
      constraints: {},
    };
  }

  test("roleForUnit routes research-models to 'researcher' (not the 'executor' fallback)", () => {
    assert.equal(roleForUnit(RESEARCH_MODELS_UNIT), "researcher");
  });

  test("unitTypeToRole stays exhaustive over NextUnit['type'] — no 'research-models' key, no 'researcher' value", () => {
    assert.equal(Object.keys(unitTypeToRole).length, 4);
    for (const type of Object.keys(unitTypeToRole) as NextUnit["type"][]) {
      assert.notEqual(unitTypeToRole[type], "researcher");
    }
  });

  test("no researcher: entry in config -> resolution is byte-identical to resolveModelForRole('executor', ...) on the same config", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config = executorPoolConfig();
    const ctx = { session: s, config };

    const researcher = resolveModelForRole("researcher", RESEARCH_MODELS_UNIT, ctx);
    const executor = resolveModelForRole("executor", RESEARCH_MODELS_UNIT, ctx);

    assert.deepEqual(researcher, executor);
    assert.deepEqual(researcher, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: familyOf("claude-code/claude-opus-4-8"),
    });
  });

  test("no researcher: entry and no executor: entry either -> degrades exactly like executor would (S02 pool-of-one), no spurious warn", () => {
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const config: ModelsConfig = { pools: {}, roles: {}, constraints: {} };
    const ctx = { session: s, config };

    const expected = effectiveModelFor(s, RESEARCH_MODELS_UNIT);
    const expectedFamily = familyOf(expected.model as string);

    let actual: ReturnType<typeof resolveModelForRole>;
    const warnings = captureWarnings(() => {
      actual = resolveModelForRole("researcher", RESEARCH_MODELS_UNIT, ctx);
    });

    assert.deepEqual(actual!, { model: expected.model, provider: expected.provider, family: expectedFamily });
    assert.equal(warnings.length, 1, "only the generic degrade warn — no pool-of-one-from-empty-array warn beyond that");
  });

  test("with researcher: [pool] configured, the researcher pool's ref wins even when it differs from what executor would pick", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: {
        claude: ["claude-code/claude-opus-4-8"],
        "grok-pool": ["xai/grok-4"],
      },
      roles: { executor: ["claude"], researcher: ["grok-pool"] },
      constraints: {},
    };
    const ctx = { session: s, config };

    const researcher = resolveModelForRole("researcher", RESEARCH_MODELS_UNIT, ctx);
    const executor = resolveModelForRole("executor", RESEARCH_MODELS_UNIT, ctx);

    assert.deepEqual(researcher, { model: "xai/grok-4", provider: "xai", family: familyOf("xai/grok-4") });
    assert.notDeepEqual(researcher, executor);
  });

  test("researcher: [] (present but empty) is honored as declared — NOT the executor fallback", () => {
    const s = makeSession("/tmp/does-not-matter");
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const config: ModelsConfig = {
      pools: { claude: ["claude-code/claude-opus-4-8"] },
      roles: { executor: ["claude"], researcher: [] },
      constraints: {},
    };
    const ctx = { session: s, config };

    const expected = effectiveModelFor(s, RESEARCH_MODELS_UNIT);
    const expectedFamily = familyOf(expected.model as string);
    const actual = resolveModelForRole("researcher", RESEARCH_MODELS_UNIT, ctx);

    assert.deepEqual(actual, { model: expected.model, provider: expected.provider, family: expectedFamily });
  });

  test("S01/R1: file-backed researcher: [] (via .gsd/models.md) is honored as declared, not dropped by the parser", () => {
    withScratchDir((cwd) => {
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(
        join(cwd, ".gsd", "models.md"),
        [
          "```yaml",
          "models:",
          "  pools:",
          "    claude: [claude-code/claude-opus-4-8]",
          "  roles:",
          "    executor: [claude]",
          "    researcher: []",
          "```",
        ].join("\n"),
      );
      const s = makeSession(cwd);
      s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
      const ctx = { session: s };

      const expected = effectiveModelFor(s, RESEARCH_MODELS_UNIT);
      const expectedFamily = familyOf(expected.model as string);
      const actual = resolveModelForRole("researcher", RESEARCH_MODELS_UNIT, ctx);

      assert.deepEqual(
        actual,
        { model: expected.model, provider: expected.provider, family: expectedFamily },
        "an explicit empty researcher: [] on disk must degrade like S02 pool-of-one, NOT silently fall back to the executor pool",
      );
    });
  });
});

describe("tierHintForUnit — pre-resolved reader of the planner's tier frontmatter hint", () => {
  function writePlan(cwd: string, milestone: string, slice: string, task: string, frontmatterExtra: string): void {
    const taskDir = join(cwd, ".gsd", "milestones", milestone, "slices", slice, "tasks", task);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, `${task}-PLAN.md`),
      `---\nid: ${task}\nslice: ${slice}\nmilestone: ${milestone}\n${frontmatterExtra}---\n\n# ${task}\n`,
      "utf-8",
    );
  }

  test("(e) returns the declared tier for a plan whose frontmatter carries one", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "tier: heavy\n");

      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      assert.equal(tierHintForUnit(cwd, unit), "heavy");
    });
  });

  test("(e) returns undefined for a plan with no tier field", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "");

      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      assert.equal(tierHintForUnit(cwd, unit), undefined);
    });
  });

  test("returns undefined for a non-execute-task unit without touching disk", () => {
    withScratchDir((cwd) => {
      assert.equal(tierHintForUnit(cwd, PLAN_SLICE), undefined);
      assert.equal(tierHintForUnit(cwd, COMPLETE_SLICE), undefined);
      assert.equal(tierHintForUnit(cwd, COMPLETE_MILESTONE), undefined);
    });
  });

  test("returns undefined (never throws) when no STATE.md / no plan file exists on disk", () => {
    withScratchDir((cwd) => {
      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      assert.doesNotThrow(() => tierHintForUnit(cwd, unit));
      assert.equal(tierHintForUnit(cwd, unit), undefined);
    });
  });

  test("returns undefined (never throws) for an invalid tier value in the frontmatter", () => {
    withScratchDir((cwd) => {
      updateState(cwd, (state) => ({ ...state, milestone: "M-toy" }));
      writePlan(cwd, "M-toy", "S01", "T01", "tier: nonsense-tier\n");

      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };
      assert.doesNotThrow(() => tierHintForUnit(cwd, unit));
      assert.equal(tierHintForUnit(cwd, unit), undefined);
    });
  });
});

describe("task-plan/task-execute role — S02/T01 do M-20260712170458-cockpit-v2", () => {
  const TASK_PLAN_UNIT: ComposableUnit = { type: "task-plan", taskId: "T-20260712170000-foo" };
  const TASK_EXECUTE_UNIT: ComposableUnit = { type: "task-execute", taskId: "T-20260712170000-foo" };

  test("roleForUnit({type:'task-plan', ...}) === 'planner' (via directDispatchRole)", () => {
    assert.equal(roleForUnit(TASK_PLAN_UNIT), "planner");
  });

  test("roleForUnit({type:'task-execute', ...}) === 'executor' (tolerant fallback, no directDispatchRole entry)", () => {
    assert.equal(roleForUnit(TASK_EXECUTE_UNIT), "executor");
  });

  test("unitTypeToRole stays exhaustive over NextUnit['type'] only — no 'task-plan'/'task-execute' key, no new value leaked", () => {
    assert.equal(Object.keys(unitTypeToRole).length, 4);
    for (const type of Object.keys(unitTypeToRole) as NextUnit["type"][]) {
      assert.notEqual(type, "task-plan");
      assert.notEqual(type, "task-execute");
    }
  });

  test("resolveModelForRole('planner', task-plan unit, ...) resolves through the same role×pool body as any other planner dispatch", () => {
    const s = makeSession("/tmp/does-not-matter");
    const config: ModelsConfig = {
      pools: { claude: ["claude-code/claude-opus-4-8"] },
      roles: { planner: ["claude"] },
      constraints: {},
    };
    const ctx = { session: s, config };

    const actual = resolveModelForRole(roleForUnit(TASK_PLAN_UNIT), TASK_PLAN_UNIT, ctx);

    assert.deepEqual(actual, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: familyOf("claude-code/claude-opus-4-8"),
    });
  });
});
