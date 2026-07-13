/**
 * Ceremony coverage for the complete `/forge milestone` lifecycle.
 *
 * The fake terminates at `newSession`/`sendMessage`. Composition, dispatch,
 * rendezvous, STATE, journal, and replay all execute through production code.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { ForgeAutoSession } from "../auto/session.ts";
import { replayJournalOnResume } from "../auto/replay.ts";
import { runMilestoneCommand } from "../commands/milestone-command.ts";
import { deriveNextUnit } from "../state/dispatch.ts";
import { parseRoadmap } from "../state/parse.ts";
import { readState, updateState } from "../state/store.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Recursive fake required by the driver's stale-handle replacement rule. */
function fakeCtx(
  cwd: string,
  onSendMessage: (content: string) => void,
): { ctx: ExtensionCommandContext; notifications: Array<[string, string]> } {
  const notifications: Array<[string, string]> = [];
  function makeSessionLike(): unknown {
    return {
      cwd,
      hasUI: true,
      ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
      model: undefined,
      abort() {},
      async sendMessage(message: { content: string }): Promise<void> {
        onSendMessage(message.content);
      },
      async newSession(options: { withSession: (fresh: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
        await options.withSession(makeSessionLike());
        return { cancelled: false };
      },
    };
  }
  return { ctx: makeSessionLike() as ExtensionCommandContext, notifications };
}

function milestoneDir(cwd: string, mid: string): string {
  return join(cwd, ".gsd", "milestones", mid);
}

function onlyMilestoneDir(cwd: string): { mid: string; dir: string } {
  const root = join(cwd, ".gsd", "milestones");
  const mids = readdirSync(root);
  assert.equal(mids.length, 1, "birth reserved exactly one directory");
  return { mid: mids[0]!, dir: join(root, mids[0]!) };
}

function writtenContext(dir: string, mid: string, body = "Conteúdo inicial produzido pelo worker."): string {
  const path = join(dir, `${mid}-CONTEXT.md`);
  writeFileSync(
    path,
    [
      "---",
      "domain: backend",
      "---",
      "",
      `# ${mid}`, 
      "",
      "## Objetivo",
      "",
      body,
      "",
      "## Escopo",
      "",
      "- Um fluxo verificável.",
      "",
      "## Fora de escopo",
      "",
      "- Trabalho não solicitado.",
      "",
      "## Realidades do repo",
      "",
      "- src/resources/extensions/forge/commands/milestone-command.ts:1",
      "",
    ].join("\n"),
  );
  return path;
}

function fakeRoadmap(mid: string): string {
  return [
    "---",
    "domain: backend",
    "---",
    "",
    `# ${mid} — ROADMAP`,
    "",
    "## Vision",
    "",
    "Uma visão substantiva para a cerimônia de planejamento.",
    "",
    "## Slices",
    "",
    "| ID | Nome | Risk | Depends | Status |",
    "|----|------|------|---------|--------|",
    "| S01 | Primeira slice | med | — | pending |",
    "",
    "## Notas",
    "",
    "O auto pode começar pela primeira slice.",
    "",
  ].join("\n");
}

function lastNotification(notifications: Array<[string, string]>): [string, string] {
  const result = notifications.at(-1);
  assert.ok(result, "the command emitted an operator notification");
  return result;
}

async function withTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FORGE_UNIT_TIMEOUT_MS;
  process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
    else process.env.FORGE_UNIT_TIMEOUT_MS = previous;
  }
}

describe("S04/T01 — cerimônia nascimento → lapidação → start through the production driver", () => {
  test("completa o ciclo no mesmo sandbox e exercita recusas encadeadas", async () => {
    await withTimeout(async () => {
      const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-lifecycle-e2e-"));
      try {
        const session = new ForgeAutoSession();
        let birthPrompt = "";
        const birth = fakeCtx(cwd, (prompt) => {
          birthPrompt = prompt;
          const { mid, dir } = onlyMilestoneDir(cwd);
          writtenContext(dir, mid);
          deliverUnitResult({ status: "done", summary: "CONTEXT entregue", artifacts: [] }, session.currentRendezvousToken ?? undefined);
        });

        await runMilestoneCommand(birth.ctx, ['"planejar a cerimônia completa"'], session);

        const { mid, dir } = onlyMilestoneDir(cwd);
        const contextPath = join(dir, `${mid}-CONTEXT.md`);
        const requestPath = join(dir, `${mid}-REQUEST.md`);
        const roadmapPath = join(dir, `${mid}-ROADMAP.md`);
        assert.match(birthPrompt, /# Unit: milestone-context/);
        assert.equal(existsSync(join(cwd, ".gsd", "STATE.md")), false, "birth never creates STATE");
        assert.ok(existsSync(requestPath), "the durable request lands alongside CONTEXT");
        assert.match(readFileSync(requestPath, "utf8"), /planejar a cerimônia completa/);
        assert.deepEqual(
          readEvents(cwd).filter((event) => event.unit === "milestone-context").map((event) => event.kind),
          ["milestone_dispatched", "milestone_result"],
          "birth uses advisory journal kinds",
        );

        const polished = writtenContext(dir, mid, "Conteúdo lapidado pelo operador antes do planejamento.");
        const polishedBytes = readFileSync(polished, "utf8");
        let startPrompt = "";
        const start = fakeCtx(cwd, (prompt) => {
          startPrompt = prompt;
          assert.equal(readFileSync(contextPath, "utf8"), polishedBytes, "start composes only after the edited CONTEXT is on disk");
          writeFileSync(roadmapPath, fakeRoadmap(mid));
          deliverUnitResult({ status: "done", summary: "ROADMAP entregue", artifacts: [roadmapPath] }, session.currentRendezvousToken ?? undefined);
        });

        await runMilestoneCommand(start.ctx, ["start", mid], session);

        assert.match(startPrompt, /# Unit: plan-milestone/);
        assert.ok(startPrompt.includes(contextPath), "production composition receives the polished CONTEXT path");
        const state = readState(cwd);
        assert.equal(state.milestone, mid);
        assert.equal(state.phase, "plan");
        assert.deepEqual(state.units, []);
        const normalEvents = readEvents(cwd).filter((event) => event.unit === "plan-milestone");
        assert.deepEqual(normalEvents.map((event) => event.kind), ["unit_dispatched", "unit_result"]);
        for (const event of normalEvents) {
          assert.equal(event.slice, undefined);
          assert.equal(event.task, undefined);
        }
        assert.match(lastNotification(start.notifications)[0], /Próximo passo: \/forge auto/);
        const slices = parseRoadmap(readFileSync(roadmapPath, "utf8"));
        assert.deepEqual(deriveNextUnit(readState(cwd), slices, {}, {}), { type: "plan-slice", slice: "S01" });

        const stateBeforeReplay = readFileSync(join(cwd, ".gsd", "STATE.md"));
        const journalBeforeReplay = readFileSync(join(cwd, ".gsd", "forge", "events.jsonl"));
        replayJournalOnResume(cwd);
        assert.ok(readFileSync(join(cwd, ".gsd", "STATE.md")).equals(stateBeforeReplay));
        assert.ok(readFileSync(join(cwd, ".gsd", "forge", "events.jsonl")).equals(journalBeforeReplay));

        const stateBeforeRestart = readFileSync(join(cwd, ".gsd", "STATE.md"));
        const journalBeforeRestart = readFileSync(join(cwd, ".gsd", "forge", "events.jsonl"));
        let sends = 0;
        const restart = fakeCtx(cwd, () => sends++);
        await runMilestoneCommand(restart.ctx, ["start", mid], session);
        assert.equal(sends, 0);
        assert.match(lastNotification(restart.notifications)[0], /já planejada/);
        assert.ok(readFileSync(join(cwd, ".gsd", "STATE.md")).equals(stateBeforeRestart));
        assert.ok(readFileSync(join(cwd, ".gsd", "forge", "events.jsonl")).equals(journalBeforeRestart));

        // Derive a no-active-state view so CONTEXT validation (the third guard)
        // is reachable after the completed ceremony.
        updateState(cwd, () => ({ milestone: "", units: [] }));
        for (const invalid of ["M-inexistente", "M-sem-context", "M-context-vazio"]) {
          if (invalid !== "M-inexistente") mkdirSync(milestoneDir(cwd, invalid), { recursive: true });
          if (invalid === "M-context-vazio") writeFileSync(join(milestoneDir(cwd, invalid), `${invalid}-CONTEXT.md`), " \n");
          const rejected = fakeCtx(cwd, () => sends++);
          await runMilestoneCommand(rejected.ctx, ["start", invalid], session);
          assert.match(lastNotification(rejected.notifications)[0], /CONTEXT ausente ou vazio/);
        }
        assert.equal(sends, 0, "invalid starts never dispatch");

        // Restore the ceremony's incomplete plan STATE: a different MID must
        // now be refused by the active-milestone guard.
        updateState(cwd, () => ({ milestone: mid, phase: "plan", units: [] }));
        const second = "M-segunda";
        mkdirSync(milestoneDir(cwd, second), { recursive: true });
        writtenContext(milestoneDir(cwd, second), second);
        const active = fakeCtx(cwd, () => sends++);
        await runMilestoneCommand(active.ctx, ["start", second], session);
        assert.match(lastNotification(active.notifications)[0], /\/forge status/);
        assert.equal(sends, 0);

        const beforeDirs = readdirSync(join(cwd, ".gsd", "milestones")).length;
        session.active = true;
        const reentrant = fakeCtx(cwd, () => sends++);
        await runMilestoneCommand(reentrant.ctx, ["não deve reservar"], session);
        assert.match(lastNotification(reentrant.notifications)[0], /loop já ativo/);
        assert.equal(readdirSync(join(cwd, ".gsd", "milestones")).length, beforeDirs);
        session.active = false;
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  test("colisão de nascimento reserva atomicamente o sufixo -2", async () => {
    await withTimeout(async () => {
      const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-lifecycle-collision-"));
      const RealDate = Date;
      const fixedNow = Date.parse("2026-07-13T12:00:00.000Z");
      class FixedDate extends RealDate {
        constructor(value?: string | number | Date) {
          super(value ?? fixedNow);
        }
        static override now(): number {
          return fixedNow;
        }
      }
      (globalThis as { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor;
      try {
        const base = "M-20260713120000-colisao";
        mkdirSync(milestoneDir(cwd, base), { recursive: true });
        const session = new ForgeAutoSession();
        const collided = `${base}-2`;
        const birth = fakeCtx(cwd, () => {
          writtenContext(milestoneDir(cwd, collided), collided);
          deliverUnitResult({ status: "done", summary: "CONTEXT entregue", artifacts: [] }, session.currentRendezvousToken ?? undefined);
        });

        await runMilestoneCommand(birth.ctx, ["colisao"], session);
        assert.ok(existsSync(milestoneDir(cwd, collided)));
      } finally {
        (globalThis as { Date: DateConstructor }).Date = RealDate;
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
