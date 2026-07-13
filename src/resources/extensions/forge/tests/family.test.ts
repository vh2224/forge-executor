import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { familyOf } from "../state/family.ts";

describe("familyOf", () => {
  test("claude-code/claude-opus-4-8 -> claude", () => {
    assert.equal(familyOf("claude-code/claude-opus-4-8"), "claude");
  });

  test("openai/gpt-5.5 -> gpt", () => {
    assert.equal(familyOf("openai/gpt-5.5"), "gpt");
  });

  test("anthropic/... -> claude", () => {
    assert.equal(familyOf("anthropic/claude-3-5-sonnet"), "claude");
  });

  test("bare provider-slug without / (claude-code) -> claude", () => {
    assert.equal(familyOf("claude-code"), "claude");
  });

  test("bare provider-slug without / (openai) -> gpt", () => {
    assert.equal(familyOf("openai"), "gpt");
  });

  test("is case-insensitive on input, output always lowercase", () => {
    assert.equal(familyOf("CLAUDE-CODE/claude-opus-4-8"), "claude");
    assert.equal(familyOf("OpenAI/GPT-5.5"), "gpt");
  });

  test("unknown provider/model falls back deterministically to the provider-slug", () => {
    assert.equal(familyOf("mistral/mixtral-8x7b"), "mistral");
  });

  test("unknown bare slug falls back to itself, lowercased", () => {
    assert.equal(familyOf("Cohere"), "cohere");
  });

  test("empty string returns '' without throwing", () => {
    assert.doesNotThrow(() => familyOf(""));
    assert.equal(familyOf(""), "");
  });

  test("whitespace-only string returns '' without throwing", () => {
    assert.equal(familyOf("   "), "");
  });

  test("never throws on unexpected shapes", () => {
    assert.doesNotThrow(() => familyOf("///"));
    assert.doesNotThrow(() => familyOf("provider/model/extra"));
  });

  test("multi-slash input uses only the provider-slug (first segment)", () => {
    assert.equal(familyOf("claude-code/claude-opus-4-8/preview"), "claude");
  });

  test("openai-codex/gpt-5.6-sol -> gpt (real slug, exact alias, not substring)", () => {
    assert.equal(familyOf("openai-codex/gpt-5.6-sol"), "gpt");
  });

  // ── S05 boundary cases: exact-alias match must not collide by substring ──

  test("not-openai/llama does NOT collide into gpt (falls to literal slug)", () => {
    assert.equal(familyOf("not-openai/llama"), "not-openai");
  });

  test("claude-proxy-for-gpt/gpt-x does NOT collide into claude (model-id inference -> gpt)", () => {
    assert.equal(familyOf("claude-proxy-for-gpt/gpt-x"), "gpt");
  });

  test("openai-compatible-llama/x does NOT collide into gpt (falls to literal slug)", () => {
    assert.equal(familyOf("openai-compatible-llama/x"), "openai-compatible-llama");
  });

  test("azure-openai/x falls to literal slug, not gpt (scope decision: not an onboarded alias)", () => {
    assert.equal(familyOf("azure-openai/x"), "azure-openai");
  });
});
