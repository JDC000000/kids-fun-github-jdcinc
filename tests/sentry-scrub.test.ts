import { describe, it, expect } from 'vitest';
import type { Event } from '@sentry/nextjs';

import {
  redactString,
  deepRedact,
  scrubEvent,
  EMAIL_MASK,
  IP_MASK,
  PHONE_MASK,
} from '@/sentry.scrub';

// Fake, obviously-synthetic PII test values (never real). RFC-5737 / RFC-3849
// document-only IP ranges and example.com are used on purpose.
const FAKE_EMAIL = 'parent.guardian+booking@example.com';
const FAKE_IPV4 = '203.0.113.7';
const FAKE_IPV6 = '2001:db8:85a3::8a2e:370:7334';
const FAKE_PHONE_INTL = '+44 7911 123456';
const FAKE_PHONE_US = '(555) 123-4567';

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

  it('masks several PII shapes in one string', () => {
    const out = redactString(`${FAKE_EMAIL} @ ${FAKE_IPV4} tel ${FAKE_PHONE_US}`);
    expect(out).toBe(`${EMAIL_MASK} @ ${IP_MASK} tel ${PHONE_MASK}`);
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('203.0.113');
  });

  it('leaves ordinary strings and short numeric ids untouched', () => {
    expect(redactString('venue id 4821 near the park')).toBe('venue id 4821 near the park');
    expect(redactString('semantic version 14.2.35')).toBe('semantic version 14.2.35');
    expect(redactString('Search failed for "soft play"')).toBe('Search failed for "soft play"');
  });

  it('is idempotent', () => {
    const once = redactString(`${FAKE_EMAIL} ${FAKE_IPV4}`);
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
