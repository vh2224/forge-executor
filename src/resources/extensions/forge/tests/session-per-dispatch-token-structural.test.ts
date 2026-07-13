import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkPerDispatchTokens,
  PER_DISPATCH_FIELDS,
  NON_DISPATCH_FIELDS,
  ACCEPTED_WITHOUT_TOKEN,
} from "./helpers/per-dispatch-token-contract.ts";

const SESSION_SOURCE = fileURLToPath(new URL("../auto/session.ts", import.meta.url));
const SESSION_SOURCE_FALLBACK = SESSION_SOURCE.replace(/\/dist-test\//u, "/").replace(/\.js$/u, ".ts");

test("ForgeAutoSession classifies every source field and pairs dispatch decisions with tokens", () => {
  const sourcePath = existsSync(SESSION_SOURCE) && readFileSync(SESSION_SOURCE, "utf8").includes("active = false")
    ? SESSION_SOURCE
    : SESSION_SOURCE_FALLBACK;
  const result = checkPerDispatchTokens(readFileSync(sourcePath, "utf8"), {
    perDispatch: PER_DISPATCH_FIELDS,
    nonDispatch: NON_DISPATCH_FIELDS,
    allowlist: ACCEPTED_WITHOUT_TOKEN,
  });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(Object.keys(ACCEPTED_WITHOUT_TOKEN).sort(), [
    "baselineThinkingLevel",
    "effortApplied",
    "providerReadiness",
    "resolvedDispatchAuthor",
    "resolvedDispatchEffort",
  ]);
});

test("the structural guard bites on a new unpaired per-dispatch field", () => {
  const fixture = `class ForgeAutoSession {
  active = false;
  fakeDispatchDecision: string | null = null;
  reset(): void {}
}`;
  const result = checkPerDispatchTokens(fixture, {
    perDispatch: ["fakeDispatchDecision"],
    nonDispatch: ["active"],
    allowlist: {},
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /fakeDispatchDecision/);
  assert.match(result.failures[0], /Campo por-dispatch exige token\/epoch/);
});
