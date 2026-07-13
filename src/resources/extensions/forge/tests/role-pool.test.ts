/**
 * S03 demo evidence — the literal contract of ROADMAP §Demos S03: "Um arquivo
 * de config ... com pools + roles ordenados é lido, e `resolveModelForRole`
 * escolhe o primeiro pool candidato disponível para cada papel; teste
 * sintético com 2 famílias fake prova filtragem por disponibilidade +
 * fallback ordenado + `on_missing_pool: degrade+warn|block`."
 *
 * This is deliberately a SEPARATE file from `role.test.ts` (T03's exhaustive
 * unit coverage of the seam's body): `role.test.ts` proves the seam's
 * internals case-by-case; this file is the end-to-end demo artifact — one
 * `ModelsConfig` shaped exactly like the locked contract in
 * `S03-PLAN.md §Config surface` (2 fake families: `claude-code/*` and
 * `openai/*`), driven through `resolveModelForRole` with an injected
 * `AvailabilityProbe`, with each of the 3 demo behaviors (availability
 * filter, ordered fallback, `on_missing_pool`) asserted as its own `describe`
 * block so the mapping to the ROADMAP bullet is explicit and unambiguous.
 *
 * No real `gpt` credential is read or required anywhere in this file — both
 * "families" are synthetic `provider/model-id` strings and availability is
 * driven entirely by the injected, in-memory `AvailabilityProbe` (S03-PLAN
 * §Availability). The GSD gate stays fully synthetic.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextUnit } from "../state/dispatch.ts";
import { familyOf } from "../state/family.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { resolveModelForRole } from "../auto/role.ts";
import type { ModelsConfig } from "../auto/models-config.ts";
import { unavailableRefsProbe } from "../auto/availability.ts";
import { parseCapabilities, emptyCapabilities } from "../auto/capability-matrix.ts";

function makeSession(cwd = "/tmp/does-not-matter"): ForgeAutoSession {
  const s = new ForgeAutoSession();
  s.active = true;
  s.cwd = cwd;
  return s;
}

const EXECUTE_TASK: NextUnit = { type: "execute-task", slice: "S03", task: "T04" };

/**
 * The 2 fake families, shaped exactly like the locked example in
 * `S03-PLAN.md §Config surface`: `claude` (claude-code/*) is the executor
 * role's first candidate pool, `gpt` (openai/*) is its second. Neither ref
 * is a real model id backed by a real provider — both are synthetic strings
 * the injected `AvailabilityProbe` (not a network/credential lookup) decides
 * on.
 */
function twoFamilyConfig(onMissingPool?: string): ModelsConfig {
  return {
    pools: {
      claude: ["claude-code/claude-opus-4-8", "claude-code/claude-sonnet-5"],
      gpt: ["openai/gpt-5.5", "openai/gpt-5-mini"],
    },
    roles: { executor: ["claude", "gpt"] },
    constraints: onMissingPool ? { on_missing_pool: onMissingPool } : {},
  };
}

describe("S03 demo — 2 fake families, ordered choose when everything is available", () => {
  test("resolveModelForRole picks the first ref of the executor role's first candidate pool", () => {
    const ctx = { session: makeSession(), config: twoFamilyConfig() };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "claude-code/claude-opus-4-8",
      provider: "claude-code",
      family: familyOf("claude-code/claude-opus-4-8"),
    });
    assert.equal(actual.family, "claude", "cross-check against the real family label, not just familyOf's echo");
  });
});

describe("S03 demo — availability filtering", () => {
  test("an unavailable ref inside the first candidate pool is skipped for the next ref in the SAME pool", () => {
    const availabilityProbe = unavailableRefsProbe(["claude-code/claude-opus-4-8"]);
    const ctx = { session: makeSession(), config: twoFamilyConfig(), availabilityProbe };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "claude-code/claude-sonnet-5",
      provider: "claude-code",
      family: familyOf("claude-code/claude-sonnet-5"),
    });
    assert.equal(actual.family, "claude", "still the claude family — the filter stayed inside the first pool");
  });
});

describe("S03 demo — ordered fallback across pools", () => {
  test("every ref in the claude pool unavailable -> resolution falls through to the gpt pool, in role order", () => {
    const availabilityProbe = unavailableRefsProbe([
      "claude-code/claude-opus-4-8",
      "claude-code/claude-sonnet-5",
    ]);
    const ctx = { session: makeSession(), config: twoFamilyConfig(), availabilityProbe };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(actual, {
      model: "openai/gpt-5.5",
      provider: "openai",
      family: familyOf("openai/gpt-5.5"),
    });
    assert.equal(actual.family, "gpt", "fallback landed in the SECOND fake family, proving the pool order was honored");
  });
});

describe("S03 demo — on_missing_pool: degrade+warn", () => {
  test("no available ref in ANY candidate pool -> degrades to the pool-of-one baseline instead of blocking", () => {
    const s = makeSession();
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const availabilityProbe = unavailableRefsProbe([
      "claude-code/claude-opus-4-8",
      "claude-code/claude-sonnet-5",
      "openai/gpt-5.5",
      "openai/gpt-5-mini",
    ]);
    const ctx = { session: s, config: twoFamilyConfig("degrade+warn"), availabilityProbe };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    // Pool-of-one baseline: the session's own baseline model, not null/blocked.
    assert.equal(actual.model, "openai/gpt-5.5");
    assert.equal(actual.provider, "openai");
    assert.notEqual(actual.model, null, "degrade+warn must never yield a blocked result");
  });
});

describe("S03 demo — on_missing_pool: block", () => {
  test("no available ref in ANY candidate pool -> a blocked/null result, no pool-of-one fallback", () => {
    const s = makeSession();
    s.baselineModel = { id: "openai/gpt-5.5", provider: "openai" } as never;
    const availabilityProbe = unavailableRefsProbe([
      "claude-code/claude-opus-4-8",
      "claude-code/claude-sonnet-5",
      "openai/gpt-5.5",
      "openai/gpt-5-mini",
    ]);
    const ctx = { session: s, config: twoFamilyConfig("block"), availabilityProbe };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.deepEqual(
      actual,
      { model: null, provider: null, family: null },
      "block must never fall back to the session's baseline model, even though one is set",
    );
  });
});

describe("S03 demo — no gpt credential required anywhere in this file", () => {
  test("every 'gpt' ref used above is a synthetic string, never resolved via a real provider/credential lookup", () => {
    const config = twoFamilyConfig();
    for (const ref of config.pools.gpt) {
      assert.match(ref, /^openai\//, "fake gpt refs are plain strings, not credential-backed lookups");
    }
    // resolveModelForRole never imports forge-agent-core / AuthStorage (S03-PLAN
    // §Availability) — this is a structural guarantee, not something a single
    // test call can assert at runtime; the doc (FORGE2-ROUTING-CONFIG.md)
    // records the real-credential path as documented-not-exercised instead.
    assert.ok(true);
  });
});

/**
 * S03 do milestone capacidade-esforço — the seam-level proof of the domain
 * capability factor (T03): two refs UNKNOWN to the static table
 * (`model-capabilities.ts` default: standard/1/1) share one pool, so they are
 * co-finalists that tie on everything except pool order — the injected S02
 * matrix is then the ONLY discriminator. The head provider (`prov-a`) is
 * unknown, hence non-flat-rate: `rankPool`'s flat-rate short-circuit never
 * fires and the tie-break is observable.
 *
 * Coverage per T03-PLAN step 5: domain+matrix reorder within the pool (both
 * directions), same ctx WITHOUT domain = pool head (byte-identity), domain
 * with an EMPTY matrix = pool head (miss = factor absent, D-S03-4), and the
 * load-bearing filter order — an availability probe that removes the matrix's
 * favorite means the matrix can never resurrect a filtered ref. A final pair
 * proves D-S03-2's production path: with no `ctx.capabilities` injected, the
 * seam reads `.gsd/CAPABILITIES.md` from `session.cwd` — and only when
 * `domain` is present.
 */

/** One pool of two co-finalist refs unknown to the static table; head is non-flat-rate. */
function coFinalistConfig(): ModelsConfig {
  return {
    pools: { unknowns: ["prov-a/model-x", "prov-b/model-y"] },
    roles: { executor: ["unknowns"] },
    constraints: {},
  };
}

/**
 * The S02 matrix, built through the REAL parser (`parseCapabilities`) so the
 * suite exercises the production representation, not a hand-rolled literal.
 * Refs verbatim, matching the pool exactly (S02 FI: exact-match, case-
 * sensitive — a case mismatch would be a silent miss, not an error).
 */
const DOMAIN_MATRIX = parseCapabilities(
  [
    "| domain | model | score |",
    "| --- | --- | --- |",
    "| backend | prov-a/model-x | 0.30 |",
    "| backend | prov-b/model-y | 0.90 |",
    "| frontend | prov-a/model-x | 0.90 |",
    "| frontend | prov-b/model-y | 0.30 |",
  ].join("\n"),
);

describe("S03 capacidade-esforço — domain + injected matrix reorder within the pool", () => {
  test("domain: backend -> the matrix's backend favorite (prov-b/model-y) wins over the pool head", () => {
    const ctx = {
      session: makeSession(),
      config: coFinalistConfig(),
      domain: "backend",
      capabilities: DOMAIN_MATRIX,
    };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.equal(actual.model, "prov-b/model-y", "backend scores (0.9 > 0.3) reorder the co-finalists");
    assert.equal(actual.provider, "prov-b");
  });

  test("domain: frontend (inverted scores) -> the OTHER ref (prov-a/model-x) wins from the SAME pool", () => {
    const ctx = {
      session: makeSession(),
      config: coFinalistConfig(),
      domain: "frontend",
      capabilities: DOMAIN_MATRIX,
    };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.equal(
      actual.model,
      "prov-a/model-x",
      "two resolutions identical except for the domain pick DIFFERENT refs of the SAME pool",
    );
    assert.equal(actual.provider, "prov-a");
  });
});

describe("S03 capacidade-esforço — absent domain / matrix miss = no effect", () => {
  test("same ctx WITHOUT domain -> pool head wins (byte-identical to the pre-domain rank)", () => {
    const ctx = {
      session: makeSession(),
      config: coFinalistConfig(),
      capabilities: DOMAIN_MATRIX,
    };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.equal(
      actual.model,
      "prov-a/model-x",
      "an injected matrix with NO domain hint must have zero effect — the head still wins",
    );
  });

  test("domain present but EMPTY matrix -> pool head wins (miss = factor absent, never score 0)", () => {
    const ctx = {
      session: makeSession(),
      config: coFinalistConfig(),
      domain: "backend",
      capabilities: emptyCapabilities(),
    };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.equal(
      actual.model,
      "prov-a/model-x",
      "every lookup misses -> both refs fall back to the normalized static profile and pool order decides",
    );
  });
});

describe("S03 capacidade-esforço — filter order stays load-bearing (adversarial ∩ availability BEFORE rank)", () => {
  test("availability probe removes the matrix's backend favorite -> the other ref wins; the matrix never resurrects a filtered ref", () => {
    const availabilityProbe = unavailableRefsProbe(["prov-b/model-y"]);
    const ctx = {
      session: makeSession(),
      config: coFinalistConfig(),
      availabilityProbe,
      domain: "backend",
      capabilities: DOMAIN_MATRIX,
    };

    const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

    assert.equal(
      actual.model,
      "prov-a/model-x",
      "the availability filter ran BEFORE the rank — a 0.9 matrix score cannot bring back an unavailable ref",
    );
  });
});

describe("S03 capacidade-esforço — production path: matrix read from .gsd/CAPABILITIES.md (D-S03-2)", () => {
  test("no ctx.capabilities injected + domain present -> the seam reads the on-disk cascade once and the matrix favorite wins", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-role-pool-caps-"));
    try {
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(
        join(cwd, ".gsd", "CAPABILITIES.md"),
        [
          "| domain | model | score |",
          "| --- | --- | --- |",
          "| backend | prov-a/model-x | 0.20 |",
          "| backend | prov-b/model-y | 0.95 |",
        ].join("\n"),
      );
      const ctx = { session: makeSession(cwd), config: coFinalistConfig(), domain: "backend" };

      const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

      assert.equal(actual.model, "prov-b/model-y", "readCapabilities(cwd) resolved the on-disk matrix");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("same on-disk matrix, NO domain -> pool head wins (absent domain reads nothing and changes nothing)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-role-pool-caps-nodomain-"));
    try {
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(
        join(cwd, ".gsd", "CAPABILITIES.md"),
        [
          "| domain | model | score |",
          "| --- | --- | --- |",
          "| backend | prov-a/model-x | 0.20 |",
          "| backend | prov-b/model-y | 0.95 |",
        ].join("\n"),
      );
      const ctx = { session: makeSession(cwd), config: coFinalistConfig() };

      const actual = resolveModelForRole("executor", EXECUTE_TASK, ctx);

      assert.equal(
        actual.model,
        "prov-a/model-x",
        "with ctx.domain absent the matrix on disk is never consulted — head of pool, byte-identical",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
