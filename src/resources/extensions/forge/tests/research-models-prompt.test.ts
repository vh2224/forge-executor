/**
 * Prompt-as-contract test for T01's methodology addenda (operator, 2026-07-12):
 * reasoning-level bias, internal-evidence-first, inference marking, planner
 * domain vocabulary (`testes`, never `testing`), and the opportunistic X
 * channel that never blocks on missing grok. Same discipline as
 * `capability-format-doc.test.ts`: prompt text and behavior must not diverge
 * in silence, so these are substring assertions against the REAL exported
 * constant, not a paraphrase.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_MODELS_PROMPT } from "../prompts/research-models.ts";

describe("RESEARCH_MODELS_PROMPT — methodology addenda contract", () => {
  test("declares the reasoning-level default-reporting bias and the discount rule", () => {
    assert.match(RESEARCH_MODELS_PROMPT, /REASONING DEFAULT/);
    assert.match(RESEARCH_MODELS_PROMPT, /state the reasoning level it ran at/);
    assert.match(RESEARCH_MODELS_PROMPT, /discount that benchmark's ranking/);
  });

  test("prioritizes internal repo review evidence over third-party sources", () => {
    assert.match(RESEARCH_MODELS_PROMPT, /Internal repo evidence FIRST/);
    assert.match(RESEARCH_MODELS_PROMPT, /docs\/forge\/\*REVIEW\*\.md/);
    assert.match(RESEARCH_MODELS_PROMPT, /outrank third-party blogs or aggregator posts/);
  });

  test("marks scores without a domain-specific source as conservative inference", () => {
    assert.match(RESEARCH_MODELS_PROMPT, /Inference marking/);
    assert.match(RESEARCH_MODELS_PROMPT, /inferred, no domain-specific source/);
    assert.match(RESEARCH_MODELS_PROMPT, /MUST be conservative and non-competitive/);
  });

  test("enumerates the planner domain vocabulary and warns testes-not-testing", () => {
    assert.match(RESEARCH_MODELS_PROMPT, /`backend`, `frontend`, `infra`, `docs`, `testes`, `research`, `refactor`, `security`/);
    assert.match(RESEARCH_MODELS_PROMPT, /EXACT-MATCH post-lowercase/);
    assert.match(RESEARCH_MODELS_PROMPT, /write `testes` — never `testing`/);
  });

  test("canal X: gated on an actually-exposed X-search tool (not model family), x.com sourcing, absence never blocks", () => {
    assert.match(RESEARCH_MODELS_PROMPT, /Canal X/);
    assert.match(RESEARCH_MODELS_PROMPT, /an actually-exposed X-search tool/);
    assert.match(RESEARCH_MODELS_PROMPT, /is NOT evidence of live X access/);
    assert.match(RESEARCH_MODELS_PROMPT, /NEVER construct or guess an `x\.com` URL/);
    assert.match(RESEARCH_MODELS_PROMPT, /x\.com\/handle\/status/);
    assert.match(RESEARCH_MODELS_PROMPT, /aggregator fallback/);
    assert.match(RESEARCH_MODELS_PROMPT, /NEVER blocks the research/);
    assert.match(RESEARCH_MODELS_PROMPT, /only block per the "never invent refs" rule above/);
  });

  test("existing writer contract still holds: locked byte-for-byte, verbatim refs, sources with dates, single write target", () => {
    assert.match(RESEARCH_MODELS_PROMPT, /preserved BYTE-FOR-BYTE/);
    assert.match(RESEARCH_MODELS_PROMPT, /never invented refs|never invent refs/i);
    assert.match(RESEARCH_MODELS_PROMPT, /sources.*WITH a date/s);
    assert.match(RESEARCH_MODELS_PROMPT, /Write ONLY the capability matrix file \(`\.gsd\/CAPABILITIES\.md`\)/);
    assert.match(RESEARCH_MODELS_PROMPT, /NEVER write `\.gsd\/CAPABILITIES\.local\.md`/);
  });
});
