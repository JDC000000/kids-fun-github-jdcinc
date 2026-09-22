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

# Disposability marker (lib/testing/disposable-db.ts). A database bootstrapped by THIS script is by
# definition a throwaway local one, so it says so about itself. The db test lane auto-provisions
# this for loopback hosts anyway; writing it here means the claim is also true for a database that
# is later reached over a non-loopback address (a container published on a LAN IP, a build box),
# where the lane REQUIRES the marker and will otherwise refuse to run.
echo "→ disposability marker"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "CREATE SCHEMA IF NOT EXISTS kf_testing" -c "CREATE TABLE IF NOT EXISTS kf_testing.kf_disposable_test_db (marked_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL)" -c "INSERT INTO kf_testing.kf_disposable_test_db (note) SELECT 'marked by scripts/local-db-bootstrap.sh' WHERE NOT EXISTS (SELECT 1 FROM kf_testing.kf_disposable_test_db)"
