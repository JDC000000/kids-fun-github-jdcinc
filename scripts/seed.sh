#!/usr/bin/env bash
# KIDS FUN — reference-data seed runner (G-T3). Applies supabase/seeds/*.sql in
# lexical order against $DATABASE_URL. Seeds are idempotent upserts (ON CONFLICT),
# not versioned like migrations — safe to re-run anytime after `migrate.sh`.
set -euo pipefail

DB_URL="${DATABASE_URL:?DATABASE_URL must be set (postgres connection string)}"
SEED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/seeds"

echo "→ seeds dir: ${SEED_DIR}"

shopt -s nullglob
for f in "$SEED_DIR"/*.sql; do
  echo "  + seed ${f##*/}"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
done

echo "✔ seeds applied."
