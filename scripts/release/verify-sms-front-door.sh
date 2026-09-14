#!/usr/bin/env bash
# scripts/release/verify-sms-front-door.sh
#
# POST-DEPLOY verification of the SMS front door (TSD v1.2 §9 M4 T4.4 / AC-08, AC-08b, AC-12).
# Run this AGAINST A DEPLOYED ORIGIN, AFTER a deploy. It is read-only: GETs and status codes only.
#
# ══════════════════════════════════════════════════════════════════════════════════════════════
# 🔴 THE TRAP THIS SCRIPT EXISTS TO CLOSE — READ THIS BEFORE RUNNING IT
# ══════════════════════════════════════════════════════════════════════════════════════════════
# `next.config.mjs`'s redirects() and headers() are BAKED INTO .next/routes-manifest.json WHEN THE
# APP IS BUILT. The config file says so in its own comment:
#
#     "a restart does not pick it up. Verifying this in a running deployment means a REDEPLOY,
#      not a bounce."
#
# So checking the /sms/signup → /sms/start redirect against a deployment that was merely
# RESTARTED, BOUNCED or SCALED gives a FALSE PASS off the previous release's manifest. The check
# looks green, the operator announces the release, and every already-printed QR code is on a
# promise nobody actually verified. AC-08b exists because that redirect is the ONLY thing keeping
# those printed codes working, and they cannot be un-printed.
#
# THIS SCRIPT THEREFORE REFUSES TO REPORT A PASS UNTIL IT HAS PROVEN THE BUILD IS THE ONE YOU
# MEAN. It does that from the live commit SHA — /api/health echoes VERCEL_GIT_COMMIT_SHA, which
# is injected AT BUILD TIME, exactly like the redirect manifest. Same build, same value; a bounce
# does not change it, a deploy does. A restarted deployment cannot pass the gate below.
#
# ══════════════════════════════════════════════════════════════════════════════════════════════
# HOW TO RUN IT
# ══════════════════════════════════════════════════════════════════════════════════════════════
#   1. Merge, then DEPLOY (not restart, not bounce, not "redeploy from cache" — a real build).
#   2. Take the SHA that was deployed:        git rev-parse HEAD
#   3. Run:
#
#        scripts/release/verify-sms-front-door.sh \
#          --origin https://kidsfunapp.ca \
#          --commit "$(git rev-parse HEAD)"
#
#   4. Exit 0 = release verified. Any non-zero = DO NOT ANNOUNCE THE RELEASE; read the output.
#
# There is deliberately NO flag to skip the freshness gate. If the hosting platform ever stops
# injecting a build-time commit SHA, this script must be changed on purpose, by someone who has
# read the trap above — not waved through at 2am by someone who just wants a green tick.
# ══════════════════════════════════════════════════════════════════════════════════════════════
set -uo pipefail

ORIGIN=""
COMMIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --origin) ORIGIN="${2:-}"; shift 2 ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '1,46p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ORIGIN" ] || [ -z "$COMMIT" ]; then
  echo "usage: $0 --origin https://kidsfunapp.ca --commit \$(git rev-parse HEAD)" >&2
  echo "  Both are required. --commit is what proves you are testing a FRESH DEPLOY and not a" >&2
  echo "  bounced one serving a stale routes-manifest.json (TSD §4.9)." >&2
  exit 2
fi

ORIGIN="${ORIGIN%/}"
FAILURES=0
BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'

pass() { printf '  %sPASS%s  %s\n' "$GREEN" "$OFF" "$1"; }
fail() { printf '  %s%sFAIL%s  %s\n' "$BOLD" "$RED" "$OFF" "$1"; FAILURES=$((FAILURES + 1)); }
note() { printf '        %s%s%s\n' "$DIM" "$1" "$OFF"; }

# HTTP status for a path, WITHOUT following redirects. Following one makes a 308 and a 200
# indistinguishable, which is the entire subject of AC-08b.
http_status() { curl -sS -o /dev/null -w '%{http_code}' --max-redirs 0 --max-time 20 "${ORIGIN}$1" 2>/dev/null || echo "000"; }
http_location() { curl -sS -o /dev/null -w '%{redirect_url}' --max-redirs 0 --max-time 20 "${ORIGIN}$1" 2>/dev/null || echo ""; }
http_body() { curl -sS -L --max-time 20 "${ORIGIN}$1" 2>/dev/null || echo ""; }

printf '\n%sKIDS FUN — SMS front-door release verification%s\n' "$BOLD" "$OFF"
printf 'origin  %s\nexpect  build from commit %s\n\n' "$ORIGIN" "$COMMIT"

# ─────────────────────────────────────────────────────────────────────────────────────────────
# GATE 0 — IS THIS A FRESH DEPLOY? Everything after this is meaningless if the answer is no.
# ─────────────────────────────────────────────────────────────────────────────────────────────
printf '%s0 · BUILD FRESHNESS — the gate (TSD §4.9)%s\n' "$BOLD" "$OFF"

HEALTH="$(http_body /api/health)"
LIVE_COMMIT="$(printf '%s' "$HEALTH" | sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

if [ -z "$HEALTH" ]; then
  fail "/api/health returned nothing — cannot reach ${ORIGIN}, so nothing below can be trusted"
  exit 1
fi

if [ -z "$LIVE_COMMIT" ]; then
  fail "/api/health reports commit: null — build freshness CANNOT BE PROVEN"
  note "VERCEL_GIT_COMMIT_SHA is injected at build time and is null on local/non-Vercel builds."
  note "Without it there is no way to tell a fresh deploy from a bounced one, and the /sms/signup"
  note "redirect check below would be a coin toss reported as a fact. Refusing to continue."
  note "If the platform changed, fix this script deliberately — do not bypass it."
  exit 1
fi

case "$LIVE_COMMIT" in
  "$COMMIT"*) MATCH=1 ;;
  *) case "$COMMIT" in "$LIVE_COMMIT"*) MATCH=1 ;; *) MATCH=0 ;; esac ;;
esac

if [ "$MATCH" != "1" ]; then
  fail "the origin is serving a DIFFERENT BUILD than the one you deployed"
  note "live:     ${LIVE_COMMIT}"
  note "expected: ${COMMIT}"
  note ""
  note "🔴 This is the §4.9 trap firing. redirects() and headers() live in .next/routes-manifest"
  note ".json, which is written at BUILD time — a restart, a bounce, a scale event or a cached"
  note "redeploy all keep the OLD manifest. Verifying /sms/signup now would report the PREVIOUS"
  note "release's behaviour as if it were this one."
  note ""
  note "Do a real deploy of ${COMMIT}, wait for it to be live, then re-run this script."
  exit 1
fi
pass "live build is commit ${LIVE_COMMIT} — this is a fresh deploy of the code under test"
note "so the routes-manifest below was compiled from THIS commit's next.config.mjs"
echo

# ─────────────────────────────────────────────────────────────────────────────────────────────
# 1 — AC-08b: the redirect that keeps already-printed QR codes working.
# ─────────────────────────────────────────────────────────────────────────────────────────────
printf '%s1 · AC-08b — /sms/signup still redirects (the printed-QR guarantee)%s\n' "$BOLD" "$OFF"

SIGNUP_STATUS="$(http_status /sms/signup)"
SIGNUP_LOCATION="$(http_location /sms/signup)"

if [ "$SIGNUP_STATUS" = "308" ]; then
  case "$SIGNUP_LOCATION" in
    */sms/start|*/sms/start\?*) pass "/sms/signup → 308 → ${SIGNUP_LOCATION}" ;;
    *) fail "/sms/signup answered 308 but points at ${SIGNUP_LOCATION}, not /sms/start" ;;
  esac
else
  fail "/sms/signup answered ${SIGNUP_STATUS}, not 308"
  note "This redirect is the ONLY thing keeping already-printed QR codes and externally shared"
  note "links working (AC-08b, Mod Spec Delta 14). It looks like dead weight and is not."
  note "Gate 0 already proved this IS a fresh build, so this is a real removal from"
  note "next.config.mjs — not a stale manifest. Restore it."
fi

# Query strings must ride along, or utm attribution silently disappears from the funnel.
UTM_LOCATION="$(http_location '/sms/signup?utm_source=qr')"
case "$UTM_LOCATION" in
  *utm_source=qr*) pass "the query string survives the hop (utm attribution intact)" ;;
  *) fail "the hop dropped the query string: ${UTM_LOCATION}" ;;
esac
echo

# ─────────────────────────────────────────────────────────────────────────────────────────────
# 2 — AC-12: SMS_SIGNUP_ENABLED is true in production, OBSERVED rather than asserted.
# ─────────────────────────────────────────────────────────────────────────────────────────────
printf '%s2 · AC-12 — the release switch, confirmed live%s\n' "$BOLD" "$OFF"
note "Not read from a dashboard: app/sms/start/page.tsx calls notFound() unless"
note "SMS_SIGNUP_ENABLED is exactly \"true\", so a 200 here IS the flag's live value."

START_STATUS="$(http_status /sms/start)"
HOME_HTML="$(http_body /)"
HOME_HAS_CTA=0
printf '%s' "$HOME_HTML" | grep -q 'kf-home__sms-cta' && HOME_HAS_CTA=1

if [ "$START_STATUS" = "200" ]; then
  pass "/sms/start answers 200 — SMS_SIGNUP_ENABLED is \"true\" in production"
else
  fail "/sms/start answers ${START_STATUS} — SMS_SIGNUP_ENABLED is NOT \"true\" in production"
  note "The front door's primary call to action has nowhere to go. Set the variable and redeploy"
  note "BEFORE announcing the release (AC-12, risk R-01 — the most serious risk in the TSD)."
fi

# The cross-surface half. A disagreement between these two is AC-12's exact failure mode, and it
# is the one thing neither surface can detect on its own.
if [ "$START_STATUS" = "200" ] && [ "$HOME_HAS_CTA" = "1" ]; then
  pass "the home page offers the signup action, and the destination serves — they agree"
elif [ "$START_STATUS" != "200" ] && [ "$HOME_HAS_CTA" = "0" ]; then
  pass "signup is off and the home page correctly renders NO action (fail-safe branch held)"
elif [ "$HOME_HAS_CTA" = "1" ]; then
  fail "🔴 the home page advertises signup but /sms/start answers ${START_STATUS}"
  note "The product's entire front door leads to a dead end. This is AC-12's failure, live."
else
  fail "/sms/start serves, but the home page renders no signup action — the front door is"
  note "hiding a working product."
fi
echo

# ─────────────────────────────────────────────────────────────────────────────────────────────
# 3 — AC-08: every existing address still works.
# ─────────────────────────────────────────────────────────────────────────────────────────────
printf '%s3 · AC-08 — every existing address still answers%s\n' "$BOLD" "$OFF"
for path in / /search '/search?q=family+swim' /coverage-status /privacy /terms; do
  code="$(http_status "$path")"
  if [ "$code" = "200" ]; then pass "200  ${path}"; else fail "${code}  ${path} (expected 200)"; fi
done
note "/account is NOT checked here. Jon's product-wide sign-in ruling governs it (TSD §9 T4.3);"
note "its status is owned by that workstream and a non-200 is not a regression from this work."
note "/activity/[id] is not swept here either — a live id is catalogue state, not a route fact."
echo

# ─────────────────────────────────────────────────────────────────────────────────────────────
# 4 — AC-19 / DC-02: the "three things" capability survived to production.
# ─────────────────────────────────────────────────────────────────────────────────────────────
printf '%s4 · AC-19 — "three things" still exists (presence, not particular listings)%s\n' "$BOLD" "$OFF"
# Counted on `class="kf-home__pick-slot"` — the per-slot label, which renders for a FILLED and an
# EMPTY slot alike. The container class would not: a slot with nothing on emits
# `class="kf-home__pick kf-home__pick--empty"`, so matching the bare container silently undercounts
# on a quiet week and would read as a capability that had half disappeared.
PICKS="$(printf '%s' "$HOME_HTML" | grep -o 'class="kf-home__pick-slot"' | wc -l | tr -d ' ')"
if printf '%s' "$HOME_HTML" | grep -q 'kf-home__proof' && [ "$PICKS" -gt 0 ]; then
  pass "the proof block renders, with ${PICKS} pick slot(s)"
  [ "$PICKS" = "3" ] || note "expected 3 slots — ${PICKS} is not a failure here, but worth a look"
  note "Deliberately not checking WHICH activities — two other workstreams edit that selection"
  note "logic, and DC-02 protects the capability, not its output (TSD A-5). The exact slot count"
  note "is gated in tests/e2e/public/address-integrity.public.spec.ts, against a fixture."
else
  fail "the proof block is absent from the production home page — DC-02 says it must not be deleted"
fi
echo

# ─────────────────────────────────────────────────────────────────────────────────────────────
printf '%s──────────────────────────────────────────────────────────────%s\n' "$BOLD" "$OFF"
if [ "$FAILURES" = "0" ]; then
  printf '%s%s✔ RELEASE VERIFIED%s against a proven-fresh deploy of %s\n\n' "$BOLD" "$GREEN" "$OFF" "$LIVE_COMMIT"
  exit 0
fi
printf '%s%s✘ %s CHECK(S) FAILED — DO NOT ANNOUNCE THE RELEASE%s\n\n' "$BOLD" "$RED" "$FAILURES" "$OFF"
exit 1
