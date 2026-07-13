import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { ExtensionAPI, SessionEntry } from "@gsd/pi-coding-agent";
import { registerConversas, type DistillLlmCall } from "../conversas/register-conversas.ts";

const VALID_ENTRY = "## 2026-07-13 — Decisões do Forge\n- Decisões: manter o loop local\n- Pendências: revisar o gate";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function conversationEntries(): SessionEntry[] {
  return [
    { type: "message", message: { role: "user", content: "Precisamos decidir a estratégia de memória." } },
    { type: "message", message: { role: "assistant", content: "Podemos manter o artefato local." } },
    { type: "message", message: { role: "user", content: "Concordo, sem telemetria externa." } },
    { type: "message", message: { role: "assistant", content: "Registrarei a decisão." } },
    { type: "message", message: { role: "user", content: "Também fica pendente o gate de qualidade." } },
  ] as SessionEntry[];
}

function workerEntries(): SessionEntry[] {
  return [{ type: "custom_message", customType: "forge-dispatch", content: "hidden", display: false }, ...conversationEntries()] as SessionEntry[];
}

type ShutdownHandler = (event: { reason: string }, ctx: Record<string, unknown>) => Promise<void>;

function fakePi(): { pi: ExtensionAPI; fire: (reason: string, ctx: Record<string, unknown>) => Promise<void> } {
  let handler: ShutdownHandler | undefined;
  return {
    pi: {
      on(_event: "session_shutdown", registered: ShutdownHandler) {
        handler = registered;
      },
    } as unknown as ExtensionAPI,
    async fire(reason, ctx) {
      await handler?.({ reason }, ctx);
    },
  };
}

async function projectRoot(withGsd = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-conversas-"));
  roots.push(root);
  if (withGsd) await mkdir(join(root, ".gsd"));
  return root;
}

function context(cwd: string, entries = conversationEntries(), sessionId = "session-123"): Record<string, unknown> {
  return {
    cwd,
    model: {} as never,
    modelRegistry: { getApiKey: async () => "key" },
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => sessionId,
    },
  };
}

function registerFake(llmCall: DistillLlmCall, timeoutMs = 100): ReturnType<typeof fakePi> {
  const fake = fakePi();
  registerConversas(fake.pi, { llmCall, timeoutMs });
  return fake;
}

describe("registerConversas session_shutdown hook", () => {
  test("qualified shutdown completes once and append-preserves existing content", async () => {
    const cwd = await projectRoot();
    const file = join(cwd, ".gsd", "CONVERSAS.md");
    const existing = "# Conversas existentes\ntexto anterior\n";
    await writeFile(file, existing);
    let calls = 0;
    const fake = registerFake(async () => {
      calls += 1;
      return VALID_ENTRY;
    });

    await fake.fire("quit", context(cwd));
    const result = await readFile(file, "utf8");
    assert.equal(calls, 1);
    assert.ok(result.startsWith(existing), "prior bytes are untouched");
    assert.match(result, /## 2026-07-13 — Decisões do Forge/);
    assert.match(result, /<!-- sessao: session-123 -->/);
  });

  test("without an existing .gsd directory it skips without creating one", async () => {
    const cwd = await projectRoot(false);
    let calls = 0;
    const fake = registerFake(async () => {
      calls += 1;
      return VALID_ENTRY;
    });
    await fake.fire("quit", context(cwd));
    await assert.rejects(readFile(join(cwd, ".gsd", "CONVERSAS.md")));
    assert.equal(calls, 0);
  });

  test("deduped session skips completion and leaves content unchanged", async () => {
    const cwd = await projectRoot();
    const file = join(cwd, ".gsd", "CONVERSAS.md");
    const existing = "## 2026-07-12 — Já existe\n<!-- sessao: session-123 -->\n";
    await writeFile(file, existing);
    const fake = registerFake(async () => {
      throw new Error("must not call");
    });
    await fake.fire("quit", context(cwd));
    assert.equal(await readFile(file, "utf8"), existing);
  });

  test("worker, reload, and below-threshold sessions skip completion", async () => {
    const cwd = await projectRoot();
    let calls = 0;
    const fake = registerFake(async () => {
      calls += 1;
      return VALID_ENTRY;
    });
    await fake.fire("quit", context(cwd, workerEntries()));
    await fake.fire("reload", context(cwd));
    await fake.fire("quit", context(cwd, conversationEntries().slice(0, 3)));
    assert.equal(calls, 0);
    await assert.rejects(readFile(join(cwd, ".gsd", "CONVERSAS.md")));
  });

  test("SKIP and invalid model responses never write", async () => {
    const cwd = await projectRoot();
    const fake = registerFake(async () => "SKIP");
    await fake.fire("new", context(cwd));
    registerConversas(fake.pi, { llmCall: async () => Array.from({ length: 11 }, () => "x").join("\n") });
    await fake.fire("fork", context(cwd, conversationEntries(), "another-session"));
    await assert.rejects(readFile(join(cwd, ".gsd", "CONVERSAS.md")));
  });

  test("missing model, API key, and rejected completion are silent skips", async () => {
    const cwd = await projectRoot();
    const fake = registerFake(async () => {
      throw new Error("provider failed");
    });
    await fake.fire("quit", { ...context(cwd), model: undefined });
    await fake.fire("resume", context(cwd));

    let apiKeyLookups = 0;
    const defaultCall = fakePi();
    registerConversas(defaultCall.pi);
    await defaultCall.fire("fork", {
      ...context(cwd, conversationEntries(), "no-api-key"),
      modelRegistry: { getApiKey: async () => { apiKeyLookups += 1; return undefined; } },
    });
    assert.equal(apiKeyLookups, 1);
    await assert.rejects(readFile(join(cwd, ".gsd", "CONVERSAS.md")));
  });

  test("an unresolved completion that observes abort signal cannot hang shutdown", async () => {
    const cwd = await projectRoot();
    const fake = registerFake(
      async (_system, _user, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      10,
    );
    await Promise.race([
      fake.fire("quit", context(cwd)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("hook hung")), 500)),
    ]);
    await assert.rejects(readFile(join(cwd, ".gsd", "CONVERSAS.md")));
  });
});
