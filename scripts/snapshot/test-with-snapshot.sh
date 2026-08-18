#!/usr/bin/env bash
# scripts/snapshot/test-with-snapshot.sh — run the suites against SNAPSHOT data instead of
# fixtures. OPT-IN. Fixture mode is and stays the default; nothing here changes `npm test`.
#
#   DATABASE_URL='postgres://…localhost…' npm run test:snapshot -- --in .snapshots/<dir>
#
# What it does:
#   1. loads the snapshot into the LOCAL database (scripts/snapshot/load.sh, which itself runs
#      local-db-bootstrap.sh first so the schema is current);
#   2. runs the DB lane with KF_SNAPSHOT_MODE=1.
#
# KF_SNAPSHOT_MODE is what un-skips tests/snapshot/catalogue-shape.test.ts — the universal
# "every row in the catalogue satisfies X" assertions that only mean something when the rows
# are real. Every other DB suite runs unchanged; they mint their own fixtures on top of the
# snapshot, which is itself worth something (a fixture inserted into a full catalogue exercises
# more code than one inserted into an empty table).
#
# The unit lane is deliberately NOT run here: it cannot reach a database, so snapshot data
# cannot change its result. Use `npm test` for that.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL must be set (the LOCAL database to load the snapshot into)}"

IN=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --in) IN="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -z "$IN" ]]; then
  # Default to the most recent snapshot directory, so the common case is one command.
  IN="$(ls -1dt .snapshots/*/ 2>/dev/null | head -1 || true)"
  [[ -n "$IN" ]] || { echo "no snapshot found — pass --in DIR, or run 'npm run snapshot:export' first" >&2; exit 2; }
  echo "→ using most recent snapshot: $IN"
fi

bash "$HERE/load.sh" --in "$IN"

echo "→ running the DB lane with KF_SNAPSHOT_MODE=1"
KF_SNAPSHOT_MODE=1 npx vitest run --project db "${args[@]}"
