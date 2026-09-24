// lib/security/search-rate-limit.ts — the rate limit behind GET /api/search.
//
// ═══ WHAT THIS STOPS ═══
// The 2026-09-22 incident (see supabase/migrations/0051_search_rate_limit.sql for the full
// writeup): a caller hitting /search then /api/search with an identical query every 1-3 seconds,
// 24/7, since at least 2026-08-28. GET /search and GET /api/search had no rate limit of any kind.
//
// ═══ SAME ATOMIC-COUNTER SHAPE AS lib/sms/throttle.ts, TWO WINDOWS INSTEAD OF ONE ═══
// The decision and the write are ONE statement (`INSERT ... ON CONFLICT ... DO UPDATE ... WHERE`),
// for the identical reason sms/throttle.ts's header explains: a check-then-write throttle only
// throttles callers polite enough to not fire concurrently, and a serverless endpoint is exactly
// where an abusive caller can. Two window sizes (minute + hour) close the gap a single window
// leaves open — see 0051's header for why both are needed.
//
// ═══ IP AND SESSION, BOTH — WITH DIFFERENT LIMITS, DELIBERATELY ASYMMETRIC ═══
// Same split as lib/sms/signup-store.ts's SIGNUP_THROTTLE_LIMITS (phonePerDay: 3, ipPerDay: 20):
// the PRECISE identity gets the tight limit, the SHARED identity gets a looser backstop.
//   • 'session' (the kf_anon_id cookie) is the precise identity here — one browser. It is what
//     the live incident traffic actually produces (it keeps a cookie jar, which is why it reads
//     as "one session" in analytics_event today), so it gets the tight limit.
//   • 'ip' is defence in depth against a caller that does NOT carry cookies — without an
//     IP-scoped limit, dropping the Set-Cookie response would be a free way to reset the session
//     counter on every request. But one IP can be many real, simultaneous households (a school,
//     an office, a carrier-grade NAT), so it is checked FIRST (a refusal there is cheaper — see
//     `checkSearchRateLimit`'s ordering note) but given a MUCH more generous ceiling, sized so
//     ordinary concurrent traffic from a shared address is never the thing that trips it.
//
// ═══ THE LIMITS, AND WHY THEY ARE SAFE FOR A REAL PARENT ═══
// /search is a plain `<form method=get>` (app/search/_components/SearchBar.tsx) with NO
// client-side typeahead — a real visitor generates one request per submit or per filter-chip
// click, not per keystroke. Even an unusually fast parent rapid-firing filter chips does not
// approach double digits of requests inside one minute from ONE browser. The incident traffic ran
// at roughly 20-60 requests/minute sustained from one session; session.perMinute refuses well
// below that ceiling's low end, and session.perHour refuses a caller who paces itself just under
// the per-minute cap to evade that alone. ip.perMinute/perHour are set high enough to absorb a
// genuinely busy shared address (a daycare, a school Wi-Fi) without ever being the limit that
// actually fires against real traffic — ip's job is catching a cookie-dropping abuser, not a
// household.
export const SEARCH_RATE_LIMITS = {
  session: {
    /** Requests per session inside a 60s bucket. */
    perMinute: 12,
    /** Requests per session inside a 3600s bucket — catches self-throttling just under perMinute. */
    perHour: 80,
  },
  ip: {
    perMinute: 40,
    perHour: 250,
  },
} as const;

/**
 * The DAU/WAU/MAU exclusion cutoff lib/analytics/kpi.ts applies to
 * analytics_event.search_minute_request_count (migration 0052) — READ time, not write time.
 *
 * ═══ WHY THIS IS A READ-TIME CUTOFF OVER A STORED COUNT, NOT A WRITE-TIME BOOLEAN ═══
 * An earlier version of this stamped a boolean at write time (>= 5/min ⇒ flagged) and excluded
 * any session with a flagged row from DAU/WAU/MAU for its ENTIRE window (up to 30 days for MAU).
 * Two independent reviews (2026-09-22) flagged the SAME problem from different angles: 5 is not
 * "double digits" — every filter-chip click in FilterRail/MobileFilterSheet/QuerySummary is its
 * own navigation, and a parent narrowing results with 5 chip clicks inside one minute is
 * completely ordinary, not abuse. Worse, a boolean is a DEAD END: a mis-tuned threshold silently
 * erases real sessions from KPIs with no stored reason and nothing to recompute from.
 *
 * Storing the RAW count (search_minute_request_count, nullable — null means "not measured":
 * degraded, no salt, no subject) and applying the cutoff in kpi.ts's query instead means (a) the
 * cutoff can be corrected after the fact with a query change, no backfill, no re-migration, and
 * (b) any specific exclusion is reviewable — `SELECT search_minute_request_count FROM
 * analytics_event WHERE ...` shows exactly why a session was or wasn't caught, rather than a bare
 * `true`.
 *
 * ═══ THE NUMBER ITSELF ═══
 * 10 — close to, but strictly below, session.perMinute's hard cap of 12 (so a caller that
 * self-throttles to 10-11/min to dodge the hard limit still gets excluded), while leaving a real,
 * fast-clicking parent room for up to 9 page-navigating actions in one minute before their
 * session is treated as suspect. This is a per-session-per-minute count, not a global assumption
 * about typical usage — a session that never reaches double digits in any single minute is never
 * touched by this at all, no matter how long or active the browsing.
 */
export const ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD = 10;

import { createHmac } from 'node:crypto';
import { query } from '@/lib/db/client';
import { phoneHashSalt } from '@/lib/sms/config';
import {
  DB_LIMITER_DEADLINE_MS,
  SearchRateLimitDeadlineError,
  defaultSearchRateLimitDegradedState,
  describeLimiterFailure,
  withDeadline,
  type SearchRateLimitDegradedState,
} from '@/lib/security/search-rate-limit-degraded';

type WindowGranularity = 'minute' | 'hour';
type IdentityKind = 'ip' | 'session';
type Scope = `${IdentityKind}_${WindowGranularity}`;

const WINDOW_SECONDS: Record<WindowGranularity, number> = { minute: 60, hour: 3600 };

export interface SearchRateLimitLimits {
  session: { perMinute: number; perHour: number };
  ip: { perMinute: number; perHour: number };
}

export interface SearchRateLimitResult {
  allowed: boolean;
  /** Which bucket refused the request. Null when allowed. Never exposed to the caller's response
   *  body — same posture as ThrottleReason in lib/sms/instant-picks-throttle.ts. */
  reason: Scope | null;
  /** Whole seconds until the refused bucket next admits a request. 0 when allowed. */
  retryAfterSeconds: number;
  /**
   * The DB check could not run, and the decision came from somewhere else:
   *   • 'no_salt' / 'no_subject' — there is nothing to count against, so the request is let
   *     through (FAIL OPEN, unchanged). 'no_salt' means the limiter is a COMPLETE, SILENT no-op
   *     and the caller reports it; 'no_subject' is a property of one request and is not reported.
   *   • 'db_error' — the counter table errored, hit its deadline, or the breaker is open. Since
   *     2026-09-24 this is NOT fail-open any more: the same buckets and limits are evaluated
   *     against a per-instance in-memory counter (`fallback: 'memory'`), so the request can still
   *     be REFUSED. Not fail-closed either: a limiter that blocked real parents because ITS OWN
   *     table is unreachable (while search still worked from cache, or a migration had not landed
   *     yet) would be worse than the abuse it exists to stop. See
   *     lib/security/search-rate-limit-degraded.ts for the full reasoning.
   */
  degraded: boolean;
  /** Why `degraded` is true. Null when not degraded. */
  degradedReason: 'no_salt' | 'no_subject' | 'db_error' | null;
  /** 'memory' when the decision came from the in-memory fallback (only with 'db_error'). */
  fallback: 'memory' | null;
  /**
   * Short, non-secret description of why the DB limiter was unavailable — the pg/Node error code
   * plus a truncated message, `SEARCH_RATE_LIMIT_DEADLINE: …`, or `breaker_open`. Null unless
   * `degradedReason === 'db_error'`. For reporting only; never put it in a response body.
   */
  degradedCause: string | null;
  /**
   * The subject's ALLOWED count in the current MINUTE bucket, for whichever identity actually
   * governed the decision — session when a session subject was checked, else ip. Null when
   * degraded (no bucket was ever consulted). Diagnostic/internal; analytics must read
   * `sessionMinuteAttempts` instead — see that field.
   */
  minuteAttempts: number | null;
  /**
   * The SESSION-scope minute count SPECIFICALLY, or null when no session subject was available to
   * check at all (a cookieless caller).
   *
   * ═══ 🟡 F3 (2026-09-22 independent recheck): ip-scope counts MUST NEVER feed a per-actor
   * exclusion, not even with a bigger threshold ═══
   * `ip.perMinute` is deliberately ~3x `session.perMinute` specifically so a shared address (a
   * school, an office, a CGNAT) never trips the RATE limit — see this module's header. Before this
   * field existed, `app/api/search/route.ts` stamped `minuteAttempts` (falling back to the ip
   * count when no session was present) into `analytics_event.search_minute_request_count`, and
   * `lib/analytics/kpi.ts` applied the SAME `ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD` to it
   * regardless of which bucket produced it. Reproduced live: 12 cookieless requests from one IP,
   * every one individually ALLOWED (nowhere near ip.perMinute=40), yet every real actor sharing
   * that address got silently excluded from DAU/WAU/MAU anyway — the exact failure class this
   * whole incident started from, re-entering through a different door.
   *
   * The fix is not a bigger or bucket-aware threshold at the read side: an ip-derived count is
   * architecturally NOT ATTRIBUTABLE to one visitor (many real people can share an IP; they
   * cannot share a session), so it must never reach the per-actor analytics signal AT ALL. Callers
   * (app/api/search/route.ts) surface ONLY this field to analytics; `minuteAttempts` above stays
   * available for diagnostics/tests but is not what a caller should stamp onto a row.
   */
  sessionMinuteAttempts: number | null;
}

export interface SearchRateLimitSubject {
  ip: string | null;
  sessionId: string | null;
}

export interface SearchRateLimitOptions {
  limits?: SearchRateLimitLimits;
  /** Injected for tests; defaults to the shared pool in lib/db/client.ts. */
  query?: typeof query;
  /** Injected for tests; defaults to this instance's shared breaker + memory fallback. */
  degradedState?: SearchRateLimitDegradedState;
  /** Injected for tests; defaults to DB_LIMITER_DEADLINE_MS. */
  dbDeadlineMs?: number;
}

type BucketCounter = (
  scope: Scope,
  hash: string,
  windowSeconds: number,
  maxAttempts: number
) => Promise<{ allowed: boolean; attempts: number }>;

/** HMAC the subject under the shared SMS phone-hash salt, domain-separated per identity kind —
 *  same pattern as lib/sms/instant-picks-throttle.ts's `instantPicksSubjectHash`. Reusing the salt
 *  (rather than provisioning a new secret) is safe BECAUSE of the domain prefix: a value hashed
 *  here can never collide with a value hashed for 'sms-signup-ip:' or any other existing prefix
 *  under the same salt. Null when no salt is provisioned — the caller must degrade open. */
function subjectHash(kind: IdentityKind, value: string): string | null {
  const salt = phoneHashSalt();
  if (!salt) return null;
  const prefix = kind === 'ip' ? 'search-rate-ip:' : 'search-rate-session:';
  return createHmac('sha256', salt).update(`${prefix}${value}`).digest('hex');
}

/**
 * One atomic check-and-increment against one (scope, subject, window) bucket. Mirrors
 * lib/sms/throttle.ts::countAttempt exactly, generalised to a caller-supplied window size instead
 * of a fixed UTC calendar day.
 *
 * `window_start` is computed here (not by a DB DEFAULT) from the caller's clock, floored to the
 * window size, so every concurrent request in the same window names the identical row and
 * collides on it — which is what makes the `ON CONFLICT` row lock actually serialise them.
 */
async function countAttempt(
  run: typeof query,
  scope: Scope,
  hash: string,
  windowSeconds: number,
  maxAttempts: number
): Promise<{ allowed: boolean; attempts: number }> {
  const bucketMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / bucketMs) * bucketMs);
  const rows = await run<{ attempts: number }>(
    `INSERT INTO search_rate_limit (scope, subject_hash, window_start)
          VALUES ($1, $2, $3)
     ON CONFLICT (scope, subject_hash, window_start) DO UPDATE
            SET attempts        = search_rate_limit.attempts + 1,
                last_attempt_at = now()
          WHERE search_rate_limit.attempts < $4
      RETURNING attempts`,
    [scope, hash, windowStart.toISOString(), maxAttempts]
  );
  const row = rows[0];
  return { allowed: Boolean(row), attempts: row?.attempts ?? maxAttempts };
}

/**
 * Check (and, if allowed, record) one request against the search rate limit. NEVER THROWS — a
 * limiter that can 500 the page is a worse outage than the traffic it is meant to stop.
 *
 * When the counter table cannot answer (error, DB_LIMITER_DEADLINE_MS exceeded, or this instance's
 * breaker is open), the SAME decision is made against an in-memory fallback and returned with
 * `degradedReason: 'db_error', fallback: 'memory'` — so a DB outage no longer lets every request
 * through. See lib/security/search-rate-limit-degraded.ts.
 *
 * Order of checks: ip_minute, ip_hour, session_minute, session_hour. IP first because it is the
 * CHEAPER-TO-EVALUATE, more generous backstop (see this module's header) — a request that IP
 * already refuses should not also spend a session-scope write, exactly like lib/sms/throttle.ts's
 * phone-before-ip ordering avoids charging the more specific counter for an already-refused
 * request. The reported `reason` is always the FIRST bucket that refused, which is the one a
 * Retry-After header should be computed from.
 *
 * ═══ UP TO 4 SEQUENTIAL DB ROUND TRIPS, CONSIDERED AND DELIBERATELY NOT COLLAPSED ═══
 * (2026-09-22 review) The worst case — both an IP and a session subject present, both fully
 * within budget — is 4 round trips: ip_minute, ip_hour, session_minute, session_hour, each
 * awaited in turn. Combining minute+hour for one identity into a single multi-row
 * `INSERT ... VALUES (row1), (row2) ON CONFLICT ...` IS possible in Postgres, but it would also
 * remove the short-circuit this file leans on elsewhere: a request refused by the minute bucket
 * currently never touches the hour bucket at all (see `countAttempt`'s "refused leaves the row
 * untouched" invariant and its test coverage in tests/security/search-rate-limit.test.ts).
 * Collapsing the two into one statement means EVERY request charges both, changing that
 * invariant for a performance win that is smaller than it looks: a refused request (the case
 * this file spends the most traffic on, by construction — that is the abuse it exists to stop)
 * already short-circuits to 1-2 round trips today, and an ALLOWED request's 4 round trips replace
 * the FAR larger cost — the listing/alias/region load in searchDatabase() — that this limiter
 * exists specifically to let a refused request skip entirely. Reworking the short-circuit
 * semantics under review pressure, for a "minor, not blocking" cost concern, was judged a worse
 * trade than leaving it and writing this down.
 */
export async function checkSearchRateLimit(
  subject: SearchRateLimitSubject,
  options: SearchRateLimitOptions = {}
): Promise<SearchRateLimitResult> {
  const limits = options.limits ?? SEARCH_RATE_LIMITS;

  const ipHash = subject.ip ? subjectHash('ip', subject.ip) : null;
  const sessionHash = subject.sessionId ? subjectHash('session', subject.sessionId) : null;

  if (!ipHash && !sessionHash) {
    // Either no salt is provisioned (dev/test — SMS_PHONE_HASH_SALT is unset), or the caller had
    // neither an IP nor a session id to check. Either way there is no subject to count against.
    // `query` (the module import) is deliberately NOT referenced on this path — see `run`'s
    // definition below for why merely reading that binding is not always free.
    const degradedReason = subject.ip || subject.sessionId ? 'no_salt' : 'no_subject';
    return {
      allowed: true,
      reason: null,
      retryAfterSeconds: 0,
      degraded: true,
      degradedReason,
      fallback: null,
      degradedCause: null,
      minuteAttempts: null,
      sessionMinuteAttempts: null,
    };
  }

  // Resolved HERE, not at the top of the function: `query` is a live-binding import from
  // lib/db/client, and merely EVALUATING `options.query ?? query` (an unconditional expression at
  // the top of a hot, request-scoped function) touches that binding even on a request this
  // function is about to answer without ever calling it. That is inert in production, but several
  // test suites (e.g. tests/search/route-db-no-fixture-leak.test.ts) `vi.mock('@/lib/db/client')`
  // with a factory that defines ONLY `getPool`. Vitest's auto-mock proxy THROWS on any access to
  // an export the factory didn't return, specifically to catch "forgot to mock this". Resolving
  // `run` down here means a request with no subject (the branch above) never touches `query` at
  // all, exactly like it never touches the database.
  const run = options.query ?? query;
  const state = options.degradedState ?? defaultSearchRateLimitDegradedState;
  const deadlineMs = options.dbDeadlineMs ?? DB_LIMITER_DEADLINE_MS;

  const ticket = state.breaker.tryAcquire(state.now());
  if (!ticket) {
    return memoryFallback(state, ipHash, sessionHash, limits, 'breaker_open');
  }

  try {
    const result = await withDeadline(
      (budget) =>
        evaluateBuckets(
          (scope, hash, windowSeconds, maxAttempts) => {
            // Once the deadline has fired, the abandoned sequence must not go on to issue its
            // remaining statements against a pool that is already struggling.
            if (budget.expired) return Promise.reject(new SearchRateLimitDeadlineError(deadlineMs));
            return countAttempt(run, scope, hash, windowSeconds, maxAttempts);
          },
          ipHash,
          sessionHash,
          limits
        ),
      deadlineMs
    );
    state.breaker.recordSuccess(ticket);
    return result;
  } catch (err) {
    // The counter table errored, or did not answer within the deadline (a real DB outage, pooler
    // exhaustion, or migration 0051 not applied yet). Count it against the breaker and decide
    // from the in-memory fallback instead — see lib/security/search-rate-limit-degraded.ts.
    state.breaker.recordFailure(ticket, state.now());
    return memoryFallback(state, ipHash, sessionHash, limits, describeLimiterFailure(err));
  }
}

/**
 * The four-bucket decision — ip_minute, ip_hour, session_minute, session_hour, first refusal wins —
 * against whichever counter it is handed (the DB table, or the in-memory fallback), so both paths
 * share one definition of the ordering and short-circuit rules described on checkSearchRateLimit.
 */
async function evaluateBuckets(
  count: BucketCounter,
  ipHash: string | null,
  sessionHash: string | null,
  limits: SearchRateLimitLimits
): Promise<SearchRateLimitResult> {
  let minuteAttempts: number | null = null;
  // Stays null unless the session bucket is actually reached — see this field's header on
  // SearchRateLimitResult for why an ip-derived count must never leak into it (F3).
  let sessionMinuteAttempts: number | null = null;

  if (ipHash) {
    const minute = await count('ip_minute', ipHash, WINDOW_SECONDS.minute, limits.ip.perMinute);
    if (!minute.allowed) {
      return {
        allowed: false,
        reason: 'ip_minute',
        retryAfterSeconds: WINDOW_SECONDS.minute,
        degraded: false,
        degradedReason: null,
        fallback: null,
        degradedCause: null,
        minuteAttempts: minute.attempts,
        sessionMinuteAttempts: null,
      };
    }
    minuteAttempts = minute.attempts;

    const hour = await count('ip_hour', ipHash, WINDOW_SECONDS.hour, limits.ip.perHour);
    if (!hour.allowed) {
      return {
        allowed: false,
        reason: 'ip_hour',
        retryAfterSeconds: WINDOW_SECONDS.hour,
        degraded: false,
        degradedReason: null,
        fallback: null,
        degradedCause: null,
        minuteAttempts,
        sessionMinuteAttempts: null,
      };
    }
  }

  if (sessionHash) {
    const minute = await count('session_minute', sessionHash, WINDOW_SECONDS.minute, limits.session.perMinute);
    if (!minute.allowed) {
      return {
        allowed: false,
        reason: 'session_minute',
        retryAfterSeconds: WINDOW_SECONDS.minute,
        degraded: false,
        degradedReason: null,
        fallback: null,
        degradedCause: null,
        minuteAttempts: minute.attempts,
        sessionMinuteAttempts: minute.attempts,
      };
    }
    // The session-scope minute count is the more precise DIAGNOSTIC signal when both
    // identities were checked (it is the exact subject, not a possibly-shared IP), so it wins
    // for `minuteAttempts`. `sessionMinuteAttempts` is set HERE and only here — the one place
    // in this function a real session subject was confirmed present.
    minuteAttempts = minute.attempts;
    sessionMinuteAttempts = minute.attempts;

    const hour = await count('session_hour', sessionHash, WINDOW_SECONDS.hour, limits.session.perHour);
    if (!hour.allowed) {
      return {
        allowed: false,
        reason: 'session_hour',
        retryAfterSeconds: WINDOW_SECONDS.hour,
        degraded: false,
        degradedReason: null,
        fallback: null,
        degradedCause: null,
        minuteAttempts,
        sessionMinuteAttempts,
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    retryAfterSeconds: 0,
    degraded: false,
    degradedReason: null,
    fallback: null,
    degradedCause: null,
    minuteAttempts,
    sessionMinuteAttempts,
  };
}

/**
 * The same buckets and limits, counted in this instance's memory. Marked degraded, and neither
 * attempts field is populated: an in-memory count is per instance and approximate, so it must not
 * reach analytics_event.search_minute_request_count ("null means not measured").
 */
async function memoryFallback(
  state: SearchRateLimitDegradedState,
  ipHash: string | null,
  sessionHash: string | null,
  limits: SearchRateLimitLimits,
  cause: string
): Promise<SearchRateLimitResult> {
  const decision = await evaluateBuckets(
    (scope, hash, windowSeconds, maxAttempts) =>
      Promise.resolve(state.store.countAttempt(scope, hash, windowSeconds, maxAttempts, Date.now())),
    ipHash,
    sessionHash,
    limits
  );
  return {
    ...decision,
    degraded: true,
    degradedReason: 'db_error',
    fallback: 'memory',
    degradedCause: cause,
    minuteAttempts: null,
    sessionMinuteAttempts: null,
  };
}
