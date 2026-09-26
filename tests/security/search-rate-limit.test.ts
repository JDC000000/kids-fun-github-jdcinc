// tests/security/search-rate-limit.test.ts — the /search & /api/search rate limit, exercised
// over TIME.
//
// Same reasoning as tests/sms/signup_throttle.test.ts (read that file's header first): the abuse
// this fixes is a SEQUENCE, so a test that stubs `query` to return one canned row proves nothing.
// `rateLimitTable()` below is a faithful in-memory model of the ONE statement `countAttempt`
// issues (lib/security/search-rate-limit.ts), including the two things about it that are easy to
// get wrong: the conflict action's WHERE (a refusal returns ZERO ROWS) and the fact that a
// refusal therefore leaves the row COMPLETELY UNTOUCHED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSearchRateLimit,
  SEARCH_RATE_LIMITS,
  type SearchRateLimitSubject,
} from '@/lib/security/search-rate-limit';
import {
  createSearchRateLimitDegradedState,
  resetDefaultSearchRateLimitDegradedState,
} from '@/lib/security/search-rate-limit-degraded';
import type { query as dbQuery } from '@/lib/db/client';

const IP = '203.0.113.7';
const SESSION = 'a1a2a3a4-0000-4000-8000-000000000001';
const OTHER_SESSION = 'b1b2b3b4-0000-4000-8000-000000000002';

/** 2026-09-22T12:00:00Z — the day of the incident. */
const START = Date.UTC(2026, 8, 22, 12, 0, 0);

interface FakeRow {
  attempts: number;
}

/** An in-memory `search_rate_limit`, plus a recorder of every scope touched. */
function rateLimitTable() {
  const rows = new Map<string, FakeRow>();
  const scopesTouched: string[] = [];

  const query = (async (text: string, values?: unknown[]) => {
    const sql = text.trim();
    if (!sql.startsWith('INSERT INTO search_rate_limit')) {
      throw new Error(`rateLimitTable saw an unmodelled statement: ${sql.slice(0, 60)}`);
    }
    const [scope, hash, windowStartIso, maxAttempts] = values as [string, string, string, number];
    scopesTouched.push(scope);
    const key = `${scope}|${hash}|${windowStartIso}`;
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, { attempts: 1 });
      return [{ attempts: 1 }];
    }
    // The conflict action's WHERE. False ⇒ skipped ⇒ nothing updated, nothing returned.
    if (existing.attempts >= maxAttempts) return [];
    existing.attempts += 1;
    return [{ attempts: existing.attempts }];
  }) as unknown as typeof dbQuery;

  return { query, rows, scopesTouched };
}

function subject(ip: string | null, sessionId: string | null): SearchRateLimitSubject {
  return { ip, sessionId };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
  // Stubbed so the lane does not depend on whoever's shell runs it — mirrors
  // tests/sms/signup_throttle.test.ts's convention for the same shared salt.
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'rate-limit-test-salt');
  // The breaker + memory fallback are per-instance module state; every test starts cold.
  resetDefaultSearchRateLimitDegradedState();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the per-minute limit — stops the burst', () => {
  it('lets the first request straight through', async () => {
    const db = rateLimitTable();
    const result = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
    expect(result).toMatchObject({ allowed: true, reason: null, degraded: false });
  });

  it('🔴 refuses the request that would exceed perMinute for the SAME session, well before an hour is anywhere near up', async () => {
    // THE ABUSE, reproduced: one session firing far more than a real, no-typeahead /search UI
    // can produce in a minute (the incident measured ~20-60/min; this asserts the limit bites
    // strictly below that). ip_minute has NOT capped out yet at this point (its ceiling is much
    // higher — see the module header on the deliberate ip/session asymmetry), so session_minute
    // is the bucket that actually refuses.
    const db = rateLimitTable();
    for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute; i++) {
      const r = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
      expect(r.allowed, `request ${i + 1}`).toBe(true);
    }
    const refused = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('session_minute');
    expect(refused.retryAfterSeconds).toBe(60);
  });

  it('a REFUSED attempt does not push the bucket past its cap (repeated hammering stays refused, does not corrupt the counter)', async () => {
    const db = rateLimitTable();
    for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute; i++) {
      await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
    }
    for (let i = 0; i < 5; i++) {
      const r = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
      expect(r.allowed).toBe(false);
    }
    const row = [...db.rows.values()].find((r) => r.attempts === SEARCH_RATE_LIMITS.session.perMinute);
    expect(row?.attempts).toBe(SEARCH_RATE_LIMITS.session.perMinute);
  });

  it('lets the same subject through again once the next minute bucket starts', async () => {
    const db = rateLimitTable();
    for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute; i++) {
      await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
    }
    expect((await checkSearchRateLimit(subject(IP, SESSION), { query: db.query })).allowed).toBe(false);

    vi.setSystemTime(new Date(START + 60_000));
    expect((await checkSearchRateLimit(subject(IP, SESSION), { query: db.query })).allowed).toBe(true);
  });

  it('leaves a DIFFERENT session (same IP) completely alone once ITS budget is exhausted', async () => {
    const db = rateLimitTable();
    for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute; i++) {
      await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
    }
    expect((await checkSearchRateLimit(subject(IP, SESSION), { query: db.query })).allowed).toBe(false);
    // Different SESSION, same IP — must not be refused by the ip_minute bucket either, because
    // ip.perMinute is deliberately much more generous than session.perMinute (this module's
    // header explains the asymmetry): only session.perMinute ip_minute attempts were spent by
    // the loop above, nowhere near ip.perMinute's ceiling.
    expect((await checkSearchRateLimit(subject(IP, OTHER_SESSION), { query: db.query })).allowed).toBe(true);
  });
});

describe('the per-hour limit — stops a caller pacing itself under the per-minute cap', () => {
  const lowHourLimit = {
    session: { perMinute: SEARCH_RATE_LIMITS.session.perMinute, perHour: 3 },
    ip: SEARCH_RATE_LIMITS.ip,
  };

  it('🔴 refuses once the hourly cap is reached even though every single request respected perMinute', async () => {
    const db = rateLimitTable();
    for (let i = 0; i < lowHourLimit.session.perHour; i++) {
      vi.setSystemTime(new Date(START + i * 60_000)); // one fresh minute bucket each time
      const r = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query, limits: lowHourLimit });
      expect(r.allowed, `request ${i + 1}`).toBe(true);
    }
    vi.setSystemTime(new Date(START + lowHourLimit.session.perHour * 60_000));
    const refused = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query, limits: lowHourLimit });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('session_hour');
    expect(refused.retryAfterSeconds).toBe(3600);
  });
});

describe('IP scope — defence in depth against a caller that drops its cookie jar', () => {
  it('🔴 refuses a caller that mints a FRESH session on every request, once the IP budget is spent', async () => {
    // The incident traffic keeps a cookie (reads as "one session"), but a smarter version of it
    // could evade a session-only limit by never sending Set-Cookie back. The ip_minute bucket is
    // exactly what still catches that: every one of these calls uses a DIFFERENT session id.
    const db = rateLimitTable();
    for (let i = 0; i < SEARCH_RATE_LIMITS.ip.perMinute; i++) {
      const r = await checkSearchRateLimit(subject(IP, `fresh-session-${i}`), { query: db.query });
      expect(r.allowed, `request ${i + 1}`).toBe(true);
    }
    const refused = await checkSearchRateLimit(subject(IP, 'fresh-session-final'), { query: db.query });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('ip_minute');
  });

  it('does not charge the session counter for a request already refused by IP', async () => {
    const db = rateLimitTable();
    for (let i = 0; i < SEARCH_RATE_LIMITS.ip.perMinute; i++) {
      await checkSearchRateLimit(subject(IP, `fresh-session-${i}`), { query: db.query });
    }
    db.scopesTouched.length = 0;
    const refused = await checkSearchRateLimit(subject(IP, 'yet-another-session'), { query: db.query });
    expect(refused.reason).toBe('ip_minute');
    // ip_minute only — the session scopes were never reached, matching the phone-before-ip
    // short-circuit lib/sms/throttle.ts's callers rely on.
    expect(db.scopesTouched).toEqual(['ip_minute']);
  });

  it('still throttles by session when the request carried no usable IP, and reports the gap', async () => {
    const db = rateLimitTable();
    const first = await checkSearchRateLimit(subject(null, SESSION), { query: db.query });
    expect(first.allowed).toBe(true);
    expect(first.degraded).toBe(false); // a session subject WAS available, so this is not degraded
    expect(db.scopesTouched).toEqual(['session_minute', 'session_hour']);
  });
});

// `minuteAttempts` is a RAW, diagnostic count — NOT a pre-thresholded boolean, and (since F3,
// 2026-09-22 independent recheck) NOT what a caller should stamp onto analytics_event either: it
// falls back to the ip-scope count when no session is present, and an ip-derived count is not
// attributable to one visitor (see `sessionMinuteAttempts`'s own describe block below for why).
// lib/analytics/kpi.ts owns the DAU/WAU/MAU exclusion CUTOFF at read time (see
// ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD's header for why the write-time-boolean version of this
// was replaced the same day it was written) against `sessionMinuteAttempts` specifically.
describe('minuteAttempts — the raw diagnostic count', () => {
  it('tracks the ALLOWED count exactly as it climbs, for a session subject', async () => {
    const db = rateLimitTable();
    for (let i = 1; i <= 5; i++) {
      const result = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
      expect(result.minuteAttempts).toBe(i);
    }
  });

  // 🔴 THE BLOCKER THIS GUARDS: both 2026-09-22 reviews independently found that every existing
  // test here (and in tests/search/route-rate-limit-db.test.ts) passed an explicit, present
  // session id — so the IP-ONLY path, which is EXACTLY what a request carries when
  // app/search/page.tsx's internal fetch drops the visitor's cookie (the actual blocker fixed in
  // app/search/page.tsx / lib/http/request-context.ts's `forwardedIdentityHeaders`), had zero
  // executed coverage anywhere. This is that missing case: no session at all, IP only.
  it('🔴 tracks minuteAttempts correctly for an IP-ONLY subject (no session id at all)', async () => {
    const db = rateLimitTable();
    for (let i = 1; i <= 5; i++) {
      const result = await checkSearchRateLimit(subject(IP, null), { query: db.query });
      expect(result.allowed).toBe(true);
      expect(result.degraded).toBe(false); // an IP subject WAS available — this is not degraded
      expect(result.minuteAttempts).toBe(i);
    }
    // And the IP-only path is refused by ip_minute once IT'S ceiling is reached, same as any
    // other ip_minute exhaustion — see the "IP scope" describe block above for the full case.
  });

  it('is null on a degraded/no-subject result — never a fake zero', async () => {
    const db = rateLimitTable();
    const result = await checkSearchRateLimit(subject(null, null), { query: db.query });
    expect(result.degraded).toBe(true);
    expect(result.minuteAttempts).toBeNull();
  });
});

// 🟡 F3 (2026-09-22 independent recheck): `sessionMinuteAttempts` — the field callers must
// actually stamp onto analytics_event. `minuteAttempts` above falls back to the ip-scope count
// when no session is present; this field never does, because an ip-derived count is not
// attributable to one visitor (many real people can share an IP; they cannot share a session).
// Reproduced live before this fix: 12 cookieless requests from one IP, every one individually
// ALLOWED (nowhere near ip.perMinute=40), yet every real actor sharing that address got silently
// excluded from a 30-day DAU/WAU/MAU window anyway.
describe('sessionMinuteAttempts — the field analytics must actually use', () => {
  it('tracks the session-scope count exactly, when a session subject is present', async () => {
    const db = rateLimitTable();
    for (let i = 1; i <= 5; i++) {
      const result = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
      expect(result.sessionMinuteAttempts).toBe(i);
    }
  });

  it('🔴 stays null for an IP-ONLY subject, no matter how high the ip-scope count climbs', async () => {
    const db = rateLimitTable();
    // Climb well past ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD (10) — reproducing the exact
    // "12 cookieless requests" scenario — while staying under ip.perMinute (40), so every one
    // of these is still individually ALLOWED, exactly like the live repro.
    for (let i = 1; i <= 12; i++) {
      const result = await checkSearchRateLimit(subject(IP, null), { query: db.query });
      expect(result.allowed, `request ${i}`).toBe(true);
      expect(result.minuteAttempts, `request ${i} (diagnostic field)`).toBe(i);
      expect(result.sessionMinuteAttempts, `request ${i} (analytics field)`).toBeNull();
    }
  });

  it('is null on a degraded/no-subject result', async () => {
    const db = rateLimitTable();
    const result = await checkSearchRateLimit(subject(null, null), { query: db.query });
    expect(result.sessionMinuteAttempts).toBeNull();
  });

  it('is null when refused by ip_minute before the session bucket was ever reached', async () => {
    const db = rateLimitTable();
    for (let i = 0; i < SEARCH_RATE_LIMITS.ip.perMinute; i++) {
      await checkSearchRateLimit(subject(IP, `fresh-session-${i}`), { query: db.query });
    }
    const refused = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('ip_minute');
    expect(refused.sessionMinuteAttempts).toBeNull();
  });
});

describe('what it never lets out, and how it degrades', () => {
  it('never sends a raw IP or a raw session id to the database', async () => {
    const db = rateLimitTable();
    const recorder: unknown[][] = [];
    const spying = (async (text: string, values?: unknown[]) => {
      recorder.push(values ?? []);
      return db.query(text, values);
    }) as unknown as typeof dbQuery;
    await checkSearchRateLimit(subject(IP, SESSION), { query: spying });
    const flat = JSON.stringify(recorder);
    expect(flat).not.toContain(IP);
    expect(flat).not.toContain(SESSION);
  });

  it('degrades OPEN, and says why, when the salt that makes a subject is missing', async () => {
    vi.stubEnv('SMS_PHONE_HASH_SALT', '');
    const db = rateLimitTable();
    const result = await checkSearchRateLimit(subject(IP, SESSION), { query: db.query });
    expect(result).toEqual({
      allowed: true,
      reason: null,
      retryAfterSeconds: 0,
      degraded: true,
      degradedReason: 'no_salt',
      fallback: null,
      degradedCause: null,
      minuteAttempts: null,
      sessionMinuteAttempts: null,
    });
    expect(db.rows.size).toBe(0);
  });

  it('degrades OPEN with no_subject when neither an IP nor a session id is present', async () => {
    const db = rateLimitTable();
    const result = await checkSearchRateLimit(subject(null, null), { query: db.query });
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('no_subject');
    expect(result.allowed).toBe(true);
  });

  it('degrades to the MEMORY fallback when the counter table is unreachable — a search must not 500, and the limit still bites', async () => {
    // Used to FAIL OPEN here (every request through). Since 2026-09-24 the same buckets are counted
    // in memory instead (lib/security/search-rate-limit-degraded.ts): the first request is still
    // allowed — a real parent never notices — but the caller is NOT unlimited. The two ways this
    // query fails are a real DB outage and migration 0051 not being applied yet.
    const exploding = (async () => {
      throw Object.assign(new Error('relation "search_rate_limit" does not exist'), { code: '42P01' });
    }) as unknown as typeof dbQuery;
    const degradedState = createSearchRateLimitDegradedState();
    const result = await checkSearchRateLimit(subject(IP, SESSION), { query: exploding, degradedState });
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('db_error');
    expect(result.fallback).toBe('memory');
    expect(result.degradedCause).toContain('42P01');

    for (let i = 1; i < SEARCH_RATE_LIMITS.session.perMinute; i++) {
      expect((await checkSearchRateLimit(subject(IP, SESSION), { query: exploding, degradedState })).allowed).toBe(true);
    }
    const refused = await checkSearchRateLimit(subject(IP, SESSION), { query: exploding, degradedState });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('session_minute');
  });
});
