import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHelp, formatStatus, runAuto } from "../commands/forge-command.ts";
import { ForgeAutoSession } from "../auto/session.ts";
import { updateState, appendEvent } from "../state/store.ts";
import type { StateDoc, ForgeEvent } from "../state/types.ts";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import {
  renderReview,
  writeReview,
  reviewArtifactPath,
  applyDecision,
  type ReviewArtifactMeta,
} from "../review/artifact.ts";
import type { ResolveReviewResult, ResolvedReviewItem } from "../review/resolve.ts";

// ── Fixtures for the review-digest cases below — same grammar as
// tests/review-digest.test.ts / tests/review-artifact.test.ts: render via the
// artifact layer, then write-back the pending marker for real. ────────────────

function reviewMeta(slice: string): ReviewArtifactMeta {
  return {
    milestoneId: "M-test",
    slice,
    sliceTitle: "toy slice",
    reviewedOn: "2026-07-12",
    rounds: 1,
  };
}

function reviewItem(
  id: string,
  resolution: ResolvedReviewItem["resolution"],
  over: Partial<ResolvedReviewItem> = {},
): ResolvedReviewItem {
  return {
    id,
    pathLine: `src/${id}.ts:10`,
    severity: "high",
    claim: `claim ${id}`,
    suggestedFix: `fix ${id}`,
    challenge: `challenge ${id}?`,
    defense: { verdict: "refuted", rationale: `defense ${id}` },
    rebuttal: { verdict: "maintained", rationale: `rebuttal ${id}` },
    resolution,
    ...over,
  };
}

function reviewResult(items: ResolvedReviewItem[]): ResolveReviewResult {
  const counts = { resolved: 0, conceded: 0, open: 0 };
  for (const i of items) counts[i.resolution]++;
  return { noFlags: items.length === 0, items, counts, warnings: [] };
}

describe("forge-command", () => {
  test("formatHelp lists the four subcommands", () => {
    const help = formatHelp();
    assert.match(help, /status/);
    assert.match(help, /help/);
    assert.match(help, /auto/);
    assert.match(help, /next/);
  });

  test("formatHelp lists research-models (S04/T04)", () => {
    const help = formatHelp();
    assert.match(help, /research-models/);
    assert.match(help, /CAPABILITIES\.md/);
  });

  test("formatStatus returns an honest message when .gsd/STATE.md is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-"));
    try {
      const result = formatStatus(dir);
      assert.doesNotThrow(() => formatStatus(dir));
      assert.match(result, /Nenhum estado forge/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formatStatus surfaces STATE.md content when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-"));
    try {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "STATE.md"), "```yaml\nphase: S01\n```\n");
      const result = formatStatus(dir);
      assert.match(result, /phase: S01/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // aceite #4 — status blocked/partial persistido (M1R-4 pela ótica do comando)
  test("aceite #4 — status blocked/partial persistido: formatStatus enxerga ambos os terminais via updateState real (mkdtemp)", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-"));
    try {
      const doc: StateDoc = {
        milestone: "M-20260709234644-paridade-auto-hospedagem",
        phase: "execute",
        current_slice: "S08",
        units: [
          { id: "T03", type: "task", status: "blocked" },
          { id: "T04", type: "task", status: "partial" },
        ],
      };
      updateState(dir, () => doc);

      const result = formatStatus(dir);
      assert.match(result, /blocked/, "blocked terminal visível no output");
      assert.match(result, /partial/, "partial terminal visível no output");
      assert.match(result, /T03/, "id da unidade blocked visível no output");
      assert.match(result, /T04/, "id da unidade partial visível no output");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aceite #4 — status lê estado VIVO do disco: após updateState flipar blocked→done, formatStatus reflete a mudança", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-"));
    try {
      const base: StateDoc = {
        milestone: "M-20260709234644-paridade-auto-hospedagem",
        units: [{ id: "T03", type: "task", status: "blocked" }],
      };
      updateState(dir, () => base);
      assert.match(formatStatus(dir), /blocked/, "estado inicial mostra blocked");

      updateState(dir, (state) => ({
        ...state,
        units: (state.units ?? []).map((u) =>
          u.id === "T03" ? { ...u, status: "done" as const } : u,
        ),
      }));

      const result = formatStatus(dir);
      assert.match(result, /T03/);
      assert.doesNotMatch(result, /status: blocked/, "blocked não deve mais aparecer para T03");
      assert.match(result, /status: done/, "status refletido é done — leitura live do disco");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forge-command status de gestação (S03/T03)", () => {
  const gestationId = "M-20260713000000-gestacao";

  function writeGestation(dir: string): void {
    const milestoneDir = join(dir, ".gsd", "milestones", gestationId);
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(
      join(milestoneDir, `${gestationId}-CONTEXT.md`),
      "---\ndomain: backend\n---\n\n# Contexto\n",
    );
  }

  test("formatHelp documenta nascimento, lapidação, start e /forge auto", () => {
    const help = formatHelp();
    assert.match(help, /milestone/);
    assert.match(help, /CONTEXT.*lapidação/i);
    assert.match(help, /start <MID>/);
    assert.match(help, /\/forge auto/);
  });

  test("sem STATE, lista a gestação e seu próximo passo", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-gestation-"));
    try {
      writeGestation(dir);
      const result = formatStatus(dir);
      assert.match(result, /Nenhum estado forge/);
      assert.match(result, /Milestones em gestação:/);
      assert.match(result, new RegExp(`/forge milestone start ${gestationId}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("com STATE, lista a gestação ao lado da milestone ativa", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-gestation-"));
    try {
      writeGestation(dir);
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "STATE.md"),
        "```yaml\nmilestone: M-active\nphase: execute\nunits: []\n```\n",
      );
      const result = formatStatus(dir);
      assert.match(result, /Milestone: M-active/);
      assert.match(result, /Milestones em gestação:/);
      assert.match(result, new RegExp(`/forge milestone start ${gestationId}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sem gestações, a saída permanece byte-idêntica", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-gestation-"));
    try {
      const before = formatStatus(dir);
      mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
      const after = formatStatus(dir);
      assert.equal(after, before);
      assert.doesNotMatch(after, /Milestones em gestação:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a recusa de start por milestone ativa continua apontando /forge status", () => {
    const source = readFileSync(
      new URL("../commands/milestone-command.ts", import.meta.url),
      "utf-8",
    );
    assert.match(source, /milestone ativa incompleta[^`]*\/forge status/);
  });
});

describe("forge-command formatStatus — review digest (S04/T02)", () => {
  function writeMilestoneState(dir: string): void {
    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "STATE.md"), "```yaml\nmilestone: M-test\nunits: []\n```\n");
  }

  test("milestone ativa + S06-REVIEW.md com R1 pendente exibe o bloco do digest entre progresso e Prefs", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-digest-"));
    try {
      writeMilestoneState(dir);
      const md = renderReview(
        reviewMeta("S06"),
        reviewResult([reviewItem("R1", "open", { challenge: "real?" })]),
      );
      const written = writeReview(dir, "M-test", "S06", md);
      applyDecision(written.path, "R1", "deferido → triagem no fim da milestone"); // stays pending

      const result = formatStatus(dir);
      assert.match(result, /⚖ 1 aberta\(s\)/);
      assert.match(result, /R1 \(S06\)/);
      const expectedPath = reviewArtifactPath(dir, "M-test", "S06");
      assert.ok(result.includes("S06-REVIEW.md"), "caminho do REVIEW.md aparece no digest");
      assert.ok(existsSync(expectedPath), "fixture write-back landed at the expected path");

      // the digest block sits between the progress block and the Prefs line
      const digestIdx = result.indexOf("⚖ 1 aberta(s)");
      const prefsIdx = result.indexOf("Prefs:");
      assert.ok(digestIdx > -1 && prefsIdx > -1 && digestIdx < prefsIdx, "digest precede a linha de Prefs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("milestone ativa sem REVIEW.md pendente não exibe ⚖ — saída inalterada", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-digest-"));
    try {
      writeMilestoneState(dir);
      const result = formatStatus(dir);
      assert.doesNotMatch(result, /⚖/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("S06-REVIEW.md corrompido degrada honestamente: formatStatus não lança e omite o digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-digest-"));
    try {
      writeMilestoneState(dir);
      const reviewDir = join(dir, ".gsd", "milestones", "M-test", "slices", "S06");
      mkdirSync(reviewDir, { recursive: true });
      writeFileSync(join(reviewDir, "S06-REVIEW.md"), "### not a valid review block\nlixo\n");

      let result = "";
      assert.doesNotThrow(() => {
        result = formatStatus(dir);
      });
      assert.doesNotMatch(result, /⚖/);
      assert.match(result, /Prefs:/, "resto do status continua presente apesar do digest omitido");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forge-command formatStatus — loose tasks (S03/T05)", () => {
  function writeLooseTask(
    dir: string,
    id: string,
    opts: { plan?: boolean; summary?: boolean; review?: boolean } = {},
  ): void {
    const taskDir = join(dir, ".gsd", "tasks", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, `${id}-TASK.md`), `# ${id}\n`);
    if (opts.plan) writeFileSync(join(taskDir, `${id}-PLAN.md`), "plan\n");
    if (opts.summary) writeFileSync(join(taskDir, `${id}-SUMMARY.md`), "summary\n");
    if (opts.review) writeFileSync(join(taskDir, `${id}-REVIEW.md`), "review\n");
  }

  function taskResultEvent(
    id: string,
    status: string,
    unit: "task-plan" | "task-execute" = "task-execute",
  ): ForgeEvent {
    return {
      ts: new Date().toISOString(),
      kind: "task_result",
      unit,
      agent: "forge-command",
      milestone: "",
      task: id,
      status,
      summary: `[${id}] fake result`,
    };
  }

  test("sem .gsd/tasks/ (ou sem entradas) — saída idêntica à anterior", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-loose-"));
    try {
      const before = formatStatus(dir);
      mkdirSync(join(dir, ".gsd", "tasks"), { recursive: true }); // dir exists, empty
      const after = formatStatus(dir);
      assert.equal(after, before, "an empty .gsd/tasks/ dir must not change the output at all");
      assert.doesNotMatch(after, /Tasks soltas/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lista até 5 tasks, mais recentes primeiro, com overflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-loose-"));
    try {
      const ids = [
        "T-20260701000000-a",
        "T-20260702000000-b",
        "T-20260703000000-c",
        "T-20260704000000-d",
        "T-20260705000000-e",
        "T-20260706000000-f",
      ];
      for (const id of ids) writeLooseTask(dir, id, { plan: true });

      const result = formatStatus(dir);
      assert.match(result, /Tasks soltas:/);
      for (const id of ids.slice(1)) assert.match(result, new RegExp(id));
      assert.doesNotMatch(result, /T-20260701000000-a/, "oldest task collapses into the overflow line");
      assert.match(result, /… \(\+1\)/);

      const idxF = result.indexOf("T-20260706000000-f");
      const idxB = result.indexOf("T-20260702000000-b");
      assert.ok(idxF > -1 && idxB > -1 && idxF < idxB, "most recent task listed first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("estágio deriva dos artefatos do store: criada/planejada/executada/revisada", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-loose-"));
    try {
      writeLooseTask(dir, "T-20260701000001-criada");
      writeLooseTask(dir, "T-20260701000002-planejada", { plan: true });
      writeLooseTask(dir, "T-20260701000003-executada", { plan: true, summary: true });
      writeLooseTask(dir, "T-20260701000004-revisada", { plan: true, summary: true, review: true });

      const result = formatStatus(dir);
      assert.match(result, /T-20260701000001-criada — criada/);
      assert.match(result, /T-20260701000002-planejada — planejada/);
      assert.match(result, /T-20260701000003-executada — executada/);
      assert.match(result, /T-20260701000004-revisada — revisada/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("último task_result do journal é anexado à linha da task (ícone ✓ em revisada+done)", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-loose-"));
    try {
      const id = "T-20260701000005-com-journal";
      writeLooseTask(dir, id, { plan: true, summary: true, review: true });
      appendEvent(dir, taskResultEvent(id, "partial", "task-execute"));
      appendEvent(dir, taskResultEvent(id, "done", "task-execute")); // last one wins

      const result = formatStatus(dir);
      assert.match(result, /último resultado: done \(task-execute\)/);
      assert.match(result, new RegExp(`✓ ${id}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("último resultado partial/blocked usa o ícone ⚠", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-loose-"));
    try {
      const id = "T-20260701000006-blocked";
      writeLooseTask(dir, id, { plan: true, summary: true });
      appendEvent(dir, taskResultEvent(id, "blocked", "task-execute"));

      const result = formatStatus(dir);
      assert.match(result, /último resultado: blocked \(task-execute\)/);
      assert.match(result, new RegExp(`⚠ ${id}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("journal ilegível (readEvents lança) é tolerado — status não lança, resto do output continua presente", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-loose-"));
    try {
      const id = "T-20260701000007-journal-ruim";
      writeLooseTask(dir, id, { plan: true });
      // events.jsonl as a DIRECTORY forces a non-ENOENT readFileSync error,
      // exercising readEvents' throw path (not just its tolerant bad-line skip).
      mkdirSync(join(dir, ".gsd", "forge", "events.jsonl"), { recursive: true });

      let result = "";
      assert.doesNotThrow(() => {
        result = formatStatus(dir);
      });
      assert.match(result, /Tasks soltas:/);
      assert.match(result, new RegExp(id));
      assert.match(result, /Prefs:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sem .gsd/STATE.md — tasks soltas ainda aparecem (repo-level, não milestone-bound)", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-loose-"));
    try {
      const id = "T-20260701000008-sem-state";
      writeLooseTask(dir, id, { plan: true });

      const result = formatStatus(dir);
      assert.match(result, /Nenhum estado forge/);
      assert.match(result, /Tasks soltas:/);
      assert.match(result, new RegExp(id));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forge-command formatStatus — última conversa (S06/T01)", () => {
  test("com .gsd/CONVERSAS.md válido, exibe a linha da última entrada", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-conversas-"));
    try {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(
        join(dir, ".gsd", "CONVERSAS.md"),
        "## 2026-07-13 — Memória local do Forge\n<!-- sessao: session-a -->\n- Decisões: manter no disco\n",
      );
      const result = formatStatus(dir);
      assert.match(result, /Última conversa: 2026-07-13 — Memória local do Forge/);
      assert.doesNotMatch(result, /sessao:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sem .gsd/CONVERSAS.md, a saída permanece byte-idêntica à de antes do arquivo existir", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-conversas-"));
    try {
      const before = formatStatus(dir);
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "CONVERSAS.md"), "");
      const withEmptyFile = formatStatus(dir);
      assert.equal(withEmptyFile, before, "an empty CONVERSAS.md must not change the output at all");
      assert.doesNotMatch(withEmptyFile, /Última conversa/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("com .gsd/STATE.md ativo e CONVERSAS.md válido, o ramo com milestone também exibe a linha", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-status-conversas-"));
    try {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "STATE.md"), "```yaml\nphase: S01\n```\n");
      writeFileSync(
        join(dir, ".gsd", "CONVERSAS.md"),
        "## 2026-07-13 — Gate da conversa\n<!-- sessao: session-b -->\n- Pendências: revisar\n",
      );
      const result = formatStatus(dir);
      assert.match(result, /Última conversa: 2026-07-13 — Gate da conversa/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forge-command /forge auto|next (T05 real wiring)", () => {
  function fakeCtx(cwd: string): { ctx: ExtensionCommandContext; notifications: Array<[string, string]> } {
    const notifications: Array<[string, string]> = [];
    const ctx = {
      cwd,
      ui: {
        notify: (message: string, level: string) => {
          notifications.push([message, level]);
        },
      },
      // newSession must never be reachable in these unit tests — the loop
      // entry is injected as a fake, so hitting the real newSession would be
      // a wiring bug, not the loop being exercised.
      newSession: async () => {
        throw new Error("newSession must not be called — loopRunner is injected in unit tests");
      },
    } as unknown as ExtensionCommandContext;
    return { ctx, notifications };
  }

  function writeActiveMilestone(dir: string): void {
    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(
      join(dir, ".gsd", "STATE.md"),
      "```yaml\nmilestone: M-toy\nunits: []\n```\n",
    );
  }

  test("pré-condição: sem .gsd/STATE.md notifica e não roda o loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-"));
    try {
      const { ctx, notifications } = fakeCtx(dir);
      const session = new ForgeAutoSession();
      let loopCalled = false;
      await runAuto(ctx, { once: false }, session, async () => {
        loopCalled = true;
        return { reason: "complete" };
      });
      assert.equal(loopCalled, false);
      assert.equal(session.active, false);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.[1], "warning");
      assert.match(notifications[0]?.[0] ?? "", /STATE\.md não encontrado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pré-condição: STATE.md sem milestone ativo notifica e não roda o loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-"));
    try {
      mkdirSync(join(dir, ".gsd"), { recursive: true });
      writeFileSync(join(dir, ".gsd", "STATE.md"), "```yaml\nmilestone: \"\"\nunits: []\n```\n");
      const { ctx, notifications } = fakeCtx(dir);
      const session = new ForgeAutoSession();
      let loopCalled = false;
      await runAuto(ctx, { once: false }, session, async () => {
        loopCalled = true;
        return { reason: "complete" };
      });
      assert.equal(loopCalled, false);
      assert.equal(session.active, false);
      assert.match(notifications[0]?.[0] ?? "", /milestone ativo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/forge auto (once=false) bootstrapa o container e chama o loop com once:false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-"));
    try {
      writeActiveMilestone(dir);
      const { ctx } = fakeCtx(dir);
      const session = new ForgeAutoSession();
      let capturedOpts: { once?: boolean } | undefined;
      let capturedCwd: string | undefined;
      let capturedActiveDuringRun: boolean | undefined;
      await runAuto(ctx, { once: false }, session, async (s, deps, opts) => {
        capturedOpts = opts;
        capturedCwd = deps.cwd;
        capturedActiveDuringRun = s.active;
        return { reason: "complete" };
      });
      assert.equal(capturedActiveDuringRun, true);
      assert.deepEqual(capturedOpts, { once: false });
      assert.equal(capturedCwd, dir);
      // reset() in finally — never left active after the loop returns.
      assert.equal(session.active, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/forge next (once=true) chama o loop com once:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-"));
    try {
      writeActiveMilestone(dir);
      const { ctx } = fakeCtx(dir);
      const session = new ForgeAutoSession();
      let capturedOpts: { once?: boolean } | undefined;
      await runAuto(ctx, { once: true }, session, async (_s, _deps, opts) => {
        capturedOpts = opts;
        return { reason: "complete" };
      });
      assert.deepEqual(capturedOpts, { once: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("guard de reentrância: session.active=true notifica e não roda um segundo loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-"));
    try {
      writeActiveMilestone(dir);
      const { ctx, notifications } = fakeCtx(dir);
      const session = new ForgeAutoSession();
      session.active = true; // simulate an already-running loop
      let loopCalled = false;
      await runAuto(ctx, { once: false }, session, async () => {
        loopCalled = true;
        return { reason: "complete" };
      });
      assert.equal(loopCalled, false);
      assert.match(notifications[0]?.[0] ?? "", /loop já ativo/);
      assert.equal(notifications[0]?.[1], "warning");
      // guard does not clobber the already-active session
      assert.equal(session.active, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("R2: após o loop, restaura tools e model (baseline) via livePi", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-"));
    try {
      writeActiveMilestone(dir);
      const baselineTools = ["read", "bash", "edit", "write", "find", "grep", "ls"];
      const baselineModel = { provider: "anthropic", id: "opus-baseline" };
      const setActiveToolsCalls: string[][] = [];
      const setModelCalls: unknown[] = [];
      const livePi = {
        setActiveTools: (names: string[]) => setActiveToolsCalls.push(names),
        setModel: async (m: unknown) => {
          setModelCalls.push(m);
          return true;
        },
      };

      const { ctx } = fakeCtx(dir);
      // The interactive session's model captured pre-loop.
      (ctx as unknown as { model: unknown }).model = baselineModel;

      const session = new ForgeAutoSession();
      // Simulate the session_start hook having narrowed tools + applied a per-unit
      // model during the run: it republishes livePi, captures defaultActiveTools,
      // and flags modelApplied.
      await runAuto(ctx, { once: false }, session, async (s) => {
        s.livePi = livePi as never;
        s.defaultActiveTools = baselineTools;
        s.modelApplied = true;
        return { reason: "complete" };
      });

      assert.deepEqual(
        setActiveToolsCalls,
        [baselineTools],
        "tools restored exactly once to the pre-loop baseline",
      );
      assert.deepEqual(setModelCalls, [baselineModel], "model restored to the pre-loop baseline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("R2: sem dispatch (livePi nunca setado) não tenta restaurar nada", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-"));
    try {
      writeActiveMilestone(dir);
      const { ctx } = fakeCtx(dir);
      const session = new ForgeAutoSession();
      // Loop never dispatched → livePi stays null → restore is a no-op, no throw.
      await runAuto(ctx, { once: false }, session, async () => {
        /* no dispatch */
        return { reason: "complete" };
      });
      assert.equal(session.active, false);
      assert.equal(session.livePi, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reset() roda em finally mesmo quando o loop lança", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-"));
    try {
      writeActiveMilestone(dir);
      const { ctx } = fakeCtx(dir);
      const session = new ForgeAutoSession();
      await assert.rejects(
        runAuto(ctx, { once: false }, session, async () => {
          throw new Error("boom");
        }),
        /boom/,
      );
      assert.equal(session.active, false);
      assert.equal(session.cmdCtx, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forge-command /forge auto — E2E-4 exit code (print/headless vs interactive)", () => {
  // The exit code is process-global state; save/restore so a set exitCode never
  // leaks into sibling tests (which would fail the whole run with a non-zero
  // code even when every assertion passed).
  const savedExitCode = process.exitCode;
  const savedHeadless = process.env.GSD_HEADLESS;
  afterEach(() => {
    process.exitCode = savedExitCode;
    if (savedHeadless === undefined) delete process.env.GSD_HEADLESS;
    else process.env.GSD_HEADLESS = savedHeadless;
  });

  function ctxFor(cwd: string, opts: { hasUI: boolean; uiMode?: string }): ExtensionCommandContext {
    return {
      cwd,
      hasUI: opts.hasUI,
      ui: {
        mode: opts.uiMode,
        notify: () => {},
      },
      newSession: async () => {
        throw new Error("newSession must not be called — loopRunner is injected");
      },
    } as unknown as ExtensionCommandContext;
  }

  function writeActiveMilestone(dir: string): void {
    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "STATE.md"), "```yaml\nmilestone: M-toy\nunits: []\n```\n");
  }

  test("print/headless (no hasUI) + terminal blocked → process.exitCode ≠ 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-exit-"));
    try {
      writeActiveMilestone(dir);
      process.exitCode = 0;
      const ctx = ctxFor(dir, { hasUI: false });
      const session = new ForgeAutoSession();
      await runAuto(ctx, { once: false }, session, async () => ({ reason: "blocked" }));
      assert.equal(process.exitCode, 3, "blocked in headless sets a non-zero exit code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("print/headless + terminal paused (retry esgotado) → process.exitCode ≠ 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-exit-"));
    try {
      writeActiveMilestone(dir);
      process.exitCode = 0;
      const ctx = ctxFor(dir, { hasUI: true, uiMode: "headless" });
      const session = new ForgeAutoSession();
      await runAuto(ctx, { once: false }, session, async () => ({ reason: "paused" }));
      assert.notEqual(process.exitCode, 0, "paused in headless surfaces a non-zero exit code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("print/headless + terminal complete → exitCode inalterado (0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-exit-"));
    try {
      writeActiveMilestone(dir);
      process.exitCode = 0;
      const ctx = ctxFor(dir, { hasUI: false });
      const session = new ForgeAutoSession();
      await runAuto(ctx, { once: false }, session, async () => ({ reason: "complete" }));
      assert.equal(process.exitCode, 0, "a complete run leaves the exit code at 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("interativo (hasUI, sem rpc/headless) + terminal blocked → NÃO força exit ≠ 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-exit-"));
    try {
      writeActiveMilestone(dir);
      // The interactive TUI treats a pause as a normal flow — no forced exit code.
      delete process.env.GSD_HEADLESS;
      process.exitCode = 0;
      const ctx = ctxFor(dir, { hasUI: true });
      const session = new ForgeAutoSession();
      await runAuto(ctx, { once: false }, session, async () => ({ reason: "blocked" }));
      assert.equal(process.exitCode, 0, "interactive pause does not force a non-zero exit code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GSD_HEADLESS=1 força print-mode mesmo com hasUI → blocked seta exit ≠ 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-auto-exit-"));
    try {
      writeActiveMilestone(dir);
      process.env.GSD_HEADLESS = "1";
      process.exitCode = 0;
      const ctx = ctxFor(dir, { hasUI: true });
      const session = new ForgeAutoSession();
      await runAuto(ctx, { once: false }, session, async () => ({ reason: "blocked" }));
      assert.equal(process.exitCode, 3, "GSD_HEADLESS=1 forces the headless exit-code path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
