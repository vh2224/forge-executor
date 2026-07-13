/**
 * S05/T01 contract test — `scopeDomainFor` (`auto/scope-domain.ts`), the
 * scope-level sibling of `domainHintForUnit` (`auto/rank-hint.ts`).
 *
 * Sandbox coverage (scratch dir with a real `.gsd/milestones/<mid>/...`
 * layout, mirroring `domain-hint.test.ts`): the full precedence cascade
 * (D-S05-A) — slice-CONTEXT wins over milestone-CONTEXT wins over
 * milestone-ROADMAP — per-rung fallthrough on a missing/empty/malformed
 * rung, trim+lowercase normalization, an open (unvalidated) vocabulary, and
 * every degrade mode (missing files, no frontmatter, non-string/empty
 * `domain:`, empty `milestoneId`) all resolving to `undefined` without
 * throwing.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeDomainFor } from "../auto/scope-domain.ts";

function withScratchDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-scope-domain-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function milestoneDirOf(cwd: string, milestone: string): string {
  return join(cwd, ".gsd", "milestones", milestone);
}

function writeRoadmap(cwd: string, milestone: string, frontmatterExtra: string): void {
  const dir = milestoneDirOf(cwd, milestone);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${milestone}-ROADMAP.md`),
    `---\nid: ${milestone}\n${frontmatterExtra}---\n\n# ROADMAP\n`,
    "utf-8",
  );
}

function writeMilestoneContext(cwd: string, milestone: string, frontmatterExtra: string): void {
  const dir = milestoneDirOf(cwd, milestone);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${milestone}-CONTEXT.md`),
    `---\nid: ${milestone}\n${frontmatterExtra}---\n\n# CONTEXT\n`,
    "utf-8",
  );
}

function writeSliceContext(cwd: string, milestone: string, slice: string, frontmatterExtra: string): void {
  const dir = join(milestoneDirOf(cwd, milestone), "slices", slice);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slice}-CONTEXT.md`),
    `---\nid: ${slice}\n${frontmatterExtra}---\n\n# CONTEXT\n`,
    "utf-8",
  );
}

function writeSliceContextNoFrontmatter(cwd: string, milestone: string, slice: string): void {
  const dir = join(milestoneDirOf(cwd, milestone), "slices", slice);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slice}-CONTEXT.md`), `# CONTEXT\n\nNo frontmatter here.\n`, "utf-8");
}

describe("scopeDomainFor — cascade precedence (D-S05-A)", () => {
  test("slice-CONTEXT wins over milestone-CONTEXT wins over ROADMAP when all three declare domain", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain: infra\n");
      writeMilestoneContext(cwd, "M-toy", "domain: backend\n");
      writeSliceContext(cwd, "M-toy", "S01", "domain: frontend\n");

      assert.equal(scopeDomainFor(cwd, "M-toy", "S01"), "frontend");
    });
  });

  test("milestone-CONTEXT wins over ROADMAP when no slice is passed", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain: infra\n");
      writeMilestoneContext(cwd, "M-toy", "domain: backend\n");

      assert.equal(scopeDomainFor(cwd, "M-toy"), "backend");
    });
  });

  test("milestone-CONTEXT wins over ROADMAP even when a slice is passed but the slice declares nothing", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain: infra\n");
      writeMilestoneContext(cwd, "M-toy", "domain: backend\n");
      writeSliceContext(cwd, "M-toy", "S01", "");

      assert.equal(scopeDomainFor(cwd, "M-toy", "S01"), "backend");
    });
  });

  test("falls through to ROADMAP when neither slice-CONTEXT nor milestone-CONTEXT exist", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain: infra\n");

      assert.equal(scopeDomainFor(cwd, "M-toy", "S01"), "infra");
    });
  });

  test("falls through per rung: slice-CONTEXT has no frontmatter, milestone-CONTEXT is missing, ROADMAP wins", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain: infra\n");
      writeSliceContextNoFrontmatter(cwd, "M-toy", "S01");

      assert.equal(scopeDomainFor(cwd, "M-toy", "S01"), "infra");
    });
  });
});

describe("scopeDomainFor — normalization and open vocabulary", () => {
  test("trims and lowercases the winning value", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain:   Backend  \n");

      assert.equal(scopeDomainFor(cwd, "M-toy"), "backend");
    });
  });

  test("an arbitrary unknown domain flows through — no valid-value set", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain: Quantum-Basketry\n");

      assert.equal(scopeDomainFor(cwd, "M-toy"), "quantum-basketry");
    });
  });
});

describe("scopeDomainFor — degrade discipline (never throws)", () => {
  test("returns undefined when no scope artifacts exist at all", () => {
    withScratchDir((cwd) => {
      assert.doesNotThrow(() => scopeDomainFor(cwd, "M-toy", "S01"));
      assert.equal(scopeDomainFor(cwd, "M-toy", "S01"), undefined);
    });
  });

  test("returns undefined when milestoneId is empty, without touching disk", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain: infra\n");

      assert.equal(scopeDomainFor(cwd, "", "S01"), undefined);
    });
  });

  test("returns undefined when every rung's domain value is empty after trim", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain:\n");
      writeMilestoneContext(cwd, "M-toy", "domain:   \n");
      writeSliceContext(cwd, "M-toy", "S01", 'domain: ""\n');

      assert.equal(scopeDomainFor(cwd, "M-toy", "S01"), undefined);
    });
  });

  test("returns undefined when domain is a list rather than a scalar string", () => {
    withScratchDir((cwd) => {
      writeRoadmap(cwd, "M-toy", "domain:\n  - infra\n  - backend\n");

      assert.equal(scopeDomainFor(cwd, "M-toy"), undefined);
    });
  });

  test("returns undefined (never throws) when the ROADMAP file has no frontmatter", () => {
    withScratchDir((cwd) => {
      const dir = milestoneDirOf(cwd, "M-toy");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "M-toy-ROADMAP.md"), "# ROADMAP\n\nNo frontmatter here.\n", "utf-8");

      assert.doesNotThrow(() => scopeDomainFor(cwd, "M-toy"));
      assert.equal(scopeDomainFor(cwd, "M-toy"), undefined);
    });
  });
});
