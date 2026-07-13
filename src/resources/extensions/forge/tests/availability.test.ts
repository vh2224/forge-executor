import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isModelAvailable,
  unavailableRefsProbe,
  type AvailabilityProbe,
} from "../auto/availability.ts";

describe("isModelAvailable — no probe (default-available)", () => {
  test("returns true for any ref when probe is omitted", () => {
    assert.equal(isModelAvailable("claude-code/claude-opus-4-8"), true);
    assert.equal(isModelAvailable("openai/gpt-5.5"), true);
  });

  test("returns true for an empty-string ref when probe is omitted", () => {
    assert.equal(isModelAvailable(""), true);
  });

  test("returns true when probe is explicitly undefined", () => {
    assert.equal(isModelAvailable("openai/gpt-5-mini", undefined), true);
  });
});

describe("isModelAvailable — injected probe", () => {
  test("probe marks a specific ref unavailable", () => {
    const probe: AvailabilityProbe = (ref) => ref !== "openai/gpt-5.5";
    assert.equal(isModelAvailable("openai/gpt-5.5", probe), false);
  });

  test("probe leaves other refs available", () => {
    const probe: AvailabilityProbe = (ref) => ref !== "openai/gpt-5.5";
    assert.equal(isModelAvailable("claude-code/claude-opus-4-8", probe), true);
    assert.equal(isModelAvailable("openai/gpt-5-mini", probe), true);
  });

  test("probe result is delegated verbatim, including a probe that always returns false", () => {
    const alwaysUnavailable: AvailabilityProbe = () => false;
    assert.equal(isModelAvailable("claude-code/claude-sonnet-5", alwaysUnavailable), false);
  });

  test("probe is called with exactly the ref passed to isModelAvailable", () => {
    let seen: string | null = null;
    const probe: AvailabilityProbe = (ref) => {
      seen = ref;
      return true;
    };
    isModelAvailable("claude-code/claude-opus-4-8", probe);
    assert.equal(seen, "claude-code/claude-opus-4-8");
  });
});

describe("unavailableRefsProbe", () => {
  test("marks every listed ref unavailable", () => {
    const probe = unavailableRefsProbe(["openai/gpt-5.5", "openai/gpt-5-mini"]);
    assert.equal(isModelAvailable("openai/gpt-5.5", probe), false);
    assert.equal(isModelAvailable("openai/gpt-5-mini", probe), false);
  });

  test("leaves refs outside the set available", () => {
    const probe = unavailableRefsProbe(["openai/gpt-5.5"]);
    assert.equal(isModelAvailable("claude-code/claude-opus-4-8", probe), true);
  });

  test("an empty iterable produces an always-available probe", () => {
    const probe = unavailableRefsProbe([]);
    assert.equal(isModelAvailable("openai/gpt-5.5", probe), true);
  });

  test("accepts a Set<string> directly (Iterable<string>)", () => {
    const probe = unavailableRefsProbe(new Set(["openai/gpt-5.5"]));
    assert.equal(isModelAvailable("openai/gpt-5.5", probe), false);
    assert.equal(isModelAvailable("openai/gpt-5-mini", probe), true);
  });
});
