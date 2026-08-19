#!/usr/bin/env bash
# scripts/backfill-scope/citycalendar-recon.sh — run the READ-ONLY §3.4 CityCalendar
# targeted-re-ingest reconciliation.
#
# Same build path as scripts/backfill-scope/measure.sh: esbuild from vitest's dependency tree,
# because there is no ts-node/tsx in this repo. `pg` stays external and must resolve from
# ./node_modules, so the bundle is written into the repo root.
#
#   DATABASE_URL=... bash scripts/backfill-scope/citycalendar-recon.sh
#   DATABASE_URL=... bash scripts/backfill-scope/citycalendar-recon.sh --json .cc-recon.json
#   DATABASE_URL=... bash scripts/backfill-scope/citycalendar-recon.sh --save-feed .cc-feed.json
#   DATABASE_URL=... bash scripts/backfill-scope/citycalendar-recon.sh --feed-file .cc-feed.json
#
# THIS TOOL CANNOT WRITE. scripts/backfill-scope/readonly-db.ts wraps every statement in
# `BEGIN TRANSACTION READ ONLY` and rejects anything that is not SELECT/WITH, and nothing in
# scripts/backfill-scope/ imports a writer. Pointing it at production is safe by construction —
# but it IS a read of live parent-facing data, so DATABASE_URL is never defaulted and never
# read from a credential store here. Supply it deliberately.
#
# It also makes ONE outbound GET, to the public Trumba feed named in
# worker/adapters/citycalendar/config.ts. Use --feed-file to run with no network at all.
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

OUT="$ROOT/.citycalendar-recon.bundle.mjs"
trap 'rm -f "$OUT"' EXIT

"$ESBUILD" "$ROOT/scripts/backfill-scope/citycalendar-recon-run.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --external:pg --external:pg-native \
  --log-level=warning \
  --outfile="$OUT"

node "$OUT" "$@"
