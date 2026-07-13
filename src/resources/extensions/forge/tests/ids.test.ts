import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nowTimestamp,
  slugify,
  makeMilestoneId,
  makeTaskId,
  nextSequentialMilestoneId,
  nextSequentialTaskId,
  classify,
  isValid,
  prefixGlob,
  entityKind,
  readIdFormat,
  resolveMilestoneId,
  resolveTaskId,
} from "../state/ids.ts";

// Isolate the two user-scope prefs cascade layers (legacy ~/.claude + gsdHome())
// so a real machine's prefs never contaminate the tests — mirrors prefs.test.ts.
function withIsolatedHome<T>(fn: (fakeHome: string) => T): T {
  const fakeHome = mkdtempSync(join(tmpdir(), "forge-ids-home-"));
  const prevHome = process.env.HOME;
  const prevForgeHome = process.env.FORGE_HOME;
  process.env.HOME = fakeHome;
  process.env.FORGE_HOME = join(fakeHome, ".forge");
  try {
    return fn(fakeHome);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevForgeHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevForgeHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-ids-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("nowTimestamp", () => {
  test("returns 14 digits", () => {
    assert.match(nowTimestamp(), /^\d{14}$/);
  });
  test("is UTC-based (year 202x sanity)", () => {
    assert.equal(nowTimestamp().startsWith("202"), true);
  });
});

describe("slugify", () => {
  test("is deterministic", () => {
    assert.equal(slugify("Autenticação OAuth"), slugify("Autenticação OAuth"));
  });

  test("accent-folds pt-BR diacritics", () => {
    assert.equal(slugify("autenticação"), "autenticacao");
  });

  test("strips diacritics broadly", () => {
    const result = slugify("café ênfase ímpar ótimo útil fôlego cêntrico ônibus coração");
    assert.equal(/[àáâãäåèéêëìíîïòóôõöùúûüç]/i.test(result), false);
  });

  test("ç becomes c", () => {
    assert.equal(slugify("certificação").includes("ç"), false);
  });

  test("removes pt-BR stopwords (o, de, com, em)", () => {
    const tokens = slugify("o sistema de notificações com autenticação em tempo").split("-");
    for (const stop of ["o", "de", "com", "em"]) {
      assert.equal(tokens.includes(stop), false, `"${stop}" survived`);
    }
  });

  test("removes EN stopwords (the, for, of, in)", () => {
    const tokens = slugify("the new auth flow for the app in production").split("-");
    for (const stop of ["the", "for", "of", "in"]) {
      assert.equal(tokens.includes(stop), false, `"${stop}" survived`);
    }
  });

  test("content words survive stopword removal", () => {
    const result = slugify("the new auth flow for the app");
    assert.equal(result.includes("auth"), true);
    assert.equal(result.includes("flow"), true);
  });

  test("caps at <= 24 chars at word boundary", () => {
    const result = slugify("Sistema de autenticação e autorização multi-fator com OAuth2 e JWT");
    assert.equal(result.length <= 24, true);
    assert.equal(result.split("-").every((t) => t.length > 0), true);
  });

  test("hard-slices a single long token at <= 24 chars", () => {
    const result = slugify("supercalifragilisticexpialidocious");
    assert.equal(result.length <= 24, true);
    assert.equal(result.length > 0, true);
  });

  test("stopword-only description → empty slug", () => {
    assert.equal(slugify("de a o"), "");
  });

  test("empty string → empty slug", () => {
    assert.equal(slugify(""), "");
  });
});

describe("makeMilestoneId / makeTaskId", () => {
  test("makeMilestoneId: M-<14 digit ts>-<slug>", () => {
    assert.match(makeMilestoneId("Sistema de autenticação"), /^M-\d{14}-.+$/);
  });

  test("makeMilestoneId: stopword-only desc → M-<ts> (no trailing slug)", () => {
    assert.match(makeMilestoneId("de a o"), /^M-\d{14}$/);
  });

  test("makeMilestoneId: slug is ASCII-only", () => {
    assert.equal(/[^\x20-\x7E]/.test(makeMilestoneId("Autenticação OAuth")), false);
  });

  test("makeTaskId: T-<14 digit ts>-<slug>", () => {
    assert.match(makeTaskId("refatorar módulo de tokens"), /^T-\d{14}-.+$/);
  });

  test("makeTaskId: stopword-only desc → T-<ts> (no trailing slug)", () => {
    assert.match(makeTaskId("de a o"), /^T-\d{14}$/);
  });
});

describe("classify", () => {
  test("legacy forms: M005, TASK-007, task-foo-a1b2", () => {
    assert.equal(classify("M005"), "legacy");
    assert.equal(classify("TASK-007"), "legacy");
    assert.equal(classify("task-foo-a1b2"), "legacy");
  });

  test("compact timestamp forms → timestamp", () => {
    assert.equal(classify("M-20260522143012-oauth"), "timestamp");
    assert.equal(classify("T-20260522143012-x"), "timestamp");
    assert.equal(classify("M-20260522143012"), "timestamp");
  });

  test("dashed timestamp forms → timestamp", () => {
    assert.equal(classify("M-20260519-153227"), "timestamp");
    assert.equal(classify("TASK-20260521-205130"), "timestamp");
  });

  test("malformed/null input does not throw", () => {
    assert.doesNotThrow(() => classify("!!!not-an-id!!!"));
    assert.doesNotThrow(() => classify(null));
  });
});

describe("isValid", () => {
  test("valid forms (timestamp compact, dashed, legacy)", () => {
    assert.equal(isValid("M-20260522143012-auth"), true);
    assert.equal(isValid("T-20260522143012-refactor"), true);
    assert.equal(isValid("M005"), true);
    assert.equal(isValid("TASK-007"), true);
    assert.equal(isValid("task-foo-bar"), true);
    assert.equal(isValid("M-20260519-153227"), true);
    assert.equal(isValid("TASK-20260521-205130"), true);
    assert.equal(isValid("T-20260521-205130"), true);
    assert.equal(isValid("M-20260519-153227-pagamentos"), true);
  });

  test("invalid forms", () => {
    assert.equal(isValid(""), false);
    assert.equal(isValid(null), false);
    assert.equal(isValid("M-123"), false);
    assert.equal(isValid("GARBAGE!!!"), false);
    assert.equal(isValid("M-2026051-153227"), false); // 7-digit date
    assert.equal(isValid("M-20260519-15322"), false); // 5-digit time
  });
});

describe("prefixGlob", () => {
  test("timestamp IDs → prefix + wildcard", () => {
    assert.equal(prefixGlob("M-20260522143012-oauth"), "M-20260522143012*");
    assert.equal(prefixGlob("T-20260522143012-refactor"), "T-20260522143012*");
    assert.equal(prefixGlob("M-20260519-153227"), "M-20260519-153227*");
    assert.equal(prefixGlob("M-20260519-153227-pagamentos"), "M-20260519-153227*");
  });

  test("legacy ID → exact match, no wildcard", () => {
    const result = prefixGlob("M005");
    assert.equal(result, "M005");
    assert.equal(result.includes("*"), false);
  });
});

describe("entityKind", () => {
  test("milestone forms", () => {
    assert.equal(entityKind("M005"), "milestone");
    assert.equal(entityKind("M-20260522143012-auth"), "milestone");
  });
  test("task forms", () => {
    assert.equal(entityKind("TASK-007"), "task");
    assert.equal(entityKind("task-foo"), "task");
    assert.equal(entityKind("T-20260522143012-x"), "task");
  });
  test("unknown forms", () => {
    assert.equal(entityKind("GARBAGE!!!"), "unknown");
    assert.equal(entityKind(""), "unknown");
    assert.equal(entityKind(null), "unknown");
  });
});

describe("nextSequentialMilestoneId / nextSequentialTaskId", () => {
  test("empty/undefined → M001", () => {
    assert.equal(nextSequentialMilestoneId([]), "M001");
    assert.equal(nextSequentialMilestoneId(undefined), "M001");
  });
  test("increments from max, ignoring gaps", () => {
    assert.equal(nextSequentialMilestoneId(["M001", "M002"]), "M003");
    assert.equal(nextSequentialMilestoneId(["M001", "M005"]), "M006");
  });
  test("ignores timestamp IDs and non-ID entries", () => {
    assert.equal(
      nextSequentialMilestoneId(["M-20260604002929-gsd-core-import", "M002"]),
      "M003",
    );
    assert.equal(nextSequentialMilestoneId([".DS_Store", "M010", "notes"]), "M011");
  });
  test("case-insensitive match, no broken padding past 3 digits", () => {
    assert.equal(nextSequentialMilestoneId(["m007"]), "M008");
    assert.equal(nextSequentialMilestoneId(["M999"]), "M1000");
  });
  test("output round-trips through isValid + classify", () => {
    const id = nextSequentialMilestoneId(["M004"]);
    assert.equal(isValid(id), true);
    assert.equal(classify(id), "legacy");
  });

  test("nextSequentialTaskId basic increment", () => {
    assert.equal(nextSequentialTaskId([]), "TASK-001");
    assert.equal(nextSequentialTaskId(["TASK-001", "TASK-002"]), "TASK-003");
  });
  test("nextSequentialTaskId ignores timestamp + task-slug forms", () => {
    assert.equal(
      nextSequentialTaskId(["T-20260601121212-fix", "task-fix-foo", "TASK-009"]),
      "TASK-010",
    );
  });
  test("nextSequentialTaskId output round-trips", () => {
    const id = nextSequentialTaskId(["TASK-001"]);
    assert.equal(isValid(id), true);
    assert.equal(classify(id), "legacy");
  });
});

describe("readIdFormat (via readForgePrefs cascade)", () => {
  test("no prefs → timestamp default", () => {
    withIsolatedHome(() => {
      withSandbox((dir) => {
        assert.equal(readIdFormat(dir), "timestamp");
      });
    });
  });

  test("repo pref 'ids: sequential' wins", () => {
    withIsolatedHome(() => {
      withSandbox((dir) => {
        mkdirSync(join(dir, ".gsd"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.md"), "ids: sequential\n");
        assert.equal(readIdFormat(dir), "sequential");
      });
    });
  });

  test("local pref overrides repo pref (last-wins, per readForgePrefs)", () => {
    withIsolatedHome(() => {
      withSandbox((dir) => {
        mkdirSync(join(dir, ".gsd"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.md"), "ids: sequential\n");
        writeFileSync(join(dir, ".gsd", "prefs.local.md"), "ids: timestamp\n");
        assert.equal(readIdFormat(dir), "timestamp");
      });
    });
  });

  test("invalid value falls back to timestamp", () => {
    withIsolatedHome(() => {
      withSandbox((dir) => {
        mkdirSync(join(dir, ".gsd"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.local.md"), "ids: banana\n");
        assert.equal(readIdFormat(dir), "timestamp");
      });
    });
  });
});

describe("resolveMilestoneId / resolveTaskId", () => {
  test("resolveMilestoneId: sequential scans milestones/ + archive/", () => {
    withIsolatedHome(() => {
      withSandbox((dir) => {
        mkdirSync(join(dir, ".gsd", "milestones", "M002"), { recursive: true });
        mkdirSync(join(dir, ".gsd", "archive", "M007"), { recursive: true });
        mkdirSync(join(dir, ".gsd", "milestones", "M-20260601121212-feature"), {
          recursive: true,
        });
        assert.equal(resolveMilestoneId(dir, "qualquer desc", "sequential"), "M008");
      });
    });
  });

  test("resolveMilestoneId: explicit timestamp override ignores sequential pref", () => {
    withIsolatedHome(() => {
      withSandbox((dir) => {
        mkdirSync(join(dir, ".gsd"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.local.md"), "ids: sequential\n");
        const id = resolveMilestoneId(dir, "minha feature nova", "timestamp");
        assert.match(id, /^M-\d{14}-/);
      });
    });
  });

  test("resolveMilestoneId: pref sequential picked up from sandbox prefs", () => {
    withIsolatedHome(() => {
      withSandbox((dir) => {
        mkdirSync(join(dir, ".gsd", "milestones", "M041"), { recursive: true });
        writeFileSync(join(dir, ".gsd", "prefs.local.md"), "ids: sequential\n");
        assert.equal(resolveMilestoneId(dir, "qualquer"), "M042");
      });
    });
  });

  test("resolveTaskId: sequential scans .gsd/tasks/", () => {
    withIsolatedHome(() => {
      withSandbox((dir) => {
        mkdirSync(join(dir, ".gsd", "tasks", "TASK-003"), { recursive: true });
        assert.equal(resolveTaskId(dir, "fix typo", "sequential"), "TASK-004");
      });
    });
  });

  test("resolveTaskId: sequential with no tasks dir → TASK-001", () => {
    withIsolatedHome(() => {
      withSandbox((dir) => {
        assert.equal(resolveTaskId(dir, "fix typo", "sequential"), "TASK-001");
      });
    });
  });
});
