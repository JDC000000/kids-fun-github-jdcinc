#!/usr/bin/env bash
# scripts/registration-vocabulary-probe.sh — what the registration heuristic says about the real
# catalogue, title by title. READ-ONLY; takes a TSV export, opens no database. See the .ts header
# for the export query and for why the probe imports the real predicates rather than copying them.
#
#   bash scripts/registration-vocabulary-probe.sh --titles titles.tsv
#   bash scripts/registration-vocabulary-probe.sh --titles titles.tsv --json > after.tsv
#
# Bundled with the esbuild inside vitest's dependency tree, exactly as
# scripts/three-things-pool-probe.sh and scripts/search-cap-probe.sh do — there is no ts-node/tsx
# in this repo and this is the established pattern for a probe that has to import the real modules.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESBUILD="$ROOT/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD" ]]; then
  echo "esbuild not found at $ESBUILD — run 'npm ci' first." >&2
  exit 2
fi

OUT="$ROOT/.registration-vocabulary-probe.bundle.mjs"
trap 'rm -f "$OUT"' EXIT

"$ESBUILD" "$ROOT/scripts/registration-vocabulary-probe.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --outfile="$OUT" --log-level=warning

node "$OUT" "$@"
