/**
 * S04/T04 — through-the-driver proof for `/forge research-models` (ROADMAP
 * §S04 demo). Unlike the fake-driver e2e's (`domain-routing-e2e.test.ts` &
 * co.), this suite exercises the REAL `dispatchUnitViaNewSession` (D-S04-2):
 * only the command-handler's `ExtensionCommandContext` (`newSession`/
 * `withSession`/`sendMessage`) is a fake, worker-compliant stand-in — the
 * exact seam `tests/driver.test.ts`'s research-models case (S04/T03) and
 * `tests/forge-command.test.ts`'s `runAuto` suite (S03) already use.
 *
 * (A) proves the full plumbing end to end: prompt composition → real
 * dispatch → a compliant fake worker writes `.gsd/CAPABILITIES.md` → the
 * file parses with the REAL `parseCapabilities` and the pre-seeded `locked`
 * row survives byte-for-byte → the journal carries only the two advisory
 * kinds, never the loop's own `unit_dispatched`/`unit_result` (D-S04-4).
 * (B) proves the hard fronteira from CONTEXT: `deriveNextUnit`'s source
 * (`state/dispatch.ts`) never mentions `research-models` — the auto-loop
 * cannot auto-dispatch this unit even by accident.
 * (C) proves D-S04-1: no `.gsd/STATE.md` on disk still dispatches, with the
 * `- Milestone:` line omitted from the composed prompt.
 * (D) proves the reentrancy guard: an already-active session refuses to
 * dispatch a second time.
 *
 * **Nota de honestidade** (same as T01-PLAN §Context): scenario A's worker
 * is a SCRIPTED fake that honors the locked-preservation contract — this
 * proves the PLUMBING, not that a real LLM worker would never violate the
 * prompt's instructions.
 *
 * S01/T02 do polimento-cockpit addition: proves the `researcher` role is
 * actually reached by the real dispatch spine — with a `researcher:` entry
 * in `.gsd/models.md`, `runResearchModelsCommand` (the same
 * `resolveDispatchAuthor` → `dispatchUnitViaNewSession` path as scenario A)
 * resolves the model authority through the researcher pool, not the executor
 * one, and journals it on `research_models_dispatched` (CODING-STANDARDS
 * §Through-the-driver — a claim about production dispatch needs a driver
 * proof, not just the pure-seam `role.test.ts` cases).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { runResearchModelsCommand } from "../commands/research-models-command.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";
import { parseCapabilities } from "../auto/capability-matrix.ts";

const LOCKED_ROW = "| infra | prov-a/model-x | 0.6 | true | https://example.dev/old (2026-01-01) |";
const NON_LOCKED_SEED_ROW = "| infra | prov-b/model-y | 0.4 |  | https://example.dev/old2 (2026-01-01) |";

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Walks up from this test file to the repo root (`pnpm-workspace.yaml`) — same pattern as `capability-format-doc.test.ts`. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("repo root (pnpm-workspace.yaml) not found above test file");
    }
    dir = parent;
  }
  return dir;
}

function writeSeedCapabilities(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "CAPABILITIES.md"),
    [
      "| domain | model | score | locked | sources |",
      "| --- | --- | --- | --- | --- |",
      LOCKED_ROW,
      NON_LOCKED_SEED_ROW,
      "updated: 2026-01-01",
      "",
    ].join("\n"),
  );
}

function writeExecutorPoolConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "pools:\n  demo:\n    - prov-a/model-x\n    - prov-b/model-y\n\nroles:\n  executor:\n    - demo\n",
  );
}

/** A fake command context whose `newSession` runs `onSendMessage` synchronously — no real pi session involved. */
function fakeCtx(
  cwd: string,
  onSendMessage: (content: string) => void,
): { ctx: ExtensionCommandContext; notifications: Array<[string, string]> } {
  const notifications: Array<[string, string]> = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push([message, level]);
      },
    },
    model: undefined,
    async newSession(opts: { withSession: (fresh: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
      const freshCtx = {
        abort() {},
        async sendMessage(msg: { content: string }): Promise<void> {
          onSendMessage(msg.content);
        },
      };
      await opts.withSession(freshCtx);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

describe("S04/T04 — /forge research-models through-the-driver", () => {
  test("(A) happy path: real dispatch, compliant worker writes CAPABILITIES.md, locked row byte-identical, journal advisory-only", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-research-models-e2e-happy-"));
    try {
      writeSeedCapabilities(cwd);
      writeExecutorPoolConfig(cwd);

      const session = new ForgeAutoSession();
      const capsPath = join(cwd, ".gsd", "CAPABILITIES.md");
      let capturedPrompt = "";

      const { ctx } = fakeCtx(cwd, (content) => {
        capturedPrompt = content;
        // Compliant worker: preserves the locked row byte-for-byte, refreshes
        // the non-locked row, appends a fresh `updated:` line.
        writeFileSync(
          capsPath,
          [
            "| domain | model | score | locked | sources |",
            "| --- | --- | --- | --- | --- |",
            LOCKED_ROW,
            "| infra | prov-b/model-y | 0.8 |  | https://example.dev/new (2026-07-12) |",
            "updated: 2026-07-12",
            "",
          ].join("\n"),
        );
        deliverUnitResult(
          { status: "done", summary: "matriz atualizada", artifacts: [capsPath] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runResearchModelsCommand(ctx, session));

      // The composed prompt carried the CAPABILITIES path, the locked-
      // preservation instruction, and T01's body verbatim.
      assert.ok(capturedPrompt.includes(capsPath), "prompt names the CAPABILITIES.md path to write");
      assert.match(capturedPrompt, /BYTE-FOR-BYTE/, "prompt carries the locked-preservation instruction");
      assert.match(capturedPrompt, /GSD model-research agent/, "prompt carries T01's body verbatim");

      const raw = readFileSync(capsPath, "utf8");
      const rawLines = raw.split("\n");
      assert.ok(rawLines.includes(LOCKED_ROW), "the locked row survives BYTE-FOR-BYTE on disk");

      const matrix = parseCapabilities(raw);
      const lockedEntry = matrix.domains.infra?.["prov-a/model-x"];
      assert.ok(lockedEntry, "parseCapabilities parses the written file");
      assert.equal(lockedEntry.locked, true);
      assert.equal(lockedEntry.score, 0.6);
      assert.equal(lockedEntry.sources, "https://example.dev/old (2026-01-01)");
      const refreshedEntry = matrix.domains.infra?.["prov-b/model-y"];
      assert.equal(refreshedEntry?.score, 0.8, "the non-locked row was refreshed");

      const events = readEvents(cwd);
      const kinds = events.map((e) => e.kind);
      assert.ok(kinds.includes("research_models_dispatched"), "advisory dispatched kind journaled");
      assert.ok(kinds.includes("research_models_result"), "advisory result kind journaled");
      assert.ok(!kinds.includes("unit_dispatched"), "the loop's own unit_dispatched kind never appears (D-S04-4)");
      assert.ok(!kinds.includes("unit_result"), "the loop's own unit_result kind never appears (D-S04-4)");

      assert.equal(session.active, false, "the finally ran — session reset");
      assert.equal(session.cmdCtx, null, "reset() cleared cmdCtx");
      assert.equal(session.currentUnit, null, "reset() cleared currentUnit");
      assert.equal(session.pendingDispatch, null, "reset() cleared the in-flight dispatch slot");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(B) fronteira dura: state/dispatch.ts (deriveNextUnit's source) has zero occurrences of 'research-models'", () => {
    const src = readFileSync(
      join(repoRoot(), "src", "resources", "extensions", "forge", "state", "dispatch.ts"),
      "utf8",
    );
    assert.doesNotMatch(src, /research-models/, "deriveNextUnit never learns about research-models");
  });

  test("(C) sem STATE.md: milestoneId degrada para \"\" — prompt composto omite '- Milestone:' e o dispatch prossegue", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-research-models-e2e-nostate-"));
    try {
      // Deliberately empty sandbox: no .gsd/STATE.md, no CAPABILITIES.md, no
      // models.md — the worker fake still receives a dispatch and reports.
      const session = new ForgeAutoSession();
      let capturedPrompt = "";
      const { ctx } = fakeCtx(cwd, (content) => {
        capturedPrompt = content;
        deliverUnitResult(
          { status: "blocked", summary: "sem refs para pontuar", artifacts: [], reason: "sem pools configurados" },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runResearchModelsCommand(ctx, session));

      assert.doesNotMatch(capturedPrompt, /- Milestone:/, "no active milestone — the identity line is omitted");
      assert.match(capturedPrompt, /GSD model-research agent/, "the dispatch actually ran — the body was composed and sent");
      assert.equal(session.active, false, "the finally ran even without STATE.md");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("(D) reentrância: session.active=true ⇒ warning, zero dispatch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-research-models-e2e-reentrant-"));
    try {
      const session = new ForgeAutoSession();
      session.active = true; // simulate an already-running loop/dispatch
      let sendMessageCalled = false;
      const { ctx, notifications } = fakeCtx(cwd, () => {
        sendMessageCalled = true;
      });

      await runResearchModelsCommand(ctx, session);

      assert.equal(sendMessageCalled, false, "no dispatch was attempted");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.[1], "warning");
      assert.match(notifications[0]?.[0] ?? "", /loop já ativo/);
      // The guard does not clobber the already-active session.
      assert.equal(session.active, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function writeResearcherPoolConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    [
      "pools:",
      "  demo:",
      "    - prov-a/model-x",
      "  grok-demo:",
      "    - xai/grok-4",
      "",
      "roles:",
      "  executor:",
      "    - demo",
      "  researcher:",
      "    - grok-demo",
      "",
    ].join("\n"),
  );
}

describe("S01/T02 — researcher role wired into research-models dispatch (through-the-driver)", () => {
  test("with researcher: [grok-demo] configured, dispatch author resolves via the researcher pool, journaled on research_models_dispatched", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-research-models-e2e-researcher-"));
    try {
      writeResearcherPoolConfig(cwd);

      const session = new ForgeAutoSession();
      const { ctx } = fakeCtx(cwd, () => {
        deliverUnitResult(
          { status: "done", summary: "matriz atualizada", artifacts: [] },
          session.currentRendezvousToken ?? undefined,
        );
      });

      await assert.doesNotReject(runResearchModelsCommand(ctx, session));

      const events = readEvents(cwd);
      const dispatched = events.find((e) => e.kind === "research_models_dispatched");
      assert.ok(dispatched, "research_models_dispatched event was journaled");
      assert.equal(
        dispatched!.model,
        "xai/grok-4",
        "the researcher pool's ref won authorship — never the executor pool's 'demo' ref",
      );
      assert.equal(dispatched!.provider, "xai");
      assert.equal(dispatched!.family, "grok");
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
