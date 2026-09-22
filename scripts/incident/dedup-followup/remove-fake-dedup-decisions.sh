#!/usr/bin/env bash
# FIX 2 of 2 — remove the 49 fake dedup decision rows. OPERATOR TOOL. Dry-run default.
#   KF_CLEANUP_TARGET_URL='postgres://…' bash scripts/incident/dedup-followup/remove-fake-dedup-decisions.sh
#   …plus --commit --yes-write-production to write.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
: "${KF_CLEANUP_TARGET_URL:?KF_CLEANUP_TARGET_URL must be set (connection string of the database to fix)}"
VITE_NODE="$ROOT/node_modules/.bin/vite-node"
[[ -x "$VITE_NODE" ]] || { echo "vite-node not found at $VITE_NODE — run 'npm ci' first." >&2; exit 2; }
exec "$VITE_NODE" scripts/incident/dedup-followup/remove-fake-dedup-decisions.ts -- "$@"
