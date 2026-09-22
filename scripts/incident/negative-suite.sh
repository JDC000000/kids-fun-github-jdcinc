#!/usr/bin/env bash
# scripts/incident/negative-suite.sh — negative tests for the cleanup script's require_() guards.
#
# ═══ WHY THIS EXISTS ═══
# The cleanup script deletes ~183 rows from PRODUCTION. Its safety rests entirely on its own
# require_() guards, and a mutation sweep found 17 of 29 of them unexercised: they could have been
# deleted and nothing would have noticed. These had previously only been checked by ad-hoc shell
# commands typed by hand each review round, which is not a test.
#
# ═══ RUNNING IT ═══
#   KF_CLEANUP_TARGET_URL='postgres://…local replica…'   # REQUIRED — never production
#   KF_REPLICA_RESET='KF_SESSION_ID=<your-session-id> node /path/to/reset-replica.cjs'
#                                                        # REQUIRED — restores the replica between cases
#                                                        # must reset the SAME database as the URL above
#   bash scripts/incident/negative-suite.sh
#
# The replica must be seeded to match the manifest's preconditions. That seeding tooling lives
# outside this repo on purpose: it is built from production-derived data and has no business being
# committed.
#
# KF_REPLICA_RESET is REQUIRED and the suite exits 2 without it. This header previously called it
# optional and said the mutating cases would be "skipped" — text left over from a version that did
# degrade gracefully, and wrong since the required check went in. An operator reads the header
# first, so a stale header is not a documentation nit: it tells them the run they just did was
# valid when it was not. Measured, before it was made required: 11 pass, 5 spurious fail, 2 skip.
#
# The suite also PROVES the two variables name the same database before it starts (see the reset
# sentinel below) rather than trusting that they do.
#
# ═══ A TRAP THIS SUITE ITSELF FELL INTO ═══
# The first version piped each run into `grep -q` under `set -o pipefail`. grep -q exits on the
# first match, the producer takes SIGPIPE, and the PIPELINE status becomes 141 — so a SUCCESSFUL
# match read as a failure and all 13 cases reported MISSED. Output is captured to a variable and
# matched separately for exactly that reason. Verify your harness before you believe it.
set -uo pipefail
W="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELP="$W/scripts/incident/negative"
U="${KF_CLEANUP_TARGET_URL:?KF_CLEANUP_TARGET_URL must be set (a LOCAL replica, never production)}"
M="$W/scripts/incident/manifest-2026-09-21-fixture-pollution.json"
# REQUIRED, not optional. Several cases mutate the replica, and every case assumes a clean one,
# so without a reset between them the database drifts and later cases fail for reasons that
# have nothing to do with the guard under test. An earlier version made this optional and
# "degraded gracefully": it produced 11 passes, 5 spurious failures and 2 skips — a result that
# looks like findings and is noise. A suite that refuses to run beats one that invents failures.
if [ -z "${KF_REPLICA_RESET:-}" ]; then
  echo "KF_REPLICA_RESET must be set: a command that restores the replica to the manifest's" >&2
  echo "preconditions, e.g. KF_REPLICA_RESET='node /path/to/reset-replica.cjs'." >&2
  exit 2
fi
RESET="$KF_REPLICA_RESET"
cd "$W" || exit 9
# No `skip` counter. There used to be one, initialised and then never incremented or printed —
# left from the version where a missing KF_REPLICA_RESET skipped the mutating cases. Nothing skips
# any more: a case that cannot run aborts the suite instead, so the only honest counters are these
# two, and a dead one would imply the suite still has a silent third outcome.
pass=0; fail=0
# ═══ A FAILED RESET USED TO BE INVISIBLE ═══
# This was `eval "$RESET" >/dev/null 2>&1`, which discards stdout, stderr AND the exit status. If
# the reset command failed — wrong path, database not running, a typo in the variable — the suite
# carried on and reported pass/fail counts as though every case had run against a freshly restored
# replica. Those results are indistinguishable from real findings, which makes them worse than no
# results at all. The suite now stops on the first failed reset and prints what the command said.
reset_db() {
  local out rc
  out="$(eval "$RESET" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    {
      echo ""
      echo "FATAL: KF_REPLICA_RESET failed (exit $rc) — aborting rather than reporting."
      echo "  command: $RESET"
      echo "  output:"
      printf '%s\n' "$out" | sed 's/^/    /'
      echo "  Every case assumes a freshly reset replica. Continuing would surface stale drift as"
      echo "  guard findings, which look exactly like signal. A suite that stops beats one that lies."
    } >&2
    exit 4
  fi
}
note() { printf '  %-46s %s\n' "$1" "$2"; }
run() { KF_CLEANUP_TARGET_URL="$U" timeout 240 bash scripts/incident/cleanup-2026-09-21-fixture-pollution.sh "$@" 2>&1; }
expect() { # expect <label> <pattern> <args...>
  local label="$1" pat="$2"; shift 2
  local out; out="$(run "$@")"          # capture, do NOT pipe: see note above about pipefail
  if printf '%s' "$out" | grep -qE "$pat"; then note "$label" "ok"; pass=$((pass+1));
  else note "$label" "MISSED"; fail=$((fail+1)); fi
}
mutate_json() { python3 -c "$1" ; }

# ═══ KF_CLEANUP_TARGET_URL AND KF_REPLICA_RESET MUST NAME THE SAME DATABASE ═══
# They are independent variables, so nothing stopped the suite resetting one database while running
# the cleanup script and the write-helpers against another. Every case would then execute against a
# replica nobody restored.
#
# This does not ask the reset command what it targets — a declaration is only as good as the thing
# declaring it, and trusting a declaration over the actual target is the root of the incident this
# toolkit exists to clean up. It plants a uniquely-named sentinel table in the database the suite
# will really use, resets, and requires the sentinel to be GONE.
SENTINEL="s$(date +%s)_$$"
if ! KF_CLEANUP_TARGET_URL="$U" node "$HELP/assert-reset-targets.cjs" plant "$SENTINEL"; then
  echo "could not plant the reset sentinel in KF_CLEANUP_TARGET_URL — refusing to run." >&2
  exit 5
fi
reset_db
KF_CLEANUP_TARGET_URL="$U" node "$HELP/assert-reset-targets.cjs" verify "$SENTINEL" || exit 3

# 0. baseline must SUCCEED (guards against a suite that passes by breaking everything)
base="$(run --include-admin-fixtures)"
if printf '%s' "$base" | grep -q "total rows removed: 183"; then note "baseline dry-run succeeds" "ok"; pass=$((pass+1));
else note "baseline dry-run succeeds" "MISSED"; fail=$((fail+1)); fi

wrongout="$(KF_CLEANUP_TARGET_URL='postgresql://postgres:postgres@127.0.0.1:55622/kf_wrong_db' timeout 240 bash scripts/incident/cleanup-2026-09-21-fixture-pollution.sh 2>&1)"
if printf '%s' "$wrongout" | grep -qE "does not match the manifest"; then note "wrong database" "ok"; pass=$((pass+1));
else note "wrong database" "MISSED"; fail=$((fail+1)); fi

mutate_json "
import json;m=json.load(open('$M'));m['target_sources'][0]['name']='DRIFTED';json.dump(m,open('/tmp/n1.json','w'))"
expect "source fingerprint drift" "fingerprint drift" --manifest=/tmp/n1.json

mutate_json "
import json;m=json.load(open('$M'));m['target_sources'].append(m['target_sources'][0]);json.dump(m,open('/tmp/n2.json','w'))"
expect "duplicate target ids" "duplicate target source ids" --manifest=/tmp/n2.json

mutate_json "
import json;m=json.load(open('$M'));m['target_sources'].append({'id':m['leave_alone_source_ids'][0],'family':'x','name':'x','terms_status':'allowed','created_at':'2026-09-21T18:46:38.305Z'});json.dump(m,open('/tmp/n3.json','w'))"
expect "leave_alone id inside target set" "ALSO leave_alone" --manifest=/tmp/n3.json

mutate_json "
import json;m=json.load(open('$M'));m['expected_preconditions']['bogus_key']=1;json.dump(m,open('/tmp/n4.json','w'))"
expect "manifest declares unknown precondition" "no query for it" --manifest=/tmp/n4.json

mutate_json "
import json;m=json.load(open('$M'));m['expected_preconditions']['occ_total']=999999;json.dump(m,open('/tmp/n5.json','w'))"
expect "precondition value drift" "precondition occ_total" --manifest=/tmp/n5.json

mutate_json "
import json;m=json.load(open('$M'));m['expected_dependent_counts']['provenaance']=m['expected_dependent_counts'].pop('provenance');json.dump(m,open('/tmp/n6.json','w'))"
expect "misspelled dependent-count key" "is misspelled or a delete is missing" --manifest=/tmp/n6.json --include-admin-fixtures

mutate_json "
import json;m=json.load(open('$M'));m['expected_dependent_counts']['provenance']=999;json.dump(m,open('/tmp/n7.json','w'))"
expect "dependent count mismatch" "Blast radius differs" --manifest=/tmp/n7.json --include-admin-fixtures

mutate_json "
import json;m=json.load(open('$M'));m['target_series_ids'].append('00000000-0000-4000-8000-000000000000');json.dump(m,open('/tmp/n8.json','w'))"
expect "nonexistent series id" "do not exist in this database" --manifest=/tmp/n8.json

mutate_json "
import json;m=json.load(open('$M'));m['fixture_venues'][0]['name']='RENAMED VENUE';json.dump(m,open('/tmp/n9.json','w'))"
expect "venue name drift" "no longer carry their recorded name" --manifest=/tmp/n9.json

mutate_json "
import json;m=json.load(open('$M'));m['target_sources']=[];json.dump(m,open('/tmp/n10.json','w'))"
expect "empty target set" "no target_sources" --manifest=/tmp/n10.json


# ── cases added after a require_() mutation sweep showed 17 of 29 guards unexercised ──
mutate_json "
import json;m=json.load(open('$M'));m['target_sources'][0]['created_at']='2020-01-01T00:00:00+00:00';json.dump(m,open('/tmp/n11.json','w'))"
expect "source created_at drift" "created_at drift" --manifest=/tmp/n11.json

mutate_json "
import json;m=json.load(open('$M'));m['fixture_venues'].append({'id':'00000000-0000-4000-8000-0000000000aa','name':'ghost','created_at':'2026-09-21T18:47:00+00:00'});json.dump(m,open('/tmp/n12.json','w'))"
expect "nonexistent venue id" "venue id\\(s\\) do not exist" --manifest=/tmp/n12.json

mutate_json "
import json;m=json.load(open('$M'));m['target_occurrence_ids'].append('00000000-0000-4000-8000-0000000000bb');json.dump(m,open('/tmp/n13.json','w'))"
expect "nonexistent occurrence id" "occurrence id\\(s\\) do not exist" --manifest=/tmp/n13.json

# ═══ HELPER FAILURES WERE INVISIBLE, AND ONE OF THEM COULD HANG THE SUITE ═══
# These three invocations discarded stderr and ignored the exit status, and unlike run() none of
# them had a `timeout`. A helper that hung took the whole suite with it (reproduced: exit 124),
# and a helper that merely failed let its case be skipped or misattributed to the guard under
# test. Both are the same disease as findings E and F: a broken run that still reports cleanly.
run_helper() { # run_helper <file> — prints stdout, aborts the suite on any failure
  local f="$1" out rc
  out="$(U="$U" timeout 60 node "$HELP/$f" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    {
      echo ""
      [ "$rc" -eq 124 ] && echo "FATAL: $f TIMED OUT after 60s — aborting." \
                        || echo "FATAL: $f failed (exit $rc) — aborting."
      echo "  output:"; printf '%s\n' "$out" | sed 's/^/    /'
      echo "  The case this helper sets up cannot run, and a suite that quietly drops a case"
      echo "  still prints a clean summary. Fix the helper rather than trusting the total."
    } >&2
    exit 6
  fi
  printf '%s' "$out"
}

# an occurrence that exists but hangs off a NON-target series (one of the contained sources)
# NOTE THE `|| exit $?`, WHICH IS NOT DECORATION.
# run_helper aborts with `exit 6`, but this call site is a COMMAND SUBSTITUTION, so that exit
# kills only the subshell and the parent carries blithely on. The first version of this fix had
# exactly that hole: an injected helper failure printed "FATAL ... aborting" and then the suite
# kept running — it happened to stop at the empty-result check below, which made the guard look
# like it worked. A control that reports success while the thing it guards continues is worse
# than no control, and this is the second time tonight a subshell has hidden a status.
STRAY_OCC="$(run_helper helper-stray-occ.cjs)" || exit $?
# An empty result is NOT a pass. It means the replica has no occurrence in the shape this case
# needs, so the guard simply goes untested — and the old code skipped the case inside `if [ -n ]`
# with no counter and no message, leaving the summary reading as a full clean run.
if [ -z "$STRAY_OCC" ]; then
  echo "FATAL: helper-stray-occ.cjs returned no occurrence, so the containment case cannot run." >&2
  echo "  The replica is not seeded to the manifest's preconditions. Refusing to report a" >&2
  echo "  partial run as a clean one." >&2
  exit 7
fi
mutate_json "
import json;m=json.load(open('$M'));m['target_occurrence_ids'].append('$STRAY_OCC');json.dump(m,open('/tmp/n14.json','w'))"
expect "occurrence outside the target series" "do not belong to a target series" --manifest=/tmp/n14.json

# containment trespass: archive a TARGET occurrence the way the Operator did
run_helper helper-archive-target.cjs >/dev/null
expect "Operator-archived row inside target set" "were archived by the Operator"
reset_db

# an orphan profile that turns out to have a real auth.users row => a REAL person
run_helper helper-real-person.cjs >/dev/null
expect "orphan profile has an auth.users row" "is a REAL account" --include-admin-fixtures
reset_db

rm -f /tmp/n1[1-4].json

rm -f /tmp/n*.json
echo "  ── pass=$pass fail=$fail ──"
[ "$fail" -eq 0 ]
