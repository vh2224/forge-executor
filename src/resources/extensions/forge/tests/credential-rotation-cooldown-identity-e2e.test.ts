/**
 * M-20260711135806-wiring-multi-llm / S04 / T03 — through-the-driver proof
 * of ROADMAP §Demos S04: selecionar índice 0=A, reordenar a lista de
 * credenciais para `[B,A]` ENTRE a seleção do dispatch #1 e o 429, disparar o
 * 429 pelo hook real de T02, e re-selecionar: **A** (a credencial que de fato
 * rodou e recebeu o 429) fica em cooldown; **B** permanece elegível — a
 * identidade certa esfria, não a posição no array.
 *
 * Este teste é a materialização literal do §(iii) de
 * `credential-rotation-driver-e2e.test.ts` (S03/T03), que declarou a
 * reordenação como fora de escopo "cenário de S04". O scaffold abaixo
 * (fake `cmdCtx`, `fakeAuthStorage`, singleton real `ForgeAutoSession`,
 * disparo do hook real) é copiado literalmente daquele arquivo — só o array
 * de credenciais vira MUTÁVEL para permitir o reorder no meio do teste.
 *
 * **Nota de honestidade (PROIBIDO SILENCIAR — T03-PLAN §Steps 5):**
 *
 * (i) Este teste dirige `dispatchUnitViaNewSession` REAL duas vezes sobre a
 * singleton `ForgeAutoSession` real (o mesmo `cmdCtx` fake que
 * `driver.test.ts`/`credential-rotation-driver-e2e.test.ts` usam), NÃO o fake
 * driver scriptado de `runForgeLoop`. Só o dispatch real exercita o threading
 * de T01/T02 (`selectedCredential`, `credentialRotator`).
 *
 * (ii) O 429 é simulado disparando o handler REAL `registerCredentialExhaustion`
 * (importado — não mirrorado — de `bootstrap/register-extension.ts`), com um
 * `pi` fake que expõe só `.on("message_end", …)` — NÃO chamando
 * `rotator.markExhausted` à mão. O hook lê `s.selectedCredential.identity`
 * (T02) — a identidade publicada pelo dispatch #1 — nunca o índice.
 *
 * (iii) A lista de credenciais É REORDENADA de propósito, entre a seleção do
 * dispatch #1 e o disparo do 429: `data.openai` passa de `[credA, credB]`
 * para `[credB, credA]`. Este é exatamente o cenário que S03/T03 declarou
 * fora de escopo e que S04 fecha — a prova central deste arquivo.
 *
 * (iv) Nenhuma credencial real openai/claude é lida: as duas contas são
 * `AuthCredential` sintéticas (`apiKey("fake-…")`) sobre um `CredentialSource`
 * fake — nunca uma `AuthStorage` real, nunca uma chamada de rede.
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
import { CredentialRotator, type CredentialSource } from "@forge/agent-core/credential-rotation.js";

/** Mirrors `credential-rotation-driver-e2e.test.ts` — synthetic-only, never a real key. */
function apiKey(key: string) {
  return { type: "api_key" as const, key };
}

/** Reads `data[provider]` on every call — a MUTABLE object (not a captured
 *  array) so the test can reorder the underlying list in place between the
 *  dispatch #1 selection and the 429, without swapping out the rotator or
 *  the fake source itself. */
function fakeAuthStorage(data: Record<string, ReturnType<typeof apiKey>[]>): CredentialSource {
  return {
    getCredentialsForProvider: (provider: string) => data[provider] ?? [],
  };
}

/** Fast-settling fake `cmdCtx` — same shape as `credential-rotation-driver-e2e.test.ts`'s
 *  `fakeCmdCtx`: a `sendMessage` that throws settles the dispatch synchronously, no real
 *  rendezvous delivery needed. */
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

/** `.gsd/models.md` routing `executor` to a single-ref `openai` pool — mirrors
 *  `credential-rotation-driver-e2e.test.ts`'s `writeExecutorRoutesToOpenaiConfig`. */
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

describe("driver + T02 hook, through-the-driver: reorder entre select e 429 cola no ID, não no índice (S04/T03)", () => {
  test("cenário literal ROADMAP §Demos S04: seleciona A no índice 0; lista reordena para [B,A]; 429 via handler REAL esfria A por identidade; re-seleção pega B", async () => {
    const prevTimeout = process.env.FORGE_UNIT_TIMEOUT_MS;
    process.env.FORGE_UNIT_TIMEOUT_MS = "30000";
    const cwd = mkdtempSync(join(tmpdir(), "forge-credential-rotation-cooldown-identity-e2e-"));
    try {
      writeExecutorRoutesToOpenaiConfig(cwd);

      const credA = apiKey("fake-openai-A");
      const credB = apiKey("fake-openai-B");
      // Mutable in place (same object the rotator's `CredentialSource` reads
      // on every call) — reordered below between the dispatch #1 selection
      // and the 429, without swapping out the rotator or the fake source.
      const data: Record<string, ReturnType<typeof apiKey>[]> = { openai: [credA, credB] };
      const rotator = new CredentialRotator(fakeAuthStorage(data));

      // T02's hook reads `getForgeAutoSession()` (the module-level singleton) —
      // so the session under test must BE that singleton, reset in place
      // (mirrors `credential-rotation-driver-e2e.test.ts`'s isolation pattern).
      const s = getForgeAutoSession();
      Object.assign(s, new ForgeAutoSession());
      s.cwd = cwd;
      s.active = true;
      s.credentialRotator = rotator;
      s.baselineModel = { id: "claude-code/claude-opus-4-8", provider: "claude-code" } as never;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.cmdCtx = fakeCmdCtx() as any;

      const unit: NextUnit = { type: "execute-task", slice: "S01", task: "T01" };

      // ── Dispatch #1: índice 0 -> credA é selecionada ────────────────────
      await dispatchUnitViaNewSession(s, unit, "prompt");
      assert.deepEqual(
        s.selectedCredential,
        { provider: "openai", index: 0, identity: "fake-openai-A", token: s.currentRendezvousToken! },
        "dispatch #1: nada esgotado ainda -> a credencial no índice 0 (A) é a selecionada",
      );

      // ── Reorder ANTES do 429: [A,B] -> [B,A] ────────────────────────────
      // A demo de S04. O índice 0 agora aponta para credB, NÃO para a
      // credencial que de fato rodou o dispatch #1 e vai receber o 429 (A).
      data.openai = [credB, credA];

      // Companion assertion (honesty note (iii)): sob a lógica PRÉ-S04
      // (cooldown por índice — `credential-cooldown.ts` antes de T01, que
      // fazia `markExhausted(provider, index)` com `index = s.selectedCredential.index`),
      // um `markExhausted("openai", 0, nowMs)` disparado aqui teria esfriado
      // a credencial que HOJE ocupa o índice 0 pós-reorder — que é B, não A.
      // A API pré-S04 nem compila mais (T01 trocou a assinatura para
      // identidade), então este teste não pode chamá-la; a asserção abaixo
      // torna o fato explícito: o índice publicado pelo dispatch #1 (0) já
      // não corresponde à credencial que rodou (A) assim que o array reordena.
      assert.deepEqual(
        data.openai[s.selectedCredential!.index],
        credB,
        "pós-reorder, o índice publicado pelo dispatch #1 (0) agora aponta para B, não para A " +
          "-> um cooldown por ÍNDICE teria esfriado a conta errada (B) e deixado a exaurida (A) elegível",
      );

      // ── 429 via handler REAL de T02 (não markExhausted à mão) ───────────
      const pi = makeFakePi();
      registerCredentialExhaustion(pi as unknown as ExtensionAPI);
      pi.fire(rateLimitAssistantMessage());

      const nowMs = Date.now();
      assert.equal(
        rotator.allExhausted("openai", nowMs),
        false,
        "credB nunca esgotou -> o provider NÃO está totalmente esgotado",
      );
      const postExhaustionSelect = rotator.selectCredential("openai", nowMs);
      assert.equal(
        postExhaustionSelect?.identity,
        "fake-openai-B",
        "o hook esfriou credA POR IDENTIDADE (a que de fato recebeu o 429), mesmo reordenada " +
          "para o índice 1 -> a próxima seleção pula A e devolve B",
      );

      // ── Dispatch #2: a seleção pega B por identidade, não por posição ──
      await dispatchUnitViaNewSession(s, unit, "prompt");
      assert.deepEqual(
        s.selectedCredential,
        { provider: "openai", index: 0, identity: "fake-openai-B", token: s.currentRendezvousToken! },
        "dispatch #2: A está em cooldown por identidade (apesar de ter migrado para o índice 1) " +
          "-> B (agora no índice 0) é selecionada; a mesma posição de array (0) que antes apontava " +
          "para A agora aponta para B, provando que a identidade — não a posição — é a chave do cooldown",
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.FORGE_UNIT_TIMEOUT_MS;
      else process.env.FORGE_UNIT_TIMEOUT_MS = prevTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
