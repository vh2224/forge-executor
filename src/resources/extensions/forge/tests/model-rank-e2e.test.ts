/**
 * S05 demo evidence — the literal contract of ROADMAP §Demos S05: "budget
 * pressure força downgrade dentro do pool" + "provider flat-rate suprime o
 * routing", plus the downgrade-only teto and the two non-regression controls
 * this task's must-haves name explicitly.
 *
 * This is deliberately a SEPARATE file from `role.test.ts` (T03's exhaustive
 * unit coverage of the seam's rankear step) and from `model-rank.test.ts`
 * (T02's exhaustive unit coverage of `rankPool` in isolation): this file
 * drives `resolveModelForRole` end to end — the same seam S03/S04's demo
 * files drive — with the 2-family fixture mirrored byte-for-byte from
 * `tests/role-pool.test.ts` (S03), proving the D6 rank is actually reachable
 * through the seam, not just correct in isolation.
 *
 * No real `gpt`/`openai` credential is read or required anywhere in this
 * file — both "families" are synthetic `provider/model-id` strings, no
 * `AvailabilityProbe` is injected (every ref is available by default), and
 * `tierHint`/`budgetPressure` are injected directly into `ResolveModelCtx`,
 * exactly the way T03's `tierHintForUnit` pre-resolves a hint outside the
 * seam (the seam itself never reads a plan file or a budget source).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NextUnit } from "../state/dispatch.ts";
import { familyOf } from "../state/family.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { resolveModelForRole } from "../auto/role.ts";
import type { ModelsConfig } from "../auto/models-config.ts";

function makeSession(cwd = "/tmp/does-not-matter"): ForgeAutoSession {
  const s = new ForgeAutoSession();
  s.active = true;
  s.cwd = cwd;
  return s;
}

const EXECUTE_TASK: NextUnit = { type: "execute-task", slice: "S05", task: "T04" };

/**
 * The 2 fake families locked in `S03-PLAN.md §Config surface` and mirrored
 * byte-for-byte from `tests/role-pool.test.ts`'s `twoFamilyConfig()` — same
 * refs, same pool order, same role wiring. Reused here (not imported: each
 * S03/S04/S05 demo file declares its own copy, precedent set by
 * `reviewer-independence-e2e.test.ts` not importing `role-pool.test.ts`
 * either) so this file reads standalone.
 */
function twoFamilyConfig(): ModelsConfig {
  return {
    pools: {
      claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
      gpt: ["openai/gpt-5.5", "openai/gpt-5-mini"],
    },
    roles: { executor: ["claude", "gpt"] },
    constraints: {},
  };
}

/**
 * Isolates the `gpt` pool (pay-per-token, `openai`) as the executor's ONLY
 * candidate — proves the budget-pressure downgrade without the flat-rate
 * short-circuit (the `claude` pool) ever entering the picture.
 */
function gptOnlyConfig(): ModelsConfig {
  return {
    pools: { gpt: ["openai/gpt-5.5", "openai/gpt-5-mini"] },
    roles: { executor: ["gpt"] },
    constraints: {},
  };
}

/**
 * Isolates the `claude` pool (flat-rate, `claude-code`) as the executor's
 * ONLY candidate — proves flat-rate suppression in isolation from the
 * budget-pressure/tier-hint mechanics the `gpt` pool exercises above.
 */
function claudeOnlyConfig(): ModelsConfig {
  return {
    pools: { claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"] },
    roles: { executor: ["claude"] },
    constraints: {},
  };
}

/**
 * The `gpt` pool with its 2 known refs REORDERED so the declared teto
 * (`eligibleRefs[0]`, per `model-rank.ts`'s contract) is the LIGHT-tier ref
 * (`gpt-5-mini`) instead of the max-tier one — while `gpt-5.5` (tier `max`)
 * still sits later in the same pool. This isolates downgrade-only from the
 * flat-rate short-circuit (both `openai` refs are pay-per-token) and proves
 * the teto is the pool's DECLARED top, not simply "the highest tier any ref
 * in the pool happens to have": an aggressive `tierHint: "max"` must NOT
 * reach past `gpt-5-mini` to grab `gpt-5.5`, even though `gpt-5.5` is right
 * there in the same pool.
 */
function gptReorderedConfig(): ModelsConfig {
  return {
    pools: { gpt: ["openai/gpt-5-mini", "openai/gpt-5.5"] },
    roles: { executor: ["gpt"] },
    constraints: {},
  };
}

/**
 * The S04 reviewer/advocate fixture (`reviewer-independence-e2e.test.ts`),
 * mirrored: `gpt` listed FIRST in `roles.reviewer` so the demo proves the
 * adversarial filter (not coincidence) is what keeps the author's family out
 * — now composed with `budgetPressure: true` to prove the rank never
 * resurfaces the excluded family even under downgrade pressure.
 */
function reviewerConfig(): ModelsConfig {
  return {
    pools: {
      claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
      gpt: ["openai/gpt-5.5", "openai/gpt-5-mini"],
    },
    roles: { reviewer: ["gpt", "claude"] },
    constraints: { reviewer_not_author: "family" },
  };
}

describe("S05 demo — budget pressure força downgrade dentro do pool", () => {
  test("control: sem budgetPressure, resolveModelForRole escolhe o topo do pool gpt", () => {
    const ctx = { session: makeSession(), config: gptOnlyConfig() };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "openai/gpt-5.5",
      provider: "openai",
      family: familyOf("openai/gpt-5.5"),
    });
  });

  test("com budgetPressure: true, resolveModelForRole desce para o tier mais leve do MESMO pool", () => {
    const ctx = { session: makeSession(), config: gptOnlyConfig(), budgetPressure: true };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "openai/gpt-5-mini",
      provider: "openai",
      family: familyOf("openai/gpt-5-mini"),
    });
    assert.equal(actual.family, "gpt", "downgrade stays inside the SAME family/pool, never crosses pools");
  });
});

describe("S05 demo — provider flat-rate suprime o routing", () => {
  test("budget pressure + hint light contra o pool claude (flat-rate) AINDA escolhe o topo", () => {
    const ctx = {
      session: makeSession(),
      config: claudeOnlyConfig(),
      tierHint: "light" as const,
      budgetPressure: true,
    };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: familyOf("claude-code/claude-opus-4-8"),
    });
    assert.equal(
      actual.model,
      "claude-code/claude-opus-4-8",
      "flat-rate provider suppresses ALL fine rank — hint and budget pressure are both no-ops here",
    );
  });

  test("control: o mesmo pool SEM hint/budget escolhe o mesmo topo (routing não muda nada num provider flat-rate)", () => {
    const ctx = { session: makeSession(), config: claudeOnlyConfig() };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.equal(actual.model, "claude-code/claude-opus-4-8");
  });
});

describe("S05 demo — downgrade-only (teto = topo declarado do pool)", () => {
  test("hint max NÃO sobe acima do topo do pool, mesmo havendo um ref de tier max mais adiante no MESMO pool", () => {
    const ctx = {
      session: makeSession(),
      config: gptReorderedConfig(),
      tierHint: "max" as const,
    };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "openai/gpt-5-mini",
      provider: "openai",
      family: familyOf("openai/gpt-5-mini"),
    });
    assert.notEqual(
      actual.model,
      "openai/gpt-5.5",
      "gpt-5.5 sits later in the same pool at tier max but is NEVER reachable past the declared teto",
    );
  });

  test("control: sem hint, o mesmo pool reordenado também escolhe o topo declarado (comportamento base)", () => {
    const ctx = { session: makeSession(), config: gptReorderedConfig() };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.equal(actual.model, "openai/gpt-5-mini");
  });
});

describe("S05 controle — byte-identidade com S03 (sem hint, sem budget)", () => {
  test("resolveModelForRole escolhe a MESMA ref que o demo de S03 escolheria, sem nenhum sinal de rank", () => {
    const ctx = { session: makeSession(), config: twoFamilyConfig() };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    // Same assertion S03's `role-pool.test.ts` ("resolveModelForRole picks
    // the first ref of the executor role's first candidate pool") makes
    // against the identical fixture — non-regression, not a new behavior.
    assert.deepEqual(actual, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: familyOf("claude-code/claude-opus-4-8"),
    });
    assert.equal(actual.family, "claude", "cross-check against the real family label, matching S03's demo verbatim");
  });
});

describe("S05 controle — reviewer_not_author sob rank (não-regressão do invariante S04)", () => {
  test("com authorFamily='gpt' e budgetPressure ativo, o rank opera SÓ sobre o conjunto pós-filtro — gpt permanece excluído", () => {
    const ctx = {
      session: makeSession(),
      config: reviewerConfig(),
      authorFamily: "gpt",
      budgetPressure: true,
    };

    const actual = resolveModelForRole("reviewer", EXECUTE_TASK, ctx);

    assert.notEqual(actual.family, "gpt", "the author's own family must never resurface, even under budget pressure");
    assert.deepEqual(actual, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: familyOf("claude-code/claude-opus-4-8"),
    });
  });

  test("control: sem authorFamily conhecida, o rank sob budgetPressure não filtra nada e o pool gpt (primeiro na ordem) vence", () => {
    const ctx = {
      session: makeSession(),
      config: reviewerConfig(),
      authorFamily: null,
      budgetPressure: true,
    };

    const actual = resolveModelForRole("reviewer", EXECUTE_TASK, ctx);

    assert.equal(
      actual.family,
      "gpt",
      "unknown authorship -> the adversarial gate is off -> the reviewer's first candidate pool (gpt) is reachable, proving the exclusion above was the filter, not a fixture accident",
    );
  });
});

describe("S05 demo — no gpt credential required anywhere in this file", () => {
  test("every ref used above is a synthetic string, never resolved via a real provider/credential lookup", () => {
    for (const config of [
      twoFamilyConfig(),
      gptOnlyConfig(),
      claudeOnlyConfig(),
      gptReorderedConfig(),
      reviewerConfig(),
    ]) {
      for (const pool of Object.values(config.pools)) {
        for (const ref of pool) {
          assert.match(ref, /^(claude-code|openai)\//, "every fixture ref stays inside the 2 synthetic fake families");
        }
      }
    }
    // rankPool/model-capabilities.ts/model-rank.ts never import pi-ai or
    // forge-agent-core (structural guarantee, not runtime-assertable here) —
    // FORGE2-ROUTING-CONFIG.md §9 records the real-budget/real-flat-rate
    // paths as documented-not-exercised, same discipline S03/S04 established.
    assert.ok(true);
  });
});
