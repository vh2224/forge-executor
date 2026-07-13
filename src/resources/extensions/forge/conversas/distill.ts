import type { SessionEntry } from "@gsd/pi-coding-agent";
import { sessionMessageText } from "./heuristics.js";

const DEFAULT_EXCERPT_MAX_CHARS = 24_000;

/** Keep the newest transcript material, where operators normally settle decisions. */
function keepTranscriptTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  const omission = "[…início omitido…]\n";
  // A tiny caller cap still obeys its cap without producing an invalid slice.
  if (maxChars <= omission.length) return text.slice(-maxChars);
  return `${omission}${text.slice(-(maxChars - omission.length))}`;
}

/**
 * Build an LLM-safe excerpt from conversational messages only. Session custom
 * entries and all non-text content (notably tools and their results) are excluded.
 */
export function buildTranscriptExcerpt(entries: SessionEntry[], maxChars = DEFAULT_EXCERPT_MAX_CHARS): string {
  const transcript = entries
    .flatMap((entry) => {
      if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) {
        return [];
      }
      const text = sessionMessageText(entry);
      if (!text) return [];
      return [`${entry.message.role === "user" ? "Operador" : "Assistente"}: ${text}`];
    })
    .join("\n\n");

  return keepTranscriptTail(transcript, maxChars);
}

/**
 * Ask for a compact human-memory entry, rather than a tool trace. The response
 * has no session marker because the shutdown writer owns dedupe and injection.
 *
 * `isoDate` is supplied by the shutdown hook, keeping this builder deterministic
 * for tests and ensuring that a delayed provider response cannot change dates.
 * The instructions intentionally repeat structural constraints: a provider can
 * make a judgment about durability, while the T02 writer remains responsible for
 * deterministic validation and append-only persistence.
 */
export function buildDistillPrompt(excerpt: string, isoDate: string): string {
  return `Você destila uma conversa de operador do projeto Forge para memória humana local.

Avalie antes de escrever:
1. É específico deste projeto, suas decisões ou seu contexto?
2. Traz algo não-óbvio, e não apenas uma repetição do trabalho executado?
3. Será durável e útil para uma retomada futura?

Se qualquer resposta for não, responda exatamente SKIP. Não resuma chamadas de ferramentas, resultados de ferramentas, comandos, logs ou passos mecânicos. Use somente decisões faladas, contexto e pendências expressos na conversa.

Se passar no gate, responda apenas uma entrada Markdown em pt-BR, com no máximo 10 linhas (sem marcador de sessão), exatamente neste formato:
## ${isoDate} — <tema em uma linha>
- Decisões: <decisões faladas ou "nenhuma">
- Pendências: <pendências citadas ou "nenhuma">

Conversa (apenas mensagens humanas e do assistente):
---
${excerpt}
---`;
}
