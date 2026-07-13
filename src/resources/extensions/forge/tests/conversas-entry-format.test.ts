import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry } from "@gsd/pi-coding-agent";
import { buildDistillPrompt, buildTranscriptExcerpt } from "../conversas/distill.js";
import {
  CONVERSAS_FILENAME,
  MAX_ENTRY_LINES,
  formatSessionMarker,
  parseDistillResponse,
  sessionAlreadyDistilled,
} from "../conversas/entry-format.js";

function entries(items: unknown[]): SessionEntry[] {
  return items as SessionEntry[];
}

const validEntry = "## 2026-07-13 — Conversa sobre o gate\n- Decisões: manter o gate\n- Pendências: testar o hook";

describe("conversas excerpt and entry format", () => {
  test("excerpt contains only user and assistant text", () => {
    const excerpt = buildTranscriptExcerpt(entries([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "decisão da pessoa" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "decisão confirmada" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "segredo de ferramenta" }] } },
      { type: "custom_message", customType: "forge-dispatch", content: "marcador interno", display: false },
    ]));

    assert.match(excerpt, /Operador: decisão da pessoa/);
    assert.match(excerpt, /Assistente: decisão confirmada/);
    assert.doesNotMatch(excerpt, /call-1|bash|segredo|marcador interno/);
  });

  test("excerpt retains the newest content when capped", () => {
    const excerpt = buildTranscriptExcerpt(entries([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "conteúdo antigo" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "decisão nova importante" }] } },
    ]), 60);
    assert.match(excerpt, /decisão nova importante/);
    assert.doesNotMatch(excerpt, /conteúdo antigo/);
  });

  test("prompt embeds the quality gate, SKIP instruction, and supplied date", () => {
    const prompt = buildDistillPrompt("Operador: escolhemos X", "2026-07-13");
    assert.match(prompt, /específico/i);
    assert.match(prompt, /não-óbvio/i);
    assert.match(prompt, /durável/i);
    assert.match(prompt, /exatamente SKIP/);
    assert.match(prompt, /## 2026-07-13 — <tema em uma linha>/);
    assert.match(prompt, /Não resuma chamadas de ferramentas/);
  });

  test("rejects SKIP responses", () => {
    assert.equal(parseDistillResponse(" SKIP\n", "2026-07-13"), null);
  });

  test("rejects a response longer than ten lines", () => {
    const tooLong = ["## 2026-07-13 — Tema", ...Array.from({ length: MAX_ENTRY_LINES }, (_, i) => `- linha ${i}`)].join("\n");
    assert.equal(parseDistillResponse(tooLong, "2026-07-13"), null);
  });

  test("rejects a response without the contracted heading", () => {
    assert.equal(parseDistillResponse("# 2026-07-13 — Tema\n- Decisões: x", "2026-07-13"), null);
    assert.equal(parseDistillResponse("## data livre — Tema\n- Decisões: x", "2026-07-13"), null);
  });

  test("accepts and normalizes a valid entry", () => {
    assert.equal(parseDistillResponse(`\n${validEntry}\n`, "2026-07-13"), validEntry);
  });

  test("rejects a heading whose date does not match the supplied date", () => {
    assert.equal(parseDistillResponse(validEntry, "2026-07-14"), null);
  });

  test("rejects a response carrying a second entry heading", () => {
    const twoHeadings = `${validEntry}\n## 2026-07-13 — Segundo tema\n- Decisões: y`;
    assert.equal(parseDistillResponse(twoHeadings, "2026-07-13"), null);
  });

  test("formats and detects exact session markers for dedupe", () => {
    const marker = formatSessionMarker("session-123");
    assert.equal(marker, "<!-- sessao: session-123 -->");
    const existing = `${validEntry}\n${marker}\n`;
    assert.equal(sessionAlreadyDistilled(existing, "session-123"), true);
    assert.equal(sessionAlreadyDistilled(existing, "session-12"), false);
  });

  test("exposes the stable filename contract", () => {
    assert.equal(CONVERSAS_FILENAME, "CONVERSAS.md");
  });
});
