import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { getForgeAutoSession } from "../auto/session.ts";
import { runReviewCommand } from "../commands/review-command.ts";
import { productionReviewDispatcher } from "../review/dispatch.ts";

const ROOT = "/sessions/operator-root.jsonl";
const WORKER = "/sessions/stale-worker.jsonl";

type NewSessionOptions = {
  parentSession?: string;
  withSession: (ctx: object) => Promise<void>;
};

function liveContext(captured: NewSessionOptions[]): ExtensionCommandContext {
  return {
    model: undefined,
    sessionManager: { getSessionFile: () => WORKER },
    newSession: async (options: NewSessionOptions) => {
      captured.push(options);
      await options.withSession({
        modelRegistry: { getAll: () => [] },
        sendMessage: async () => undefined,
        sessionManager: {
          getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "NO_FLAGS" }] } }],
        },
      });
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
}

test("review dispatch threads the run root and does not recapture a stale worker context", async () => {
  const captured: NewSessionOptions[] = [];
  const live = liveContext(captured);
  const session = getForgeAutoSession();
  session.reset();
  session.runRootSessionPath = ROOT;
  session.cmdCtx = live;

  await productionReviewDispatcher(live).dispatch("review", { workingDir: process.cwd(), model: null, provider: null });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.parentSession, ROOT);

  // Simulate the loop after replacement: cmdCtx is now a worker with a
  // different persisted path. Dispatch must still read the run-scoped root.
  const staleWorker = liveContext(captured);
  session.cmdCtx = staleWorker;
  await productionReviewDispatcher(live).dispatch("review", { workingDir: process.cwd(), model: null, provider: null });
  assert.equal(captured[1]?.parentSession, ROOT);
});

test("review dispatch preserves the former undefined parent when no root is available", async () => {
  const captured: NewSessionOptions[] = [];
  const live = liveContext(captured);
  const session = getForgeAutoSession();
  session.reset();
  session.cmdCtx = live;

  await productionReviewDispatcher(live).dispatch("review", { workingDir: process.cwd(), model: null, provider: null });

  assert.equal(captured[0]?.parentSession, undefined);
});

test("standalone /forge review captures its fresh operator session as the run root", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forge-review-root-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(join(cwd, ".gsd", "STATE.md"), "```yaml\nmilestone: M-test\n```\n");
  writeFileSync(join(cwd, "changed.ts"), "export const changed = false;\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  writeFileSync(join(cwd, "changed.ts"), "export const changed = true;\n");
  const session = getForgeAutoSession();
  session.reset();
  // The command sets runRootSessionPath from ctx.sessionManager.getSessionFile()
  // BEFORE dispatch and CLEARS it in the `finally` (S02/R3: the singleton field
  // must never outlive the command), and the dispatcher only runs when there is
  // a diff. So the observable contract is "the command consulted the operator's
  // session file as run root" — spy on that read, and confirm the field is
  // cleared afterward so the singleton never lingers.
  let readOperatorSession = false;
  const ctx = {
    cwd,
    hasUI: true,
    ui: { mode: "tui", notify: () => undefined },
    sessionManager: {
      getSessionFile: () => {
        readOperatorSession = true;
        return ROOT;
      },
    },
  } as unknown as ExtensionCommandContext;

  await runReviewCommand(ctx, "target", {
    dispatcher: { dispatch: async () => "NO_FLAGS" },
    resolveContext: { session: session as never, config: { pools: {}, roles: {}, constraints: {} } },
  });

  assert.equal(readOperatorSession, true, "standalone review reads the fresh operator session as the run root");
  assert.equal(session.runRootSessionPath, null, "and clears it in finally so the singleton never lingers");
  session.reset();
});
