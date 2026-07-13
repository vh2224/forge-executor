/**
 * Through-the-driver coverage for `/forge milestone start <MID>`.
 * The fake ends at `newSession`/`sendMessage`; prompt composition, dispatch,
 * rendezvous, state writes, journaling, and post-landing validation are real.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { runMilestoneCommand } from "../commands/milestone-command.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { replayJournalOnResume } from "../auto/replay.ts";
import { readState } from "../state/store.ts";
import { deliverUnitResult } from "../worker/rendezvous.ts";

const MID = "M-test-milestone";

function readEvents(cwd: string): Array<Record<string, unknown>> {
  const path = join(cwd, ".gsd", "forge", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Recursive fake required by the driver's B3 stale-handle rule: each
 * `withSession` replacement exposes the same `newSession`/`sendMessage` API.
 */
function fakeCtx(
  cwd: string,
  onSendMessage: (content: string) => void,
  hasUI = true,
): { ctx: ExtensionCommandContext; notifications: Array<[string, string]> } {
  const notifications: Array<[string, string]> = [];
  function makeSessionLike(): unknown {
    return {
      cwd,
      hasUI,
      ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
      model: undefined,
      abort() {},
      async sendMessage(message: { content: string }): Promise<void> {
        onSendMessage(message.content);
      },
      async newSession(opts: { withSession: (fresh: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
        await opts.withSession(makeSessionLike());
        return { cancelled: false };
      },
    };
  }
  return { ctx: makeSessionLike() as ExtensionCommandContext, notifications };
}

function milestoneDir(cwd: string, mid = MID): string {
  return join(cwd, ".gsd", "milestones", mid);
}

/** Seed a substantive CONTEXT with the scope-domain header consumed by the prompt. */
function seedMilestoneContext(cwd: string, mid = MID): string {
  const dir = milestoneDir(cwd, mid);
  mkdirSync(dir, { recursive: true });
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
      "Planejar uma mudança verificável.",
      "",
      "## Escopo",
      "",
      "- Implementar o fluxo pedido.",
      "",
      "## Fora de escopo",
      "",
      "- Nada além deste teste.",
      "",
    ].join("\n"),
  );
  return path;
}

function roadmapPath(cwd: string, mid = MID): string {
  return join(milestoneDir(cwd, mid), `${mid}-ROADMAP.md`);
}

/** Write the minimum substantive CONTEXT accepted by the birth landing gate. */
function writtenContext(dir: string, mid: string, domain = "backend"): string {
  const path = join(dir, `${mid}-CONTEXT.md`);
  writeFileSync(
    path,
    [
      "---",
      `domain: ${domain}`,
      "---",
      "",
      `# ${mid}`,
      "",
      "## Objetivo",
      "",
      "Entregar o pedido do operador.",
      "",
      "## Escopo",
      "",
      "- Um fluxo verificável.",
      "",
      "## Fora de escopo",
      "",
      "- Qualquer trabalho não solicitado.",
      "",
      "## Realidades do repo",
      "",
      "- src/resources/extensions/forge/commands/milestone-command.ts:1",
      "",
    ].join("\n"),
  );
  return path;
}

function onlyMilestoneDir(cwd: string): { mid: string; dir: string } {
  const root = join(cwd, ".gsd", "milestones");
  const mids = readdirSync(root);
  assert.equal(mids.length, 1, "the birth reserved exactly one milestone directory");
  return { mid: mids[0], dir: join(root, mids[0]) };
}

/** A substantive roadmap whose Slices table parses to one pending slice. */
function fakeRoadmap(mid = MID): string {
  return [
    "---",
    "domain: backend",
    "---",
    "",
    `# ${mid} — ROADMAP`,
    "",
    "## Vision",
    "",
    "Uma visão suficientemente detalhada para o planejador.",
    "",
    "## Slices",
    "",
    "| ID | Nome | Risk | Depends | Status |",
    "|----|------|------|---------|--------|",
    "| S01 | Primeira slice | med | — | pending |",
    "",
    "## Notas",
    "",
    "A execução começa após a revisão do roadmap.",
    "",
  ].join("\n");
}

function writeStateFile(cwd: string, milestone: string, phase = "execute"): string {
  const path = join(cwd, ".gsd", "STATE.md");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(path, `# STATE\n\n\`\`\`yaml\nmilestone: ${milestone}\nphase: ${phase}\nunits: []\n\`\`\`\n`);
  return path;
}

function lastNotification(notifications: Array<[string, string]>): [string, string] {
  const notification = notifications.at(-1);
  assert.ok(notification, "the command reported an operator-facing result");
  return notification;
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

describe("S01/T03 — /forge milestone start through the production driver", () => {
  test("happy path composes planner prompt, flips STATE, journals normal events, verifies ROADMAP, and replay is a no-op", async () => {
    await withTimeout(async () => {
      const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-happy-"));
      try {
        const contextPath = seedMilestoneContext(cwd);
        const session = new ForgeAutoSession();
        let prompt = "";
        const { ctx, notifications } = fakeCtx(cwd, (content) => {
          prompt = content;
          writeFileSync(roadmapPath(cwd), fakeRoadmap());
          deliverUnitResult(
            { status: "done", summary: "ROADMAP escrito", artifacts: [roadmapPath(cwd)] },
            session.currentRendezvousToken ?? undefined,
          );
        });

        await assert.doesNotReject(runMilestoneCommand(ctx, ["start", MID], session));

        assert.match(prompt, /# Unit: plan-milestone/);
        assert.ok(prompt.includes(contextPath), "the prompt names the CONTEXT path");
        assert.ok(prompt.includes(roadmapPath(cwd)), "the prompt names the ROADMAP write path");
        assert.match(prompt, /- Domain \(larger scope\): `backend`/);

        const state = readState(cwd);
        assert.equal(state.milestone, MID);
        assert.equal(state.phase, "plan");
        assert.deepEqual(state.units, []);

        const events = readEvents(cwd).filter((event) => event.unit === "plan-milestone");
        assert.deepEqual(events.map((event) => event.kind), ["unit_dispatched", "unit_result"]);
        for (const event of events) {
          assert.equal(event.milestone, MID);
          assert.equal(event.slice, undefined, "plan-milestone events must not resemble a loop slice");
          assert.equal(event.task, undefined, "plan-milestone events must not resemble a task");
        }
        assert.equal(events[1]?.status, "done");
        assert.match(lastNotification(notifications)[0], /Próximo passo: \/forge auto/);
        assert.equal(session.active, false, "restoreInteractiveSession ran in finally");

        const stateBeforeReplay = readFileSync(join(cwd, ".gsd", "STATE.md"));
        replayJournalOnResume(cwd);
        assert.ok(readFileSync(join(cwd, ".gsd", "STATE.md")).equals(stateBeforeReplay), "replay is byte-identical no-op");
        assert.ok(!readEvents(cwd).some((event) => event.kind === "unit_result_replayed"));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  test("planner role resolves its own pool and journals that planner model", async () => {
    await withTimeout(async () => {
      const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-planner-role-"));
      try {
        seedMilestoneContext(cwd);
        mkdirSync(join(cwd, ".gsd"), { recursive: true });
        writeFileSync(
          join(cwd, ".gsd", "models.md"),
          "pools:\n  planner-pool:\n    - openai/gpt-5.5\n  executor-pool:\n    - claude-code/claude-opus-4-8\n\nroles:\n  planner:\n    - planner-pool\n  executor:\n    - executor-pool\n",
        );
        const session = new ForgeAutoSession();
        const { ctx } = fakeCtx(cwd, () => {
          writeFileSync(roadmapPath(cwd), fakeRoadmap());
          deliverUnitResult({ status: "done", summary: "ROADMAP escrito", artifacts: [] }, session.currentRendezvousToken ?? undefined);
        });

        await runMilestoneCommand(ctx, ["start", MID], session);

        const dispatched = readEvents(cwd).find((event) => event.kind === "unit_dispatched");
        assert.ok(dispatched, "the normal dispatch event was written");
        assert.equal(dispatched.model, "openai/gpt-5.5", "plan-milestone uses planner rather than executor pool");
        assert.equal(dispatched.provider, "openai");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  test("refuses an existing ROADMAP without dispatching or changing STATE", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-restart-"));
    try {
      seedMilestoneContext(cwd);
      writeFileSync(roadmapPath(cwd), fakeRoadmap());
      const statePath = writeStateFile(cwd, "M-other");
      const before = readFileSync(statePath);
      const session = new ForgeAutoSession();
      let sends = 0;
      const { ctx, notifications } = fakeCtx(cwd, () => sends++);

      await runMilestoneCommand(ctx, ["start", MID], session);

      assert.equal(sends, 0);
      assert.ok(readFileSync(statePath).equals(before));
      assert.deepEqual(readEvents(cwd), []);
      assert.match(lastNotification(notifications)[0], /já planejada.*\/forge auto/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("refuses a different incomplete active milestone and points to /forge status", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-active-"));
    try {
      seedMilestoneContext(cwd);
      const statePath = writeStateFile(cwd, "M-active", "execute");
      const before = readFileSync(statePath);
      const session = new ForgeAutoSession();
      let sends = 0;
      const { ctx, notifications } = fakeCtx(cwd, () => sends++);

      await runMilestoneCommand(ctx, ["start", MID], session);

      assert.equal(sends, 0);
      assert.ok(readFileSync(statePath).equals(before));
      assert.deepEqual(readEvents(cwd), []);
      assert.match(lastNotification(notifications)[0], /M-active.*\/forge status/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("refuses a nonexistent, missing, or empty CONTEXT without dispatching or changing STATE", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-context-"));
    try {
      const statePath = writeStateFile(cwd, "");
      const before = readFileSync(statePath);
      for (const mid of ["M-no-dir", "M-no-context", "M-empty-context"]) {
        if (mid !== "M-no-dir") {
          mkdirSync(milestoneDir(cwd, mid), { recursive: true });
        }
        if (mid === "M-empty-context") writeFileSync(join(milestoneDir(cwd, mid), `${mid}-CONTEXT.md`), " \n\n");
        const session = new ForgeAutoSession();
        let sends = 0;
        const { ctx, notifications } = fakeCtx(cwd, () => sends++);

        await runMilestoneCommand(ctx, ["start", mid], session);

        assert.equal(sends, 0, `${mid} never dispatches`);
        assert.match(lastNotification(notifications)[0], /CONTEXT ausente ou vazio/);
      }
      assert.ok(readFileSync(statePath).equals(before));
      assert.deepEqual(readEvents(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("missing STATE permits dispatch, but a done worker without ROADMAP reports an honest warning and leaves STATE untouched", async () => {
    await withTimeout(async () => {
      const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-no-state-"));
      try {
        seedMilestoneContext(cwd);
        const session = new ForgeAutoSession();
        let sends = 0;
        const { ctx, notifications } = fakeCtx(cwd, () => {
          sends++;
          deliverUnitResult({ status: "done", summary: "disse que escreveu", artifacts: [] }, session.currentRendezvousToken ?? undefined);
        });

        await runMilestoneCommand(ctx, ["start", MID], session);

        assert.equal(sends, 1, "missing STATE is not a dispatch blocker");
        assert.equal(
          readState(cwd).milestone,
          "",
          "R1 (S01 review): activation is deferred past ROADMAP verification, so a done-but-unverified landing never activates STATE",
        );
        assert.equal(
          existsSync(join(cwd, ".gsd", "STATE.md")),
          false,
          "no STATE.md should ever be written for a failed landing",
        );
        const report = lastNotification(notifications);
        assert.equal(report[1], "warning");
        assert.match(report[0], /worker reportou done, mas ROADMAP ausente/);
        assert.doesNotMatch(report[0], /Próximo passo: \/forge auto/);
        assert.equal(session.active, false, "finally restores the session after an invalid landing");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});

describe("S02/T03 — /forge milestone nascimento through the production driver", () => {
  test("happy path compõe milestone-context, persiste REQUEST, journaliza e instrui o start sem tocar STATE", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-birth-happy-"));
    try {
      const statePath = writeStateFile(cwd, "M-preservada");
      const beforeState = readFileSync(statePath);
      mkdirSync(join(cwd, ".gsd"), { recursive: true });
      writeFileSync(
        join(cwd, ".gsd", "models.md"),
        "pools:\n  planner-pool:\n    - openai/gpt-5.5\n\nroles:\n  planner:\n    - planner-pool\n",
      );
      const session = new ForgeAutoSession();
      let prompt = "";
      const { ctx, notifications } = fakeCtx(cwd, (content) => {
        prompt = content;
        const { mid, dir } = onlyMilestoneDir(cwd);
        writtenContext(dir, mid);
        deliverUnitResult({ status: "done", summary: "CONTEXT entregue", artifacts: [] }, session.currentRendezvousToken ?? undefined);
      });

      await runMilestoneCommand(ctx, ['"corrigir o banner"'], session);

      const { mid, dir } = onlyMilestoneDir(cwd);
      const contextPath = join(dir, `${mid}-CONTEXT.md`);
      const requestPath = join(dir, `${mid}-REQUEST.md`);
      assert.match(prompt, /# Unit: milestone-context/);
      assert.match(prompt, /Você é um agente de planejamento Forge/);
      assert.ok(prompt.includes(requestPath), "the prompt names the durable request");
      assert.ok(prompt.includes(contextPath), "the prompt names the only permitted CONTEXT write");
      assert.match(readFileSync(requestPath, "utf8"), /corrigir o banner/);
      assert.ok(existsSync(contextPath));
      assert.ok(readFileSync(statePath).equals(beforeState), "birth preserves pre-existing STATE bytes");

      const events = readEvents(cwd).filter((event) => event.unit === "milestone-context");
      assert.deepEqual(events.map((event) => event.kind), ["milestone_dispatched", "milestone_result"]);
      for (const event of events) {
        assert.equal(event.milestone, mid);
        assert.equal(event.slice, undefined);
        assert.equal(event.task, undefined);
        assert.ok("model" in event || "provider" in event || "family" in event, "authorship fields are journaled when resolved");
      }
      assert.equal(events[1]?.status, "done");
      const report = lastNotification(notifications);
      assert.equal(report[1], "success");
      assert.match(report[0], new RegExp(`${contextPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(report[0], new RegExp(`/forge milestone start ${mid}`));
      assert.equal(session.active, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("STATE ausente permanece ausente após o nascimento", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-birth-no-state-"));
    try {
      const session = new ForgeAutoSession();
      const { ctx } = fakeCtx(cwd, () => {
        const { mid, dir } = onlyMilestoneDir(cwd);
        writtenContext(dir, mid);
        deliverUnitResult({ status: "done", summary: "ok", artifacts: [] }, session.currentRendezvousToken ?? undefined);
      });

      await runMilestoneCommand(ctx, ["sem state"], session);
      assert.equal(existsSync(join(cwd, ".gsd", "STATE.md")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("replay ignora o par advisory do nascimento e não cria STATE", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-birth-replay-"));
    try {
      const session = new ForgeAutoSession();
      const { ctx } = fakeCtx(cwd, () => {
        const { mid, dir } = onlyMilestoneDir(cwd);
        writtenContext(dir, mid);
        deliverUnitResult({ status: "done", summary: "ok", artifacts: [] }, session.currentRendezvousToken ?? undefined);
      });

      await runMilestoneCommand(ctx, ["testar replay"], session);
      const eventsBefore = readEvents(cwd);
      replayJournalOnResume(cwd);
      assert.equal(existsSync(join(cwd, ".gsd", "STATE.md")), false);
      assert.deepEqual(readEvents(cwd), eventsBefore, "unknown advisory kinds reconstruct no unit and append nothing");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("done sem CONTEXT avisa honestamente e ainda preserva STATE", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-birth-missing-context-"));
    try {
      const statePath = writeStateFile(cwd, "M-imutavel");
      const beforeState = readFileSync(statePath);
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, () => {
        deliverUnitResult({ status: "done", summary: "disse que escreveu", artifacts: [] }, session.currentRendezvousToken ?? undefined);
      });

      await runMilestoneCommand(ctx, ["context ausente"], session);
      assert.equal(lastNotification(notifications)[1], "warning");
      assert.match(lastNotification(notifications)[0], /worker reportou done, mas CONTEXT ausente/);
      assert.ok(readFileSync(statePath).equals(beforeState));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("CONTEXT com domain fora do frontmatter é recusado com warning", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-birth-invalid-domain-"));
    try {
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, () => {
        const { mid, dir } = onlyMilestoneDir(cwd);
        writeFileSync(join(dir, `${mid}-CONTEXT.md`), ["# Context", "", "domain: backend", "", ...Array(12).fill("conteúdo")].join("\n"));
        deliverUnitResult({ status: "done", summary: "ok", artifacts: [] }, session.currentRendezvousToken ?? undefined);
      });

      await runMilestoneCommand(ctx, ["domain invalido"], session);
      assert.equal(lastNotification(notifications)[1], "warning");
      assert.match(lastNotification(notifications)[0], /domain: não-vazio no frontmatter/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resultado partial não anuncia o handoff de start", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-birth-partial-"));
    try {
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, () => {
        deliverUnitResult({ status: "partial", summary: "recon incompleta", artifacts: [] }, session.currentRendezvousToken ?? undefined);
      });

      await runMilestoneCommand(ctx, ["resultado parcial"], session);
      const report = lastNotification(notifications);
      assert.equal(report[1], "warning");
      assert.match(report[0], /não concluído \(partial\)/);
      assert.doesNotMatch(report[0], /Lapide o arquivo|milestone start/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("timeout do worker avisa honestamente sem reportar sucesso", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-birth-timeout-"));
    const previous = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "1";
    try {
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, () => {});
      await runMilestoneCommand(ctx, ["timeout"], session);
      const report = lastNotification(notifications);
      assert.equal(report[1], "warning");
      assert.match(report[0], /não concluído \(timeout\)/);
      assert.doesNotMatch(report[0], /Lapide o arquivo/);
    } finally {
      if (previous === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("colisão de diretório recebe sufixo atômico -2", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-birth-collision-"));
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
      const collidedMid = `${base}-2`;
      const { ctx } = fakeCtx(cwd, () => {
        writtenContext(milestoneDir(cwd, collidedMid), collidedMid);
        deliverUnitResult({ status: "done", summary: "ok", artifacts: [] }, session.currentRendezvousToken ?? undefined);
      });

      await runMilestoneCommand(ctx, ["colisao"], session);
      assert.ok(existsSync(milestoneDir(cwd, collidedMid)));
    } finally {
      (globalThis as { Date: DateConstructor }).Date = RealDate;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reentrância recusa antes de reservar qualquer diretório", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-birth-active-"));
    try {
      const session = new ForgeAutoSession();
      session.active = true;
      let sends = 0;
      const { ctx, notifications } = fakeCtx(cwd, () => sends++);

      await runMilestoneCommand(ctx, ["não deve nascer"], session);
      assert.equal(sends, 0);
      assert.equal(existsSync(join(cwd, ".gsd", "milestones")), false);
      assert.match(lastNotification(notifications)[0], /loop já ativo/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("S03/T02 — /forge milestone status de gestação", () => {
  test("lista gestações, a ativa com fase e omite milestones já planejadas", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-gestation-list-"));
    try {
      const first = "M-20260713120000-primeira";
      const second = "M-20260713130000-segunda";
      const planned = "M-20260713140000-planejada";
      seedMilestoneContext(cwd, first);
      seedMilestoneContext(cwd, second);
      seedMilestoneContext(cwd, planned);
      writeFileSync(roadmapPath(cwd, planned), fakeRoadmap(planned));
      writeStateFile(cwd, "M-ativa", "execute");
      const session = new ForgeAutoSession();
      let sends = 0;
      const { ctx, notifications } = fakeCtx(cwd, () => sends++);

      await runMilestoneCommand(ctx, [], session);

      const report = lastNotification(notifications)[0];
      assert.match(report, /Milestones em gestação:/);
      assert.match(report, new RegExp(`${first} — próximo passo: /forge milestone start ${first}`));
      assert.match(report, new RegExp(`${second} — próximo passo: /forge milestone start ${second}`));
      assert.match(report, /Ativa: M-ativa — phase: execute/);
      assert.doesNotMatch(report, new RegExp(planned));
      assert.equal(sends, 0, "status never dispatches");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("sem milestones imprime orientação amigável e não cria STATE", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-gestation-empty-"));
    try {
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, () => {});

      await runMilestoneCommand(ctx, [], session);

      const report = lastNotification(notifications)[0];
      assert.match(report, /Nenhuma milestone em gestação nem ativa/);
      assert.match(report, /Uso: \/forge milestone "<descrição>" \| start <MID>/);
      assert.equal(existsSync(join(cwd, ".gsd", "STATE.md")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("status é permitido durante sessão ativa, preserva STATE e os braços mutantes continuam bloqueados", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-gestation-active-"));
    try {
      const statePath = writeStateFile(cwd, "M-ativa", "plan");
      const before = readFileSync(statePath);
      const session = new ForgeAutoSession();
      session.active = true;
      let sends = 0;
      const { ctx, notifications } = fakeCtx(cwd, () => sends++);

      await runMilestoneCommand(ctx, [], session);
      assert.match(lastNotification(notifications)[0], /Ativa: M-ativa — phase: plan/);
      assert.ok(readFileSync(statePath).equals(before), "status preserves STATE bytes");
      assert.equal(sends, 0);

      await runMilestoneCommand(ctx, ["start", MID], session);
      assert.match(lastNotification(notifications)[0], /loop já ativo/);
      await runMilestoneCommand(ctx, ["não deve nascer"], session);
      assert.match(lastNotification(notifications)[0], /loop já ativo/);
      assert.equal(sends, 0);
      assert.equal(existsSync(join(cwd, ".gsd", "milestones")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("em contexto headless escreve o status no stdout", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-milestone-gestation-headless-"));
    const originalWrite = process.stdout.write;
    let stdout = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      seedMilestoneContext(cwd, "M-20260713150000-headless");
      const session = new ForgeAutoSession();
      const { ctx, notifications } = fakeCtx(cwd, () => {}, false);

      await runMilestoneCommand(ctx, [], session);

      assert.match(stdout, /M-20260713150000-headless/);
      assert.match(stdout, /\/forge milestone start M-20260713150000-headless/);
      assert.deepEqual(notifications, []);
    } finally {
      process.stdout.write = originalWrite;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
