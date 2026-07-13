import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderReview,
  renderReviewStub,
  writeReview,
  reviewArtifactPath,
  applyConcededFix,
  applyDecision,
  collectPendingReviewItems,
  collectPendingReviewBlocks,
  collectPendingTaskReviewItems,
  collectPendingTaskReviewBlocks,
  collectReviewArtifactWarnings,
  type ReviewArtifactMeta,
} from "../review/artifact.ts";
import type { ResolveReviewResult, ResolvedReviewItem } from "../review/resolve.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const META: ReviewArtifactMeta = {
  milestoneId: "M-test",
  slice: "S05",
  sliceTitle: "review artifact",
  reviewedOn: "2026-07-10",
  rounds: 1,
};

function item(
  id: string,
  resolution: ResolvedReviewItem["resolution"],
  over: Partial<ResolvedReviewItem> = {},
): ResolvedReviewItem {
  return {
    id,
    pathLine: `src/${id}.ts:10`,
    severity: "high",
    claim: `claim ${id}`,
    suggestedFix: `fix ${id}`,
    challenge: `challenge ${id}?`,
    defense: { verdict: "refuted", rationale: `defense ${id}` },
    rebuttal: { verdict: "maintained", rationale: `rebuttal ${id}` },
    resolution,
    ...over,
  };
}

function result(items: ResolvedReviewItem[]): ResolveReviewResult {
  const counts = { resolved: 0, conceded: 0, open: 0 };
  for (const i of items) counts[i.resolution]++;
  return { noFlags: items.length === 0, items, counts, warnings: [] };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "forge-review-artifact-"));
}

// ── renderReview: golden with the 3 sections + omission ───────────────────────

describe("renderReview", () => {
  test("golden: all three sections, sorted by id, header outcome from counts", () => {
    const r = result([
      item("R3", "resolved", { rebuttal: { verdict: "withdrawn", rationale: "reviewer dropped it" } }),
      item("R1", "open", { challenge: "is it real?" }),
      item("R2", "conceded", { defense: { verdict: "conceded", rationale: "should validate input" } }),
    ]);
    const md = renderReview(META, r);
    const expected =
      "# S05: review artifact — Review (Dialectic)\n" +
      "**Slice:** S05  **Milestone:** M-test  **Reviewed:** 2026-07-10  **Rounds:** 1\n" +
      "**Outcome:** 1 resolved · 1 conceded · 1 open\n" +
      "\n" +
      "## Abertas — requerem decisão humana\n" +
      "> O reviewer e o autor não chegaram a acordo. Você decide.\n" +
      "### R1 — `src/R1.ts:10`\n" +
      "- **Objeção:** claim R1 — _is it real?_\n" +
      "- **Defesa:** defense R1\n" +
      "- **Réplica:** rebuttal R1\n" +
      "- **Decisão:** _pendente_\n" +
      "\n" +
      "## Concedidas — problema real, corrigido\n" +
      "### R2 — `src/R2.ts:10`\n" +
      "- **Objeção:** claim R2\n" +
      "- **Defesa:** conceded — should validate input\n" +
      "- **Correção:** _pendente_\n" +
      "\n" +
      "## Resolvidas no debate — sem ação\n" +
      "- R3 `src/R3.ts:10` — reviewer dropped it\n";
    assert.equal(md, expected);
  });

  test("omits sections with zero items", () => {
    const md = renderReview(META, result([item("R1", "open")]));
    assert.match(md, /## Abertas/);
    assert.doesNotMatch(md, /## Concedidas/);
    assert.doesNotMatch(md, /## Resolvidas/);
  });

  test("noFlags → clean artifact", () => {
    const md = renderReview(META, result([]));
    assert.match(md, /Reviewer found nothing to challenge\./);
    assert.match(md, /\*\*Outcome:\*\* 0 resolved · 0 conceded · 0 open/);
    assert.doesNotMatch(md, /## Abertas/);
  });

  test("renderReviewStub → review could not run", () => {
    const md = renderReviewStub(META, "challenger threw ENOENT");
    assert.match(md, /\*\*Outcome:\*\* review could not run/);
    assert.match(md, /> Review could not run: challenger threw ENOENT/);
  });

  test("pure: identical inputs → identical output (no Date drift)", () => {
    const r = result([item("R1", "open")]);
    assert.equal(renderReview(META, r), renderReview(META, r));
  });
});

// ── writeReview: atomic + idempotent, RE-EXECUTED (S04-R1/R3) ─────────────────

describe("writeReview", () => {
  test("path is milestone-namespaced by construction (S04-R2)", () => {
    const p = reviewArtifactPath("/cwd", "M-x", "S07");
    assert.match(p.replace(/\\/g, "/"), /\.gsd\/milestones\/M-x\/slices\/S07\/S07-REVIEW\.md$/);
  });

  test("first write created:true; second identical write created:false, zero rewrite", () => {
    const cwd = tmp();
    const content = renderReview(META, result([item("R1", "open")]));

    const first = writeReview(cwd, "M-test", "S05", content);
    assert.equal(first.created, true);
    assert.equal(readFileSync(first.path, "utf-8"), content);
    const mtime1 = statSync(first.path).mtimeMs;

    // RE-EXECUTE with byte-identical content → no write (compare PRE-mutation).
    const second = writeReview(cwd, "M-test", "S05", content);
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);
    const mtime2 = statSync(second.path).mtimeMs;
    assert.equal(mtime2, mtime1, "idempotent no-op must not rewrite the file");
  });

  test("changed content → created:true again", () => {
    const cwd = tmp();
    writeReview(cwd, "M-test", "S05", "a\n");
    const again = writeReview(cwd, "M-test", "S05", "b\n");
    assert.equal(again.created, true);
    assert.equal(readFileSync(again.path, "utf-8"), "b\n");
  });
});

// ── Write-backs: fail-before / pass-after + re-apply no-op (S04-R3) ────────────

describe("applyConcededFix / applyDecision", () => {
  function seed(): string {
    const cwd = tmp();
    const md = renderReview(
      META,
      result([
        item("R1", "open", { challenge: "real?" }),
        item("R2", "conceded"),
      ]),
    );
    writeReview(cwd, "M-test", "S05", md);
    return reviewArtifactPath(cwd, "M-test", "S05");
  }

  test("applyConcededFix stamps commit sha, then re-apply is a no-op", () => {
    const path = seed();
    assert.match(readFileSync(path, "utf-8"), /- \*\*Correção:\*\* _pendente_/); // before

    const first = applyConcededFix(path, "R2", { sha: "abc1234" });
    assert.equal(first.updated, true);
    assert.match(readFileSync(path, "utf-8"), /- \*\*Correção:\*\* aplicada — commit abc1234/); // after

    // RE-EXECUTE with the same outcome → no bytes change.
    const before = readFileSync(path, "utf-8");
    const again = applyConcededFix(path, "R2", { sha: "abc1234" });
    assert.equal(again.updated, false);
    assert.equal(readFileSync(path, "utf-8"), before);
  });

  test("applyConcededFix 'failed' → deferred marker", () => {
    const path = seed();
    const res = applyConcededFix(path, "R2", "failed");
    assert.equal(res.updated, true);
    assert.match(readFileSync(path, "utf-8"), /- \*\*Correção:\*\* falhou — deferida para triagem final/);
  });

  test("applyDecision stamps decision, then re-apply is a no-op", () => {
    const path = seed();
    assert.match(readFileSync(path, "utf-8"), /- \*\*Decisão:\*\* _pendente_/); // before

    const decision = "deferido → triagem no fim da milestone";
    const first = applyDecision(path, "R1", decision);
    assert.equal(first.updated, true);
    assert.match(readFileSync(path, "utf-8"), /- \*\*Decisão:\*\* deferido → triagem no fim da milestone/);

    const before = readFileSync(path, "utf-8");
    const again = applyDecision(path, "R1", decision);
    assert.equal(again.updated, false);
    assert.equal(readFileSync(path, "utf-8"), before);
  });

  test("unknown R# → updated:false, no throw", () => {
    const path = seed();
    const before = readFileSync(path, "utf-8");
    assert.equal(applyConcededFix(path, "R99", "failed").updated, false);
    assert.equal(applyDecision(path, "R99", "whatever").updated, false);
    assert.equal(readFileSync(path, "utf-8"), before);
  });

  test("absent file → updated:false, no throw", () => {
    assert.equal(applyDecision(join(tmp(), "nope.md"), "R1", "x").updated, false);
    assert.equal(applyConcededFix(join(tmp(), "nope.md"), "R1", "failed").updated, false);
  });
});

// ── collectPendingReviewItems: mixed markers + legacy + empty milestone ────────

describe("collectPendingReviewItems", () => {
  function writeArtifact(cwd: string, slice: string, body: string): void {
    const dir = join(cwd, ".gsd", "milestones", "M-test", "slices", slice);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slice}-REVIEW.md`), body, "utf-8");
  }

  test("collects open (current + legacy) and conceded-sem-fix, skips decided", () => {
    const cwd = tmp();

    // S05: one deferred-open, one failed-conceded, one decided (must be skipped).
    let md = renderReview(
      META,
      result([
        item("R1", "open", { challenge: "real?" }),
        item("R2", "conceded"),
        item("R3", "open", { challenge: "also?" }),
      ]),
    );
    writeArtifact(cwd, "S05", md);
    let path = reviewArtifactPath(cwd, "M-test", "S05");
    applyDecision(path, "R1", "deferido → triagem no fim da milestone");
    applyConcededFix(path, "R2", "failed");
    applyDecision(path, "R3", "refatorar agora — resolvido");

    // S06: legacy auto-mode marker (still honored).
    md = renderReview(META, result([item("R1", "open", { challenge: "legacy?" })]));
    writeArtifact(cwd, "S06", md.replace("S05", "S06"));
    applyDecision(reviewArtifactPath(cwd, "M-test", "S06"), "R1", "deferido (auto-mode)");

    const pending = collectPendingReviewItems(cwd, "M-test");
    assert.equal(pending.length, 3);

    const r1 = pending.find((p) => p.slice === "S05" && p.id === "R1");
    assert.ok(r1);
    assert.equal(r1!.status, "open");
    assert.equal(r1!.claim, "claim R1"); // challenge suffix stripped
    assert.equal(r1!.pathLine, "src/R1.ts:10");

    const r2 = pending.find((p) => p.id === "R2");
    assert.equal(r2!.status, "conceded-sem-fix");

    const legacy = pending.find((p) => p.slice === "S06");
    assert.equal(legacy!.status, "open");

    // The decided R3 is NOT pending.
    assert.equal(pending.find((p) => p.id === "R3"), undefined);
  });

  test("FRESH artifacts (renderReview's own _pendente_) are pending — the state production actually has (M8-close bug)", () => {
    // No applyDecision/applyConcededFix mutations: this is the artifact
    // exactly as the in-loop dialectic writes it. M8's first real triage
    // reported "nenhum item pendente" over 10 real items because only the
    // defer markers were recognized — never this fresh state.
    const cwd = tmp();
    const md = renderReview(META, result([item("R1", "open", { challenge: "real?" }), item("R2", "conceded")]));
    writeArtifact(cwd, "S05", md);

    const pending = collectPendingReviewItems(cwd, "M-test");
    assert.equal(pending.length, 2, "fresh open + fresh conceded must BOTH be pending");
    assert.equal(pending.find((p) => p.id === "R1")!.status, "open");
    assert.equal(pending.find((p) => p.id === "R2")!.status, "conceded-sem-fix");
  });

  test("milestone with no slices dir → [] (no throw)", () => {
    assert.deepEqual(collectPendingReviewItems(tmp(), "M-empty"), []);
  });

  test("truncated artifact is skipped, never throws", () => {
    const cwd = tmp();
    writeArtifact(cwd, "S05", "### R1 — `src/x.ts:1`\n"); // header only, no Objeção
    assert.deepEqual(collectPendingReviewItems(cwd, "M-test"), []);
  });
});

// ── collectReviewArtifactWarnings: partial parse (headings > blocks) — S01-R2 ──

describe("collectReviewArtifactWarnings", () => {
  function writeArtifact(cwd: string, slice: string, body: string): void {
    const dir = join(cwd, ".gsd", "milestones", "M-test", "slices", slice);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slice}-REVIEW.md`), body, "utf-8");
  }

  test("all blocks parse cleanly → no warning", () => {
    const cwd = tmp();
    const md = renderReview(META, result([item("R1", "open", { challenge: "real?" })]));
    writeArtifact(cwd, "S05", md);
    assert.deepEqual(collectReviewArtifactWarnings(cwd, "M-test"), []);
  });

  test("zero blocks parse from a visible ### R# heading → warns (pre-existing case)", () => {
    const cwd = tmp();
    writeArtifact(cwd, "S05", "### R1 malformed, no path/em-dash grammar\nsome text\n");
    const warnings = collectReviewArtifactWarnings(cwd, "M-test");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /S05.*não-parseáveis/);
  });

  // S01-R2 (review, conceded): one well-formed block plus one grammar-drifted
  // heading used to parse to >=1 block and suppress the warning entirely —
  // the drifted block's pending item silently vanished from triage.
  test("one valid block + one grammar-drifted heading → still warns (mix, not just total failure)", () => {
    const cwd = tmp();
    const good = renderReview(META, result([item("R1", "open", { challenge: "real?" })]));
    const drifted = "### R2 malformed heading, missing the path/em-dash grammar\nsome text\n";
    writeArtifact(cwd, "S05", `${good}\n${drifted}`);

    const warnings = collectReviewArtifactWarnings(cwd, "M-test");
    assert.equal(warnings.length, 1, "the mix must still surface a warning, not be masked by the one valid block");
    assert.match(warnings[0], /S05.*não-parseáveis/);
  });
});

// ── collectPendingReviewBlocks: same markers + verbatim dialogue + filters ─────

describe("collectPendingReviewBlocks", () => {
  function writeArtifact(cwd: string, slice: string, body: string): void {
    const dir = join(cwd, ".gsd", "milestones", "M-test", "slices", slice);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slice}-REVIEW.md`), body, "utf-8");
  }

  function seedTwoSlices(cwd: string): void {
    let md = renderReview(
      META,
      result([
        item("R1", "open", { challenge: "real?" }),
        item("R2", "conceded"),
        item("R3", "open", { challenge: "also?" }),
      ]),
    );
    writeArtifact(cwd, "S05", md);
    let path = reviewArtifactPath(cwd, "M-test", "S05");
    applyDecision(path, "R1", "deferido → triagem no fim da milestone");
    applyConcededFix(path, "R2", "failed");
    applyDecision(path, "R3", "refatorar agora — resolvido"); // decided, must not appear

    md = renderReview(META, result([item("R1", "open", { challenge: "legacy?" })]));
    writeArtifact(cwd, "S06", md.replace("S05", "S06"));
    applyDecision(reviewArtifactPath(cwd, "M-test", "S06"), "R1", "deferido (auto-mode)");
  }

  test("same pending set as collectPendingReviewItems, plus verbatim dialogue and reviewPath", () => {
    const cwd = tmp();
    seedTwoSlices(cwd);

    const items = collectPendingReviewItems(cwd, "M-test");
    const blocks = collectPendingReviewBlocks(cwd, "M-test");
    assert.equal(blocks.length, items.length);

    const r1 = blocks.find((b) => b.slice === "S05" && b.id === "R1");
    assert.ok(r1);
    assert.equal(r1!.status, "open");
    assert.equal(r1!.claim, "claim R1");
    assert.equal(r1!.reviewPath, reviewArtifactPath(cwd, "M-test", "S05"));
    // dialogue is the verbatim `### R#` block: header + all four dialogue fields.
    assert.match(r1!.dialogue, /^### R1 — `src\/R1\.ts:10`$/m);
    assert.match(r1!.dialogue, /- \*\*Objeção:\*\* claim R1 — _real\?_/);
    assert.match(r1!.dialogue, /- \*\*Defesa:\*\* defense R1/);
    assert.match(r1!.dialogue, /- \*\*Réplica:\*\* rebuttal R1/);
    assert.match(r1!.dialogue, /- \*\*Decisão:\*\* deferido → triagem no fim da milestone/);
    // dialogue does not bleed into the next block.
    assert.doesNotMatch(r1!.dialogue, /### R2/);

    const r2 = blocks.find((b) => b.id === "R2");
    assert.match(r2!.dialogue, /- \*\*Correção:\*\* falhou — deferida para triagem final/);

    // the decided R3 is not pending, and never leaks into an unrelated block's dialogue.
    assert.equal(blocks.find((b) => b.id === "R3"), undefined);
  });

  test("filter by slice", () => {
    const cwd = tmp();
    seedTwoSlices(cwd);
    const s06only = collectPendingReviewBlocks(cwd, "M-test", { slice: "S06" });
    assert.equal(s06only.length, 1);
    assert.equal(s06only[0].slice, "S06");
  });

  test("filter by id", () => {
    const cwd = tmp();
    seedTwoSlices(cwd);
    const r2only = collectPendingReviewBlocks(cwd, "M-test", { id: "R2" });
    assert.equal(r2only.length, 1);
    assert.equal(r2only[0].id, "R2");
    assert.equal(r2only[0].slice, "S05");
  });

  test("filter by slice AND id", () => {
    const cwd = tmp();
    seedTwoSlices(cwd);
    const both = collectPendingReviewBlocks(cwd, "M-test", { slice: "S06", id: "R1" });
    assert.equal(both.length, 1);
    assert.equal(both[0].slice, "S06");

    const noMatch = collectPendingReviewBlocks(cwd, "M-test", { slice: "S05", id: "R99" });
    assert.deepEqual(noMatch, []);
  });

  test("absent milestone → [] (no throw)", () => {
    assert.deepEqual(collectPendingReviewBlocks(tmp(), "M-empty"), []);
  });
});

// ── collectPendingTaskReviewItems/Blocks (S03/T03) — same grammar, task store ──

describe("collectPendingTaskReviewItems / collectPendingTaskReviewBlocks", () => {
  function writeTaskArtifact(cwd: string, taskId: string, body: string): void {
    const dir = join(cwd, ".gsd", "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${taskId}-REVIEW.md`), body, "utf-8");
  }

  function taskReviewPath(cwd: string, taskId: string): string {
    return join(cwd, ".gsd", "tasks", taskId, `${taskId}-REVIEW.md`);
  }

  const T1 = "T-20260709200551-m1-review-fix-m1r-1";
  const T2 = "T-20260710154451-aplicar-review-fix-m2";

  function seedTwoTasks(cwd: string): void {
    let md = renderReview(
      { ...META, slice: T1 },
      result([
        item("R1", "open", { challenge: "real?" }),
        item("R2", "conceded"),
        item("R3", "open", { challenge: "also?" }),
      ]),
    );
    writeTaskArtifact(cwd, T1, md);
    let path = taskReviewPath(cwd, T1);
    applyDecision(path, "R1", "deferido → triagem no fim da milestone");
    applyConcededFix(path, "R2", "failed");
    applyDecision(path, "R3", "refatorar agora — resolvido"); // decided: must not appear

    md = renderReview({ ...META, slice: T2 }, result([item("R1", "open", { challenge: "legacy?" })]));
    writeTaskArtifact(cwd, T2, md);
    applyDecision(taskReviewPath(cwd, T2), "R1", "deferido (auto-mode)");
  }

  test("collectPendingTaskReviewItems: collects open+conceded across tasks, skips decided, slice carries TASK_ID", () => {
    const cwd = tmp();
    seedTwoTasks(cwd);

    const pending = collectPendingTaskReviewItems(cwd);
    assert.equal(pending.length, 3);

    const r1 = pending.find((p) => p.slice === T1 && p.id === "R1");
    assert.ok(r1);
    assert.equal(r1!.status, "open");
    assert.equal(r1!.claim, "claim R1");

    const r2 = pending.find((p) => p.slice === T1 && p.id === "R2");
    assert.equal(r2!.status, "conceded-sem-fix");

    const legacy = pending.find((p) => p.slice === T2);
    assert.equal(legacy!.status, "open");

    assert.equal(pending.find((p) => p.slice === T1 && p.id === "R3"), undefined);
  });

  test("collectPendingTaskReviewItems: absent .gsd/tasks/ → [] (no throw)", () => {
    assert.deepEqual(collectPendingTaskReviewItems(tmp()), []);
  });

  test("collectPendingTaskReviewItems: unparseable/truncated file is skipped, never throws", () => {
    const cwd = tmp();
    writeTaskArtifact(cwd, T1, "### R1 — `src/x.ts:1`\n"); // header only, no Objeção
    assert.deepEqual(collectPendingTaskReviewItems(cwd), []);
  });

  test("collectPendingTaskReviewItems: a task dir with no REVIEW.md yet is skipped, never throws", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".gsd", "tasks", "T-20260711000000-mid-flight"), { recursive: true });
    assert.deepEqual(collectPendingTaskReviewItems(cwd), []);
  });

  test("collectPendingTaskReviewBlocks: same pending set, plus verbatim dialogue and reviewPath", () => {
    const cwd = tmp();
    seedTwoTasks(cwd);

    const items = collectPendingTaskReviewItems(cwd);
    const blocks = collectPendingTaskReviewBlocks(cwd);
    assert.equal(blocks.length, items.length);

    const r1 = blocks.find((b) => b.slice === T1 && b.id === "R1");
    assert.ok(r1);
    assert.equal(r1!.reviewPath, taskReviewPath(cwd, T1));
    assert.match(r1!.dialogue, /^### R1 — `src\/R1\.ts:10`$/m);
    assert.match(r1!.dialogue, /- \*\*Decisão:\*\* deferido → triagem no fim da milestone/);
    assert.doesNotMatch(r1!.dialogue, /### R2/);

    assert.equal(blocks.find((b) => b.slice === T1 && b.id === "R3"), undefined);
  });

  test("collectPendingTaskReviewBlocks: filter by taskId", () => {
    const cwd = tmp();
    seedTwoTasks(cwd);
    const t2only = collectPendingTaskReviewBlocks(cwd, { taskId: T2 });
    assert.equal(t2only.length, 1);
    assert.equal(t2only[0].slice, T2);
  });

  test("collectPendingTaskReviewBlocks: filter by id", () => {
    const cwd = tmp();
    seedTwoTasks(cwd);
    const r2only = collectPendingTaskReviewBlocks(cwd, { id: "R2" });
    assert.equal(r2only.length, 1);
    assert.equal(r2only[0].slice, T1);
  });

  test("collectPendingTaskReviewBlocks: filter by taskId AND id, no-match → []", () => {
    const cwd = tmp();
    seedTwoTasks(cwd);
    const both = collectPendingTaskReviewBlocks(cwd, { taskId: T2, id: "R1" });
    assert.equal(both.length, 1);
    assert.equal(both[0].slice, T2);

    const noMatch = collectPendingTaskReviewBlocks(cwd, { taskId: T1, id: "R99" });
    assert.deepEqual(noMatch, []);
  });

  test("collectPendingTaskReviewBlocks: absent .gsd/tasks/ → [] (no throw)", () => {
    assert.deepEqual(collectPendingTaskReviewBlocks(tmp()), []);
  });
});
