// tests/sms/twilio_client.test.ts — the real outbound Twilio call, and the delivery-status
// callback that closes the loop.
//
// ═══ HOW THIS IS TESTED WITHOUT A TWILIO ACCOUNT ═══
// Nobody on this branch holds a credential, and no test may reach the network. But "we cannot run
// it live" is not the same as "we cannot verify it", and the weaker version of this file — a hand
// written fake asserting that our own code called our own fake — would pass just as happily on a
// wrong parameter name, a wrong URL, or a `from` where a `messagingServiceSid` belongs.
//
// So this is DIFFERENTIAL, the same discipline tests/sms/twilio_signature.test.ts applies to
// signature verification: the REAL `twilio` client (6.1.0, the version in package.json) is
// constructed with a fake HTTP layer via its documented `httpClient` option, and the assertions
// are on THE REQUEST THE SDK ITSELF PRODUCED — method, URI, and form parameters. If the SDK
// renames a field or we pass the wrong one, these fail.
//
// What genuinely CANNOT be verified here, stated rather than papered over: that Twilio's servers
// accept the request, and that a real toll-free number is provisioned behind the Messaging
// Service. Those need the credential and the account. Everything up to the socket is covered.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Twilio from 'twilio';
import RestException from 'twilio/lib/base/RestException';
import {
  dispatchSms,
  twilioClient,
  TWILIO_ERROR_OPTED_OUT,
  type TwilioMessageSender,
} from '@/lib/sms/twilio-client';
import { renderWelcomeMessage } from '@/lib/sms/message';

const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const AUTH_TOKEN = 'auth-token-value';
const SERVICE_SID = `MG${'b'.repeat(32)}`;
const TO = '+16045550123';
const CALLBACK = 'https://kidsfun.example/api/sms/status';

const MESSAGE = renderWelcomeMessage({
  areaLabel: 'East Van',
  childAges: [5],
  preferencesUrl: 'https://kidsfun.example/u/8fJ2q',
});

function configure({ callback = true }: { callback?: boolean } = {}) {
  vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT_SID);
  vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN);
  vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', SERVICE_SID);
  if (callback) vi.stubEnv('SMS_STATUS_CALLBACK_URL', CALLBACK);
}

/**
 * The REAL Twilio client with its HTTP layer replaced. Everything the SDK does to shape, encode
 * and address the request still happens; only the socket is missing.
 */
function realClientCapturing(
  respond: (opts: Record<string, unknown>) => { statusCode: number; body: unknown }
) {
  const requests: Array<Record<string, unknown>> = [];
  const httpClient = {
    request: async (opts: Record<string, unknown>) => {
      requests.push(opts);
      const res = respond(opts);
      if (res.statusCode >= 400) throw new RestException({ statusCode: res.statusCode, body: res.body });
      return res;
    },
  };
  const client = Twilio(ACCOUNT_SID, AUTH_TOKEN, {
    httpClient: httpClient as never,
  }) as unknown as TwilioMessageSender;
  return { client, requests };
}

const ok = (over: Record<string, unknown> = {}) => () => ({
  statusCode: 201,
  body: { sid: 'SM_created', status: 'queued', num_segments: '1', ...over },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// The request the SDK actually produces
// ─────────────────────────────────────────────────────────────────────────────

describe('the outbound request', () => {
  it('POSTs the documented Messages endpoint with the exact form parameters', async () => {
    configure();
    const { client, requests } = realClientCapturing(ok());
    const result = await dispatchSms(TO, MESSAGE, { dryRun: false, client });

    expect(result.outcome).toBe('sent');
    expect(result.twilioSid).toBe('SM_created');
    expect(requests).toHaveLength(1);

    const req = requests[0];
    expect(req.method).toBe('post');
    expect(req.uri).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`
    );
    // The SDK's own PascalCase field names, produced by the SDK, not by us.
    expect(req.data).toEqual({
      To: TO,
      Body: MESSAGE.body,
      MessagingServiceSid: SERVICE_SID,
      StatusCallback: CALLBACK,
    });
  });

  it('sends MessagingServiceSid and NEVER a bare From number', async () => {
    // The Messaging Service holds the toll-free sender pool, applies Advanced Opt-Out (which is
    // what handles STOP/START/HELP before our inbound webhook runs) and is what Toll-Free
    // Verification is granted against. A bare `From` would bypass all three.
    configure();
    const { client, requests } = realClientCapturing(ok());
    await dispatchSms(TO, MESSAGE, { dryRun: false, client });
    expect(requests[0].data).not.toHaveProperty('From');
    expect((requests[0].data as Record<string, string>).MessagingServiceSid).toBe(SERVICE_SID);
  });

  it('omits StatusCallback entirely rather than sending an empty one', async () => {
    // Twilio validates the parameter; a blank one would fail the whole send for the sake of a
    // delivery receipt.
    configure({ callback: false });
    const { client, requests } = realClientCapturing(ok());
    const result = await dispatchSms(TO, MESSAGE, { dryRun: false, client });
    expect(result.outcome).toBe('sent');
    expect(requests[0].data).not.toHaveProperty('StatusCallback');
  });

  it('sends the body verbatim — no re-encoding, no truncation', async () => {
    configure();
    const { client, requests } = realClientCapturing(ok());
    await dispatchSms(TO, MESSAGE, { dryRun: false, client });
    expect((requests[0].data as Record<string, string>).Body).toBe(MESSAGE.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Outcome mapping — unchanged from the stub it replaced
// ─────────────────────────────────────────────────────────────────────────────

describe('outcome mapping', () => {
  it('is dry-run FIRST, before it needs any credential at all', async () => {
    // No environment stubbed on purpose. A verification run must build and cost every message in
    // an unconfigured environment and dispatch none of them.
    const { client, requests } = realClientCapturing(ok());
    const result = await dispatchSms(TO, MESSAGE, { dryRun: true, client });
    expect(result).toEqual({ outcome: 'dry_run', twilioSid: null, errorCode: null });
    expect(requests).toEqual([]);
  });

  it('maps a 21610 to stopped_via_carrier, not to a retryable failure', async () => {
    // PRD §2.2 step 6: this is the send-time safeguard independent of the inbound STOP webhook,
    // and the faster of the two paths into status = 'stopped'.
    configure();
    const { client } = realClientCapturing(() => ({
      statusCode: 400,
      body: {
        code: TWILIO_ERROR_OPTED_OUT,
        message: `The message From/To pair violates a blacklist rule. To: ${TO}`,
        status: 400,
      },
    }));
    const result = await dispatchSms(TO, MESSAGE, { dryRun: false, client });
    expect(result.outcome).toBe('stopped_via_carrier');
    expect(result.errorCode).toBe(21610);
  });

  it('maps any other Twilio error to failed', async () => {
    configure();
    const { client } = realClientCapturing(() => ({
      statusCode: 400,
      body: { code: 30001, message: 'Queue overflow', status: 400 },
    }));
    const result = await dispatchSms(TO, MESSAGE, { dryRun: false, client });
    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe(30001);
  });

  it('treats a create-time failed/undelivered/canceled status as failed, not sent', async () => {
    // `create` normally returns queued/accepted and the verdict arrives on the callback. These
    // three already mean it did not go, and calling them 'sent' would write a 'sent' audit row
    // for a message Twilio had given up on.
    configure();
    for (const status of ['failed', 'undelivered', 'canceled']) {
      const { client } = realClientCapturing(ok({ status }));
      const result = await dispatchSms(TO, MESSAGE, { dryRun: false, client });
      expect(result.outcome, status).toBe('failed');
    }
    // And a create-time failure that IS a carrier opt-out still routes to the right outcome.
    const { client } = realClientCapturing(ok({ status: 'failed', error_code: 21610 }));
    expect((await dispatchSms(TO, MESSAGE, { dryRun: false, client })).outcome)
      .toBe('stopped_via_carrier');
  });

  it('treats queued / accepted / sending as sent — the callback carries the later truth', async () => {
    configure();
    for (const status of ['queued', 'accepted', 'sending', 'sent']) {
      const { client } = realClientCapturing(ok({ status }));
      expect((await dispatchSms(TO, MESSAGE, { dryRun: false, client })).outcome, status).toBe('sent');
    }
  });

  it('fails closed and quietly when credentials are missing', async () => {
    // Nothing stubbed. This is called from the Friday job, the signup route and the inbound
    // webhook, and none of them may turn "Twilio is not set up here" into a 500 for a parent.
    const result = await dispatchSms(TO, MESSAGE, { dryRun: false, client: null });
    expect(result.outcome).toBe('failed');
    expect(result.twilioSid).toBeNull();
    expect(result.error).toBe('twilio credentials not configured');
  });

  it('fails when the Messaging Service is unset, rather than falling back to a number', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT_SID);
    vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN);
    const { client, requests } = realClientCapturing(ok());
    const result = await dispatchSms(TO, MESSAGE, { dryRun: false, client });
    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('twilio messaging service not configured');
    expect(requests).toEqual([]);
  });

  it('survives a transport failure with no error code', async () => {
    configure();
    const client = {
      messages: { create: async () => { throw new Error('socket hang up'); } },
    } as unknown as TwilioMessageSender;
    const result = await dispatchSms(TO, MESSAGE, { dryRun: false, client });
    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBeNull();
    expect(result.error).toBe('twilio request failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The PII rule that is hardest to keep in this file
// ─────────────────────────────────────────────────────────────────────────────

describe('nothing returned may carry the number or the body', () => {
  it('discards Twilio\'s error message, which quotes the recipient back at us', async () => {
    // 21211 is literally "The 'To' number +1604... is not a valid phone number." Passing
    // err.message through would have piped a subscriber's number into every log line and Sentry
    // breadcrumb the send job produces.
    configure();
    const { client } = realClientCapturing(() => ({
      statusCode: 400,
      body: {
        code: 21211,
        message: `The 'To' number ${TO} is not a valid phone number.`,
        status: 400,
      },
    }));
    const result = await dispatchSms(TO, MESSAGE, { dryRun: false, client });

    expect(result.error).toBe('twilio error 21211');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('6045550123');
    expect(serialized).not.toContain('East Van');
    expect(serialized).not.toContain(MESSAGE.body);
  });

  it('carries no number or body on ANY failure path', async () => {
    configure();
    const paths: Array<TwilioMessageSender> = [
      { messages: { create: async () => { throw new Error(`connection to ${TO} reset`); } } } as never,
      { messages: { create: async () => ({ sid: 'SM1', status: 'failed', errorCode: 30006 }) } } as never,
    ];
    for (const client of paths) {
      const serialized = JSON.stringify(await dispatchSms(TO, MESSAGE, { dryRun: false, client }));
      expect(serialized).not.toContain('6045550123');
      expect(serialized).not.toContain(MESSAGE.body);
    }
  });
});

describe('twilioClient', () => {
  it('returns null when unconfigured, and a client when configured', () => {
    expect(twilioClient()).toBeNull();
    configure();
    expect(twilioClient()).not.toBeNull();
  });

  it('reuses one client, but not across a credential change', async () => {
    // The SDK client holds a connection pool worth reusing across a bulk run of several hundred
    // sends — but a process that changes account must not keep talking to the old one.
    configure();
    const first = twilioClient();
    expect(twilioClient()).toBe(first);
    vi.stubEnv('TWILIO_ACCOUNT_SID', `AC${'c'.repeat(32)}`);
    expect(twilioClient()).not.toBe(first);
  });
});
