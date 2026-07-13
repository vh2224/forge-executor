# Test confidence stack

This document maps **what protects what** across local scripts and CI. Use it when you need merge confidence, not just a green `verify:pr`.

> **Fork note (M0, D8):** this is the Forge 2.0 fork's LEAN CI pipeline. Rust
> native builds are off (`GSD_NATIVE_DISABLE=1`), and the Windows/Docker/web-host
> lanes described in the upstream gsd-pi pipeline have been stripped along with
> the subsystems they tested (`web/`, native packaging, portability). See
> `.github/workflows/ci.yml` for the authoritative lane list.

## Quick reference

| When | Run locally | CI equivalent | Blocks merge? |
|------|-------------|---------------|---------------|
| Every push | `npm run verify:fast` | `fast-gates` | Yes |
| **Before requesting PR review** | `pnpm run build:core && npx tsc -p tsconfig.strip-gate.json --noEmit && pnpm run typecheck:extensions && node scripts/verify-pi-patches.cjs && node scripts/verify-no-deleted-imports.cjs && pnpm run test:ci` | `build` | Yes (when `heavy-code-changed`) |
| Repo-wide coverage report | `npm run test:coverage:full` | `Coverage report` workflow | Separate workflow |
| Coverage thresholds | `npm run test:coverage` | `Coverage report` workflow | Separate workflow |

Native/Windows/Docker lanes (`windows-portability`, `windows-smoke-e2e`,
Docker e2e) are **dropped for the fork** — native builds are disabled (D8) and
the subsystems they exercised (native packaging, Windows portability shims,
Docker e2e images) are out of scope for the stripped harness.

**Node 26+:** `c8` depends on `yargs` v17, which breaks under Node 26’s module resolution. The repo pins `yargs@^18` via `package.json` `overrides` (CI uses Node 24).

Run the inventory anytime:

```bash
npm run audit:test-confidence
npm run audit:test-confidence -- --strict   # fail if tier map drifts from package.json
npm run audit:test-gaps                     # unwired tests, zero-test extensions, thin packages
npm run audit:test-gaps -- --strict-unwired # fail if any test file is unwired/unknown
npm run audit:test-matrix                   # per-source-file status matrix
npm run audit:test-matrix -- --strict       # fail unless the audit matrix is fully covered
npm run audit:test-matrix -- --write-report # regenerate docs/dev/test-evaluation-report.md
```

`audit:test-matrix --strict` is the repo audit definition for source coverage:
zero untested source files, zero critical/high untested files, zero source
files mapped only to unwired tests, zero unwired test files, and zero
unreachable test files. A source file can count as `indirect` when a reachable
suite-level test covers its package, root area, or extension even without a
same-stem test file.

## Test runners by code area

| Code area | Test runner | Invoked by | Notes |
|-----------|-------------|------------|-------|
| `src/` + GSD extension | `node --test` on compiled `dist-test/` | `test:unit` | Primary app unit tests; compile via `test:compile` |
| Extension integration suites | `node --test` + `resolve-ts.mjs` | `test:integration` | ollama, async-jobs, browser-tools, search-the-web, bg-shell, slash-commands |
| `packages/*` | `node --test` (compiled to dist-test) | `test:packages` | Every linkable package must have ≥1 test (`verify:workspace-coverage`) |
| Extensions with ≥5 source files | `tests/*.test.*` required | `verify:extension-coverage` | Enforced in `verify:merge` |
| `scripts/__tests__` | `node --test` | `verify:fast` | CI contract/policy regressions |
| `tests/e2e/` | `node --test` against built binary | `test:e2e` | Requires `GSD_SMOKE_BINARY=dist/loader.js` |
| Coverage (merged) | c8 across unit/integration/packages | `test:coverage:full` | Writes `coverage/lcov.info` + `coverage/file-index.json` |
| Coverage thresholds | c8 on GSD slice | `test:coverage` | Manual/scheduled coverage workflow |

## Enforcement philosophy

### Block merge (PR)

When `heavy-code-changed=true`, CI runs the lean fork build/test stack in a
single `build` job, in this order:

1. Install dependencies (`pnpm install --frozen-lockfile`, `GSD_NATIVE_DISABLE=1`)
2. `pnpm run build:core` — compile the runnable binary
3. `npx tsc -p tsconfig.strip-gate.json --noEmit` — strip-gate typecheck
4. `pnpm run typecheck:extensions`
5. `node scripts/verify-pi-patches.cjs` — vendored `packages/pi-*` patch integrity
6. `node scripts/verify-no-deleted-imports.cjs` — anti-import guard for deleted trees
7. `pnpm run test:ci` — extended gate + fake smoke (`GSD_SMOKE_BINARY=dist/loader.js`)

Local parity: run the same steps in sequence, e.g.:

```bash
GSD_NATIVE_DISABLE=1 pnpm run build:core \
  && npx tsc -p tsconfig.strip-gate.json --noEmit \
  && pnpm run typecheck:extensions \
  && node scripts/verify-pi-patches.cjs \
  && node scripts/verify-no-deleted-imports.cjs \
  && GSD_SMOKE_BINARY=$(pwd)/dist/loader.js pnpm run test:ci
```

`verify:fast` also runs:

- `scripts/__tests__/`
- `audit:test-gaps --strict-unwired`
- `audit:test-matrix --strict`

### Coverage workflow

- `test:coverage` — c8 thresholds (40/40/20/20) on the GSD slice
- `test:coverage:full` — merged coverage artifacts
- Runs manually, weekly, or on PRs labeled `coverage`

### Path-gate

- **Doc-only PRs** — skip build/test jobs intentionally; `fast-gates` still runs
- `node22-smoke` — runs the smoke suite on the Node 22 engines floor after `build` succeeds

## Why `verify:pr` still exists

`verify:pr` is a **fast inner loop** (~5–15 min): `build:core` → `typecheck:extensions` → `test:unit`.

It is intentionally lighter than CI. Do not treat a passing `verify:pr` as merge-ready.

## Known gaps (honest)

These are tracked limitations, not bugs to hide:

1. **Native/Windows/Docker lanes** — dropped for the fork (D8, Rust native off); revisit if native builds are reintroduced
2. **Single-file extensions** — may rely on root-level suite coverage instead of dedicated extension-local tests

## Related docs

- [Test evaluation report](./test-evaluation-report.md) — regeneratable matrix snapshot
- [CI/CD Pipeline Guide](./ci-cd-pipeline.md) — promotion pipeline and workflow files
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — local development commands
