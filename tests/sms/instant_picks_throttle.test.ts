// tests/sms/instant_picks_throttle.test.ts — the Instant Picks rate limit (plan v1.0, task 2).
//
// The `query` seam is INJECTED rather than module-mocked, so this file never constructs a pool and
// stays in the `unit` lane (vitest.workspace.ts). What is under test is the decision and the
// SHAPE OF THE STATEMENT — the atomicity is the statement's, and asserting it is the only way to
// notice if somebody "simplifies" it into a check-then-write.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INSTANT_PICKS_THROTTLE_LIMITS,
  checkAndRecordInstantPicks,
} from '@/lib/sms/instant-picks-throttle';

const SUBSCRIBER = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

let sql: string[];
const SALT = 'test-salt-not-a-real-one';

beforeEach(() => {
  sql = [];
  process.env.SMS_PHONE_HASH_SALT = SALT;
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.SMS_PHONE_HASH_SALT;
});

/** A `query` stand-in that records statements and returns whatever the test queued. */
function fakeQuery(responses: unknown[][]) {
  let i = 0;
  return (async (text: string, params?: unknown[]) => {
    sql.push(text);
    void params;
    return responses[i++] ?? [];
  }) as never;
}

describe('instant picks throttle · the limits', () => {
  it('is one per minute and twenty per day', () => {
    expect(INSTANT_PICKS_THROTTLE_LIMITS.minIntervalSeconds).toBe(60);
    expect(INSTANT_PICKS_THROTTLE_LIMITS.perDay).toBe(20);
  });

  it('passes those limits into the statement, not hard-coded numbers', async () => {
    const params: unknown[][] = [];
    const q = (async (text: string, p: unknown[]) => {
      sql.push(text);
      params.push(p);
      return [{ attempts: 1 }];
    }) as never;

    await checkAndRecordInstantPicks(SUBSCRIBER, { query: q });

    expect(params[0][2]).toBe(20); // perDay
    expect(params[0][3]).toBe(60); // minIntervalSeconds
  });
});

describe('instant picks throttle · the decision and the write are ONE statement', () => {
  it('counts with an atomic upsert, not a SELECT then an INSERT', async () => {
    await checkAndRecordInstantPicks(SUBSCRIBER, { query: fakeQuery([[{ attempts: 1 }]]) });

    expect(sql).toHaveLength(1);
    const stmt = sql[0].replace(/\s+/g, ' ');
    // Each clause carries its own share of the correctness:
    expect(stmt).toMatch(/INSERT INTO sms_signup_throttle/i);
    expect(stmt).toMatch(/ON CONFLICT \(scope, subject_hash, window_date\) DO UPDATE/i);
    // The WHERE is what makes the refusal part of the same lock. Without it the statement always
    // increments and the limit does nothing.
    expect(stmt).toMatch(/WHERE sms_signup_throttle\.attempts < \$3/i);
    expect(stmt).toMatch(/last_attempt_at <= now\(\) - make_interval/i);
    // Zero rows returned ⟺ refused. If RETURNING goes, the caller cannot tell.
    expect(stmt).toMatch(/RETURNING attempts/i);
    // And the thing that must NOT be there.
    expect(stmt).not.toMatch(/SELECT count/i);
  });

  it('writes under the `instant_picks` scope — the value migration 0046 adds', async () => {
    const params: unknown[][] = [];
    const q = (async (text: string, p: unknown[]) => {
      sql.push(text);
      params.push(p);
      return [{ attempts: 1 }];
    }) as never;

    await checkAndRecordInstantPicks(SUBSCRIBER, { query: q });

    expect(params[0][0]).toBe('instant_picks');
  });
});

describe('instant picks throttle · the subject', () => {
  it('is a hash — never the raw subscriber id', async () => {
    const params: unknown[][] = [];
    const q = (async (text: string, p: unknown[]) => {
      params.push(p);
      return [{ attempts: 1 }];
    }) as never;

    await checkAndRecordInstantPicks(SUBSCRIBER, { query: q });

    const subject = params[0][1] as string;
    expect(subject).not.toBe(SUBSCRIBER);
    expect(subject).not.toContain(SUBSCRIBER);
    expect(subject).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256, hex
  });

  it('is stable for one subscriber and distinct between two', async () => {
    const subjects: string[] = [];
    const q = (async (text: string, p: unknown[]) => {
      subjects.push(p[1] as string);
      return [{ attempts: 1 }];
    }) as never;

    await checkAndRecordInstantPicks(SUBSCRIBER, { query: q });
    await checkAndRecordInstantPicks(SUBSCRIBER, { query: q });
    await checkAndRecordInstantPicks(OTHER, { query: q });

    expect(subjects[0]).toBe(subjects[1]);
    expect(subjects[2]).not.toBe(subjects[0]);
  });

  it('is domain-separated from the signup scopes under the same salt', async () => {
    // `sms-instant-picks:` vs `sms-phone:` / `sms-signup-ip:`. One salt, three families that
    // cannot collide — the argument lib/sms/signup-store.ts already makes for its IP subject.
    const { createHmac } = await import('node:crypto');
    const params: unknown[][] = [];
    const q = (async (text: string, p: unknown[]) => {
      params.push(p);
      return [{ attempts: 1 }];
    }) as never;

    await checkAndRecordInstantPicks(SUBSCRIBER, { query: q });

    const collision = createHmac('sha256', SALT).update(`sms-phone:${SUBSCRIBER}`).digest('hex');
    expect(params[0][1]).not.toBe(collision);
    expect(params[0][1]).toBe(
      createHmac('sha256', SALT).update(`sms-instant-picks:${SUBSCRIBER}`).digest('hex')
    );
  });
});

describe('instant picks throttle · refusal', () => {
  it('zero rows back means refused, and it asks WHY on a second read', async () => {
    const result = await checkAndRecordInstantPicks(SUBSCRIBER, {
      query: fakeQuery([[], [{ attempts: 3, since_last: 10 }]]),
    });

    expect(result.allowed).toBe(false);
    expect(sql).toHaveLength(2);
    expect(sql[1].replace(/\s+/g, ' ')).toMatch(/SELECT attempts.*FROM sms_signup_throttle/i);
  });

  it('under the daily cap, reports the interval and the seconds left of it', async () => {
    const result = await checkAndRecordInstantPicks(SUBSCRIBER, {
      query: fakeQuery([[], [{ attempts: 3, since_last: 10 }]]),
    });

    expect(result.reason).toBe('interval');
    expect(result.retryAfterSeconds).toBe(50); // 60 - 10
    expect(result.degraded).toBe(false);
  });

  it('at the daily cap, reports daily and waits for the UTC day to roll over', async () => {
    const result = await checkAndRecordInstantPicks(SUBSCRIBER, {
      query: fakeQuery([[], [{ attempts: 20, since_last: 5000 }]]),
    });

    expect(result.reason).toBe('daily');
    // Longer than any interval wait, and never more than a day.
    expect(result.retryAfterSeconds).toBeGreaterThan(60);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(86_400);
  });

  it('never reports a confident zero — a refusal always carries a real wait', async () => {
    // The row vanished between the two statements (a retention sweep at midnight). Falling back to
    // the minimum interval is honest; returning 0 would tell the page to retry immediately into a
    // limit that has not moved.
    const result = await checkAndRecordInstantPicks(SUBSCRIBER, { query: fakeQuery([[], []]) });

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('allows the press when the upsert returns a row, and asks nothing further', async () => {
    const result = await checkAndRecordInstantPicks(SUBSCRIBER, {
      query: fakeQuery([[{ attempts: 1 }]]),
    });

    expect(result).toEqual({ allowed: true, reason: null, retryAfterSeconds: 0, degraded: false });
    expect(sql).toHaveLength(1); // no explain query on the happy path
  });
});

describe('instant picks throttle · fails OPEN, loudly', () => {
  it('lets the press through when the table is unreachable, and says it degraded', async () => {
    // A limiter that failed CLOSED would turn "the counter table hiccuped" into "the button is
    // broken for everyone" — the worse outcome for a cost control.
    const result = await checkAndRecordInstantPicks(SUBSCRIBER, {
      query: (async () => {
        throw new Error('connection refused');
      }) as never,
    });

    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('specifically survives migration 0046 being unapplied', async () => {
    // The realistic failure: the code ships before the Operator applies the CHECK widening, so
    // every write under the new scope raises 23514. The button must still work.
    const result = await checkAndRecordInstantPicks(SUBSCRIBER, {
      query: (async () => {
        throw Object.assign(new Error('new row violates check constraint'), { code: '23514' });
      }) as never,
    });

    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('degrades rather than inventing a subject when the salt is missing', async () => {
    delete process.env.SMS_PHONE_HASH_SALT;
    const q = (async (text: string) => {
      sql.push(text);
      return [{ attempts: 1 }];
    }) as never;

    const result = await checkAndRecordInstantPicks(SUBSCRIBER, { query: q });

    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
    // An unsalted or constant subject would produce a table that either throttles nobody or
    // throttles everybody together. Better to not write at all.
    expect(sql).toHaveLength(0);
  });

  it('never throws, whatever the database does', async () => {
    await expect(
      checkAndRecordInstantPicks(SUBSCRIBER, {
        query: (async () => {
          throw new Error('boom');
        }) as never,
      })
    ).resolves.toMatchObject({ allowed: true });
  });
});
