#!/usr/bin/env bash
# scripts/backfill-scope/review-batch.sh — build the §3h ActiveNet title-gate REVIEW-CANDIDATE
# queue. Same esbuild build path as measure.sh (there is no ts-node/tsx in this repo).
#
#   bash scripts/backfill-scope/review-batch.sh --recheck .backfill-scope.json
#   DATABASE_URL=... bash scripts/backfill-scope/review-batch.sh --recheck r.json --live
#
# DEFAULT IS OFFLINE. The queue is built entirely from the recheck JSON, so it is reproducible
# byte-for-byte by anyone holding that file. `--live` adds a READ-ONLY cross-check against
# production (scripts/backfill-scope/readonly-db.ts — `BEGIN TRANSACTION READ ONLY`, SELECT/WITH
# only, no writer imported anywhere in this directory) and reports snapshot-vs-live drift.
#
# DATABASE_URL is never defaulted and never read from a credential store here: pointing this at
# production must be an explicit act. It is only consulted when --live is passed.
#
# THIS TOOL PROPOSES NO CORRECTION AND WRITES NO PRODUCTION ROW. The rows it emits are
# CANDIDATES — see docs/worker-fix-backfill-scope.md §3.3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ESBUILD="$ROOT/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD" ]]; then
  echo "esbuild not found at $ESBUILD — run 'npm ci' first." >&2
  exit 2
fi

OUT="$ROOT/.backfill-scope-review.bundle.mjs"
trap 'rm -f "$OUT"' EXIT

"$ESBUILD" "$ROOT/scripts/backfill-scope/review-batch.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --external:pg --external:pg-native \
  --log-level=warning \
  --outfile="$OUT"

node "$OUT" "$@"
