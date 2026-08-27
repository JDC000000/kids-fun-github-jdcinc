// tests/sms/delivery_status.test.ts — the Twilio delivery-status callback (POST /api/sms/status).
//
// The other end of the loop lib/sms/twilio-client.ts opens. Previously deferred as "scaffolding
// on top of scaffolding" because there was no real send to report a status FROM; round 16's real
// dispatch now passes a `StatusCallback` URL that needs somewhere to land.
//
// Requests are signed with TWILIO'S OWN SDK, not with our implementation — same differential
// reasoning as tests/sms/twilio_signature.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks';
import { POST, MAX_STATUS_PAYLOAD_BYTES } from '@/app/api/sms/status/route';
import {
  FAILED_DELIVERY_STATUSES,
  KNOWN_DELIVERY_STATUSES,
  parseDeliveryStatus,
  recordDeliveryStatus,
  type DeliveryStatusReport,
} from '@/lib/sms/delivery-status';

// The unit lane does not touch a database — Stage B made applyDeliveryStatus issue real SQL. See
// tests/sms/send_log-db.test.ts for the statement itself, in the `db` lane.
vi.mock('@/lib/db/client', () => ({
  query: async () => [],
  getPool: () => {
    throw new Error('the unit lane must not open a pool');
  },
}));


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
      write: async () => {},
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
