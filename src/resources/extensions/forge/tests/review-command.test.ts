import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { runReviewCommand, slugify } from "../commands/review-command.ts";
import type { ReviewDispatcher } from "../review/dispatch.ts";

function fakeContext(cwd: string, hasUI = true, notifications: string[] = []): ExtensionCommandContext {
  return {
    cwd,
    hasUI,
    ui: { mode: "tui", notify: (message: string) => notifications.push(message) },
    newSession: async () => ({ cancelled: true }),
  } as unknown as ExtensionCommandContext;
}

function resolveContext(cwd: string) {
  return {
    session: { cwd } as never,
    config: {
      pools: { review: ["gpt/reviewer"], author: ["claude/advocate"] },
      roles: { reviewer: ["review"], advocate: ["author"] },
      constraints: {},
    },
  };
}

function gitSandbox(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-review-command-"));
  execFileSync("git", ["init", "-q", cwd]);
  writeFileSync(join(cwd, "tracked.txt"), "before\n");
  execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
  execFileSync("git", ["-C", cwd, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "base"]);
  writeFileSync(join(cwd, "tracked.txt"), "after\n");
  return cwd;
}

const noFlags: ReviewDispatcher = {
  async dispatch() {
    return "NO_FLAGS";
  },
};

describe("/forge review command", () => {
  it("sanitizes targets into safe slugs", () => {
    assert.equal(slugify("S03"), "s03");
    assert.equal(slugify("../etc/passwd")?.includes("/"), false);
    assert.equal(slugify("../etc/passwd")?.includes(".."), false);
    assert.equal(slugify("Auth Flow!"), "auth-flow");
    assert.equal(slugify("../"), null);
  });

  it("prints usage and does not dispatch when the target is missing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-review-usage-"));
    const notifications: string[] = [];
    let dispatched = false;
    await runReviewCommand(fakeContext(cwd, true, notifications), "", {
      dispatcher: { dispatch: async () => { dispatched = true; return "NO_FLAGS"; } },
    });
    assert.match(notifications[0] ?? "", /Uso: \/forge review <alvo>/);
    assert.equal(dispatched, false);
  });

  it("writes the exact docs/forge slug and challenger-family path", async () => {
    const cwd = gitSandbox();
    const notifications: string[] = [];
    await runReviewCommand(fakeContext(cwd, true, notifications), "Auth Flow!", {
      dispatcher: noFlags,
      resolveContext: resolveContext(cwd),
      now: "2026-07-11T00:00:00.000Z",
    });
    const path = join(cwd, "docs", "forge", "auth-flow-REVIEW-gpt.md");
    assert.match(readFileSync(path, "utf8"), /Review/);
    assert.match(notifications[0] ?? "", /auth-flow-REVIEW-gpt\.md/);
  });

  it("uses stdout in headless mode and notify in the TUI", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-review-empty-"));
    mkdirSync(join(cwd, "docs", "forge"), { recursive: true });
    const notifications: string[] = [];
    await runReviewCommand(fakeContext(cwd, true, notifications), "S03", { resolveContext: resolveContext(cwd) });
    assert.match(notifications[0] ?? "", /gravado em/);
    assert.ok(readFileSync(join(cwd, "docs", "forge", "s03-REVIEW-gpt.md"), "utf8").includes("sem diff"));

    let printed = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runReviewCommand(fakeContext(cwd, false), "S03", { resolveContext: resolveContext(cwd) });
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.match(printed, /gravado em/);
  });

  it("S05/T03: threads scopeDomainFor into the dialectic for an S## target", async () => {
    const cwd = gitSandbox();
    mkdirSync(join(cwd, ".gsd"), { recursive: true });
    writeFileSync(
      join(cwd, ".gsd", "STATE.md"),
      "```yaml\nmilestone: M-test\n```\n",
    );
    mkdirSync(join(cwd, ".gsd", "milestones", "M-test"), { recursive: true });
    writeFileSync(
      join(cwd, ".gsd", "milestones", "M-test", "M-test-ROADMAP.md"),
      "---\ndomain: infra\n---\n\n# ROADMAP\n",
    );
    const captured: string[] = [];
    const capturingDispatcher: ReviewDispatcher = {
      async dispatch(prompt) {
        captured.push(prompt);
        return "NO_FLAGS";
      },
    };
    const notifications: string[] = [];
    await runReviewCommand(fakeContext(cwd, true, notifications), "S03", {
      dispatcher: capturingDispatcher,
      resolveContext: resolveContext(cwd),
    });
    assert.equal(captured.length, 1);
    assert.match(captured[0], /DOMAIN: infra \(larger-scope context — pick review lenses accordingly\)/);
  });

  it("S05/T03: omits the DOMAIN line for a non-S## (ad-hoc slug) target", async () => {
    const cwd = gitSandbox();
    mkdirSync(join(cwd, ".gsd"), { recursive: true });
    writeFileSync(
      join(cwd, ".gsd", "STATE.md"),
      "```yaml\nmilestone: M-test\n```\n",
    );
    mkdirSync(join(cwd, ".gsd", "milestones", "M-test"), { recursive: true });
    writeFileSync(
      join(cwd, ".gsd", "milestones", "M-test", "M-test-ROADMAP.md"),
      "---\ndomain: infra\n---\n\n# ROADMAP\n",
    );
    const captured: string[] = [];
    const capturingDispatcher: ReviewDispatcher = {
      async dispatch(prompt) {
        captured.push(prompt);
        return "NO_FLAGS";
      },
    };
    await runReviewCommand(fakeContext(cwd), "auth-flow", {
      dispatcher: capturingDispatcher,
      resolveContext: resolveContext(cwd),
    });
    assert.equal(captured.length, 1);
    assert.ok(!captured[0].includes("DOMAIN:"));
  });
});
