#!/usr/bin/env bash
# scripts/snapshot/export.sh — produce an anonymised catalogue snapshot. OPERATOR TOOL.
#
#   KF_SNAPSHOT_SOURCE_URL='postgres://…' bash scripts/snapshot/export.sh --label production
#
# READ-ONLY against the source. Exports only the allowlisted catalogue tables in
# lib/snapshot/policy.ts; user/account tables are never read. See docs/prod-snapshot-runbook.md.
#
# KF_SNAPSHOT_SOURCE_URL is used rather than DATABASE_URL on purpose — see the header of
# scripts/snapshot/export.ts. It is never printed, logged or written to the snapshot.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_run.sh"

: "${KF_SNAPSHOT_SOURCE_URL:?KF_SNAPSHOT_SOURCE_URL must be set (connection string of the database to snapshot)}"

run_snapshot_tool scripts/snapshot/export.ts "$@"
