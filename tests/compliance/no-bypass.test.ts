// tests/compliance/no-bypass.test.ts — G-T35-2 (Round 18 / Task Z, ‹L3›).
//
// Compliance guardrail: NO live adapter performs a login / paywall / checkout /
// CAPTCHA bypass. This is verified two ways against the *real* adapter code
// (not mocks that could paper over a bypass):
//
//   (A) Behavioural — the two adapters that actually reach the network (library
//       RSS, city-calendar Trumba) are driven with a spied global fetch, and the
//       real outgoing request is inspected: it must be a single credential-free
//       GET (no Authorization/Cookie header, no body, no credentials:include),
//       carrying only an identified bot User-Agent — never a browser spoof.
//       The fixture-only rec-portal scaffolds (ActiveNet, PerfectMind — the
//       BLOCKED T7/T8 sources) must make ZERO network requests at all.
//
//   (B) Structural — every adapter's source file is read from disk, its comments
//       are stripped (so the "no login / CAPTCHA" *comments* can't mask real
//       code), and the remaining CODE is scanned for bypass fingerprints:
//       password/credential auth, Authorization/Cookie headers, credentials:
//       include, mutating HTTP methods, headless-browser navigation
//       (puppeteer/playwright/page.*), checkout/cart flows, and anti-forgery
//       token submission. None may appear.
//
// See docs/source-register.md for the terms/robots classification these tests
// back up. If a future task wires a live rec-portal adapter (ActiveNet /
// PerfectMind), THIS test is the tripwire that must be revisited first.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LibraryAdapter, LIBRARY_SYSTEMS } from '../../worker/adapters/library';
import { CityCalendarAdapter, CITY_CALENDARS } from '../../worker/adapters/citycalendar';
import { ActiveNetAdapter, ACTIVENET_TENANTS } from '../../worker/adapters/activenet';
import { PerfectMindAdapter, PERFECTMIND_TENANTS } from '../../worker/adapters/perfectmind';
import { VenueAdapter, getVenue } from '../../worker/adapters/venue';
import type { Adapter } from '../../worker/core/adapter';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

// ── request-capture helpers ──────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  init: (RequestInit & { credentials?: string }) | undefined;
}

function mockFetchCapture(body: string, contentType: string): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init?: unknown) => {
    calls.push({ url: String(input), init: init as CapturedCall['init'] });
    return new Response(body, { status: 200, headers: { 'content-type': contentType } });
  }) as typeof fetch);
  return calls;
}

function headerLookup(init: CapturedCall['init'], name: string): string | undefined {
  const h = (init?.headers ?? {}) as Record<string, string> | Headers;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? rec[key] : undefined;
}

/** Assert a captured request is a read-only, credential-free, identified GET. */
function expectCredentialFreeGet(call: CapturedCall): void {
  const method = (call.init?.method ?? 'GET').toString().toUpperCase();
  expect(method, 'HTTP method must be a read-only GET (never a POST/login/checkout)').toBe('GET');
  expect(call.init?.body ?? null, 'request must carry no body (no form/credential submission)').toBeNull();
  expect(headerLookup(call.init, 'authorization'), 'no Authorization header').toBeUndefined();
  expect(headerLookup(call.init, 'cookie'), 'no Cookie header (no session replay)').toBeUndefined();
  expect(call.init?.credentials, "no credentials:'include'").not.toBe('include');

  const ua = headerLookup(call.init, 'user-agent');
  expect(ua, 'request carries an identified User-Agent').toBeTruthy();
  expect(ua).toMatch(/KidsFunBot/i);
  expect(ua, 'identified bot UA, not a browser spoof').not.toMatch(/Mozilla/i);
}

// ── (A) behavioural: what the real adapter code actually sends ────────────────

describe('G-T35-2 (A) live adapters issue only credential-free read-only GETs', () => {
  it('library RSS (VPL) — single GET, no login/cookie/body', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl';
    const vpl = LIBRARY_SYSTEMS.find((s) => s.systemKey === 'vpl');
    expect(vpl, 'VPL system present in registry').toBeTruthy();
    const adapter = new LibraryAdapter(vpl!);
    expect(adapter.isLiveFetchEnabled?.()).toBe(true);

    const calls = mockFetchCapture('<?xml version="1.0"?><rss><channel></channel></rss>', 'application/xml');
    await adapter.fetch();

    expect(calls.length, 'exactly one paginated GET per fetch').toBe(1);
    expectCredentialFreeGet(calls[0]);
    // Must be the ToS-permitted RSS/XML feed PATH specifically, not merely the
    // gateway host. The prohibited JSON gateway (`…/v2/libraries/<slug>/events`)
    // lives on the SAME host, so asserting only `gateway.bibliocommons.com` would
    // let a silent regression back onto the JSON gateway pass. Pin the `/rss/`
    // events segment so only the RSS feed satisfies this tripwire.
    expect(calls[0].url).toMatch(/gateway\.bibliocommons\.com\/v2\/libraries\/[^/]+\/rss\/events/);
    expect(calls[0].url).not.toMatch(/login|signin|account|checkout|cart/i);
  });

  it('city calendar (Vancouver Trumba) — single GET, no login/cookie/body', async () => {
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    const van = CITY_CALENDARS.find((c) => c.calendarKey === 'vancouver');
    expect(van, 'Vancouver calendar present in registry').toBeTruthy();
    const adapter = new CityCalendarAdapter(van!);
    expect(adapter.isLiveFetchEnabled?.()).toBe(true);

    const calls = mockFetchCapture('[]', 'application/json');
    await adapter.fetch();

    expect(calls.length, 'exactly one GET per fetch').toBe(1);
    expectCredentialFreeGet(calls[0]);
    expect(calls[0].url).toMatch(/trumba\.com/);
    expect(calls[0].url).not.toMatch(/login|signin|account|checkout|cart/i);
  });
});

describe('G-T11 venue adapter — live GETs are credential-free; fixture-only venues never touch the network', () => {
  it('live-capable venue (Space Centre) issues one credential-free GET per configured page', async () => {
    process.env.KIDS_FUN_LIVE_VENUES = 'hr-macmillan-space-centre';
    const config = getVenue('hr-macmillan-space-centre');
    expect(config, 'Space Centre present in venue registry').toBeTruthy();
    const adapter = new VenueAdapter(config!);
    expect(adapter.isLiveFetchEnabled()).toBe(true);

    const calls = mockFetchCapture(
      '<html><head><script type="application/ld+json">{"@type":["EntertainmentBusiness"],"openingHours":["Mo-Su 09:00-17:00"]}</script></head><body></body></html>',
      'text/html'
    );
    await adapter.fetch();

    // Space Centre wires only the schema.org open-hours page (no events page) — one GET.
    expect(calls.length, 'one GET per configured venue page').toBe(1);
    for (const c of calls) expectCredentialFreeGet(c);
    expect(calls[0].url).toMatch(/spacecentre\.ca/);
    expect(calls[0].url).not.toMatch(/login|signin|account|checkout|cart/i);
  });

  it('fixture-only venue (Vancouver Aquarium, Akamai-blocked) makes ZERO network calls even if env-enabled', async () => {
    // vanaqua.org actively blocks bots; the adapter must never live-fetch it,
    // regardless of the env allow-list, because it is not marked liveCapable.
    process.env.KIDS_FUN_LIVE_VENUES = 'vancouver-aquarium';
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new VenueAdapter(getVenue('vancouver-aquarium')!);
    expect(adapter.isLiveFetchEnabled(), 'never live').toBe(false);
    const raw = await adapter.fetch();
    expect(Array.isArray(raw)).toBe(true);
    expect(spy, 'Aquarium fetch() made no network request').not.toHaveBeenCalled();
  });
});

describe('G-T35-2 (A) fixture-only rec-portal scaffolds make ZERO network calls', () => {
  // ActiveNet + PerfectMind are the BLOCKED T7/T8 rec-portal sources: terms_status
  // 'pending', no live wiring. They must never touch the network — proving there
  // is no headless login/render path even latently present.
  it('ActiveNet adapter performs no fetch and never reports live', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter: Adapter = new ActiveNetAdapter(ACTIVENET_TENANTS[0]);
    expect(adapter.isLiveFetchEnabled?.() ?? false, 'never live').toBe(false);
    const raw = await adapter.fetch();
    expect(Array.isArray(raw)).toBe(true);
    expect(spy, 'ActiveNet fetch() made no network request').not.toHaveBeenCalled();
  });

  it('PerfectMind adapter performs no fetch and never reports live', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter: Adapter = new PerfectMindAdapter(PERFECTMIND_TENANTS[0]);
    expect(adapter.isLiveFetchEnabled?.() ?? false, 'never live').toBe(false);
    const raw = await adapter.fetch();
    expect(Array.isArray(raw)).toBe(true);
    expect(spy, 'PerfectMind fetch() made no network request').not.toHaveBeenCalled();
  });
});

// ── (B) structural: scan the real adapter source for bypass fingerprints ──────

/** Strip block + line comments, preserving `https://` URLs inside string literals
 *  (the `//` after a `:` is never treated as a line-comment start). Guarantees the
 *  scan can only ever miss a bypass, never false-positive on an explanatory comment
 *  such as "no login / CAPTCHA bypass" or a `puppeteer-core` runtime note. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const ADAPTER_SOURCES = [
  'worker/adapters/library/index.ts',
  'worker/adapters/library/config.ts',
  'worker/adapters/citycalendar/index.ts',
  'worker/adapters/citycalendar/config.ts',
  'worker/adapters/activenet/index.ts',
  'worker/adapters/activenet/config.ts',
  'worker/adapters/perfectmind/index.ts',
  'worker/adapters/perfectmind/config.ts',
  'worker/adapters/venue/index.ts',
  'worker/adapters/venue/config.ts',
  'worker/adapters/venue/separate.ts',
];

// Fingerprints of an access-control bypass. Deliberately avoids tokens that appear
// legitimately as *source-data flags* the adapter merely reads (e.g. the library
// feed's `loginToRegister`, the Trumba feed's `requiresPayment`) — those describe
// the event, they are not the adapter authenticating or paying.
const BYPASS_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'CAPTCHA handling', re: /captcha/i },
  { label: 'password credential', re: /\bpassword\b/i },
  { label: 'Authorization header', re: /authorization\s*:/i },
  { label: 'Cookie/session header', re: /["']?cookie["']?\s*:/i },
  { label: "credentials:'include'", re: /credentials\s*:\s*['"]?include/i },
  { label: 'mutating HTTP method', re: /method\s*:\s*['"](post|put|patch|delete)['"]/i },
  { label: 'headless-browser navigation', re: /\bpage\.(goto|type|click|fill|waitForSelector|evaluate|setContent)\b/i },
  { label: 'headless-browser library', re: /\b(puppeteer|playwright)\b/i },
  { label: 'checkout/cart flow', re: /\b(checkout|add[_-]?to[_-]?cart)\b/i },
  { label: 'anti-forgery token submit', re: /(__requestverificationtoken|x-csrf-token|csrf[_-]?token)/i },
];

describe('G-T35-2 (B) adapter source contains no login/paywall/CAPTCHA-bypass code', () => {
  for (const rel of ADAPTER_SOURCES) {
    it(`${rel} is free of bypass fingerprints`, () => {
      const code = stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8'));
      for (const { label, re } of BYPASS_PATTERNS) {
        expect(re.test(code), `${rel} must not contain ${label}`).toBe(false);
      }
    });
  }

  it('only the ToS-cleared live adapters (library, city-calendar, venue) expose a live-fetch capability', () => {
    // library + citycalendar + venue implement isLiveFetchEnabled(); the rec-portal
    // scaffolds do not (they can never flip to live without new code + this test
    // being revisited).
    const liveLibrary = new LibraryAdapter(LIBRARY_SYSTEMS.find((s) => s.systemKey === 'vpl')!);
    const liveCity = new CityCalendarAdapter(CITY_CALENDARS[0]);
    const liveVenue = new VenueAdapter(getVenue('hr-macmillan-space-centre')!);
    const activenet = new ActiveNetAdapter(ACTIVENET_TENANTS[0]);
    const perfectmind = new PerfectMindAdapter(PERFECTMIND_TENANTS[0]);

    expect(typeof liveLibrary.isLiveFetchEnabled).toBe('function');
    expect(typeof liveCity.isLiveFetchEnabled).toBe('function');
    expect(typeof liveVenue.isLiveFetchEnabled).toBe('function');
    expect((activenet as { isLiveFetchEnabled?: unknown }).isLiveFetchEnabled).toBeUndefined();
    expect((perfectmind as { isLiveFetchEnabled?: unknown }).isLiveFetchEnabled).toBeUndefined();
  });
});
