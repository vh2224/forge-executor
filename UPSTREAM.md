# UPSTREAM.md — sync flows and governance

This document describes how this fork stays synchronized with its two upstream
sources, and the mechanism that prevents unreviewed upstream drift from silently
breaking the fork. It is the authoritative pointer for maintainers; the actual
allowlist data lives in `scripts/pi-upstream.json` (never duplicated here).

## Lineage

Three layers, oldest to newest:

1. **[earendil-works/pi](https://github.com/earendil-works/pi)** — the upstream
   agent-loop/TUI harness. Vendored into `packages/pi-*` (see Flow A below).
2. **[gsd-pi](https://github.com/open-gsd/gsd-pi)** (Open GSD) — the fork this
   repo itself forks from. Its GSD extension and methodology code are cherry-picked
   into this fork on demand (see Flow B below).
3. **This fork (Forge 2.0)** — the harness core plus the new Forge methodology
   extension, replacing the condemned `gsd` extension.

See `NOTICE` for the full MIT attribution chain, and
`docs/forge/FORGE2-DECISIONS.md` (decision D9) for the rationale behind keeping
deliberate, tracked upstream sync instead of silently drifting.

## Flow A — earendil-works/pi → packages/pi-* (vendoring)

Four upstream packages are vendored verbatim (minus an explicit patch allowlist)
into this repo under `packages/pi-*`. The mapping from upstream path to vendored
path, and from vendored path to the `@gsd/*` npm package name, is defined in
`scripts/pi-upstream.json` (`packageMap` / `gsdPackageNames`) — that JSON file is
the single source of truth; do not hand-copy the table here.

- **Upstream repository:** `https://github.com/earendil-works/pi`
- **Pinned ref:** `v0.75.5` (see `pinnedRef` in `scripts/pi-upstream.json`)
- **Vendored packages:** 4 — `packages/agent`, `packages/ai`, `packages/tui`,
  `packages/coding-agent` from upstream, landing as `packages/pi-agent-core`,
  `packages/pi-ai`, `packages/pi-tui`, `packages/pi-coding-agent` in this repo
  (exact mapping: `packageMap` in `scripts/pi-upstream.json`).
- **Sync command:** `node scripts/vendor-pi.cjs [--ref v0.75.5] [--dry-run]`.
  It shallow-clones/updates the upstream repo under `.cache/pi-upstream`, copies
  the four upstream package directories into `packages/pi-*`, and preserves the
  GSD-scoped `package.json` name/scope fields so the vendored packages keep
  publishing as `@gsd/pi-*`.
- **Prerequisite:** ADR-010 clean seam must be complete (GSD-specific code lives
  in `packages/gsd-agent-core` / `packages/gsd-agent-modes`, listed as
  `protectedPaths` in the manifest) before running a vendoring sync.
- **Rule (iron rule 1 in `CLAUDE.md`):** `packages/pi-*` is vendored source.
  Any change to its `src/` or `test/` files that is not on the patch allowlist
  breaks CI (`verify-pi-patches`). The correct place for new fork-specific code
  is `packages/gsd-agent-*` (future `packages/forge-agent-*`) or an extension —
  never a raw edit inside `packages/pi-*`.

## Patch allowlist

Because the vendored packages are meant to track upstream diff-for-diff, any
local modification to `packages/pi-*` source or test files must be declared
explicitly. The allowlist:

- **Lives in:** `scripts/pi-upstream.json`, field `patchAllowlist` — an array of
  exact file paths and glob patterns (e.g. `packages/pi-coding-agent/src/theme/**`)
  that are permitted to diverge from upstream. This document does not restate
  the list; treat the JSON file as authoritative and read it directly for the
  current contents.
- **Enforced by:** `node scripts/verify-pi-patches.cjs`. The script diffs
  `packages/pi-agent-core/`, `packages/pi-ai/`, `packages/pi-tui/`, and
  `packages/pi-coding-agent/` (restricted to `src/`/`test/` subpaths) against a
  resolved base ref (`origin/main`, falling back to `main`, falling back to
  `HEAD~1`, or `VERIFY_PI_PATCHES_BASE` if set), then fails if any changed file
  is not covered by an allowlist entry (exact match or glob).
- **When to run it:** locally before committing any change that touches
  `packages/pi-*`, and it also runs in CI as a guard — see
  `node scripts/verify-pi-patches.cjs` in the repo's lint/verification commands.
- **Adding an entry:** edit `patchAllowlist` in `scripts/pi-upstream.json`
  directly (this task does not modify that file — see Flow A rule above); a
  patch allowlist addition should be reviewed like any other change to the
  vendoring contract.

## Flow B — gsd-pi → fork (methodological cherry-picks)

Unlike the vendored `pi-*` packages, code and methodology originating from
`gsd-pi` (the GSD extension, agent modes, docs) is **not** bulk-synced. It is
harvested deliberately:

- **Method:** curated copy-and-adapt, one module/concept at a time, each landing
  with its own test coverage (decision D2) — never a wholesale import from the
  condemned `src/resources/extensions/gsd/` tree (iron rule 2 in `CLAUDE.md`).
- **Source of history:** the pre-fork git history retains the full `gsd-pi`
  tree; useful modules are recovered from that history via targeted
  cherry-pick/copy, not by re-cloning `gsd-pi` at sync time.
- **Rationale:** the GSD extension subsystem is being replaced by the new Forge
  methodology extension, not carried forward wholesale — only proven, still-
  relevant pieces are harvested, and each harvest is reviewed independently.

## Cadence

- **Vendoring sync (Flow A):** run once per upstream `earendil-works/pi`
  release, not continuously. This is the deliberate-tracking policy locked by
  decision D9 in `docs/forge/FORGE2-DECISIONS.md` — the previous fork
  (`gsd-pi`) fell roughly 10 releases behind upstream by drifting silently, and
  D9 exists specifically to avoid repeating that gap.
- **Methodological harvest (Flow B):** ad hoc, driven by which `gsd-pi` module
  is needed next for a given milestone task — no fixed cadence.
- **Scope boundary for this milestone:** migrating the vendored packages to
  plain npm dependencies (dropping the copy-based vendoring in Flow A) is an
  explicitly deferred decision, not part of this milestone (D9).

## Quick reference

| Task | Command |
|------|---------|
| Sync vendored `pi-*` packages from upstream | `node scripts/vendor-pi.cjs --ref v0.75.5` |
| Dry-run the vendoring sync | `node scripts/vendor-pi.cjs --dry-run` |
| Verify no unlisted patches to vendored packages | `node scripts/verify-pi-patches.cjs` |
| Inspect current pin / allowlist / package map | `scripts/pi-upstream.json` |
