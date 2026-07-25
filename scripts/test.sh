#!/usr/bin/env bash
# KIDS FUN — full unit-test run, split into two lanes (H3). See vitest.workspace.ts for
# WHY the split exists and how a file is routed.
#
#   unit lane — every file that cannot reach the database. Fully parallel.
#   db lane   — the shared-Postgres integration suites. One file at a time
#               (vitest.config.ts's `fileParallelism: false`, which is a vitest
#               NON-project option and therefore needs its own invocation).
#
# The two lanes run CONCURRENTLY. That is safe by construction, not by luck: the unit lane
# is defined as the files that never open a connection, so it cannot observe or disturb the
# db lane's fixtures. It is also where the win is — the db lane is the critical path, and
# overlapping the unit lane with it hides the unit lane's cost almost entirely. The db lane
# uses exactly one worker, so the two lanes are not fighting for the same core.
#
# Output is buffered per lane and printed lane-by-lane, so a failure is readable instead of
# interleaved with the other lane's progress. For a live-progress run of one lane, use
# `npm run test:unit` / `npm run test:db`.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

unit_log="$(mktemp)"
db_log="$(mktemp)"
trap 'rm -f "$unit_log" "$db_log"' EXIT

# --fileParallelism overrides the base config's serial default for this lane only.
npx vitest run --project unit --fileParallelism >"$unit_log" 2>&1 &
unit_pid=$!
npx vitest run --project db >"$db_log" 2>&1 &
db_pid=$!

wait "$unit_pid"; unit_status=$?
wait "$db_pid"; db_status=$?

echo "──────────────── unit lane (parallel, no database) ────────────────"
cat "$unit_log"
echo "──────────────── db lane (serial, shared Postgres) ────────────────"
cat "$db_log"

if [ "$unit_status" -ne 0 ] || [ "$db_status" -ne 0 ]; then
  echo "✖ tests failed (unit lane exit=${unit_status}, db lane exit=${db_status})"
  exit 1
fi
echo "✔ both lanes green."
