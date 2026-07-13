/**
 * M-20260711135806-wiring-multi-llm / S03 / T03 — through-the-driver proof
 * of ROADMAP §Demos S03: duas contas configuradas para o mesmo provider; a
 * conta 0 recebe um 429 num dispatch real; o dispatch seguinte usa a conta 1
 * (não repete a 0).
 *
 * **Nota de honestidade (PROIBIDO SILENCIAR — S03-PLAN, T03-PLAN §Steps 2):**
 *
 * (i) Este teste dirige `dispatchUnitViaNewSession` REAL (o mesmo `cmdCtx`
 * fake com `newSession` invocando `withSession(freshCtx)` que
 * `driver.test.ts`/`reviewer-not-author-e2e.test.ts` usam), NÃO o fake driver
 * scriptado de `runForgeLoop`. O fake driver de `loop.ts` curto-circuita a
 * seleção de credencial e o `message_end` — eles vivem inteiramente dentro do
 * bloco de resolução de `dispatchUnitViaNewSession` e do hook `message_end`
 * da instância fresh, nenhum dos dois no caminho do fake driver. Só o
 * dispatch real exercita o threading de T01.
 *
 * (ii) O 429 é simulado disparando o handler REAL de `message_end` de T02
 * (`registerCredentialExhaustion`, importado — não mirrorado — de
 * `bootstrap/register-extension.ts`), com um `pi` fake que expõe só
 * `.on("message_end", …)` (a única superfície que o hook usa), NÃO chamando
 * `rotator.markExhausted` à mão. Isso prova a via de produção ponta-a-ponta:
 * o mesmo `s.selectedCredential`/`s.credentialRotator` que o dispatch #1
 * publicou (T01) são os que o hook lê (T02).
 *
 * (iii) A lista de credenciais NÃO é reordenada entre `selectCredential` e
 * `markExhausted` em nenhum momento deste teste — o `fakeAuthStorage` devolve
 * sempre o mesmo array `[credA, credB]`. O hazard de reordenação (índice vs.
 * identidade da credencial, achado #4 do review) é o cenário de S04
 * (`S04 depends: [S03]`), fora de escopo aqui — declarado, não silenciado.
 *
 * (iv) Nenhuma credencial real openai/claude é lida: as duas contas são
 * `AuthCredential` sintéticas (`apiKey("fake-…")`) sobre um `CredentialSource`
 * fake — nunca uma `AuthStorage` real, nunca uma chamada de rede (o
 * `cmdCtx.newSession` fake falha rápido dentro de `sendMessage`, mesmo atalho
 * de "fast-pause" que `driver.test.ts`/`reviewer-not-author-e2e.test.ts` já
 * usam para assentar o dispatch sem uma rendezvous real).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { dispatchUnitViaNewSession } from "../auto/driver.ts";
import { ForgeAutoSession, getForgeAutoSession } from "../auto/session.ts";
import type { NextUnit } from "../state/index.ts";
import { registerCredentialExhaustion } from "../bootstrap/register-extension.ts";
import { CredentialRotator, providerAvailabilityProbe, type CredentialSource } from "@forge/agent-core/credential-rotation.js";

/** Mirrors `driver.test.ts`/`credential-rotation-e2e.test.ts` — synthetic-only, never a real key. */
function apiKey(key: string) {
  return { type: "api_key" as const, key };
}

function fakeAuthStorage(data: Record<string, ReturnType<typeof apiKey>[]>): CredentialSource {
  return {
    getCredentialsForProvider: (provider: string) => data[provider] ?? [],
  };
}

/** Fast-settling fake `cmdCtx` — same shape as `driver.test.ts`'s `fakeCmdCtx`: a
 *  `sendMessage` that throws settles the dispatch synchronously, no real
 *  rendezvous delivery needed — the resolution block under test runs
 *  regardless of how the dispatch itself concludes. */
function fakeCmdCtx() {
  const freshCtx = {
    abort() {},
    async sendMessage(): Promise<void> {
      throw new Error("boom: worker turn failed inside sendMessage");
    },
  };
  return {
    abort() {},
    model: undefined,
    async newSession(opts: { withSession: (ctx: unknown) => Promise<void> }): Promise<{ cancelled: boolean }> {
      let failure: { error: unknown } | undefined;
      try {
        await opts.withSession(freshCtx);
      } catch (error) {
        failure = { error };
      }
      if (failure) throw failure.error;
      return { cancelled: false };
    },
  };
}

/** `.gsd/models.md` routing `executor` to a single-ref `openai` pool (`driver.test.ts`'s
 *  `writeExecutorRoutesToOpenaiConfig` shape) — the pool ref wins over the Claude
 *  baseline, so the rotator's `openai` provider is the one under test. */
function writeExecutorRoutesToOpenaiConfig(cwd: string): void {
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "models.md"),
    "pools:\n  primary:\n    - openai/gpt-5.5\n\nroles:\n  executor:\n    - primary\n",
  );
}

/** Minimal fake `pi` — only `.on("message_end", handler)`, the sole surface
 *  `registerCredentialExhaustion` calls — plus a test-only `fire()`. Mirrors
 *  `register-extension.test.ts`'s `makeFakePi` (T02's own harness). */
interface FakePi {
  on(event: "message_end", handler: (event: { message: unknown }, ctx: unknown) => void): void;
  fire(message: unknown): void;
}

function makeFakePi(): FakePi {
  let handler: ((event: { message: unknown }, ctx: unknown) => void) | null = null;
  return {
    on(_event, h) {
      handler = h;
    },
    fire(message) {
      handler?.({ message }, {});
    },
  };
}

/** A real 429, exactly as the fake provider emits it (`pi-ai/src/providers/fake.ts:228-249`):
 *  an `AssistantMessage` with `stopReason:"error"` + `errorMessage` + `retryAfterMs`, delivered
 *  via `message_end` — never a `newSession` rejection. */
function rateLimitAssistantMessage(): unknown {
  return { role: "assistant", stopReason: "error", errorMessage: "rate_limit_exceeded", retryAfterMs: 30_000 };
}

describe("driver + T02 hook, through-the-driver: 429 na conta 0 rotaciona para a conta 1 (S03/T03)", () => {
  test("cenário literal ROADMAP §Demos S03: dispatch #1 seleciona a conta 0; 429 via handler REAL de T02 coloca a conta 0 em cooldown; dispatch #2 seleciona a conta 1", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-credential-rotation-driver-e2e-"));
    try {
      writeExecutorRoutesToOpenaiConfig(cwd);

      const credA = apiKey("fake-openai-A");
      const credB = apiKey("fake-openai-B");
      const rotator = new CredentialRotator(fakeAuthStorage({ openai: [credA, credB] }));

      // T02's hook reads `getForgeAutoSession()` (the module-level singleton) —
      // so the session under test must BE that singleton, reset in place
      // (mirrors `register-extension.test.ts`'s isolation pattern), not a
      // separately-constructed `new ForgeAutoSession()` the hook would never see.
      const s = getForgeAutoSession();
      Object.assign(s, new ForgeAutoSession());
      s.cwd = cwd;
      s.active = true;
      s.credentialRotator = rotator;
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = fakeCmdCtx() as any;

      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };

      // ── Dispatch #1: conta 0 selecionada ────────────────────────────────
      await dispatchUnitViaNewSession(s, unit, "prompt");
      assert.deepEqual(
        s.selectedCredential,
        { provider: "openai", index: 0, identity: "fake-openai-A", token: s.currentRendezvousToken! },
        "dispatch #1: nada esgotado ainda -> a conta 0 (índice 0) é a selecionada",
      );

      // ── 429 via handler REAL de T02 (não markExhausted à mão) ───────────
      const pi = makeFakePi();
      registerCredentialExhaustion(pi as unknown as ExtensionAPI);
      pi.fire(rateLimitAssistantMessage());

      const nowMs = Date.now();
      assert.equal(
        rotator.allExhausted("openai", nowMs),
        false,
        "a conta 1 continua disponível -> o provider NÃO está totalmente esgotado",
      );
      const probe = providerAvailabilityProbe(rotator, nowMs);
      assert.equal(
        probe("openai/gpt-5.5"),
        true,
        "com a conta 1 disponível, o probe injetado no seam reporta o provider disponível " +
          "(se a conta 0 fosse a ÚNICA conta, allExhausted seria true e o probe reportaria false — " +
          "exercido isoladamente em driver.test.ts's rotator-exhausted-degrades case)",
      );
      const postExhaustionSelect = rotator.selectCredential("openai", nowMs);
      assert.equal(
        postExhaustionSelect?.index,
        1,
        "a conta 0 entrou em cooldown pela via de produção (T02) -> a próxima seleção pula a 0 e devolve a 1",
      );

      // ── Dispatch #2: a seleção ROTACIONOU para a conta 1 ────────────────
      await dispatchUnitViaNewSession(s, unit, "prompt");
      assert.deepEqual(
        s.selectedCredential,
        { provider: "openai", index: 1, identity: "fake-openai-B", token: s.currentRendezvousToken! },
        "dispatch #2: a conta 0 está em cooldown -> a conta 1 é selecionada; a conta 0 NÃO é repetida",
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
