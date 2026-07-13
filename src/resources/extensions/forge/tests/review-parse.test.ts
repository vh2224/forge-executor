import { test } from "node:test";
import assert from "node:assert/strict";

import {
  challengerPrompt,
  advocatePrompt,
  rebuttalPrompt,
  renderObjectionsText,
  renderDefenseText,
} from "../review/prompts.js";
import { parseObjections, parseVerdicts } from "../review/parse.js";
import { resolveReview } from "../review/resolve.js";
import type {
  ReviewObjection,
  ReviewVerdict,
  AdvocateVerdictKind,
  RebuttalVerdictKind,
} from "../review/resolve.js";

const BASE = { workingDir: "/tmp/proj", unit: "task/T02", diffCmd: "git diff HEAD" };

const OBJECTIONS: ReviewObjection[] = [
  {
    id: "R1",
    pathLine: "src/foo.ts:10",
    severity: "critical",
    claim: "null deref on missing input",
    suggestedFix: "add a guard before dereferencing",
    challenge: "does the caller ever pass undefined here?",
  },
  {
    id: "R2",
    pathLine: "src/bar.ts:42",
    severity: "medium",
    claim: "duplicated retry logic",
    suggestedFix: "extract a shared retry helper",
    challenge: "is this duplication intentional?",
  },
];

test("challengerPrompt embeds WORKING_DIR/UNIT/DIFF_CMD and the diff-from-inside instruction", () => {
  const prompt = challengerPrompt(BASE);
  assert.match(prompt, /WORKING_DIR: \/tmp\/proj/);
  assert.match(prompt, /UNIT: task\/T02/);
  assert.match(prompt, /DIFF_CMD: git diff HEAD/);
  assert.match(prompt, /Execute DIFF_CMD from INSIDE WORKING_DIR/);
  assert.match(prompt, /NO_FLAGS/);
});

test("advocatePrompt embeds OBJECTIONS text", () => {
  const objectionsText = renderObjectionsText(OBJECTIONS);
  const prompt = advocatePrompt({ ...BASE, objectionsText });
  assert.match(prompt, /OBJECTIONS:/);
  assert.match(prompt, /R1 `src\/foo\.ts:10`/);
  assert.match(prompt, /R2 `src\/bar\.ts:42`/);
});

test("rebuttalPrompt embeds OBJECTIONS and DEFENSE text", () => {
  const objectionsText = renderObjectionsText(OBJECTIONS);
  const defenseVerdicts: ReviewVerdict<AdvocateVerdictKind>[] = [
    { id: "R1", verdict: "refuted", rationale: "guard already exists on the caller" },
    { id: "R2", verdict: "conceded", rationale: "yes, should be extracted" },
  ];
  const defenseText = renderDefenseText(defenseVerdicts);
  const prompt = rebuttalPrompt({ ...BASE, objectionsText, defenseText });
  assert.match(prompt, /OBJECTIONS:/);
  assert.match(prompt, /DEFENSE:/);
  assert.match(prompt, /R1: refuted — guard already exists on the caller/);
  assert.match(prompt, /R2: conceded — yes, should be extracted/);
});

test("round-trip: objections -> renderObjectionsText -> parseObjections reproduces ids/severities/claims", () => {
  const rendered = renderObjectionsText(OBJECTIONS);
  const result = parseObjections(rendered);

  assert.equal(result.noFlags, false);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.objections.length, 2);

  for (const [i, original] of OBJECTIONS.entries()) {
    const parsed = result.objections[i]!;
    assert.equal(parsed.id, original.id);
    assert.equal(parsed.pathLine, original.pathLine);
    assert.equal(parsed.severity, original.severity);
    assert.equal(parsed.claim, original.claim);
    assert.equal(parsed.suggestedFix, original.suggestedFix);
    assert.equal(parsed.challenge, original.challenge);
  }
});

test("round-trip: verdicts -> renderDefenseText -> parseVerdicts reproduces ids/verdicts (advocate allowed set)", () => {
  const verdicts: ReviewVerdict<AdvocateVerdictKind>[] = [
    { id: "R1", verdict: "refuted", rationale: "pre-existing behavior, out of scope" },
    { id: "R2", verdict: "conceded", rationale: "real duplication, will extract" },
    { id: "R3", verdict: "open", rationale: "tradeoff between perf and clarity" },
  ];
  const rendered = renderDefenseText(verdicts);
  const result = parseVerdicts(rendered, ["refuted", "conceded", "open"] as const);

  assert.deepEqual(result.warnings, []);
  assert.equal(result.verdicts.length, 3);
  for (const [i, original] of verdicts.entries()) {
    const parsed = result.verdicts[i]!;
    assert.equal(parsed.id, original.id);
    assert.equal(parsed.verdict, original.verdict);
    assert.equal(parsed.rationale, original.rationale);
  }
});

test("round-trip: rebuttal verdicts -> renderDefenseText -> parseVerdicts reproduces ids/verdicts (rebuttal allowed set)", () => {
  const verdicts: ReviewVerdict<RebuttalVerdictKind>[] = [
    { id: "R1", verdict: "maintained", rationale: "the defense missed the async path" },
    { id: "R2", verdict: "withdrawn", rationale: "the advocate is right, false positive" },
    { id: "R3", verdict: "conceded", rationale: "carried through — advocate conceded" },
  ];
  const rendered = renderDefenseText(verdicts);
  const result = parseVerdicts(rendered, ["maintained", "withdrawn", "conceded"] as const);

  assert.deepEqual(result.warnings, []);
  assert.equal(result.verdicts.length, 3);
  for (const [i, original] of verdicts.entries()) {
    const parsed = result.verdicts[i]!;
    assert.equal(parsed.id, original.id);
    assert.equal(parsed.verdict, original.verdict);
  }
});

test("parseObjections recognizes NO_FLAGS case-insensitively, in isolation or amid noise", () => {
  assert.equal(parseObjections("NO_FLAGS").noFlags, true);
  assert.equal(parseObjections("no_flags").noFlags, true);
  assert.equal(
    parseObjections("Some prose before.\nNo_Flags\nSome prose after.").noFlags,
    true,
  );
});

test("parseObjections handles realistic prose noise around the structured lines", () => {
  const text = `Here is my review of the diff.

### Critical
- R1 \`src/foo.ts:10\` — null deref on missing input — suggested fix: add a guard before dereferencing — challenge: does the caller ever pass undefined here?

### Medium
- R2 \`src/bar.ts:42\` — duplicated retry logic — suggested fix: extract a shared retry helper — challenge: is this duplication intentional?

That's everything I found.`;

  const result = parseObjections(text);
  assert.equal(result.noFlags, false);
  assert.equal(result.objections.length, 2);
  assert.equal(result.objections[0]!.severity, "critical");
  assert.equal(result.objections[1]!.severity, "medium");
  assert.deepEqual(result.warnings, []);
});

test("parseObjections: malformed R#-line becomes a warning, never throws", () => {
  const text = `### High
- R1 this line has no backticks or dashes at all`;
  assert.doesNotThrow(() => parseObjections(text));
  const result = parseObjections(text);
  assert.equal(result.objections.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /malformed/i);
});

test("parseObjections: inline severity outside the enum degrades to medium with a warning", () => {
  const text =
    "- R1 `src/foo.ts:1` [urgent] — something is wrong — suggested fix: fix it — challenge: is it though?";
  const result = parseObjections(text);
  assert.equal(result.objections.length, 1);
  assert.equal(result.objections[0]!.severity, "medium");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /outside enum/);
});

test("parseObjections: duplicate R# id keeps the first occurrence and warns", () => {
  const text = `### Critical
- R1 \`a.ts:1\` — first claim — suggested fix: fix A — challenge: q1?
- R1 \`b.ts:2\` — second claim — suggested fix: fix B — challenge: q2?`;
  const result = parseObjections(text);
  assert.equal(result.objections.length, 1);
  assert.equal(result.objections[0]!.claim, "first claim");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /duplicate objection id R1/);
});

test("parseObjections: empty text yields zero objections and no crash (no NO_FLAGS either)", () => {
  const result = parseObjections("");
  assert.equal(result.noFlags, false);
  assert.equal(result.objections.length, 0);
  assert.deepEqual(result.warnings, []);
});

test("parseVerdicts: verdict outside the allowed enum is discarded with a warning, never throws", () => {
  const text = "R1: unsure — I have no idea";
  assert.doesNotThrow(() => parseVerdicts(text, ["refuted", "conceded", "open"] as const));
  const result = parseVerdicts(text, ["refuted", "conceded", "open"] as const);
  assert.equal(result.verdicts.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /outside allowed set/);
});

test("parseVerdicts: malformed line becomes a warning, tolerant of surrounding prose", () => {
  const text = `Here are my verdicts.
R1: refuted — pre-existing behavior
this line is just noise, not a verdict at all
R2 malformed no colon or dash
### Defense
`;
  const result = parseVerdicts(text, ["refuted", "conceded", "open"] as const);
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0]!.id, "R1");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /malformed/i);
});

test("parseVerdicts: duplicate id keeps first occurrence and warns", () => {
  const text = `R1: refuted — first rationale
R1: conceded — second rationale`;
  const result = parseVerdicts(text, ["refuted", "conceded", "open"] as const);
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0]!.verdict, "refuted");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /duplicate verdict/);
});

// ── C1 (S05) regression: challengerPrompt ↔ parseObjections format contract ──
// The objection lines the prompt INSTRUCTS the agent to emit must round-trip
// through parseObjections and recover non-zero objections. This test derives
// the text from the REAL `challengerPrompt()` output (not a hand-written
// approximation), so a prompt/parser format drift fails it. Fail-before: the
// pre-fix template omitted `:` after "suggested fix", so parseObjections'
// label-anchored `— suggested fix:` search dropped EVERY line → 0 objections →
// resolveReview sees nothing → noFlags over a diff full of real bugs.
test("C1: objection lines from challengerPrompt() parse back to non-zero objections", () => {
  const prompt = challengerPrompt(BASE);
  // Pull the exact `- R#` template lines the prompt instructs the agent to emit.
  const objectionLines = prompt
    .split(/\r?\n/)
    .filter((l) => /^-\s*R\d+\s+`/.test(l.trim()));
  assert.ok(
    objectionLines.length >= 4,
    `expected the prompt to instruct >=4 objection lines, got ${objectionLines.length}`,
  );

  const result = parseObjections(objectionLines.join("\n"));
  assert.equal(result.noFlags, false);
  // The core of C1: the parser must recover EVERY instructed line, not drop it.
  assert.equal(
    result.objections.length,
    objectionLines.length,
    `parseObjections dropped instructed objection lines — warnings: ${result.warnings.join(" | ")}`,
  );
  for (const o of result.objections) {
    assert.ok(o.pathLine.length > 0, `R${o.id} lost its pathLine`);
    assert.ok(o.suggestedFix.length > 0, `${o.id} lost its suggestedFix`);
    assert.ok(o.challenge.length > 0, `${o.id} lost its challenge`);
  }
});

// ── C2 (S05) regression: trailing punctuation on a verdict token survives ─────
// Fail-before: `VERDICT_RE` captured the token with `\S+`, so `R2: conceded.`
// (full stop) failed the exact-match enum check and was discarded → resolveReview
// defaulted the objection to open → a genuine CONCEDED was silently downgraded.
test("C2: parseVerdicts strips trailing punctuation on the verdict token", () => {
  const text = `R1: refuted. — pre-existing behavior
R2: conceded. — real bug, will fix
R3: open, — genuine tradeoff
R4: refuted; — false positive`;
  const result = parseVerdicts(text, ["refuted", "conceded", "open"] as const);
  assert.equal(result.verdicts.length, 4, `warnings: ${result.warnings.join(" | ")}`);
  assert.equal(result.verdicts[0]!.verdict, "refuted");
  assert.equal(result.verdicts[1]!.verdict, "conceded");
  assert.equal(result.verdicts[2]!.verdict, "open");
  assert.equal(result.verdicts[3]!.verdict, "refuted");
  assert.deepEqual(result.warnings, []);
});

test("C2: a CONCEDED verdict with a trailing full stop resolves CONCEDED, not open", () => {
  const objText = "- R1 `src/foo.ts:1` — real bug — suggested fix: fix it — challenge: is it real?";
  const parsedObjections = parseObjections(objText);
  assert.equal(parsedObjections.objections.length, 1);

  const parsedVerdicts = parseVerdicts("R1: conceded. — real bug, will fix", ["refuted", "conceded", "open"] as const);
  assert.equal(parsedVerdicts.verdicts.length, 1);
  assert.equal(parsedVerdicts.verdicts[0]!.verdict, "conceded");

  const out = resolveReview(parsedObjections.objections, parsedVerdicts.verdicts, [], 0);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]!.resolution, "conceded");
});
