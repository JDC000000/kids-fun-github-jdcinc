#!/usr/bin/env bash
# KIDS FUN — forward-only migration runner (single schema tool; TSD §3A.3).
# Applies supabase/migrations/*.sql in lexical order against $DATABASE_URL, tracking
# applied versions in schema_migrations so re-runs are idempotent (CI + deploy use).
set -euo pipefail

DB_URL="${DATABASE_URL:?DATABASE_URL must be set (postgres connection string)}"
MIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/migrations"

echo "→ migrations dir: ${MIG_DIR}"

psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (
     version    text PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   );"

shopt -s nullglob
applied=0
for f in "$MIG_DIR"/*.sql; do
  v="$(basename "$f")"
  exists="$(psql "$DB_URL" -tAc "SELECT 1 FROM schema_migrations WHERE version = '${v}'")"
  if [ "$exists" = "1" ]; then
    echo "  = skip  ${v}"
    continue
  fi
  echo "  + apply ${v}"
  # -1 wraps each migration file in a single transaction (atomic apply).
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO schema_migrations(version) VALUES ('${v}');"
  applied=$((applied + 1))
done

echo "✔ migrations up to date (${applied} applied this run)."
