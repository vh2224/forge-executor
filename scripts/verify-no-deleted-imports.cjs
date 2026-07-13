#!/usr/bin/env node
'use strict'

// Anti-import guard (M0 acceptance #3 / SCOPE A5).
// Walks KEPT source scan roots and fails if any import/require/export-from
// (static or dynamic) specifier references a deleted tree.
// CJS, node:fs/node:path only — no deps.

const { readdirSync, readFileSync, statSync } = require('fs')
const { join, extname } = require('path')

const ROOT = join(__dirname, '..')

const SCAN_ROOTS = [
  'src',
  'packages/forge-agent-core',
  'packages/forge-agent-modes',
  'packages/contracts',
  'packages/rpc-client',
  'packages/mcp-server',
  'tests',
  'scripts',
]

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'dist-test'])

// This guard file itself must never flag its own probe fixtures/content.
const SELF_PATH = join(ROOT, 'scripts', 'verify-no-deleted-imports.cjs')

// Deleted-tree path fragments. Any specifier CONTAINING one of these is a hit.
const DELETED_FRAGMENTS = [
  'resources/extensions/gsd/',
  'resources/extensions/github-sync/',
  'resources/extensions/remote-questions/',
  'src/web/',
  '/web/',
  '/studio/',
  'vscode-extension',
  'packages/daemon',
  'cloud-mcp-gateway',
  'integrations/',
  'gsd-orchestrator',
  'src/headless',
]

// Explicit false-positive exclusions — never flag these even if a fragment
// substring were to coincidentally appear.
const EXCLUDE_SPECIFIER_PATTERNS = [
  /^@gsd\/agent-core(\/|$)/, // frozen vendored seam token, aliased to @forge/agent-core
  /^@gsd\/pi-/,
  /^@opengsd\//,
  /^\.gsd\//,
]

// Matches import/export-from/require/dynamic-import STATEMENTS and captures
// the specifier string, so we never trip on comments or markdown prose.
const STATEMENT_PATTERNS = [
  // import ... from "x"; / import "x";
  /\bimport\s+(?:[^'"()]*?\bfrom\s+)?["']([^"']+)["']/g,
  // export ... from "x";
  /\bexport\s+(?:[^'"()]*?\bfrom\s+)?["']([^"']+)["']/g,
  // require("x")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  // dynamic import("x")
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
]

function isExcludedSpecifier(specifier) {
  return EXCLUDE_SPECIFIER_PATTERNS.some((re) => re.test(specifier))
}

function isDeletedSpecifier(specifier) {
  if (isExcludedSpecifier(specifier)) return false
  return DELETED_FRAGMENTS.some((frag) => specifier.includes(frag))
}

function walk(dir, fn) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, fn)
      continue
    }
    if (!entry.isFile()) continue
    if (full === SELF_PATH) continue
    if (entry.name.endsWith('.d.ts')) continue
    if (!SCAN_EXTENSIONS.has(extname(entry.name))) continue
    fn(full)
  }
}

function scanFile(file, failures) {
  const content = readFileSync(file, 'utf8')
  const lines = content.split('\n')

  for (const pattern of STATEMENT_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1]
      if (!isDeletedSpecifier(specifier)) continue
      const upto = content.slice(0, match.index)
      const lineNo = upto.split('\n').length
      failures.push({
        file: file.replace(ROOT + '/', ''),
        line: lineNo,
        specifier,
      })
    }
  }
  // lines is unused beyond computing line numbers via upto; keep for clarity.
  void lines
}

function main() {
  const failures = []

  for (const root of SCAN_ROOTS) {
    const abs = join(ROOT, root)
    try {
      statSync(abs)
    } catch {
      continue
    }
    walk(abs, (file) => scanFile(file, failures))
  }

  if (failures.length) {
    process.stderr.write('Anti-import guard: found imports of deleted trees:\n')
    for (const f of failures) {
      process.stderr.write(`${f.file}:${f.line}  ${f.specifier}\n`)
    }
    process.exit(1)
  }

  process.stdout.write('OK: no imports of deleted trees found.\n')
  process.exit(0)
}

main()
