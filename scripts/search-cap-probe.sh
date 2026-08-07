#!/usr/bin/env bash
# scripts/search-cap-probe.sh — run the read-only search population/relevance probe.
#
# The probe is TypeScript that imports the REAL lib/search modules (not a reimplementation),
# so it cannot drift from the code it measures. There is no ts-node/tsx in this repo, so we
# bundle with the esbuild that ships inside vitest's dependency tree and run the bundle.
#
#   KF_PROBE_DATABASE_URL='postgres://...' bash scripts/search-cap-probe.sh --env staging
#   KF_PROBE_DATABASE_URL='postgres://...' bash scripts/search-cap-probe.sh --env production --json
#
# READ-ONLY. Safe against staging or production. Uses KF_PROBE_DATABASE_URL rather than
# DATABASE_URL on purpose — see the header of scripts/search-cap-probe.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESBUILD="$ROOT/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD" ]]; then
  echo "esbuild not found at $ESBUILD — run 'npm ci' first." >&2
  exit 2
fi

# The bundle must live INSIDE the repo, not in /tmp: `pg` stays external (it is a native-ish
# CJS package that must not be bundled), so Node resolves it from the nearest node_modules —
# which only exists here.
OUT="$ROOT/.search-cap-probe.bundle.mjs"
trap 'rm -f "$OUT"' EXIT

"$ESBUILD" "$ROOT/scripts/search-cap-probe.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --external:pg --external:pg-native \
  --log-level=warning \
  --outfile="$OUT"

node "$OUT" "$@"
