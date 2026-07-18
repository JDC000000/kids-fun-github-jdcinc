#!/usr/bin/env bash
# scripts/e2e/run-e2e.sh — build + start the app against the local Supabase stack
# and run the Playwright E2E suite, then tear the server down. LOCAL / TEST ONLY.
#
# Prereq: `npm run e2e:setup` (writes .env.e2e.local + starts Supabase).
# Any args are forwarded to `playwright test` (e.g. --project=authed-dark).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.npm-global/bin:$PATH"

if [ ! -f .env.e2e.local ]; then
  echo "Missing .env.e2e.local — run: npm run e2e:setup" >&2
  exit 1
fi
set -a; . ./.env.e2e.local; set +a

PORT="${E2E_PORT:-3000}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:${PORT}}"

if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then
  echo "→ next build"
  npm run build
fi

echo "→ starting next start on :${PORT}"
npx next start -p "$PORT" >/tmp/kf-e2e-app.log 2>&1 &
APP_PID=$!
cleanup() { kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "→ waiting for app health"
ok=0
for _ in $(seq 1 90); do
  if curl -sf "${E2E_BASE_URL}/api/health" >/dev/null 2>&1 || curl -sf "${E2E_BASE_URL}/preview" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 1
done
if [ "$ok" != "1" ]; then
  echo "app did not become healthy — last log lines:" >&2
  tail -30 /tmp/kf-e2e-app.log >&2 || true
  exit 1
fi

echo "→ playwright test"
npx playwright test "$@"
