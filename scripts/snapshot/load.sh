#!/usr/bin/env bash
# scripts/snapshot/load.sh — bring a LOCAL Postgres to "schema + production-shaped data".
#
#   DATABASE_URL='postgres://…@localhost:5432/kids_fun' bash scripts/snapshot/load.sh --in DIR
#
# Runs scripts/local-db-bootstrap.sh first (auth stub + forward migrations — it owns the
# SCHEMA), then loads the snapshot's rows (this owns the DATA). Both steps are idempotent, so
# re-running against an already-bootstrapped database just reloads the data.
#
# Refuses any non-local DATABASE_URL, with no override: the load TRUNCATEs the catalogue.
#
#   --skip-bootstrap   assume the schema is already current (CI, where the ci job has already
#                      run local-db-bootstrap.sh, and re-running it is wasted time not safety)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_run.sh"

: "${DATABASE_URL:?DATABASE_URL must be set (the LOCAL database to load into)}"

args=()
skip_bootstrap=0
for a in "$@"; do
  if [[ "$a" == "--skip-bootstrap" ]]; then skip_bootstrap=1; else args+=("$a"); fi
done

if [[ "$skip_bootstrap" -eq 0 ]]; then
  echo "→ schema: scripts/local-db-bootstrap.sh"
  bash "$HERE/../local-db-bootstrap.sh"
fi

run_snapshot_tool scripts/snapshot/load.ts "${args[@]}"
