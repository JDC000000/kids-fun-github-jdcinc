// tests/sms/inbound_route.test.ts — POST /api/sms/inbound, the Twilio inbound webhook.
//
// THIS ROUTE HAD NO TEST FILE AT ALL until round 13. Round 1 built its payload cap, its
// fail-closed signature check and its graceful handling of a signed-but-malformed body, and none
// of it was covered — so this file also pins those existing behaviours, not just the new reply.
//
// REQUESTS ARE SIGNED WITH TWILIO'S OWN SDK, not with our implementation, for the same reason
// tests/sms/twilio_signature.test.ts is differential: a test that signs with the code under test
// passes just as happily on a wrong algorithm. `getExpectedTwilioSignature` is the reference.
//
// The four transitions are stubs on this branch (lib/sms/consent-transitions.ts) and are proven
// in tests/sms/consent_transitions.test.ts, so what is testable here is the contract Twilio sees:
// status, content type, and exactly what is in the TwiML body.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks';
import { POST, MAX_INBOUND_PAYLOAD_BYTES, escapeXml } from '@/app/api/sms/inbound/route';
import { renderConfirmRequestMessage } from '@/lib/sms/message';
import { renderUnknownKeywordMessage, assertGsm7Safe, estimateSegments } from '@/lib/sms/message';

const URL = 'https://kidsfun.example/api/sms/inbound';
const TOKEN = 'test-auth-token';
const FROM = '+16045550123';

function configure({ sending = false }: { sending?: boolean } = {}) {
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubEnv('SMS_WEBHOOK_PUBLIC_URL', URL);
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfun.example');
  if (sending) vi.stubEnv('SMS_SENDING_ENABLED', 'true');
}

/** A properly signed Twilio webhook POST. */
function signed(fields: Record<string, string>, over: { signature?: string; url?: string } = {}) {
  const body = new URLSearchParams(fields).toString();
  return new Request(over.url ?? URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': over.signature ?? getExpectedTwilioSignature(TOKEN, URL, fields),
    },
    body,
  });
}

const inbound = (body: string) => signed({ From: FROM, To: '+18778357776', Body: body });

async function xml(res: Response): Promise<string> {
  return res.text();
}

const EXPECTED_REPLY = renderUnknownKeywordMessage('https://kidsfun.example/sms/signup').body;

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// The copy
// ─────────────────────────────────────────────────────────────────────────────

describe('the unknown-keyword reply (copy)', () => {
  it('names JOIN, HELP and STOP — and never START', () => {
    // START is left out on purpose: PRD §1.4 records that Twilio's behaviour toward a
    // previously-unknown or previously-stopped number may be a canned carrier-level auto-reply
    // rather than a route into our app, and that it must be configured and verified against a
    // real toll-free number before launch. We do not print a keyword we cannot promise works.
    const body = renderUnknownKeywordMessage('https://kidsfun.example/sms/signup').body;
    expect(body).toContain('Reply JOIN');
    expect(body).toContain('HELP');
    expect(body).toContain('STOP');
    expect(body).not.toContain('START');
  });

  it('carries the signup link, so following its advice cannot lead to a second silence', () => {
    // Somebody who texts us cold has no sms_consent row: if they reply JOIN the transition
    // answers `no_such_subscriber` and the webhook says nothing at all. The link is the only
    // thing in this message that works for a person who has never signed up.
    expect(EXPECTED_REPLY).toContain('https://kidsfun.example/sms/signup');
  });

  it('passes the GSM-7 guard and fits one segment at the production URL', () => {
    // Also on the all-templates wall in tests/sms/weekly_send.test.ts.
    assertGsm7Safe(EXPECTED_REPLY);
    const live = renderUnknownKeywordMessage('https://kidsfun.ca/sms/signup');
    expect(live.encoding).toBe('GSM-7');
    expect(live.characters).toBe(149);
    expect(live.segments).toBe(1);
    // 11 septets of headroom, which is the real constraint on this copy: a longer host — a
    // preview deployment, say — tips it into a second segment. Measured, not assumed.
    expect(estimateSegments('x'.repeat(11)).characters).toBe(160 - 149);
  });

  it('drops the signup clause rather than printing a placeholder', () => {
    const bare = renderUnknownKeywordMessage(null).body;
    expect(bare).not.toContain('Not signed up?');
    expect(bare).not.toContain('null');
    expect(bare.endsWith('or STOP to end.')).toBe(true);
    assertGsm7Safe(bare);
  });

  it('uses a straight apostrophe — the curly one would triple the cost', () => {
    expect(EXPECTED_REPLY).toContain("didn't");
    expect(EXPECTED_REPLY).not.toContain('’');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/sms/inbound — the unknown branch', () => {
  it('replies with a real TwiML <Message>, not an empty <Response>', async () => {
    configure({ sending: true });
    const res = await POST(inbound('hi there'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    expect(await xml(res)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${EXPECTED_REPLY}</Message></Response>`
    );
  });

  it('answers a NEAR-MISS of JOIN, which is the whole point of refusing to fuzzy-match', async () => {
    // lib/sms/keywords.ts will not promote "JOIM" into a consent record, deliberately. That is
    // only safe if the person is told what the real word is — which, until now, they were not.
    configure({ sending: true });
    for (const typo of ['JOIM', 'join please', 'yes please', 'Jion']) {
      const res = await POST(inbound(typo));
      expect(await xml(res), typo).toContain('Reply JOIN to confirm your signup');
    }
  });

  it('answers an emoji-only or empty body too, which normalises to unknown', async () => {
    // A thumbs-up strips to an empty string in normalizeInboundBody (emoji are \p{S}), so it
    // classifies as `unknown`. Replying is still better than the silence that reads as "this
    // number doesn't work" — flagged in the notes as the one case where it is arguable.
    configure({ sending: true });
    expect(await xml(await POST(inbound('\u{1F44D}')))).toContain('<Message>');
    expect(await xml(await POST(inbound('')))).toContain('<Message>');
  });

  it('says NOTHING for join, stop, start or help — Twilio already answered those', async () => {
    // A second reply from us on a STOP would be a duplicate message on the one exchange a
    // carrier scrutinises most. JOIN answers with the welcome text, via the REST API.
    configure({ sending: true });
    for (const keyword of ['JOIN', 'STOP', 'START', 'HELP', 'unsubscribe', 'info']) {
      const res = await POST(inbound(keyword));
      expect(res.status, keyword).toBe(200);
      expect(await xml(res), keyword).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  });

  it('is gated by SMS_SENDING_ENABLED like every other outbound message', async () => {
    // "This deployment sends no messages" has to mean all of them, or it is not auditable. It
    // also matters concretely right now: until Toll-Free Verification is granted, outbound
    // traffic from an unverified number is what should not be flowing.
    configure(); // SMS_SENDING_ENABLED deliberately unset
    const res = await POST(inbound('hi there'));
    expect(res.status).toBe(200);
    expect(await xml(res)).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('is unaffected by what the INBOUND body contained — the reply is ours, not an echo', async () => {
    // An inbound webhook that reflected the sender's text would be both an XML injection vector
    // and a way to make our number emit arbitrary content. It does not echo: every unknown body
    // gets the same static reply.
    configure({ sending: true });
    const res = await POST(inbound('</Message><Message>free money'));
    expect(await xml(res)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${EXPECTED_REPLY}</Message></Response>`
    );
  });
});

describe('escapeXml', () => {
  it('escapes the three characters that break element content, and no more', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    // Quotes are attribute-only concerns. Escaping them here was valid but turned every
    // apostrophe in our copy into `&apos;` on the wire for no reason.
    expect(escapeXml(`it's "fine"`)).toBe(`it's "fine"`);
  });

  it('makes §2.6\'s confirmation copy safe to put in a TwiML <Message>', () => {
    // The concrete trap: "Msg&data rates may apply" is a bare ampersand in approved copy. Nothing
    // routes that template through this response today; the first thing that does must not
    // discover this the hard way.
    const confirm = renderConfirmRequestMessage('Vancouver').body;
    expect(confirm).toContain('Msg&data');
    expect(escapeXml(confirm)).toContain('Msg&amp;data');
    expect(escapeXml(confirm)).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The round-1 paths this reply must NOT leak into
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/sms/inbound — the early returns still return nothing', () => {
  it('rejects a request with no signature header, and one with a wrong signature', async () => {
    // The signature check is the first thing that happens because this URL is public and mutates
    // consent: anyone who learned it could otherwise POST Body=STOP and unsubscribe a stranger.
    // The body here classifies as `unknown`, so an unverified caller must not be able to make our
    // number send a message either.
    configure({ sending: true });

    const missing = await POST(
      new Request(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: FROM, Body: 'hi there' }).toString(),
      })
    );
    expect(missing.status).toBe(403);
    expect(await xml(missing)).not.toContain('<Message>');

    const wrong = await POST(signed({ From: FROM, Body: 'hi there' }, { signature: 'nope' }));
    expect(wrong.status).toBe(403);
    expect(await xml(wrong)).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('fails CLOSED when TWILIO_AUTH_TOKEN is unset — an unconfigured environment trusts nothing', async () => {
    vi.stubEnv('SMS_WEBHOOK_PUBLIC_URL', URL);
    vi.stubEnv('SMS_SENDING_ENABLED', 'true');
    const res = await POST(inbound('hi there'));
    expect(res.status).toBe(403);
    expect(await xml(res)).not.toContain('<Message>');
  });

  it('says nothing to a signed request with no From, even though the body is unknown', async () => {
    // Twilio always sends From. Signed-but-malformed is nothing to act on — and specifically
    // nothing to REPLY to, since there is no number to reply to. This is the path the new reply
    // most plausibly could have leaked into: the body classifies as `unknown` long before the
    // From check runs.
    configure({ sending: true });
    const res = await POST(signed({ To: '+18778357776', Body: 'hi there' }));
    expect(res.status).toBe(200);
    expect(await xml(res)).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('413s an oversized body without replying, before the signature check', async () => {
    configure({ sending: true });
    const huge = new URLSearchParams({ From: FROM, Body: 'x'.repeat(MAX_INBOUND_PAYLOAD_BYTES) });
    const res = await POST(
      new Request(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: huge.toString(),
      })
    );
    expect(res.status).toBe(413);
    expect(await xml(res)).not.toContain('<Message>');
  });
});
