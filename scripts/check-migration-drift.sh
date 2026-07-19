#!/usr/bin/env bash
# KIDS FUN — migration drift detector (READ-ONLY).
#
# Compares the committed migration set (supabase/migrations/*.sql) against a live
# database's `schema_migrations` ledger and reports any drift. This is the mirror
# of scripts/migrate.sh: migrate.sh WRITES the ledger (applies migrations); this
# script only READS it (SELECT-only) and never modifies the target DB.
#
# WHY THIS EXISTS
#   App code auto-deploys via Vercel's git integration on merge to main, but DB
#   migrations are applied MANUALLY (scripts/migrate.sh against the real staging /
#   prod DB). Those two channels can silently diverge. In Round 20 the staging DB
#   sat >1 round behind the committed migration head (ledger at 0016 while main
#   was at 0018) and nobody noticed until a security fix stumbled into it. This
#   check catches that class of drift automatically — run it as a scheduled CI
#   job, an on-merge gate, or an ad-hoc command.
#
# DRIFT CLASSES DETECTED
#   missing            committed migration that is NOT in the live ledger
#                      (the Round 20 incident: DB behind the committed head)
#   checksum-mismatch  applied version whose committed file content no longer
#                      matches the checksum recorded at apply time
#                      (an applied migration was edited in place — forward-only
#                       violation; migrate.sh already blocks this on apply, this
#                       catches it independently on any DB)
#   unknown            ledger row with NO corresponding committed file
#                      (DB ahead of code, or a migration applied out-of-band)
#
# USAGE
#   DATABASE_URL=postgres://user:pass@host:5432/db \
#     bash scripts/check-migration-drift.sh [--json] [--quiet]
#
#   --json   emit a machine-readable summary (for alerting hooks / agents)
#            instead of the human report. Exit code is unchanged.
#   --quiet  suppress the per-item "= ok" lines; only show drift + summary.
#
# EXIT CODES
#   0  in sync   — every committed migration is applied with a matching checksum,
#                  and the ledger contains nothing unknown
#   1  DRIFT     — one or more missing / checksum-mismatch / unknown items
#   2  error     — usage, missing psql, unreachable DB, or absent ledger table
#
# Legacy note: rows applied before the checksum column existed store an empty
# checksum. migrate.sh backfills these on its next run. This read-only check
# cannot verify their content, so it reports them as "applied (unverified)" —
# an informational note, NOT drift.
set -euo pipefail

# ---- args ------------------------------------------------------------------
JSON=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --json)  JSON=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help)
      sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ---- preconditions ---------------------------------------------------------
if ! command -v psql >/dev/null 2>&1; then
  echo "✗ psql not found — install the postgresql-client package." >&2
  exit 2
fi

DB_URL="${DATABASE_URL:?DATABASE_URL must be set (postgres connection string)}"
MIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/migrations"

if [ ! -d "$MIG_DIR" ]; then
  echo "✗ migrations dir not found: ${MIG_DIR}" >&2
  exit 2
fi

# Connectivity probe (also fails fast on a bad URL) — read-only.
if ! psql "$DB_URL" -tAc "SELECT 1" >/dev/null 2>&1; then
  echo "✗ cannot connect to the target database (check DATABASE_URL / network)." >&2
  exit 2
fi

# Ledger must exist. If it doesn't, the DB has never been migrated — that is
# itself a hard fault worth alerting on (exit 2, not a silent "0 drift").
HAS_LEDGER="$(psql "$DB_URL" -tAc \
  "SELECT to_regclass('public.schema_migrations') IS NOT NULL" 2>/dev/null || echo f)"
if [ "$HAS_LEDGER" != "t" ]; then
  if [ "$JSON" = "1" ]; then
    printf '{"status":"error","reason":"no schema_migrations ledger","committed_count":%s}\n' \
      "$(find "$MIG_DIR" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
  else
    echo "✗ target DB has no schema_migrations ledger — it has never been migrated." >&2
    echo "  Run scripts/migrate.sh against it first." >&2
  fi
  exit 2
fi

# ---- gather state ----------------------------------------------------------
sha() { sha256sum "$1" | cut -d' ' -f1; }

# Live ledger: "version<TAB>checksum" per row (checksum may be empty = legacy).
declare -A APPLIED         # version -> checksum ('' if legacy/unverified)
declare -A SEEN_COMMITTED  # version -> 1 for committed files (to find unknowns)
while IFS=$'\t' read -r v c; do
  [ -z "$v" ] && continue
  APPLIED["$v"]="$c"
done < <(psql "$DB_URL" -tA -F $'\t' -c \
           "SELECT version, coalesce(checksum,'') FROM schema_migrations ORDER BY version")

# ---- classify --------------------------------------------------------------
missing=()      # committed, not in ledger
mismatch=()     # committed + applied, checksum differs
unverified=()   # committed + applied, ledger checksum empty (legacy) — info only
ok_count=0
committed_count=0

shopt -s nullglob
for f in "$MIG_DIR"/*.sql; do
  v="$(basename "$f")"
  SEEN_COMMITTED["$v"]=1
  committed_count=$((committed_count + 1))
  sum="$(sha "$f")"

  if [ -z "${APPLIED["$v"]+x}" ]; then
    missing+=("$v")
    continue
  fi

  stored="${APPLIED["$v"]}"
  if [ -z "$stored" ]; then
    unverified+=("$v")
  elif [ "$stored" = "$sum" ]; then
    ok_count=$((ok_count + 1))
  else
    mismatch+=("${v}|stored=${stored}|current=${sum}")
  fi
done

# Unknown: applied rows with no committed file.
unknown=()
for v in "${!APPLIED[@]}"; do
  if [ -z "${SEEN_COMMITTED["$v"]+x}" ]; then
    unknown+=("$v")
  fi
done

applied_count="${#APPLIED[@]}"
drift_count=$(( ${#missing[@]} + ${#mismatch[@]} + ${#unknown[@]} ))

# ---- JSON output -----------------------------------------------------------
json_array() { # prints a JSON array from the args (empty args skipped)
  local out="[" first=1 x
  for x in "$@"; do
    x="${x%%|*}"                       # keep version only for mismatch entries
    [ -z "$x" ] && continue            # drop the empty-array placeholder
    x="${x//\\/\\\\}"; x="${x//\"/\\\"}"
    [ "$first" = 1 ] && first=0 || out+=","
    out+="\"$x\""
  done
  out+="]"; printf '%s' "$out"
}

if [ "$JSON" = "1" ]; then
  status="in_sync"; [ "$drift_count" -gt 0 ] && status="drift"
  printf '{"status":"%s","committed_count":%s,"applied_count":%s,"in_sync":%s,' \
    "$status" "$committed_count" "$applied_count" "$ok_count"
  printf '"missing":%s,'  "$(json_array "${missing[@]:-}")"
  printf '"checksum_mismatch":%s,' "$(json_array "${mismatch[@]:-}")"
  printf '"unknown":%s,' "$(json_array "${unknown[@]:-}")"
  printf '"unverified_legacy":%s}\n' "$(json_array "${unverified[@]:-}")"
  [ "$drift_count" -gt 0 ] && exit 1 || exit 0
fi

# ---- human report ----------------------------------------------------------
echo "→ migrations dir: ${MIG_DIR}"
echo "→ target ledger:  schema_migrations (${applied_count} row(s))"
echo "→ committed set:   ${committed_count} migration file(s)"
echo

if [ "$QUIET" != "1" ]; then
  for f in "$MIG_DIR"/*.sql; do
    v="$(basename "$f")"
    [ -n "${APPLIED["$v"]+x}" ] && [ -n "${APPLIED["$v"]}" ] \
      && [ "${APPLIED["$v"]}" = "$(sha "$f")" ] && echo "  = ok    ${v}"
  done
fi

for v in "${unverified[@]:-}"; do [ -n "$v" ] && echo "  ~ note  ${v} (applied; ledger checksum empty — content unverified)"; done
for v in "${missing[@]:-}";    do [ -n "$v" ] && echo "  ✗ DRIFT ${v} — committed but NOT applied to this DB"; done
for e in "${mismatch[@]:-}";   do
  [ -z "$e" ] && continue
  IFS='|' read -r v s c <<<"$e"
  echo "  ✗ DRIFT ${v} — checksum mismatch (applied content differs from committed)"
  echo "          ${s}"
  echo "          ${c}"
done
for v in "${unknown[@]:-}";    do [ -n "$v" ] && echo "  ✗ DRIFT ${v} — in ledger but NO committed file (DB ahead of code / out-of-band)"; done

echo
if [ "$drift_count" -eq 0 ]; then
  echo "✔ in sync — ${ok_count}/${committed_count} committed migrations applied with matching checksums."
  [ "${#unverified[@]}" -gt 0 ] && echo "  (${#unverified[@]} legacy row(s) with unverified checksums; migrate.sh will backfill.)"
  exit 0
else
  echo "✗ DRIFT DETECTED — ${#missing[@]} missing, ${#mismatch[@]} checksum-mismatch, ${#unknown[@]} unknown."
  echo "  The live database does not match the committed migration set on this ref."
  echo "  Remediate with: DATABASE_URL=… bash scripts/migrate.sh   (for 'missing' — applies forward)"
  echo "  For mismatch/unknown, investigate before applying — do NOT force."
  exit 1
fi
