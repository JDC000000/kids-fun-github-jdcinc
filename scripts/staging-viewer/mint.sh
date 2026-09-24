#!/usr/bin/env bash
# scripts/staging-viewer/mint.sh — mint or revoke the STAGING read-only admin viewer's session.
# See scripts/staging-viewer/mint.ts for what it does and does not do, and
# documents/kids-fun/admin-pr1-test-viewer-login-IMPL-2026-09-24.md for the operator runbook.
#
# Secrets come ONLY from the credentials store, injected into this process's environment. Two
# stores are involved (staging Supabase project; the viewer's own login), so the invocation nests
# two `credentials-cli run` calls. ALWAYS end with `| cat` — credentials-cli run returns before its
# child finishes, so unpiped output is lost; judge success only by the printed output:
#
#   CLI=/opt/projects/crhq-satellite/server/services/credentials-cli.js
#   node $CLI run kids-fun-supabase-staging --field=anon_key --env-name=SUPABASE_ANON_KEY -- \
#     node $CLI run kids-fun-staging-test-admin --field=password --env-name=KF_VIEWER_PASSWORD -- \
#     env SUPABASE_URL=https://mdusztrunwnniwnpwsmy.supabase.co \
#         KF_VIEWER_EMAIL=<viewer email> KF_VIEWER_USER_ID=<viewer uuid> \
#         KF_VIEWER_STATE_OUT=/opt/projects/crhq-satellite/.scratch/kf-viewer/state.json \
#     bash scripts/staging-viewer/mint.sh mint | cat
#
# ...and afterwards the same with `revoke` (KF_VIEWER_STATE_OUT not needed), then delete the file.
#
# There is no ts-node/tsx in this repo, so — like scripts/search-cap-probe.sh — the TypeScript is
# bundled with the esbuild that ships in the dependency tree, run, and the bundle deleted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ESBUILD="$ROOT/node_modules/.bin/esbuild"
if [[ ! -x "$ESBUILD" ]]; then
  echo "esbuild not found at $ESBUILD — run 'npm ci' first." >&2
  exit 2
fi

OUT="$ROOT/.staging-viewer-mint.bundle.mjs"
trap 'rm -f "$OUT"' EXIT

"$ESBUILD" "$ROOT/scripts/staging-viewer/mint.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --external:pg --external:pg-native \
  --log-level=warning \
  --outfile="$OUT"

node "$OUT" "$@"
