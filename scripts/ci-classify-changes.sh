#!/usr/bin/env bash
# Classify changed files for CI path gating. Writes booleans to GITHUB_OUTPUT when set.
set -euo pipefail

EVENT_NAME="${EVENT_NAME:-${GITHUB_EVENT_NAME:-pull_request}}"
PR_BASE_SHA="${PR_BASE_SHA:-${GITHUB_EVENT_PULL_REQUEST_BASE_SHA:-}}"
PUSH_BEFORE_SHA="${PUSH_BEFORE_SHA:-${GITHUB_EVENT_BEFORE:-}}"
HEAD_SHA="${HEAD_SHA:-${GITHUB_SHA:-HEAD}}"

if [ "$EVENT_NAME" = "pull_request" ] && [ -n "$PR_BASE_SHA" ]; then
  BASE="$PR_BASE_SHA"
elif [ -n "$PUSH_BEFORE_SHA" ] && [ "$PUSH_BEFORE_SHA" != "0000000000000000000000000000000000000000" ]; then
  BASE="$PUSH_BEFORE_SHA"
else
  BASE="${CI_DIFF_REF:-origin/main}"
fi

FILES=$(git diff --name-only "$BASE" "$HEAD_SHA" 2>/dev/null || git diff --name-only HEAD~1)
echo "Changed files:"
echo "$FILES"

is_core_file() {
  case "$1" in
    src/*|packages/*|native/*|scripts/*|web/*|extensions/*|integrations/*|tests/*|docker/*|Dockerfile|package.json|pnpm-lock.yaml|tsconfig*.json|.github/*) return 0 ;;
    packages/*/tsconfig.json) return 0 ;;
    *) return 1 ;;
  esac
}

# NOTE (fork, M0, D8): the upstream gsd-pi classifier also emitted web-changed /
# portability-changed / windows-e2e-changed / docker-changed outputs to gate
# Windows/Docker/web-host CI lanes. Those lanes and the subsystems they tested
# (native builds, web host, Docker e2e, Windows portability) are stripped for
# the fork — native is off (GSD_NATIVE_DISABLE=1) — so the lean CI pipeline no
# longer conditions any job on that signal. Removed to avoid dead classification
# logic; reintroduce if native/Windows/Docker lanes come back.

HEAVY_CODE=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  if is_core_file "$file"; then
    HEAVY_CODE="${HEAVY_CODE}${file}"$'\n'
  fi
done <<< "$FILES"

write_output() {
  local key="$1"
  local value="$2"
  local notice="$3"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "${key}=${value}" >> "$GITHUB_OUTPUT"
  fi
  export "${key//-/_}=${value}"
  if [ "$value" = "true" ]; then
    echo "$notice"
  else
    echo "::notice::$notice"
  fi
}

if [ -n "$HEAVY_CODE" ]; then
  write_output "heavy-code-changed" "true" "Build/runtime-relevant files changed:"
  echo "$HEAVY_CODE"
else
  write_output "heavy-code-changed" "false" "No build/runtime-relevant changes — skipping heavy build/test jobs"
fi
