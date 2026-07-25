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

# PREFLIGHT: refuse to run if something already holds $PORT.
#
# Without this the suite silently lies. `next start` fails to bind, this script's own
# health check happily succeeds against the FOREIGN server, and Playwright tests that
# stale build while reporting a normal pass. The a11y sweep is the worst victim: a
# stale server yields "0 violations" for fixes that were never actually served, i.e. a
# false CLEAN. (docs/a11y-audit.md flagged this trap; H2 was bitten by it in practice —
# a leftover server from a prior run made an unfixed page audit as fixed.)
#
# Note the leak this guards against is real: killing the `npx` wrapper below does not
# always reap the `next-server` child, so a previous run can outlive its own trap.
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q LISTEN; then
  echo "REFUSING: port ${PORT} is already in use — a stale or foreign server would be" >&2
  echo "  tested INSTEAD of this build, silently invalidating the results." >&2
  echo "  Free it (e.g. 'ss -ltnp | grep :${PORT}' then kill the pid), or run on another" >&2
  echo "  port with: E2E_PORT=3111 E2E_BASE_URL=http://127.0.0.1:3111 $0 $*" >&2
  exit 1
fi

echo "→ starting next start on :${PORT}"
npx next start -p "$PORT" >/tmp/kf-e2e-app.log 2>&1 &
APP_PID=$!
# Reap by PORT, not just by PID. `npx next start` spawns a `next-server` grandchild
# that outlives the npx wrapper and gets RE-PARENTED to init — so neither
# `kill $APP_PID` nor `pkill -P $APP_PID` finds it, and it squats the port for the
# next run (observed in H2: PPID 1, port still bound after the trap ran). Killing
# whatever still holds $PORT is the only reliable reap, and it is safe here because
# the preflight above already proved the port was ours to begin with.
cleanup() {
  kill "$APP_PID" 2>/dev/null || true
  pkill -P "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  if command -v ss >/dev/null 2>&1; then
    local leaked
    leaked="$(ss -ltnp "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)"
    for pid in $leaked; do kill "$pid" 2>/dev/null || true; done
  fi
}
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
