#!/usr/bin/env bash
# scripts/safety-audit.sh — run the read-only catalogue safety auditor.
#
# The auditor is TypeScript that imports the REAL lib/audit + lib/llm modules (not a
# reimplementation), so it cannot drift from the code it measures. There is no ts-node/tsx in
# this repo, so we bundle with the esbuild that ships inside vitest's dependency tree and run
# the bundle — identical to scripts/search-cap-probe.sh.
#
#   bash scripts/safety-audit.sh                                   # dry run, delta mode
#   bash scripts/safety-audit.sh --out .audit                      # write report.json + report.md
#   bash scripts/safety-audit.sh --mode as_served --out .audit
#   bash scripts/safety-audit.sh --base-url https://staging.example --delay 200
#   bash scripts/safety-audit.sh --live --out .audit               # also adjudicate (gated, see below)
#
# READ-ONLY AND CREDENTIAL-FREE BY DEFAULT. It issues GETs against the public search API and
# writes only under --out. It never connects to a database.
#
# --live asks for LLM adjudication; it does NOT grant it. A real Anthropic call additionally
# needs ANTHROPIC_API_KEY provisioned AND LLM_BATCH_ENABLED=true (lib/llm/config.ts). Without
# both, the run silently stays prefilter-only, which costs nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESBUILD="$ROOT/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD" ]]; then
  echo "esbuild not found at $ESBUILD — run 'npm ci' first." >&2
  exit 2
fi

# The bundle must live INSIDE the repo: `pg` stays external (it is pulled in transitively by
# lib/llm/config's neighbours and must resolve from the nearest node_modules, which only
# exists here). The auditor itself never opens a pool.
OUT="$ROOT/.safety-audit.bundle.mjs"
trap 'rm -f "$OUT"' EXIT

"$ESBUILD" "$ROOT/scripts/safety-audit.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --external:pg --external:pg-native \
  --log-level=warning \
  --outfile="$OUT"

node "$OUT" "$@"
