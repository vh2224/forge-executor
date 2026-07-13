import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { evidenceEventFor } from "../verify/evidence.ts";

// ── evidenceEventFor ─────────────────────────────────────────────────────────

describe("evidenceEventFor", () => {
  test("builds an ok evidence event when isError is false", () => {
    const event = evidenceEventFor("T01", { toolName: "Bash", isError: false }, "2026-07-10T00:00:00Z");
    assert.equal(event.kind, "evidence");
    assert.equal(event.unit, "T01");
    assert.equal(event.status, "ok");
    assert.equal(event.ts, "2026-07-10T00:00:00Z");
    assert.match(event.summary, /Bash/);
    assert.match(event.summary, /ok/);
  });

  test("builds an error evidence event when isError is true", () => {
    const event = evidenceEventFor("T02", { toolName: "Edit", isError: true }, "2026-07-10T01:00:00Z");
    assert.equal(event.status, "error");
    assert.match(event.summary, /Edit/);
    assert.match(event.summary, /falhou/);
  });

  test("empty toolName produces a stable event without throwing", () => {
    assert.doesNotThrow(() => evidenceEventFor("T03", { toolName: "", isError: false }, "2026-07-10T02:00:00Z"));
    const event = evidenceEventFor("T03", { toolName: "", isError: false }, "2026-07-10T02:00:00Z");
    assert.match(event.summary, /\?/);
    assert.equal(event.status, "ok");
  });

  test("missing/undefined toolName does not throw and degrades to '?'", () => {
    // @ts-expect-error — exercising runtime robustness against malformed input
    assert.doesNotThrow(() => evidenceEventFor("T04", { isError: false }, "2026-07-10T03:00:00Z"));
    // @ts-expect-error — exercising runtime robustness against malformed input
    const event = evidenceEventFor("T04", { isError: false }, "2026-07-10T03:00:00Z");
    assert.match(event.summary, /\?/);
  });

  test("ts parameter is reflected verbatim in the event, never synthesized", () => {
    const ts = "2099-01-01T12:34:56.000Z";
    const event = evidenceEventFor("T05", { toolName: "Grep", isError: false }, ts);
    assert.equal(event.ts, ts);
  });

  test("defaults milestone to empty string when not supplied", () => {
    const event = evidenceEventFor("T06", { toolName: "Read", isError: false }, "2026-07-10T04:00:00Z");
    assert.equal(event.milestone, "");
  });

  test("honors an explicit milestone parameter", () => {
    const event = evidenceEventFor("T07", { toolName: "Write", isError: false }, "2026-07-10T05:00:00Z", "M001");
    assert.equal(event.milestone, "M001");
  });

  test("agent is always 'forge-worker'", () => {
    const event = evidenceEventFor("T08", { toolName: "Bash", isError: false }, "2026-07-10T06:00:00Z");
    assert.equal(event.agent, "forge-worker");
  });

  test("is deterministic across repeated calls with the same input", () => {
    const args = ["T09", { toolName: "Bash", isError: true }, "2026-07-10T07:00:00Z"] as const;
    const r1 = evidenceEventFor(...args);
    const r2 = evidenceEventFor(...args);
    assert.deepEqual(r1, r2);
  });
});
