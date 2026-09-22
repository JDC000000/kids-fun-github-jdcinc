#!/usr/bin/env bash
# Wrapper for the 2026-09-21 fixture-pollution cleanup. OPERATOR TOOL. Dry-run by default.
#
#   KF_CLEANUP_TARGET_URL='postgres://…' bash scripts/incident/cleanup-2026-09-21-fixture-pollution.sh
#   …same, plus --commit --yes-write-production        # actually writes
#   …optional: --include-admin-fixtures  --skip-venues
#
# Uses vite-node (the repo has no ts-node/tsx), exactly as scripts/snapshot/_run.sh documents.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
: "${KF_CLEANUP_TARGET_URL:?KF_CLEANUP_TARGET_URL must be set (connection string of the database to clean)}"
VITE_NODE="$ROOT/node_modules/.bin/vite-node"
[[ -x "$VITE_NODE" ]] || { echo "vite-node not found at $VITE_NODE — run 'npm ci' first." >&2; exit 2; }
exec "$VITE_NODE" scripts/incident/cleanup-2026-09-21-fixture-pollution.ts -- "$@"
