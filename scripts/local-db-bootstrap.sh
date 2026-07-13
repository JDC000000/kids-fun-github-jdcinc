#!/usr/bin/env bash
# KIDS FUN — local/CI DB bootstrap. Applies the local-only auth stub (never
# run against a real Supabase project — see supabase/local-dev/000_auth_stub.sql),
# then runs the normal forward migrations. Use this instead of migrate.sh
# directly when developing against a bare Postgres (local docker, CI); use
# migrate.sh directly against a real Supabase project (staging/production),
# which already provides the `auth` schema this stub emulates.
set -euo pipefail

DB_URL="${DATABASE_URL:?DATABASE_URL must be set (postgres connection string)}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "→ local-dev auth stub"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -1 -f "${ROOT_DIR}/supabase/local-dev/000_auth_stub.sql"

bash "${ROOT_DIR}/scripts/migrate.sh"
