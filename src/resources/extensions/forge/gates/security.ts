/**
 * Forge security gate — deterministic keyword→domain detection + risk-level
 * classification + checklist skeleton.
 *
 * Native in-process port of the CORE of the 1.0 skill
 * `forge-agent/skills/forge-security/SKILL.md` (Step 2 domain table, Step 3
 * Blocker/Check tiers, Step 4 artefact format). Rewritten from the 1.0 skill
 * markdown into the forge namespace — this repo has NO `gsd/` import (the
 * condemned tree is never referenced).
 *
 * Design decision (S04-PLAN D-S04-3): only the CORE is ported natively —
 * keyword→domain detection, risk-level, and a structural skeleton. The 1.0
 * skill's LLM step (reading the plan and drafting specific, plan-traceable
 * items per domain) is deliberately NOT reproduced here. That enrichment is
 * deferred to the interactive flow / M3. The native skeleton emits one
 * placeholder Blocker item per active domain plus the domain's standard
 * Check-tier items, all explicitly marked "(advisory — native skeleton,
 * plan-specific redaction deferred)" so nobody mistakes them for
 * plan-traceable analysis.
 *
 * Exports:
 *   scanSecurity(planText, opts?) → SecurityScan   (pure)
 *   writeSecurityChecklist(cwd, mid, sid, scan, taskId?) → string  (writes artefact)
 *   types: SecurityDomain, SecurityScan, SecurityItem
 */

import { join } from "node:path";
import { writeFileAtomic } from "../state/ledger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** The 8 security domains ported from the 1.0 skill's Step 2 table. */
export type SecurityDomain =
  | "Authentication"
  | "Authorization"
  | "Data handling"
  | "Input validation"
  | "Secrets management"
  | "Injection"
  | "Frontend XSS"
  | "Transport / headers";

export type RiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** A single checklist item, native-skeleton placeholder. */
export interface SecurityItem {
  domain: SecurityDomain;
  tier: "Blocker" | "Check";
  text: string;
}

export interface SecurityScan {
  domains: SecurityDomain[];
  riskLevel: RiskLevel;
  blockers: SecurityItem[];
  checks: SecurityItem[];
}

export interface ScanSecurityOptions {
  /** Override current date for deterministic tests (ISO date, e.g. "2026-01-01"). */
  now?: Date;
}

// ── Step 2: domain → keyword table (1.0 SKILL.md, word-boundary match) ────────

const DOMAIN_KEYWORDS: Record<SecurityDomain, string[]> = {
  Authentication: [
    "auth",
    "login",
    "logout",
    "jwt",
    "oauth",
    "session",
    "token",
    "credential",
    "password",
    "register",
    "signup",
  ],
  Authorization: ["permission", "role", "rbac", "acl", "access control", "admin", "guard", "middleware", "policy"],
  "Data handling": ["encrypt", "decrypt", "hash", "salt", "crypto", "sensitive data", "pii", "personal info", "private key"],
  "Input validation": ["user input", "form submission", "query param", "search", "file upload", "body parsing", "sanitize"],
  "Secrets management": ["api key", "secret", "env var", ".env", "config", "credential storage"],
  Injection: ["database query", "raw sql", "orm bypass", "exec", "shell", "subprocess", "dynamic query"],
  "Frontend XSS": ["innerhtml", "dangerouslysetinnerhtml", "template rendering", "user-generated content", "markdown render"],
  "Transport / headers": ["http", "cors", "csp", "security headers", "certificate", "tls", "redirect"],
};

/** Deterministic domain order (matches 1.0 table order). */
const DOMAIN_ORDER: SecurityDomain[] = [
  "Authentication",
  "Authorization",
  "Data handling",
  "Input validation",
  "Secrets management",
  "Injection",
  "Frontend XSS",
  "Transport / headers",
];

/** Build a word-boundary regex for a keyword (keywords may contain spaces/dots). */
function keywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Multi-word / dotted keywords (e.g. "api key", ".env") use loose boundaries;
  // single-word keywords use strict \b word boundaries.
  if (/^[a-z0-9]+$/.test(keyword)) {
    return new RegExp(`\\b${escaped}\\b`, "i");
  }
  return new RegExp(escaped, "i");
}

const DOMAIN_REGEXES: Record<SecurityDomain, RegExp[]> = Object.fromEntries(
  DOMAIN_ORDER.map((d) => [d, DOMAIN_KEYWORDS[d].map(keywordRegex)]),
) as Record<SecurityDomain, RegExp[]>;

// ── Step 3: Blocker/Check skeleton per domain (native placeholders) ───────────

const SKELETON_SUFFIX = "(advisory — native skeleton, plan-specific redaction deferred)";

function skeletonBlocker(domain: SecurityDomain): SecurityItem {
  return {
    domain,
    tier: "Blocker",
    text: `Verify ${domain} handling implemented by this plan is sound ${SKELETON_SUFFIX}`,
  };
}

const CHECK_TEXT: Record<SecurityDomain, string> = {
  Authentication: "Failed auth returns 401, not a 500 with a stack trace",
  Authorization: "Role/permission checks cannot be bypassed via horizontal or vertical escalation",
  "Data handling": "Sensitive data is not logged or exposed in error responses",
  "Input validation": "All user-controlled input is validated/sanitized at the boundary",
  "Secrets management": "No secrets or API keys appear in source files or committed .env",
  Injection: "Queries/commands are parameterized — no raw string interpolation of user input",
  "Frontend XSS": "User-generated content is escaped before render — no raw innerHTML of untrusted input",
  "Transport / headers": "CORS/CSP/TLS configuration rejects unauthorized origins and weak ciphers",
};

function skeletonCheck(domain: SecurityDomain): SecurityItem {
  return { domain, tier: "Check", text: `${CHECK_TEXT[domain]} ${SKELETON_SUFFIX}` };
}

// ── Public: scanSecurity ────────────────────────────────────────────────────

/**
 * Pure scan: maps `planText` to the 8 domains via the keyword table, excludes
 * zero-match domains, classifies risk-level deterministically, and derives the
 * native skeleton (one Blocker placeholder + the domain's standard Check item
 * per active domain). No side effects.
 */
export function scanSecurity(planText: string, _opts: ScanSecurityOptions = {}): SecurityScan {
  const text = planText.toLowerCase();

  const domains: SecurityDomain[] = DOMAIN_ORDER.filter((d) => DOMAIN_REGEXES[d].some((re) => re.test(text)));

  const riskLevel = classifyRisk(domains);

  const blockers = domains.map(skeletonBlocker);
  const checks = domains.map(skeletonCheck);

  return { domains, riskLevel, blockers, checks };
}

/**
 * HIGH if Authentication/Authorization/Data handling active (auth/authz/crypto);
 * MEDIUM if Input validation or Secrets management active (and no HIGH domain);
 * LOW if only Transport/headers and/or Injection/Frontend XSS active (and
 * neither HIGH nor MEDIUM domains present) — any active domain at all that
 * isn't HIGH/MEDIUM still yields at minimum LOW;
 * NONE if domains is empty.
 */
function classifyRisk(domains: SecurityDomain[]): RiskLevel {
  if (domains.length === 0) return "NONE";
  const HIGH_DOMAINS: SecurityDomain[] = ["Authentication", "Authorization", "Data handling"];
  const MEDIUM_DOMAINS: SecurityDomain[] = ["Input validation", "Secrets management"];
  if (domains.some((d) => HIGH_DOMAINS.includes(d))) return "HIGH";
  if (domains.some((d) => MEDIUM_DOMAINS.includes(d))) return "MEDIUM";
  return "LOW";
}

// ── Public: writeSecurityChecklist ──────────────────────────────────────────

function sliceDir(cwd: string, mid: string, sid: string): string {
  return join(cwd, ".gsd", "milestones", mid, "slices", sid);
}

function taskDir(cwd: string, mid: string, sid: string, taskId: string): string {
  return join(sliceDir(cwd, mid, sid), "tasks", taskId);
}

const RISK_EXPLAINER = "(HIGH = auth/authz/crypto in scope; MEDIUM = input validation or secrets; LOW = transport/headers only)";

function renderDomainsBlock(scan: SecurityScan, unitId: string, title: string, generatedDate: string): string {
  if (scan.domains.length === 0) {
    return (
      `# Security Checklist — ${unitId}: ${title}\n\n` +
      `**Generated:** ${generatedDate}\n` +
      `**Result:** No security-sensitive scope detected in this task. No checklist required.\n`
    );
  }

  const blockersByDomain = scan.domains
    .map((d) => {
      const items = scan.blockers.filter((b) => b.domain === d);
      if (items.length === 0) return "";
      const lines = items.map((i) => `- [ ] ${i.text}`).join("\n");
      return `### ${d}\n${lines}\n`;
    })
    .filter(Boolean)
    .join("\n");

  const checksLines = scan.checks.map((i) => `- [ ] ${i.text} — domain: ${i.domain}`).join("\n");

  return (
    `# Security Checklist — ${unitId}: ${title}\n\n` +
    `**Domains in scope:** ${scan.domains.join(", ")}\n` +
    `**Generated:** ${generatedDate}\n` +
    `**Risk level:** ${scan.riskLevel}\n\n` +
    `*${RISK_EXPLAINER}*\n\n` +
    `## Blockers — resolve before marking complete\n` +
    `*(Native skeleton — plan-specific redaction deferred, D-S04-3)*\n\n` +
    `${blockersByDomain}\n` +
    `## Also verify\n` +
    `*(Check-tier items for the active domains)*\n\n` +
    `${checksLines}\n`
  );
}

/**
 * Write `T##-SECURITY.md` (when `taskId` is given) or `S##-SECURITY.md`
 * (slice-level) in the 1.0 artefact format. The only side-effect in this
 * module — writes via `writeFileAtomic` (atomic + deterministic path).
 * Idempotent: given the same `scan` and the same `generatedDate` (default:
 * current date, `YYYY-MM-DD`), re-running produces a byte-identical file.
 */
export function writeSecurityChecklist(
  cwd: string,
  mid: string,
  sid: string,
  scan: SecurityScan,
  taskId?: string,
  opts: { title?: string; now?: Date } = {},
): string {
  const unitId = taskId ?? sid;
  const title = opts.title ?? unitId;
  const generatedDate = (opts.now ?? new Date()).toISOString().slice(0, 10);

  const dir = taskId ? taskDir(cwd, mid, sid, taskId) : sliceDir(cwd, mid, sid);
  const filename = taskId ? `${taskId}-SECURITY.md` : `${sid}-SECURITY.md`;
  const target = join(dir, filename);

  const content = renderDomainsBlock(scan, unitId, title, generatedDate);
  writeFileAtomic(target, content);
  return target;
}
