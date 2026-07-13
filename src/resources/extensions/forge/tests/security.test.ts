/**
 * `gates/security.ts` — unit tests for `scanSecurity` / `writeSecurityChecklist`
 * (S04-T02, D-S04-3 core-native security gate).
 *
 * Proves: (1) deterministic keyword→domain activation per domain, zero-match
 * domains excluded; (2) risk-level classification HIGH/MEDIUM/LOW/NONE by
 * domain mix; (3) the zero-domain case produces an explicit "no scope"
 * checklist body, not an error; (4) `writeSecurityChecklist` writes
 * `T##-SECURITY.md` / `S##-SECURITY.md` atomically and idempotently.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSecurity, writeSecurityChecklist, type SecurityScan } from "../gates/security.ts";

const MID = "M-20260101000000-toy";
const SID = "S01";
const TID = "T01";

function withSandbox<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-security-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scanSecurity — domain activation", () => {
  test("Authentication activates on jwt/login keywords", () => {
    const scan = scanSecurity("Implement JWT login flow with refresh token rotation.");
    assert.ok(scan.domains.includes("Authentication"));
  });

  test("Authorization activates on rbac/role keywords", () => {
    const scan = scanSecurity("Add role-based access control (RBAC) guard middleware.");
    assert.ok(scan.domains.includes("Authorization"));
  });

  test("Data handling activates on encrypt/hash keywords", () => {
    const scan = scanSecurity("Hash and encrypt PII before storing at rest.");
    assert.ok(scan.domains.includes("Data handling"));
  });

  test("Input validation activates on file upload / sanitize keywords", () => {
    const scan = scanSecurity("Sanitize file upload body parsing for the form submission endpoint.");
    assert.ok(scan.domains.includes("Input validation"));
  });

  test("Secrets management activates on api key / .env keywords", () => {
    const scan = scanSecurity("Load the api key from .env, never hardcode secrets.");
    assert.ok(scan.domains.includes("Secrets management"));
  });

  test("Injection activates on raw sql / exec keywords", () => {
    const scan = scanSecurity("Avoid raw sql string interpolation; never exec a dynamic query.");
    assert.ok(scan.domains.includes("Injection"));
  });

  test("Frontend XSS activates on dangerouslySetInnerHTML keyword", () => {
    const scan = scanSecurity("Render markdown via dangerouslySetInnerHTML for user-generated content.");
    assert.ok(scan.domains.includes("Frontend XSS"));
  });

  test("Transport / headers activates on cors/tls keywords", () => {
    const scan = scanSecurity("Configure CORS and enforce TLS with strict security headers.");
    assert.ok(scan.domains.includes("Transport / headers"));
  });

  test("domains with zero matches are excluded from the result", () => {
    const scan = scanSecurity("Configure CORS and enforce TLS with strict security headers.");
    assert.ok(!scan.domains.includes("Authentication"));
    assert.ok(!scan.domains.includes("Injection"));
    assert.equal(scan.domains.length, 1);
  });

  test("plain-word keywords use word-boundary matching (no substring false positives)", () => {
    // "administer" contains "admin" as substring but must NOT match \badmin\b.
    const scan = scanSecurity("We administer the cluster nodes and rotate backups.");
    assert.ok(!scan.domains.includes("Authorization"));
  });
});

describe("scanSecurity — risk-level classification", () => {
  test("HIGH when Authentication (auth) is active", () => {
    const scan = scanSecurity("Implement JWT login with session token support.");
    assert.equal(scan.riskLevel, "HIGH");
  });

  test("HIGH when Authorization (authz) is active", () => {
    const scan = scanSecurity("Add an admin RBAC guard middleware policy.");
    assert.equal(scan.riskLevel, "HIGH");
  });

  test("HIGH when Data handling (crypto) is active", () => {
    const scan = scanSecurity("Encrypt and hash the private key material.");
    assert.equal(scan.riskLevel, "HIGH");
  });

  test("MEDIUM when only Input validation is active", () => {
    const scan = scanSecurity("Sanitize the search query param on form submission.");
    assert.equal(scan.riskLevel, "MEDIUM");
  });

  test("MEDIUM when only Secrets management is active", () => {
    const scan = scanSecurity("Store the api key as an env var, never in config.");
    assert.equal(scan.riskLevel, "MEDIUM");
  });

  test("LOW when only Transport/headers is active", () => {
    const scan = scanSecurity("Configure CORS and TLS certificate rotation.");
    assert.equal(scan.riskLevel, "LOW");
  });

  test("HIGH wins over MEDIUM/LOW when domains mix", () => {
    const scan = scanSecurity("JWT login flow; also configure CORS headers and sanitize form submission input.");
    assert.equal(scan.riskLevel, "HIGH");
  });

  test("MEDIUM wins over LOW when no HIGH domain present", () => {
    const scan = scanSecurity("Sanitize the file upload body parsing; also configure CORS security headers.");
    assert.equal(scan.riskLevel, "MEDIUM");
  });

  test("no active domain → NONE risk level, empty domains, explicit (not error)", () => {
    const scan = scanSecurity("Rename a variable and update a comment in the README.");
    assert.deepEqual(scan.domains, []);
    assert.equal(scan.riskLevel, "NONE");
    assert.deepEqual(scan.blockers, []);
    assert.deepEqual(scan.checks, []);
  });
});

describe("scanSecurity — purity", () => {
  test("scanSecurity is pure — same input yields deep-equal output, no side effects", () => {
    const input = "Implement JWT login with RBAC guard and encrypt PII at rest.";
    const a = scanSecurity(input);
    const b = scanSecurity(input);
    assert.deepEqual(a, b);
  });
});

describe("writeSecurityChecklist — artefact", () => {
  test("writes T##-SECURITY.md with domains/risk-level/blockers/checks when domains active", () => {
    withSandbox((cwd) => {
      const scan = scanSecurity("Implement JWT login flow with session token support.");
      const target = writeSecurityChecklist(cwd, MID, SID, scan, TID, { now: new Date("2026-01-05T00:00:00Z") });
      assert.ok(existsSync(target));
      assert.ok(target.endsWith(join("tasks", TID, `${TID}-SECURITY.md`)));
      const content = readFileSync(target, "utf-8");
      assert.match(content, /Domains in scope:.*Authentication/);
      assert.match(content, /Risk level:\*\*\s*HIGH/);
      assert.match(content, /## Blockers/);
      assert.match(content, /## Also verify/);
      assert.match(content, /Generated:\*\*\s*2026-01-05/);
    });
  });

  test("writes S##-SECURITY.md at slice level when taskId is omitted", () => {
    withSandbox((cwd) => {
      const scan = scanSecurity("Configure CORS and TLS headers.");
      const target = writeSecurityChecklist(cwd, MID, SID, scan, undefined, { now: new Date("2026-01-05T00:00:00Z") });
      assert.ok(existsSync(target));
      assert.ok(target.endsWith(join("slices", SID, `${SID}-SECURITY.md`)));
    });
  });

  test("zero-domain scan writes explicit 'No security-sensitive scope detected' body, not an error", () => {
    withSandbox((cwd) => {
      const scan = scanSecurity("Rename a variable and update a comment.");
      const target = writeSecurityChecklist(cwd, MID, SID, scan, TID, { now: new Date("2026-01-05T00:00:00Z") });
      const content = readFileSync(target, "utf-8");
      assert.match(content, /No security-sensitive scope detected/);
      assert.doesNotMatch(content, /## Blockers/);
      assert.doesNotMatch(content, /Domains in scope:/);
    });
  });

  test("idempotent — re-run with the same scan + fixed date is byte-identical", () => {
    withSandbox((cwd) => {
      const scan: SecurityScan = scanSecurity("Implement JWT login with an admin RBAC guard.");
      const now = new Date("2026-01-05T00:00:00Z");
      const a = readFileSync(writeSecurityChecklist(cwd, MID, SID, scan, TID, { now }), "utf-8");
      const b = readFileSync(writeSecurityChecklist(cwd, MID, SID, scan, TID, { now }), "utf-8");
      assert.equal(a, b);
    });
  });

  test("idempotent for the zero-domain case too", () => {
    withSandbox((cwd) => {
      const scan = scanSecurity("Update README wording only.");
      const now = new Date("2026-01-05T00:00:00Z");
      const a = readFileSync(writeSecurityChecklist(cwd, MID, SID, scan, TID, { now }), "utf-8");
      const b = readFileSync(writeSecurityChecklist(cwd, MID, SID, scan, TID, { now }), "utf-8");
      assert.equal(a, b);
    });
  });
});
