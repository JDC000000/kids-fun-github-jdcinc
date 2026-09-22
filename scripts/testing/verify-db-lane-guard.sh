#!/usr/bin/env bash
# scripts/testing/verify-db-lane-guard.sh — prove the db lane's ADDRESS guard actually executes.
#
# ═══ WHAT THIS PROTECTS, AND WHY A CONFIG ASSERTION WOULD NOT ═══
# lib/testing/disposable-db-setup.ts is wired as the db project's setupFiles, and it relies on
# vitest MERGING array options across `extends` so the lane runs BOTH the base address guard
# (lib/testing/local-db-guard.ts, from vitest.config.ts) and the disposability proof. That merge
# is the load-bearing premise of the entire 2026-09-21 remediation: if it ever stops happening,
# the address guard silently does not run on the one lane that talks to a database.
#
# The failure would be INVISIBLE. The disposability guard would still fire, the lane would still
# look protected, and the only missing piece would be the check that refuses a non-local host
# before a connection is ever opened — which is exactly the check the incident turned on.
#
# The obvious test — assert the resolved config CONTAINS both setup files — is the wrong shape. It
# proves the wiring is PRESENT, not that the guard RUNS, and it would keep passing while the
# behaviour disappeared. That is the same mistake as asserting a connection string LOOKS like a
# managed host instead of asking what host it resolves to.
#
# So this asks the question behaviourally: point the db lane at a host only the BASE guard refuses
# (non-local, but NOT a managed endpoint, so the disposability guard's absolute refusal is not what
# answers) and require the refusal to name the base guard. Nothing here reads a config file.
#
# ═══ VALIDATED WITH A NEGATIVE CONTROL, NOT JUST A PASSING RUN ═══
# A check that has only ever been seen to pass proves nothing. This one was validated by
# reproducing the regression: create a throwaway detached worktree, set vitest.config.ts's
# setupFiles to [], symlink node_modules, and run this script against it. It must FAIL. Measured
# when that was done: healthy 2-3s, regressed 11s — the regressed run is slower precisely BECAUSE
# nothing refuses on the address any more, so the lane really dials the unreachable host and waits
# for the timeout. If you change this script, re-run that procedure; do not trust a green run.
#
# ═══ WHY IT IS NOT A TEST IN THE DB LANE ═══
# Circular. A broken lane setup is the very fault being detected, so a test living inside that lane
# could be disabled by the thing it exists to catch. It runs as a preflight in scripts/test.sh and
# is safe to call directly from CI.
set -uo pipefail
ROOT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT_DIR" || { echo "verify-db-lane-guard: cannot enter $ROOT_DIR" >&2; exit 9; }

# Non-local and deliberately NOT a managed-provider hostname: a managed host is refused absolutely
# by the disposability guard too, which would let this pass for the wrong reason.
PROBE_URL='postgres://u:p@10.0.0.5:5432/db'
out="$(DATABASE_URL="$PROBE_URL" timeout 120 \
       npx vitest run --project db tests/rls_public_tables.test.ts 2>&1)"
rc=$?

if printf '%s' "$out" | grep -q 'local-db-guard.*non-local host'; then
  echo "✔ db-lane address guard fires (base guard reached before any connection)."
  exit 0
fi

{
  echo ""
  echo "✖ THE DB LANE'S ADDRESS GUARD DID NOT FIRE."
  echo ""
  echo "  Pointed the db lane at ${PROBE_URL} and lib/testing/local-db-guard.ts did not refuse it."
  echo "  The most likely cause is that vitest's setupFiles no longer MERGE across \`extends\`, so"
  echo "  vitest.config.ts's base guard is not being loaded for the db project — see"
  echo "  lib/testing/disposable-db-setup.ts and vitest.workspace.ts."
  echo ""
  echo "  This is not a test failure to route around. Until it is fixed, the db lane can open a"
  echo "  connection to a non-local database without being stopped on the address first, which is"
  echo "  the 2026-09-21 production-pollution failure mode."
  echo ""
  echo "  (child vitest exit=${rc}; a slow run here is itself a symptom — with no address refusal"
  echo "   the lane actually dials the unreachable host and waits for the timeout.)"
  echo "  last lines of the child run:"
  printf '%s\n' "$out" | tail -n 3 | sed 's/^/      /'
} >&2
exit 1
