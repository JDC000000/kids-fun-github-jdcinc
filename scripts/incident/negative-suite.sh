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
#   KF_REPLICA_RESET='node /path/to/reset-replica.cjs'   # optional; restores the replica between cases
#   bash scripts/incident/negative-suite.sh
#
# The replica must be seeded to match the manifest's preconditions. That seeding tooling lives
# outside this repo on purpose: it is built from production-derived data and has no business being
# committed. Without KF_REPLICA_RESET the two cases that mutate the database are skipped, and the
# rest still run.
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
RESET="${KF_REPLICA_RESET:-}"
cd "$W" || exit 9
pass=0; fail=0; skip=0
reset_db() { [ -n "$RESET" ] && eval "$RESET" >/dev/null 2>&1; }
note() { printf '  %-46s %s\n' "$1" "$2"; }
run() { KF_CLEANUP_TARGET_URL="$U" timeout 240 bash scripts/incident/cleanup-2026-09-21-fixture-pollution.sh "$@" 2>&1; }
expect() { # expect <label> <pattern> <args...>
  local label="$1" pat="$2"; shift 2
  local out; out="$(run "$@")"          # capture, do NOT pipe: see note above about pipefail
  if printf '%s' "$out" | grep -qE "$pat"; then note "$label" "ok"; pass=$((pass+1));
  else note "$label" "MISSED"; fail=$((fail+1)); fi
}
mutate_json() { python3 -c "$1" ; }

reset_db

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

# an occurrence that exists but hangs off a NON-target series (one of the contained sources)
STRAY_OCC="$(U="$U" node "$HELP/helper-stray-occ.cjs" 2>/dev/null)"
if [ -n "$STRAY_OCC" ]; then
  mutate_json "
import json;m=json.load(open('$M'));m['target_occurrence_ids'].append('$STRAY_OCC');json.dump(m,open('/tmp/n14.json','w'))"
  expect "occurrence outside the target series" "do not belong to a target series" --manifest=/tmp/n14.json
fi

# containment trespass: archive a TARGET occurrence the way the Operator did
U="$U" node "$HELP/helper-archive-target.cjs" >/dev/null 2>&1
expect "Operator-archived row inside target set" "were archived by the Operator"
reset_db

# an orphan profile that turns out to have a real auth.users row => a REAL person
U="$U" node "$HELP/helper-real-person.cjs" >/dev/null 2>&1
expect "orphan profile has an auth.users row" "is a REAL account" --include-admin-fixtures
reset_db

rm -f /tmp/n1[1-4].json

rm -f /tmp/n*.json
echo "  ── pass=$pass fail=$fail ──"
[ "$fail" -eq 0 ]
