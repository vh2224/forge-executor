import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@gsd/pi-coding-agent";
import { completeSimple } from "@gsd/pi-ai";
import { buildDistillPrompt, buildTranscriptExcerpt } from "./distill.js";
import {
  CONVERSAS_FILENAME,
  formatSessionMarker,
  parseDistillResponse,
  sessionAlreadyDistilled,
} from "./entry-format.js";
import { shouldDistillSession } from "./heuristics.js";

const DEFAULT_TIMEOUT_MS = 15_000;
// `new`/`resume`/`fork` are awaited on the interactive path before the operator
// gets control of the next session, unlike `quit` which tears down on process
// exit. Bound those transitions with a much smaller budget so a slow provider
// cannot stall the operator for the full shutdown timeout.
const INTERACTIVE_TIMEOUT_MS = 3_000;

/** Injectable one-shot completion seam for shutdown-hook tests. */
export type DistillLlmCall = (system: string, user: string, signal: AbortSignal) => Promise<string>;

type RegisterConversasOptions = {
  llmCall?: DistillLlmCall;
  timeoutMs?: number;
};

function readConversas(path: string): Promise<string> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
}

function injectSessionMarker(entry: string, sessionId: string): string {
  const [heading, ...body] = entry.split("\n");
  return [heading, formatSessionMarker(sessionId), ...body].join("\n");
}

/**
 * Register the best-effort conversational-memory shutdown hook. It deliberately
 * never throws: shutdown is awaited by the runtime and must not be held hostage
 * by a provider, filesystem, or malformed completion failure.
 */
export function registerConversas(pi: ExtensionAPI, opts: RegisterConversasOptions = {}): void {
  pi.on("session_shutdown", async (event, ctx) => {
    try {
      const conversasDir = join(ctx.cwd, ".gsd");
      if (!existsSync(conversasDir)) return;

      const entries = ctx.sessionManager.getEntries();
      if (!shouldDistillSession(entries, event.reason)) return;

      const sessionId = ctx.sessionManager.getSessionId();
      const conversasPath = join(conversasDir, CONVERSAS_FILENAME);
      if (sessionAlreadyDistilled(await readConversas(conversasPath), sessionId)) return;

      const model = ctx.model;
      if (!model) return;

      const llmCall = opts.llmCall ?? (async (system: string, user: string, signal: AbortSignal): Promise<string> => {
        const apiKey = await ctx.modelRegistry.getApiKey(model);
        if (!apiKey) throw new Error("No API key available for conversation distillation");
        const result = await completeSimple(
          model,
          { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
          { apiKey, signal, maxTokens: 512 },
        );
        return result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
      });

      const isoDate = new Date().toISOString().slice(0, 10);
      const prompt = buildDistillPrompt(buildTranscriptExcerpt(entries), isoDate);
      const timeoutMs = opts.timeoutMs ?? (event.reason === "quit" ? DEFAULT_TIMEOUT_MS : INTERACTIVE_TIMEOUT_MS);
      const response = await llmCall(
        "Você é um destilador de memória conversacional local. Siga estritamente o formato solicitado.",
        prompt,
        AbortSignal.timeout(timeoutMs),
      );
      const entry = parseDistillResponse(response, isoDate);
      if (!entry) return;

      await withFileMutationQueue(conversasPath, async () => {
        // Re-read inside the per-path queue: concurrent shutdown handlers cannot
        // append a duplicate marker even if both passed the cheap preflight read.
        if (sessionAlreadyDistilled(await readConversas(conversasPath), sessionId)) return;
        await appendFile(conversasPath, `\n${injectSessionMarker(entry, sessionId)}\n`, "utf8");
      });
    } catch {
      /* best-effort, like journaling: shutdown must never be blocked or fail */
    }
  });
}
