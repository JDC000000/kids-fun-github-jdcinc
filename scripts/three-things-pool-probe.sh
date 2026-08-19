#!/usr/bin/env bash
# scripts/three-things-pool-probe.sh — does the front door still have three things to say?
#
# READ-ONLY. Hits a live /api/search and applies the REAL front-door gates from lib/ to what comes
# back. Exits 1 when the indoor slot has nothing showable citywide — the condition Jon's
# 2026-08-19 ruling accepted a thin pool specifically in order to avoid. See the .ts header.
#
#   bash scripts/three-things-pool-probe.sh
#   bash scripts/three-things-pool-probe.sh --base https://kids-fun.example --json
#
# Bundled with the esbuild inside vitest's dependency tree, exactly as scripts/search-cap-probe.sh
# does — there is no ts-node/tsx in this repo and this is the established pattern for a probe that
# has to import the real modules rather than a copy of them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESBUILD="$ROOT/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD" ]]; then
  echo "esbuild not found at $ESBUILD — run 'npm ci' first." >&2
  exit 2
fi

OUT="$ROOT/.three-things-pool-probe.bundle.mjs"
trap 'rm -f "$OUT"' EXIT

"$ESBUILD" "$ROOT/scripts/three-things-pool-probe.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --outfile="$OUT" --log-level=warning

node "$OUT" "$@"
