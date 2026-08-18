#!/usr/bin/env bash
# scripts/snapshot/verify.sh — independently re-scan a snapshot on disk for personal data.
#
#   bash scripts/snapshot/verify.sh --in .snapshots/production-2026-08-18T12-00-00-000Z
#
# Touches no database. Run it on the machine that produced the snapshot, BEFORE the snapshot
# is copied anywhere. A non-zero exit means delete the file — do not ship it.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_run.sh"

run_snapshot_tool scripts/snapshot/verify.ts "$@"
