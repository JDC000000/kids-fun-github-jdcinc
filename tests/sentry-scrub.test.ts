import { describe, it, expect } from 'vitest';
import type { Event } from '@sentry/nextjs';

import {
  redactString,
  deepRedact,
  scrubEvent,
  EMAIL_MASK,
  IP_MASK,
  PHONE_MASK,
  POSTAL_MASK,
  CREDENTIAL_MASK,
} from '@/sentry.scrub';

// Fake, obviously-synthetic PII test values (never real). RFC-5737 / RFC-3849
// document-only IP ranges and example.com are used on purpose.
const FAKE_EMAIL = 'parent.guardian+booking@example.com';
const FAKE_IPV4 = '203.0.113.7';
const FAKE_IPV6 = '2001:db8:85a3::8a2e:370:7334';
const FAKE_PHONE_INTL = '+44 7911 123456';
const FAKE_PHONE_US = '(555) 123-4567';
// Synthetic Canadian postal codes (valid format, not a real address) — this
// product's most location-sensitive field (`user_profile.home_postal`).
const FAKE_POSTAL = 'V6B 4Y8';
const FAKE_POSTAL_NOSPACE = 'V6B4Y8';

describe('redactString', () => {
  it('masks an email address', () => {
    expect(redactString(`contact ${FAKE_EMAIL} now`)).toBe(`contact ${EMAIL_MASK} now`);
  });

  it('masks IPv4 and IPv6 addresses', () => {
    expect(redactString(`from ${FAKE_IPV4}`)).toBe(`from ${IP_MASK}`);
    expect(redactString(`from ${FAKE_IPV6}`)).toBe(`from ${IP_MASK}`);
  });

  it('masks phone-shaped numbers (international + grouped domestic)', () => {
    expect(redactString(`call ${FAKE_PHONE_INTL}`)).toBe(`call ${PHONE_MASK}`);
    expect(redactString(`call ${FAKE_PHONE_US}`)).toBe(`call ${PHONE_MASK}`);
  });

  it('masks a Canadian postal code (spaced and run-together, any casing)', () => {
    expect(redactString(`home ${FAKE_POSTAL} area`)).toBe(`home ${POSTAL_MASK} area`);
    expect(redactString(`home ${FAKE_POSTAL_NOSPACE} area`)).toBe(`home ${POSTAL_MASK} area`);
    expect(redactString('lives at v6b 4y8')).toBe(`lives at ${POSTAL_MASK}`);
    // dash-separated variant is also covered by the optional [ -] separator.
    expect(redactString('postal T2X-1V4 noted')).toBe(`postal ${POSTAL_MASK} noted`);
  });

  it('masks several PII shapes in one string', () => {
    const out = redactString(`${FAKE_EMAIL} @ ${FAKE_IPV4} tel ${FAKE_PHONE_US} pc ${FAKE_POSTAL}`);
    expect(out).toBe(`${EMAIL_MASK} @ ${IP_MASK} tel ${PHONE_MASK} pc ${POSTAL_MASK}`);
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('203.0.113');
    expect(out).not.toContain('V6B 4Y8');
  });

  it('leaves ordinary strings and short numeric ids untouched', () => {
    expect(redactString('venue id 4821 near the park')).toBe('venue id 4821 near the park');
    expect(redactString('semantic version 14.2.35')).toBe('semantic version 14.2.35');
    expect(redactString('Search failed for "soft play"')).toBe('Search failed for "soft play"');
    // A bare FSA (3-char prefix, no local delivery unit) is NOT a full postal
    // code and must stay readable in region/debug strings.
    expect(redactString('region fsa V6B centroid')).toBe('region fsa V6B centroid');
  });

  it('is idempotent', () => {
    const once = redactString(`${FAKE_EMAIL} ${FAKE_IPV4} ${FAKE_POSTAL}`);
    expect(redactString(once)).toBe(once);
  });
});

describe('deepRedact', () => {
  it('redacts strings nested in objects and arrays', () => {
    const out = deepRedact({
      note: `reach me at ${FAKE_EMAIL}`,
      ips: [FAKE_IPV4, 'no ip here'],
      nested: { deeper: `ping ${FAKE_IPV4}` },
    }) as Record<string, unknown>;
    expect(out.note).toBe(`reach me at ${EMAIL_MASK}`);
    expect((out.ips as string[])[0]).toBe(IP_MASK);
    expect((out.nested as Record<string, unknown>).deeper).toBe(`ping ${IP_MASK}`);
  });

  it('drops deny-listed keys wholesale (email/phone/token/cookie/etc.)', () => {
    const out = deepRedact({
      email: FAKE_EMAIL,
      phone: FAKE_PHONE_US,
      token: 'abc.def.ghi',
      password: 'hunter2',
      cookie: 'sid=xyz',
      keep_this: 'ok',
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('email');
    expect(out).not.toHaveProperty('phone');
    expect(out).not.toHaveProperty('token');
    expect(out).not.toHaveProperty('password');
    expect(out).not.toHaveProperty('cookie');
    expect(out.keep_this).toBe('ok');
  });

  it("drops this product's PII keys (postal + child-age fields, F-2)", () => {
    const out = deepRedact({
      // exact live schema field names on user_profile…
      home_postal: FAKE_POSTAL,
      saved_child_ages: [3, 5, 84],
      // …plus the additive defense-in-depth aliases.
      postal: FAKE_POSTAL,
      postal_code: FAKE_POSTAL,
      child_ages: [4],
      dob: '2019-06-01',
      birthdate: '2019-06-01',
      keep_this: 'ok',
    }) as Record<string, unknown>;
    for (const denied of [
      'home_postal',
      'saved_child_ages',
      'postal',
      'postal_code',
      'child_ages',
      'dob',
      'birthdate',
    ]) {
      expect(out, `expected "${denied}" to be dropped`).not.toHaveProperty(denied);
    }
    expect(out.keep_this).toBe('ok');
    // Nothing PII survived anywhere in the serialized output.
    expect(JSON.stringify(out)).not.toContain('V6B');
    expect(JSON.stringify(out)).not.toContain('84');
  });
});

function baseEvent(): Event {
  return {
    message: `Booking failed for ${FAKE_EMAIL} from ${FAKE_IPV4}`,
    user: {
      id: 'usr_123',
      email: FAKE_EMAIL,
      ip_address: FAKE_IPV4,
      username: 'parent_jane',
    },
    request: {
      url: `https://kids-fun.example/account?email=${encodeURIComponent(FAKE_EMAIL)}`,
      query_string: `email=${FAKE_EMAIL}&region=leeds`,
      headers: {
        cookie: 'sb-access-token=secret; other=1',
        authorization: 'Bearer secret-token',
        'x-forwarded-for': FAKE_IPV4,
        'user-agent': `agent contacting ${FAKE_EMAIL}`,
        accept: 'text/html',
      },
      cookies: { 'sb-access-token': 'secret' },
      env: { REMOTE_ADDR: FAKE_IPV4, SERVER_NAME: 'edge-1' },
      data: { form: { email: FAKE_EMAIL, note: `call ${FAKE_PHONE_INTL}` } },
    },
    exception: {
      values: [{ type: 'Error', value: `duplicate signup: ${FAKE_EMAIL}` }],
    },
    breadcrumbs: [
      { message: `POST /account by ${FAKE_EMAIL}`, data: { ip: FAKE_IPV4, path: '/account' } },
    ],
    extra: {
      raw_body: `email=${FAKE_EMAIL}`,
      email: FAKE_EMAIL,
      alt_contact: `ipv6 ${FAKE_IPV6} or call ${FAKE_PHONE_US}`,
      attempt: 3,
    },
    tags: { route: '/account', reporter: FAKE_EMAIL },
    contexts: { extra_ctx: { last_ip: FAKE_IPV4 } },
  };
}

describe('scrubEvent', () => {
  it('does not leak any PII test value anywhere in the serialized event', () => {
    const scrubbed = scrubEvent(baseEvent());
    const json = JSON.stringify(scrubbed);
    for (const pii of [
      FAKE_EMAIL,
      'example.com',
      FAKE_IPV4,
      '203.0.113',
      'db8:85a3',
      'sb-access-token',
      'Bearer secret-token',
      '7911 123456',
      '555) 123-4567',
    ]) {
      expect(json, `expected "${pii}" to be scrubbed`).not.toContain(pii);
    }
  });

  it('keeps only a pseudonymous user id', () => {
    const scrubbed = scrubEvent(baseEvent());
    expect(scrubbed.user).toEqual({ id: 'usr_123' });
  });

  it('strips credential / IP headers but keeps benign ones', () => {
    const scrubbed = scrubEvent(baseEvent());
    const headers = scrubbed.request?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('cookie');
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('x-forwarded-for');
    expect(headers.accept).toBe('text/html');
    expect(headers['user-agent']).toBe(`agent contacting ${EMAIL_MASK}`);
  });

  it('drops cookies and REMOTE_ADDR from the request', () => {
    const scrubbed = scrubEvent(baseEvent());
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect((scrubbed.request?.env as Record<string, string>).REMOTE_ADDR).toBeUndefined();
    expect((scrubbed.request?.env as Record<string, string>).SERVER_NAME).toBe('edge-1');
  });

  it('redacts message, exception value and breadcrumbs', () => {
    const scrubbed = scrubEvent(baseEvent());
    expect(scrubbed.message).toBe(`Booking failed for ${EMAIL_MASK} from ${IP_MASK}`);
    expect(scrubbed.exception?.values?.[0].value).toBe(`duplicate signup: ${EMAIL_MASK}`);
    expect(scrubbed.breadcrumbs?.[0].message).toBe(`POST /account by ${EMAIL_MASK}`);
    // breadcrumb data `ip` is a deny key → dropped
    expect(scrubbed.breadcrumbs?.[0].data).not.toHaveProperty('ip');
    expect((scrubbed.breadcrumbs?.[0].data as Record<string, unknown>).path).toBe('/account');
  });

  it('preserves non-PII fields and structure', () => {
    const scrubbed = scrubEvent(baseEvent());
    expect((scrubbed.extra as Record<string, unknown>).attempt).toBe(3);
    expect((scrubbed.tags as Record<string, unknown>).route).toBe('/account');
    // `extra.email` (deny key) dropped; `extra.raw_body` (free-form) redacted
    expect(scrubbed.extra).not.toHaveProperty('email');
    expect((scrubbed.extra as Record<string, unknown>).raw_body).toBe(`email=${EMAIL_MASK}`);
  });

  it('is idempotent (scrubbing twice matches scrubbing once)', () => {
    const once = JSON.stringify(scrubEvent(baseEvent()));
    const twice = JSON.stringify(scrubEvent(scrubEvent(baseEvent())));
    expect(twice).toBe(once);
  });

  it('handles a minimal event with no PII containers', () => {
    const scrubbed = scrubEvent({ message: 'no pii here' } as Event);
    expect(scrubbed.message).toBe('no pii here');
  });

  it("scrubs this product's PII end-to-end (postal in message, deny-keys in extra)", () => {
    const scrubbed = scrubEvent({
      message: `geocode failed for ${FAKE_POSTAL}`,
      extra: {
        home_postal: FAKE_POSTAL,
        saved_child_ages: [3, 5, 84],
        note: `parent typed ${FAKE_POSTAL} into the box`,
        attempt: 2,
      },
    } as unknown as Event);
    expect(scrubbed.message).toBe(`geocode failed for ${POSTAL_MASK}`);
    const extra = scrubbed.extra as Record<string, unknown>;
    expect(extra).not.toHaveProperty('home_postal');
    expect(extra).not.toHaveProperty('saved_child_ages');
    expect(extra.note).toBe(`parent typed ${POSTAL_MASK} into the box`);
    expect(extra.attempt).toBe(2);
    // Belt and braces: no fragment of the postal survives anywhere.
    expect(JSON.stringify(scrubbed)).not.toContain('V6B');
  });

  it('redacts local-variable snapshots on stack frames but leaves source context', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  filename: 'app/account/actions.ts',
                  context_line: "  const email = form.get('email');",
                  vars: { email: FAKE_EMAIL, clientIp: FAKE_IPV4, count: 2 },
                },
              ],
            },
          },
        ],
      },
    } as unknown as Event;
    const scrubbed = scrubEvent(event);
    const frame = scrubbed.exception?.values?.[0].stacktrace?.frames?.[0];
    // vars.email is a deny key → dropped; clientIp value redacted; source kept.
    expect(frame?.vars).not.toHaveProperty('email');
    expect((frame?.vars as Record<string, unknown>).clientIp).toBe(IP_MASK);
    expect((frame?.vars as Record<string, unknown>).count).toBe(2);
    expect(frame?.context_line).toBe("  const email = form.get('email');");
  });

  it('redacts transaction span descriptions / data', () => {
    const txn = {
      type: 'transaction',
      spans: [{ description: `GET /account?email=${FAKE_EMAIL}`, data: { peer_ip: FAKE_IPV4 } }],
    } as unknown as Event;
    const scrubbed = scrubEvent(txn) as unknown as {
      spans: Array<{ description: string; data: Record<string, unknown> }>;
    };
    expect(scrubbed.spans[0].description).toBe(`GET /account?email=${EMAIL_MASK}`);
    expect(scrubbed.spans[0].data.peer_ip).toBe(IP_MASK);
  });
});

// 2026-09-24 — credentials in URLs. The admin console used to accept a shared secret as `?token=`
// (and an `x-admin-token` header); none of the PII shape patterns above match an opaque secret, so
// a captured error on such a request would have shipped it verbatim. The admin path is gone; these
// pin that the scrubber masks the NEXT one wherever a URL can appear on an event.
describe('credential query values and the retired admin header', () => {
  const SECRET = 'q9Zx7-legacy_secret.value';

  it('masks credential-named query values in a URL, keeping the key and the rest of the URL', () => {
    expect(redactString(`https://kidsfunapp.ca/admin/dashboard?token=${SECRET}&view=day`)).toBe(
      `https://kidsfunapp.ca/admin/dashboard?token=${CREDENTIAL_MASK}&view=day`
    );
    expect(redactString(`/admin/auth/callback?code=${SECRET}&next=%2Fadmin%2Fdashboard`)).toBe(
      `/admin/auth/callback?code=${CREDENTIAL_MASK}&next=%2Fadmin%2Fdashboard`
    );
    for (const key of ['secret', 'access_token', 'refresh_token', 'password', 'api_key', 'sig']) {
      expect(redactString(`/x?a=1&${key}=${SECRET}`), key).not.toContain(SECRET);
    }
  });

  it('masks a bare query_string (no leading "?"), as Sentry stores it', () => {
    expect(redactString(`token=${SECRET}&view=month`)).toBe(`token=${CREDENTIAL_MASK}&view=month`);
  });

  it('leaves non-credential params alone (no false positives on ordinary filters)', () => {
    const url = '/search?region=vancouver&age=5&view=day&tokenized=1&monkey=2';
    expect(redactString(url)).toBe(url);
  });

  it('scrubEvent masks the credential in request.url, query_string (string and pairs) and breadcrumbs, and strips x-admin-token', () => {
    const event = scrubEvent({
      request: {
        url: `https://kidsfunapp.ca/admin/sms-subscribers?token=${SECRET}`,
        query_string: [['token', SECRET], ['view', 'day']],
        headers: { 'x-admin-token': SECRET, 'user-agent': 'test' },
      },
      breadcrumbs: [{ category: 'navigation', data: { from: '/', to: `/admin/dashboard?token=${SECRET}` } }],
    } as unknown as Event);
    const json = JSON.stringify(event);
    expect(json).not.toContain(SECRET);
    expect((event.request?.headers as Record<string, string>)['x-admin-token']).toBeUndefined();
    expect(event.request?.query_string).toEqual([['token', CREDENTIAL_MASK], ['view', 'day']]);

    const asString = scrubEvent({ request: { query_string: `token=${SECRET}&view=day` } } as unknown as Event);
    expect(asString.request?.query_string).toBe(`token=${CREDENTIAL_MASK}&view=day`);
  });
});
