#!/usr/bin/env bash
# check-dist-fresh.sh — verify compiled dist/ outputs are at least as new as their
# corresponding src/ .ts sources. Use this as a restart-precondition / CI guard so
# we never ship stale compiled artifacts again (see 2026-04-23 reviewer infinite-loop
# incident caused by a patched src/bundled-cli-path.ts with a stale dist/).
#
# Usage:
#   scripts/check-dist-fresh.sh                  # checks default packages (root + agent-runner)
#   scripts/check-dist-fresh.sh DIR [DIR ...]    # each DIR must contain src/ and dist/
#
# Exit codes:
#   0 — all dist/ files up-to-date
#   1 — at least one dist/ file missing or older than its src/ sibling
#   2 — usage / environment error
#
# Rules per package:
#   - For every foo.ts under src/ (excluding *.test.ts, *.d.ts, __tests__/*):
#       require dist/foo.js to exist AND have mtime >= src/foo.ts
#   - Missing dist/foo.js is a hard error (build never ran for that file).
#
set -euo pipefail

# Resolve repo root from this script's location so the script works from any cwd.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [ "$#" -gt 0 ]; then
  PACKAGES=("$@")
else
  PACKAGES=(
    "${REPO_ROOT}"
    "${REPO_ROOT}/runners/agent-runner"
    "${REPO_ROOT}/runners/codex-runner"
    "${REPO_ROOT}/runners/shared"
  )
fi

fail=0
checked=0

# Use mtime in nanoseconds (GNU stat) for precision. Fallback to seconds if %Y only.
_mtime() {
  # $1: path
  local t
  t="$(stat -c '%Y' "$1" 2>/dev/null || true)"
  if [ -z "$t" ]; then
    # BSD stat fallback (macOS)
    t="$(stat -f '%m' "$1" 2>/dev/null || true)"
  fi
  echo "${t:-0}"
}

check_package() {
  local pkg="$1"
  local src_dir="${pkg}/src"
  local dist_dir="${pkg}/dist"

  if [ ! -d "$src_dir" ]; then
    echo "skip: ${pkg} (no src/)" >&2
    return 0
  fi
  if [ ! -d "$dist_dir" ]; then
    echo "FAIL: ${pkg} — dist/ does not exist (run build)" >&2
    fail=1
    return 0
  fi

  local ts dist_file src_mtime dist_mtime
  # Loop over every .ts file under src/, skipping tests & type declarations.
  while IFS= read -r -d '' ts; do
    local rel="${ts#${src_dir}/}"
    dist_file="${dist_dir}/${rel%.ts}.js"
    checked=$((checked + 1))

    if [ ! -f "$dist_file" ]; then
      echo "FAIL: missing dist file: ${dist_file} (src: ${ts})" >&2
      fail=1
      continue
    fi

    src_mtime="$(_mtime "$ts")"
    dist_mtime="$(_mtime "$dist_file")"

    if [ "$dist_mtime" -lt "$src_mtime" ]; then
      echo "FAIL: stale dist: ${dist_file}" >&2
      echo "       src  mtime=${src_mtime} ($(date -d "@${src_mtime}" '+%F %T' 2>/dev/null || true)) ${ts}" >&2
      echo "       dist mtime=${dist_mtime} ($(date -d "@${dist_mtime}" '+%F %T' 2>/dev/null || true))" >&2
      fail=1
    fi
  done < <(find "$src_dir" -type f -name '*.ts' \
             ! -name '*.test.ts' \
             ! -name '*.d.ts' \
             ! -path '*/__tests__/*' \
             -print0)
}

for pkg in "${PACKAGES[@]}"; do
  if [ ! -d "$pkg" ]; then
    echo "skip: ${pkg} (directory not found)" >&2
    continue
  fi
  check_package "$pkg"
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "dist freshness check FAILED (checked ${checked} source files)" >&2
  echo "Run: bun run build:all  (or the package's build script)" >&2
  exit 1
fi

echo "dist freshness OK (checked ${checked} source files across ${#PACKAGES[@]} package(s))"
exit 0
