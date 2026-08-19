#!/usr/bin/env bash
# scripts/backfill-scope/measure.sh — run the READ-ONLY §3h backfill-scope measurement.
#
# Same build path as scripts/safety-audit.sh and scripts/search-cap-probe.sh: esbuild from
# vitest's dependency tree, because there is no ts-node/tsx in this repo. `pg` stays external
# and must resolve from ./node_modules, so the bundle is written into the repo root.
#
#   DATABASE_URL=... bash scripts/backfill-scope/measure.sh
#   DATABASE_URL=... bash scripts/backfill-scope/measure.sh --json .backfill-scope.json
#   DATABASE_URL=... bash scripts/backfill-scope/measure.sh --samples 20
#
# THIS TOOL CANNOT WRITE. scripts/backfill-scope/readonly-db.ts wraps every statement in
# `BEGIN TRANSACTION READ ONLY` and rejects anything that is not SELECT/WITH, and nothing in
# scripts/backfill-scope/ imports a writer. Pointing it at production is safe by construction —
# but it IS a read of live parent-facing data, so DATABASE_URL is never defaulted and never
# read from a credential store here. Supply it deliberately.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ESBUILD="$ROOT/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD" ]]; then
  echo "esbuild not found at $ESBUILD — run 'npm ci' first." >&2
  exit 2
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required. This tool never guesses a database." >&2
  exit 2
fi

OUT="$ROOT/.backfill-scope.bundle.mjs"
trap 'rm -f "$OUT"' EXIT

"$ESBUILD" "$ROOT/scripts/backfill-scope/measure.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --external:pg --external:pg-native \
  --log-level=warning \
  --outfile="$OUT"

node "$OUT" "$@"
