// tests/sms/click_through.test.ts — the weekly short link, from tap to redirect.
//
// Two layers, both here because they answer different questions:
//   • `resolveClickThrough` — the decision table, with the three database reads injected, so every
//     outcome and every "uncounted but still redirected" path is reachable without a database.
//   • GET /s/[shortId] — that the transport actually redirects, with the headers the click data
//     depends on.
//
// Tokens are minted with the REAL `encodeShortLink`, not hand-written, so a change to the token
// format breaks this suite rather than silently breaking production links.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeShortLink } from '@/lib/sms/short-link';
import {
  FALLBACK_DESTINATION,
  GONE_DESTINATION,
  activityPath,
  resolveClickThrough,
  type ClickThroughDeps,
  type SmsClickEvent,
} from '@/lib/sms/click-through';
import { GET } from '@/app/s/[shortId]/route';
import { renderToStaticMarkup } from 'react-dom/server';
import ActivityUnavailablePage from '@/app/activity-unavailable/page';
import {
  ACTIVITY_GONE_BODY,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_PHONE_E164,
} from '@/lib/sms/consent-copy';

const OCC_SHORT_REF = 5601;
const SUB_SHORT_REF = 42;
const OCCURRENCE_ID = '11111111-1111-1111-1111-111111111111';
const SUBSCRIBER_ID = '22222222-2222-2222-2222-222222222222';
const SEND_LOG_ID = '33333333-3333-3333-3333-333333333333';

function withSecret() {
  vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-short-link-secret');
}

function validToken(): string {
  return encodeShortLink(OCC_SHORT_REF, SUB_SHORT_REF);
}

/** Every read succeeds. Records the click events that were written. */
function wiredDeps(over: Partial<ClickThroughDeps> = {}) {
  const clicks: SmsClickEvent[] = [];
  const deps: ClickThroughDeps = {
    findOccurrenceIdByShortRef: async (ref) => (ref === OCC_SHORT_REF ? OCCURRENCE_ID : null),
    findSubscriberIdByShortRef: async (ref) => (ref === SUB_SHORT_REF ? SUBSCRIBER_ID : null),
    findSendLogIdForClick: async () => SEND_LOG_ID,
    recordClick: async (event) => {
      clicks.push(event);
    },
    ...over,
  };
  return { clicks, deps };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a valid token for a live activity', () => {
  it('redirects to the CANONICAL activity page and logs one direct click', async () => {
    withSecret();
    const { clicks, deps } = wiredDeps();
    const result = await resolveClickThrough(validToken(), deps);

    expect(result.outcome).toBe('redirect');
    // /activity/[id], not /preview/[id]: that route's own header calls itself the canonical,
    // shareable, SEO-canonical URL, and /preview/[id]'s metadata canonicalises AT it.
    expect(result.destination).toBe(`/activity/${OCCURRENCE_ID}`);
    expect(result.occurrenceId).toBe(OCCURRENCE_ID);
    expect(result.clickLogged).toBe(true);

    expect(clicks).toEqual([
      {
        subscriberId: SUBSCRIBER_ID,
        sendLogId: SEND_LOG_ID,
        occurrenceId: OCCURRENCE_ID,
        // Always 'direct' from this route. 'hub' comes from the preferences page, which does not
        // exist yet.
        linkOrigin: 'direct',
      },
    ]);
  });

  it('carries the subscriber from the TOKEN, so the click is attributable to one person', async () => {
    withSecret();
    const { clicks, deps } = wiredDeps({
      findSubscriberIdByShortRef: async (ref) => `subscriber-${ref}`,
    });
    await resolveClickThrough(encodeShortLink(OCC_SHORT_REF, 99), deps);
    expect(clicks[0].subscriberId).toBe('subscriber-99');
  });

  it('logs a repeat tap as a SECOND click — a click log, not a click flag', async () => {
    // Migration 0036 deliberately has no unique index on (send_log_id, occurrence_id): a parent
    // tapping the same pick twice is two taps.
    withSecret();
    const { clicks, deps } = wiredDeps();
    const token = validToken();
    await resolveClickThrough(token, deps);
    await resolveClickThrough(token, deps);
    expect(clicks).toHaveLength(2);
  });
});

describe('a token that does not verify', () => {
  it('fails closed to the fallback and logs NOTHING', async () => {
    withSecret();
    const token = validToken();

    const cases: Array<[string, string | null | undefined]> = [
      ['tampered checksum', `${token.slice(0, -1)}${token.at(-1) === 'a' ? 'b' : 'a'}`],
      ['too short', token.slice(1)],
      ['too long', `${token}x`],
      ['outside base62', `${token.slice(0, -1)}-`],
      ['empty', ''],
      ['garbage', 'not-a-token-at-all'],
      ['null', null],
      ['undefined', undefined],
      ['path traversal attempt', '../../etc/passwd'],
      ['sql-ish', "1' OR '1'='1"],
    ];

    for (const [label, token_] of cases) {
      const { clicks, deps } = wiredDeps();
      const result = await resolveClickThrough(token_, deps);
      expect(result.outcome, label).toBe('invalid_token');
      expect(result.destination, label).toBe(FALLBACK_DESTINATION);
      expect(result.occurrenceId, label).toBeNull();
      expect(result.clickLogged, label).toBe(false);
      expect(clicks, label).toEqual([]);
    }
  });

  it('answers IDENTICALLY for malformed and for a failed checksum', async () => {
    // An endpoint that distinguished them would confirm to a prober when they were one character
    // away, turning a 20-bit check into a guided search.
    withSecret();
    const token = validToken();
    const malformed = await resolveClickThrough('!!!!!!!!!!!!!', wiredDeps().deps);
    const tampered = await resolveClickThrough(
      `${token.slice(0, -1)}${token.at(-1) === 'a' ? 'b' : 'a'}`,
      wiredDeps().deps
    );
    expect(malformed).toEqual(tampered);
  });

  it('does not even attempt a lookup for an unverifiable token', async () => {
    withSecret();
    const findOccurrence = vi.fn(async () => OCCURRENCE_ID);
    await resolveClickThrough('bogus', { findOccurrenceIdByShortRef: findOccurrence });
    expect(findOccurrence).not.toHaveBeenCalled();
  });

  it('treats an unconfigured secret as unverifiable rather than erroring', async () => {
    // No SMS_SHORT_LINK_SECRET at all: decodeShortLink verifies nothing and returns null, so this
    // degrades to the fallback instead of throwing on a public endpoint.
    const result = await resolveClickThrough('7bQ2mX9pLa4Rd', wiredDeps().deps);
    expect(result.outcome).toBe('invalid_token');
  });
});

describe('a valid token whose activity is gone', () => {
  it('goes to its OWN interstitial and logs NO click — the schema makes that mandatory', async () => {
    // sms_click_event.occurrence_id is NOT NULL and FK-constrained to a live activity_occurrence
    // row, so there is literally no row to write. This is a schema fact, not a policy choice.
    withSecret();
    const { clicks, deps } = wiredDeps({ findOccurrenceIdByShortRef: async () => null });
    const result = await resolveClickThrough(validToken(), deps);

    expect(result.outcome).toBe('occurrence_gone');
    expect(result.destination).toBe(GONE_DESTINATION);
    expect(result.occurrenceId).toBeNull();
    expect(result.clickLogged).toBe(false);
    expect(clicks).toEqual([]);
  });

  it('goes somewhere DIFFERENT from an invalid token — and that is a deliberate tradeoff', async () => {
    // Round 6 sent both here because no "gone" page existed. Jon's §8 Q3 copy now gives this
    // outcome its own destination, which creates a validity ORACLE: a prober can tell "my forged
    // token passed the HMAC but named no live activity" from "it did not pass".
    //
    // Accepted, and reasoned through in GONE_DESTINATION's comment rather than assumed. The short
    // version: it does not COMPOUND (an HMAC over each payload independently — one verified
    // forgery makes the next no cheaper), and the alternative was telling a parent whose link a
    // messaging app mangled that an activity had been CANCELLED when nothing had.
    withSecret();
    const gone = await resolveClickThrough(
      validToken(),
      wiredDeps({ findOccurrenceIdByShortRef: async () => null }).deps
    );
    const invalid = await resolveClickThrough('bogus', wiredDeps().deps);
    expect(gone.outcome).not.toBe(invalid.outcome);
    expect(gone.destination).toBe(GONE_DESTINATION);
    expect(invalid.destination).toBe(FALLBACK_DESTINATION);
    expect(gone.destination).not.toBe(invalid.destination);
  });

  it('STILL does not distinguish malformed from checksum-failed — round 6\'s actual concern', async () => {
    // The property that mattered is unchanged: inside the space of FAILING tokens there is no
    // "warmer/colder" signal, so a prober still learns nothing about how close they were.
    withSecret();
    const token = validToken();
    const malformed = await resolveClickThrough('!!!!!!!!!!!!!', wiredDeps().deps);
    const tampered = await resolveClickThrough(
      `${token.slice(0, -1)}${token.at(-1) === 'a' ? 'b' : 'a'}`,
      wiredDeps().deps
    );
    expect(malformed).toEqual(tampered);
  });

  it('treats a failed occurrence READ the same way — with a known, flagged cost', async () => {
    // A database outage therefore tells a handful of parents an activity was cancelled when it was
    // not. The alternative is a bare error page, which is worse for them and no more truthful.
    // Named in click-through.ts and in the round-9 notes rather than left to be discovered.
    withSecret();
    const { deps } = wiredDeps({
      findOccurrenceIdByShortRef: async () => {
        throw new Error('connection terminated');
      },
    });
    const result = await resolveClickThrough(validToken(), deps);
    expect(result.outcome).toBe('occurrence_gone');
    expect(result.destination).toBe(GONE_DESTINATION);
  });
});

describe('the redirect NEVER depends on the logging', () => {
  const uncountable: Array<[string, Partial<ClickThroughDeps>]> = [
    ['the subscriber row was deleted (90-day purge)', { findSubscriberIdByShortRef: async () => null }],
    ['no matching send log (e.g. a dry-run send)', { findSendLogIdForClick: async () => null }],
    [
      'the subscriber lookup threw',
      {
        findSubscriberIdByShortRef: async () => {
          throw new Error('connection terminated');
        },
      },
    ],
    [
      'the insert itself failed',
      {
        recordClick: async () => {
          throw new Error('deadlock detected');
        },
      },
    ],
  ];

  it('still sends the parent to their activity in every uncountable case', async () => {
    withSecret();
    for (const [label, over] of uncountable) {
      const result = await resolveClickThrough(validToken(), wiredDeps(over).deps);
      expect(result.outcome, label).toBe('redirect');
      expect(result.destination, label).toBe(activityPath(OCCURRENCE_ID));
      // Reported honestly rather than pretended.
      expect(result.clickLogged, label).toBe(false);
    }
  });
});

describe('nothing about the subscriber ever leaves the resolver', () => {
  it('returns only an outcome, a path, an occurrence id and a boolean', async () => {
    // The destination becomes a Location header, which is written into browser history, sent as a
    // Referer to the destination, and logged by every proxy in between.
    withSecret();
    const result = await resolveClickThrough(validToken(), wiredDeps().deps);
    expect(Object.keys(result).sort()).toEqual([
      'clickLogged',
      'destination',
      'occurrenceId',
      'outcome',
    ]);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(SUBSCRIBER_ID);
    expect(serialised).not.toContain(SEND_LOG_ID);
    expect(serialised).not.toContain(String(SUB_SHORT_REF));
  });

  it('never puts the token itself in the destination', async () => {
    withSecret();
    const token = validToken();
    for (const t of [token, 'bogus']) {
      const result = await resolveClickThrough(t, wiredDeps().deps);
      expect(result.destination).not.toContain(t);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────

function get(shortId: string): Promise<Response> {
  return GET(new Request(`https://kidsfun.example/s/${encodeURIComponent(shortId)}`), {
    params: { shortId },
  });
}

describe('GET /s/[shortId]', () => {
  it('307s with the unwired stubs — never 500s, never leaks', async () => {
    // The default seams read nothing, so a well-formed token resolves to occurrence_gone and lands
    // on the interstitial. What matters at this layer is that a public, unauthenticated endpoint
    // cannot do anything worse.
    withSecret();
    const res = await get(validToken());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://kidsfun.example/activity-unavailable');
    expect(await res.text()).toBe(''); // no body, no stack trace, no echo of the input
  });

  it('sets no-store, because a cached redirect would silently stop counting taps', async () => {
    // THE HEADER THAT PROTECTS THE CLICK DATA. One cached redirect and every subsequent tap on
    // that link goes straight to the target without ever reaching this route.
    withSecret();
    const res = await get(validToken());
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('is NEVER a permanent redirect', async () => {
    // 301/308 are cached by browsers and intermediaries indefinitely — repeat taps would vanish
    // from sms_click_event, and the mapping is per-subscriber and can be archived tomorrow.
    withSecret();
    const res = await get(validToken());
    expect([301, 308]).not.toContain(res.status);
  });

  it('survives hostile path segments without erroring or echoing them', async () => {
    withSecret();
    for (const hostile of [
      '../../../etc/passwd',
      '<script>alert(1)</script>',
      "'; DROP TABLE sms_click_event; --",
      '%00',
      'a'.repeat(4096),
    ]) {
      const res = await get(hostile);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://kidsfun.example/search');
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('script');
      expect(location).not.toContain('DROP TABLE');
    }
  });

  it('redirects on the REQUEST origin, not a configured one', async () => {
    // Reached from a text message, possibly on a preview or staging host. Bouncing a parent to the
    // production domain mid-tap would be surprising and would lose the click.
    withSecret();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://production.example');
    const token = validToken();
    const res = await GET(new Request(`https://staging.example/s/${token}`), {
      params: { shortId: token },
    });
    expect(res.headers.get('location')).toBe('https://staging.example/activity-unavailable');
  });
});

describe('the interstitial the "gone" outcome redirects to', () => {
  const html = renderToStaticMarkup(<ActivityUnavailablePage />);

  it("renders Jon's copy verbatim", () => {
    // react-dom/server escapes the apostrophe in "that's".
    expect(html).toContain(ACTIVITY_GONE_BODY.replace(/'/g, '&#x27;'));
  });

  it('gives "let me know if you have any other questions" somewhere to be let known', () => {
    expect(html).toContain(`tel:${SUPPORT_PHONE_E164}`);
    expect(html).toContain(SUPPORT_PHONE_DISPLAY);
  });

  it('carries NO identifier — not the occurrence, not the subscriber, not the token', () => {
    // The redirect deliberately passes nothing, and this page must not invent anything either:
    // its URL lands in browser history and must not record WHICH activity was gone for WHOM.
    expect(html).not.toContain(OCCURRENCE_ID);
    expect(html).not.toContain(SUBSCRIBER_ID);
    expect(html).not.toMatch(/short_?ref/i);
    expect(html).not.toContain('?');
  });

  it('offers the one useful next step', () => {
    expect(html).toContain('href="/search"');
  });
});
