/**
 * S05/T03 product proof. The hook sees a real, persisted SessionManager; only
 * the one-shot LLM seam is fake so this remains deterministic and offline.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { SessionManager } from "../../../../../packages/pi-coding-agent/src/core/session-manager.ts";
import { registerConversas, type DistillLlmCall } from "../conversas/register-conversas.ts";

const roots: string[] = [];
const VALID_ENTRIES = [
  "## 2026-07-13 — Memória local do Forge\n- Decisões: manter conversas no disco local\n- Pendências: consumir a última entrada no status",
  "## 2026-07-13 — Gate da conversa\n- Decisões: preservar o append-only\n- Pendências: revisar a apresentação",
];

type ShutdownHandler = (event: { reason: string }, ctx: Record<string, unknown>) => Promise<void>;

function sandbox(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-conversas-e2e-"));
  roots.push(cwd);
  mkdirSync(join(cwd, ".gsd"));
  return cwd;
}

function fakePi(): { pi: ExtensionAPI; shutdown: (ctx: Record<string, unknown>) => Promise<void> } {
  let handler: ShutdownHandler | undefined;
  return {
    pi: { on: (_event: "session_shutdown", callback: ShutdownHandler) => { handler = callback; } } as unknown as ExtensionAPI,
    async shutdown(ctx) { await handler?.({ reason: "quit" }, ctx); },
  };
}

function appendOperatorConversation(manager: SessionManager, subject: string): void {
  for (const [role, text] of [
    ["user", `Precisamos decidir ${subject}.`],
    ["assistant", "Vamos manter a decisão explícita no projeto."],
    ["user", "Concordo que o artefato deve ser local."],
    ["assistant", "A decisão ficará documentada."],
    ["user", "A pendência é validar o formato final."],
  ] as const) {
    manager.appendMessage({ role, content: [{ type: "text", text }], timestamp: Date.now() } as never);
  }
}

function shutdownContext(cwd: string, manager: SessionManager): Record<string, unknown> {
  return {
    cwd,
    model: {} as never,
    modelRegistry: { getApiKey: async () => "unused-by-fake" },
    sessionManager: manager,
  };
}

function createSession(cwd: string, name: string): SessionManager {
  return SessionManager.create(cwd, join(cwd, "sessions", name));
}

function conversationEntries(content: string): string[] {
  return content.split(/^## /m).filter((entry) => entry.trim().length > 0).map((entry) => `## ${entry}`.trim());
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("S05/T03 CONVERSAS.md product proof with persisted SessionManager", () => {
  test("operator, worker, dedupe, append order, and S06 heading contract", async () => {
    const cwd = sandbox();
    let llmCalls = 0;
    const llmCall: DistillLlmCall = async () => VALID_ENTRIES[llmCalls++] ?? "SKIP";
    const hook = fakePi();
    registerConversas(hook.pi, { llmCall, timeoutMs: 100 });

    const operator = createSession(cwd, "operator");
    appendOperatorConversation(operator, "a memória conversacional");
    const firstSessionId = operator.getSessionId();
    const firstSessionFile = operator.getSessionFile();
    assert.ok(firstSessionFile && existsSync(firstSessionFile), "real SessionManager persisted the operator fixture");

    await hook.shutdown(shutdownContext(cwd, operator));
    const conversasPath = join(cwd, ".gsd", "CONVERSAS.md");
    const firstContent = readFileSync(conversasPath, "utf8");
    const firstEntry = conversationEntries(firstContent);
    assert.equal(firstEntry.length, 1);
    assert.match(firstEntry[0], /^## 2026-07-13 — Memória local do Forge/);
    assert.match(firstEntry[0], new RegExp(`<!-- sessao: ${firstSessionId} -->`));
    assert.ok(firstEntry[0].split("\n").length <= 10, "stored entry, including its marker, stays compact");

    const worker = createSession(cwd, "worker");
    worker.appendCustomMessageEntry("forge-dispatch", "# Unit: execute-task", false);
    appendOperatorConversation(worker, "um trabalho de worker");
    await hook.shutdown(shutdownContext(cwd, worker));
    assert.equal(readFileSync(conversasPath, "utf8"), firstContent, "real forge-dispatch custom entry suppresses a worker slice");

    await hook.shutdown(shutdownContext(cwd, operator));
    assert.equal(readFileSync(conversasPath, "utf8"), firstContent, "the same real session is deduplicated before another completion");

    const second = createSession(cwd, "second-operator");
    appendOperatorConversation(second, "o gate de qualidade");
    const secondSessionId = second.getSessionId();
    await hook.shutdown(shutdownContext(cwd, second));
    const secondContent = readFileSync(conversasPath, "utf8");
    assert.ok(secondContent.startsWith(firstContent), "the first entry bytes remain intact under append-only writing");
    const entries = conversationEntries(secondContent);
    assert.equal(entries.length, 2, "distinct qualified sessions append distinct entries");
    assert.match(entries[1], new RegExp(`<!-- sessao: ${secondSessionId} -->`));
    // S06 consumes the final conversation by splitting level-two headings.
    assert.equal(`## ${secondContent.split(/^## /m).filter(Boolean).at(-1)?.trim()}`, entries[1]);
    assert.equal(llmCalls, 2, "worker and deduplicated shutdown never invoke the LLM seam");
  });

  test("a qualified real session whose distiller says SKIP does not create a file", async () => {
    const cwd = sandbox();
    const manager = createSession(cwd, "skip");
    appendOperatorConversation(manager, "um detalhe transitório");
    const hook = fakePi();
    registerConversas(hook.pi, { llmCall: async () => "SKIP" });

    await hook.shutdown(shutdownContext(cwd, manager));
    assert.equal(existsSync(join(cwd, ".gsd", "CONVERSAS.md")), false);
  });

  test("locked invariant: loop modules never import conversational memory", () => {
    // CONVERSAS.md is human-only; auto/state/review must never derive loop state from it.
    const forgeRoot = join(process.cwd(), "src/resources/extensions/forge");
    for (const area of ["auto", "state", "review"]) {
      for (const file of sourceFiles(join(forgeRoot, area))) {
        assert.doesNotMatch(readFileSync(file, "utf8"), /(?:from|import)\s*[^\n]*conversas\//, file);
      }
    }
  });
});
