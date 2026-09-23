// app/api/search/route.ts — Search API route (G-T16-7, TSD §5A, FR-02).
//
// Default remains fixture-backed while live coverage is narrow. Staging/prod opt into
// the DB read model with KIDS_FUN_SEARCH_BACKEND=database; when they do, the WHOLE
// pipeline is live — DB listings AND the DB alias dictionary (synonym_alias, via
// PostgresAliasResolver) AND the DB region hierarchy (region table). No fixture resolver
// leaks into database mode.
//
// In LIVE database mode a real visitor is NEVER shown test/fixture rows. There are two
// honest outcomes and one honest failure — each maps to a UI state the product already
// has (app/search/page.tsx, app/preview ResultsShell):
//   • Reachable, zero visible results for this query (e.g. `open gym`, no live source yet,
//     or the table is momentarily empty)  → return the REAL empty response → "No matches
//     yet" empty state.  (Previously this fell back to fixtures — the P0 leak that showed
//     "Rank Test Gym" to real parents. Removed.)
//   • Reachable, has matches                                → return the real results.
//   • Genuinely unreachable / errored (pool/query threw)    → 5xx → "couldn't load, try
//     again" error state.  We must NOT fake data, and must NOT claim "nothing matches"
//     when we could not actually search.
// Fixture/default mode (KIDS_FUN_SEARCH_BACKEND !== 'database') is unchanged: local dev
// and the /preview demo shell intentionally run on fixtures — not a live-visitor path.

import { NextResponse } from 'next/server';
import { makeFixtureEngine } from '@/lib/search/__fixtures__/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { getCachedPostgresListings } from '@/lib/search/postgres-repository';
import { getPostgresAliasResolver } from '@/lib/search/postgres-alias-resolver';
import { getPostgresRegionHierarchy } from '@/lib/search/postgres-region-hierarchy';
import { SearchEngine, type SearchRequest, type SearchResponse } from '@/lib/search/engine';
import { getPool } from '@/lib/db/client';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { isInternalAgeMarker } from '@/app/preview/_data/format';
import { resolvePreciseSavedHomeGeocoder } from '@/lib/geo/saved-home-geocoder';
import { captureAndFlush, withObservedRoute } from '@/lib/observability/route-handler';
import type { Geocoder, OriginRequest } from '@/lib/geo/origin';
import type { AgeBandKey, SortKey } from '@/lib/search/types';
import { readCookie } from '@/lib/http/request-context';
import { clientIpFrom } from '@/lib/sms/client-ip';
import { ANON_SESSION_COOKIE } from '@/lib/db/session';
import { checkSearchRateLimit } from '@/lib/security/search-rate-limit';
// Stage 2a — reuse the rail's own vocabulary for the new typed params (age/when/time) rather
// than duplicating the allowed-value lists, so route.ts and the /search page can never accept
// different sets. See app/search/_lib/params.ts's header for the structured-vs-composed split.
import { AGE_ORDER, WHEN_OPTIONS, TIME_OF_DAY_OPTIONS } from '@/app/search/_lib/params';
import type { WhenKey, TimeOfDayKey } from '@/app/search/_lib/params';

export const dynamic = 'force-dynamic';

const VALID_SORTS: SortKey[] = ['best_match', 'distance', 'soonest', 'lowest_cost', 'newest'];
const fixtureBundle = makeFixtureEngine();

// Stage 2a — allowed-value sets for the new typed params, derived from the rail's own
// vocabulary (imported above) so a value the UI could never produce can't reach the engine.
const WHEN_KEYS: WhenKey[] = WHEN_OPTIONS.map((w) => w.key);
const TIME_OF_DAY_KEYS: TimeOfDayKey[] = TIME_OF_DAY_OPTIONS.map((t) => t.key);

export const GET = withObservedRoute(searchGet, { tags: { route: 'api/search' } });

/** GET /api/search?q=open+gym&lat=..&lng=..&sort=..&region=van,bby&includeRegistration=1&limit=20 */
async function searchGet(request: Request): Promise<NextResponse> {
  // ═══ RATE LIMIT, FIRST, BEFORE ANY WORK ═══ (2026-09-22 incident — see
  // supabase/migrations/0051_search_rate_limit.sql and lib/security/search-rate-limit.ts for the
  // full writeup). Checked before the listing/alias/region loads below so a refused caller never
  // pays for them, and before buildSearchRequest so a malformed query string can't be used to
  // dodge the check. app/search/page.tsx only calls recordSearchPerformed when this fetch
  // succeeds (`result.ok`), so a 429 here ALSO stops the analytics_event write — enforcement and
  // the analytics fix are the same choke point, deliberately.
  const rateLimit = await checkSearchRateLimit({
    ip: clientIpFrom(request.headers),
    sessionId: readCookie(request.headers, ANON_SESSION_COOKIE) ?? null,
  });
  if (rateLimit.degraded && (rateLimit.degradedReason === 'db_error' || rateLimit.degradedReason === 'no_salt')) {
    // db_error: expected once, harmlessly, the moment this ships ahead of migration 0051 being
    // applied to an environment; anything after that is a real counter-table outage worth seeing.
    // no_salt: SMS_PHONE_HASH_SALT unset/rotated means the limiter is a COMPLETE, SILENT no-op —
    // every request degrades open with no subject to count against. That is expected in dev/test
    // (captureAndFlush no-ops with no Sentry DSN configured, so this costs nothing there) but is
    // exactly the kind of "the limiter has been inert since Tuesday" failure that must not go
    // unnoticed in an environment where it does have a DSN. 'no_subject' (a request with neither
    // an IP nor a session — now rare after forwardedIdentityHeaders, see app/search/page.tsx) is
    // NOT reported: it is a property of one request, not a standing misconfiguration.
    await captureAndFlush(new Error(`search_rate_limit_degraded:${rateLimit.degradedReason}`), undefined, {
      route: 'api/search',
      operation: 'check_search_rate_limit',
    });
  }
  if (!rateLimit.allowed) {
    return jsonRateLimited(rateLimit.retryAfterSeconds);
  }

  const url = new URL(request.url);
  const searchRequest = buildSearchRequest(url.searchParams);

  // Precise saved-home origin (Task 36): pre-resolve the saved postal to a real Mapbox
  // point once, at the async boundary, so the synchronous engine can use it. Returns
  // null for anything that can't/shouldn't be precisely geocoded (near_me/area_chip,
  // not signed in, Mapbox down/timeout/miss) → the FSA-centroid fallback below stands in.
  const preciseGeocoder = await resolvePreciseSavedHomeGeocoder(
    searchRequest.origin,
    searchRequest.signedIn ?? false
  );

  // Surfaced to app/search/page.tsx so it can stamp analytics_event.search_minute_request_count
  // (migration 0052) without a second rate-limit query — see lib/analytics/record.ts. The RAW
  // count, not a boolean: lib/analytics/kpi.ts decides the exclusion threshold at READ time, so
  // a mis-tuned cutoff is a query change, not a re-migration — see search-rate-limit.ts's header
  // on why a silent write-time boolean was the wrong shape for this.
  //
  // 🟡 F3 (2026-09-22 independent recheck): `sessionMinuteAttempts`, NEVER `minuteAttempts`. The
  // latter falls back to the ip-scope count when no session was available, and an ip-derived
  // count is not attributable to one visitor — see SearchRateLimitResult.sessionMinuteAttempts's
  // header for the reproduced failure this caused (a shared IP's real, ordinary traffic silently
  // excluding every one of its distinct visitors from DAU/WAU/MAU).
  const searchMinuteRequestCount = rateLimit.sessionMinuteAttempts;

  if (process.env.KIDS_FUN_SEARCH_BACKEND === 'database') {
    const dbResult = await searchDatabase(searchRequest, preciseGeocoder);
    if (dbResult.ok) return json(dbResult.response, dbResult.header, searchMinuteRequestCount);
    // Genuine DB outage in LIVE database mode: fail honestly with a 5xx so each client
    // renders its existing "couldn't load — try again" state. We deliberately do NOT fall
    // through to the fixture path below — real production visitors must NEVER be shown
    // test/fixture rows (e.g. "Rank Test Gym"), and an outage is not a "nothing matches".
    return jsonError('search temporarily unavailable', 503);
  }

  // Fixture/default mode only (KIDS_FUN_SEARCH_BACKEND !== 'database'): local dev and the
  // /preview demo shell intentionally run on hand-authored fixtures. This is NOT the live
  // production data path, so returning fixtures here is correct and unchanged.
  const response = searchFixtures(searchRequest, preciseGeocoder);
  return json(response, 'fixture', searchMinuteRequestCount);
}

async function searchDatabase(
  searchRequest: SearchRequest,
  preciseGeocoder: Geocoder | null
): Promise<{ ok: true; response: SearchResponse; header: string } | { ok: false }> {
  try {
    const pool = getPool();
    // Retire the fixture seam in database mode: the ENTIRE pipeline reads live DB —
    // listings AND the alias dictionary (synonym_alias) AND the region hierarchy (region).
    // All three load in parallel; a genuine failure of any of them throws to the catch
    // below (→ honest 5xx), which is categorically different from a successful search that
    // simply matched nothing.
    // All three loads are now cached per warm instance on a short TTL (alias/region 60s, listing
    // read model 10 min — see postgres-repository.ts for why it is longer). The listing read
    // model is the COMPLETE visible catalogue (no pre-search row cap), so reloading it on every
    // invocation made the load the dominant per-request cost — 428ms of a 560ms request against
    // live staging. See lib/search/postgres-repository.ts for the measurements and the staleness
    // budget this trades for them.
    const [listings, aliasResolver, regionHierarchy] = await Promise.all([
      getCachedPostgresListings(pool),
      getPostgresAliasResolver(pool),
      getPostgresRegionHierarchy(pool),
    ]);

    // No fixture fallback on an empty/zero-match result set anymore. Pre-launch the DB was
    // completely empty and fixtures kept the shell from going blank (the original, now-stale
    // rationale). Post-launch the DB is populated for the live sources, so BOTH "the table
    // is empty" AND "this specific query matched nothing" (e.g. `open gym`, which no live
    // source covers yet) are REAL zero-result answers that must render the honest empty
    // state — never test rows like "Rank Test Gym". The engine handles an empty repository
    // correctly (zero results), so we run it unconditionally and return whatever it produces.
    const engine = new SearchEngine({
      repository: new InMemoryListingRepository(listings),
      aliasResolver,
      regionHierarchy,
      // Saved-home origin (postal → point): Task 36 wires live Mapbox geocoding. When the
      // request pre-resolved a precise point, use it; otherwise degrade to the Task-29
      // FSA-centroid resolver (fsaGeocoder) as the fallback-of-last-resort.
      geocoder: preciseGeocoder ?? fsaGeocoder,
      fixtureBacked: false,
    });
    const response = engine.search(searchRequest);
    response.meta.backend = 'database';
    return { ok: true, response, header: 'database' };
  } catch (err) {
    // Genuine DB failure (pool/connection/query threw) — categorically different from a
    // reachable-but-zero-match result. We could not search at all, so we must neither fake
    // data (fixtures) nor falsely claim "nothing matches" (empty state). Signal failure; the
    // caller returns a 5xx and the client shows its honest "couldn't load — try again" state.
    await captureAndFlush(err, undefined, { route: 'api/search', operation: 'search_database' });
    return { ok: false };
  }
}

function searchFixtures(searchRequest: SearchRequest, preciseGeocoder: Geocoder | null = null): SearchResponse {
  // Reuse the cached fixture engine (fsaGeocoder baked in) unless the request pre-resolved
  // a precise saved-home point — then build a one-off engine over the same fixture deps
  // with the precise geocoder swapped in. Task 36.
  const engine = preciseGeocoder
    ? new SearchEngine({
        repository: fixtureBundle.repository,
        aliasResolver: fixtureBundle.aliasResolver,
        regionHierarchy: fixtureBundle.regionHierarchy,
        geocoder: preciseGeocoder,
      })
    : fixtureBundle.engine;
  const response = engine.search(searchRequest);
  response.meta.backend = 'fixture';
  return response;
}

/**
 * ═══ INTERNAL PIPELINE MARKERS NEVER LEAVE THIS ROUTE ═══
 * 36.8% of live listings carry `age_notes` beginning 'unresolved:' or 'audience:' — markers
 * lib/llm/age-fallback.ts writes for rows awaiting an LLM backfill. At least 12 of them carry a
 * full engineering changelog including a git SHA and an internal document slug, and this route
 * returned all of it to any unauthenticated caller. Both audits measured the bug without
 * credentials, which is the clearest possible statement of the exposure.
 *
 * STRIPPED HERE, AT THE ONE CHOKE POINT. Every mode — fixture, live and precise-geocoder — ends
 * up in this function, so guarding it covers all three and cannot be bypassed by a new path. The
 * display-layer guard in ActivityDetail is the second layer, not the only one: the API leaked
 * this to callers who never render a page at all.
 *
 * DROPPED WHOLE RATHER THAN HAVING THE PREFIX STRIPPED. On an ordinary row the residue is the
 * raw source wording and would be safe — but on the changelog rows the prefix is the only part
 * that ISN'T internal. Remove "unresolved:" from the worst example and what remains still reads
 * "…code fix live in 9f95e31, worker release v24". A marked value is one the pipeline wrote, not
 * one a source did, so the whole value is treated as internal. When the backfill runs, these rows
 * get real values and their notes return on their own.
 *
 * The response is shallow-copied rather than mutated: the engine's listing objects are shared
 * with its in-memory caches, and editing them in place would poison every later request.
 */
function withoutInternalAgeMarkers(response: SearchResponse): SearchResponse {
  let touched = false;
  const results = response.results.map((r) => {
    const notes = (r.listing as { ageNotes?: string | null }).ageNotes;
    if (!isInternalAgeMarker(notes)) return r;
    touched = true;
    return { ...r, listing: { ...r.listing, ageNotes: null } };
  });
  return touched ? { ...response, results } : response;
}

/**
 * `rateLimit` rides along OUTSIDE the typed `SearchResponse` shape (a bag-on-the-side field, not
 * a new member of lib/search/engine.ts's `SearchResponse.meta`) so this rate-limit signal never
 * has to be threaded through the search engine itself — every caller of the engine (tests,
 * /preview, the fixture path) stays exactly as typed as before. app/search/page.tsx reads it as
 * an optional field on its own local response type; see `SearchApiResponse.rateLimit` there.
 *
 * The RAW minute-bucket count, not a pre-thresholded boolean — see the header on
 * `searchMinuteRequestCount` above and lib/analytics/kpi.ts for why the exclusion cutoff lives at
 * read time. `null`/absent means "not measured" (degraded — no salt, no subject, or a DB error),
 * which is a materially different fact from "measured, and low" (a real, small number).
 */
function json(response: SearchResponse, source: string, searchMinuteRequestCount: number | null = null): NextResponse {
  const body: SearchResponse & { rateLimit?: { searchMinuteRequestCount: number } } = {
    ...withoutInternalAgeMarkers(response),
    ...(searchMinuteRequestCount !== null ? { rateLimit: { searchMinuteRequestCount } } : {}),
  };
  return NextResponse.json(body, {
    headers: { 'x-data-source': source },
  });
}

/** Honest failure for LIVE database mode: a genuine DB outage returns a 5xx (never a
 *  fixture/test row) so every client renders its existing "couldn't load — try again"
 *  state. `x-data-source: database-error` lets monitoring distinguish an outage from a
 *  real empty result. */
function jsonError(reason: string, status: number): NextResponse {
  return NextResponse.json({ error: reason }, { status, headers: { 'x-data-source': 'database-error' } });
}

/**
 * Refused by lib/security/search-rate-limit.ts (2026-09-22 incident). `Retry-After` is the real
 * HTTP mechanism for this (RFC 9110 §10.2.3) so a well-behaved caller — including any future
 * synthetic monitor — knows to back off rather than retry immediately. The body error string is
 * deliberately generic: it is never shown to a real visitor (app/search/page.tsx's existing
 * "couldn't load — try again" state renders on any non-2xx, same as a genuine 503), so there is
 * nothing to gain by being more specific here and a small cost (telling a probing caller exactly
 * which knob to tune) to being more specific.
 */
function jsonRateLimited(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: 'too many requests' },
    {
      status: 429,
      headers: {
        'x-data-source': 'rate-limited',
        'Retry-After': String(Math.max(1, retryAfterSeconds)),
      },
    }
  );
}

function buildSearchRequest(p: URLSearchParams): SearchRequest {
  const q = p.get('q') ?? '';
  const sortParam = p.get('sort');
  const sort = sortParam && (VALID_SORTS as string[]).includes(sortParam) ? (sortParam as SortKey) : undefined;
  const origin = buildOriginRequest(p);
  // Region chips are MULTI-SELECT, and a caller may express that either way — `region=van,bby`
  // (what the rail's own links and apiQuery emit) or `region=van&region=bby` (the ordinary REST
  // spelling of a repeated param, and what a hand-written or shared call tends to use). This read
  // used to be `p.get('region')`, which returns only the FIRST occurrence, so the repeated form
  // silently searched Vancouver alone and reported nothing about the chips it dropped. See
  // `csvValues`.
  const regionChipIds = csvValues(p.getAll('region'));
  // NB: `includeUnknownCost` is GONE as a request parameter. It used to mean absent→exclude
  // here while meaning absent→include in the /search state layer, so unknown-cost listings
  // could be suppressed by nothing more than a caller omitting a param. They are now always
  // included, decided once in lib/search/filters/cost.ts. A caller that still sends
  // `includeUnknownCost=0` is ignored rather than obeyed — deliberately, since obeying it
  // would restore the suppression the removal exists to end.
  //
  // Registration courses are OFF unless explicitly asked for: an inclusion policy the caller
  // states, never something inferred from the text of `q`.
  //
  // BOTH SPELLINGS OF THE SAME FLAG ARE READ, and the alias is not a convenience. `reg` is the
  // name the /search PAGE URL uses (app/search/_lib/params.ts `pageParams`), the name every rail
  // link puts in front of a parent, and the key a saved search persists — while this route
  // historically read only `includeRegistration`. Every other chip param (age/when/time/bookable/
  // rainy/dropin/free/region/radius/from/to) is spelled identically on both sides, so this was the
  // one page param that a caller could send verbatim from the URL bar and have silently ignored:
  // the API answered "drop-in only" to a request that plainly said `reg=1`.
  // Precedence: this API's own name wins when both are present, so an explicit
  // `includeRegistration=0` is never overridden by a stale `reg=1` carried along in the same URL.
  const includeRegistration = isOn(p.get('includeRegistration') ?? p.get('reg'));
  // Facet counts for the filter UI (`facets=1`). Deliberately part of THIS request rather
  // than a second endpoint: the counts are derived from the candidate set this search has
  // already loaded and matched, so asking for them here costs a few in-memory passes, while
  // a separate /facets route would re-run the entire pipeline (including the listing load)
  // a second time on every filter interaction.
  const facets = isOn(p.get('facets'));
  const dateRange = buildDateRange(p);
  const limit = clampInt(p.get('limit'), 1, 100);
  const minResults = clampInt(p.get('minResults'), 0, 100);

  // Stage 2a — typed filter-chip params (roadmap initiative 2, first half). Same param names
  // the /search PAGE URL already reserves (app/search/_lib/params.ts: age/when/time/bookable/
  // rainy/dropin/free/radius), now ALSO read here as structured request fields — in addition
  // to, not instead of, the `q` text those same chips still compose (apiQuery sends both
  // during this stage). Each helper returns `undefined` when the param is absent, so the
  // engine's override block leaves parseQuery()'s reading alone rather than clearing it.
  const ageBands = parseCsvAgainstAllowed(p.getAll('age'), AGE_ORDER);
  const when = parseEnumParam(p.get('when'), WHEN_KEYS);
  const timeOfDay = parseEnumParam(p.get('time'), TIME_OF_DAY_KEYS);
  const bookableNow = parseOptionalBool(p.get('bookable'));
  const rainyDay = parseOptionalBool(p.get('rainy'));
  const dropIn = parseOptionalBool(p.get('dropin'));
  const free = parseOptionalBool(p.get('free'));
  const radiusKm = parsePositiveFloat(p.get('radius'));

  return {
    q,
    origin,
    signedIn: p.get('signedIn') === '1',
    regionChipIds,
    sort,
    includeRegistration,
    facets,
    ...(dateRange != null ? { dateRange } : {}),
    ...(limit != null ? { limit } : {}),
    ...(minResults != null ? { minResults } : {}),
    ...(ageBands !== undefined ? { ageBands } : {}),
    ...(when !== undefined ? { when } : {}),
    ...(timeOfDay !== undefined ? { timeOfDay } : {}),
    ...(bookableNow !== undefined ? { bookableNow } : {}),
    ...(rainyDay !== undefined ? { rainyDay } : {}),
    ...(dropIn !== undefined ? { dropIn } : {}),
    ...(free !== undefined ? { free } : {}),
    ...(radiusKm !== undefined ? { radiusKm } : {}),
  };
}

/**
 * Every value of a repeatable csv param, in the order the caller sent them, de-duplicated.
 *
 * ONE READER FOR BOTH SPELLINGS of a multi-select param — `x=a,b` and `x=a&x=b` — because the two
 * are the same selection and a caller has no way to know which one this API prefers. Reading it
 * with `URLSearchParams.get()` (which returns only the first occurrence) is what made a
 * two-municipality search quietly return one municipality's listings: no error, no notice, and a
 * result set that looks exactly like a real answer. Empty segments are dropped, so a trailing
 * comma or a bare `region=` is "no chips", not a chip named "".
 */
function csvValues(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
  }
  return out;
}

/** A csv param filtered/ordered against an allowed-value list; `undefined` when the param is
 *  absent (so the engine leaves the text-parsed value alone), `[]` when it was present but every
 *  value in it was unrecognised (an explicit, valid "none"). Repeatable, for the reason
 *  `csvValues` documents. */
function parseCsvAgainstAllowed<T extends string>(raw: string[], allowed: readonly T[]): T[] | undefined {
  if (raw.length === 0) return undefined;
  const set = new Set(csvValues(raw));
  return allowed.filter((v) => set.has(v));
}

/** A single param validated against an allowed-value list; `undefined` when absent OR when the
 *  value isn't in the list — a malformed value degrades to "no override", never a thrown error. */
function parseEnumParam<T extends string>(raw: string | null, allowed: readonly T[]): T | undefined {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

/** A boolean param; `undefined` when absent (leave text parse alone) vs. explicitly on/off. */
function parseOptionalBool(raw: string | null): boolean | undefined {
  return raw == null ? undefined : isOn(raw);
}

/** A positive-finite-number param; `undefined` when absent or not a usable radius. */
function parsePositiveFloat(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Boolean query param, accepting the same truthy spellings across the API. */
function isOn(raw: string | null): boolean {
  return ['1', 'true', 'yes'].includes((raw ?? '').toLowerCase());
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Custom date range (T26 / FR-04): `from`/`to` are structured YYYY-MM-DD params (like region,
 * not text in `q`). Both ends must be present and well-formed, else no range is applied. */
function buildDateRange(p: URLSearchParams): { from: string; to: string } | null {
  const from = p.get('from');
  const to = p.get('to');
  if (from && to && ISO_DATE_RE.test(from) && ISO_DATE_RE.test(to)) return { from, to };
  return null;
}

/** Derive an origin resolution request from query params (near me / area chip / saved home). */
function buildOriginRequest(p: URLSearchParams): OriginRequest | null {
  const latParam = p.get('lat');
  const lngParam = p.get('lng');
  if (latParam != null && lngParam != null) {
    const lat = Number(latParam);
    const lng = Number(lngParam);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { mode: 'near_me', coords: { lat, lng } };
  }
  const area = p.get('area');
  if (area) return { mode: 'area_chip', areaChipId: area };
  const postal = p.get('postal');
  if (postal) return { mode: 'saved_home', homePostal: postal };
  return null;
}

function clampInt(raw: string | null, min: number, max: number): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
