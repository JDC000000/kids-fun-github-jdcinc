// tests/sms/inbound_loop_guard.test.ts — the 2026-09-24 auto-reply loop, and the two guards that
// end it (lib/sms/inbound-reply-guard.ts).
//
// Incident: our toll-free number and a QA number both webhook POST /api/sms/inbound. Each one's
// "didn't catch that" reply was the other's unknown inbound text — ~60 messages in 39 seconds.
//
// Driven through the REAL route with requests SIGNED BY TWILIO'S OWN SDK (same as
// tests/sms/inbound_route.test.ts). The db seam is a small IN-MEMORY MODEL of
// `sms_signup_throttle`'s upsert semantics — one row per (scope, subject), refused once
// `attempts >= perDay` — so the loop simulations below exercise the real guard end to end without a
// connection (unit lane). The SQL itself is proven against real Postgres, including under
// concurrency, in tests/sms/unknown_reply_throttle-db.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks';

const db = vi.hoisted(() => ({
  rows: new Map<string, number>(),
  calls: [] as { text: string; params: unknown[] }[],
  fail: null as Error | null,
}));

vi.mock('@/lib/db/client', () => ({
  query: async (text: string, params: unknown[] = []) => {
    db.calls.push({ text, params });
    if (!/INSERT INTO sms_signup_throttle/.test(text)) return [];
    if (db.fail) throw db.fail;
    const [scope, subject, perDay] = params as [string, string, number];
    const key = `${scope}|${subject}`;
    const attempts = db.rows.get(key);
    if (attempts === undefined) {
      db.rows.set(key, 1);
      return [{ attempts: 1 }];
    }
    if (attempts < perDay) {
      db.rows.set(key, attempts + 1);
      return [{ attempts: attempts + 1 }];
    }
    return []; // refused: the conflict WHERE was false, nothing updated or returned
  },
  getPool: () => {
    throw new Error('the unit lane must not open a pool');
  },
}));

import { POST } from '@/app/api/sms/inbound/route';
import { isOwnNumber, checkAndRecordUnknownReply, UNKNOWN_REPLY_LIMITS } from '@/lib/sms/inbound-reply-guard';
import { renderUnknownKeywordMessage } from '@/lib/sms/message';

const URL = 'https://kidsfunapp.ca/api/sms/inbound';
const TOKEN = 'test-auth-token';
const TOLL_FREE = '+18778357776';
const QA = '+17784047122';
const PARENT = '+16045550123';
const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const REPLY = renderUnknownKeywordMessage('https://kidsfunapp.ca/sms/start').body;

function configure({ testNumbers }: { testNumbers?: string } = {}) {
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubEnv('SMS_WEBHOOK_PUBLIC_URL', URL);
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfunapp.ca');
  vi.stubEnv('SMS_PHONE_HASH_SALT', 'loop-guard-test-salt');
  vi.stubEnv('SMS_SENDING_ENABLED', 'true');
  vi.stubEnv('SMS_TEST_NUMBERS', testNumbers ?? '');
}

function signed(fields: Record<string, string>): Request {
  return new Request(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': getExpectedTwilioSignature(TOKEN, URL, fields),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** POST one inbound text; return the reply body we would send back, or null for silence. */
async function text(from: string, to: string, body: string): Promise<string | null> {
  const res = await POST(signed({ From: from, To: to, Body: body }));
  expect(res.status).toBe(200);
  const xml = await res.text();
  if (xml === EMPTY) return null;
  const m = xml.match(/<Message>([\s\S]*)<\/Message>/);
  expect(m, xml).not.toBeNull();
  return m![1];
}

const throttleCalls = () => db.calls.filter((c) => /sms_signup_throttle/.test(c.text));

beforeEach(() => {
  db.rows.clear();
  db.calls.length = 0;
  db.fail = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the incident, replayed — two of our numbers webhooking the same route', () => {
  /**
   * Drive a ping-pong: whatever one side replies becomes the other side's inbound text, From/To
   * swapped. Returns how many replies WE emitted before the exchange went silent (capped at 100 so
   * a regression shows up as a number rather than a hung test).
   */
  async function pingPong(a: string, b: string, opener: string): Promise<number> {
    let from = a;
    let to = b;
    let body: string | null = opener;
    let sent = 0;
    while (body !== null && sent < 100) {
      body = await text(from, to, body);
      if (body !== null) sent++;
      [from, to] = [to, from];
    }
    return sent;
  }

  it('QA → toll-free with SMS_TEST_NUMBERS configured: zero replies', async () => {
    configure({ testNumbers: QA });
    expect(await pingPong(QA, TOLL_FREE, 'test 123')).toBe(0);
  });

  it('QA → toll-free with SMS_TEST_NUMBERS UNSET: one reply, then the toll-free sender is recognised', async () => {
    // Even if prod's env list is incomplete, the QA webhook sees From = our toll-free number and
    // stays silent. The loop cannot get past its first hop.
    configure();
    expect(await pingPong(QA, TOLL_FREE, 'test 123')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a parent whose phone auto-replies to every text', () => {
  it('gets exactly ONE "didn\'t catch that" from us, however many auto-replies it sends', async () => {
    configure();
    const replies: (string | null)[] = [];
    for (let i = 0; i < 50; i++) {
      replies.push(await text(PARENT, TOLL_FREE, "I'm driving right now - I'll get back to you"));
    }
    expect(replies[0]).toBe(REPLY);
    expect(replies.slice(1).every((r) => r === null)).toBe(true);
    expect(UNKNOWN_REPLY_LIMITS.perDay).toBe(1);
  });

  it('the cap is per SENDER: a second parent still gets their reply', async () => {
    configure();
    expect(await text(PARENT, TOLL_FREE, 'hi')).toBe(REPLY);
    expect(await text(PARENT, TOLL_FREE, 'hi again')).toBeNull();
    expect(await text('+16045550199', TOLL_FREE, 'hi')).toBe(REPLY);
  });

  it('formatting variants of one number share a counter', async () => {
    configure();
    expect(await text('+1 (604) 555-0123', TOLL_FREE, 'hi')).toBe(REPLY);
    expect(await text('+16045550123', TOLL_FREE, 'hi')).toBeNull();
  });

  it('JOIN, STOP and HELP are never counted or blocked by the cap', async () => {
    // The cap guards the reply to ARBITRARY text only. A capped sender must still be able to join.
    configure();
    await text(PARENT, TOLL_FREE, 'hi');
    db.calls.length = 0;
    for (const kw of ['JOIN', 'STOP', 'HELP']) {
      expect(await text(PARENT, TOLL_FREE, kw), kw).toBeNull();
    }
    expect(throttleCalls()).toHaveLength(0);
  });

  it('never puts the phone number into the counter — only a salted hash, under scope unknown_reply', async () => {
    configure();
    await text(PARENT, TOLL_FREE, 'hi');
    const [call] = throttleCalls();
    expect(call.params[0]).toBe('unknown_reply');
    expect(call.params[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call.params)).not.toContain('6045550123');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 the counter FAILS CLOSED — no counter, no reply', () => {
  it('a database error (incl. migration 0054 not applied → check_violation) means silence', async () => {
    configure();
    db.fail = Object.assign(new Error('new row violates check constraint'), { code: '23514' });
    expect(await text(PARENT, TOLL_FREE, 'hi')).toBeNull();
  });

  it('a missing SMS_PHONE_HASH_SALT means silence, and the database is not touched', async () => {
    configure();
    vi.stubEnv('SMS_PHONE_HASH_SALT', '');
    expect(await text(PARENT, TOLL_FREE, 'hi')).toBeNull();
    expect(throttleCalls()).toHaveLength(0);
  });

  it('checkAndRecordUnknownReply reports WHY it refused, so the route can alert on the non-normal cases', async () => {
    vi.stubEnv('SMS_PHONE_HASH_SALT', 'x');
    const boom = async () => {
      throw new Error('down');
    };
    expect(await checkAndRecordUnknownReply(PARENT, { query: boom as never })).toMatchObject({
      allowed: false,
      reason: 'db_error',
    });
    const refuse = async () => [];
    expect(await checkAndRecordUnknownReply(PARENT, { query: refuse as never })).toEqual({
      allowed: false,
      reason: 'daily_cap',
    });
    vi.stubEnv('SMS_PHONE_HASH_SALT', '');
    expect(await checkAndRecordUnknownReply(PARENT)).toEqual({ allowed: false, reason: 'no_salt' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what did NOT change', () => {
  it('a dry run (SMS_SENDING_ENABLED unset) is still silent AND still touches no table', async () => {
    configure();
    vi.stubEnv('SMS_SENDING_ENABLED', '');
    expect(await text(PARENT, TOLL_FREE, 'hi')).toBeNull();
    expect(throttleCalls()).toHaveLength(0);
  });

  it('a stranger\'s first unknown text still gets the reply, byte for byte', async () => {
    configure();
    const res = await POST(signed({ From: PARENT, To: TOLL_FREE, Body: 'hi there' }));
    expect(await res.text()).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${REPLY}</Message></Response>`
    );
  });

  it('START from one of our own numbers gets no reply either', async () => {
    configure({ testNumbers: QA });
    expect(await text(QA, TOLL_FREE, 'START')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('isOwnNumber', () => {
  it('recognises the toll-free number, the To number and every SMS_TEST_NUMBERS entry, in any format', () => {
    vi.stubEnv('SMS_TEST_NUMBERS', '+1 (778) 404-7122, +16045550100');
    expect(isOwnNumber(TOLL_FREE, QA)).toBe(true);
    expect(isOwnNumber('+1 877-835-7776', '+15555550000')).toBe(true);
    expect(isOwnNumber('+17784047122', TOLL_FREE)).toBe(true);
    expect(isOwnNumber('+16045550100', TOLL_FREE)).toBe(true);
    expect(isOwnNumber('+15551234567', '+1 555 123 4567')).toBe(true); // From === To
  });

  it('does not recognise a stranger, and an empty From is never "ours"', () => {
    vi.stubEnv('SMS_TEST_NUMBERS', QA);
    expect(isOwnNumber(PARENT, TOLL_FREE)).toBe(false);
    expect(isOwnNumber('', TOLL_FREE)).toBe(false);
    expect(isOwnNumber(null, '')).toBe(false);
  });

  it('with SMS_TEST_NUMBERS unset, the QA number is a stranger (only toll-free and To remain)', () => {
    vi.stubEnv('SMS_TEST_NUMBERS', '');
    expect(isOwnNumber(QA, TOLL_FREE)).toBe(false);
  });
});
