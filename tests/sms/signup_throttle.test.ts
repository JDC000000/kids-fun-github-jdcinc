// tests/sms/signup_throttle.test.ts — the signup rate limit, exercised over TIME.
//
// ═══ WHAT IS BEING PROVED, AND WHY IT NEEDED A SIMULATED TABLE ═══
// The abuse this fixes is a SEQUENCE — submit, submit again, submit again — so a test that stubs
// `query` to return a canned row proves nothing about it: every assertion would be a restatement
// of the stub. What matters is that the third rapid submission of the same number is refused and
// the first submission of a fresh one is not, and neither of those is observable in one call.
//
// So `throttleTable()` below is a faithful in-memory model of ONE statement: the upsert in
// `countAttempt`, including the two things about it that are easy to get wrong and that the
// production behaviour depends on —
//
//   • the conflict action's WHERE, so a refusal returns ZERO ROWS, and
//   • the fact that a refusal therefore leaves the row COMPLETELY UNTOUCHED, so a caller who
//     hammers does not push their own `last_attempt_at` forward.
//
// ⚠ A MODEL IS NOT THE DATABASE, AND THIS FILE DOES NOT PRETEND OTHERWISE. It pins the decision
// logic: the limits, the order the two subjects are checked in, what a refusal reports, and the
// three ways this degrades open. That the real SQL has the semantics modelled here is pinned
// separately, against a real Postgres, in tests/sms/signup_persistence-db.test.ts — which is the
// only place the `ON CONFLICT ... DO UPDATE ... WHERE` behaviour is actually executed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIGNUP_THROTTLE_LIMITS,
  checkAndRecordSignupAttempt,
  type SignupThrottleLimits,
} from '@/lib/sms/signup-store';
import type { query as dbQuery } from '@/lib/db/client';

const PHONE = '+16045550123';
const OTHER_PHONE = '+16045550999';
const IP = '203.0.113.7';

/** 2026-09-04T12:00:00Z — mid-day UTC, so a day-rollover assertion is not accidentally at 00:00. */
const START = Date.UTC(2026, 8, 4, 12, 0, 0);

interface FakeRow {
  attempts: number;
  lastAttemptMs: number;
}

/** The UTC calendar day, exactly as `(now() AT TIME ZONE 'UTC')::date` computes it. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * An in-memory `sms_signup_throttle`, plus a recorder for everything that was asked of it.
 *
 * The SQL is matched on its leading verb rather than parsed: this models a statement whose exact
 * text is the thing under test elsewhere, and a regex over the whole query would fail on
 * whitespace and prove nothing. An unrecognised statement THROWS, so a future edit that adds a
 * third query to this path cannot pass silently on a stub that quietly returns [].
 */
function throttleTable() {
  const rows = new Map<string, FakeRow>();
  const params: unknown[][] = [];
  const verbs: string[] = [];

  const query = (async (text: string, values?: unknown[]) => {
    params.push(values ?? []);
    const sql = text.trim();

    if (sql.startsWith('INSERT INTO sms_signup_throttle')) {
      verbs.push('upsert');
      const [scope, subject, perDay, minIntervalSeconds] = values as [string, string, number, number];
      const key = `${scope}|${subject}|${utcDay(Date.now())}`;
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, { attempts: 1, lastAttemptMs: Date.now() });
        return [{ attempts: 1 }];
      }
      const intervalElapsed = Date.now() - existing.lastAttemptMs >= minIntervalSeconds * 1000;
      // The conflict action's WHERE. False ⇒ skipped ⇒ nothing updated, nothing returned.
      if (existing.attempts >= perDay || !intervalElapsed) return [];
      existing.attempts += 1;
      existing.lastAttemptMs = Date.now();
      return [{ attempts: existing.attempts }];
    }

    if (sql.startsWith('SELECT attempts')) {
      verbs.push('explain');
      const [scope, subject] = values as [string, string];
      const row = rows.get(`${scope}|${subject}|${utcDay(Date.now())}`);
      if (!row) return [];
      return [
        {
          attempts: row.attempts,
          since_last: Math.floor((Date.now() - row.lastAttemptMs) / 1000),
        },
      ];
    }

    throw new Error(`throttleTable saw an unmodelled statement: ${sql.slice(0, 60)}`);
  }) as unknown as typeof dbQuery;

  return { query, rows, params, verbs };
}

/** Every call in this file is a live one — the dry-run bypass has its own test. */
function attempt(
  db: ReturnType<typeof throttleTable>,
  phoneNumber: string,
  ipAddress: string | null,
  limits?: SignupThrottleLimits
) {
  return checkAndRecordSignupAttempt(
    { phoneNumber, ipAddress },
    { dryRun: false, query: db.query, ...(limits ? { limits } : {}) }
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
  // The subjects are HMACs under this salt. Stubbed so the lane does not depend on whoever's
  // shell runs it — and so the "no salt" test below is the ONLY one without it.
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'throttle-test-salt');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the per-number limit — the half that protects a handset', () => {
  it('lets a first-time signup straight through', async () => {
    const db = throttleTable();
    const result = await attempt(db, PHONE, IP);
    expect(result).toEqual({ allowed: true, reason: null, retryAfterSeconds: 0, degraded: false });
    // One row for the number, one for the address.
    expect(db.rows.size).toBe(2);
  });

  it('🔴 refuses the SECOND submission of the same number inside ten minutes', async () => {
    // THE ABUSE, in three lines. Before this limit existed, every one of these dispatched a
    // confirmation SMS to whoever actually holds the number.
    const db = throttleTable();
    expect((await attempt(db, PHONE, IP)).allowed).toBe(true);

    vi.setSystemTime(new Date(START + 5_000));
    const second = await attempt(db, PHONE, IP);
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('phone_interval');
    // Ten minutes from the attempt that WAS allowed, less the five seconds already elapsed.
    expect(second.retryAfterSeconds).toBe(SIGNUP_THROTTLE_LIMITS.phoneMinIntervalSeconds - 5);

    vi.setSystemTime(new Date(START + 60_000));
    expect((await attempt(db, PHONE, IP)).allowed).toBe(false);
  });

  it('lets the same number through again once the interval has actually elapsed', async () => {
    const db = throttleTable();
    await attempt(db, PHONE, IP);
    vi.setSystemTime(new Date(START + SIGNUP_THROTTLE_LIMITS.phoneMinIntervalSeconds * 1000));
    expect((await attempt(db, PHONE, IP)).allowed).toBe(true);
  });

  it('🔴 refuses the FOURTH signup of the day even when they are properly spaced', async () => {
    // The interval limit alone would permit 144 texts a day to one handset. The daily cap is what
    // makes the number bounded rather than merely slow.
    const db = throttleTable();
    const tenMinutes = SIGNUP_THROTTLE_LIMITS.phoneMinIntervalSeconds * 1000;
    for (let i = 0; i < SIGNUP_THROTTLE_LIMITS.phonePerDay; i++) {
      vi.setSystemTime(new Date(START + i * tenMinutes));
      expect((await attempt(db, PHONE, IP)).allowed, `attempt ${i + 1}`).toBe(true);
    }
    vi.setSystemTime(new Date(START + SIGNUP_THROTTLE_LIMITS.phonePerDay * tenMinutes));
    const fourth = await attempt(db, PHONE, IP);
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toBe('phone_daily');
    // Until the UTC day rolls over, which is when the counter's bucket changes. Started at
    // 12:00Z and walked forward 30 minutes, so 11.5 hours remain.
    expect(fourth.retryAfterSeconds).toBe(11.5 * 3600);
  });

  it('🔴 a REFUSED attempt does not push the caller’s own window out', async () => {
    // A parent who did not get the text taps submit three more times. If a refusal moved
    // `last_attempt_at`, they would be locked out for ten minutes FROM THE LAST TAP, and each
    // further tap would extend it — punishing exactly the person the limit is meant to protect.
    const db = throttleTable();
    await attempt(db, PHONE, IP);
    for (const offset of [30_000, 120_000, 300_000]) {
      vi.setSystemTime(new Date(START + offset));
      expect((await attempt(db, PHONE, IP)).allowed).toBe(false);
    }
    // Still exactly ten minutes from the FIRST attempt, not from the last refusal.
    vi.setSystemTime(new Date(START + SIGNUP_THROTTLE_LIMITS.phoneMinIntervalSeconds * 1000));
    expect((await attempt(db, PHONE, IP)).allowed).toBe(true);
    // And the refusals were never counted against the daily cap either.
    const phoneRow = [...db.rows.values()].find((r) => r.attempts === 2);
    expect(phoneRow?.attempts).toBe(2);
  });

  it('leaves a DIFFERENT first-time number completely alone', async () => {
    // The limit is per subject. A busy day for one number must not cost the next parent anything.
    const db = throttleTable();
    await attempt(db, PHONE, IP);
    vi.setSystemTime(new Date(START + 1_000));
    expect((await attempt(db, OTHER_PHONE, null)).allowed).toBe(true);
  });
});

describe('the per-IP limit — defence in depth against spraying MANY numbers', () => {
  const sprayLimits: SignupThrottleLimits = {
    ...SIGNUP_THROTTLE_LIMITS,
    ipPerDay: 3,
    ipMinIntervalSeconds: 0,
  };

  it('🔴 refuses one address once it has signed up more numbers than a household would', async () => {
    // The per-number limit cannot see this attack at all: every number is fresh, so every one of
    // them passes. This is the only thing standing between an attacker and a different stranger's
    // phone on every request.
    const db = throttleTable();
    for (let i = 0; i < sprayLimits.ipPerDay; i++) {
      const res = await attempt(db, `+1604555${String(1000 + i)}`, IP, sprayLimits);
      expect(res.allowed, `spray ${i + 1}`).toBe(true);
    }
    const blocked = await attempt(db, '+16045552000', IP, sprayLimits);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('ip_daily');
  });

  it('refuses a burst from one address before the daily cap is anywhere near', async () => {
    const db = throttleTable();
    await attempt(db, PHONE, IP);
    vi.setSystemTime(new Date(START + 5_000));
    const second = await attempt(db, OTHER_PHONE, IP);
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('ip_interval');
    expect(second.retryAfterSeconds).toBe(SIGNUP_THROTTLE_LIMITS.ipMinIntervalSeconds - 5);
  });

  it('does not charge one address for a number that was refused anyway', async () => {
    // ORDER: the number is checked first, and a request the per-number limit refuses never
    // reaches the IP counter. The reverse order would let a noisy shared NAT spend a specific
    // handset's allowance.
    const db = throttleTable();
    await attempt(db, PHONE, IP);
    db.verbs.length = 0;
    vi.setSystemTime(new Date(START + 1_000));
    const refused = await attempt(db, PHONE, IP);
    expect(refused.reason).toBe('phone_interval');
    // The upsert and its explain — for the PHONE subject only. Nothing was asked about the IP.
    expect(db.verbs).toEqual(['upsert', 'explain']);
  });
});

describe('what it never lets out, and how it degrades', () => {
  it('never sends a raw phone number or a raw IP to the database', async () => {
    // Both subjects are HMACs. This table is a counter, not a record of who tried to sign up.
    const db = throttleTable();
    await attempt(db, PHONE, IP);
    const flat = JSON.stringify(db.params);
    expect(flat).not.toContain(PHONE);
    expect(flat).not.toContain('6045550123');
    expect(flat).not.toContain(IP);
  });

  it('does not touch the database at all on a dry run', async () => {
    // With sending disabled nothing reaches a handset and no consent row is written, so there is
    // nothing to throttle — and the signup path must not need a database in an environment that
    // has none. Every other test in this file passes `dryRun: false` for exactly this reason.
    const db = throttleTable();
    const result = await checkAndRecordSignupAttempt(
      { phoneNumber: PHONE, ipAddress: IP },
      { dryRun: true, query: db.query }
    );
    expect(result).toEqual({ allowed: true, reason: null, retryAfterSeconds: 0, degraded: false });
    expect(db.verbs).toEqual([]);
  });

  it('degrades OPEN, and says so, when the salt that makes a subject is missing', async () => {
    // No salt ⇒ no subject to count against. Inventing one would produce a table that either
    // throttles nobody or throttles everybody together, and would look correct in every test.
    vi.stubEnv('SMS_PHONE_HASH_SALT', '');
    const db = throttleTable();
    const result = await attempt(db, PHONE, IP);
    expect(result).toEqual({ allowed: true, reason: null, retryAfterSeconds: 0, degraded: true });
    expect(db.verbs).toEqual([]);
  });

  it('degrades OPEN when the counter table is unreachable — a signup must not 500', async () => {
    // Fail-open is the opposite of this module's usual posture and is deliberate: the two ways
    // this query fails are a database outage (in which case the write two lines later 503s
    // anyway) and migration 0045 not being applied yet, which is a deploy-ordering state.
    const exploding = (async () => {
      throw new Error('relation "sms_signup_throttle" does not exist');
    }) as unknown as typeof dbQuery;
    const result = await checkAndRecordSignupAttempt(
      { phoneNumber: PHONE, ipAddress: IP },
      { dryRun: false, query: exploding }
    );
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('still throttles by number when the request carried no usable IP, and reports the gap', async () => {
    const db = throttleTable();
    const first = await attempt(db, PHONE, null);
    expect(first.allowed).toBe(true);
    // Degraded because the IP half genuinely did not run — a deployment where every request
    // arrives without a forwarded-for header is a misconfiguration worth seeing.
    expect(first.degraded).toBe(true);
    expect(db.rows.size).toBe(1);

    vi.setSystemTime(new Date(START + 1_000));
    expect((await attempt(db, PHONE, null)).allowed).toBe(false);
  });
});
