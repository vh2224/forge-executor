import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendReviewFollowUps, type ReviewFollowUpEntry } from "../review/followups.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "forge-review-followups-"));
}

function knowledgePath(cwd: string): string {
  return join(cwd, ".gsd", "KNOWLEDGE.md");
}

function entry(over: Partial<ReviewFollowUpEntry> = {}): ReviewFollowUpEntry {
  return {
    milestoneId: "M-test",
    slice: "S02",
    id: "R1",
    pathLine: "src/x.ts:10",
    claim: "validate input before use",
    note: "tracked as a follow-up, not a fix",
    ...over,
  };
}

describe("appendReviewFollowUps", () => {
  test("no entries → { appended: 0, ok: true }, no file created", () => {
    const cwd = tmp();
    const res = appendReviewFollowUps(cwd, []);
    assert.deepEqual(res, { appended: 0, ok: true });
    assert.throws(() => readFileSync(knowledgePath(cwd), "utf-8"));
  });

  test("missing file → creates it with a minimal `# KNOWLEDGE` header and the section", () => {
    const cwd = tmp();
    const res = appendReviewFollowUps(cwd, [entry()]);
    assert.equal(res.appended, 1);

    const content = readFileSync(knowledgePath(cwd), "utf-8");
    assert.match(content, /^# KNOWLEDGE\n/);
    assert.match(content, /## Review follow-ups\n/);
    assert.match(
      content,
      /- \*\*\[follow-up de S02 R1 · M-test\]\*\* validate input before use \(`src\/x\.ts:10`\) — tracked as a follow-up, not a fix/,
    );
  });

  test("file exists, section missing → section created at the end, existing content preserved", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".gsd"), { recursive: true });
    const original = "# KNOWLEDGE — M-other\n\n## Other section\n\n- pre-existing line\n";
    writeFileSync(knowledgePath(cwd), original, "utf-8");

    const res = appendReviewFollowUps(cwd, [entry()]);
    assert.equal(res.appended, 1);

    const content = readFileSync(knowledgePath(cwd), "utf-8");
    assert.ok(content.startsWith(original), "pre-existing content must be preserved byte-for-byte");
    assert.match(content, /## Review follow-ups\n/);
    assert.match(content, /- \*\*\[follow-up de S02 R1 · M-test\]\*\*/);
  });

  test("section exists → appends without disturbing other content, including a suffixed section", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".gsd"), { recursive: true });
    const original =
      "# KNOWLEDGE — M-test\n\n" +
      "## Review follow-ups\n\n" +
      "- **[pre-existing entry]** something else\n\n" +
      "## Review follow-ups (M1)\n\n" +
      "- **[from S01 review R4]** untouched decoy section\n";
    writeFileSync(knowledgePath(cwd), original, "utf-8");

    const res = appendReviewFollowUps(cwd, [entry()]);
    assert.equal(res.appended, 1);

    const content = readFileSync(knowledgePath(cwd), "utf-8");
    // Base section keeps its pre-existing line AND gains the new one.
    assert.match(content, /- \*\*\[pre-existing entry\]\*\* something else/);
    assert.match(content, /- \*\*\[follow-up de S02 R1 · M-test\]\*\*/);
    // The suffixed decoy section is untouched byte-for-byte — exact match, not prefix.
    assert.match(
      content,
      /## Review follow-ups \(M1\)\n\n- \*\*\[from S01 review R4\]\*\* untouched decoy section\n$/,
    );
    // The new entry lands in the BASE section, before the decoy section header.
    const baseIdx = content.indexOf("## Review follow-ups\n");
    const newEntryIdx = content.indexOf("[follow-up de S02 R1");
    const decoyIdx = content.indexOf("## Review follow-ups (M1)");
    assert.ok(baseIdx < newEntryIdx && newEntryIdx < decoyIdx);
  });

  test("multiple entries in one call, some new some duplicate of an existing line", () => {
    const cwd = tmp();
    appendReviewFollowUps(cwd, [entry({ id: "R1" })]);

    const res = appendReviewFollowUps(cwd, [entry({ id: "R1" }), entry({ id: "R2", claim: "second claim" })]);
    assert.equal(res.appended, 1); // R1 line already present, only R2 is new

    const content = readFileSync(knowledgePath(cwd), "utf-8");
    assert.match(content, /follow-up de S02 R1/);
    assert.match(content, /follow-up de S02 R2/);
    // R1's line appears exactly once.
    assert.equal(content.split("follow-up de S02 R1").length - 1, 1);
  });

  test("idempotent: re-applying the exact same entries appends nothing and does not rewrite the file", () => {
    const cwd = tmp();
    appendReviewFollowUps(cwd, [entry()]);
    const before = readFileSync(knowledgePath(cwd), "utf-8");
    const mtimeBefore = statSync(knowledgePath(cwd)).mtimeMs;

    const again = appendReviewFollowUps(cwd, [entry()]);
    assert.deepEqual(again, { appended: 0, ok: true });
    assert.equal(readFileSync(knowledgePath(cwd), "utf-8"), before);
    assert.equal(statSync(knowledgePath(cwd)).mtimeMs, mtimeBefore, "idempotent no-op must not rewrite the file");
  });

  test("never throws: unreadable/invalid target directory yields { appended: 0, ok: false }", () => {
    // Point cwd at a path whose ".gsd" segment is actually a FILE — readdir/write
    // through it must fail, and the function must swallow it rather than throw.
    // R1: `ok: false` here is what distinguishes a real I/O failure from the
    // legitimate "nothing new to append" case (`ok: true` above) — callers that
    // stamp a REVIEW.md marker on the strength of this call need that distinction.
    const cwd = tmp();
    writeFileSync(join(cwd, ".gsd"), "not a directory", "utf-8");
    assert.doesNotThrow(() => {
      const res = appendReviewFollowUps(cwd, [entry()]);
      assert.equal(res.appended, 0);
      assert.equal(res.ok, false);
    });
  });
});
