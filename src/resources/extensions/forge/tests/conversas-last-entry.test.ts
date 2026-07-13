import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { formatSessionMarker } from "../conversas/entry-format.js";
import { parseLastConversationHeading, readLastConversationLine } from "../conversas/last-entry.js";

const roots: string[] = [];

function sandbox(): string {
  const cwd = mkdtempSync(join(tmpdir(), "forge-last-entry-"));
  roots.push(cwd);
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  return cwd;
}

function writeConversas(cwd: string, content: string): void {
  writeFileSync(join(cwd, ".gsd", "CONVERSAS.md"), content, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseLastConversationHeading — pure parser", () => {
  test("a single entry parses into its date and theme", () => {
    const result = parseLastConversationHeading("## 2026-07-13 — Memória local do Forge\n- Decisões: manter no disco");
    assert.deepEqual(result, { date: "2026-07-13", theme: "Memória local do Forge" });
  });

  test("of N entries, returns the LAST one, not the first", () => {
    const content = [
      "## 2026-07-10 — Tema antigo",
      "<!-- sessao: session-a -->",
      "- Decisões: x",
      "",
      "## 2026-07-13 — Tema mais recente",
      "<!-- sessao: session-b -->",
      "- Decisões: y",
    ].join("\n");
    const result = parseLastConversationHeading(content);
    assert.deepEqual(result, { date: "2026-07-13", theme: "Tema mais recente" });
  });

  test("no heading at all returns null", () => {
    assert.equal(parseLastConversationHeading("apenas texto solto, sem heading nenhum"), null);
  });

  test("empty string returns null", () => {
    assert.equal(parseLastConversationHeading(""), null);
  });

  test("an invalid heading (bad date grammar, or missing em-dash) returns null", () => {
    assert.equal(parseLastConversationHeading("## data-livre — Tema"), null);
    assert.equal(parseLastConversationHeading("# 2026-07-13 — Tema (H1, não H2)"), null);
    assert.equal(parseLastConversationHeading("## 2026-07-13 sem separador de tema"), null);
  });
});

describe("readLastConversationLine — fs wrapper", () => {
  test("no .gsd/CONVERSAS.md at all — returns empty string, never throws", () => {
    const cwd = sandbox();
    assert.doesNotThrow(() => readLastConversationLine(cwd));
    assert.equal(readLastConversationLine(cwd), "");
  });

  test("present with two entries — formats the LAST one in pt-BR, without the dedupe marker", () => {
    const cwd = sandbox();
    const first = `## 2026-07-10 — Memória local do Forge\n${formatSessionMarker("session-a")}\n- Decisões: manter no disco`;
    const second = `## 2026-07-13 — Gate da conversa\n${formatSessionMarker("session-b")}\n- Pendências: revisar apresentação`;
    writeConversas(cwd, `${first}\n\n${second}\n`);

    const line = readLastConversationLine(cwd);
    assert.equal(line, "Última conversa: 2026-07-13 — Gate da conversa");
    assert.doesNotMatch(line, /sessao:/);
    assert.doesNotMatch(line, /session-a|session-b/);
  });

  test("empty file — returns empty string, never throws", () => {
    const cwd = sandbox();
    writeConversas(cwd, "");
    assert.equal(readLastConversationLine(cwd), "");
  });

  test("malformed content (no valid heading) — returns empty string, never throws", () => {
    const cwd = sandbox();
    writeConversas(cwd, "isto não é uma entrada válida\nnem isto\n");
    assert.equal(readLastConversationLine(cwd), "");
  });

  test("unreadable path (a directory sits where the file should be) — returns empty string, never throws", () => {
    const cwd = sandbox();
    mkdirSync(join(cwd, ".gsd", "CONVERSAS.md"));
    assert.ok(existsSync(join(cwd, ".gsd", "CONVERSAS.md")));
    assert.doesNotThrow(() => readLastConversationLine(cwd));
    assert.equal(readLastConversationLine(cwd), "");
  });
});
