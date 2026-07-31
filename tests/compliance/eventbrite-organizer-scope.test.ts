// tests/compliance/eventbrite-organizer-scope.test.ts — G-T10-2 (IR-03, TSD §5 row 10).
//
// THE ACCEPTANCE CRITERION THIS FILE ENFORCES
//   "The connector only pulls configured organizer feeds; no anonymous area-query path
//    exists."  Note the verb: EXISTS, not "is used". So this suite is written to the same
//   standard tests/compliance/no-bypass.test.ts holds T7/T8 to — the guarantee has to be
//   PROVABLY ABSENT from the code, not merely absent from the happy path.
//
// WHY THIS IS A SEPARATE FILE FROM no-bypass.test.ts, stated plainly.
//   no-bypass bans the Authorization header outright for every adapter in its
//   ADAPTER_SOURCES list, and correctly: those adapters read PUBLIC pages, where a
//   credential could only mean logging in as somebody to reach content we were not
//   offered. This family is the opposite case BY DEFINITION — Eventbrite has no
//   anonymous read path at all, so an organizer-granted bearer token is the only way to
//   satisfy "organizer-owned/authorized feeds only" rather than a way around it.
//
//   That is a real narrowing, so it is handled the way T7/T8's POST narrowing was — named,
//   scoped and re-proven, never silently omitted. Concretely, this file:
//     • re-runs EVERY prohibition from no-bypass's structural scan against the eventbrite
//       sources (CAPTCHA · password · Cookie · credentials:'include' · headless
//       navigation/library · checkout/cart · anti-forgery token · POST · PUT/PATCH/DELETE),
//       so coverage is COMPLETE, not reduced;
//     • narrows exactly ONE item — the Authorization header — permitted only in
//       worker/adapters/eventbrite/client.ts and only as a bearer token read from an env
//       var, asserted by shape, with the token proven absent from every URL;
//     • adds prohibitions no-bypass does not have, because this family needs them: the
//       anonymous area-query surface (`/v3/events/search`, `location.*`, `q`, `within`,
//       `categories`) must appear nowhere in the code at all.
//   Structure mirrors no-bypass deliberately: (A) behavioural, (B) structural, (C) the
//   tripwire tests itself.
//
// CONTEXT — Eventbrite retired the anonymous search endpoint themselves (2019-12-12
// removed, 2020-02-20 fully denied), and their own migration note points callers at the
// organizer-scoped endpoint this adapter uses. That is a helpful fact, NOT the guarantee:
// it is a statement about today's vendor, not about our code. Everything below assumes it
// could come back tomorrow.
//
// FIXTURE-ONLY BY NECESSITY: no organizer has authorised KIDS FUN, so EVENTBRITE_ORGANIZERS
// is empty (worker/adapters/eventbrite/config.ts, "HONEST ZERO"). The behavioural tests
// therefore drive the adapter with a TEST-OWNED synthetic organizer config, declared here
// rather than shipped in config.ts — proving the code without pretending a partner exists.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EventbriteAdapter,
  EVENTBRITE_ORGANIZERS,
  organizerTokenEnvVar,
  type EventbriteOrganizerConfig,
} from '../../worker/adapters/eventbrite';
import {
  assertOrganizerScopedUrl,
  buildOrganizationEventsUrl,
  ALLOWED_QUERY_PARAMS,
  OrganizerScopeViolationError,
} from '../../worker/adapters/eventbrite/client';
import { EVENTBRITE_API_HOST } from '../../worker/adapters/eventbrite/config';
import { clearPolicyState } from '../../worker/health/policy';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
  clearPolicyState();
});

// ── the test-owned synthetic organizer ────────────────────────────────────────
//
// Declared in the TEST, never in config.ts. config.ts's list is a statement that a real
// organizer authorised us; this is a statement that the CODE works. Keeping them apart is
// the whole reason the shipped list can stay honestly empty.
const TEST_ORGANIZER_KEY = 'test_partner';
const TEST_ORGANIZATION_ID = '987654321098';

const TEST_ORGANIZER: EventbriteOrganizerConfig = {
  organizerKey: TEST_ORGANIZER_KEY,
  organizationId: TEST_ORGANIZATION_ID,
  organizerName: 'Test Partner Organizer',
  sourceFamily: 'eventbrite_organizer',
  sourceName: 'Test Partner Organizer Eventbrite',
  municipality: 'Vancouver',
  timezone: 'America/Vancouver',
  authorisationNote: 'SYNTHETIC — test fixture only, no real organizer authorised anything.',
  tokenEnvVar: organizerTokenEnvVar(TEST_ORGANIZER_KEY),
  enabled: true,
  maxRequestsPerRun: 5,
  maxEventsPerRun: 100,
};

const FIXTURE_BODY = readFileSync(
  resolve(process.cwd(), 'worker/adapters/eventbrite/__fixtures__/organization-events.json'),
  'utf8'
);

const TEST_TOKEN = 'EBTESTTOKEN0000000000';

/**
 * The anonymous-area-query parameters IR-03 forbids. Declared HERE, in the test, and
 * deliberately NOT in the adapter — same reasoning as no-bypass.test.ts's own allow-list:
 * a tripwire that reads its rules from the code it polices can be widened by editing that
 * code alone. (And a deny-list ARRAY inside the adapter would be indistinguishable, to the
 * structural scan below, from the area-query code it is meant to ban.) The adapter's
 * guarantee is the CLOSED allow-list plus the `location.` prefix guard; this list is how
 * the test proves those actually reject the real-world surface.
 */
const FORBIDDEN_QUERY_PARAMS: readonly string[] = [
  'location.address',
  'location.latitude',
  'location.longitude',
  'location.within',
  'location.viewport.northeast.latitude',
  'location.viewport.southwest.longitude',
  'q',
  'categories',
  'subcategories',
  'within',
  'organizer.id',
];

interface CapturedCall {
  url: string;
  init: (RequestInit & { credentials?: string }) | undefined;
}

function mockFetchCapture(body: string): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init?: unknown) => {
    calls.push({ url: String(input), init: init as CapturedCall['init'] });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  return calls;
}

function headerLookup(init: CapturedCall['init'], name: string): string | undefined {
  const h = (init?.headers ?? {}) as Record<string, string> | Headers;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  // Normalise through the native Headers API so this checker sees exactly what the
  // transport would send — same reasoning as no-bypass's headerLookup (QA finding A2).
  return new Headers(h as Record<string, string>).get(name) ?? undefined;
}

/** Live the synthetic organizer: env allow-list + token, both required. */
function enableTestOrganizer(): void {
  process.env.KIDS_FUN_LIVE_EVENTBRITE = TEST_ORGANIZER_KEY;
  process.env[TEST_ORGANIZER.tokenEnvVar] = TEST_TOKEN;
}

// ── (A) behavioural: what the real adapter code actually sends ────────────────

describe('G-T10-2 (A) every request is organizer-scoped, by path, on the exact API host', () => {
  it('the ONLY request it makes is GET /v3/organizations/{configured id}/events/', async () => {
    enableTestOrganizer();
    const adapter = new EventbriteAdapter(TEST_ORGANIZER);
    expect(adapter.isLiveFetchEnabled()).toBe(true);

    const calls = mockFetchCapture(FIXTURE_BODY);
    await adapter.fetch();

    expect(calls.length, 'one page, one request (fixture reports has_more_items:false)').toBe(1);
    const url = new URL(calls[0].url);
    expect(url.protocol).toBe('https:');
    // EXACT hostname, never endsWith.
    expect(url.hostname).toBe(EVENTBRITE_API_HOST);
    expect(url.pathname).toBe(`/v3/organizations/${TEST_ORGANIZATION_ID}/events/`);
    // The organizer id is in the PATH, so the request cannot return anyone else's events.
    expect(url.pathname).toContain(TEST_ORGANIZATION_ID);
    const method = (calls[0].init?.method ?? 'GET').toString().toUpperCase();
    expect(method, 'a read, and only a read').toBe('GET');
    expect(calls[0].init?.body ?? null, 'a GET carries no body').toBeNull();
  });

  it('the query string is the CLOSED allow-list — no area/geo/free-text parameter, ever', async () => {
    enableTestOrganizer();
    const calls = mockFetchCapture(FIXTURE_BODY);
    await new EventbriteAdapter(TEST_ORGANIZER).fetch();

    const params = new URL(calls[0].url).searchParams;
    const sent = [...params.keys()].sort();
    // A CLOSED expected set: anything new here is a deliberate, visible edit — the same
    // discipline no-bypass applies to PerfectMind's POST body fields.
    expect(sent).toEqual([...Object.keys(ALLOWED_QUERY_PARAMS)].sort());
    for (const banned of FORBIDDEN_QUERY_PARAMS) {
      expect(params.has(banned), `forbidden parameter ${banned} must be absent`).toBe(false);
    }
    for (const name of sent) {
      expect(name.startsWith('location.'), `no location.* parameter (${name})`).toBe(false);
    }
  });

  it('the organizer token travels ONLY as a bearer header — never in the URL', async () => {
    enableTestOrganizer();
    const calls = mockFetchCapture(FIXTURE_BODY);
    await new EventbriteAdapter(TEST_ORGANIZER).fetch();

    // The narrowed prohibition, asserted by shape rather than merely permitted.
    expect(headerLookup(calls[0].init, 'authorization')).toBe(`Bearer ${TEST_TOKEN}`);
    // …and everything that is NOT narrowed still holds.
    expect(headerLookup(calls[0].init, 'cookie'), 'no Cookie (no session replay)').toBeUndefined();
    expect(calls[0].init?.credentials, "no credentials:'include'").not.toBe('include');
    const ua = headerLookup(calls[0].init, 'user-agent');
    expect(ua, 'identified bot UA').toMatch(/KidsFunBot/i);
    expect(ua, 'not a browser spoof').not.toMatch(/Mozilla/i);

    // The credential must not be reachable from a log line, a Referer, or an error string.
    expect(calls[0].url).not.toContain(TEST_TOKEN);
    expect(calls[0].url).not.toMatch(/token=|auth=|key=/i);
    expect(calls[0].url).not.toMatch(/login|signin|account|checkout|cart/i);
  });

  it('extract() yields only organizer-owned, placeable, live events (fixture-backed)', async () => {
    enableTestOrganizer();
    mockFetchCapture(FIXTURE_BODY);
    const adapter = new EventbriteAdapter(TEST_ORGANIZER);
    const records = adapter.extract(await adapter.fetch());

    // The fixture holds 4 events: 2 ingestable, 1 cancelled, 1 online-only.
    expect(records.map((r) => r.sourceRecordId)).toEqual(['000000000001', '000000000002']);

    const [storytime, workshop] = records;
    expect(storytime.title).toBe('Family Storytime & Craft Morning');
    expect(storytime.startDatetimeUtc).toBe('2026-08-12T17:00:00Z');
    expect(storytime.endDatetimeUtc).toBe('2026-08-12T18:30:00Z');
    expect(storytime.venueName).toBe('Placeholder Community Hall');
    expect(storytime.venueLat).toBeCloseTo(49.2827, 4);
    expect(storytime.venueLng).toBeCloseTo(-123.1207, 4);
    expect(storytime.venueMunicipalityName).toBe('Vancouver');
    expect(storytime.costStatus).toBe('free');
    expect(storytime.costMinCad).toBe(0);
    // Age wording is pulled from prose by the SHARED extractor (worker/core/age.ts),
    // preferring an explicit numeric range over a bare audience keyword.
    expect(storytime.ageText).toMatch(/aged 3-6/i);

    expect(workshop.costStatus).toBe('known');
    expect(workshop.costMinCad).toBe(12);
    expect(workshop.costMaxCad).toBe(18);
    expect(workshop.ageText).toMatch(/ages 7-11/i);

    // Dedup keys are organizer-namespaced, so two organizers can never collide.
    expect(adapter.dedupKeys(storytime).key).toBe(
      `eventbrite_organizer::${TEST_ORGANIZER_KEY}::000000000001`
    );
  });

  it('a cancelled event and an online-only event are dropped deliberately', async () => {
    enableTestOrganizer();
    mockFetchCapture(FIXTURE_BODY);
    const adapter = new EventbriteAdapter(TEST_ORGANIZER);
    const ids = adapter.extract(await adapter.fetch()).map((r) => r.sourceRecordId);
    expect(ids, 'cancelled listing never enters the pipeline').not.toContain('000000000003');
    // KIDS FUN answers "near us, at this time"; an online event has no venue and no
    // distance, so it is excluded rather than ingested as an unplaceable row.
    expect(ids, 'online-only listing is not a placeable activity').not.toContain('000000000004');
  });

  it('follows the continuation cursor WITHIN one organizer — the path never changes', async () => {
    enableTestOrganizer();
    let call = 0;
    const calls: CapturedCall[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init?: unknown) => {
      calls.push({ url: String(input), init: init as CapturedCall['init'] });
      const body =
        call++ === 0
          ? JSON.stringify({
              pagination: { has_more_items: true, continuation: 'cursor-2' },
              events: [{ id: 'p1', name: { text: 'Page one' }, start: { utc: '2026-08-01T17:00:00Z' }, status: 'live' }],
            })
          : JSON.stringify({
              pagination: { has_more_items: false, continuation: null },
              events: [{ id: 'p2', name: { text: 'Page two' }, start: { utc: '2026-08-02T17:00:00Z' }, status: 'live' }],
            });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);

    vi.useFakeTimers();
    const pending = new EventbriteAdapter(TEST_ORGANIZER).fetch();
    await vi.advanceTimersByTimeAsync(60_000);
    const raw = await pending;
    vi.useRealTimers();

    expect((raw as Array<{ id: string }>).map((e) => e.id)).toEqual(['p1', 'p2']);
    expect(calls.length).toBe(2);
    // BOTH requests stay on the same organizer-scoped path — paging widens nothing.
    for (const c of calls) {
      const u = new URL(c.url);
      expect(u.hostname).toBe(EVENTBRITE_API_HOST);
      expect(u.pathname).toBe(`/v3/organizations/${TEST_ORGANIZATION_ID}/events/`);
    }
    expect(new URL(calls[0].url).searchParams.has('continuation')).toBe(false);
    expect(new URL(calls[1].url).searchParams.get('continuation')).toBe('cursor-2');
  });
});

describe('G-T10-2 (A) an unauthorised organizer makes ZERO network calls', () => {
  // The load-bearing default, exactly as no-bypass's zero-network assertions are for T7/T8:
  // an organizer is fixture-only unless EVERY gate names it.
  it('no env allow-list → not live, zero requests', async () => {
    delete process.env.KIDS_FUN_LIVE_EVENTBRITE;
    process.env[TEST_ORGANIZER.tokenEnvVar] = TEST_TOKEN;
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new EventbriteAdapter(TEST_ORGANIZER);
    expect(adapter.isLiveFetchEnabled()).toBe(false);
    expect(Array.isArray(await adapter.fetch())).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('env allow-list but NO token → not live, zero requests (the gate that matters today)', async () => {
    process.env.KIDS_FUN_LIVE_EVENTBRITE = TEST_ORGANIZER_KEY;
    delete process.env[TEST_ORGANIZER.tokenEnvVar];
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new EventbriteAdapter(TEST_ORGANIZER);
    expect(adapter.isLiveFetchEnabled(), 'a missing credential keeps it off').toBe(false);
    await adapter.fetch();
    expect(spy).not.toHaveBeenCalled();
  });

  it('an empty/whitespace token is treated as absent, not as a credential', async () => {
    process.env.KIDS_FUN_LIVE_EVENTBRITE = TEST_ORGANIZER_KEY;
    process.env[TEST_ORGANIZER.tokenEnvVar] = '   ';
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(new EventbriteAdapter(TEST_ORGANIZER).isLiveFetchEnabled()).toBe(false);
    await new EventbriteAdapter(TEST_ORGANIZER).fetch();
    expect(spy).not.toHaveBeenCalled();
  });

  it('config `enabled:false` keeps it off even when env AND token are present', async () => {
    // Same shape as Richmond/West Vancouver under T8/T7: an operator cannot enable a feed
    // the config says is not authorised merely by setting an env var.
    enableTestOrganizer();
    const spy = vi.spyOn(globalThis, 'fetch');
    const adapter = new EventbriteAdapter({ ...TEST_ORGANIZER, enabled: false });
    expect(adapter.isLiveFetchEnabled()).toBe(false);
    await adapter.fetch();
    expect(spy).not.toHaveBeenCalled();
  });

  it('an organizer NOT named in the allow-list stays fixture-only', async () => {
    process.env.KIDS_FUN_LIVE_EVENTBRITE = 'someone_else';
    process.env[TEST_ORGANIZER.tokenEnvVar] = TEST_TOKEN;
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(new EventbriteAdapter(TEST_ORGANIZER).isLiveFetchEnabled()).toBe(false);
    await new EventbriteAdapter(TEST_ORGANIZER).fetch();
    expect(spy).not.toHaveBeenCalled();
  });

  it('the SHIPPED configuration authorises nobody, so nothing can fetch at all', async () => {
    // The honest zero, asserted rather than described. If an entry ever appears in
    // EVENTBRITE_ORGANIZERS this fails, which is the intended forcing function: adding one
    // is a claim that a named organizer authorised KIDS FUN, and must be a visible edit
    // accompanied by the docs/source-register.md evidence.
    expect(EVENTBRITE_ORGANIZERS).toEqual([]);
    process.env.KIDS_FUN_LIVE_EVENTBRITE = 'anything,at,all';
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const config of EVENTBRITE_ORGANIZERS) {
      await new EventbriteAdapter(config).fetch();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── (A2) the runtime tripwire, driven adversarially ──────────────────────────

describe('G-T10-2 (A) assertOrganizerScopedUrl rejects every anonymous-area shape', () => {
  const ORG = `https://${EVENTBRITE_API_HOST}/v3/organizations/${TEST_ORGANIZATION_ID}/events/`;

  it('accepts the one permitted shape', () => {
    expect(() => assertOrganizerScopedUrl(new URL(ORG))).not.toThrow();
    expect(() => buildOrganizationEventsUrl(TEST_ORGANIZATION_ID)).not.toThrow();
  });

  it('rejects the RETIRED anonymous area-search endpoint outright', () => {
    for (const path of [
      '/v3/events/search/',
      '/v3/events/search/?location.address=vancouver&location.within=25km',
      '/v3/destination/search/',
      '/v3/events/',
      '/v3/organizations/123/orders/',
      '/v3/users/me/owned_events/',
    ]) {
      expect(
        () => assertOrganizerScopedUrl(new URL(`https://${EVENTBRITE_API_HOST}${path}`)),
        `${path} must be rejected`
      ).toThrow(OrganizerScopeViolationError);
    }
  });

  it('rejects a smuggled area/geo/free-text parameter on the PERMITTED path', () => {
    // The subtle attack the path check alone would miss: right endpoint, widened query.
    for (const q of [
      'location.address=vancouver',
      'location.within=25km',
      'location.latitude=49.28',
      'location.viewport.northeast.latitude=49.3',
      'q=kids',
      'categories=115',
      'within=25km',
      'organizer.id=999',
    ]) {
      const url = new URL(`${ORG}?${q}`);
      expect(() => assertOrganizerScopedUrl(url), `${q} must be rejected`).toThrow(
        OrganizerScopeViolationError
      );
    }
  });

  it('rejects ANY parameter outside the closed allow-list, not just known-bad ones', () => {
    // Fail-closed: an unrecognised parameter is rejected even though nobody predicted it.
    expect(() => assertOrganizerScopedUrl(new URL(`${ORG}?some_new_vendor_param=1`))).toThrow(
      OrganizerScopeViolationError
    );
  });

  it('rejects look-alike hosts (exact match, never a suffix match)', () => {
    for (const host of [
      'www.eventbriteapi.com.attacker.example',
      'not-www.eventbriteapi.com',
      'eventbriteapi.com',
      'www.eventbrite.com',
      'evil.example.com',
      'localhost:8080',
    ]) {
      expect(
        () => assertOrganizerScopedUrl(new URL(`https://${host}/v3/organizations/1/events/`)),
        `${host} must be rejected`
      ).toThrow(OrganizerScopeViolationError);
    }
  });

  it('rejects plaintext http, and a credential smuggled into the query string', () => {
    expect(() => assertOrganizerScopedUrl(new URL(`http://${EVENTBRITE_API_HOST}/v3/organizations/1/events/`))).toThrow(
      OrganizerScopeViolationError
    );
    for (const q of ['token=secret', 'access_token=secret', 'api_key=secret', 'auth=secret']) {
      expect(() => assertOrganizerScopedUrl(new URL(`${ORG}?${q}`)), `${q} must be rejected`).toThrow(
        OrganizerScopeViolationError
      );
    }
  });

  it('QA F2 — an opaque cursor VALUE containing "auth"/"token" is legitimate, not a credential', () => {
    // The regression QA found: the credential check used to match /token|auth|key=/ against
    // the whole query STRING, which includes VALUES. Eventbrite's continuation cursor is an
    // opaque vendor-generated blob, so one that merely contains those letters aborted a
    // perfectly legitimate run. We control parameter NAMES; we do not control the vendor's
    // cursor alphabet. Every one of these threw before the fix.
    for (const cursor of ['abcAUTHxyz', 'tokenish123', 'MTIzauth456', 'keyed=stuff', 'AUTHORIZATION']) {
      expect(
        () => buildOrganizationEventsUrl(TEST_ORGANIZATION_ID, cursor),
        `cursor ${cursor} is opaque vendor data, not a credential`
      ).not.toThrow();
    }
    // …and the NAME-based check still bites, so the fix narrowed the signal without
    // weakening the guarantee.
    expect(() => assertOrganizerScopedUrl(new URL(`${ORG}?access_token=x`))).toThrow(
      /credential-shaped query parameter/
    );
  });

  it('QA F4 — the location.* guard is the thing that fires, not the allow-list in front of it', () => {
    // QA correctly observed the prefix guard is redundant while the allow-list stays closed,
    // and it is kept for the case where that stops being true (see client.ts). "Kept for a
    // reason" has to be checkable, so this pins WHICH rejection fires, by message: a
    // location.* parameter must be refused as an AREA QUERY specifically.
    expect(() => assertOrganizerScopedUrl(new URL(`${ORG}?location.address=vancouver`))).toThrow(
      /forbidden area-query parameter/
    );
    // A merely-unknown parameter takes the other branch — proving the two are distinct and
    // that the assertion above is not just the allow-list wearing the area-query's name.
    expect(() => assertOrganizerScopedUrl(new URL(`${ORG}?some_new_vendor_param=1`))).toThrow(
      /not in the closed allow-list/
    );
  });

  it('rejects a request for an organization OTHER than the configured one', () => {
    // Organizer scope is not merely "some organization" — it is THE configured one.
    expect(() => assertOrganizerScopedUrl(new URL(ORG), TEST_ORGANIZATION_ID)).not.toThrow();
    expect(() => assertOrganizerScopedUrl(new URL(ORG), '111111111111')).toThrow(
      OrganizerScopeViolationError
    );
  });

  it('an organizationId carrying path/query characters cannot escape its segment', () => {
    for (const id of ['1/../../events/search', '1?location.address=x', '1/events', '../users/me', '']) {
      expect(() => buildOrganizationEventsUrl(id), `${id} must be rejected`).toThrow(
        OrganizerScopeViolationError
      );
    }
  });
});

// ── (B) structural: scan the real source for area-query + bypass fingerprints ─

/** Strip block + line comments, preserving `https://` inside string literals — so the
 *  explanatory comments in these files (which NAME the forbidden endpoints in order to
 *  ban them) can never satisfy or mask the scan. Same implementation as no-bypass's. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const EVENTBRITE_SOURCES = [
  'worker/adapters/eventbrite/index.ts',
  'worker/adapters/eventbrite/config.ts',
  'worker/adapters/eventbrite/client.ts',
];

/** The file permitted to carry the ONE narrowed prohibition (Authorization). Declared
 *  HERE, in the test, not imported from the code it polices — widening it must be an
 *  edit to this file, exactly as no-bypass declares its own allow-list. */
const AUTH_HEADER_ALLOWED_FILES = new Set(['worker/adapters/eventbrite/client.ts']);

interface Pattern {
  label: string;
  re: RegExp;
}

/**
 * The anonymous-area-query surface. These are the fingerprints of the thing IR-03 forbids,
 * and none may appear in CODE anywhere in this family — including the allow-listed file.
 */
const AREA_QUERY_PATTERNS: Pattern[] = [
  { label: 'anonymous event-search endpoint', re: /events\s*\/\s*search/i },
  { label: 'discovery/destination search endpoint', re: /\/destination\//i },
  { label: 'geo area filter (location.*)', re: /location\.(address|latitude|longitude|within|viewport)/i },
  { label: 'radius filter', re: /["'`]within["'`]\s*[,:]/i },
  { label: 'free-text search parameter', re: /["'`]q["'`]\s*:/i },
  { label: 'category sweep parameter', re: /["'`](categories|subcategories)["'`]\s*:/i },
];

/** Every prohibition no-bypass.test.ts applies, re-declared so coverage is COMPLETE for a
 *  family that is deliberately outside that file's ADAPTER_SOURCES list. */
const BYPASS_PATTERNS: Pattern[] = [
  { label: 'CAPTCHA handling', re: /captcha/i },
  { label: 'password credential', re: /\bpassword\b/i },
  { label: 'Cookie/session header', re: /["']?cookie["']?\s*:/i },
  { label: "credentials:'include'", re: /credentials\s*:\s*['"]?include/i },
  { label: 'headless-browser navigation', re: /\bpage\.(goto|type|click|fill|waitForSelector|evaluate|setContent)\b/i },
  { label: 'headless-browser library', re: /\b(puppeteer|playwright)\b/i },
  { label: 'checkout/cart flow', re: /\b(checkout|add[_-]?to[_-]?cart)\b/i },
  { label: 'anti-forgery token submit', re: /(__requestverificationtoken|x-csrf-token|csrf[_-]?token)/i },
  { label: 'mutating HTTP method (PUT/PATCH/DELETE)', re: /method\s*:\s*['"](put|patch|delete)['"]/i },
  // POST stays absolutely banned for this family — unlike T7/T8, nothing here needs a
  // POST-as-query, so no narrowing is claimed.
  { label: 'POST method', re: /method\s*:\s*['"]post['"]/i },
];

const AUTH_HEADER_PATTERN: Pattern = { label: 'Authorization header', re: /authorization\s*:/i };

/** Pure scanner so (C) below can exercise it on synthetic code. */
function scanEventbriteSource(rawSource: string, authHeaderAllowed: boolean): string[] {
  const code = stripComments(rawSource);
  const patterns = [...AREA_QUERY_PATTERNS, ...BYPASS_PATTERNS];
  if (!authHeaderAllowed) patterns.push(AUTH_HEADER_PATTERN);
  return patterns.filter(({ re }) => re.test(code)).map(({ label }) => label);
}

describe('G-T10-2 (B) no anonymous area-query path EXISTS in the adapter source', () => {
  for (const rel of EVENTBRITE_SOURCES) {
    it(`${rel} is free of area-query and bypass fingerprints`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
      const violations = scanEventbriteSource(src, AUTH_HEADER_ALLOWED_FILES.has(rel));
      expect(violations, `${rel} must not contain: ${violations.join(', ')}`).toEqual([]);
    });
  }

  it('only client.ts may carry an Authorization header at all', () => {
    for (const rel of EVENTBRITE_SOURCES) {
      if (AUTH_HEADER_ALLOWED_FILES.has(rel)) continue;
      const code = stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8'));
      expect(AUTH_HEADER_PATTERN.re.test(code), `${rel} must not send Authorization`).toBe(false);
    }
  });

  it('the permitted Authorization value is a bearer token read from the environment', () => {
    // Not merely "an Authorization header exists" — it must be the narrow thing that was
    // authorised: `Bearer ${token}`, with the token sourced from an env var, never a literal.
    const code = stripComments(
      readFileSync(resolve(process.cwd(), 'worker/adapters/eventbrite/client.ts'), 'utf8')
    );
    expect(code).toMatch(/Authorization\s*:\s*`Bearer \$\{token\}`/);
    // No hard-coded credential-shaped literal anywhere in the family.
    for (const rel of EVENTBRITE_SOURCES) {
      const src = stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8'));
      expect(src, `${rel} must not embed a token literal`).not.toMatch(/['"`]Bearer [A-Za-z0-9._-]{8,}/);
    }
    const index = stripComments(
      readFileSync(resolve(process.cwd(), 'worker/adapters/eventbrite/index.ts'), 'utf8')
    );
    expect(index, 'the token comes from process.env, named by config').toMatch(
      /process\.env\[config\.tokenEnvVar\]/
    );
  });

  it('the API host is pinned in config — repointing it fails HERE', () => {
    // Same mechanism as no-bypass's hostConfigFile assertion: asserting the host is the
    // ONLY host literal in config.ts is what makes a REPOINT fail, not just a deletion.
    const code = stripComments(
      readFileSync(resolve(process.cwd(), 'worker/adapters/eventbrite/config.ts'), 'utf8')
    );
    const hosts = new Set<string>();
    for (const m of code.matchAll(/['"`]([a-z0-9-]+(?:\.[a-z0-9-]+)+)['"`]/gi)) {
      if (/\.[a-z]{2,}$/i.test(m[1]) && !/\.(ts|tsx|js|json|sql|md|css|svg|png)$/i.test(m[1])) {
        hosts.add(m[1].toLowerCase());
      }
    }
    for (const m of code.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) {
      hosts.add(m[1].toLowerCase());
    }
    expect([...hosts]).toEqual([EVENTBRITE_API_HOST]);
  });

  it('the client declares ONLY the organizer-scoped endpoint path', () => {
    // Second layer under the behavioural check: a path that never runs in a test still
    // cannot be introduced silently, because the file's v3 path literals are pinned.
    const code = stripComments(
      readFileSync(resolve(process.cwd(), 'worker/adapters/eventbrite/client.ts'), 'utf8')
    );
    const declared = [...new Set(code.match(/\/v3\/[A-Za-z0-9_{}\-/]*/g) ?? [])];
    expect(declared.length, 'client.ts declares at least one v3 path').toBeGreaterThan(0);
    for (const path of declared) {
      expect(
        path.startsWith('/v3/organizations/'),
        `client.ts declares a non-organizer-scoped endpoint path: ${path}`
      ).toBe(true);
    }
  });

  // ── QA F1: the tripwire's CALL SITES, pinned ────────────────────────────────
  //
  // WHY THIS EXISTS, in QA's words: assertOrganizerScopedUrl() itself was thoroughly
  // mutation-tested, but the WIRING to it was not — QA deleted the single call inside
  // buildOrganizationEventsUrl and the ENTIRE suite stayed green (1314/1314 unit, 385 db,
  // both tsc, eslint), byte-identical to baseline. A guarantee whose invocation nothing
  // pins is a guarantee one keystroke from being decorative. Same class as no-bypass's own
  // historical A1 finding, which this project treats as must-fix.
  //
  // Two things are pinned here, not one: that each call site EXISTS, and that the
  // fetch-path one runs BEFORE the request. The ordering half is the other half of F1 —
  // QA's defeat attempt appended a parameter to the url AFTER the builder returned, which
  // the tripwire never saw. Asserting mere presence would not have caught that.

  /**
   * A named function's body, brace-matched. Input must already be comment-stripped.
   *
   * The parameter list is skipped by PAREN-matching first, before looking for the opening
   * brace. Found the hard way: `fetchOrganizerEvents`'s signature contains
   * `opts: { fetchImpl?: typeof fetch } = {}`, so naively taking the first `{` after the
   * function name returned the PARAMETER TYPE as the body — an assertion that would then
   * have passed or failed for reasons having nothing to do with the code it was policing.
   */
  function functionBody(code: string, name: string): string {
    const sig = new RegExp(`function\\s+${name}\\s*\\(`).exec(code);
    if (!sig) throw new Error(`function ${name} not found — did it get renamed?`);
    // Paren-match across the whole parameter list, however many braces it contains.
    let parens = 0;
    let afterParams = -1;
    for (let i = sig.index + sig[0].length - 1; i < code.length; i += 1) {
      if (code[i] === '(') parens += 1;
      else if (code[i] === ')') {
        parens -= 1;
        if (parens === 0) {
          afterParams = i + 1;
          break;
        }
      }
    }
    if (afterParams === -1) throw new Error(`unbalanced parameter list reading ${name}`);
    const open = code.indexOf('{', afterParams);
    if (open === -1) throw new Error(`no body found for ${name}`);
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) return code.slice(open, i + 1);
      }
    }
    throw new Error(`unbalanced braces reading ${name}`);
  }

  const GUARD_CALL = 'assertOrganizerScopedUrl(';
  const FETCH_CALL = 'politeFetch(';

  function clientCode(): string {
    return stripComments(
      readFileSync(resolve(process.cwd(), 'worker/adapters/eventbrite/client.ts'), 'utf8')
    );
  }

  it('the URL BUILDER calls the tripwire — deleting that call fails HERE', () => {
    expect(
      functionBody(clientCode(), 'buildOrganizationEventsUrl'),
      'buildOrganizationEventsUrl must call assertOrganizerScopedUrl'
    ).toContain(GUARD_CALL);
  });

  it('the FETCH PATH calls the tripwire, and calls it BEFORE the request', () => {
    const body = functionBody(clientCode(), 'fetchOrganizerEvents');
    expect(body, 'fetchOrganizerEvents must assert on the final url').toContain(GUARD_CALL);
    expect(body, 'fetchOrganizerEvents must actually issue the request here').toContain(FETCH_CALL);
    // The ordering half. An assert AFTER the fetch validates nothing that was sent.
    expect(
      body.indexOf(GUARD_CALL),
      'the tripwire must run BEFORE politeFetch, not after it'
    ).toBeLessThan(body.indexOf(FETCH_CALL));
  });

  it('there is exactly ONE request call site in the whole family, and it is the guarded one', () => {
    // The ordering pin above is only meaningful if there is ONE place a request can be
    // issued from. A second, unguarded request elsewhere would slip past it entirely.
    for (const rel of EVENTBRITE_SOURCES) {
      const code = stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8'));
      const expected = rel.endsWith('client.ts') ? 1 : 0;
      expect(
        [...code.matchAll(/\b(politeFetch|guardedLiveFetch)\s*\(/g)].length,
        `${rel} must contain exactly ${expected} polite-fetch call site(s)`
      ).toBe(expected);

      // …and nothing in the family may call the GLOBAL fetch directly, bypassing the
      // politeness/terms seam. The Adapter interface's own `fetch()` METHOD shares the
      // name and is not a network call, so it is neutralised first rather than being
      // matched and excused — otherwise this assertion would be reporting on the wrong
      // thing while looking green.
      const withoutAdapterMethod = code.replace(/\basync\s+fetch\s*\(\s*\)/g, 'ADAPTER_FETCH_METHOD');
      expect(
        [...withoutAdapterMethod.matchAll(/(?<![.\w])fetch\s*\(/g)].length,
        `${rel} must not call the global fetch directly — every request goes through politeFetch`
      ).toBe(0);
    }
  });

  // (C)-style self-checks: a pin nobody has proved can fail is not a pin. These drive the
  // SAME helpers against synthetic bodies carrying exactly the mutations QA performed.
  it('(C) the call-site pin BITES: a builder body with the guard removed is caught', () => {
    const mutated = `
      function buildOrganizationEventsUrl(organizationId, continuation) {
        const url = new URL('https://host/v3/organizations/' + organizationId + '/events/');
        return url;
      }`;
    expect(functionBody(mutated, 'buildOrganizationEventsUrl')).not.toContain(GUARD_CALL);
  });

  it('(C) the ORDERING pin BITES: an assert placed after the fetch is caught', () => {
    const mutated = `
      async function fetchOrganizerEvents(config, token) {
        const url = buildOrganizationEventsUrl(config.organizationId);
        const response = await politeFetch(key, url, {}, {});
        assertOrganizerScopedUrl(url, config.organizationId);
        return response;
      }`;
    const body = functionBody(mutated, 'fetchOrganizerEvents');
    expect(body).toContain(GUARD_CALL); // presence alone would PASS…
    expect(body.indexOf(GUARD_CALL)).toBeGreaterThan(body.indexOf(FETCH_CALL)); // …ordering catches it
  });

  it('(C) the extractor fails loudly on a rename rather than passing vacuously', () => {
    // The quiet way a source-reading pin dies: the function is renamed, the regex misses,
    // and an empty body trivially satisfies every assertion. It must throw instead.
    expect(() => functionBody('function somethingElse() { return 1; }', 'fetchOrganizerEvents')).toThrow(
      /not found/
    );
  });

  it('the config module declares the organizer-scoped template and nothing else', () => {
    const code = stripComments(
      readFileSync(resolve(process.cwd(), 'worker/adapters/eventbrite/config.ts'), 'utf8')
    );
    const declared = [...new Set(code.match(/\/v3\/[A-Za-z0-9_{}\-/]*/g) ?? [])];
    expect(declared).toEqual(['/v3/organizations/{organization_id}/events/']);
  });
});

// ── (C) the tripwire tests itself ────────────────────────────────────────────
//
// A scanner nobody has proved can fail is not a guarantee. These feed synthetic snippets
// through the SAME function used above and assert each class is genuinely caught —
// including inside the file that holds the one narrowed permission.

describe('G-T10-2 (C) tripwire self-check: every prohibition actually bites', () => {
  const SNIPPETS: Array<[string, string, string]> = [
    ['area search endpoint', "const u = base + '/v3/events/search/';", 'anonymous event-search endpoint'],
    ['destination search', "await get('/v3/destination/search/?q=kids');", 'discovery/destination search endpoint'],
    ['location.address', "params.set('location.address', 'Vancouver');", 'geo area filter (location.*)'],
    ['location.within', "params.set('location.within', '25km');", 'geo area filter (location.*)'],
    ['location.latitude', "params.set('location.latitude', lat);", 'geo area filter (location.*)'],
    ['radius param', "const p = { 'within': '25km' };", 'radius filter'],
    ['free-text q', "const p = { 'q': 'kids events' };", 'free-text search parameter'],
    ['category sweep', "const p = { 'categories': '115' };", 'category sweep parameter'],
    ['Cookie header', "await fetch(u, { headers: { cookie: jar } });", 'Cookie/session header'],
    ['credentials include', "await fetch(u, { credentials: 'include' });", "credentials:'include'"],
    ['anti-forgery token', "body.append('__RequestVerificationToken', t);", 'anti-forgery token submit'],
    ['headless import', "import puppeteer from 'puppeteer';", 'headless-browser library'],
    ['headless navigation', 'await page.goto(url);', 'headless-browser navigation'],
    ['CAPTCHA handling', 'const solved = solveCaptcha(challenge);', 'CAPTCHA handling'],
    ['password credential', "const password = process.env.EB_PASSWORD;", 'password credential'],
    ['checkout flow', "await fetch(base + '/checkout');", 'checkout/cart flow'],
    ['POST', "await fetch(u, { method: 'POST', body: '{}' });", 'POST method'],
    ['PUT', "await fetch(u, { method: 'PUT' });", 'mutating HTTP method (PUT/PATCH/DELETE)'],
    ['DELETE', "await fetch(u, { method: 'delete' });", 'mutating HTTP method (PUT/PATCH/DELETE)'],
  ];

  for (const [name, snippet, expectedLabel] of SNIPPETS) {
    it(`${name} is caught in a normal file`, () => {
      expect(scanEventbriteSource(snippet, false)).toContain(expectedLabel);
    });
    it(`${name} is STILL caught inside the Authorization-allow-listed file`, () => {
      // The narrowing is ONE header. Nothing else moved for the allow-listed file.
      expect(scanEventbriteSource(snippet, true)).toContain(expectedLabel);
    });
  }

  it('an Authorization header FAILS in a non-allow-listed file', () => {
    expect(scanEventbriteSource("await fetch(u, { headers: { authorization: t } });", false)).toContain(
      'Authorization header'
    );
  });

  it('an Authorization header PASSES only in the allow-listed file', () => {
    expect(scanEventbriteSource("await fetch(u, { headers: { Authorization: t } });", true)).toEqual([]);
  });

  it('a comment claiming compliance cannot mask real area-query code', () => {
    const src =
      "// we never call /v3/events/search and never set location.address\n" +
      "params.set('location.within', '25km');";
    expect(scanEventbriteSource(src, true)).toContain('geo area filter (location.*)');
  });

  it("the adapter's own prose naming the banned endpoints does not trip its own scan", () => {
    // Proves the comment-stripping is what makes the scan SOUND rather than merely
    // lucky: these files deliberately NAME /v3/events/search and location.address in
    // their headers, in order to ban them. That prose must be present (otherwise the
    // scan is passing for the boring reason that nobody wrote anything) AND the scan
    // must still come back clean, because it only ever reads code.
    const allProse = EVENTBRITE_SOURCES.map((rel) =>
      readFileSync(resolve(process.cwd(), rel), 'utf8')
    ).join('\n');
    expect(allProse, 'the retired area-search endpoint is named in prose').toMatch(/events\/search/);
    expect(allProse, 'the geo parameter is named in prose').toMatch(/location\.address/);

    for (const rel of EVENTBRITE_SOURCES) {
      const raw = readFileSync(resolve(process.cwd(), rel), 'utf8');
      expect(
        scanEventbriteSource(raw, AUTH_HEADER_ALLOWED_FILES.has(rel)),
        `${rel} scans clean despite naming the prohibitions in comments`
      ).toEqual([]);
    }
  });

  it('the allow-list is exactly one file and one narrowed prohibition', () => {
    // A drift guard on the exception itself: widening it must fail here first.
    expect([...AUTH_HEADER_ALLOWED_FILES]).toEqual(['worker/adapters/eventbrite/client.ts']);
    expect(EVENTBRITE_SOURCES).toHaveLength(3);
    // The closed query allow-list, pinned by value so a widening edit is visible.
    expect(Object.keys(ALLOWED_QUERY_PARAMS).sort()).toEqual([
      'expand',
      'order_by',
      'page_size',
      'status',
      'time_filter',
    ]);
    expect(ALLOWED_QUERY_PARAMS.status).toBe('live');
    expect(ALLOWED_QUERY_PARAMS.time_filter).toBe('current_future');
  });
});
