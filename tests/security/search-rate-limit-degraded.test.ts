// tests/security/search-rate-limit-degraded.test.ts — what the /search rate limit does when its
// own counter table cannot answer (lib/security/search-rate-limit-degraded.ts, 2026-09-24 C+D).
//
// Every test injects a FRESH degraded state (memory store + breaker) so nothing leaks between
// tests through the module-level instance the route uses. The clock is fully faked: the breaker
// and deadline are both time-driven, and the deadline's setTimeout must be advanced by hand.
// (Safe here, unlike tests/search/route-rate-limit-db.test.ts: nothing in this file opens a real
// database connection.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSearchRateLimit, SEARCH_RATE_LIMITS } from '@/lib/security/search-rate-limit';
import {
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_OPEN_MS,
  DB_LIMITER_DEADLINE_MS,
  DEGRADED_REPORT_INTERVAL_MS,
  DegradedReportThrottle,
  MemoryRateLimitStore,
  SearchRateLimitBreaker,
  createSearchRateLimitDegradedState,
  describeLimiterFailure,
} from '@/lib/security/search-rate-limit-degraded';
import type { query as dbQuery } from '@/lib/db/client';

const IP = '203.0.113.9';
const SESSION = 'c1c2c3c4-0000-4000-8000-000000000003';
/** Mid-minute, so no test here straddles a minute bucket by accident. */
const START = Date.UTC(2026, 8, 24, 12, 0, 30);

type Query = typeof dbQuery;

/** A counter table that is down: every statement throws a pg-shaped error. */
function downTable(code = 'ENOTFOUND', message = 'getaddrinfo ENOTFOUND db.example.supabase.co') {
  const calls = { count: 0 };
  const query = (async () => {
    calls.count += 1;
    throw Object.assign(new Error(message), { code });
  }) as unknown as Query;
  return { query, calls };
}

/** A healthy counter table (same model as tests/security/search-rate-limit.test.ts). */
function upTable() {
  const rows = new Map<string, number>();
  const calls = { count: 0 };
  const query = (async (_text: string, values?: unknown[]) => {
    calls.count += 1;
    const [scope, hash, windowStartIso, maxAttempts] = values as [string, string, string, number];
    const key = `${scope}|${hash}|${windowStartIso}`;
    const existing = rows.get(key);
    if (existing === undefined) {
      rows.set(key, 1);
      return [{ attempts: 1 }];
    }
    if (existing >= maxAttempts) return [];
    rows.set(key, existing + 1);
    return [{ attempts: existing + 1 }];
  }) as unknown as Query;
  return { query, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'degraded-test-salt');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('memory fallback — the limit still bites while the counter table is down', () => {
  it('🔴 allows a session up to perMinute, then refuses with session_minute + Retry-After 60', async () => {
    const db = downTable();
    const degradedState = createSearchRateLimitDegradedState();
    for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute; i++) {
      const r = await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState });
      expect(r.allowed, `request ${i + 1}`).toBe(true);
      expect(r).toMatchObject({ degraded: true, degradedReason: 'db_error', fallback: 'memory' });
    }
    const refused = await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState });
    expect(refused).toMatchObject({
      allowed: false,
      reason: 'session_minute',
      retryAfterSeconds: 60,
      degraded: true,
      degradedReason: 'db_error',
      fallback: 'memory',
    });
  });

  it('🔴 an IP-only caller (no cookie) is refused by ip_minute after ip.perMinute', async () => {
    const db = downTable();
    const degradedState = createSearchRateLimitDegradedState();
    for (let i = 0; i < SEARCH_RATE_LIMITS.ip.perMinute; i++) {
      expect((await checkSearchRateLimit({ ip: IP, sessionId: null }, { query: db.query, degradedState })).allowed).toBe(true);
    }
    const refused = await checkSearchRateLimit({ ip: IP, sessionId: null }, { query: db.query, degradedState });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('ip_minute');
  });

  it('keeps the DB path\'s short-circuit: a request refused by the minute bucket is never charged to the hour bucket', async () => {
    // perHour 13: minute 1 allows 12 then refuses 5 more. If those refusals were charged to the
    // hour bucket, minute 2 would be refused immediately. It must allow exactly one more
    // (hour → 13) and only then refuse on session_hour.
    const limits = { session: { perMinute: 12, perHour: 13 }, ip: { perMinute: 1000, perHour: 1000 } };
    const db = downTable();
    const degradedState = createSearchRateLimitDegradedState();
    const check = () => checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState, limits });
    for (let i = 0; i < 12; i++) expect((await check()).allowed).toBe(true);
    for (let i = 0; i < 5; i++) expect((await check()).reason).toBe('session_minute');

    vi.setSystemTime(new Date(START + 60_000));
    expect((await check()).allowed).toBe(true);
    const refused = await check();
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('session_hour');
    expect(refused.retryAfterSeconds).toBe(3600);
  });

  it('never populates minuteAttempts / sessionMinuteAttempts from an in-memory count (analytics: null = not measured)', async () => {
    const db = downTable();
    const degradedState = createSearchRateLimitDegradedState();
    for (let i = 0; i < 3; i++) {
      const r = await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState });
      expect(r.minuteAttempts).toBeNull();
      expect(r.sessionMinuteAttempts).toBeNull();
    }
  });

  it('reports the cause (error code + message) of the DB failure', async () => {
    const db = downTable('42P01', 'relation "search_rate_limit" does not exist');
    const r = await checkSearchRateLimit(
      { ip: IP, sessionId: SESSION },
      { query: db.query, degradedState: createSearchRateLimitDegradedState() }
    );
    expect(r.degradedCause).toBe('42P01: relation "search_rate_limit" does not exist');
  });

  it('leaves no_salt and no_subject exactly as before — fail open, no fallback, nothing counted', async () => {
    const db = downTable();
    const degradedState = createSearchRateLimitDegradedState();
    const noSubject = await checkSearchRateLimit({ ip: null, sessionId: null }, { query: db.query, degradedState });
    expect(noSubject).toMatchObject({ allowed: true, degradedReason: 'no_subject', fallback: null, degradedCause: null });

    vi.stubEnv('SMS_PHONE_HASH_SALT', '');
    for (let i = 0; i < SEARCH_RATE_LIMITS.session.perMinute + 5; i++) {
      const r = await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState });
      expect(r).toMatchObject({ allowed: true, degradedReason: 'no_salt', fallback: null });
    }
    expect(db.calls.count).toBe(0);
    expect(degradedState.store.size).toBe(0);
    expect(degradedState.breaker.currentState()).toBe('closed');
  });

  it('a healthy table is used as before — no fallback, no degraded flag, real counts', async () => {
    const db = upTable();
    const r = await checkSearchRateLimit(
      { ip: IP, sessionId: SESSION },
      { query: db.query, degradedState: createSearchRateLimitDegradedState() }
    );
    expect(r).toMatchObject({ allowed: true, degraded: false, fallback: null, degradedCause: null, sessionMinuteAttempts: 1 });
    expect(db.calls.count).toBe(4);
  });
});

describe('deadline — a slow table fails over fast instead of holding the request for the 10s acquire timeout', () => {
  it('🔴 a query that never answers resolves via the fallback at the deadline, with the deadline as the cause', async () => {
    const hanging = (() => new Promise(() => {})) as unknown as Query;
    const pending = checkSearchRateLimit(
      { ip: IP, sessionId: SESSION },
      { query: hanging, degradedState: createSearchRateLimitDegradedState() }
    );
    let settled = false;
    void pending.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(DB_LIMITER_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ allowed: true, degradedReason: 'db_error', fallback: 'memory' });
    expect(result.degradedCause).toContain('SEARCH_RATE_LIMIT_DEADLINE');
  });

  it('the abandoned sequence issues no further statements, and its late rejection is handled', async () => {
    // The first statement answers AFTER the deadline. Without the budget check the sequence would
    // go on to issue ip_hour / session_minute / session_hour against a struggling pool. Its later
    // rejection must not surface as an unhandled rejection (vitest fails the run if it does).
    let calls = 0;
    const slow = (() => {
      calls += 1;
      return new Promise((resolve) => setTimeout(() => resolve([{ attempts: 1 }]), DB_LIMITER_DEADLINE_MS + 500));
    }) as unknown as Query;
    const pending = checkSearchRateLimit(
      { ip: IP, sessionId: SESSION },
      { query: slow, degradedState: createSearchRateLimitDegradedState() }
    );
    await vi.advanceTimersByTimeAsync(DB_LIMITER_DEADLINE_MS);
    expect((await pending).fallback).toBe('memory');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(1);
  });
});

describe('breaker — stop hammering a failing table', () => {
  it(`🔴 opens after ${BREAKER_FAILURE_THRESHOLD} failures: the next request does not touch the DB at all`, async () => {
    const db = downTable();
    const degradedState = createSearchRateLimitDegradedState();
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState });
    }
    expect(db.calls.count).toBe(BREAKER_FAILURE_THRESHOLD);
    expect(degradedState.breaker.currentState()).toBe('open');

    const r = await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState });
    expect(db.calls.count).toBe(BREAKER_FAILURE_THRESHOLD);
    expect(r).toMatchObject({ fallback: 'memory', degradedCause: 'breaker_open' });
  });

  it('after the open window, one probe goes through; success closes the breaker', async () => {
    const down = downTable();
    const up = upTable();
    const degradedState = createSearchRateLimitDegradedState();
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: down.query, degradedState });
    }
    vi.setSystemTime(new Date(START + BREAKER_OPEN_MS));
    const probe = await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: up.query, degradedState });
    expect(probe.degraded).toBe(false);
    expect(up.calls.count).toBe(4);
    expect(degradedState.breaker.currentState()).toBe('closed');
  });

  it('a failed probe re-opens it for a fresh window', async () => {
    const db = downTable();
    const degradedState = createSearchRateLimitDegradedState();
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState });
    }
    vi.setSystemTime(new Date(START + BREAKER_OPEN_MS));
    await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState });
    expect(db.calls.count).toBe(BREAKER_FAILURE_THRESHOLD + 1);
    expect(degradedState.breaker.currentState()).toBe('open');

    vi.setSystemTime(new Date(START + BREAKER_OPEN_MS + BREAKER_OPEN_MS - 1));
    await checkSearchRateLimit({ ip: IP, sessionId: SESSION }, { query: db.query, degradedState });
    expect(db.calls.count).toBe(BREAKER_FAILURE_THRESHOLD + 1);
  });

  it('while half-open, only ONE concurrent caller probes; the rest use the fallback', () => {
    const breaker = new SearchRateLimitBreaker({ failureThreshold: 1, openMs: 1_000 });
    breaker.recordFailure(breaker.tryAcquire(0)!, 0);
    expect(breaker.currentState()).toBe('open');
    expect(breaker.tryAcquire(999)).toBeNull();
    expect(breaker.tryAcquire(1_000)).toMatchObject({ probe: true }); // the probe
    expect(breaker.currentState()).toBe('half_open');
    expect(breaker.tryAcquire(1_001)).toBeNull();
    expect(breaker.tryAcquire(1_002)).toBeNull();
  });

  it('failures spread wider than the window do not open it (a single stale connection now and then is tolerated)', () => {
    const breaker = new SearchRateLimitBreaker();
    const fail = (t: number) => breaker.recordFailure(breaker.tryAcquire(t)!, t);
    fail(0);
    fail(6_000);
    fail(12_000); // the first has aged out of the 10s window
    expect(breaker.currentState()).toBe('closed');
    fail(13_000);
    expect(breaker.currentState()).toBe('open');
  });
});

// ═══ 2026-09-24 independent QA, finding F1 ═══
// The breaker was "3 failures IN A ROW" (any success reset it) instead of "3 failures in 10s", and
// a straggler success from a request that started before the breaker opened re-closed it. Each
// test below is one of QA's reproductions (their probe ids in brackets).
describe('breaker F1 — a true sliding window; only the current probe can close it', () => {
  it('🔴 [QA L2] alternating success/failure: the 3rd failure inside 10s opens it, successes in between do not reset it', async () => {
    const degradedState = createSearchRateLimitDegradedState();
    const ok = (async () => [{ attempts: 1 }]) as unknown as Query;
    const down = downTable();
    let openedAtRequest: number | null = null;
    for (let i = 0; i < 20; i++) {
      await checkSearchRateLimit({ ip: `10.2.0.${i}`, sessionId: `s${i}` }, { query: i % 2 ? down.query : ok, degradedState });
      if (openedAtRequest === null && degradedState.breaker.currentState() === 'open') openedAtRequest = i;
    }
    expect(openedAtRequest).toBe(5); // failures at i = 1, 3, 5
    expect(down.calls.count).toBe(3); // nothing after it opened reached the DB
  });

  it('🔴 [QA S5b] a DB flapping around the deadline (1.32s successes / 1.5s timeouts) opens it, and later requests stop paying the latency', async () => {
    // Per-statement latency alternates 0.33s (4 stmts = 1.32s, under the 1.5s deadline) and 0.42s
    // (1.68s, over it) — QA's real-DB jitter sequence, reproduced with timers.
    const degradedState = createSearchRateLimitDegradedState();
    let perStatementMs = 0;
    let dbStatements = 0;
    const jittery = (() => {
      dbStatements += 1;
      return new Promise((resolve) => setTimeout(() => resolve([{ attempts: 1 }]), perStatementMs));
    }) as unknown as Query;
    const seq = [330, 420, 330, 420, 330, 420, 330, 420, 330, 420];
    const latencies: number[] = [];
    for (let i = 0; i < seq.length; i++) {
      perStatementMs = seq[i];
      const t0 = Date.now();
      let doneAt = 0;
      const p = checkSearchRateLimit({ ip: `10.5.0.${i}`, sessionId: `j${i}` }, { query: jittery, degradedState }).then((r) => {
        doneAt = Date.now();
        return r;
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await p;
      latencies.push(doneAt - t0);
    }
    // Requests 2, 4, 6 time out (3 failures within ~8.5s) → open. Requests 7-10 skip the DB.
    expect(degradedState.breaker.currentState()).toBe('open');
    expect(latencies.slice(0, 6).every((ms) => ms >= 1_300)).toBe(true);
    expect(latencies.slice(6)).toEqual([0, 0, 0, 0]);
    const statementsAfterOpen = dbStatements;
    await checkSearchRateLimit({ ip: '10.5.1.1', sessionId: 'after' }, { query: jittery, degradedState });
    expect(dbStatements).toBe(statementsAfterOpen);
  });

  it('🔴 [QA L1] a straggler success from a request that started while CLOSED does not re-close an OPEN breaker', async () => {
    const degradedState = createSearchRateLimitDegradedState();
    let mode: 'slow_ok' | 'fail' | 'ok' = 'slow_ok';
    let dbCalls = 0;
    const query = (() => {
      dbCalls += 1;
      if (mode === 'fail') return Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND db.x'), { code: 'ENOTFOUND' }));
      if (mode === 'ok') return Promise.resolve([{ attempts: 1 }]);
      return new Promise((resolve) => setTimeout(() => resolve([{ attempts: 1 }]), 300)); // 4 × 300ms = 1.2s
    }) as unknown as Query;

    // A acquires while CLOSED and is slow but successful.
    const straggler = checkSearchRateLimit({ ip: '10.1.1.1', sessionId: 'A' }, { query, degradedState });
    await vi.advanceTimersByTimeAsync(950); // A has issued its 4th (last) statement
    mode = 'fail';
    for (const s of ['B', 'C', 'D']) await checkSearchRateLimit({ ip: `10.1.2.${s.charCodeAt(0)}`, sessionId: s }, { query, degradedState });
    expect(degradedState.breaker.currentState()).toBe('open');

    await vi.advanceTimersByTimeAsync(300);
    expect((await straggler).degraded).toBe(false); // A itself did succeed on the DB…
    expect(degradedState.breaker.currentState()).toBe('open'); // …but must not close the breaker

    mode = 'ok';
    const callsBefore = dbCalls;
    const next = await checkSearchRateLimit({ ip: '10.1.3.1', sessionId: 'E' }, { query, degradedState });
    expect(dbCalls).toBe(callsBefore);
    expect(next.fallback).toBe('memory');
  });

  it('a success while closed leaves recent failures in the window (fail, fail, success, fail → open)', () => {
    const breaker = new SearchRateLimitBreaker();
    breaker.recordFailure(breaker.tryAcquire(0)!, 0);
    breaker.recordFailure(breaker.tryAcquire(1_000)!, 1_000);
    breaker.recordSuccess(breaker.tryAcquire(2_000)!);
    expect(breaker.currentState()).toBe('closed');
    breaker.recordFailure(breaker.tryAcquire(3_000)!, 3_000);
    expect(breaker.currentState()).toBe('open');
  });

  it('a stale failure from a request that started BEFORE the breaker opened cannot count against the NEXT closed episode', () => {
    const breaker = new SearchRateLimitBreaker({ failureThreshold: 1, openMs: 1_000 });
    const stale = breaker.tryAcquire(0)!; // acquired while closed, finishes very late
    breaker.recordFailure(breaker.tryAcquire(0)!, 0);
    breaker.recordSuccess(breaker.tryAcquire(1_000)!); // probe succeeds → closed again
    expect(breaker.currentState()).toBe('closed');
    breaker.recordFailure(stale, 1_500);
    expect(breaker.currentState()).toBe('closed');
  });

  it('outcomes from an earlier episode are ignored; only the CURRENT probe closes it', () => {
    const breaker = new SearchRateLimitBreaker({ failureThreshold: 1, openMs: 1_000 });
    const beforeOpen = breaker.tryAcquire(0)!;
    breaker.recordFailure(breaker.tryAcquire(0)!, 0);
    expect(breaker.currentState()).toBe('open');
    breaker.recordSuccess(beforeOpen);
    expect(breaker.currentState()).toBe('open');
    const probe = breaker.tryAcquire(1_000)!;
    breaker.recordFailure(beforeOpen, 1_000); // a stale failure cannot re-open or extend it either
    expect(breaker.currentState()).toBe('half_open');
    breaker.recordSuccess(probe);
    expect(breaker.currentState()).toBe('closed');
  });
});

describe('memory store — bounded', () => {
  it('a REFUSED attempt leaves the bucket at its cap (same as the DB statement\'s conflict WHERE)', () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 12; i++) store.countAttempt('session_minute', 'h', 60, 12, START);
    for (let i = 0; i < 5; i++) {
      expect(store.countAttempt('session_minute', 'h', 60, 12, START)).toEqual({ allowed: false, attempts: 12 });
    }
  });

  it('never grows past its cap, whatever the number of distinct subjects', () => {
    const store = new MemoryRateLimitStore(100);
    for (let i = 0; i < 250; i++) store.countAttempt('ip_minute', `hash-${i}`, 60, 40, START);
    expect(store.size).toBeLessThanOrEqual(100);
  });

  it('at the cap, drops EXPIRED buckets before evicting live ones', () => {
    const store = new MemoryRateLimitStore(3);
    store.countAttempt('ip_minute', 'old-1', 60, 40, START);
    store.countAttempt('ip_minute', 'old-2', 60, 40, START);
    store.countAttempt('ip_hour', 'live', 3600, 250, START);
    // Next minute: the two minute buckets have expired, the hour bucket has not.
    store.countAttempt('ip_minute', 'new', 60, 40, START + 60_000);
    expect(store.size).toBe(2);
    expect(store.countAttempt('ip_hour', 'live', 3600, 250, START + 60_000).attempts).toBe(2);
  });

  it('evicts the least recently USED bucket, not merely the oldest created', () => {
    const store = new MemoryRateLimitStore(2);
    store.countAttempt('session_minute', 'a', 60, 12, START);
    store.countAttempt('session_minute', 'b', 60, 12, START);
    store.countAttempt('session_minute', 'a', 60, 12, START); // a is now most recent
    store.countAttempt('session_minute', 'c', 60, 12, START); // evicts b
    expect(store.countAttempt('session_minute', 'a', 60, 12, START).attempts).toBe(3);
    expect(store.countAttempt('session_minute', 'b', 60, 12, START).attempts).toBe(1);
  });
});

describe('reporting helpers', () => {
  it('the report throttle lets each reason through once per interval', () => {
    const throttle = new DegradedReportThrottle();
    expect(throttle.shouldReport('db_error', 0)).toBe(true);
    expect(throttle.shouldReport('db_error', 1)).toBe(false);
    expect(throttle.shouldReport('no_salt', 1)).toBe(true);
    expect(throttle.shouldReport('db_error', DEGRADED_REPORT_INTERVAL_MS - 1)).toBe(false);
    expect(throttle.shouldReport('db_error', DEGRADED_REPORT_INTERVAL_MS)).toBe(true);
  });

  it('describeLimiterFailure keeps the code, truncates, and redacts credentials in a URL', () => {
    const err = Object.assign(
      new Error('connect failed for postgres://postgres:hunter2@db.example.supabase.co:6543/postgres'),
      { code: 'ECONNREFUSED' }
    );
    const described = describeLimiterFailure(err);
    expect(described.startsWith('ECONNREFUSED: ')).toBe(true);
    expect(described).not.toContain('hunter2');
    expect(describeLimiterFailure(new Error('x'.repeat(500))).length).toBeLessThanOrEqual('Error: '.length + 160);
    expect(describeLimiterFailure('a string')).toBe('non_error:string');
  });
});
