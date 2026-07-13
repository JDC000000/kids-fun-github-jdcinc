#!/usr/bin/env bash
# KIDS FUN — forward-only migration runner (single schema tool; TSD §3A.3).
# Applies supabase/migrations/*.sql in lexical order against $DATABASE_URL, tracking
# applied versions AND their content checksums in schema_migrations. Consequences:
#   • re-runs are idempotent (already-applied files are skipped);
#   • an already-applied migration whose file later changes is REJECTED (forward-only
#     guard) — so a live DB can never silently drift from the committed history.
# Used by CI (ephemeral Postgres) and by deploy (persistent staging/prod DB).
#
# Escape hatch (LOCAL resets only — never set in CI or deploy):
#   MIGRATE_ALLOW_CHECKSUM_MISMATCH=1  downgrades a checksum mismatch to a warning.
set -euo pipefail

DB_URL="${DATABASE_URL:?DATABASE_URL must be set (postgres connection string)}"
MIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/migrations"
ALLOW_MISMATCH="${MIGRATE_ALLOW_CHECKSUM_MISMATCH:-0}"

echo "→ migrations dir: ${MIG_DIR}"

# Ledger table + forward-compatible checksum column (backfilled onto older DBs).
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (
     version    text PRIMARY KEY,
     checksum   text,
     applied_at timestamptz NOT NULL DEFAULT now()
   );"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
  "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text;"

sha() { sha256sum "$1" | cut -d' ' -f1; }

shopt -s nullglob
applied=0
for f in "$MIG_DIR"/*.sql; do
  v="$(basename "$f")"
  sum="$(sha "$f")"
  exists="$(psql "$DB_URL" -tAc "SELECT 1 FROM schema_migrations WHERE version = '${v}'")"

  if [ "$exists" = "1" ]; then
    stored="$(psql "$DB_URL" -tAc "SELECT coalesce(checksum,'') FROM schema_migrations WHERE version = '${v}'")"
    if [ -z "$stored" ]; then
      # Legacy row applied before checksums existed — backfill on first upgraded run.
      psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
        "UPDATE schema_migrations SET checksum = '${sum}' WHERE version = '${v}'"
      echo "  = skip  ${v} (checksum backfilled)"
    elif [ "$stored" = "$sum" ]; then
      echo "  = skip  ${v}"
    elif [ "$ALLOW_MISMATCH" = "1" ]; then
      echo "  ! WARN  ${v} content changed since apply — override in effect (MIGRATE_ALLOW_CHECKSUM_MISMATCH=1)" >&2
    else
      echo "  ✗ ERROR ${v} was modified after being applied (forward-only violation)." >&2
      echo "          stored=${stored}" >&2
      echo "          current=${sum}" >&2
      echo "          Fix: add a NEW migration instead of editing an applied one" >&2
      echo "          (or reset the DB for a local dev database)." >&2
      exit 2
    fi
    continue
  fi

  echo "  + apply ${v}"
  # -1 wraps the file in a single transaction (atomic apply).
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO schema_migrations(version, checksum) VALUES ('${v}', '${sum}');"
  applied=$((applied + 1))
done

echo "✔ migrations up to date (${applied} applied this run)."
