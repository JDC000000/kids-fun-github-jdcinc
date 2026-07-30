// tests/compliance/no-bypass.test.ts — G-T35-2 (Round 18 / Task Z, ‹L3›),
// amended by G-T7R-0 (T7 REBUILD) for the read-only POST-search exception.
//
// Compliance guardrail: NO live adapter performs a login / paywall / checkout /
// CAPTCHA bypass. This is verified two ways against the *real* adapter code
// (not mocks that could paper over a bypass):
//
//   (A) Behavioural — the adapters that actually reach the network are driven with
//       a spied global fetch, and the real outgoing requests are inspected: they
//       must be credential-free (no Authorization/Cookie header, no
//       credentials:include), carrying only an identified bot User-Agent — never a
//       browser spoof. Every request must be a GET, with ONE named exception
//       (READ_ONLY_POST_SEARCH, below — host-scoped as well as path-scoped). Any
//       tenant/source not explicitly enabled
//       via its KIDS_FUN_LIVE_* env allow-list must make ZERO network requests.
//
//   (B) Structural — every adapter's source file is read from disk, its comments
//       are stripped (so the "no login / CAPTCHA" *comments* can't mask real
//       code), and the remaining CODE is scanned for bypass fingerprints:
//       password/credential auth, Authorization/Cookie headers, credentials:
//       include, mutating HTTP methods, headless-browser navigation
//       (puppeteer/playwright/page.*), checkout/cart flows, and anti-forgery
//       token submission. None may appear.
//
// ─────────────────────────────────────────────────────────────────────────────
// G-T7R-0 AMENDMENT — the ONE thing that moved, and why (decisions_register D-11).
//
// The ActiveCommunities rec-portal's internal JSON API answers its two SEARCH
// endpoints over POST — not because anything is mutated, but because the filter
// payload is a JSON object rather than a query string. They are POST-AS-QUERY
// READS. Live verification on 2026-07-30 established that NOTHING ELSE about the
// prohibition list needs to change: the portal answers with no cookie, no session,
// no CSRF/anti-forgery token, no browser-spoofed User-Agent and no headless render.
//
// So exactly one prohibition is narrowed, by a NAMED allow-list keyed on adapter
// family + EXACT host + EXACT path (READ_ONLY_POST_SEARCH). Everything else stays banned for
// every adapter INCLUDING the allow-listed one:
//     Authorization header · Cookie header · credentials:'include' ·
//     PUT/PATCH/DELETE · headless navigation (puppeteer/playwright/page.*) ·
//     checkout/cart flows · anti-forgery token submission · browser-spoofed UA ·
//     CAPTCHA handling · password credentials
// and the ZERO-NETWORK assertion is retained for every source not explicitly
// enabled by its env allow-list.
//
// The amendment is itself tested: `describe('(C) tripwire self-check')` feeds
// synthetic snippets through the same scanners and asserts each bypass class is
// still caught — including inside an allow-listed family — and that a POST to a
// path OUTSIDE the allow-list still fails.
//
// Authority for the underlying access: decisions_register D-10 (Jon's direct,
// twice-stated, informed override of ACTIVE Network's Terms of Use prohibition on
// automated portal access). See docs/source-register.md §6.3, where the risk is
// recorded unsoftened. This test does not evaluate that decision; it enforces that
// the CODE stays within the narrow technical envelope the decision was made on.
// ─────────────────────────────────────────────────────────────────────────────
//
// See docs/source-register.md for the terms/robots classification these tests
// back up.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LibraryAdapter, LIBRARY_SYSTEMS } from '../../worker/adapters/library';
import { CityCalendarAdapter, CITY_CALENDARS } from '../../worker/adapters/citycalendar';
import { ActiveNetAdapter, ACTIVENET_TENANTS, getTenantConfig } from '../../worker/adapters/activenet';
import { PerfectMindAdapter, PERFECTMIND_TENANTS } from '../../worker/adapters/perfectmind';
import { VenueAdapter, getVenue } from '../../worker/adapters/venue';
import { clearPolicyState } from '../../worker/health/policy';
import type { Adapter } from '../../worker/core/adapter';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
  clearPolicyState();
});

// ── the ONE narrow exception (G-T7R-0 / D-11) ────────────────────────────────
//
// A read-only POST search is permitted ONLY for a family listed here, ONLY on an
// exact HOST listed here, ONLY on an exact path listed here, and ONLY from the
// files listed here. The list is deliberately declared in the TEST rather than
// imported from the adapter: a tripwire that reads its own allow-list from the
// code it polices can be widened by editing that code alone. Widening it must be
// an edit to this file.
//
// HOST-SCOPING (added by QA finding A1). D-10's authorisation is host-scoped: Jon
// overrode ACTIVE Network's Terms of Use for THIS portal, not for read-only POSTs
// against hosts in general. An earlier revision of this file matched on path alone,
// so repointing the adapter's host constant left this suite green while a lower-
// scrutiny adapter test caught it — exactly backwards for the file the project holds
// to the highest standard. The host is now pinned HERE, three ways:
//   1. behaviourally — every captured request from an allow-listed family must go to
//      an allow-listed hostname (GETs included, not just the POSTs);
//   2. in the POST check — host AND path must both match, on the SAME family entry;
//   3. structurally — the family's config must declare the pinned host literal, so
//      repointing that constant fails this file directly.
// Hostnames are matched EXACTLY (never endsWith), so `anc.ca.apm.activecommunities
// .com.attacker.example` does not satisfy it.

interface ReadOnlyPostSearchFamily {
  family: string;
  /** Repo-relative files the exception applies to. */
  sourceFiles: string[];
  /**
   * EXACT hostnames D-10 authorises for this family. The override is host-scoped;
   * this is the boundary, not a convenience.
   */
  hosts: string[];
  /**
   * The file that declares the host, and the literal it must contain — so the host
   * cannot be repointed without failing this suite.
   */
  hostConfigFile: string;
  /** EXACT paths that may be POSTed. Read-only searches; nothing is mutated. */
  postPaths: string[];
  /** Read paths the same files may GET. */
  getPaths: string[];
  /** Shape of an API endpoint path literal in these files, for the structural scan. */
  endpointPathPattern: RegExp;
}

const READ_ONLY_POST_SEARCH: ReadOnlyPostSearchFamily[] = [
  {
    family: 'activenet',
    sourceFiles: ['worker/adapters/activenet/client.ts'],
    hosts: ['anc.ca.apm.activecommunities.com'],
    hostConfigFile: 'worker/adapters/activenet/config.ts',
    postPaths: ['/onlinecalendar/filters', '/onlinecalendar/multicenter/events'],
    getPaths: ['/onlinecalendar/calendars', '/onlinecalendar/centerdetails'],
    endpointPathPattern: /\/onlinecalendar\/[A-Za-z0-9_\-/]+/g,
  },
];

const POST_ALLOWED_FILES = new Set(READ_ONLY_POST_SEARCH.flatMap((f) => f.sourceFiles));

/** Every hostname any allow-listed family may reach at all. */
const ALLOWED_HOSTS = new Set(READ_ONLY_POST_SEARCH.flatMap((f) => f.hosts));

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * True only when the hostname AND the path are both allow-listed, on the SAME family
 * entry — so one family's host can never license another family's path. Hostname is an
 * exact match; the path is a suffix match because the tenant's site path prefixes it
 * (`/vancouver/rest` + `/onlinecalendar/filters`).
 */
function isAllowedReadOnlyPost(url: string): boolean {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  const { pathname } = new URL(url);
  return READ_ONLY_POST_SEARCH.some(
    (f) => f.hosts.includes(hostname) && f.postPaths.some((p) => pathname.endsWith(p))
  );
}

/**
 * Every hostname a source file DECLARES, found two ways so a repoint cannot hide:
 *   (a) a quoted string that is itself a bare hostname  — 'anc.ca.apm.…com'
 *   (b) a hostname inside an absolute URL literal       — 'https://anc.ca.apm.…com/x'
 * Deliberately narrow: (a) is anchored on the quotes, so prose containing a dotted
 * word ("see docs/source-register.md §6.3") and dotted NON-hosts (a "26.9.53" version
 * stamp, a `t.dropInCalendarIds.length` expression) are not hostnames and do not match.
 */
function hostLiteralsIn(code: string): string[] {
  const hosts = new Set<string>();
  for (const m of code.matchAll(/['"`]([a-z0-9-]+(?:\.[a-z0-9-]+)+)['"`]/gi)) {
    // Require an alphabetic TLD so '26.9.53' is excluded, and drop bare filenames.
    if (/\.[a-z]{2,}$/i.test(m[1]) && !/\.(ts|tsx|js|json|sql|md|css|svg|png)$/i.test(m[1])) {
      hosts.add(m[1].toLowerCase());
    }
  }
  for (const m of code.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) {
    hosts.add(m[1].toLowerCase().replace(/\.$/, ''));
  }
  return [...hosts].sort();
}

/** Every request from an allow-listed family must stay on a D-10-authorised host. */
function expectAllowedHost(call: CapturedCall): void {
  const hostname = hostnameOf(call.url);
  expect(hostname, `unparseable request URL: ${call.url}`).not.toBeNull();
  expect(
    ALLOWED_HOSTS.has(hostname!),
    `${hostname} is not a D-10-authorised host — the override is host-scoped`
  ).toBe(true);
}

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

/** The credential/identity half of the contract — applies to EVERY request, GET or
 *  allow-listed POST. Nothing here was relaxed by G-T7R-0. */
function expectCredentialFree(call: CapturedCall): void {
  expect(headerLookup(call.init, 'authorization'), 'no Authorization header').toBeUndefined();
  expect(headerLookup(call.init, 'cookie'), 'no Cookie header (no session replay)').toBeUndefined();
  expect(call.init?.credentials, "no credentials:'include'").not.toBe('include');

  // No anti-forgery / CSRF token may be submitted, in a header or in a body.
  for (const name of Object.keys((call.init?.headers ?? {}) as Record<string, string>)) {
    expect(name, 'no anti-forgery/CSRF header').not.toMatch(/csrf|__requestverificationtoken/i);
  }
  const body = typeof call.init?.body === 'string' ? call.init.body : '';
  expect(body, 'no anti-forgery/CSRF token in the request body').not.toMatch(
    /csrf|__requestverificationtoken/i
  );

  const ua = headerLookup(call.init, 'user-agent');
  expect(ua, 'request carries an identified User-Agent').toBeTruthy();
  expect(ua).toMatch(/KidsFunBot/i);
  expect(ua, 'identified bot UA, not a browser spoof').not.toMatch(/Mozilla/i);
  expect(call.url).not.toMatch(/login|signin|account|checkout|cart/i);
}

/** Assert a captured request is a read-only, credential-free, identified GET. */
function expectCredentialFreeGet(call: CapturedCall): void {
  const method = (call.init?.method ?? 'GET').toString().toUpperCase();
  expect(method, 'HTTP method must be a read-only GET (never a POST/login/checkout)').toBe('GET');
  expect(call.init?.body ?? null, 'request must carry no body (no form/credential submission)').toBeNull();
  expectCredentialFree(call);
}

/**
 * Assert a captured request is EITHER a credential-free GET, OR a credential-free
 * POST to an exact READ_ONLY_POST_SEARCH host + path. This is the only assertion that
 * differs from expectCredentialFreeGet, and only for allow-listed families.
 *
 * The HOST is checked twice on purpose: once for every request regardless of method
 * (D-10 authorises a portal, not a technique), and again inside the POST branch bound
 * to the same family entry as the path.
 */
function expectReadOnlyRequest(call: CapturedCall): void {
  const method = (call.init?.method ?? 'GET').toString().toUpperCase();
  expect(['GET', 'POST'], 'only GET or an allow-listed read-only POST').toContain(method);
  expectAllowedHost(call);
  if (method === 'GET') {
    expect(call.init?.body ?? null, 'a GET carries no body').toBeNull();
  } else {
    expect(
      isAllowedReadOnlyPost(call.url),
      `POST ${call.url} is not an allow-listed READ_ONLY_POST_SEARCH host+path`
    ).toBe(true);
  }
  expectCredentialFree(call);
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

describe('G-T7R-0 (A) ActiveNet live path — credential-free reads on allow-listed paths only', () => {
  /** Drive the adapter under fake timers so the 3s politeness floor between requests
   *  costs virtual time, not wall-clock. The rate limiter itself is exercised for real. */
  async function driveActiveNet(tenantKey: string, calendarIds: number[]): Promise<CapturedCall[]> {
    process.env.KIDS_FUN_LIVE_ACTIVENET = tenantKey;
    const tenant = { ...getTenantConfig(tenantKey)!, dropInCalendarIds: calendarIds };
    const adapter = new ActiveNetAdapter(tenant);
    expect(adapter.isLiveFetchEnabled(), `${tenantKey} live-enabled by env`).toBe(true);

    const calls = mockFetchCapture(
      JSON.stringify({ headers: { response_code: '0000' }, body: { calendars: [], center: [], center_events: [], center_details: [] } }),
      'application/json'
    );
    vi.useFakeTimers();
    const pending = adapter.fetch();
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
    vi.useRealTimers();
    return calls;
  }

  it('every request is a credential-free GET or an allow-listed read-only POST', async () => {
    const calls = await driveActiveNet('vancouver', [5]);
    expect(calls.length, 'calendars + filters + events (no centres ⇒ no centerdetails)').toBeGreaterThan(0);
    for (const call of calls) expectReadOnlyRequest(call);
  });

  it('the POSTs it does make are EXACTLY the two named read-only searches', async () => {
    const calls = await driveActiveNet('vancouver', [5]);
    const posts = calls
      .filter((c) => (c.init?.method ?? 'GET').toString().toUpperCase() === 'POST')
      .map((c) => new URL(c.url).pathname);
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(
        ['/vancouver/rest/onlinecalendar/filters', '/vancouver/rest/onlinecalendar/multicenter/events']
      ).toContain(p);
    }
  });

  it('POST bodies are search filters — no credential, no token, no cart', async () => {
    const calls = await driveActiveNet('vancouver', [5]);
    for (const call of calls) {
      const body = typeof call.init?.body === 'string' ? call.init.body : '';
      if (!body) continue;
      expect(body).not.toMatch(/password|username|token|session|cart|checkout/i);
      expect(() => JSON.parse(body), 'the POST body is a plain JSON filter object').not.toThrow();
      expect(Object.keys(JSON.parse(body))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(calendar_id|center_ids|start_date)$/)])
      );
    }
  });

  it('Burnaby behaves identically — the exception is per family, not per tenant', async () => {
    const calls = await driveActiveNet('burnaby', [1]);
    for (const call of calls) expectReadOnlyRequest(call);
  });
});

describe('G-T7R-0 (A) sources NOT explicitly enabled make ZERO network calls', () => {
  // The zero-network assertion is RETAINED, and is now the load-bearing default: a
  // tenant is fixture-only until its env allow-list names it. This is what keeps the
  // read-only-POST exception from becoming a general licence to fetch.
  it('ActiveNet with no env allow-list performs no fetch and reports not-live', async () => {
    delete process.env.KIDS_FUN_LIVE_ACTIVENET;
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const tenant of ACTIVENET_TENANTS) {
      const adapter: Adapter = new ActiveNetAdapter(tenant);
      expect(adapter.isLiveFetchEnabled?.() ?? false, `${tenant.tenantKey} never live`).toBe(false);
      const raw = await adapter.fetch();
      expect(Array.isArray(raw)).toBe(true);
    }
    expect(spy, 'ActiveNet fetch() made no network request').not.toHaveBeenCalled();
  });

  it('an ActiveNet tenant NOT named in the allow-list stays fixture-only', async () => {
    process.env.KIDS_FUN_LIVE_ACTIVENET = 'vancouver';
    const spy = vi.spyOn(globalThis, 'fetch');
    const burnaby = new ActiveNetAdapter(getTenantConfig('burnaby')!);
    expect(burnaby.isLiveFetchEnabled()).toBe(false);
    await burnaby.fetch();
    expect(spy).not.toHaveBeenCalled();
  });

  it('West Vancouver can never live-fetch — it has no drop-in calendars', async () => {
    process.env.KIDS_FUN_LIVE_ACTIVENET = 'west_vancouver';
    const spy = vi.spyOn(globalThis, 'fetch');
    const wv = new ActiveNetAdapter(getTenantConfig('west_vancouver')!);
    expect(wv.isLiveFetchEnabled(), 'config keeps it off even when env names it').toBe(false);
    await wv.fetch();
    expect(spy).not.toHaveBeenCalled();
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
  'worker/adapters/activenet/client.ts',
  'worker/adapters/activenet/parse.ts',
  'worker/adapters/activenet/venues.ts',
  'worker/adapters/activenet/health.ts',
  'worker/adapters/perfectmind/index.ts',
  'worker/adapters/perfectmind/config.ts',
  'worker/adapters/venue/index.ts',
  'worker/adapters/venue/config.ts',
  'worker/adapters/venue/separate.ts',
];

interface BypassPattern {
  label: string;
  re: RegExp;
}

// Fingerprints of an access-control bypass. Deliberately avoids tokens that appear
// legitimately as *source-data flags* the adapter merely reads (e.g. the library
// feed's `loginToRegister`, the Trumba feed's `requiresPayment`) — those describe
// the event, they are not the adapter authenticating or paying.
//
// These apply to EVERY adapter file, including READ_ONLY_POST_SEARCH ones.
const BYPASS_PATTERNS: BypassPattern[] = [
  { label: 'CAPTCHA handling', re: /captcha/i },
  { label: 'password credential', re: /\bpassword\b/i },
  { label: 'Authorization header', re: /authorization\s*:/i },
  { label: 'Cookie/session header', re: /["']?cookie["']?\s*:/i },
  { label: "credentials:'include'", re: /credentials\s*:\s*['"]?include/i },
  { label: 'headless-browser navigation', re: /\bpage\.(goto|type|click|fill|waitForSelector|evaluate|setContent)\b/i },
  { label: 'headless-browser library', re: /\b(puppeteer|playwright)\b/i },
  { label: 'checkout/cart flow', re: /\b(checkout|add[_-]?to[_-]?cart)\b/i },
  { label: 'anti-forgery token submit', re: /(__requestverificationtoken|x-csrf-token|csrf[_-]?token)/i },
];

/** Mutating HTTP methods. Split so the ONE narrowed prohibition is visible on its own
 *  line and the rest stay absolute. */
const WRITE_METHOD_PATTERN: BypassPattern = {
  label: 'mutating HTTP method (PUT/PATCH/DELETE)',
  re: /method\s*:\s*['"](put|patch|delete)['"]/i,
};
const POST_METHOD_PATTERN: BypassPattern = {
  label: 'POST method',
  re: /method\s*:\s*['"]post['"]/i,
};

/**
 * The scanner, as a pure function so (C) below can exercise it on synthetic code.
 * Returns the labels of every prohibition the code violates.
 *
 * `postAllowed` is true ONLY for files named in READ_ONLY_POST_SEARCH.sourceFiles.
 * Note what does NOT change when it is true: every entry in BYPASS_PATTERNS, and the
 * PUT/PATCH/DELETE prohibition, still apply.
 */
function scanForBypass(rawSource: string, postAllowed: boolean): string[] {
  const code = stripComments(rawSource);
  const patterns = [...BYPASS_PATTERNS, WRITE_METHOD_PATTERN];
  if (!postAllowed) patterns.push(POST_METHOD_PATTERN);
  return patterns.filter(({ re }) => re.test(code)).map(({ label }) => label);
}

describe('G-T35-2 (B) adapter source contains no login/paywall/CAPTCHA-bypass code', () => {
  for (const rel of ADAPTER_SOURCES) {
    it(`${rel} is free of bypass fingerprints`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
      const violations = scanForBypass(src, POST_ALLOWED_FILES.has(rel));
      expect(violations, `${rel} must not contain: ${violations.join(', ')}`).toEqual([]);
    });
  }

  it('only the allow-listed file may contain a POST at all', () => {
    for (const rel of ADAPTER_SOURCES) {
      if (POST_ALLOWED_FILES.has(rel)) continue;
      const code = stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8'));
      expect(POST_METHOD_PATTERN.re.test(code), `${rel} must not POST`).toBe(false);
    }
  });

  it('an allow-listed family pins its HOST in config — repointing it fails HERE', () => {
    // QA finding A1: previously the host was guarded only by an ordinary adapter test,
    // so repointing ACTIVENET_PORTAL_HOST left this suite green. D-10 is host-scoped, so
    // the elevated-scrutiny file owns that boundary itself now. Asserting the host is
    // the SOLE host literal in the config (not merely present) is what makes a REPOINT
    // fail, rather than only catching a deletion.
    for (const family of READ_ONLY_POST_SEARCH) {
      const code = stripComments(readFileSync(resolve(process.cwd(), family.hostConfigFile), 'utf8'));
      expect(
        hostLiteralsIn(code),
        `${family.hostConfigFile} must declare exactly the D-10-authorised host(s)`
      ).toEqual(family.hosts);
    }
  });

  it('an allow-listed file declares ONLY allow-listed endpoint paths', () => {
    // Second layer under the behavioural check: a POST path that never runs in a test
    // still cannot be introduced silently, because the file's endpoint-path literals
    // are pinned to the reviewed set.
    for (const family of READ_ONLY_POST_SEARCH) {
      const allowed = new Set([...family.postPaths, ...family.getPaths]);
      for (const rel of family.sourceFiles) {
        const code = stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8'));
        const declared = [...new Set(code.match(family.endpointPathPattern) ?? [])];
        expect(declared.length, `${rel} declares endpoint paths`).toBeGreaterThan(0);
        for (const path of declared) {
          expect(allowed.has(path), `${rel} declares un-allow-listed endpoint path ${path}`).toBe(true);
        }
      }
    }
  });

  it('the ToS-cleared and D-10-authorised live adapters are the ONLY ones exposing live fetch', () => {
    // library + citycalendar + venue + (T7 REBUILD) activenet implement
    // isLiveFetchEnabled(); PerfectMind still does not — it can never flip to live
    // without new code AND this test being revisited.
    const liveLibrary = new LibraryAdapter(LIBRARY_SYSTEMS.find((s) => s.systemKey === 'vpl')!);
    const liveCity = new CityCalendarAdapter(CITY_CALENDARS[0]);
    const liveVenue = new VenueAdapter(getVenue('hr-macmillan-space-centre')!);
    const activenet = new ActiveNetAdapter(ACTIVENET_TENANTS[0]);
    const perfectmind = new PerfectMindAdapter(PERFECTMIND_TENANTS[0]);

    expect(typeof liveLibrary.isLiveFetchEnabled).toBe('function');
    expect(typeof liveCity.isLiveFetchEnabled).toBe('function');
    expect(typeof liveVenue.isLiveFetchEnabled).toBe('function');
    expect(typeof activenet.isLiveFetchEnabled).toBe('function');
    expect((perfectmind as { isLiveFetchEnabled?: unknown }).isLiveFetchEnabled).toBeUndefined();
  });
});

// ── (C) the amendment tests itself ───────────────────────────────────────────
//
// G-T7R-0 narrowed exactly one prohibition. These cases prove the tripwire still
// catches every class it caught before — including inside the allow-listed family —
// and that the new allowance is genuinely narrow.

describe('G-T7R-0 (C) tripwire self-check: every other prohibition still bites', () => {
  const BYPASS_SNIPPETS: Array<[string, string, string]> = [
    ['Cookie header', "await fetch(u, { headers: { cookie: jar } });", 'Cookie/session header'],
    ['Authorization header', "await fetch(u, { headers: { authorization: 'Bearer x' } });", 'Authorization header'],
    ['credentials include', "await fetch(u, { credentials: 'include' });", "credentials:'include'"],
    ['anti-forgery token', "body.append('__RequestVerificationToken', t);", 'anti-forgery token submit'],
    ['csrf header', "headers['x-csrf-token'] = token;", 'anti-forgery token submit'],
    ['headless import', "import puppeteer from 'puppeteer';", 'headless-browser library'],
    ['headless navigation', 'await page.goto(url);', 'headless-browser navigation'],
    ['browser-spoofed UA', "const UA = 'Mozilla/5.0 (Windows NT 10.0)';", 'BROWSER_UA'],
    ['CAPTCHA handling', 'const solved = solveCaptcha(challenge);', 'CAPTCHA handling'],
    ['password credential', "const password = process.env.PORTAL_PASSWORD;", 'password credential'],
    ['checkout flow', "await fetch(base + '/checkout');", 'checkout/cart flow'],
    ['PUT', "await fetch(u, { method: 'PUT' });", 'mutating HTTP method (PUT/PATCH/DELETE)'],
    ['DELETE', "await fetch(u, { method: 'delete' });", 'mutating HTTP method (PUT/PATCH/DELETE)'],
  ];

  for (const [name, snippet, expectedLabel] of BYPASS_SNIPPETS) {
    if (expectedLabel === 'BROWSER_UA') continue; // covered by the behavioural UA assertion
    it(`${name} is caught in a NON-allow-listed file`, () => {
      expect(scanForBypass(snippet, false)).toContain(expectedLabel);
    });
    it(`${name} is STILL caught inside an allow-listed file`, () => {
      expect(scanForBypass(snippet, true)).toContain(expectedLabel);
    });
  }

  it('a bare read-only POST FAILS in a non-allow-listed file', () => {
    expect(scanForBypass("await fetch(u, { method: 'POST', body: '{}' });", false)).toContain('POST method');
  });

  it('a bare read-only POST PASSES in an allow-listed file', () => {
    expect(scanForBypass("await fetch(u, { method: 'POST', body: '{}' });", true)).toEqual([]);
  });

  it('a comment claiming compliance cannot mask real bypass code', () => {
    const src = "// no cookie, no login, no CAPTCHA here\nawait fetch(u, { headers: { cookie: jar } });";
    expect(scanForBypass(src, true)).toContain('Cookie/session header');
  });

  it('a POST to a path OUTSIDE the allow-list is rejected by the request check', () => {
    const AC = 'https://anc.ca.apm.activecommunities.com';
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/onlinecalendar/filters`)).toBe(true);
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/onlinecalendar/multicenter/events`)).toBe(true);
    expect(isAllowedReadOnlyPost(`${AC}/burnaby/rest/onlinecalendar/filters`)).toBe(true);
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/cart/checkout`)).toBe(false);
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/onlinecalendar/register`)).toBe(false);
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/activities/list`)).toBe(false);
  });

  it('a POST to an allow-listed PATH on a NON-allow-listed HOST is rejected (QA A1)', () => {
    // The exact hole QA found: D-10 authorised a portal, not a technique. The right
    // path on the wrong host must fail, and near-miss hostnames must not sneak through
    // a suffix match.
    for (const host of [
      'https://evil.example.com',
      'https://anc.ca.apm.activecommunities.com.attacker.example',
      'https://not-anc.ca.apm.activecommunities.com',
      'http://localhost:8080',
    ]) {
      expect(
        isAllowedReadOnlyPost(`${host}/vancouver/rest/onlinecalendar/filters`),
        `${host} must not be allowed`
      ).toBe(false);
    }
    expect(isAllowedReadOnlyPost('not a url at all')).toBe(false);
  });

  it('the per-request host guard rejects a non-authorised host for ANY method', () => {
    // Not just POSTs: a GET drifting off the authorised portal is also out of scope.
    expect(() => expectAllowedHost({ url: 'https://anc.ca.apm.activecommunities.com/x', init: {} })).not.toThrow();
    expect(() => expectAllowedHost({ url: 'https://evil.example.com/x', init: {} })).toThrow();
  });

  it('a browser-spoofed UA fails the behavioural check', () => {
    // The UA prohibition is behavioural (the constant lives in worker/core/politeness.ts,
    // outside ADAPTER_SOURCES), so assert the assertion itself bites.
    expect(() =>
      expectCredentialFree({ url: 'https://example.org/x', init: { headers: { 'user-agent': 'Mozilla/5.0' } } })
    ).toThrow();
    expect(() =>
      expectCredentialFree({ url: 'https://example.org/x', init: { headers: { 'user-agent': 'KidsFunBot/1.0' } } })
    ).not.toThrow();
  });

  it('the allow-list is exactly one family, one adapter, two paths', () => {
    // A drift guard on the exception itself: widening it should be a visible,
    // deliberate edit that fails this assertion first.
    expect(READ_ONLY_POST_SEARCH).toHaveLength(1);
    expect(READ_ONLY_POST_SEARCH[0].family).toBe('activenet');
    expect(READ_ONLY_POST_SEARCH[0].sourceFiles).toEqual(['worker/adapters/activenet/client.ts']);
    expect(READ_ONLY_POST_SEARCH[0].hosts).toEqual(['anc.ca.apm.activecommunities.com']);
    expect(READ_ONLY_POST_SEARCH[0].postPaths).toEqual([
      '/onlinecalendar/filters',
      '/onlinecalendar/multicenter/events',
    ]);
    // One host, and it is the one D-10 names. Adding a second is a deliberate,
    // visible edit that must fail here first.
    expect(ALLOWED_HOSTS.size).toBe(1);
  });
});
