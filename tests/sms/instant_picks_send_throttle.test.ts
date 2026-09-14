// tests/sms/instant_picks_send_throttle.test.ts — the limit on the TEXT a press sends
// (plan v2.0 §4.2/§4.3, task 3).
//
// The `query` seam is INJECTED rather than module-mocked, so this file never constructs a pool and
// stays in the `unit` lane (vitest.workspace.ts).
//
// ═══ THE ONE ASSERTION IN HERE THAT IS NOT LIKE THE OTHER THROTTLES' ═══
// The fail DIRECTION. Every other throttle in this repo fails OPEN and says so loudly; this one
// fails CLOSED, and that inversion is the single most reversible-by-accident decision in the
// feature — "make it consistent with the others" is a plausible-sounding cleanup that would
// convert an unreachable counter into an unmetered bill against somebody else's handset. So it is
// asserted directly, in both of its forms, rather than left to a comment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INSTANT_PICKS_SEND_THROTTLE_LIMITS,
  checkAndRecordInstantPicksSend,
} from '@/lib/sms/instant-picks-send-throttle';
import { SIGNUP_THROTTLE_LIMITS } from '@/lib/sms/signup-store';
import { INSTANT_PICKS_THROTTLE_LIMITS } from '@/lib/sms/instant-picks-throttle';

const SUBSCRIBER = '11111111-2222-3333-4444-555555555555';
const IP = '203.0.113.7';
const SALT = 'test-salt-not-a-real-one';

let sql: string[];
let params: unknown[][];

beforeEach(() => {
  sql = [];
  params = [];
  process.env.SMS_PHONE_HASH_SALT = SALT;
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.SMS_PHONE_HASH_SALT;
});

/** A `query` stand-in that records statements and returns whatever the test queued. */
function fakeQuery(responses: unknown[][]) {
  let i = 0;
  return (async (text: string, p?: unknown[]) => {
    sql.push(text);
    params.push(p ?? []);
    return responses[i++] ?? [];
  }) as never;
}

/** A row coming back from the upsert means ALLOWED; zero rows means refused. */
const ALLOW = [{ attempts: 1 }];
const REFUSE: unknown[] = [];

describe('instant picks send throttle · the limits are the signup limits, not new numbers', () => {
  it('matches SIGNUP_THROTTLE_LIMITS exactly', () => {
    // The plan's argument for reusing them: there is then no new number to defend, and the two
    // paths that cause a real text cannot drift apart. The constant is RESTATED in the send
    // throttle rather than imported (importing it would drag signup-store's whole graph — the
    // postal-FSA table, the token minter, the Twilio client — into a module the press path loads),
    // so THIS is the thing that stops the copy drifting. Do not delete it; if the two are ever
    // meant to differ, that is a decision with a reason, and the reason goes here.
    expect({
      subscriberMinIntervalSeconds: SIGNUP_THROTTLE_LIMITS.phoneMinIntervalSeconds,
      subscriberPerDay: SIGNUP_THROTTLE_LIMITS.phonePerDay,
      ipMinIntervalSeconds: SIGNUP_THROTTLE_LIMITS.ipMinIntervalSeconds,
      ipPerDay: SIGNUP_THROTTLE_LIMITS.ipPerDay,
    }).toEqual(INSTANT_PICKS_SEND_THROTTLE_LIMITS);
  });

  it('is 10 minutes / 3 a day per subscriber and 30s / 20 a day per IP', () => {
    // Spelled out as literals too: the assertion above would still pass if BOTH objects were
    // changed together, and these four numbers are the ones the disclosure copy has to be true
    // against ("a ceiling a reviewer can check" — plan §5.2).
    expect(INSTANT_PICKS_SEND_THROTTLE_LIMITS).toEqual({
      subscriberMinIntervalSeconds: 600,
      subscriberPerDay: 3,
      ipMinIntervalSeconds: 30,
      ipPerDay: 20,
    });
  });

  it('is MUCH tighter than the page-render limit it sits beside', () => {
    // The whole point of a second scope. 20 presses/day was right for a page render and would
    // authorise ~$124/subscriber/year of texts here (plan §4.1).
    expect(INSTANT_PICKS_SEND_THROTTLE_LIMITS.subscriberPerDay)
      .toBeLessThan(INSTANT_PICKS_THROTTLE_LIMITS.perDay);
    expect(INSTANT_PICKS_SEND_THROTTLE_LIMITS.subscriberMinIntervalSeconds)
      .toBeGreaterThan(INSTANT_PICKS_THROTTLE_LIMITS.minIntervalSeconds);
  });
});

describe('instant picks send throttle · both halves, counted independently', () => {
  it('counts the subscriber first and the IP second', async () => {
    const result = await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: fakeQuery([ALLOW, ALLOW]) }
    );
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(false);
    expect(params[0][0]).toBe('instant_picks_sms');
    expect(params[1][0]).toBe('instant_picks_sms_ip');
  });

  it('does not spend the IP budget when the subscriber half already refused', async () => {
    // Order matters: the per-subscriber limit is the one that protects a specific handset, so it
    // refuses first and a noisy shared NAT can never consume one person's allowance.
    const result = await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: fakeQuery([REFUSE, [{ attempts: 3, since_last: 10 }]]) }
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('subscriber_daily');
    // Two statements: the refused upsert and the explain. NEVER the IP upsert.
    expect(params.map((p) => p[0])).toEqual(['instant_picks_sms', 'instant_picks_sms']);
  });

  it('refuses on the IP half even when the subscriber half passed', async () => {
    const result = await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: fakeQuery([ALLOW, REFUSE, [{ attempts: 20, since_last: 5 }]]) }
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('ip_daily');
  });

  it('distinguishes an interval refusal from a daily one, for the logs', async () => {
    const result = await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: fakeQuery([REFUSE, [{ attempts: 1, since_last: 30 }]]) }
    );
    expect(result.reason).toBe('subscriber_interval');
    // 600s limit, 30s elapsed → 570 to wait. The caller never shows this to the subscriber; it is
    // what a `retry-after` header would be computed from.
    expect(result.retryAfterSeconds).toBe(570);
  });

  it('uses scopes distinct from the page counter, so presses and sends never share a row', async () => {
    await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: fakeQuery([ALLOW, ALLOW]) }
    );
    const scopes = params.map((p) => p[0]);
    expect(scopes).not.toContain('instant_picks');
    // And the two subjects differ from each other even though both derive from one salt — the
    // domain prefixes are what keep the families apart.
    expect(params[0][1]).not.toBe(params[1][1]);
  });

  it('passes the limits into the statement rather than hard-coding them', async () => {
    await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: fakeQuery([ALLOW, ALLOW]) }
    );
    expect(params[0][2]).toBe(3);    // subscriberPerDay
    expect(params[0][3]).toBe(600);  // subscriberMinIntervalSeconds
    expect(params[1][2]).toBe(20);   // ipPerDay
    expect(params[1][3]).toBe(30);   // ipMinIntervalSeconds
  });

  it('decides and writes in ONE statement — an upsert, never a SELECT then an INSERT', async () => {
    // The atomicity is lib/sms/throttle.ts's and it is invisible in a single-threaded test, so the
    // SHAPE is what gets asserted: two concurrent presses must not both read zero and both send.
    await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: fakeQuery([ALLOW, ALLOW]) }
    );
    expect(sql[0]).toMatch(/INSERT INTO sms_signup_throttle/);
    expect(sql[0]).toMatch(/ON CONFLICT .* DO UPDATE/s);
    expect(sql[0]).not.toMatch(/SELECT count/i);
  });

  it('stores a hash, never the raw subscriber id or the raw IP', async () => {
    await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: fakeQuery([ALLOW, ALLOW]) }
    );
    for (const p of params) {
      expect(p[1]).toMatch(/^[0-9a-f]{64}$/);
      expect(p[1]).not.toBe(SUBSCRIBER);
      expect(p[1]).not.toBe(IP);
    }
  });
});

describe('instant picks send throttle · 🔴 IT FAILS CLOSED', () => {
  it('refuses when the counter throws — the inversion from every other throttle here', async () => {
    const boom = (async () => {
      throw new Error('relation "sms_signup_throttle" does not exist');
    }) as never;

    const result = await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: boom }
    );

    // ⚠ IF THIS EVER READS `allowed: true`, SOMEBODY HAS "MADE IT CONSISTENT" WITH THE SIGNUP AND
    // PAGE THROTTLES AND THE FEATURE NOW SENDS UNMETERED TEXTS WHEN ITS COUNTER IS UNREACHABLE.
    // The reason the other two fail open — refusing real people is worse than the abuse — does not
    // survive here, because the page STILL RENDERS THE LIST. Failing closed costs one channel;
    // failing open costs money and reaches a third party's handset until a human notices.
    expect(result.allowed).toBe(false);
    expect(result.degraded).toBe(true);
  });

  it('refuses when there is no salt, because nothing was counted at all', async () => {
    delete process.env.SMS_PHONE_HASH_SALT;
    const result = await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: fakeQuery([ALLOW, ALLOW]) }
    );
    expect(result.allowed).toBe(false);
    expect(result.degraded).toBe(true);
    expect(sql).toHaveLength(0); // and it did not pretend to count by inventing a subject
  });

  it('never throws — a throttle that can 500 the preferences page is worse than a lost text', async () => {
    const boom = (async () => {
      throw new Error('nope');
    }) as never;
    await expect(
      checkAndRecordInstantPicksSend({ subscriberId: SUBSCRIBER, ipAddress: IP }, { query: boom })
    ).resolves.toBeDefined();
  });

  it('carries nothing from the error out of the module', async () => {
    const boom = (async () => {
      throw new Error(`failed for +16045551234`);
    }) as never;
    const result = await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: IP },
      { query: boom }
    );
    expect(JSON.stringify(result)).not.toMatch(/1604|nope|failed for/);
  });
});

describe('instant picks send throttle · the one degraded-but-allowed case', () => {
  it('allows and REPORTS when there is no IP to count against', async () => {
    // ⚠ This looks like a hole in "fail closed" and is not. The counter WAS reached and the half
    // that protects a specific handset already ran and passed — every victim is still bounded to
    // three texts a day. What is lost is the bound on how many DIFFERENT handsets one caller can
    // reach. Refusing here instead would mean any deployment that stops forwarding a client IP
    // silently stops sending, with no error — and would diverge from
    // `checkAndRecordSignupAttempt`, which meets this exact state on this exact threat model and
    // degrades-but-allows.
    const result = await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: null },
      { query: fakeQuery([ALLOW]) }
    );
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
    expect(params.map((p) => p[0])).toEqual(['instant_picks_sms']);
  });

  it('still refuses on the subscriber half when there is no IP', async () => {
    const result = await checkAndRecordInstantPicksSend(
      { subscriberId: SUBSCRIBER, ipAddress: null },
      { query: fakeQuery([REFUSE, [{ attempts: 3, since_last: 10 }]]) }
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('subscriber_daily');
  });
});
