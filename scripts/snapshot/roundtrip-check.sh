#!/usr/bin/env bash
# scripts/snapshot/roundtrip-check.sh — prove a loaded snapshot preserved what it promised.
#
#   KF_SNAPSHOT_SOURCE_URL='postgres://…source…' \
#   DATABASE_URL='postgres://…localhost…target…' \
#   bash scripts/snapshot/roundtrip-check.sh
#
# READ-ONLY on both ends. Digests every `preserve` column on the source and on the loaded
# target and compares: identical means dates/ages/regions/costs/geometries survived exactly.
# See docs/prod-snapshot-runbook.md §7.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_run.sh"

: "${KF_SNAPSHOT_SOURCE_URL:?KF_SNAPSHOT_SOURCE_URL must be set (the database the snapshot came from)}"
: "${DATABASE_URL:?DATABASE_URL must be set (the database the snapshot was loaded into)}"

run_snapshot_tool scripts/snapshot/roundtrip-check.ts "$@"
