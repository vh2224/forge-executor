import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { formatReviewDigest } from "../ui/review-digest.ts";
import {
  renderReview,
  writeReview,
  reviewArtifactPath,
  applyDecision,
  applyConcededFix,
  type ReviewArtifactMeta,
} from "../review/artifact.ts";
import type { ResolveReviewResult, ResolvedReviewItem } from "../review/resolve.ts";

// ── Fixtures — same grammar as tests/review-artifact.test.ts: render via the
// artifact layer, then write-back the pending/conceded markers with the real
// write-backs, never hand-typed markdown. ──────────────────────────────────

function meta(slice: string): ReviewArtifactMeta {
  return {
    milestoneId: "M-test",
    slice,
    sliceTitle: "toy slice",
    reviewedOn: "2026-07-12",
    rounds: 1,
  };
}

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
  return mkdtempSync(join(tmpdir(), "forge-review-digest-"));
}

describe("formatReviewDigest", () => {
  test("no .gsd at all → [] (no throw)", () => {
    const cwd = tmp();
    try {
      assert.deepEqual(formatReviewDigest(cwd, "M-toy"), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("empty milestoneId → [] (no throw)", () => {
    const cwd = tmp();
    try {
      assert.deepEqual(formatReviewDigest(cwd, ""), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("milestone with no pending items → []", () => {
    const cwd = tmp();
    try {
      const md = renderReview(meta("S06"), result([item("R1", "open", { challenge: "real?" })]));
      const written = writeReview(cwd, "M-test", "S06", md);
      applyDecision(written.path, "R1", "refatorar agora — resolvido"); // decided
      assert.deepEqual(formatReviewDigest(cwd, "M-test"), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("one open item → header + R#(S##) line + relative path to the origin REVIEW.md", () => {
    const cwd = tmp();
    try {
      const md = renderReview(meta("S06"), result([item("R1", "open", { challenge: "real?" })]));
      const written = writeReview(cwd, "M-test", "S06", md);
      applyDecision(written.path, "R1", "deferido → triagem no fim da milestone");

      const out = formatReviewDigest(cwd, "M-test");
      assert.equal(out.length, 3);
      assert.match(out[0], /^⚖ 1 aberta\(s\) — triagem de review pendente · \/forge fix$/);
      assert.match(out[1], /^ {2}R1 \(S06\): claim R1$/);
      const expectedPath = relative(cwd, reviewArtifactPath(cwd, "M-test", "S06"));
      assert.equal(out[2], `    ↳ ${expectedPath}`);
      assert.match(out[2], /S06-REVIEW\.md$/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("pending items across two slices → both appear, count is 2", () => {
    const cwd = tmp();
    try {
      const md1 = renderReview(meta("S06"), result([item("R1", "open", { challenge: "real?" })]));
      const w1 = writeReview(cwd, "M-test", "S06", md1);
      applyDecision(w1.path, "R1", "deferido → triagem no fim da milestone");

      const md2 = renderReview(meta("S07"), result([item("R1", "conceded")]));
      const w2 = writeReview(cwd, "M-test", "S07", md2);
      applyConcededFix(w2.path, "R1", "failed");

      const out = formatReviewDigest(cwd, "M-test");
      assert.match(out[0], /^⚖ 2 aberta\(s\)/);
      const joined = out.join("\n");
      assert.match(joined, /R1 \(S06\): claim R1$/m);
      assert.match(joined, /R1 \(S07\): claim R1 · concedida — fix pendente$/m);
      assert.match(joined, /S06-REVIEW\.md$/m);
      assert.match(joined, /S07-REVIEW\.md$/m);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("conceded-sem-fix item gets the '· concedida — fix pendente' suffix", () => {
    const cwd = tmp();
    try {
      const md = renderReview(meta("S06"), result([item("R2", "conceded")]));
      const written = writeReview(cwd, "M-test", "S06", md);
      applyConcededFix(written.path, "R2", "failed");

      const out = formatReviewDigest(cwd, "M-test");
      assert.match(out[1], /R2 \(S06\): claim R2 · concedida — fix pendente$/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("item with a filled-in Decisão does not appear", () => {
    const cwd = tmp();
    try {
      const md = renderReview(
        meta("S06"),
        result([
          item("R1", "open", { challenge: "real?" }),
          item("R2", "open", { challenge: "also?" }),
        ]),
      );
      const written = writeReview(cwd, "M-test", "S06", md);
      applyDecision(written.path, "R1", "deferido → triagem no fim da milestone"); // stays pending
      applyDecision(written.path, "R2", "refatorar agora — resolvido"); // decided — must vanish

      const out = formatReviewDigest(cwd, "M-test");
      assert.match(out[0], /^⚖ 1 aberta\(s\)/);
      assert.doesNotMatch(out.join("\n"), /R2/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("long claim is truncated with an ellipsis", () => {
    const cwd = tmp();
    try {
      const longClaim = "x".repeat(120);
      const md = renderReview(
        meta("S06"),
        result([item("R1", "open", { challenge: "real?", claim: longClaim })]),
      );
      const written = writeReview(cwd, "M-test", "S06", md);
      applyDecision(written.path, "R1", "deferido → triagem no fim da milestone");

      const out = formatReviewDigest(cwd, "M-test");
      assert.match(out[1], /…$/);
      assert.ok(out[1].length <= 100, `expected a truncated line, got length ${out[1].length}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
