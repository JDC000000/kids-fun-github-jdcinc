// tests/sms/delivery_status.test.ts — the Twilio delivery-status callback (POST /api/sms/status).
//
// The other end of the loop lib/sms/twilio-client.ts opens. Previously deferred as "scaffolding
// on top of scaffolding" because there was no real send to report a status FROM; round 16's real
// dispatch now passes a `StatusCallback` URL that needs somewhere to land.
//
// Requests are signed with TWILIO'S OWN SDK, not with our implementation — same differential
// reasoning as tests/sms/twilio_signature.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks';
import { POST, MAX_STATUS_PAYLOAD_BYTES } from '@/app/api/sms/status/route';
import {
  applyDeliveryStatus,
  DELIVERY_STATUS_RANK,
  DELIVERY_STATUS_RETRY_DELAYS_MS,
  deliveryStatusRank,
  FAILED_DELIVERY_STATUSES,
  KNOWN_DELIVERY_STATUSES,
  parseDeliveryStatus,
  recordDeliveryStatus,
  UNRANKED_DELIVERY_RANK,
  type DeliveryStatusReport,
} from '@/lib/sms/delivery-status';

// The unit lane does not touch a database — Stage B made applyDeliveryStatus issue real SQL. See
// tests/sms/send_log-db.test.ts for the statement itself, in the `db` lane.
//
// The mock is a SPY rather than a constant `[]` because the writer now BRANCHES on what the
// database answered: an UPDATE that matched nothing means one thing if the row exists and another
// if it does not. A stub that always says "no rows" would exercise only the retry path, and would
// make every route test in this file wait out the retry budget.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
  getPool: () => {
    throw new Error('the unit lane must not open a pool');
  },
}));

/** The default: whatever is asked, one row comes back — i.e. the UPDATE advanced the row. */
beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue([{ id: 'row-1' }]);
});

/** The parameter array of the nth UPDATE the writer issued. */
function updateParams(nth = 0): unknown[] {
  const updates = queryMock.mock.calls.filter((c) => String(c[0]).includes('UPDATE sms_send_log'));
  return (updates[nth]?.[1] ?? []) as unknown[];
}
const updateCount = () =>
  queryMock.mock.calls.filter((c) => String(c[0]).includes('UPDATE sms_send_log')).length;


const URL_ = 'https://kidsfun.example/api/sms/status';
const TOKEN = 'test-auth-token';
const SID = 'SM1342fe1b2c904d1ab04f0fc7a58abca9';

/** Twilio's own documented example payload for a status callback, field for field. */
const DELIVERED = {
  AccountSid: `AC${'a'.repeat(32)}`,
  From: '+15017250604',
  MessageSid: SID,
  MessageStatus: 'sent',
  SmsSid: SID,
  SmsStatus: 'sent',
};

function configure() {
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubEnv('SMS_STATUS_CALLBACK_URL', URL_);
}

function signed(fields: Record<string, string>, over: { signature?: string } = {}) {
  return new Request(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': over.signature ?? getExpectedTwilioSignature(TOKEN, URL_, fields),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const params = (fields: Record<string, string>) => new URLSearchParams(fields);
const sig = (fields: Record<string, string>) => getExpectedTwilioSignature(TOKEN, URL_, fields);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseDeliveryStatus', () => {
  it("reads Twilio's own documented payload", () => {
    expect(parseDeliveryStatus(params(DELIVERED))).toEqual({
      twilioSid: SID,
      status: 'sent',
      errorCode: null,
    });
  });

  it('prefers MessageSid but accepts SmsSid, the legacy alias', () => {
    // Twilio's example carries both with identical values. A channel that sends only the old name
    // still has to work.
    expect(parseDeliveryStatus(params({ SmsSid: SID, SmsStatus: 'delivered' }))?.twilioSid).toBe(SID);
    expect(
      parseDeliveryStatus(params({ MessageSid: SID, SmsSid: 'SM_other', MessageStatus: 'delivered' }))
        ?.twilioSid
    ).toBe(SID);
  });

  it('reads ErrorCode when a delivery failed, and null when it did not', () => {
    expect(
      parseDeliveryStatus(params({ MessageSid: SID, MessageStatus: 'undelivered', ErrorCode: '30003' }))
        ?.errorCode
    ).toBe(30003);
    // Absent on every successful status, so "not a number" is the normal case, not an exception.
    expect(parseDeliveryStatus(params(DELIVERED))?.errorCode).toBeNull();
    expect(
      parseDeliveryStatus(params({ MessageSid: SID, MessageStatus: 'sent', ErrorCode: 'nonsense' }))
        ?.errorCode
    ).toBeNull();
    expect(
      parseDeliveryStatus(params({ MessageSid: SID, MessageStatus: 'sent', ErrorCode: '0' }))
        ?.errorCode
    ).toBeNull();
  });

  it('returns null when either required field is missing', () => {
    expect(parseDeliveryStatus(params({ MessageStatus: 'sent' }))).toBeNull();
    expect(parseDeliveryStatus(params({ MessageSid: SID }))).toBeNull();
    expect(parseDeliveryStatus(params({}))).toBeNull();
  });

  it('records an UNKNOWN status verbatim rather than rejecting it', () => {
    // Twilio's docs warn the properties "vary by messaging channel and event type and are subject
    // to change" and that it "occasionally adds new properties without advance notice".
    // sms_send_log.delivery_status is plain text with no CHECK (0035) precisely so a new Twilio
    // state does not become a failed write.
    const report = parseDeliveryStatus(params({ MessageSid: SID, MessageStatus: 'teleported' }));
    expect(report?.status).toBe('teleported');
    expect(KNOWN_DELIVERY_STATUSES.has('teleported')).toBe(false);
  });

  it('knows which statuses are terminal failures', () => {
    for (const s of ['undelivered', 'failed', 'canceled']) expect(FAILED_DELIVERY_STATUSES.has(s)).toBe(true);
    for (const s of ['delivered', 'sent', 'queued']) expect(FAILED_DELIVERY_STATUSES.has(s)).toBe(false);
    // The known set is the SDK's own MessageStatus union, transcribed not recalled.
    for (const s of FAILED_DELIVERY_STATUSES) expect(KNOWN_DELIVERY_STATUSES.has(s)).toBe(true);
  });
});

describe('recordDeliveryStatus', () => {
  it('verifies, parses and writes exactly one update', async () => {
    const writes: DeliveryStatusReport[] = [];
    const result = await recordDeliveryStatus(params(DELIVERED), sig(DELIVERED), {
      authToken: TOKEN,
      url: URL_,
      write: async (r) => {
        writes.push(r);
        return 'applied';
      },
    });
    expect(result.outcome).toBe('applied');
    expect(writes).toEqual([{ twilioSid: SID, status: 'sent', errorCode: null }]);
  });

  it('refuses an unverified caller BEFORE parsing anything', async () => {
    const writes: DeliveryStatusReport[] = [];
    const result = await recordDeliveryStatus(params(DELIVERED), 'not-the-signature', {
      authToken: TOKEN,
      url: URL_,
      write: async (r) => {
        writes.push(r);
        return 'applied';
      },
    });
    expect(result.outcome).toBe('unverified');
    expect(result.report).toBeNull();
    expect(writes).toEqual([]);
  });

  it('fails closed when the token or the URL is unconfigured', async () => {
    for (const over of [{ authToken: null }, { url: null }]) {
      const result = await recordDeliveryStatus(params(DELIVERED), sig(DELIVERED), {
        authToken: TOKEN,
        url: URL_,
        ...over,
      });
      expect(result.outcome).toBe('unverified');
    }
  });

  it('verifies over WHATEVER parameters arrived, including ones we do not read', async () => {
    // Twilio adds properties without notice. Verifying over the whole URLSearchParams rather than
    // a list of expected fields is what makes that safe by construction.
    const evolved = { ...DELIVERED, SomeFutureField: 'x', ChannelPrefix: 'sms' };
    const result = await recordDeliveryStatus(params(evolved), sig(evolved), {
      authToken: TOKEN,
      url: URL_,
      write: async () => 'applied',
    });
    expect(result.outcome).toBe('applied');
    // And a signature computed WITHOUT the new field no longer verifies, which is the same fact
    // from the other side: nothing is excluded from the check.
    const stale = await recordDeliveryStatus(params(evolved), sig(DELIVERED), {
      authToken: TOKEN,
      url: URL_,
    });
    expect(stale.outcome).toBe('unverified');
  });

  it('reports a malformed body without writing', async () => {
    const junk = { AccountSid: 'AC1', MessageStatus: 'sent' }; // no SID
    const result = await recordDeliveryStatus(params(junk), sig(junk), {
      authToken: TOKEN,
      url: URL_,
      write: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result.outcome).toBe('malformed');
  });

  it('never throws when the write fails', async () => {
    const result = await recordDeliveryStatus(params(DELIVERED), sig(DELIVERED), {
      authToken: TOKEN,
      url: URL_,
      write: async () => {
        throw new Error('relation "sms_send_log" does not exist');
      },
    });
    expect(result.outcome).toBe('error');
    expect(result.report?.twilioSid).toBe(SID);
  });

  it('is NOT gated on SMS_SENDING_ENABLED, and that is deliberate', async () => {
    // Every other write on this branch is. This one must not be: a callback only ever arrives for
    // a message that was actually sent, so the flag cannot protect anything here — it could only
    // discard delivery receipts for messages already in flight.
    const writes: DeliveryStatusReport[] = [];
    // SMS_SENDING_ENABLED deliberately unset.
    const result = await recordDeliveryStatus(params(DELIVERED), sig(DELIVERED), {
      authToken: TOKEN,
      url: URL_,
      write: async (r) => {
        writes.push(r);
        return 'applied';
      },
    });
    expect(result.outcome).toBe('applied');
    expect(writes).toHaveLength(1);
  });

  it('the default writer now issues a real UPDATE — proven by mocking the db seam', async () => {
    // Stage B made this seam real. In the unit lane the db client is mocked (top of file), so this
    // asserts the WIRING — that the default path reaches the query layer rather than a stub —
    // while tests/sms/send_log-db.test.ts proves the statement itself against a real table.
    const result = await recordDeliveryStatus(params(DELIVERED), sig(DELIVERED), {
      authToken: TOKEN,
      url: URL_,
    });
    expect(result.outcome).toBe('applied');
  });
});

describe('deliveryStatusRank — the out-of-order guard\'s ordering', () => {
  it('puts EVERY terminal verdict above EVERY in-flight state', () => {
    // The load-bearing property, and the only one the fix actually depends on: a callback that
    // says "still on its way" can never displace one that says how it ended.
    const inFlight = ['scheduled', 'accepted', 'queued', 'sending', 'sent'];
    const terminal = ['delivered', 'undelivered', 'failed', 'canceled', 'partially_delivered'];
    for (const t of terminal)
      for (const f of inFlight)
        expect(deliveryStatusRank(t)).toBeGreaterThan(deliveryStatusRank(f));
  });

  it("follows Twilio's own progression among the in-flight states", () => {
    const order = ['scheduled', 'accepted', 'queued', 'sending', 'sent'];
    for (let i = 1; i < order.length; i++)
      expect(deliveryStatusRank(order[i])).toBeGreaterThan(deliveryStatusRank(order[i - 1]));
  });

  it('ranks the three terminal verdicts EQUALLY, so one never overwrites another', () => {
    // Twilio does not send two verdicts for one message, so a second one is a duplicate rather
    // than a correction. Equal rank + a strictly-greater comparison makes it a no-op.
    expect(deliveryStatusRank('delivered')).toBe(deliveryStatusRank('undelivered'));
    expect(deliveryStatusRank('delivered')).toBe(deliveryStatusRank('failed'));
    // ...and every status the file already calls a terminal failure is at that rank.
    for (const f of FAILED_DELIVERY_STATUSES)
      expect(deliveryStatusRank(f)).toBe(deliveryStatusRank('delivered'));
  });

  it("puts 'read' strictly after 'delivered' — it is the one real advance past it", () => {
    expect(deliveryStatusRank('read')).toBeGreaterThan(deliveryStatusRank('delivered'));
  });

  it('sits an UNRECOGNISED status above every in-flight state and below every terminal one', () => {
    // Neither extreme is safe: lowest would drop a Twilio state we have not heard of yet (their
    // docs promise there will be some), highest would let any string displace `delivered`.
    expect(deliveryStatusRank('teleported')).toBe(UNRANKED_DELIVERY_RANK);
    expect(deliveryStatusRank('teleported')).toBeGreaterThan(deliveryStatusRank('sent'));
    expect(deliveryStatusRank('teleported')).toBeLessThan(deliveryStatusRank('delivered'));
  });

  it('ranks nothing that is not a real Twilio status', () => {
    // The rank table is a subset of the SDK's own MessageStatus union, transcribed not recalled.
    for (const s of DELIVERY_STATUS_RANK.keys()) expect(KNOWN_DELIVERY_STATUSES.has(s)).toBe(true);
    // receiving/received describe an INBOUND message and cannot arrive on this callback, so they
    // are deliberately unranked rather than given an invented position.
    expect(DELIVERY_STATUS_RANK.has('receiving')).toBe(false);
    expect(DELIVERY_STATUS_RANK.has('received')).toBe(false);
  });
});

describe('applyDeliveryStatus — the guard, the error code and the missing row', () => {
  /** Parameter positions of the UPDATE, named so the assertions below read as intent. */
  const STATUS = 0;
  const ERROR_CODE = 1;
  const SID = 2;
  const BLOCKING = 3;
  const UNRANKED_BLOCKS = 4;

  it('blocks every status at or above the incoming one — a late `queued` cannot land', async () => {
    await applyDeliveryStatus({ twilioSid: 'SM1', status: 'queued', errorCode: null });
    const blocking = updateParams()[BLOCKING] as string[];
    // Everything the row could already hold that is further along, INCLUDING queued itself.
    for (const s of ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'read'])
      expect(blocking).toContain(s);
    // ...and nothing behind it, which is what makes this an advance rather than a freeze.
    for (const s of ['scheduled', 'accepted']) expect(blocking).not.toContain(s);
    // An unrecognised stored status also outranks `queued`, so it blocks too.
    expect(updateParams()[UNRANKED_BLOCKS]).toBe(true);
  });

  it('lets a terminal verdict overwrite anything still in flight', async () => {
    await applyDeliveryStatus({ twilioSid: 'SM1', status: 'delivered', errorCode: null });
    const blocking = updateParams()[BLOCKING] as string[];
    for (const s of ['scheduled', 'accepted', 'queued', 'sending', 'sent'])
      expect(blocking).not.toContain(s);
    // Only the other terminals, and `read`, are ahead of it.
    for (const s of ['delivered', 'undelivered', 'failed', 'read']) expect(blocking).toContain(s);
    // An unrecognised status does NOT hold off the carrier's final verdict.
    expect(updateParams()[UNRANKED_BLOCKS]).toBe(false);
  });

  it('records an unrecognised status over an in-flight one, but never over a verdict', async () => {
    await applyDeliveryStatus({ twilioSid: 'SM1', status: 'teleported', errorCode: null });
    const blocking = updateParams()[BLOCKING] as string[];
    expect(blocking).not.toContain('sent');
    for (const s of ['delivered', 'undelivered', 'failed']) expect(blocking).toContain(s);
    expect(updateParams()[UNRANKED_BLOCKS]).toBe(true); // another unknown is a duplicate, not news
  });

  it('sends the error code to the SAME statement that moves the status', async () => {
    // Not a second UPDATE: the code on a row must always describe the status on that row.
    await applyDeliveryStatus({ twilioSid: 'SM1', status: 'undelivered', errorCode: 30003 });
    expect(updateCount()).toBe(1);
    expect(updateParams()[STATUS]).toBe('undelivered');
    expect(updateParams()[ERROR_CODE]).toBe(30003);
    expect(updateParams()[SID]).toBe('SM1');
    expect(String(queryMock.mock.calls[0][0])).toContain('delivery_error_code');
  });

  it('reports `ignored` when the row is there and the guard declined — no retry', async () => {
    queryMock.mockImplementation(async (sql: string) =>
      String(sql).includes('UPDATE') ? [] : [{ id: 'row-1' }]
    );
    expect(await applyDeliveryStatus({ twilioSid: 'SM1', status: 'queued', errorCode: null })).toBe(
      'ignored'
    );
    // Settled, not transient: retrying a rejected rank would reject it again, forever.
    expect(updateCount()).toBe(1);
  });

  it('reports `no_match` rather than success when no row ever appears', async () => {
    // THE BUG THIS REPLACES: a zero-row UPDATE used to be indistinguishable from a recorded one.
    queryMock.mockResolvedValue([]);
    expect(
      await applyDeliveryStatus({ twilioSid: 'SM_nothing', status: 'delivered', errorCode: null })
    ).toBe('no_match');
    expect(updateCount()).toBe(DELIVERY_STATUS_RETRY_DELAYS_MS.length + 1); // bounded, and tried
  });

  it('RETRIES the callback that overtook its own INSERT, and then applies it', async () => {
    // The real race: every caller dispatches first and writes sms_send_log immediately after, so
    // the first status callback can be in flight while the row is still uncommitted.
    let rowExists = false;
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('UPDATE')) return rowExists ? [{ id: 'row-1' }] : [];
      return rowExists ? [{ id: 'row-1' }] : [];
    });
    const inFlight = applyDeliveryStatus({ twilioSid: 'SM_late', status: 'sent', errorCode: null });
    setTimeout(() => {
      rowExists = true; // the INSERT commits while we are between attempts
    }, 100);
    expect(await inFlight).toBe('applied');
    expect(updateCount()).toBeGreaterThan(1);
  });
});

describe('recordDeliveryStatus — the writer\'s verdict reaches the caller', () => {
  it('passes `ignored` and `no_match` through instead of flattening them into `applied`', async () => {
    for (const verdict of ['ignored', 'no_match'] as const) {
      const result = await recordDeliveryStatus(params(DELIVERED), sig(DELIVERED), {
        authToken: TOKEN,
        url: URL_,
        write: async () => verdict,
      });
      expect(result.outcome).toBe(verdict);
      // The report survives either way — an alert needs to know WHICH message went unrecorded.
      expect(result.report?.twilioSid).toBe(SID);
    }
  });
});

describe('POST /api/sms/status', () => {
  it('accepts a properly signed callback with empty TwiML', async () => {
    configure();
    const res = await POST(signed(DELIVERED));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('403s an unsigned and a wrongly-signed callback', async () => {
    configure();
    expect((await POST(signed(DELIVERED, { signature: 'nope' }))).status).toBe(403);
    const unsigned = new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(DELIVERED).toString(),
    });
    expect((await POST(unsigned)).status).toBe(403);
  });

  it('fails CLOSED when TWILIO_AUTH_TOKEN is unset', async () => {
    vi.stubEnv('SMS_STATUS_CALLBACK_URL', URL_);
    expect((await POST(signed(DELIVERED))).status).toBe(403);
  });

  it('answers 200 for a malformed but SIGNED body — a retry would not help', async () => {
    // A non-2xx makes Twilio retry the callback, and retrying will not make an unparseable
    // payload parseable. Our failures are ours to alert on, not Twilio's to retry.
    configure();
    const junk = { AccountSid: 'AC1', MessageStatus: 'sent' };
    expect((await POST(signed(junk))).status).toBe(200);
  });

  it('413s an oversized body before the signature check', async () => {
    configure();
    const res = await POST(
      new Request(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ MessageSid: SID, Body: 'x'.repeat(MAX_STATUS_PAYLOAD_BYTES) }).toString(),
      })
    );
    expect(res.status).toBe(413);
  });

  it('answers TwiML on every path, so Twilio never logs a webhook error', async () => {
    configure();
    for (const req of [signed(DELIVERED), signed(DELIVERED, { signature: 'nope' })]) {
      const res = await POST(req);
      expect(res.headers.get('content-type')).toContain('text/xml');
      expect(await res.text()).toContain('<Response></Response>');
    }
  });
});
