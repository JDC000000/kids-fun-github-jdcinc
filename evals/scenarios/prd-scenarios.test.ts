// evals/scenarios/prd-scenarios.test.ts — PRD test scenarios T-01…T-15 as automated
// fixtures (G-T36-1), each exercised over the REAL search / data path — the same
// SearchEngine + real product modules the app runs, never a mock.
//
//   • Search scenarios (T-01…T-11) drive the real SearchEngine — defaultEngine() is the
//     shipped fixture-backed engine (== /api/search default mode); a few build a one-off
//     engine over a representative listing (via the project's own makeListing factory)
//     where the shipped FIXTURE_LISTINGS has no example yet. Those data-breadth gaps are
//     called out in-line and in the findings doc.
//   • Non-search scenarios (T-12…T-15) drive the real product logic that owns them:
//     corrections validation, saved-search validation, the analytics event catalog, and
//     the source-staleness rule.
//
// Source: PRD v1.2 §"Test scenarios" (T-01…T-15); TSD §9; scope-to-task G-T36-1.

import { describe, it, expect } from 'vitest';
import { SearchEngine } from '@/lib/search/engine';
import type { ListingRecord } from '@/lib/search/types';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { matchesAge } from '@/lib/search/filters/age';
import { isPrimaryResult, isExpectedSection, isHidden, STATUS_CLASS } from '@/lib/search/filters/status';
import { parseCorrectionReportBody } from '@/lib/corrections/validate';
import { parseSavedSearchCreate } from '@/lib/user/saved-search-validate';
import { EVENT_CATALOG, DEFERRED_EVENT_TYPES, catalogEntry } from '@/lib/analytics/catalog';
import { isSourceStale } from '@/lib/admin/dashboard';
import { mapListingRecordToActivity } from '@/app/preview/_data/search-api';
import { defaultEngine, EAST_VAN, FIXTURE_NOW } from '@/evals/harness';

const engine = defaultEngine();

/** Build a one-off real engine over a custom catalogue (same deps as the fixture engine). */
function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
  });
}

const nearEastVan = { mode: 'near_me', coords: { lat: EAST_VAN.lat, lng: EAST_VAN.lng } } as const;
const ids = (list: { listing: ListingRecord }[]) => list.map((r) => r.listing.id);

// ── T-01 ───────────────────────────────────────────────────────────────────
// "open gym", East Van/home, Today, 10km, age 2 + 5 → relevant open gym / family
// drop-in / gymnasium play appear (or close equivalents + broaden suggestions).
describe('T-01 — "open gym" near East Van returns relevant open-gym options', () => {
  const res = engine.search({ q: 'open gym', now: FIXTURE_NOW, origin: nearEastVan, minResults: 3, limit: 20 });

  it('returns a non-empty, all-open-gym primary set', () => {
    expect(res.total).toBeGreaterThan(0);
    expect(res.results.every((r) => r.listing.primaryCategoryKey === 'open_gym')).toBe(true);
  });

  it('surfaces the open-gym family: drop-in gym + gymnasium play, nearest East-Van gym first', () => {
    expect(res.results[0].listing.id).toBe('l-opengym-van'); // free, East Van, bookable, freshest
    expect(ids(res.results)).toEqual(expect.arrayContaining(['l-gymplay-nvan', 'l-familydropin-bby']));
  });

  it('never surfaces the cancelled gym', () => {
    expect(ids(res.results)).not.toContain('l-cancelled-gym');
  });
});

// ── T-02 ───────────────────────────────────────────────────────────────────
// "family swim" age 2, 10km → pools/aquatic-centre swim appear; the Aquarium is not
// incorrectly mixed in as a swim/pool source.
describe('T-02 — "family swim" returns pools, not the Aquarium', () => {
  const res = engine.search({ q: 'family swim', now: FIXTURE_NOW, origin: nearEastVan, minResults: 2, limit: 20 });

  it('returns public-swim listings only', () => {
    expect(res.total).toBeGreaterThanOrEqual(2);
    expect(res.results.every((r) => r.listing.primaryCategoryKey === 'public_swim')).toBe(true);
    expect(ids(res.results)).toContain('l-publicswim-van');
  });

  it('does not mix the Aquarium into swim results', () => {
    expect(ids(res.results)).not.toContain('l-aquarium-van');
  });

  it('the Aquarium is still indexed under its own attraction category', () => {
    const aq = engine.search({ q: 'aquarium', now: FIXTURE_NOW, minResults: 0, limit: 20 });
    const top = aq.results[0];
    expect(top.listing.id).toBe('l-aquarium-van');
    expect(top.listing.primaryCategoryKey).toBe('aquarium'); // NOT public_swim
  });
});

// ── T-03 ───────────────────────────────────────────────────────────────────
// Selecting the Vancouver parent area → results include sub-areas (East Van + West
// Side); selecting only West Side narrows.
describe('T-03 — Vancouver parent area spans sub-areas; West Side narrows', () => {
  const van = engine.search({ q: '', now: FIXTURE_NOW, regionChipIds: ['van'], minResults: 0, limit: 100 });
  const westSide = engine.search({ q: '', now: FIXTURE_NOW, regionChipIds: ['van-westside'], minResults: 0, limit: 100 });

  it('the Vancouver area includes both East Van and West Side sub-areas', () => {
    const areas = new Set(van.results.map((r) => r.listing.displayArea));
    expect(areas.has('van-east')).toBe(true);
    expect(areas.has('van-westside')).toBe(true);
  });

  it('selecting only West Side narrows to a strict subset of the Vancouver results', () => {
    expect(westSide.total).toBeGreaterThan(0);
    expect(westSide.total).toBeLessThan(van.total);
    expect(westSide.results.every((r) => r.listing.displayArea === 'van-westside')).toBe(true);
    const vanIds = new Set(ids(van.results));
    expect(ids(westSide.results).every((id) => vanIds.has(id))).toBe(true);
  });
});

// ── T-04 ───────────────────────────────────────────────────────────────────
// Search from East Van with 10km radius → nearby North Van / Burnaby / West Side can
// appear if within radius; Richmond (~11km) does not.
describe('T-04 — 10km radius from East Van includes nearby municipalities, excludes Richmond', () => {
  const all = engine.search({ q: '', now: FIXTURE_NOW, origin: nearEastVan, minResults: 0, limit: 100 });

  it('includes North Van, Burnaby and West Side listings that fall within radius', () => {
    const got = ids(all.results);
    expect(got).toEqual(
      expect.arrayContaining(['l-gymplay-nvan', 'l-familydropin-bby', 'l-indoorplay-bby', 'l-publicswim-van'])
    );
  });

  it('every returned result is within the 10km radius', () => {
    expect(all.results.every((r) => r.distanceKm != null && r.distanceKm <= 10)).toBe(true);
  });

  it('Richmond (~11km) is excluded by radius, but present without an origin', () => {
    expect(ids(all.results)).not.toContain('l-skate-rmd');
    const skateNear = engine.search({ q: 'skate', now: FIXTURE_NOW, origin: nearEastVan, minResults: 0, limit: 20 });
    expect(ids(skateNear.results)).not.toContain('l-skate-rmd'); // radius removes it
    const skateAny = engine.search({ q: 'skate', now: FIXTURE_NOW, minResults: 0, limit: 20 });
    expect(ids(skateAny.results)).toContain('l-skate-rmd'); // exists, just out of range
  });
});

// ── T-05 ───────────────────────────────────────────────────────────────────
// Age boundary: child age 5 maps to the Children (5-9) band, not Kids (2-4); source
// ranges overlapping 5 can still match.
describe('T-05 — age 5 maps to the 5-9 band, not 2-4; overlapping ranges still match', () => {
  // Canonical, non-overlapping bands (age_bands.sql): months are lower-inclusive /
  // upper-exclusive, so 5 years = 60 months is the FIRST month of the 5-9 ("Children")
  // band and is NOT in 2-4 ("Kids") = [24,60). The product filters on band KEYS, so the
  // real classification path under test is matchesAge over those keys — a 5-9 child must
  // match 5-9 and overlapping listings but never a 2-4-only listing.
  it('the real matchesAge predicate matches a 5-9 child to overlapping listings only', () => {
    const only24 = makeListing({ id: 't05-24', ageBandMatches: ['2-4'] }); // "Kids" band only
    const only59 = makeListing({ id: 't05-59', ageBandMatches: ['5-9'] }); // "Children" band only
    const overlap = makeListing({ id: 't05-ov', ageBandMatches: ['2-4', '5-9'] });
    expect(matchesAge(only59, ['5-9'])).toBe(true);
    expect(matchesAge(overlap, ['5-9'])).toBe(true); // a source range overlapping 5-9 still matches
    expect(matchesAge(only24, ['5-9'])).toBe(false); // a 2-4-only ("Kids") listing is NOT a 5yo match
  });
});

// ── T-06 ───────────────────────────────────────────────────────────────────
// A multi-category activity (festival-at-museum) can appear under BOTH the festival and
// the museum/attraction filters.
//
// DATA-BREADTH GAP: the shipped FIXTURE_LISTINGS has no multi-category listing, so this
// builds a representative one via the same factory the fixtures use and exercises the
// REAL engine/matcher (field B tokenizes primaryCategoryKey + categoryTags). When a real
// festival-at-museum source is ingested, the same behaviour is expected without change.
describe('T-06 — a festival-at-museum surfaces under both festival and museum queries', () => {
  const festivalAtMuseum = makeListing({
    id: 't06-festival-museum',
    activityName: 'Lantern Festival at the Museum',
    primaryCategoryKey: 'festival',
    categoryTags: ['museum_arts'],
    venueName: 'City Museum',
    descriptionSnippet: 'A family lantern festival held at the city museum.',
    geo: { lat: 49.26, lng: -123.07 },
    municipalityId: 'van',
  });
  const eng = engineOver([festivalAtMuseum]);

  it('appears for a "festival" query', () => {
    const res = eng.search({ q: 'festival', now: FIXTURE_NOW, minResults: 0, limit: 20 });
    expect(ids(res.results)).toContain('t06-festival-museum');
  });

  it('appears for a "museum" query too (same listing, second category)', () => {
    const res = eng.search({ q: 'museum', now: FIXTURE_NOW, minResults: 0, limit: 20 });
    expect(ids(res.results)).toContain('t06-festival-museum');
  });
});

// ── T-07 ───────────────────────────────────────────────────────────────────
// A seasonal source out of season / suspended shows an honest out-of-season / suspended
// / schedule-not-published state, NOT a false confirmed event.
describe('T-07 — an out-of-season seasonal listing is honest, not falsely confirmed', () => {
  it('the out-of-season toboggan is surfaced ONLY in the expected/seasonal section', () => {
    const res = engine.search({ q: 'tobogganing', now: FIXTURE_NOW, minResults: 3, limit: 20 });
    expect(ids(res.results)).not.toContain('l-toboggan-seasonal'); // not in confirmed/primary
    expect(ids(res.expected)).toContain('l-toboggan-seasonal'); // shown separately as expected
  });

  it('the seasonal listing keeps its honest status_state (never rewritten to confirmed)', () => {
    const res = engine.search({ q: 'tobogganing', now: FIXTURE_NOW, minResults: 3, limit: 20 });
    const toboggan = res.expected.find((r) => r.listing.id === 'l-toboggan-seasonal')!;
    expect(toboggan.listing.statusState).toBe('seasonal_out_of_season');
    expect(STATUS_CLASS[toboggan.listing.statusState]).toBe('expected');
  });

  it('an in-season seasonal listing (summer miniature train) is honestly seasonal_active, not confirmed', () => {
    const res = engine.search({ q: 'train', now: FIXTURE_NOW, minResults: 0, limit: 20 });
    const train = res.results.find((r) => r.listing.id === 'l-minitrain-van')!;
    expect(train.listing.statusState).toBe('seasonal_active');
    expect(isPrimaryResult(train.listing)).toBe(true);
  });
});

// ── T-08 ───────────────────────────────────────────────────────────────────
// Stanley Park Train: if the official source says suspended, listings do not appear as
// bookable.
//
// The shipped train fixture is seasonal_active (correct for a July "now"), so this asserts
// the invariant the scenario describes on a representative suspended listing + on the
// non-bookable listings already in the catalogue.
describe('T-08 — a suspended official listing never presents as bookable', () => {
  const suspendedTrain = makeListing({
    id: 't08-train-suspended',
    activityName: 'Stanley Park Miniature Train',
    primaryCategoryKey: 'miniature_train',
    venueName: 'Stanley Park',
    statusState: 'suspended',
    confidenceLabel: 'official_recent',
    bookingUrl: 'https://example.org/train',
    geo: { lat: 49.3, lng: -123.14 },
    municipalityId: 'van',
  });

  it('a suspended listing is classified hidden and never surfaces in search', () => {
    expect(isHidden(suspendedTrain)).toBe(true);
    const res = engineOver([suspendedTrain]).search({ q: 'train', now: FIXTURE_NOW, minResults: 0, limit: 20 });
    expect(ids(res.results)).not.toContain('t08-train-suspended');
    expect(ids(res.expected)).not.toContain('t08-train-suspended');
  });

  it('the card mapping offers no booking affordance for suspended/cancelled/full listings', () => {
    // Even if a suspended listing reached a card, the source CTA stays authoritative but
    // the misleading "book/register/drop-in" chip is suppressed.
    expect(mapListingRecordToActivity(suspendedTrain).booking).toBe('none');
    // The catalogue's cancelled + full listings behave the same way.
    const cancelled = makeListing({ id: 't08-cancelled', statusState: 'cancelled', bookingUrl: 'https://x/y' });
    const full = makeListing({ id: 't08-full', statusState: 'full', bookingUrl: 'https://x/y' });
    expect(mapListingRecordToActivity(cancelled).booking).toBe('none');
    expect(mapListingRecordToActivity(full).booking).toBe('none');
  });
});

// ── T-09 ───────────────────────────────────────────────────────────────────
// Cypress tubing/sliding age/season → the listing reflects winter/season/weather/age
// constraints. (No Cypress-specific fixture; the Mount Seymour winter toboggan is the
// seasonal-winter analog in the catalogue.)
describe('T-09 — a winter seasonal listing reflects season + age constraints', () => {
  const res = engine.search({ q: 'snow tubing', now: FIXTURE_NOW, minResults: 3, limit: 20 });
  const toboggan =
    res.expected.find((r) => r.listing.id === 'l-toboggan-seasonal') ??
    res.results.find((r) => r.listing.id === 'l-toboggan-seasonal');

  it('is out of season in July (not shown as a confirmed, bookable winter activity)', () => {
    expect(toboggan, 'winter toboggan should surface as an expected/seasonal option').toBeTruthy();
    expect(toboggan!.listing.statusState).toBe('seasonal_out_of_season');
    expect(isPrimaryResult(toboggan!.listing)).toBe(false);
  });

  it('carries age constraints (an age-banded winter activity, not all-ages-implicit)', () => {
    expect(toboggan!.listing.ageBandMatches.length).toBeGreaterThan(0);
    expect(toboggan!.listing.ageBandMatches).not.toContain('under2'); // age/height floor
  });
});

// ── T-10 ───────────────────────────────────────────────────────────────────
// Unknown cost → the listing is not assumed free; the card/detail gives a source link and
// acceptable "check source" handling.
describe('T-10 — an unknown-cost listing is never assumed free', () => {
  it('a Free filter SHOWS the unknown-cost storytime, but never labels it free', () => {
    // T-10's requirement is "never ASSUMED free", and that is about the label, not about
    // visibility. It used to be enforced by hiding unknown-cost listings behind an
    // include-unknown flag; that flag was removed (Jon's beta feedback) because a source
    // omitting a price is our data gap, not something a parent should have to opt out of.
    // The honesty half is unchanged and is asserted directly below: the card still reads
    // "Cost — check source", never "Free".
    const free = engine.search({ q: 'storytime free', now: FIXTURE_NOW, minResults: 1, limit: 20 });
    expect(ids(free.results)).toContain('l-storytime-van'); // genuinely free
    expect(ids(free.results)).toContain('l-storytime-unknown'); // shown, not hidden
    const unknownCard = mapListingRecordToActivity(
      makeListing({ id: 'l-storytime-unknown-card', costStatus: 'unknown' }),
    );
    expect(unknownCard.costStatus).toBe('unknown'); // and still not asserted to be free
  });

  it('the card mapping keeps unknown cost as "unknown" (not free) and still exposes a source', () => {
    const unknown = makeListing({ id: 't10-unknown', costStatus: 'unknown', sourceUrl: 'https://library.example/branch' });
    const activity = mapListingRecordToActivity(unknown);
    expect(activity.costStatus).toBe('unknown');
    expect(activity.sourceUrl).toBe('https://library.example/branch');
    expect(activity.sourceName).toBeTruthy();
  });
});

// ── T-11 ───────────────────────────────────────────────────────────────────
// No exact matches → the empty state suggests synonyms, radius expansion, adjacent
// times/dates, and expected/seasonal options.
describe('T-11 — an empty result set broadens with synonyms/radius/expected and explains itself', () => {
  it('a no-match query applies the synonym → radius → expected-section broadening ladder', () => {
    const res = engine.search({ q: 'pottery class', now: FIXTURE_NOW, origin: nearEastVan, minResults: 3, limit: 20 });
    expect(res.total).toBe(0); // no exact matches
    const rungs = res.broadening.applied.map((r) => r.key);
    expect(rungs).toEqual(expect.arrayContaining(['synonym_widen', 'radius_expand', 'expected_section']));
  });

  it('names the blocking constraint and quantifies the relaxations (Flow 5 explanation)', () => {
    const res = engine.search({ q: 'pottery class', now: FIXTURE_NOW, origin: nearEastVan, minResults: 3, limit: 20 });
    expect(res.broadening.emptyState).not.toBeNull();
    expect(res.broadening.emptyState!.blockingConstraint).toBe('text');
    expect(res.broadening.emptyState!.singleRelaxations.length).toBeGreaterThan(0);
  });

  it('surfaces expected/seasonal options separately from confirmed results', () => {
    // A winter query in July has no confirmed matches but a seasonal option exists.
    const res = engine.search({ q: 'tobogganing', now: FIXTURE_NOW, minResults: 3, limit: 20 });
    expect(res.total).toBe(0);
    expect(ids(res.expected)).toContain('l-toboggan-seasonal');
  });
});

// ── T-12 ───────────────────────────────────────────────────────────────────
// User reports wrong info → a correction record enters the QA queue.
describe('T-12 — a "report wrong info" submission becomes a valid QA-queue correction', () => {
  it('validates a report into a persistable correction (occurrence + issue type + note)', () => {
    const result = parseCorrectionReportBody({
      occurrence_id: '11111111-1111-1111-1111-111111111111',
      reason: 'The listed start time is wrong',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.occurrenceId).toBe('11111111-1111-1111-1111-111111111111');
      expect(result.value.issueType).toBe('wrong_info'); // default issue type for the single button
      expect(result.value.note).toBe('The listed start time is wrong');
    }
  });

  it('rejects a report with no valid occurrence reference (never enters the queue)', () => {
    const result = parseCorrectionReportBody({ note: 'no occurrence id here' });
    expect(result.ok).toBe(false);
  });
  // NOTE: the correction_report INSERT (status 'open') + its appearance in /admin/qa-queue
  // are covered by tests/corrections/route.test.ts and tests/admin/qa-queue-db.test.ts.
});

// ── T-13 ───────────────────────────────────────────────────────────────────
// Signed-in repeat user → can save home/postal + preferences and rerun a saved search.
describe('T-13 — a saved search validates and reruns to the same results', () => {
  it('validates a saved-search envelope carrying the home postal + query params', () => {
    const result = parseSavedSearchCreate({
      name: 'Open gym near home',
      params: { q: 'open gym', postal: 'V5L', origin: 'saved_home' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('Open gym near home');
      expect(result.value.params.postal).toBe('V5L');
    }
  });

  it('rejects an empty saved search (no search fields to rerun)', () => {
    const result = parseSavedSearchCreate({ name: 'empty', params: {} });
    expect(result.ok).toBe(false);
  });

  it('re-running the same saved search yields identical results (deterministic rerun)', () => {
    const req = { q: 'open gym', now: FIXTURE_NOW, origin: nearEastVan, minResults: 3, limit: 20 } as const;
    const first = engine.search({ ...req });
    const second = engine.search({ ...req });
    expect(ids(second.results)).toEqual(ids(first.results));
  });
});

// ── T-14 ───────────────────────────────────────────────────────────────────
// Analytics dashboard records search, filter, no-result, source click, correction,
// active-user, retention, and source-health events.
describe('T-14 — the analytics catalog covers the dashboard event surface', () => {
  const types = new Set(EVENT_CATALOG.map((e) => e.type));

  it('records the concrete launch events the dashboard reads', () => {
    // search + filter + no-result are all captured on the one search event (query text +
    // filter tokens in search_context, result counts incl. zero in result_summary).
    const search = catalogEntry('search_performed');
    expect(search).toBeTruthy();
    expect(search!.provenance).toMatch(/KPI #1/);
    // source click, correction, and account sign-in (the active-user signal) each exist.
    expect(types.has('outbound_source_click')).toBe(true);
    expect(types.has('correction_report_submitted')).toBe(true);
    expect(types.has('account_signed_in')).toBe(true);
    expect(types.has('listing_viewed')).toBe(true);
  });

  it('active-user & retention are derived from event user_or_session, and source-health from the ingestion table', () => {
    // These are computed metrics, not their own event types: active-user/retention come
    // from lib/analytics/kpi.ts + retention.ts over the recorded events, and source-health
    // is derived from source_check_run via isSourceStale — asserted in T-15.
    expect(typeof isSourceStale).toBe('function');
    // The catalog also explicitly records what is deferred/N-A at launch, so nothing is
    // silently missing.
    expect(DEFERRED_EVENT_TYPES.some((d) => d.type === 'search_autocomplete_selected')).toBe(true);
  });
});

// ── T-15 ───────────────────────────────────────────────────────────────────
// A source stale beyond its cadence is labelled stale and appears in the source-health
// dashboard.
describe('T-15 — a source past its cadence is flagged stale', () => {
  const now = Date.parse('2026-07-20T00:00:00Z');
  const weekly = 7 * 24 * 3600; // cadence seconds

  it('flags a source whose last success is older than its cadence', () => {
    const stale = isSourceStale(
      { lastSuccessAtMs: now - 30 * 24 * 3600 * 1000, lastRunAtMs: now, cadenceSeconds: weekly },
      now
    );
    expect(stale).toBe(true);
  });

  it('does not flag a source refreshed within its cadence', () => {
    const fresh = isSourceStale(
      { lastSuccessAtMs: now - 3 * 24 * 3600 * 1000, lastRunAtMs: now, cadenceSeconds: weekly },
      now
    );
    expect(fresh).toBe(false);
  });

  it('does not false-alarm a never-run source, but does flag an attempted-but-failing one', () => {
    expect(isSourceStale({ lastSuccessAtMs: null, lastRunAtMs: null, cadenceSeconds: weekly }, now)).toBe(false);
    expect(isSourceStale({ lastSuccessAtMs: null, lastRunAtMs: now, cadenceSeconds: weekly }, now)).toBe(true);
  });

  it('a stale-status listing is still shown but classified low-priority (primary, ranked down)', () => {
    // The search read model shows stale listings (STATUS_CLASS.stale === 'primary') so a
    // parent still sees them, and honest ranking pushes them below confirmed equivalents.
    expect(STATUS_CLASS.stale).toBe('primary');
    const res = engine.search({ q: 'open gym', now: FIXTURE_NOW, origin: nearEastVan, minResults: 1, limit: 20 });
    const got = ids(res.results);
    // Both must be PRESENT before comparing ranks — otherwise a dropped confirmed listing
    // would give indexOf === -1 and pass the ordering check vacuously.
    expect(got).toContain('l-rank-confirmed');
    expect(got).toContain('l-rank-stale');
    expect(got.indexOf('l-rank-confirmed')).toBeLessThan(got.indexOf('l-rank-stale'));
  });
});
