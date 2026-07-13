/**
 * `/forge init` — structural coverage for `commands/init-command.ts` (S03/T01):
 * virgin bootstrap, doctor-lite zero-write, `--repair` create-only-missing,
 * `--gitignore` opt-in, `detectStack` manifest heuristic, and the subcommand
 * routing wired into `forge-command.ts`.
 *
 * Same `mkdtempSync`/`rmSync`-in-`finally` sandbox discipline as
 * `migrate-command.test.ts` — nothing here touches a real project's `.gsd/`
 * tree. Exercises the exported pure-I/O functions directly
 * (`detectStack`/`buildInitReport`/`applyInit`), not `runInitCommand` itself
 * (which needs a full `ExtensionCommandContext`) — the router wiring is
 * instead asserted structurally against `forge-command.ts`'s source text,
 * per T02-PLAN Step 1/3 and the `migrate` precedent.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectStack, buildInitReport, applyInit, formatInitReport } from "../commands/init-command.ts";
import { parseState } from "../state/parse.ts";
import { parsePrefsBlock } from "../prefs.ts";
import { parseModelsConfig, emptyConfig } from "../auto/models-config.ts";

function withSandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-init-command-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function snapshotTree(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else {
        out.push(`${full}:${st.size}:${readFileSync(full, "utf-8")}`);
      }
    }
  }
  walk(root);
  return out;
}

// ── Bootstrap — virgin project ───────────────────────────────────────────────

describe("applyInit — bootstrap on a virgin project", () => {
  test("creates the 7-item skeleton; STATE.md round-trips via parseState; prefs.md/models.md parse to empty config", () => {
    withSandbox((dir) => {
      const result = applyInit(dir);

      assert.equal(result.mode, "bootstrap");
      assert.equal(result.created.length, 7);
      assert.equal(result.skipped.length, 0);

      const report = buildInitReport(dir);
      assert.equal(report.gsdExists, true);
      assert.equal(report.items.length, 7);
      for (const item of report.items) {
        assert.equal(item.status, "exists", `expected ${item.label} to exist after bootstrap`);
      }

      const stateMd = readFileSync(join(dir, ".gsd", "STATE.md"), "utf-8");
      const state = parseState(stateMd);
      assert.equal(state.milestone, "", "virgin STATE.md must round-trip to the empty-valid milestone");

      const prefsMd = readFileSync(join(dir, ".gsd", "prefs.md"), "utf-8");
      assert.deepEqual(parsePrefsBlock(prefsMd), {}, "100%-commented prefs.md template must parse to empty config");

      const modelsMd = readFileSync(join(dir, ".gsd", "models.md"), "utf-8");
      assert.deepEqual(
        parseModelsConfig(modelsMd),
        emptyConfig(),
        "100%-commented models.md template must parse to empty config",
      );

      // Fragment-store dirs exist and are actual directories.
      for (const dirName of ["ledger", "decisions", "memory"]) {
        const full = join(dir, ".gsd", dirName);
        assert.equal(existsSync(full), true, `${dirName} must exist`);
        assert.equal(statSync(full).isDirectory(), true, `${dirName} must be a directory`);
      }
    });
  });
});

// ── Doctor-lite — zero-write proof ──────────────────────────────────────────

describe("buildInitReport — doctor-lite is zero-write", () => {
  test("byte-identical .gsd/ tree before and after buildInitReport on a complete skeleton", () => {
    withSandbox((dir) => {
      applyInit(dir);
      const before = snapshotTree(join(dir, ".gsd"));

      const report = buildInitReport(dir);

      const after = snapshotTree(join(dir, ".gsd"));
      assert.deepEqual(after, before, ".gsd/ tree must be byte-identical before and after a doctor-lite report");
      for (const item of report.items) assert.equal(item.status, "exists");
    });
  });

  test("byte-identical .gsd/ tree before and after buildInitReport on a partial skeleton", () => {
    withSandbox((dir) => {
      applyInit(dir);
      rmSync(join(dir, ".gsd", "models.md"));
      rmSync(join(dir, ".gsd", "memory"), { recursive: true, force: true });
      const before = snapshotTree(join(dir, ".gsd"));

      const report = buildInitReport(dir);

      const after = snapshotTree(join(dir, ".gsd"));
      assert.deepEqual(after, before, "a partial tree must also see zero writes from a doctor-lite report");

      const byKey = new Map(report.items.map((item) => [item.key, item.status]));
      assert.equal(byKey.get("models.md"), "missing");
      assert.equal(byKey.get("memory"), "missing");
      assert.equal(byKey.get("STATE.md"), "exists");
    });
  });
});

// ── --repair — create only what's missing, preserve the rest byte-for-byte ─

describe("applyInit — --repair creates only missing items, never touches existing ones", () => {
  test("deletes 2 items (file + dir), modifies 1 existing file, repair recreates only the deleted ones and leaves the modified one byte-identical", () => {
    withSandbox((dir) => {
      applyInit(dir);

      // Delete one file item and one dir item.
      rmSync(join(dir, ".gsd", "models.md"));
      rmSync(join(dir, ".gsd", "memory"), { recursive: true, force: true });

      // Modify an existing file's content — must survive repair untouched.
      const customProject = "# PROJECT — hand-edited by the operator\n\ncustom content, do not overwrite\n";
      writeFileSync(join(dir, ".gsd", "PROJECT.md"), customProject);

      // Snapshot every item that should remain untouched by repair.
      const untouchedBefore = snapshotTree(join(dir, ".gsd")).filter(
        (line) => !line.includes(`${join(dir, ".gsd", "models.md")}:`) && !line.startsWith(join(dir, ".gsd", "memory")),
      );

      const result = applyInit(dir, { repair: true });

      assert.equal(result.mode, "repair");
      const createdKeys = result.created.map((item) => item.key).sort();
      assert.deepEqual(createdKeys, ["memory", "models.md"]);
      const skippedKeys = result.skipped.map((item) => item.key).sort();
      assert.deepEqual(skippedKeys, ["PROJECT.md", "STATE.md", "decisions", "ledger", "prefs.md"]);

      // Recreated items now exist.
      assert.equal(existsSync(join(dir, ".gsd", "models.md")), true);
      assert.equal(statSync(join(dir, ".gsd", "memory")).isDirectory(), true);

      // The hand-modified file is byte-identical — repair never rewrote it.
      assert.equal(readFileSync(join(dir, ".gsd", "PROJECT.md"), "utf-8"), customProject);

      // Every other previously-existing item is still byte-identical.
      const untouchedAfter = snapshotTree(join(dir, ".gsd")).filter(
        (line) => !line.includes(`${join(dir, ".gsd", "models.md")}:`) && !line.startsWith(join(dir, ".gsd", "memory")),
      );
      assert.deepEqual(untouchedAfter, untouchedBefore);
    });
  });

  test("repair on an already-complete tree creates nothing", () => {
    withSandbox((dir) => {
      applyInit(dir);
      const result = applyInit(dir, { repair: true });
      assert.equal(result.mode, "repair");
      assert.deepEqual(result.created, []);
      assert.equal(result.skipped.length, 7);
    });
  });

  // S01-R1 (review, conceded): a wrong-type conflict left over by --repair
  // used to render as "· já existia (mantido)" — identical to a genuine
  // pre-existing item — and the "nada faltava — completo" line still fired
  // because it only gated on `created.length === 0`. Both false signals.
  test("repair report surfaces a leftover conflict distinctly and never claims completion over it", () => {
    withSandbox((dir) => {
      applyInit(dir);
      // Turn the `ledger/` dir item into a wrong-type conflict (file where a dir belongs).
      rmSync(join(dir, ".gsd", "ledger"), { recursive: true, force: true });
      writeFileSync(join(dir, ".gsd", "ledger"), "not a directory");

      const result = applyInit(dir, { repair: true });
      assert.equal(result.mode, "repair");
      const conflictKeys = result.skipped.filter((item) => item.status === "conflict").map((item) => item.key);
      assert.deepEqual(conflictKeys, ["ledger"]);

      const text = formatInitReport({ mode: "repair", result });
      assert.ok(!text.includes("nada faltava"), "must not claim completion while a conflict remains unresolved");
      assert.ok(text.includes("⚠ conflito de tipo (resolva manualmente): .gsd/ledger/"));
      assert.ok(!text.includes("· já existia (mantido): .gsd/ledger/"), "a conflict must not be reported as a genuine existing item");
    });
  });
});

// ── --gitignore — opt-in only, idempotent ───────────────────────────────────

describe("applyInit — --gitignore is opt-in and idempotent", () => {
  test("default (no --gitignore) never touches .gitignore; passing it appends '.gsd/' once, no duplicate on a second call", () => {
    withSandbox((dir) => {
      const bootstrap = applyInit(dir);
      assert.equal(bootstrap.gitignore, undefined);
      assert.equal(existsSync(join(dir, ".gitignore")), false, "default must not create .gitignore");

      const first = applyInit(dir, { repair: true, gitignore: true });
      assert.ok(first.gitignore);
      assert.equal(first.gitignore!.added, true);
      assert.equal(first.gitignore!.alreadyPresent, false);

      const afterFirst = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.equal((afterFirst.match(/\.gsd\//g) ?? []).length, 1);

      const second = applyInit(dir, { repair: true, gitignore: true });
      assert.ok(second.gitignore);
      assert.equal(second.gitignore!.added, false);
      assert.equal(second.gitignore!.alreadyPresent, true);

      const afterSecond = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.equal(afterSecond, afterFirst, "second --gitignore call must not duplicate the entry");
      assert.equal((afterSecond.match(/\.gsd\//g) ?? []).length, 1);
    });
  });
});

// ── detectStack — manifest heuristic ─────────────────────────────────────────

describe("detectStack — manifest heuristic, pure", () => {
  test("no manifest at all → []", () => {
    withSandbox((dir) => {
      assert.deepEqual(detectStack(dir), []);
    });
  });

  test("package.json → ['Node.js']", () => {
    withSandbox((dir) => {
      writeFileSync(join(dir, "package.json"), "{}");
      assert.deepEqual(detectStack(dir), ["Node.js"]);
    });
  });

  test("pyproject.toml → ['Python']", () => {
    withSandbox((dir) => {
      writeFileSync(join(dir, "pyproject.toml"), "");
      assert.deepEqual(detectStack(dir), ["Python"]);
    });
  });

  test("go.mod → ['Go']", () => {
    withSandbox((dir) => {
      writeFileSync(join(dir, "go.mod"), "");
      assert.deepEqual(detectStack(dir), ["Go"]);
    });
  });

  test("Cargo.toml → ['Rust']", () => {
    withSandbox((dir) => {
      writeFileSync(join(dir, "Cargo.toml"), "");
      assert.deepEqual(detectStack(dir), ["Rust"]);
    });
  });

  test("combination: package.json + Cargo.toml → ['Node.js', 'Rust'], in manifest-check order", () => {
    withSandbox((dir) => {
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "Cargo.toml"), "");
      assert.deepEqual(detectStack(dir), ["Node.js", "Rust"]);
    });
  });

  test("combination: all 4 manifests present → all 4 stacks, in manifest-check order", () => {
    withSandbox((dir) => {
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "pyproject.toml"), "");
      writeFileSync(join(dir, "go.mod"), "");
      writeFileSync(join(dir, "Cargo.toml"), "");
      assert.deepEqual(detectStack(dir), ["Node.js", "Python", "Go", "Rust"]);
    });
  });
});

// ── Subcommand routing — structural assertion over forge-command.ts source ──
//
// Same technique as `migrate-command.test.ts`: building a full
// `ExtensionCommandContext` mock just to cover routing lines is not worth the
// fragility. Assert structurally that "init" is registered, wired to
// `runInitCommand`, and surfaced in both help and the no-STATE status hint.

describe("/forge init — subcommand routing (structural)", () => {
  const source = readFileSync(new URL("../commands/forge-command.ts", import.meta.url), "utf-8");

  test("'init' is registered in SUBCOMMANDS", () => {
    assert.match(source, /SUBCOMMANDS\s*=\s*\[[^\]]*"init"[^\]]*\]/);
  });

  test("case \"init\" dispatches to runInitCommand(ctx, rest)", () => {
    assert.match(source, /case "init":\s*\n\s*runInitCommand\(ctx, rest\);\s*\n\s*return;/);
  });

  test("formatHelp() lists 'init' with a descriptive line mentioning doctor-lite", () => {
    assert.match(source, /"\s*init\s+—[^"]*doctor-lite[^"]*"/);
  });

  test("formatStatus() hints '/forge init' on the branch with no .gsd/STATE.md", () => {
    const noStateMatch = source.match(
      /if \(!existsSync\(statePath\)\) \{\s*\n([\s\S]*?)\n\s*\}\s*\n\s*try \{/,
    );
    assert.ok(noStateMatch, "expected an `if (!existsSync(statePath)) { … }` no-STATE branch");
    const body = noStateMatch![1];
    assert.match(body, /Rode \/forge init para criar o esqueleto \.gsd\/\./);
  });
});
