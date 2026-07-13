import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { composePrompt } from "../prompts/compose.ts";
import type { NextUnit } from "../state/dispatch.ts";

const INFO = {
  cwd: "/repo",
  milestoneId: "M-1",
  milestoneTitle: "Test Milestone",
  sliceTitle: "Test Slice",
  taskTitle: "Test Task",
};

const EXECUTE_TASK_UNIT: NextUnit = { type: "execute-task", slice: "S01", task: "T02" };

const MEMORY_BLOCK = "## Project Memory\n\n- fato X\n- fato Y\n";

describe("composePrompt — S07/T04 project-memory injection (4th param)", () => {
  test("projectMemory present → '## Project Memory' section injected, containing the facts", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO, undefined, MEMORY_BLOCK);
    assert.match(prompt, /## Project Memory/);
    assert.match(prompt, /fato X/);
    assert.match(prompt, /fato Y/);
  });

  test("projectMemory section is placed BEFORE the commit-point instruction", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO, undefined, MEMORY_BLOCK);
    const memoryIdx = prompt.indexOf("## Project Memory");
    const commitIdx = prompt.lastIndexOf("## Commit point (mandatory)");
    assert.ok(memoryIdx >= 0, "memory section must be present");
    assert.ok(memoryIdx < commitIdx, "Project Memory must precede the final commit-point instruction");
  });

  test("projectMemory section is NOT re-headerized (composeProjectMemory already carries the header)", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO, undefined, MEMORY_BLOCK);
    // Exactly one occurrence of the header — a naive implementation that wraps
    // the block in its own "## Project Memory" would duplicate it.
    const occurrences = prompt.split("## Project Memory").length - 1;
    assert.equal(occurrences, 1, "header must appear exactly once — not re-wrapped");
  });

  test("no projectMemory arg (3-arg call) → prompt does NOT contain '## Project Memory'", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO, "some retry context");
    assert.doesNotMatch(prompt, /## Project Memory/);
  });

  test("REGRESSION: composePrompt(unit, info) with no memory is byte-identical to the pre-T04 baseline", () => {
    // Baseline: identity + body + commit-point instruction only, no Retry
    // Context, no Project Memory. This proves the new 4th param is purely
    // additive — omission is a strict no-op on the existing 2-arg call shape.
    const withNoArgs = composePrompt(EXECUTE_TASK_UNIT, INFO);
    const withExplicitUndefined = composePrompt(EXECUTE_TASK_UNIT, INFO, undefined, undefined);
    assert.equal(withNoArgs, withExplicitUndefined, "explicit undefined 4th arg is a no-op vs omission");
    assert.doesNotMatch(withNoArgs, /## Project Memory/);
    assert.doesNotMatch(withNoArgs, /## Retry Context/);
    assert.match(withNoArgs, /## Commit point \(mandatory\)/);
  });

  test("REGRESSION: composePrompt(unit, info) with empty-string memory is a no-op (whitespace-only too)", () => {
    const baseline = composePrompt(EXECUTE_TASK_UNIT, INFO);
    const withEmpty = composePrompt(EXECUTE_TASK_UNIT, INFO, undefined, "");
    const withWhitespace = composePrompt(EXECUTE_TASK_UNIT, INFO, undefined, "   \n  ");
    assert.equal(baseline, withEmpty, "empty-string memory must not add a section");
    assert.equal(baseline, withWhitespace, "whitespace-only memory must not add a section");
  });

  test("failureContext + projectMemory together → both sections present, memory after retry context, both before commit-point", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO, "typecheck failed on foo.ts", MEMORY_BLOCK);
    assert.match(prompt, /## Retry Context/);
    assert.match(prompt, /## Project Memory/);
    const retryIdx = prompt.indexOf("## Retry Context");
    const memoryIdx = prompt.indexOf("## Project Memory");
    const commitIdx = prompt.lastIndexOf("## Commit point (mandatory)");
    assert.ok(retryIdx < memoryIdx, "Retry Context should precede Project Memory (same threading order as failureContext)");
    assert.ok(memoryIdx < commitIdx, "Project Memory must precede the commit-point instruction");
  });
});

describe("composePrompt — S07/T04 namespaced resultToolName coexists with memory section", () => {
  const NAMESPACED = "mcp__forge__forge_unit_result";

  test("namespaced rename applies AND the Project Memory section remains intact", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, { ...INFO, resultToolName: NAMESPACED }, undefined, MEMORY_BLOCK);

    // The rename applied everywhere...
    assert.match(prompt, /`mcp__forge__forge_unit_result`/);
    assert.doesNotMatch(prompt, /`forge_unit_result`/);

    // ...and the memory section is still present, untouched by the rename
    // (the rename only rewrites the tool-name token, never memory content).
    assert.match(prompt, /## Project Memory/);
    assert.match(prompt, /fato X/);
    assert.match(prompt, /fato Y/);
  });

  test("default (bare) resultToolName + memory → memory present, no namespaced token introduced", () => {
    const prompt = composePrompt(EXECUTE_TASK_UNIT, INFO, undefined, MEMORY_BLOCK);
    assert.match(prompt, /## Project Memory/);
    assert.doesNotMatch(prompt, /mcp__forge__/);
    assert.match(prompt, /`forge_unit_result`/);
  });
});
