// tests/sms/inbound_route.test.ts
//
// NOTE (2026-09-01): the signup URL in these fixtures is /sms/start, not /sms/signup. signupUrl()
// was retargeted when /sms/start became the primary landing page — /sms/signup still 308s there,
// but a link WE compose into an SMS body should not spend a redirect hop. These assertions are
// unchanged in intent: the reply must carry the signup link the product actually builds. — POST /api/sms/inbound, the Twilio inbound webhook.
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
import {
  POST,
  MAX_INBOUND_PAYLOAD_BYTES,
  escapeXml,
  startReplyFor,
} from '@/app/api/sms/inbound/route';
import {
  renderConfirmRequestMessage,
  renderStartSignupInviteMessage,
} from '@/lib/sms/message';
import { smsSendingEnabled, stagingReplyBodyAllowed } from '@/lib/sms/config';
import type { TransitionOutcome } from '@/lib/sms/consent-transitions';
import { renderUnknownKeywordMessage, assertGsm7Safe, estimateSegments } from '@/lib/sms/message';

// ═══ THE UNIT LANE DOES NOT TOUCH A DATABASE ═══
// Stage A made the consent seams real: they now issue actual SQL through lib/db/client. This file
// tests decisions and wiring, not persistence, so the db seam is mocked to an empty result — which
// restores exactly the "finds nothing" world these tests were written against, honestly and
// without a connection. The real seams are covered in tests/sms/start_persistence-db.test.ts,
// which runs in the `db` lane. That split is the convention vitest.workspace.ts documents.
vi.mock('@/lib/db/client', () => ({
  query: async () => [],
  getPool: () => {
    throw new Error('the unit lane must not open a pool');
  },
}));


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

const EXPECTED_REPLY = renderUnknownKeywordMessage('https://kidsfun.example/sms/start').body;

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
    const body = renderUnknownKeywordMessage('https://kidsfun.example/sms/start').body;
    expect(body).toContain('Reply JOIN');
    expect(body).toContain('HELP');
    expect(body).toContain('STOP');
    expect(body).not.toContain('START');
  });

  it('carries the signup link, so following its advice cannot lead to a second silence', () => {
    // Somebody who texts us cold has no sms_consent row: if they reply JOIN the transition
    // answers `no_such_subscriber` and the webhook says nothing at all. The link is the only
    // thing in this message that works for a person who has never signed up.
    expect(EXPECTED_REPLY).toContain('https://kidsfun.example/sms/start');
  });

  it('passes the GSM-7 guard and fits one segment at the REAL production URL', () => {
    // Also on the all-templates wall in tests/sms/weekly_send.test.ts.
    assertGsm7Safe(EXPECTED_REPLY);
    // MEASURED AT THE DOMAIN THAT ACTUALLY SHIPS. The prior version of this test measured
    // `kidsfun.ca`; production is `kidsfunapp.ca`, three characters longer. That difference is
    // small and it is exactly the kind of thing that turns a 1-segment message into a 2-segment
    // one, so the assertion now names the real host.
    const live = renderUnknownKeywordMessage('https://kidsfunapp.ca/sms/start');
    expect(live.encoding).toBe('GSM-7');
    // 151, not 152: /sms/start is one character shorter than /sms/signup. Pinned EXACTLY
    // rather than as '<= 160' — the point of this assertion is that a copy change has to
    // come and move the number on purpose, which is how the budget stays visible.
    expect(live.characters).toBe(151);
    expect(live.segments).toBe(1);
    // 9 characters of headroom now, up from 8 — the /sms/start retarget bought one back.
    expect(160 - live.characters).toBe(9);
    // The shorter apex domain also fits, with more room, if it is ever used instead.
    expect(renderUnknownKeywordMessage('https://kidsfun.ca/sms/start').segments).toBe(1);
  });

  it('⚠ NO LONGER says what KIDS FUN is inline — Jon chose the acknowledgement instead', () => {
    // ═══ THIS REVERSES A V1 TESTING FINDING, DELIBERATELY, AND THE TRADE IS FORCED ═══
    // V1 found this message told a stranger what to TYPE without saying what they would be
    // signing up FOR, so round 21 added "We text weekly kid activity picks". PRD v3.11's approved
    // wording does not contain that clause — it spends the room on the acknowledgement instead.
    //
    // BOTH DO NOT FIT: the two clauses together measure 163 septets at the production URL — two
    // segments. That arithmetic is unchanged and is re-pinned below; what changed is which side of
    // it the product owner chose. This is a copy ruling, not a regression, and it is recorded here
    // rather than silently dropped so the V1 finding is not quietly lost.
    //
    // WHAT SOFTENS IT: the signup link is still present, so a stranger still has somewhere to go
    // to find out what this is — which was the V1 finding's actual concern.
    expect(EXPECTED_REPLY).not.toContain('We text weekly kid activity picks');
    // The START invite is UNAFFECTED and still carries the product description, so the clause has
    // not disappeared from the product — only from the message that could not afford both.
    expect(INVITE).toContain('We text weekly kid activity picks');
  });

  it('✅ acknowledges that it did not understand — PRD v3.11, restored', () => {
    // RESTORED 2026-08-28 after live testing found the delivered text had drifted off the approved
    // wording. This clause is the difference between a reply and a broadcast: it answers someone
    // whose message we did not understand by saying so first, rather than opening with what we do.
    expect(EXPECTED_REPLY).toContain("didn't catch that");
    expect(EXPECTED_REPLY).toContain('Reply JOIN to confirm your signup');
    // THE TRADE THAT FORCES THE CHOICE, re-pinned unchanged: both clauses together are 2 segments.
    // The earlier decision dropped this one to keep the product clause; v3.11 goes the other way.
    // Either is defensible; having both is not available.
    const withBoth =
      "KIDS FUN: We text weekly kid activity picks. Sorry, we didn't catch that - reply JOIN to " +
      'confirm, HELP for info, or STOP to end. Not signed up? https://kidsfun.ca/sms/start';
    expect(estimateSegments(withBoth).segments).toBe(2);
  });

  it('drops the signup clause rather than printing a placeholder', () => {
    const bare = renderUnknownKeywordMessage(null).body;
    expect(bare).not.toContain('Not signed up?');
    expect(bare).not.toContain('null');
    expect(bare.endsWith('or STOP to end.')).toBe(true);
    assertGsm7Safe(bare);
  });

  it('uses straight punctuation throughout — a curly apostrophe would triple the cost', () => {
    expect(EXPECTED_REPLY).not.toContain('\u2019');
    expect(EXPECTED_REPLY).not.toContain('\u2014');
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
      expect(await xml(res), typo).toContain('Reply JOIN to confirm');
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

  it('says NOTHING for join, stop or help — Twilio already answered those', async () => {
    // A second reply from us on a STOP would be a duplicate message on the one exchange a
    // carrier scrutinises most. JOIN answers with the welcome text, via the REST API.
    // START is the exception and has its own section below: PRD §2.1 door 2 requires a reply.
    configure({ sending: true });
    for (const keyword of ['JOIN', 'STOP', 'HELP', 'unsubscribe', 'info']) {
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

// ─────────────────────────────────────────────────────────────────────────────
// SMS_STAGING_ALLOW_REPLY_BODY — the local-harness reply-visibility flag
// ─────────────────────────────────────────────────────────────────────────────
//
// It changes ONE thing: whether this route emits the `<Message>` body it has already built, or an
// empty `<Response>`. It dispatches nothing, touches no transition, and cannot cause a Twilio API
// call. The flag exists because the reply text was invisible to the local testing harness — the
// same gate suppressing the send was suppressing the evidence — and a TwiML reply needs no
// credential and makes no API call, so the two are separable.
//
// 🔴 THE REASON IT IS A SEPARATE, DEFAULT-OFF, NEVER-SHIPPED FLAG: in the harness the response goes
// back to the agent that posted it. IN PRODUCTION the thing posting is TWILIO, and Twilio DELIVERS
// a `<Message>` body it receives. So this flag set in a real environment would send real texts
// while SMS_SENDING_ENABLED was false and an operator believed sending was off. The first describe
// below is the one that matters most: it pins that the production path is untouched when the flag
// is absent.

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

describe('with the flag UNSET, production behaviour is byte-identical to before', () => {
  it('an unknown keyword is still met with silence on a dry run', async () => {
    // SMS_SENDING_ENABLED unset (dry run) and SMS_STAGING_ALLOW_REPLY_BODY unset. This is the
    // exact assertion that existed before the flag, unchanged, and it must keep passing verbatim.
    configure(); // no sending, no staging flag
    const res = await POST(inbound('hi there'));
    expect(res.status).toBe(200);
    expect(await xml(res)).toBe(EMPTY_TWIML);
  });

  it('a START from an unknown number is still met with silence on a dry run', async () => {
    configure();
    const res = await POST(inbound('START'));
    expect(res.status).toBe(200);
    expect(await xml(res)).toBe(EMPTY_TWIML);
  });

  it('every keyword returns the identical empty document — no partial leakage', async () => {
    configure();
    for (const keyword of ['JOIN', 'STOP', 'START', 'HELP', 'hi there', '', '\u{1F44D}']) {
      expect(await xml(await POST(inbound(keyword))), keyword).toBe(EMPTY_TWIML);
    }
  });

  it('is off for every value that is not "true", and PARSES EXACTLY LIKE SMS_SENDING_ENABLED', async () => {
    // Not stricter and not more lenient than the flag it sits beside — a new flag that parsed its
    // input differently from the established one would be its own trap. Both go through the same
    // `env()` reader, which TRIMS, so ' true ' is a deliberate value with stray whitespace and is
    // accepted; everything else is off, and the failure direction is silence.
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', 'false', '']) {
      configure();
      vi.stubEnv('SMS_STAGING_ALLOW_REPLY_BODY', value);
      expect(await xml(await POST(inbound('hi there'))), JSON.stringify(value)).toBe(EMPTY_TWIML);
    }

    // The parity itself, asserted directly rather than described: whatever one flag makes of a
    // value, the other makes of it too.
    for (const value of ['true', ' true ', 'TRUE', '1', 'false', '']) {
      vi.unstubAllEnvs();
      vi.stubEnv('SMS_SENDING_ENABLED', value);
      vi.stubEnv('SMS_STAGING_ALLOW_REPLY_BODY', value);
      expect(stagingReplyBodyAllowed(), JSON.stringify(value)).toBe(smsSendingEnabled());
    }
  });
});

describe('with the flag SET, the harness can see the real reply', () => {
  function staging() {
    configure(); // SMS_SENDING_ENABLED still unset — sending stays off throughout
    vi.stubEnv('SMS_STAGING_ALLOW_REPLY_BODY', 'true');
  }

  it('returns the real unknown-keyword body, and SMS_SENDING_ENABLED stays off', async () => {
    staging();
    expect(smsSendingEnabled()).toBe(false); // the point of the whole exercise
    const res = await POST(inbound('hi there'));
    expect(res.status).toBe(200);
    expect(await xml(res)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${EXPECTED_REPLY}</Message></Response>`
    );
  });

  it('returns the real START invite body', async () => {
    staging();
    expect(await xml(await POST(inbound('START')))).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${INVITE}</Message></Response>`
    );
  });

  it('does NOT make the other keywords speak — it reveals, it does not create', async () => {
    // JOIN, STOP and HELP are silent by design (Twilio's Advanced Opt-Out already answered them;
    // JOIN answers with the welcome text via the REST API). The flag must not change which
    // branches reply, only whether an already-built body is emitted.
    staging();
    for (const keyword of ['JOIN', 'STOP', 'HELP', 'unsubscribe', 'info']) {
      expect(await xml(await POST(inbound(keyword))), keyword).toBe(EMPTY_TWIML);
    }
  });

  it('still refuses an unverified caller — the flag is not an auth bypass', async () => {
    staging();
    const bad = await POST(signed({ From: FROM, Body: 'hi there' }, { signature: 'nope' }));
    expect(bad.status).toBe(403);
    expect(await xml(bad)).not.toContain('<Message>');
  });

  it('still says nothing to a signed request with no From', async () => {
    staging();
    const res = await POST(signed({ To: '+18778357776', Body: 'hi there' }));
    expect(await xml(res)).toBe(EMPTY_TWIML);
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
// START — one door, three answers (PRD §2.1 door 2)
// ─────────────────────────────────────────────────────────────────────────────

const INVITE = renderStartSignupInviteMessage('https://kidsfun.example/sms/start').body;
const CONFIRM_AGAIN = renderConfirmRequestMessage(null).body;

describe('startReplyFor — the three-way mapping', () => {
  it('no_such_subscriber gets the signup link — this IS door 2', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfun.example');
    expect(startReplyFor('no_such_subscriber')).toBe(INVITE);
    expect(startReplyFor('no_such_subscriber')).toContain('https://kidsfun.example/sms/start');
  });

  it('awaiting_confirmation gets the confirmation request AGAIN, not new copy', () => {
    // PRD §2.1: "no automated nudge in MVP (resubmitting the form or texting START again both
    // work)". Texting START again is the thing that works, and this is what makes it work.
    expect(startReplyFor('awaiting_confirmation')).toBe(CONFIRM_AGAIN);
    expect(startReplyFor('awaiting_confirmation')).toContain('Reply JOIN to confirm');
    // Degraded by design: no area clause, because this reply does no database read.
    // Asserted against the ACTUAL clause, not against the substring " for " — that proxy broke
    // the moment Jon's approved copy added "or HELP for info.", which is a different " for ".
    expect(startReplyFor('awaiting_confirmation')).toContain('activity picks. Msg&data');
    expect(startReplyFor('awaiting_confirmation')).not.toMatch(/picks for /);
  });

  it('every other outcome is SILENT, and the guard is a positive test', () => {
    // So a future outcome is silent by default rather than accidentally texting somebody — the
    // same shape as confirmAndWelcome's `applied` guard.
    const silent: TransitionOutcome[] = [
      'already_in_state', // they are active; nothing happened and nothing needs saying
      'applied', // Twilio's Advanced Opt-Out already sent its own resubscribe confirmation
      'dry_run',
      'no_change',
      'error',
    ];
    for (const outcome of silent) expect(startReplyFor(outcome), outcome).toBeNull();
  });

  it('the two replies it does send are GSM-7 safe and one segment each', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfun.ca');
    const invite = renderStartSignupInviteMessage('https://kidsfun.ca/sms/start');
    assertGsm7Safe(invite.body);
    // 126 after the /sms/start retarget, same reasoning as the unknown-keyword pin above.
    expect(invite.characters).toBe(126);
    expect(invite.segments).toBe(1);
    const again = renderConfirmRequestMessage(null);
    assertGsm7Safe(again.body);
    expect(again.segments).toBe(1);
  });

  it('the invite says what the product IS before it asks for anything', () => {
    // The one message on this branch that can reach somebody with no record of us at all — a QR
    // code on a noticeboard. A bare link would assume they know what they nearly signed up for.
    expect(INVITE).toContain('weekly kid activity picks');
    expect(INVITE.startsWith('KIDS FUN:')).toBe(true);
    // No sms_consent row means no recorded consent of any kind: brand tag + free opt-out.
    expect(INVITE).toContain('Reply STOP to end');
  });

  it('shares ONE signup clause with the unknown-keyword reply', () => {
    // "Where do I sign up" must not have two different answers depending on which word the
    // person happened to text. Both messages are built from the same clause.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://kidsfun.example');
    const clause = 'Not signed up? https://kidsfun.example/sms/start';
    expect(INVITE).toContain(clause);
    expect(EXPECTED_REPLY).toContain(clause);
  });
});

describe('POST /api/sms/inbound — START end to end', () => {
  it('replies with the signup invite, because the lookup stub finds nothing', async () => {
    // findSubscriberByPhone is a draft stub returning null, so a signed START resolves to
    // `no_such_subscriber` — which is genuinely door 2's case, not a test artifact.
    configure({ sending: true });
    const res = await POST(inbound('START'));
    expect(res.status).toBe(200);
    expect(await xml(res)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${INVITE}</Message></Response>`
    );
  });

  it('answers the carrier ALIASES too, not just the literal word', async () => {
    // UNSTOP and YES classify as `start` (lib/sms/keywords.ts). A parent who texted YES because
    // some other service taught them to must land in the same place.
    configure({ sending: true });
    for (const alias of ['UNSTOP', 'yes', ' Start ']) {
      expect(await xml(await POST(inbound(alias))), alias).toContain('<Message>');
    }
  });

  it('says nothing on a dry run, even though the outcome is a read-only one', async () => {
    // `no_such_subscriber` is reported as itself even in a dry run (only `applied` is displaced),
    // so without the gate this branch WOULD have replied with sending disabled.
    configure(); // SMS_SENDING_ENABLED deliberately unset
    const res = await POST(inbound('START'));
    expect(await xml(res)).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('escapes the confirmation copy\'s bare "&" when that reply is the one sent', () => {
    // round 13 added escapeXml for a trap nobody had hit yet. This round hits it: the
    // `awaiting_confirmation` reply IS §2.6's confirmation request, which contains "Msg&data".
    expect(CONFIRM_AGAIN).toContain('Msg&data');
    expect(escapeXml(CONFIRM_AGAIN)).toContain('Msg&amp;data');
    expect(escapeXml(CONFIRM_AGAIN)).not.toMatch(/&(?!amp;|lt;|gt;)/);
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
