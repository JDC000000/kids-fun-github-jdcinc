#!/usr/bin/env bash
# scripts/snapshot/_run.sh — shared TypeScript entrypoint for the snapshot tools.
#
# There is no ts-node/tsx in this repo. `vite-node` ships inside vitest's dependency tree and
# resolves the repo's TS + "@/" alias exactly like the test suite does, which is the same
# choice scripts/backfill-venue-geo.ts documents. Sourced, not executed: each tool's wrapper
# adds its own header and env checks, and every one of them must go through here so none can
# drift into a different runner with different resolution rules.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VITE_NODE="$ROOT/node_modules/.bin/vite-node"

if [[ ! -x "$VITE_NODE" ]]; then
  echo "vite-node not found at $VITE_NODE — run 'npm ci' first." >&2
  exit 2
fi

run_snapshot_tool() {
  local entry="$1"; shift
  cd "$ROOT"
  "$VITE_NODE" "$entry" -- "$@"
}
