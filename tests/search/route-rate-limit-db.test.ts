// tests/search/route-rate-limit-db.test.ts — GET /api/search's rate limit, end-to-end against
// REAL Postgres (the `search_rate_limit` table from migration 0051).
//
// tests/security/search-rate-limit.test.ts already pins the decision logic against a faithful
// in-memory model of the table (same reasoning as tests/sms/signup_throttle.test.ts — read that
// file's header). This file exists to prove the OTHER half: that the real
// `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE` statement actually has the semantics the model
// assumes, AND that app/api/search/route.ts is wired to it correctly end-to-end — real HTTP
// headers in, a real 429 + Retry-After out, and the rateLimit signal riding in the JSON body for
// app/search/page.tsx to forward into analytics_event.search_minute_request_count (migration
// 0052).
//
// DB-gated (skipped without DATABASE_URL, like every other `-db` suite — see
// vitest.workspace.ts). Every request in this file uses a globally-unique IP/session pair
// (crypto.randomUUID()-derived) so it cannot collide with concurrent or prior runs sharing the
// same database, and the affected rows are deleted in `afterAll`.
//
// ═══ THE SALT IS STUBBED HERE, NOT READ FROM THE ENVIRONMENT — 2026-09-22 QA FINDING ═══
// The first version of this file gated on `Boolean(process.env.SMS_PHONE_HASH_SALT)` in its own
// `describe.skipIf`, same shape as the DATABASE_URL gate. That is NOT the pattern every other
// salt-dependent `-db` suite uses (tests/sms/signup_persistence-db.test.ts et al. all
// `vi.stubEnv('SMS_PHONE_HASH_SALT', ...)` in `beforeAll` instead) — and the difference is not
// cosmetic: ci.yml sets DATABASE_URL/USER_DATABASE_URL but never SMS_PHONE_HASH_SALT, so gating on
// the real env var meant this file reported "N skipped" in CI and had NEVER ONCE actually run
// there, even after the identity-forwarding blocker fix landed. Stubbing the salt ourselves
// (matching the established convention) makes this suite self-sufficient in every environment —
// local, CI, anywhere — with no environment configuration required at all.
//
// ═══ THE CLOCK IS FROZEN MID-MINUTE — 2026-09-24 FLAKE FIX ═══
// lib/security/search-rate-limit.ts buckets with `floor(Date.now() / 60s)`. Against the REAL clock,
// any test whose request loop straddled a minute boundary split its requests across two
// `window_start` rows: the 13th request of the session-limit test landed in a fresh bucket (200, not
// 429), the RAW-count test saw its count reset to 1, and the 41-request IP-only test got a 200 where
// it expected the 429. Reproduced deterministically on 4abe49a by launching this file ~2.4s before a
// minute boundary — each of those three failures, one per attempt.
// Fix: fake ONLY `Date` (`toFake: ['Date']`) and pin it to the middle of the current real minute, so
// every request in this file names the same minute bucket no matter how long the file takes.
// ONLY `Date`: faking setTimeout/setImmediate/nextTick would freeze node-postgres's socket, pool
// acquire and idle timers and hang this suite against a real database — the same reason
// tests/search/catalogue-cache-bust-route.test.ts fakes only `Date`. Pinned near REAL now (not a
// fixed historic date) so rows look ordinary to anything that reasons about window_start age, and
// `last_attempt_at = now()` (the DB's clock) stays close to window_start. Isolation between tests
// still comes from unique subjects (`freshSubject`), not from time, so one frozen minute for the
// whole file is safe.
//
// ═══ THE LOCAL-DB GUARD ═══
// vitest.config.ts's `setupFiles: ['./lib/testing/local-db-guard.ts']` already runs for EVERY
// test file in EVERY workspace project (including this file's `db` project — the projects all
// `extends: './vitest.config.ts'` and none override `setupFiles`), so a non-local DATABASE_URL
// throws before any `it()` here runs, exactly like every other `-db` suite. The explicit call
// below is redundant with that (verified: the workspace inheritance already covers it) but is
// kept anyway as a visible, file-local guarantee — a future refactor of the global wiring should
// not have to be trusted blindly by a suite that writes rows, even throwaway ones.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { query, closePool } from '../../lib/db/client';
import { assertLocalDatabaseUrl } from '../../lib/testing/local-db-guard';
import { GET } from '../../app/api/search/route';
import { ANON_SESSION_COOKIE } from '../../lib/db/session';
import { SEARCH_RATE_LIMITS, ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD } from '../../lib/security/search-rate-limit';

const hasDb = Boolean(process.env.DATABASE_URL);
if (hasDb) assertLocalDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');

const TEST_SALT = 'route-rate-limit-db-test-salt';

/** A GET /api/search request carrying a chosen IP (x-forwarded-for) and, optionally, a session
 *  cookie. `sessionId: null` reproduces the request shape app/api/search/route.ts sees from a
 *  caller with no kf_anon_id cookie at all — see the 'IP-only' test below for why this matters. */
function request(ip: string, sessionId: string | null): Request {
  const headers: Record<string, string> = { accept: 'application/json', 'x-forwarded-for': ip };
  if (sessionId !== null) headers.cookie = `${ANON_SESSION_COOKIE}=${sessionId}`;
  return new Request('http://localhost/api/search?q=soft+play&minResults=0', { headers });
}

const MINUTE_MS = 60_000;

/** The middle (:30.000) of the minute containing `realNowMs` — see the frozen-clock note above. */
function midMinuteNear(realNowMs: number): Date {
  return new Date(Math.floor(realNowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS / 2);
}

describe.skipIf(!hasDb)('GET /api/search rate limit (real Postgres)', () => {
  const testIps: string[] = [];
  const testSessionIds: string[] = [];

  beforeAll(() => {
    vi.stubEnv('SMS_PHONE_HASH_SALT', TEST_SALT);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(midMinuteNear(Date.now()));
  });

  afterAll(async () => {
    // Best-effort cleanup — throwaway synthetic IPs (10.77.x.x-10.82.x.x, never a real caller's
    // address) and randomUUID() session ids, scoped to exactly the subjects THIS file minted
    // (recorded as each is used, not derived after the fact) — nothing else in the table is
    // touched. Deletes BOTH scopes: an earlier version of this cleanup only ever collected IP
    // hashes despite claiming full cleanup, silently leaving every session_minute/session_hour
    // row this file wrote behind (2026-09-22 QA finding).
    const hashes: string[] = [];
    for (const ip of testIps) hashes.push(createHmac('sha256', TEST_SALT).update(`search-rate-ip:${ip}`).digest('hex'));
    for (const sid of testSessionIds) {
      hashes.push(createHmac('sha256', TEST_SALT).update(`search-rate-session:${sid}`).digest('hex'));
    }
    if (hashes.length > 0) {
      await query(`DELETE FROM search_rate_limit WHERE subject_hash = ANY($1::text[])`, [hashes]);
    }
    // Cleanup runs BEFORE the unstub (single afterAll, correct order by construction — not two
    // hooks racing on Vitest's same-scope ordering) so TEST_SALT is still the active salt when
    // these hashes are computed above.
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await closePool();
  });

  /** Mint and register a fresh synthetic subject pair for cleanup, so every test that needs one
   *  gets it right rather than repeating the push-to-both-arrays boilerplate. */
  function freshSubject(ipPrefix: string): { ip: string; sessionId: string } {
    const ip = `${ipPrefix}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const sessionId = randomUUID();
    testIps.push(ip);
    testSessionIds.push(sessionId);
    return { ip, sessionId };
  }

  it('lets requests through up to the session limit, then refuses with 429 + Retry-After', async () => {
    const { ip, sessionId } = freshSubject('10.77');

    for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute; i++) {
      const res = await GET(request(ip, sessionId));
      expect(res.status, `request ${i + 1}`).toBe(200);
    }

    const refused = await GET(request(ip, sessionId));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('60');
    expect(refused.headers.get('x-data-source')).toBe('rate-limited');
    const body = await refused.json();
    expect(body).toEqual({ error: 'too many requests' });
  });

  it('is deterministic even when pinned 1ms before a minute boundary (frozen clock cannot straddle)', async () => {
    // Pins the WORST case the real clock used to hit by chance: the whole limit-then-refuse loop
    // starting at :59.999. With `Date` frozen the loop cannot cross into the next bucket, so the
    // 13th request is still refused. Restores the file's mid-minute pin afterwards.
    const pinned = midMinuteNear(Date.now());
    vi.setSystemTime(new Date(pinned.getTime() + MINUTE_MS / 2 - 1));
    try {
      const { ip, sessionId } = freshSubject('10.84');
      for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute; i++) {
        const res = await GET(request(ip, sessionId));
        expect(res.status, `request ${i + 1}`).toBe(200);
      }
      const refused = await GET(request(ip, sessionId));
      expect(refused.status).toBe(429);
    } finally {
      vi.setSystemTime(pinned);
    }
  });

  it('leaves a completely different ip/session pair unaffected', async () => {
    const { ip, sessionId } = freshSubject('10.78');
    const res = await GET(request(ip, sessionId));
    expect(res.status).toBe(200);
  });

  it('stamps rateLimit.searchMinuteRequestCount on the response with the RAW count, once the exclusion threshold is reached — still well under the hard limit', async () => {
    const { ip, sessionId } = freshSubject('10.79');
    expect(ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD).toBeLessThan(SEARCH_RATE_LIMITS.session.perMinute);

    let lastBody: { rateLimit?: { searchMinuteRequestCount: number } } | undefined;
    for (let i = 1; i <= ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD; i++) {
      const res = await GET(request(ip, sessionId));
      expect(res.status, `request ${i}`).toBe(200);
      lastBody = await res.json();
      // The RAW count, not a boolean — must track the actual request number.
      expect(lastBody?.rateLimit?.searchMinuteRequestCount).toBe(i);
    }
  });

  it('stamps the RAW count (1) on the very first, ordinary request — not just once a threshold is crossed', async () => {
    // Deliberately not "does NOT stamp" (that was the pre-review, boolean-flag design): the route
    // surfaces `searchMinuteRequestCount` whenever the limiter actually measured a subject, on
    // EVERY allowed request, so lib/analytics/kpi.ts always has the real number to apply (and
    // later adjust) its exclusion cutoff against — see lib/security/search-rate-limit.ts's
    // ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD header for why a write-time boolean was replaced.
    const { ip, sessionId } = freshSubject('10.80');
    const res = await GET(request(ip, sessionId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rateLimit?: { searchMinuteRequestCount: number } };
    expect(body.rateLimit?.searchMinuteRequestCount).toBe(1);
  });

  it('omits rateLimit entirely when the check is degraded (no salt configured)', async () => {
    // The one case `rateLimit` is genuinely absent: nothing was measured at all. Simulated by
    // temporarily overriding this block's own stubbed salt to empty, then restoring it — a
    // request made while degraded never reaches search_rate_limit at all, so it needs no entry
    // in testIps/testSessionIds.
    vi.stubEnv('SMS_PHONE_HASH_SALT', '');
    try {
      const ip = `10.82.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
      const res = await GET(request(ip, randomUUID()));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rateLimit?: unknown };
      expect(body.rateLimit).toBeUndefined();
    } finally {
      vi.stubEnv('SMS_PHONE_HASH_SALT', TEST_SALT);
    }
  });

  // 🔴 THE BLOCKER THIS GUARDS, END TO END: both 2026-09-22 reviews independently found that
  // every test in this file (before this one) — and every unit test in
  // tests/security/search-rate-limit.test.ts — passed an explicit, present session id, so the
  // NO-COOKIE path (exactly what app/search/page.tsx's internal fetch sent before
  // lib/http/request-context.ts's `forwardedIdentityHeaders` fix) had ZERO executed coverage
  // against the real database. This request carries an IP and NO cookie at all — the route must
  // still identify, count, and eventually refuse it via the ip_minute/ip_hour buckets.
  it('🔴 rate-limits correctly end-to-end for a request with NO session cookie at all (IP-only)', async () => {
    const ip = `10.81.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    testIps.push(ip);

    for (let i = 0; i < SEARCH_RATE_LIMITS.ip.perMinute; i++) {
      const res = await GET(request(ip, null));
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const refused = await GET(request(ip, null));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('60');
  });

  // 🟡 F3 (2026-09-22 independent recheck), end to end: an ip-scope count must NEVER reach
  // analytics_event.search_minute_request_count, no matter how high it climbs — see
  // lib/security/search-rate-limit.ts's `sessionMinuteAttempts` header for the reproduced
  // failure (12 cookieless requests, all allowed, every real actor sharing that IP silently
  // excluded from DAU/WAU/MAU). Well past ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD (10) here,
  // still nowhere near ip.perMinute (40) — every response must omit `rateLimit` entirely.
  it('🔴 never stamps rateLimit for cookieless requests, even well past the exclusion threshold', async () => {
    const ip = `10.83.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    testIps.push(ip);
    expect(ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD).toBeLessThan(SEARCH_RATE_LIMITS.ip.perMinute);

    for (let i = 1; i <= ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD + 2; i++) {
      const res = await GET(request(ip, null));
      expect(res.status, `request ${i}`).toBe(200);
      const body = (await res.json()) as { rateLimit?: unknown };
      expect(body.rateLimit, `request ${i} must omit rateLimit (ip-only, no session)`).toBeUndefined();
    }
  });
});
