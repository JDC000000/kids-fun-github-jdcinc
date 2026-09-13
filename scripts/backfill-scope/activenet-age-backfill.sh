#!/usr/bin/env bash
# scripts/backfill-scope/activenet-age-backfill.sh — run the ActiveNet age correction: stored ages re-derived
# from ActiveNet's OWN activity age field (/activity/detail/<id>).
#
#   DATABASE_URL=... bash scripts/backfill-scope/activenet-age-backfill.sh                  # DRY RUN
#   DATABASE_URL=... bash scripts/backfill-scope/activenet-age-backfill.sh --json plan.json # + artefact
#   DATABASE_URL=... bash scripts/backfill-scope/activenet-age-backfill.sh --apply          # WRITES
#
# DRY RUN IS THE DEFAULT. Planning goes through scripts/backfill-scope/readonly-db.ts, which
# cannot write (server-side `BEGIN TRANSACTION READ ONLY`, a SELECT/WITH-only statement guard,
# and no writer imported). `--apply` is the only way to reach correcting-db.ts.
#
# ── WHY --splitting, AND WHY IT IS LOAD-BEARING RATHER THAN A BUILD PREFERENCE ───────────────
# The driver reaches the write surface through a DYNAMIC `await import('./correcting-db')` that
# only executes under --apply. Bundled into one file, that module's code would sit in the same
# artefact as everything else and the "not loaded in a dry run" property would be a claim about
# source rather than about what runs. With `--splitting`, esbuild emits the writer as its OWN
# CHUNK which node loads only when the dynamic import is evaluated — so in a dry run the process
# genuinely never loads it. Verifiable after any build: the chunk is a separate file on disk and
# `grep -l "BEGIN" .activenet-age-backfill-bundle/*` finds it in the chunk, not in the entry point.
#
# DATABASE_URL is never defaulted and never read from a credential store here: pointing this at
# production must be an explicit act.
#
# ── THIS ONE ALSO MAKES NETWORK READS WHILE PLANNING ────────────────────────────────────────
# Unlike the M1 correction, planning here asks the public ActiveNet portal for each affected
# activity's own age. Those reads are credential-free GETs through the adapter's shared polite
# client, gated to rows that already carry an age claim, cached per activity id, and capped by
# --max-lookups. A dry run therefore touches the network but still cannot touch the database.
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

# Built inside the repo root so `pg` (kept external) resolves from ./node_modules.
OUTDIR="$ROOT/.activenet-age-backfill-bundle"
KEEP_BUNDLE="${KEEP_BUNDLE:-}"
cleanup() { [[ -n "$KEEP_BUNDLE" ]] || rm -rf "$OUTDIR"; }
trap cleanup EXIT

"$ESBUILD" "$ROOT/scripts/backfill-scope/activenet-age-backfill.ts" \
  --bundle --splitting --platform=node --format=esm --target=node20 \
  --external:pg --external:pg-native \
  --log-level=warning \
  --outdir="$OUTDIR"

node "$OUTDIR/activenet-age-backfill.js" "$@"
