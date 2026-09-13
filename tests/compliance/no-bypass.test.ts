// tests/compliance/no-bypass.test.ts — G-T35-2 (Round 18 / Task Z, ‹L3›),
// amended by G-T7R-0 (T7 REBUILD) for the read-only POST-search exception,
// and by G-T8-3 (T8) for a SECOND family under the same exception (PerfectMind).
//
// Compliance guardrail: NO live adapter performs a login / paywall / checkout /
// CAPTCHA bypass. This is verified two ways against the *real* adapter code
// (not mocks that could paper over a bypass):
//
//   (A) Behavioural — the adapters that actually reach the network are driven with
//       a spied global fetch, and the real outgoing requests are inspected: they
//       must be credential-free (no Authorization/Cookie header, no
//       credentials:include), carrying only an identified bot User-Agent — never a
//       browser spoof. Every request must be a GET, with the named
//       READ_ONLY_POST_SEARCH exceptions only (below — host-scoped and
//       family-scoped as well as path-scoped). Any
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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LibraryAdapter, LIBRARY_SYSTEMS } from '../../worker/adapters/library';
import { CityCalendarAdapter, CITY_CALENDARS } from '../../worker/adapters/citycalendar';
import { ActiveNetAdapter, ACTIVENET_TENANTS, getTenantConfig } from '../../worker/adapters/activenet';
import {
  PerfectMindAdapter,
  PERFECTMIND_TENANTS,
  getPerfectMindTenant,
} from '../../worker/adapters/perfectmind';
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
  {
    // T8 / G-T8-3 — the SECOND family under D-11, added deliberately and narrowly.
    //
    // Why an amendment was needed at all: the entry above is HOST-scoped (QA finding A1,
    // and rightly so), so PerfectMind's different hosts were NOT covered by it. The
    // brief's suggestion that D-11 might already cover this generically was checked
    // against this file rather than assumed, and it does not — `ALLOWED_HOSTS`,
    // `POST_ALLOWED_FILES` and the drift guard at the bottom were all pinned to
    // ActiveNet alone. Widening by one family, two hosts, two paths and one file is
    // therefore a real edit to the highest-scrutiny file in the repo, held to the same
    // elevated standard as the original: nothing else about the prohibition list moves.
    //
    // Two hosts because PerfectMind is one tenant per SUBDOMAIN rather than one tenant
    // per path segment. Each is named exactly; there is no wildcard and no suffix match.
    //
    // NOTE what is NOT here: `/BookMe4BookingPages/Courses` (registered courses, not
    // drop-ins — including it would let the adapter manufacture drop-in coverage that
    // does not exist) and any anti-forgery submission. The BookMe4 shell posts a
    // `__RequestVerificationToken` and the server does not require it, so the
    // anti-forgery prohibition stays absolutely banned for this family too — asserted
    // behaviourally below, not merely by omission.
    family: 'perfectmind',
    sourceFiles: ['worker/adapters/perfectmind/client.ts'],
    hosts: ['nvrc.perfectmind.com', 'richmondcity.perfectmind.com'],
    hostConfigFile: 'worker/adapters/perfectmind/config.ts',
    postPaths: ['/BookMe4V2/GetCategoriesDataV2', '/BookMe4BookingPagesV2/ClassesV2'],
    getPaths: [],
    endpointPathPattern: /\/BookMe4[A-Za-z0-9_\-/]*/g,
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
 * (`/vancouver/rest` + `/onlinecalendar/filters`, `/23734/Clients` +
 * `/BookMe4BookingPagesV2/ClassesV2`).
 *
 * `family` narrows the search to ONE entry, and is REQUIRED. Added with T8's second
 * family: without it, every added family silently widens the check for every EXISTING
 * family, because a request would only have to satisfy *some* entry.
 *
 * REQUIRED, not optional (QA finding A1). The first version made it optional, which made
 * the whole mechanism a silent no-op if a caller forgot it — QA proved the point by
 * deleting the argument at every call site and watching the suite stay green. A required
 * parameter turns that omission into a compile error. The `list` parameter exists so the
 * family filter can be exercised for real, against a synthetic allow-list where two
 * families SHARE a host — see the mutation test below. Without that, the assertion is
 * vacuous today, because the two real families' host sets happen to be disjoint and the
 * pre-existing host+path coupling already rejects every cross-family combination.
 */
function matchesReadOnlyPost(
  list: ReadOnlyPostSearchFamily[],
  url: string,
  family: string
): boolean {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  const { pathname } = new URL(url);
  return list
    .filter((f) => f.family === family)
    .some((f) => f.hosts.includes(hostname) && f.postPaths.some((p) => pathname.endsWith(p)));
}

function isAllowedReadOnlyPost(url: string, family: string): boolean {
  return matchesReadOnlyPost(READ_ONLY_POST_SEARCH, url, family);
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

/** Every request from an allow-listed family must stay on a D-10-authorised host —
 *  and, when the caller names the family, on THAT family's hosts specifically. */
function expectAllowedHost(call: CapturedCall, family: string): void {
  const hostname = hostnameOf(call.url);
  expect(hostname, `unparseable request URL: ${call.url}`).not.toBeNull();
  const allowed = new Set(
    READ_ONLY_POST_SEARCH.filter((f) => f.family === family).flatMap((f) => f.hosts)
  );
  expect(
    allowed.has(hostname!),
    `${hostname} is not a D-10-authorised host for family '${family}' — the override is host-scoped`
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
  // QA finding A2 (defence in depth): the previous hand-rolled scan returned the FIRST
  // case-insensitive key match, so a plain object carrying two differently-cased UA keys
  // let the identified one shadow a spoof that `Headers` would actually combine and put on
  // the wire (`user-agent: KidsFunBot/1.0, Mozilla/5.0 …`). Normalising through the native
  // Headers API makes this checker see exactly what the transport would send.
  //
  // H4 already removed the PRECONDITION — politeFetch no longer emits a second UA key, and
  // every adapter now routes through it — so this is belt-and-braces rather than the sole
  // protection. It is kept because the guarantee it depends on lives in a different file
  // and is not obliged to preserve that property. Absence-assertions (Cookie/Authorization)
  // were always casing-safe; value-property assertions like the UA check were not.
  return new Headers(h as Record<string, string>).get(name) ?? undefined;
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
function expectReadOnlyRequest(call: CapturedCall, family: string): void {
  const method = (call.init?.method ?? 'GET').toString().toUpperCase();
  expect(['GET', 'POST'], 'only GET or an allow-listed read-only POST').toContain(method);
  expectAllowedHost(call, family);
  if (method === 'GET') {
    expect(call.init?.body ?? null, 'a GET carries no body').toBeNull();
  } else {
    expect(
      isAllowedReadOnlyPost(call.url, family),
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

  // ── NVDPL generic_rss (D-12) ────────────────────────────────────────────────
  // D-12 is Jon's acceptance of ONE specific risk: that NVDPL's robots.txt is unreadable
  // (HTTP 403, Cloudflare managed challenge) and therefore fail-closed under this
  // project's own T11 Aquarium precedent. It authorises fetching a public RSS feed. It
  // does NOT discharge anything below, and it does not extend to any other source.
  it('NVDPL RSS (generic_rss) — single GET, no login/cookie/body', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'nvdpl';
    const nvdpl = LIBRARY_SYSTEMS.find((s) => s.systemKey === 'nvdpl');
    expect(nvdpl, 'NVDPL system present in registry').toBeTruthy();
    const adapter = new LibraryAdapter(nvdpl!);
    expect(adapter.isLiveFetchEnabled?.()).toBe(true);

    const calls = mockFetchCapture(
      '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>',
      'application/rss+xml'
    );
    await adapter.fetch();

    expect(calls.length, 'exactly one GET per fetch — this source is not paginated').toBe(1);
    expectCredentialFreeGet(calls[0]);
    // Pin the exact feed URL. NVDPL's other paths (/events, /events/ical, /api/events) are
    // all Cloudflare-challenged 403/404 — /rss is the ONE surface that answers, and the
    // only one D-12 was decided about. A repoint onto an HTML path fails here.
    expect(calls[0].url).toBe('https://nvdpl.events.mylibrary.digital/rss');
  });

  it('NVDPL is STATELESS — the feed sets a PHPSESSID and we never send one back', async () => {
    // A real, verified property of this host, not a hypothetical: the live response carries
    // `set-cookie: PHPSESSID=…; path=/; secure; HttpOnly`. Two fetches must therefore look
    // IDENTICAL — no cookie jar, no session continuation, no state accumulating across runs.
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'nvdpl';
    const nvdpl = LIBRARY_SYSTEMS.find((s) => s.systemKey === 'nvdpl')!;

    const calls: Array<{ url: string; init: (RequestInit & { credentials?: string }) | undefined }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init?: unknown) => {
      calls.push({ url: String(input), init: init as RequestInit });
      return new Response('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>', {
        status: 200,
        headers: {
          'content-type': 'application/rss+xml',
          // Exactly what the live host returned on 2026-07-31.
          'set-cookie': 'PHPSESSID=121094c16335663cc9bb834b92ff4971; path=/; secure; HttpOnly',
        },
      });
    }) as typeof fetch);

    await new LibraryAdapter(nvdpl).fetch();
    clearPolicyState(); // reset the per-source rate-limit clock, not any cookie state
    await new LibraryAdapter(nvdpl).fetch();

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expectCredentialFreeGet(call);
      expect(headerLookup(call.init, 'cookie'), 'the Set-Cookie is never echoed back').toBeUndefined();
    }
    // The second request carries no trace of the first beyond conditional-cache headers.
    expect(calls[1].url).toBe(calls[0].url);
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
    for (const call of calls) expectReadOnlyRequest(call, 'activenet');
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
    for (const call of calls) expectReadOnlyRequest(call, 'activenet');
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

  it('PerfectMind with no env allow-list performs no fetch and reports not-live', async () => {
    delete process.env.KIDS_FUN_LIVE_PERFECTMIND;
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const tenant of PERFECTMIND_TENANTS) {
      const adapter: Adapter = new PerfectMindAdapter(tenant);
      expect(adapter.isLiveFetchEnabled?.() ?? false, `${tenant.tenantKey} never live`).toBe(false);
      const raw = await adapter.fetch();
      expect(Array.isArray(raw)).toBe(true);
    }
    expect(spy, 'PerfectMind fetch() made no network request').not.toHaveBeenCalled();
  });

  it('a PerfectMind tenant NOT named in the allow-list stays fixture-only', async () => {
    process.env.KIDS_FUN_LIVE_PERFECTMIND = 'nvrc';
    const spy = vi.spyOn(globalThis, 'fetch');
    const richmond = new PerfectMindAdapter(getPerfectMindTenant('richmond')!);
    expect(richmond.isLiveFetchEnabled()).toBe(false);
    await richmond.fetch();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Richmond can never live-fetch — it has no drop-in categories (G-T8-1 null result)', async () => {
    // The measured outcome of G-T8-1: Richmond's only public widget is a REGISTRATION
    // widget. Config keeps it off even when the env names it, so a future operator
    // cannot enable drop-in coverage that does not exist by setting an env var.
    process.env.KIDS_FUN_LIVE_PERFECTMIND = 'richmond';
    const spy = vi.spyOn(globalThis, 'fetch');
    const richmond = new PerfectMindAdapter(getPerfectMindTenant('richmond')!);
    expect(richmond.isLiveFetchEnabled(), 'config keeps it off even when env names it').toBe(false);
    await richmond.fetch();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('G-T9/D-12 (A) library systems NOT explicitly enabled make ZERO network calls', () => {
  it('NVDPL with no env allow-list performs no fetch and reports not-live', async () => {
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new LibraryAdapter(LIBRARY_SYSTEMS.find((s) => s.systemKey === 'nvdpl')!);
    expect(adapter.isLiveFetchEnabled?.(), 'not live without the env allow-list').toBe(false);
    const raw = await adapter.fetch();
    expect(Array.isArray(raw)).toBe(true);
    expect(spy, 'NVDPL fetch() made no network request').not.toHaveBeenCalled();
  });

  it('a library system NOT named in the allow-list stays fixture-only', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl';
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new LibraryAdapter(LIBRARY_SYSTEMS.find((s) => s.systemKey === 'nvdpl')!);
    expect(adapter.isLiveFetchEnabled?.()).toBe(false);
    await adapter.fetch();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Coquitlam can never live-fetch — it has no reviewed live path (liveCapable unset)', async () => {
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'cpl,vpl,rpl,nvdpl';
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new LibraryAdapter(LIBRARY_SYSTEMS.find((s) => s.systemKey === 'cpl')!);
    expect(adapter.isLiveFetchEnabled?.(), 'naming it in the env var is not sufficient').toBe(false);
    await adapter.fetch();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('G-T8-3 (A) PerfectMind live path — credential-free, token-free reads on allow-listed paths only', () => {
  /** Drive the adapter under fake timers so the 3s politeness floor between requests
   *  costs virtual time, not wall-clock. The rate limiter itself is exercised for real. */
  async function drivePerfectMind(tenantKey: string): Promise<CapturedCall[]> {
    process.env.KIDS_FUN_LIVE_PERFECTMIND = tenantKey;
    const adapter = new PerfectMindAdapter(getPerfectMindTenant(tenantKey)!);
    expect(adapter.isLiveFetchEnabled(), `${tenantKey} live-enabled by env`).toBe(true);

    // One category holding one ClassesV2-servable calendar, then an end-of-data cursor,
    // so the run makes both kinds of request and terminates.
    let call = 0;
    const calls: CapturedCall[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init?: unknown) => {
      calls.push({ url: String(input), init: init as CapturedCall['init'] });
      const body =
        call++ === 0
          ? JSON.stringify([
              {
                Name: '**Drop-In Schedules',
                Calendars: [
                  {
                    Id: '11111111-2222-3333-4444-555555555555',
                    Name: 'Open Gym Schedules',
                    BookingLink: '/x',
                    BookingTypeInfo: { BookingType: 2 },
                  },
                ],
              },
            ])
          : JSON.stringify({ classes: [], classesMaxEndDateString: null, nextKey: '0001-01-01' });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);

    vi.useFakeTimers();
    const pending = adapter.fetch();
    await vi.advanceTimersByTimeAsync(300_000);
    await pending;
    vi.useRealTimers();
    return calls;
  }

  it('every request is a credential-free, allow-listed read-only POST', async () => {
    const calls = await drivePerfectMind('nvrc');
    expect(calls.length, 'categories + at least one classes page').toBeGreaterThan(1);
    for (const call of calls) expectReadOnlyRequest(call, 'perfectmind');
  });

  it('the POSTs it makes are EXACTLY the two named read-only searches', async () => {
    const calls = await drivePerfectMind('nvrc');
    const paths = calls.map((c) => new URL(c.url).pathname);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect([
        '/23734/Clients/BookMe4V2/GetCategoriesDataV2',
        '/23734/Clients/BookMe4BookingPagesV2/ClassesV2',
      ]).toContain(p);
    }
  });

  it('NO request carries an anti-forgery token, in any form', async () => {
    // The load-bearing assertion of this family's amendment. The vendor's OWN client
    // posts `__RequestVerificationToken` via `$.ajaxAntiForgeryPost`; the server does not
    // require it, and we must never send one. `expectCredentialFree` already checks
    // headers and bodies for it, but this asserts it explicitly and by name so the
    // guarantee is proven rather than true by omission — which is exactly the standard
    // the brief asked for.
    const calls = await drivePerfectMind('nvrc');
    for (const call of calls) {
      const body = typeof call.init?.body === 'string' ? call.init.body : '';
      expect(body, 'no anti-forgery token in a PerfectMind body').not.toMatch(
        /__requestverificationtoken|csrf/i
      );
      const fields = new Set([...new URLSearchParams(body).keys()]);
      // A CLOSED expected field set: anything new here is a deliberate, visible edit.
      for (const key of fields) {
        expect(
          ['widgetId', 'calendarId', 'page', 'dateString', 'after'],
          `unexpected POST field "${key}" — the body allow-list is closed`
        ).toContain(key);
      }
      expect(fields.has('widgetId'), 'the widget id is always present').toBe(true);
    }
  });

  it('POST bodies are search filters — no credential, no session, no cart', async () => {
    const calls = await drivePerfectMind('nvrc');
    for (const call of calls) {
      const body = typeof call.init?.body === 'string' ? call.init.body : '';
      expect(body).not.toMatch(/password|username|token|session|cart|checkout/i);
    }
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
  // NVDPL generic_rss handler + the XML/HTML text helpers it shares with the
  // BiblioCommons parser (D-12). Held to the identical bar as every other adapter file:
  // the robots.txt override authorises FETCHING this feed, it does not relax any of the
  // no-login / no-CAPTCHA / no-headless / no-POST prohibitions.
  'worker/adapters/library/generic-rss.ts',
  'worker/adapters/library/rss-text.ts',
  // Shared run-health vocabulary for the family's feed parsers (tallies + verdicts). A pure
  // function module that cannot make a request — listed anyway, for the same reason
  // activenet/venue-geo.ts is: "this one can't fetch" is precisely the assumption a
  // tripwire exists so nobody has to take on trust. Section (D) below is what caught its
  // absence when the file was added, which is the mechanism working as designed.
  'worker/adapters/library/run-health.ts',
  'worker/adapters/citycalendar/index.ts',
  'worker/adapters/citycalendar/config.ts',
  'worker/adapters/activenet/index.ts',
  'worker/adapters/activenet/config.ts',
  'worker/adapters/activenet/client.ts',
  'worker/adapters/activenet/parse.ts',
  'worker/adapters/activenet/venues.ts',
  // The activity-record age lookup (/activity/detail/<id>). A READ of the same public,
  // credential-free portal the calendar endpoints use, through the same shared client, so it
  // inherits the identical politeness, budget and circuit-breaker policy — it adds no new
  // surface of its own. Listed because section (D) exists so that claim is checked rather
  // than taken on trust.
  'worker/adapters/activenet/activity-age.ts',
  // The cross-run store for those answers. Touches the DATABASE, never the portal — it holds no
  // fetch of any kind. Listed for the same reason venue-geo.ts is: "this one cannot make a
  // request" is exactly the assumption section (D) exists so nobody has to take on trust.
  'worker/adapters/activenet/activity-age-store.ts',
  // G-VENUE-1: a committed constant, not a fetcher — listed anyway, because
  // "this one can't make requests" is exactly the assumption a tripwire exists to stop
  // anyone having to trust. (This list stays hand-written so each entry is a deliberate
  // act; what changed in PRODREC-3 is that section (D) below now PROVES the list is
  // complete against the real directory tree, so an omission can no longer be silent.)
  'worker/adapters/activenet/venue-geo.ts',
  'worker/adapters/activenet/health.ts',
  'worker/adapters/perfectmind/index.ts',
  'worker/adapters/perfectmind/config.ts',
  'worker/adapters/perfectmind/client.ts',
  'worker/adapters/perfectmind/parse.ts',
  'worker/adapters/perfectmind/health.ts',
  'worker/adapters/venue/index.ts',
  'worker/adapters/venue/config.ts',
  'worker/adapters/venue/separate.ts',
];

// ─────────────────────────────────────────────────────────────────────────────
// PRODREC-3 — REQUIRED-COVERAGE REGISTRY (the structural fix; see section (D)).
//
// THE GAP THIS CLOSES, stated plainly. Until now the structural scan worked from
// ADAPTER_SOURCES alone — a hand-kept enumeration. Nothing forced a NEW adapter family
// to actually be added to it. Two independent QA sessions proved this the same way:
// drop an adapter file with hardcoded credentials and banned request patterns into a
// directory nobody listed, and the whole compliance suite stays green — because the
// file is never opened. A KNOWN instance had been live since the family was built:
// all four worker/adapters/seasonal/*.ts files had never been in any compliance scan.
//
// The fix: discovery is now by DIRECTORY ENUMERATION, not by memory. Every subdirectory
// of worker/adapters/ is an adapter family, and every .ts file in it must be covered by
// EITHER this file's ADAPTER_SOURCES scan OR a per-family compliance suite registered
// below. A new family, or a new file in an existing family, fails section (D) LOUDLY
// until its coverage is declared. Forgetting is no longer a silent pass.
//
// WHY PER-FAMILY SUITES EXIST AT ALL. Some families have a legitimately different
// security shape that the shared prohibitions above would misjudge in BOTH directions.
// Registering one is a narrowing, so it is handled the way T7/T8's POST narrowing and
// D-11 were — named, scoped, and re-proven, never silently omitted. Each registered
// suite must re-run EVERY prohibition from this file against its family and narrow only
// what it names and justifies.
//   • eventbrite — no anonymous read path exists at all, so an organizer-granted bearer
//     token is the only way to satisfy "authorized feeds only" rather than a way around
//     it. Narrows exactly one item (Authorization header). Built T10.
//   • seasonal   — its config carries robots.txt COMPLIANCE RECORDS that quote the very
//     paths we are banned from ("Disallow /checkout*,/cart*,…"). Those string literals
//     survive stripComments and trip the checkout/cart fingerprint, so the shared scan
//     would read a record PROVING we stay out of checkout as if it were checkout code.
//     Narrows exactly that, positionally. Built PRODREC-3.
//
// Registration is deliberately NOT self-certifying: (D) asserts each registered suite
// exists on disk AND literally names every file it claims to cover. You cannot register
// a family and then quietly not cover it.
const PER_FAMILY_COMPLIANCE_SUITES: Record<string, string> = {
  eventbrite: 'tests/compliance/eventbrite-organizer-scope.test.ts',
  seasonal: 'tests/compliance/seasonal-status-watcher.test.ts',
};

const ADAPTERS_ROOT = 'worker/adapters';

/** Directories inside an adapter family that hold test data, not adapter code. */
const NON_CODE_DIRS = new Set(['__fixtures__', '__snapshots__', '__mocks__']);

/**
 * Discover every adapter family and its code files from the real directory tree.
 * Pure w.r.t. its `root` argument so (D) can run it against synthetic trees.
 * Returns family name → repo-relative .ts paths, sorted for stable assertions.
 */
function discoverAdapterFamilies(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const abs = resolve(process.cwd(), root);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!entry.isDirectory() || NON_CODE_DIRS.has(entry.name)) continue;
    const files = readdirSync(resolve(abs, entry.name), { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.ts') && !f.name.endsWith('.d.ts'))
      .map((f) => `${root}/${entry.name}/${f.name}`)
      .sort();
    out.set(entry.name, files);
  }
  return out;
}

interface CoverageGaps {
  /** Families with no coverage of either kind. */
  uncoveredFamilies: string[];
  /** Individual files no scan would ever open. */
  uncoveredFiles: string[];
  /** Families registered to a suite that does not exist on disk. */
  missingSuites: string[];
  /** `file → suite` where the registered suite never names that file. */
  unreferencedFiles: string[];
  /** ADAPTER_SOURCES entries that no longer exist on disk (stale list). */
  staleSources: string[];
}

/**
 * THE GUARANTEE, as a pure function so section (D) can mutation-test it directly on
 * synthetic inputs instead of trusting that it works. Everything it needs is injected:
 * the discovered tree, the hand-kept list, the registry, and a reader for suite text.
 *
 * A file is covered iff it is named in ADAPTER_SOURCES, OR its family is registered to
 * a per-family suite that EXISTS and literally names that file.
 */
function computeCoverageGaps(
  discovered: Map<string, string[]>,
  adapterSources: readonly string[],
  perFamilySuites: Record<string, string>,
  readSuite: (rel: string) => string | null
): CoverageGaps {
  const listed = new Set(adapterSources);
  const gaps: CoverageGaps = {
    uncoveredFamilies: [],
    uncoveredFiles: [],
    missingSuites: [],
    unreferencedFiles: [],
    staleSources: [],
  };

  const suiteText = new Map<string, string | null>();
  for (const [family, rel] of Object.entries(perFamilySuites)) {
    const text = readSuite(rel);
    suiteText.set(family, text);
    if (text === null && discovered.has(family)) gaps.missingSuites.push(`${family} → ${rel}`);
  }

  for (const [family, files] of discovered) {
    const registered = Object.prototype.hasOwnProperty.call(perFamilySuites, family);
    const text = registered ? suiteText.get(family) ?? null : null;
    const anyListed = files.some((f) => listed.has(f));

    // A family with zero coverage of EITHER kind — the exact seasonal case, and the
    // exact shape a brand-new adapter family arrives in.
    if (!anyListed && !(registered && text !== null)) {
      gaps.uncoveredFamilies.push(family);
      gaps.uncoveredFiles.push(...files);
      continue;
    }

    for (const file of files) {
      if (listed.has(file)) continue;
      if (text !== null && text.includes(file)) continue;
      if (registered && text !== null) {
        gaps.unreferencedFiles.push(`${file} → ${perFamilySuites[family]}`);
      } else {
        gaps.uncoveredFiles.push(file);
      }
    }
  }

  const onDisk = new Set([...discovered.values()].flat());
  gaps.staleSources = adapterSources.filter((f) => !onDisk.has(f));
  return gaps;
}

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
    // library + citycalendar + venue + (T7 REBUILD) activenet + (T8) perfectmind all
    // implement isLiveFetchEnabled(). PerfectMind USED to be asserted here as having no
    // such method at all; T8 changed that deliberately under the same D-10/D-11
    // authority, so the guarantee moves rather than disappearing: every live-capable
    // adapter must be OFF by default, which is what the roster below asserts.
    delete process.env.KIDS_FUN_LIVE_ACTIVENET;
    delete process.env.KIDS_FUN_LIVE_PERFECTMIND;
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
    delete process.env.KIDS_FUN_LIVE_CITY_CALENDARS;
    delete process.env.KIDS_FUN_LIVE_VENUES;

    const liveCapable: Array<[string, Adapter]> = [
      ['library', new LibraryAdapter(LIBRARY_SYSTEMS.find((s) => s.systemKey === 'vpl')!)],
      ['library/nvdpl', new LibraryAdapter(LIBRARY_SYSTEMS.find((s) => s.systemKey === 'nvdpl')!)],
      ['citycalendar', new CityCalendarAdapter(CITY_CALENDARS[0])],
      ['venue', new VenueAdapter(getVenue('hr-macmillan-space-centre')!)],
      ['activenet', new ActiveNetAdapter(ACTIVENET_TENANTS[0])],
      ['perfectmind', new PerfectMindAdapter(PERFECTMIND_TENANTS[0])],
    ];

    for (const [name, adapter] of liveCapable) {
      expect(typeof adapter.isLiveFetchEnabled, `${name} declares isLiveFetchEnabled`).toBe('function');
      expect(
        adapter.isLiveFetchEnabled!(),
        `${name} must be OFF with no KIDS_FUN_LIVE_* env var set`
      ).toBe(false);
    }
  });
});

// ── (D) required coverage: no adapter family can escape the scan ─────────────
//
// PRODREC-3. Discovery by directory enumeration, not by memory. These are the tests
// that make forgetting LOUD. The pure-function mutation cases at the bottom prove the
// mechanism actually bites rather than being read and assumed to work.

describe('PRODREC-3 (D) every adapter family is covered by a compliance scan', () => {
  const readSuite = (rel: string): string | null => {
    const abs = resolve(process.cwd(), rel);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  };
  const discovered = () => discoverAdapterFamilies(ADAPTERS_ROOT);
  const gaps = () =>
    computeCoverageGaps(discovered(), ADAPTER_SOURCES, PER_FAMILY_COMPLIANCE_SUITES, readSuite);

  it('discovery actually finds the real adapter tree (guards against a vacuous pass)', () => {
    // If this ever returns nothing, every assertion below would pass trivially. That is
    // the failure mode a coverage check has to rule out about ITSELF first.
    const families = discovered();
    expect(families.size, 'at least one adapter family must be discovered').toBeGreaterThan(0);
    for (const [family, files] of families) {
      expect(files.length, `family ${family} must contain at least one .ts file`).toBeGreaterThan(0);
    }
    // The families known at the time of writing. A NEW family makes this fail on
    // purpose — the point is that adding one is a deliberate, visible act.
    expect([...families.keys()].sort()).toEqual([
      'activenet',
      'citycalendar',
      'eventbrite',
      'library',
      'perfectmind',
      'seasonal',
      'venue',
    ]);
  });

  it('NO adapter family is without compliance coverage of either kind', () => {
    const { uncoveredFamilies } = gaps();
    expect(
      uncoveredFamilies,
      `adapter families with NO compliance coverage: ${uncoveredFamilies.join(', ')}. ` +
        'Add each file to ADAPTER_SOURCES, or register a per-family compliance suite in ' +
        'PER_FAMILY_COMPLIANCE_SUITES. Do not delete this assertion.'
    ).toEqual([]);
  });

  it('NO individual adapter file escapes every scan', () => {
    // Family-level coverage is not enough: a new file dropped into an ALREADY-covered
    // family would otherwise slip through, which is the same bug one level down.
    const { uncoveredFiles } = gaps();
    expect(
      uncoveredFiles,
      `adapter files no compliance scan opens: ${uncoveredFiles.join(', ')}`
    ).toEqual([]);
  });

  it('every registered per-family suite exists and names every file it covers', () => {
    const { missingSuites, unreferencedFiles } = gaps();
    expect(missingSuites, `registered suites missing from disk: ${missingSuites.join(', ')}`).toEqual([]);
    expect(
      unreferencedFiles,
      `files whose registered suite never names them: ${unreferencedFiles.join(', ')}`
    ).toEqual([]);
  });

  it('ADAPTER_SOURCES contains no stale entry for a deleted file', () => {
    // The mirror image: a renamed/deleted file leaving a dead entry behind would make
    // the list look more complete than it is.
    const { staleSources } = gaps();
    expect(staleSources, `ADAPTER_SOURCES names files that do not exist: ${staleSources.join(', ')}`).toEqual([]);
  });

  it('the registry is exactly the two justified narrowings', () => {
    // Same drift-guard shape as the READ_ONLY_POST_SEARCH assertion: widening the set of
    // families exempt from the shared scan must be a visible, deliberate edit that fails
    // here first, with a written justification in the block comment above.
    expect(Object.keys(PER_FAMILY_COMPLIANCE_SUITES).sort()).toEqual(['eventbrite', 'seasonal']);
  });

  // ── the guarantee mutation-tests itself ────────────────────────────────────
  //
  // Each case feeds computeCoverageGaps a SYNTHETIC tree. These are the proofs that the
  // mechanism catches what it claims to; the assertions above only prove today's tree is
  // clean, which a broken mechanism would also report.

  const suiteOf = (map: Record<string, string>) => (rel: string) => map[rel] ?? null;

  it('MUTATION: a brand-new unlisted adapter family is caught', () => {
    // Precisely the fake-unsafe-adapter proof both QA sessions ran, as a unit case.
    const tree = new Map([
      ['library', ['worker/adapters/library/index.ts']],
      ['fakeunsafe', ['worker/adapters/fakeunsafe/index.ts', 'worker/adapters/fakeunsafe/client.ts']],
    ]);
    const g = computeCoverageGaps(tree, ['worker/adapters/library/index.ts'], {}, suiteOf({}));
    expect(g.uncoveredFamilies).toEqual(['fakeunsafe']);
    expect(g.uncoveredFiles).toEqual([
      'worker/adapters/fakeunsafe/index.ts',
      'worker/adapters/fakeunsafe/client.ts',
    ]);
  });

  it('MUTATION: a new FILE inside an already-covered family is caught', () => {
    const tree = new Map([
      ['library', ['worker/adapters/library/index.ts', 'worker/adapters/library/sneaky.ts']],
    ]);
    const g = computeCoverageGaps(tree, ['worker/adapters/library/index.ts'], {}, suiteOf({}));
    expect(g.uncoveredFamilies).toEqual([]);
    expect(g.uncoveredFiles).toEqual(['worker/adapters/library/sneaky.ts']);
  });

  it('MUTATION: registering a family whose suite does not exist is caught', () => {
    const tree = new Map([['ghost', ['worker/adapters/ghost/index.ts']]]);
    const g = computeCoverageGaps(tree, [], { ghost: 'tests/compliance/ghost.test.ts' }, suiteOf({}));
    expect(g.missingSuites).toEqual(['ghost → tests/compliance/ghost.test.ts']);
    expect(g.uncoveredFamilies).toEqual(['ghost']);
  });

  it('MUTATION: a registered suite that does NOT name a file cannot cover it', () => {
    // The anti-forgery property: registration alone must not launder coverage. A suite
    // that names only one of two files leaves the other reported, not absorbed.
    const tree = new Map([['eb', ['worker/adapters/eb/index.ts', 'worker/adapters/eb/client.ts']]]);
    const g = computeCoverageGaps(
      tree,
      [],
      { eb: 'tests/compliance/eb.test.ts' },
      suiteOf({ 'tests/compliance/eb.test.ts': "scan('worker/adapters/eb/index.ts')" })
    );
    expect(g.uncoveredFamilies).toEqual([]);
    expect(g.unreferencedFiles).toEqual(['worker/adapters/eb/client.ts → tests/compliance/eb.test.ts']);
  });

  it('MUTATION: a fully-covered tree reports NO gaps (the check is not stuck-on-fail)', () => {
    // A guard that always fails is as useless as one that never does.
    const tree = new Map([
      ['library', ['worker/adapters/library/index.ts']],
      ['eb', ['worker/adapters/eb/index.ts']],
    ]);
    const g = computeCoverageGaps(
      tree,
      ['worker/adapters/library/index.ts'],
      { eb: 'tests/compliance/eb.test.ts' },
      suiteOf({ 'tests/compliance/eb.test.ts': "scan('worker/adapters/eb/index.ts')" })
    );
    expect(g).toEqual({
      uncoveredFamilies: [],
      uncoveredFiles: [],
      missingSuites: [],
      unreferencedFiles: [],
      staleSources: [],
    });
  });

  it('MUTATION: a stale ADAPTER_SOURCES entry for a deleted file is caught', () => {
    const tree = new Map([['library', ['worker/adapters/library/index.ts']]]);
    const g = computeCoverageGaps(
      tree,
      ['worker/adapters/library/index.ts', 'worker/adapters/library/deleted.ts'],
      {},
      suiteOf({})
    );
    expect(g.staleSources).toEqual(['worker/adapters/library/deleted.ts']);
  });

  it('MUTATION: fixture directories are not mistaken for adapter families', () => {
    // __fixtures__ holds captured vendor payloads, not adapter code. If discovery counted
    // them as families they would demand coverage that means nothing — and the resulting
    // noise is how a real gap gets rationalised away.
    const families = discoverAdapterFamilies(ADAPTERS_ROOT);
    for (const dir of NON_CODE_DIRS) expect(families.has(dir)).toBe(false);
    expect([...families.values()].flat().some((f) => f.includes('__fixtures__'))).toBe(false);
  });

  it('MUTATION: discovery of a non-existent root yields nothing rather than throwing', () => {
    expect(discoverAdapterFamilies('worker/adapters-does-not-exist').size).toBe(0);
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
    // `family` is REQUIRED (QA finding A1). These call sites previously omitted it, which
    // is exactly how the mechanism could be a silent no-op — omitting it is now a type
    // error, and these were the two places that proved it.
    const AC = 'https://anc.ca.apm.activecommunities.com';
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/onlinecalendar/filters`, 'activenet')).toBe(true);
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/onlinecalendar/multicenter/events`, 'activenet')).toBe(true);
    expect(isAllowedReadOnlyPost(`${AC}/burnaby/rest/onlinecalendar/filters`, 'activenet')).toBe(true);
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/cart/checkout`, 'activenet')).toBe(false);
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/onlinecalendar/register`, 'activenet')).toBe(false);
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/activities/list`, 'activenet')).toBe(false);
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
        isAllowedReadOnlyPost(`${host}/vancouver/rest/onlinecalendar/filters`, 'activenet'),
        `${host} must not be allowed`
      ).toBe(false);
    }
    expect(isAllowedReadOnlyPost('not a url at all', 'activenet')).toBe(false);
  });

  it('the per-request host guard rejects a non-authorised host for ANY method', () => {
    // Not just POSTs: a GET drifting off the authorised portal is also out of scope.
    expect(() =>
      expectAllowedHost({ url: 'https://anc.ca.apm.activecommunities.com/x', init: {} }, 'activenet')
    ).not.toThrow();
    expect(() => expectAllowedHost({ url: 'https://evil.example.com/x', init: {} }, 'activenet')).toThrow();
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

  it('the allow-list is exactly two families, one adapter file each, two paths each', () => {
    // A drift guard on the exception itself: widening it should be a visible,
    // deliberate edit that fails this assertion first. T8 widened it from one family to
    // two, which is precisely why this assertion had to be edited by hand — that is the
    // mechanism working, not a nuisance.
    expect(READ_ONLY_POST_SEARCH).toHaveLength(2);

    const [activenet, perfectmind] = READ_ONLY_POST_SEARCH;

    expect(activenet.family).toBe('activenet');
    expect(activenet.sourceFiles).toEqual(['worker/adapters/activenet/client.ts']);
    expect(activenet.hosts).toEqual(['anc.ca.apm.activecommunities.com']);
    expect(activenet.postPaths).toEqual([
      '/onlinecalendar/filters',
      '/onlinecalendar/multicenter/events',
    ]);

    expect(perfectmind.family).toBe('perfectmind');
    expect(perfectmind.sourceFiles).toEqual(['worker/adapters/perfectmind/client.ts']);
    // Two hosts because PerfectMind is one tenant per SUBDOMAIN, not per path segment.
    expect(perfectmind.hosts).toEqual(['nvrc.perfectmind.com', 'richmondcity.perfectmind.com']);
    expect(perfectmind.postPaths).toEqual([
      '/BookMe4V2/GetCategoriesDataV2',
      '/BookMe4BookingPagesV2/ClassesV2',
    ]);
    // The registered-COURSES endpoint is deliberately absent: reading it would let the
    // adapter present registered courses as drop-in coverage.
    expect(perfectmind.postPaths).not.toContain('/BookMe4BookingPages/Courses');

    // Three hosts total, all D-10-named. Adding a fourth is a deliberate, visible edit
    // that must fail here first.
    expect(ALLOWED_HOSTS.size).toBe(3);
  });

  it('one family’s host can never license another family’s path (family scoping)', () => {
    // The hole T8 could have opened: with two families in the list, an unscoped check
    // would let an ActiveNet POST path pass on a PerfectMind host and vice versa,
    // because it would only have to satisfy SOME entry. Family scoping is what stops it.
    const PM = 'https://nvrc.perfectmind.com';
    const AC = 'https://anc.ca.apm.activecommunities.com';

    expect(isAllowedReadOnlyPost(`${PM}/23734/Clients/BookMe4BookingPagesV2/ClassesV2`, 'perfectmind')).toBe(true);
    expect(isAllowedReadOnlyPost(`${AC}/vancouver/rest/onlinecalendar/filters`, 'activenet')).toBe(true);

    // Right path, wrong family's host.
    expect(isAllowedReadOnlyPost(`${PM}/vancouver/rest/onlinecalendar/filters`, 'activenet')).toBe(false);
    expect(isAllowedReadOnlyPost(`${AC}/23734/Clients/BookMe4BookingPagesV2/ClassesV2`, 'perfectmind')).toBe(false);
    // Right host, wrong family's path.
    expect(isAllowedReadOnlyPost(`${PM}/vancouver/rest/onlinecalendar/filters`, 'perfectmind')).toBe(false);
    expect(isAllowedReadOnlyPost(`${AC}/23734/Clients/BookMe4BookingPagesV2/ClassesV2`, 'activenet')).toBe(false);

    // Near-miss hostnames must not sneak through a suffix match.
    for (const host of [
      'https://evil.example.com',
      'https://nvrc.perfectmind.com.attacker.example',
      'https://not-nvrc.perfectmind.com',
      'https://perfectmind.com',
    ]) {
      expect(
        isAllowedReadOnlyPost(`${host}/23734/Clients/BookMe4BookingPagesV2/ClassesV2`, 'perfectmind'),
        `${host} must not be allowed`
      ).toBe(false);
    }

    // And the per-request host guard is family-scoped too.
    expect(() => expectAllowedHost({ url: `${PM}/x`, init: {} }, 'perfectmind')).not.toThrow();
    expect(() => expectAllowedHost({ url: `${AC}/x`, init: {} }, 'perfectmind')).toThrow();
    expect(() => expectAllowedHost({ url: `${PM}/x`, init: {} }, 'activenet')).toThrow();
  });

  it('family scoping is LOAD-BEARING, proved on a shared host (QA finding A1)', () => {
    // WHY THIS TEST EXISTS, in QA's words: the assertions above are VACUOUS against the
    // real allow-list. Today's two families have DISJOINT host sets, so the pre-existing
    // host+path coupling already rejects every cross-family combination — deleting the
    // family filter entirely left the whole suite green. A test that cannot fail when the
    // mechanism it names is removed is not a test of that mechanism.
    //
    // So this drives the same matcher against a SYNTHETIC allow-list where two families
    // SHARE a host and differ only by path. That is the only configuration in which
    // family scoping is the sole thing standing between family A's host and family B's
    // path — and it is a configuration the real list could grow into at any time (two
    // tenants of the same vendor, or a vendor consolidating onto one hostname).
    const SHARED = 'shared.example.com';
    const synthetic: ReadOnlyPostSearchFamily[] = [
      {
        family: 'alpha',
        sourceFiles: [],
        hosts: [SHARED],
        hostConfigFile: '',
        postPaths: ['/alpha/search'],
        getPaths: [],
        endpointPathPattern: /x/g,
      },
      {
        family: 'beta',
        sourceFiles: [],
        hosts: [SHARED],
        hostConfigFile: '',
        postPaths: ['/beta/search'],
        getPaths: [],
        endpointPathPattern: /x/g,
      },
    ];

    // Each family reaches its own path on the shared host.
    expect(matchesReadOnlyPost(synthetic, `https://${SHARED}/alpha/search`, 'alpha')).toBe(true);
    expect(matchesReadOnlyPost(synthetic, `https://${SHARED}/beta/search`, 'beta')).toBe(true);

    // THE ASSERTION THAT ONLY FAMILY SCOPING CAN SATISFY: same host, other family's path.
    // Remove the `.filter(f => f.family === family)` from matchesReadOnlyPost and these
    // two flip to true — which is precisely the mutation QA ran to prove the old test was
    // vacuous. Verified by hand-running that mutation; both go red.
    expect(matchesReadOnlyPost(synthetic, `https://${SHARED}/beta/search`, 'alpha')).toBe(false);
    expect(matchesReadOnlyPost(synthetic, `https://${SHARED}/alpha/search`, 'beta')).toBe(false);

    // An unknown family name matches nothing at all — a typo fails closed, not open.
    expect(matchesReadOnlyPost(synthetic, `https://${SHARED}/alpha/search`, 'gamma')).toBe(false);
  });

  it('the registered-COURSES endpoint appears nowhere in the PerfectMind adapter', () => {
    // Not a compliance bypass — a HONESTY guard, and the reason it lives in this file is
    // that it has the same "must be a visible, deliberate edit" property. G-T8-1 found
    // Richmond exposes 1,207 registered courses and ZERO drop-in occurrences; reading
    // the Courses endpoint would let a future change quietly present those as drop-in
    // coverage, which is the single outcome the task's acceptance criteria forbid.
    for (const rel of ADAPTER_SOURCES.filter((f) => f.startsWith('worker/adapters/perfectmind/'))) {
      const code = stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8'));
      expect(code, `${rel} must not reference the registered-Courses endpoint`).not.toMatch(
        /BookMe4BookingPages\/Courses/
      );
    }
  });
});
