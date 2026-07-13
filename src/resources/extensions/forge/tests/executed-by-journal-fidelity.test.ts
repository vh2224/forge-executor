import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { composePrompt } from "../prompts/compose.ts";
import { EXECUTE_TASK_PROMPT } from "../prompts/execute-task.ts";
import { COMPLETE_SLICE_PROMPT } from "../prompts/complete-slice.ts";
import { COMPLETE_MILESTONE_PROMPT } from "../prompts/complete-milestone.ts";

const EXECUTE_TASK = { type: "execute-task" as const, slice: "S01", task: "T04" };
const INFO = { cwd: "/repo", milestoneId: "M-20260711195610-cockpit" };

/** The loop's journal and prompt header deliberately consume this same ref. */
function promptForDispatch(ref: string | undefined): string {
  return composePrompt(EXECUTE_TASK, { ...INFO, dispatchAuthorRef: ref });
}

describe("executed_by × dispatch journal authorship", () => {
  test("configured model is a fact in the worker header", () => {
    const journaledAuthor = "anthropic/claude-sonnet-4-20250514";
    const prompt = promptForDispatch(journaledAuthor);

    assert.ok(prompt.includes("You are running as: `" + journaledAuthor + "`"));
    assert.match(prompt, /copy this exact value into `executed_by`/);
    // This is the same ref shape emitted by dispatchedEvent/resultAuthor.
    assert.equal(journaledAuthor, "anthropic/claude-sonnet-4-20250514");
  });

  test("degenerate dispatch uses the live effective model as the journal fallback", () => {
    // In the no-config path loop.ts derives this from effectiveModelFor and
    // passes the resulting provider/model ref to both the header and journal.
    const effectiveModel = "claude-code/claude-opus-4-8";
    const prompt = promptForDispatch(effectiveModel);

    assert.match(prompt, /You are running as: `claude-code\/claude-opus-4-8`/);
    assert.match(prompt, /executed_by/);
  });

  test("without a resolved author, composition remains byte-identical", () => {
    const omitted = composePrompt(EXECUTE_TASK, INFO);
    const explicitUndefined = composePrompt(EXECUTE_TASK, {
      ...INFO,
      dispatchAuthorRef: undefined,
    });

    assert.equal(omitted, explicitUndefined);
    assert.doesNotMatch(omitted, /^- You are running as:/m);
  });

  test("all durable summaries instruct verbatim header copying", () => {
    for (const body of [EXECUTE_TASK_PROMPT, COMPLETE_SLICE_PROMPT, COMPLETE_MILESTONE_PROMPT]) {
      assert.match(body, /copy exactly the provider\/model-id shown in the unit header/);
      assert.match(body, /if (?:the header does not provide one|absent)/);
      assert.match(body, /executed_by/);
    }
  });

  test("the header is not an invitation to subprocess self-reporting", () => {
    const prompt = promptForDispatch("openai/gpt-5.4");
    assert.doesNotMatch(prompt, /provider\/model-id that is executing you/);
    assert.match(prompt, /You are running as: `openai\/gpt-5\.4`/);
  });
});
