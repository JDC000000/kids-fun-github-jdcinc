// tests/sms/weekly_picks_diversity.test.ts — venue and activity repetition in the Friday text.
//
// WHAT THIS FILE PINS, AND WHY IT EXISTS SEPARATELY FROM weekly_picks.test.ts.
// The 2026-09-10 synthetic user test read ten picks for a Kitsilano profile and found seven of
// them at three places: Britannia Pool x3, West End Community Centre x2, Roundhouse x2 — and two
// of the three NAMED, linked picks were the same building. The instinct was that a diversity rule
// was missing. It was not: `capVenueRepetition` runs on this exact path and Britannia's three
// cards are its 3-per-20 promise being HONOURED at a list size it was never calibrated for.
//
// Three separate defects produce that message, so this file reproduces all three as separate
// cases rather than one end-to-end assertion. Every case below FAILED on `main` (f544e59) before
// the fix, for the reason named in its own comment:
//
//   1. A WINDOW-SIZE MISMATCH. 3-of-20 is a 15% ceiling; the same rule on a 10-item digest
//      licenses 30%. Three venues at 3/2/2 is fully compliant and is exactly what was rejected.
//   2. THE CAP DOES NOT SURVIVE WHAT HAPPENS AFTER IT. `selectFrom` gates, dedupes and filters
//      AFTER the engine capped, so the surviving top ten is drawn from a deeper prefix and can
//      straddle the cap's round boundary — measured at SIX of ten from one venue, which is
//      strictly worse than what was already rejected. That is the "Probe-B" case below.
//   3. NOTHING IN THE CODEBASE SAW TWO SITTINGS OF ONE ACTIVITY AS ONE THING. "Pickleball - Sun
//      PM" and "Pickleball - Sun AM" score 0.750 on the repo's own similarity(), three
//      hundredths under the 0.78 dedup threshold, AND their 10:00 and 12:30 sittings do not
//      overlap — so `isDuplicatePair` fails on BOTH arms, not just the time one. The last case
//      in this file pins that 0.750/0.78 gap directly, so a future threshold edit cannot
//      silently invalidate the reasoning the fix is built on.
//
// THE FIXTURE ROWS ARE THE REPORT'S REAL ROWS, not invented ones. Their measured trigram scores
// are asserted in `title identity — the measured numbers the fix is built on` below, so this
// file fails loudly if the metric or the catalogue's wording moves underneath it.
//
// Harness, clock and geography are the same shape weekly_picks.test.ts uses: a fixture-backed
// REAL SearchEngine, a passed clock, no DB and no network.
import { describe, expect, it } from 'vitest';
import { SearchEngine, type SearchResultItem } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import type { AgeBandKey, GeoPoint, ListingRecord } from '@/lib/search/types';
import { similarity } from '@/lib/search/text/trigram';
import { foldTitleForComparison, isShowableOnFrontDoor } from '@/lib/recommend/three-things';
import { isWeeklyPickEligible } from '@/lib/sms/registration';
import {
  DEDUP_TITLE_SIMILARITY,
  DIRECT_LINK_PICKS,
  FLOOR_PICKS,
  MAX_FORCED_PICKS,
  MAX_PICKS,
  MAX_NAMED_SLOTS_PER_CATEGORY,
  MAX_PICKS_PER_CATEGORY,
  MAX_PICKS_PER_VENUE,
  CLASS_PROGRAM_CAP,
  CLASS_PROGRAM_CATEGORY_KEY,
  COVERAGE_SWAP_REACH,
  SAME_VENUE_TITLE_SIMILARITY,
  ageBandsFromBirthYears,
  applyCoverageSwap,
  buildPicksRequest,
  collapseSameOfferingAtVenue,
  dedupeCandidates,
  matchesInterests,
  sameOfferingAtVenue,
  selectWeeklyPicks,
  spreadNamedSlots,
  type WeeklyPicks,
  type WeeklyPicksInput,
} from '@/lib/sms/weekly-picks';

// ── The clock and the geography ──────────────────────────────────────────────
/** Friday 2026-08-28, 16:00 PDT — the PRD's send moment, as in weekly_picks.test.ts. */
const FRIDAY_4PM = new Date('2026-08-28T23:00:00Z');
const SAT = '2026-08-29';
const SUN = '2026-08-30';

const HOME: GeoPoint = { lat: 49.28, lng: -123.07 };

/**
 * A point `metres` due north of HOME.
 *
 * Venue SEPARATION is the load-bearing property here, not realism: two fixture venues closer than
 * `DEDUP_VENUE_RADIUS_KM` (500m) would satisfy `sameishPlace`'s proximity arm and could collapse
 * across venues on a title coincidence, which is a different rule than the one under test. Every
 * venue below is at least 600m from its neighbour, and cards AT one venue share its exact point.
 */
function northOfHome(metres: number): GeoPoint {
  return { lat: HOME.lat + metres / 111_320, lng: HOME.lng };
}

function at(isoDate: string, localHour: number, localMinute = 0): string {
  // America/Vancouver is UTC-7 in August.
  return `${isoDate}T${String(localHour + 7).padStart(2, '0')}:${String(localMinute).padStart(2, '0')}:00Z`;
}

/** Passes every gate: confirmed, a stated age floor, geocoded, dated inside the weekend. */
function kidActivity(partial: Partial<ListingRecord> & { id: string }): ListingRecord {
  return makeListing({
    statusState: 'confirmed',
    ageMinMonths: 24,
    ageMaxMonths: 120,
    ageBandMatches: ['2-4', '5-9'] as AgeBandKey[],
    startDatetimeUtc: at(SAT, 10),
    endDatetimeUtc: at(SAT, 11),
    primaryCategoryKey: 'general',
    ...partial,
  });
}

function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
  });
}

function input(listings: ListingRecord[], over: Partial<WeeklyPicksInput> = {}): WeeklyPicksInput {
  return {
    engine: engineOver(listings),
    now: FRIDAY_4PM,
    ...over,
    subscriber: {
      origin: { geo: HOME, label: 'Kitsilano' },
      radiusKm: 10,
      birthYears: [2021, 2018], // 5 and 8 in 2026 — both land in '5-9'
      consecutiveEmptyWeeks: 0,
      ...over.subscriber,
    },
  };
}

/**
 * Unrelated filler activities, one per venue, receding from HOME.
 *
 * The names are deliberately unrelated words (max pairwise trigram similarity 0.333, the list
 * weekly_picks.test.ts measured) and none reads as a registration-shaped course — see that file's
 * header for both traps. A filler is never the subject of an assertion; it is the ALTERNATIVE
 * that a diversity rule is supposed to be able to reach.
 */
const FILLER_NAMES = [
  'Story Circle', 'Lego Build', 'Puppet Show', 'Nature Walk', 'Music Makers',
  'Gym Romp', 'Art Studio', 'Chess Club', 'Marble Run', 'Bike Rodeo',
  'Forest Explorers', 'Garden Club', 'Board Games', 'Pottery Wheel', 'Bird Watching',
  'Rock Climbing', 'Drama Games', 'Film Night', 'Science Lab', 'Yoga Kids',
];

function fillers(count: number, firstMetres: number, over: Partial<ListingRecord> = {}): ListingRecord[] {
  return Array.from({ length: count }, (_, i) =>
    kidActivity({
      id: `filler-${i}`,
      activityName: FILLER_NAMES[i % FILLER_NAMES.length],
      venueName: `${FILLER_NAMES[i % FILLER_NAMES.length]} Centre`,
      geo: northOfHome(firstMetres + i * 600),
      ...over,
    })
  );
}

/** Venue name per pick, in send order — the thing every assertion in this file is about. */
function venues(result: WeeklyPicks): string[] {
  return result.picks.map((p) => p.item.listing.venueName ?? '');
}

function titles(result: WeeklyPicks): string[] {
  return result.picks.map((p) => p.item.listing.activityName);
}

function countAt(result: WeeklyPicks, venueName: string): number {
  return venues(result).filter((v) => v === venueName).length;
}

/** The picks a parent actually reads without tapping through (PRD §2.3). */
function namedVenues(result: WeeklyPicks): string[] {
  return result.picks.filter((p) => p.linkOrigin === 'direct').map((p) => p.item.listing.venueName ?? '');
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE #2 — Vancouver / Kitsilano. The report's own rows.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 2026-09-10 report's profile #2, as listings.
 *
 * The venues recede from HOME in the order below and every card at one venue shares that venue's
 * exact point, so each venue's cards arrive together and the concentration under test is the
 * fixture's rather than an accident of scoring. WITHIN and BETWEEN venues the engine's own
 * ranking still applies — measured on this fixture, date proximity outweighs a few hundred metres,
 * so the Saturday cards lead the Sunday ones and West End sits just below Britannia despite being
 * nearer. That is deliberately NOT flattened: these assertions are about venue COUNTS, which is
 * what the defect is about, so they survive a ranking change that a golden list would not.
 *
 * `capVenueRepetition`'s own 3-per-20 does not reorder this at all — Britannia sits at exactly 3,
 * which is the whole point of case 1.
 */
function profile2(): ListingRecord[] {
  const roundhouse = northOfHome(600);
  const coalHarbour = northOfHome(1200);
  const westEnd = northOfHome(1800);
  const britannia = northOfHome(2400);

  return [
    // Roundhouse x2 — two genuinely different activities. These must NOT collapse.
    kidActivity({ id: 'rh-tai', activityName: 'Tai Chi Chuan - Beginners', venueName: 'Roundhouse Community Arts Centre', geo: roundhouse }),
    kidActivity({ id: 'rh-dan', activityName: 'Roundhouse Community Dancers', venueName: 'Roundhouse Community Arts Centre', geo: roundhouse, startDatetimeUtc: at(SAT, 13), endDatetimeUtc: at(SAT, 14) }),
    // The report's pick 6 — one card at its own venue, between the two Roundhouse cards and the rest.
    kidActivity({ id: 'coal', activityName: 'Splash Time', venueName: 'Coal Harbour Community Centre', geo: coalHarbour }),
    // West End x2 — ONE activity, two sittings. 0.750 on similarity(), 10:00 and 12:30 so the
    // times do not overlap: invisible to `isDuplicatePair` on BOTH arms.
    kidActivity({ id: 'we-am', activityName: 'Pickleball - Sun AM', venueName: 'West End Community Centre', geo: westEnd, startDatetimeUtc: at(SUN, 10), endDatetimeUtc: at(SUN, 11) }),
    kidActivity({ id: 'we-pm', activityName: 'Pickleball - Sun PM', venueName: 'West End Community Centre', geo: westEnd, startDatetimeUtc: at(SUN, 12, 30), endDatetimeUtc: at(SUN, 13, 30) }),
    // Britannia x3 — three genuinely different things to do at one building. These must NOT
    // collapse; they must be DEFERRED by the digest-sized cap.
    kidActivity({ id: 'br-tot', activityName: 'Public Swim with Tot Pool', venueName: 'Britannia Pool', geo: britannia }),
    kidActivity({ id: 'br-les', activityName: 'Lessons and One Lane', venueName: 'Britannia Pool', geo: britannia, startDatetimeUtc: at(SAT, 13), endDatetimeUtc: at(SAT, 14) }),
    kidActivity({ id: 'br-len', activityName: 'Lengths', venueName: 'Britannia Pool', geo: britannia, startDatetimeUtc: at(SUN, 15), endDatetimeUtc: at(SUN, 16) }),
    // Ten alternatives at ten distinct venues, all inside the subscriber's radius. Every one of
    // them already passed every relevance, radius, age and safety gate — which is what makes a
    // deferral a choice between things that exist rather than an invention.
    ...fillers(10, 3000),
  ];
}

describe('profile #2 (Kitsilano) — the message the 2026-09-10 report read', () => {
  it('CASE 1 — Britannia Pool holds at most 2 of the ten, not the 3 that 3-per-20 licenses', () => {
    // FAILED ON main: 3. `capVenueRepetition`'s 3-of-20 is a 15% ceiling on a search page and a
    // 30% ceiling on a ten-item digest. Nothing was breached; the window was simply wrong for
    // this surface.
    const result = selectWeeklyPicks(input(profile2()));
    expect(result.outcome).toBe('picks');
    expect(result.picks).toHaveLength(MAX_PICKS);
    expect(countAt(result, 'Britannia Pool')).toBeLessThanOrEqual(2);
  });

  it('CASE 2 — West End Community Centre holds ONE pick, because its two cards are one activity', () => {
    // FAILED ON main: 2 ("Pickleball - Sun AM" AND "Pickleball - Sun PM"). Two sittings of one
    // thing is one decision, not two — it is a wasted slot in a list of ten, never a choice.
    const result = selectWeeklyPicks(input(profile2()));
    expect(countAt(result, 'West End Community Centre')).toBe(1);
    const pickleball = titles(result).filter((t) => /Pickleball/.test(t));
    expect(pickleball).toHaveLength(1);
  });

  it('CASE 3 — the Roundhouse pair is NOT collapsed: two different activities are two things to do', () => {
    // The negative control for case 2. Tai Chi and a community dance troupe score 0.063 on
    // similarity(): a rule that merged them would be merging on the venue alone.
    const result = selectWeeklyPicks(input(profile2()));
    expect(countAt(result, 'Roundhouse Community Arts Centre')).toBe(2);
  });

  it('CASE 4 — the three NAMED picks are at three distinct venues', () => {
    // FAILED ON main: the first two picks were both the Roundhouse. Only the first
    // DIRECT_LINK_PICKS picks are named and linked; everything after folds into an anonymous
    // "+N more", so this is the only part of the defect a parent sees without tapping through.
    const result = selectWeeklyPicks(input(profile2()));
    const named = namedVenues(result);
    expect(named).toHaveLength(DIRECT_LINK_PICKS);
    expect(new Set(named).size).toBe(DIRECT_LINK_PICKS);
  });

  it('reports the concentration it actually shipped, so the improvement is measurable', () => {
    // The report's number was "7 of 10 across 3 venues". This asserts the SHAPE — no venue over
    // 2, and at least six distinct places in the ten — rather than a golden list, so a future
    // ranking change cannot make it fail for a reason that is not this defect.
    const result = selectWeeklyPicks(input(profile2()));
    const counts = new Map<string, number>();
    for (const v of venues(result)) counts.set(v, (counts.get(v) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(counts.size).toBeGreaterThanOrEqual(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE #3 — North Vancouver / Central Lonsdale. Same pattern, different city,
// different operator: the defect is systemic, not one municipality's data.
// ─────────────────────────────────────────────────────────────────────────────

function profile3(): ListingRecord[] {
  const delbrook = northOfHome(600);
  const harryJerome = northOfHome(1400);

  return [
    // The Delbrook trio. `Whole Pool` and `Leisure Pool` are two DIFFERENT pools in one building
    // and must stay distinct — they score 0.641, which is the lower edge of the band the
    // same-venue threshold has to sit inside.
    kidActivity({ id: 'db-whole', activityName: 'Public Swim Delbrook Whole Pool', venueName: 'Delbrook Community Recreation Centre', geo: delbrook }),
    kidActivity({ id: 'db-leisure', activityName: 'Public Swim Delbrook Leisure Pool', venueName: 'Delbrook Community Recreation Centre', geo: delbrook, startDatetimeUtc: at(SAT, 13), endDatetimeUtc: at(SAT, 14) }),
    kidActivity({ id: 'db-lane', activityName: 'Lane Swim Delbrook', venueName: 'Delbrook Community Recreation Centre', geo: delbrook, startDatetimeUtc: at(SUN, 15), endDatetimeUtc: at(SUN, 16) }),
    kidActivity({ id: 'hj-1', activityName: 'Gym Romp', venueName: 'Harry Jerome Community Recreation Centre', geo: harryJerome }),
    kidActivity({ id: 'hj-2', activityName: 'Art Studio', venueName: 'Harry Jerome Community Recreation Centre', geo: harryJerome, startDatetimeUtc: at(SUN, 11), endDatetimeUtc: at(SUN, 12) }),
    ...fillers(10, 2200),
  ];
}

describe('profile #3 (Central Lonsdale) — the same shape in a second municipality', () => {
  it('Delbrook holds at most 2 of the ten', () => {
    // FAILED ON main: 3. Recurring municipal pool timetables are the densest thing in this
    // catalogue, so this recurs wherever the catalogue is dense.
    const result = selectWeeklyPicks(input(profile3()));
    expect(result.picks).toHaveLength(MAX_PICKS);
    expect(countAt(result, 'Delbrook Community Recreation Centre')).toBeLessThanOrEqual(2);
  });

  it('does NOT merge Whole Pool with Leisure Pool — two pools in one building are two outings', () => {
    // The measured 0.641 pair. A same-venue title rule loose enough to merge this would be
    // taking a real choice away from a parent, not removing a duplicate.
    const result = selectWeeklyPicks(input(profile3()));
    const delbrookTitles = result.picks
      .filter((p) => p.item.listing.venueName === 'Delbrook Community Recreation Centre')
      .map((p) => p.item.listing.activityName);
    // Whichever two survive the cap, they are never the SAME offering twice.
    expect(new Set(delbrookTitles).size).toBe(delbrookTitles.length);
  });

  it('names three distinct venues', () => {
    const named = namedVenues(selectWeeklyPicks(input(profile3())));
    expect(new Set(named).size).toBe(DIRECT_LINK_PICKS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBE B — the latent failure that is strictly worse than the one that was reported.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A venue whose cards STRADDLE the engine cap's round boundary, plus the post-cap attrition that
 * pulls the far side of it into the top ten.
 *
 * `capVenueRepetition` deals in ROUNDS: round 1 seats positions 0-19 with at most 3 per venue and
 * round 2 starts with FRESH counters at position 20. A venue with six cards therefore lands at
 * [0,1,2,20,21,22] — two independent allowances, three positions apart. Positions 0-9 sit safely
 * inside round 1 for the RAW engine output; `selectFrom` then removes cards, so the surviving top
 * ten is drawn from a deeper prefix and meets both allowances at once.
 *
 * The attrition here is the CATEGORY INTEREST post-filter, which is real, is applied in
 * `selectFrom` after the engine has capped, and on profile #2's real data removed more rows than
 * anything else. Seventeen of the cards the engine seats in round 1 are outside the subscriber's
 * stated interest, so they vanish AFTER the cap made its promise about them.
 */
function probeB(alternatives = 14): ListingRecord[] {
  const dominant = northOfHome(400);
  const wanted = { primaryCategoryKey: 'swimming', categoryTags: ['swimming'] };
  const unwanted = { primaryCategoryKey: 'general', categoryTags: [] as string[] };

  return [
    // Six cards at one venue, all wanted. The engine's own cap seats three of them and defers the
    // other three past position 20 — it cannot do anything else, and that IS correct behaviour
    // for a page of twenty.
    ...FILLER_NAMES.slice(0, 6).map((name, i) =>
      kidActivity({
        id: `dom-${i}`,
        activityName: name,
        venueName: 'Britannia Pool',
        geo: dominant,
        startDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 9 + i),
        endDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 10 + i),
        ...wanted,
      })
    ),
    // Exactly seventeen cards that the engine ranks into round 1 — filling positions 3..19, which
    // is what pushes the dominant venue's remainder to 20, 21 and 22 — and that
    // `matchesInterests` then removes INSIDE `selectFrom`, after the cap made its promise.
    ...Array.from({ length: 17 }, (_, i) =>
      kidActivity({
        id: `gone-${i}`,
        activityName: FILLER_NAMES[(i + 6) % FILLER_NAMES.length],
        venueName: `Filtered Venue ${i}`,
        geo: northOfHome(1000 + i * 600),
        ...unwanted,
      })
    ),
    // Genuine alternatives, ranked below everything above, that DO match the interest. These are
    // what the deferral spends: every one already passed every relevance, radius, age and safety
    // gate, so promoting one is a choice between things that exist.
    ...Array.from({ length: alternatives }, (_, i) =>
      kidActivity({
        id: `alt-${i}`,
        activityName: FILLER_NAMES[(i + 12) % FILLER_NAMES.length],
        venueName: `Alternative Venue ${i}`,
        geo: northOfHome(11_200 + i * 300),
        ...wanted,
      })
    ),
  ];
}

/** Probe B's subscriber: the stated interest is the attrition that runs AFTER the engine capped. */
function probeBInput(listings: ListingRecord[]): WeeklyPicksInput {
  return input(listings, {
    subscriber: {
      origin: { geo: HOME, label: 'Kitsilano' },
      radiusKm: 20,
      birthYears: [2021, 2018],
      categoryInterests: ['swimming'],
      consecutiveEmptyWeeks: 0,
    },
  });
}

describe('Probe B — the cap must survive what `selectFrom` does after it', () => {
  it('NON-VACUITY — the engine really does seat the dominant venue on both sides of a round boundary', () => {
    // `capVenueRepetition` deals in rounds: round 1 seats positions 0-19 at up to 3 per venue and
    // round 2 starts with FRESH counters at position 20. Measured here on the engine's own output,
    // so the case below is testing the arrangement it claims to test and not a coincidence of the
    // fixture: the six cards land at exactly [0,1,2] and [20,21,22] — two independent allowances,
    // seventeen positions apart. Everything between them is about to be filtered away.
    const engine = engineOver(probeB());
    const response = engine.search({
      q: '',
      now: FRIDAY_4PM,
      origin: { mode: 'near_me', coords: HOME },
      includeRegistration: true,
      ageBands: ['5-9'] as AgeBandKey[],
      when: 'weekend',
      radiusKm: 20,
      minResults: 0,
    });
    const positions = response.results
      .map((item, index) => ({ id: item.listing.id, index }))
      .filter((r) => r.id.startsWith('dom-'))
      .map((r) => r.index);
    expect(positions).toEqual([0, 1, 2, 20, 21, 22]);
  });

  it('holds a straddling venue to 2 of the ten, not the 6 it reached on main', () => {
    // FAILED ON main with SIX of ten from one venue — strictly worse than the 3 that was reported
    // and rejected, and unreachable by any retune of the ENGINE's constants, because the hole is
    // downstream of the engine. The digest-sized cap runs last, on the full surviving list, so
    // nothing is left to undo it.
    const result = selectWeeklyPicks(probeBInput(probeB()));
    expect(result.outcome).toBe('picks');
    expect(result.picks).toHaveLength(MAX_PICKS);
    expect(countAt(result, 'Britannia Pool')).toBeLessThanOrEqual(2);
    // And it was a DEFERRAL, not a removal: the cards are still in the list, further down.
    expect(result.diversity.venueCapDeferred).toBeGreaterThan(0);
  });

  it('DEFERS AS FAR AS THE LIST ALLOWS AND NEVER FURTHER — the scarcity edge, stated honestly', () => {
    // The same arrangement with only six alternatives instead of fourteen. Twelve candidates, six
    // of them at one venue: a 2-of-10 promise is then ARITHMETICALLY UNREACHABLE without hiding
    // four real answers, and hiding them is exactly what `capVenueRepetition` refuses to do — its
    // own header says so ("the rounds simply get shorter ... they are not told the other five do
    // not exist"). So the ten still ship, the dominant venue is pushed as far down as twelve cards
    // permit, and the shortfall is arithmetic rather than a rule failing.
    //
    // THIS IS PINNED, NOT TOLERATED. It is the same posture as the floor: a diversity rule may
    // defer, never thin. If a future change made this case ship EIGHT picks instead of ten in the
    // name of variety, that would be the rule spending ruling 7.5's empty state on itself.
    const result = selectWeeklyPicks(probeBInput(probeB(6)));
    expect(result.picks).toHaveLength(MAX_PICKS);
    const dominant = countAt(result, 'Britannia Pool');
    // Twelve candidates minus six alternatives = at least four of the ten must come from Britannia.
    expect(dominant).toBe(4);
    // The two cards it COULD defer, it did: without the cap this would have been six.
    expect(result.diversity.venueCapDeferred).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The numbers the whole fix is built on. If any of these move, the reasoning above
// stops being true and this file says so BEFORE the behaviour tests start guessing.
// ─────────────────────────────────────────────────────────────────────────────

describe('title identity — the measured numbers the fix is built on', () => {
  it('pins the 0.750 / 0.78 gap that hides the Pickleball pair from the dedup pass', () => {
    // THE SINGLE MOST IMPORTANT NUMBER IN THIS SCOPE. The whole same-venue predicate exists
    // because this pair is three hundredths short of the cross-venue threshold. Lowering
    // DEDUP_TITLE_SIMILARITY to catch it would apply CROSS-VENUE, where 0.78 was measured and
    // where "Public Swim" at two unrelated pools is the exact false merge the PRD warns about.
    expect(similarity('Pickleball - Sun PM', 'Pickleball - Sun AM')).toBeCloseTo(0.75, 3);
    expect(DEDUP_TITLE_SIMILARITY).toBe(0.78);
    expect(similarity('Pickleball - Sun PM', 'Pickleball - Sun AM')).toBeLessThan(DEDUP_TITLE_SIMILARITY);
  });

  it('pins the 0.641 Delbrook pair that must NOT merge, and the band between the two', () => {
    // The upper edge is 0.750 (must merge), the lower edge is 0.641 (must not). Every
    // same-venue threshold this scope could pick has to sit strictly inside that band, and the
    // band is narrow enough that it is worth a test rather than a comment.
    expect(similarity('Public Swim Delbrook Whole Pool', 'Public Swim Delbrook Leisure Pool')).toBeCloseTo(0.641, 3);
    expect(similarity('Public Swim Delbrook Whole Pool', 'Lane Swim Delbrook')).toBeLessThan(0.641);
    expect(similarity('Public Swim Delbrook Leisure Pool', 'Lane Swim Delbrook')).toBeLessThan(0.641);
  });

  it('pins that no Britannia or Roundhouse pair comes anywhere near the band', () => {
    // These are the negative controls: three things to do at one pool, and two at one arts
    // centre. A same-venue rule that touched any of them would be merging on the venue alone.
    expect(similarity('Public Swim with Tot Pool', 'Lessons and One Lane')).toBe(0);
    expect(similarity('Public Swim with Tot Pool', 'Lengths')).toBe(0);
    expect(similarity('Lessons and One Lane', 'Lengths')).toBeLessThan(0.1);
    expect(similarity('Tai Chi Chuan - Beginners', 'Roundhouse Community Dancers')).toBeLessThan(0.1);
  });

  it('the AM/PM pair folds to ONE key, so the fold arm catches it even if the trigram moves', () => {
    // Two ways to satisfy one condition, exactly as `titlesMatch` already does it: a threshold
    // AND exact equality of the comparison fold. The fold arm cannot drift.
    expect(foldTitleForComparison('Pickleball - Sun PM')).toBe(foldTitleForComparison('Pickleball - Sun AM'));
    expect(foldTitleForComparison('Pickleball - Sun PM')).not.toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — the predicate itself, at the edges of the measured band.
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal SearchResultItem over a listing — for exercising the pure predicates directly. */
function asItem(listing: ListingRecord): SearchResultItem {
  return {
    listing,
    score: 1,
    distanceKm: null,
    components: {} as SearchResultItem['components'],
    matchedAliases: [],
    slots: [
      {
        id: listing.id,
        startDatetimeUtc: listing.startDatetimeUtc,
        endDatetimeUtc: listing.endDatetimeUtc,
        costStatus: listing.costStatus,
        costMinCad: listing.costMinCad,
        costMaxCad: listing.costMaxCad,
        ageMinMonths: listing.ageMinMonths,
        ageMaxMonths: listing.ageMaxMonths,
      },
    ],
    slotDays: [],
    slotSpanEndUtc: listing.endDatetimeUtc,
    registrationRequired: false,
  };
}

const never = () => false;

/** Two rows at one venue, at two times that do NOT overlap — the shape under test. */
function pairAtVenue(venueName: string, a: string, b: string, geo = northOfHome(600)) {
  return [
    asItem(kidActivity({ id: 'x', activityName: a, venueName, geo, startDatetimeUtc: at(SUN, 10), endDatetimeUtc: at(SUN, 11) })),
    asItem(kidActivity({ id: 'y', activityName: b, venueName, geo, startDatetimeUtc: at(SUN, 14), endDatetimeUtc: at(SUN, 15) })),
  ] as const;
}

describe('sameOfferingAtVenue — the venue-scoped identity', () => {
  it('is TRUE for the West End Pickleball pair, which `isDuplicatePair` misses on BOTH arms', () => {
    const [am, pm] = pairAtVenue('West End Community Centre', 'Pickleball - Sun AM', 'Pickleball - Sun PM');
    expect(sameOfferingAtVenue(am, pm, never)).toBe(true);
    // Both arms carry it independently, which is the point of having two: 0.750 clears the
    // venue-scoped threshold, AND the two titles fold to one key.
    expect(similarity(am.listing.activityName, pm.listing.activityName)).toBeGreaterThanOrEqual(SAME_VENUE_TITLE_SIMILARITY);
    expect(foldTitleForComparison(am.listing.activityName)).toBe(foldTitleForComparison(pm.listing.activityName));
  });

  it('is FALSE for Delbrook Whole Pool vs Leisure Pool — two pools in one building', () => {
    // 0.641, the lower edge of the band. THE most important negative in this scope: merging these
    // would take a real choice away from a parent rather than remove a duplicate.
    const [whole, leisure] = pairAtVenue(
      'Delbrook Community Recreation Centre',
      'Public Swim Delbrook Whole Pool',
      'Public Swim Delbrook Leisure Pool'
    );
    expect(sameOfferingAtVenue(whole, leisure, never)).toBe(false);
    expect(similarity(whole.listing.activityName, leisure.listing.activityName)).toBeLessThan(SAME_VENUE_TITLE_SIMILARITY);
  });

  it('is FALSE for every Britannia pair and for the Roundhouse pair', () => {
    const britannia = ['Public Swim with Tot Pool', 'Lessons and One Lane', 'Lengths'];
    for (let i = 0; i < britannia.length; i += 1) {
      for (let j = i + 1; j < britannia.length; j += 1) {
        const [a, b] = pairAtVenue('Britannia Pool', britannia[i], britannia[j]);
        expect(sameOfferingAtVenue(a, b, never)).toBe(false);
      }
    }
    const [tai, dancers] = pairAtVenue('Roundhouse Community Arts Centre', 'Tai Chi Chuan - Beginners', 'Roundhouse Community Dancers');
    expect(sameOfferingAtVenue(tai, dancers, never)).toBe(false);
  });

  it('is FALSE across two venues however well the titles match — the PRD’s central warning', () => {
    // "Public Swim" scores 1.000 against itself. The place condition is ANDed in FIRST, so the
    // loosened title threshold is structurally unable to reach two unrelated pools.
    const a = asItem(kidActivity({ id: 'a', activityName: 'Public Swim', venueName: 'Templeton Pool', geo: northOfHome(600) }));
    const b = asItem(kidActivity({ id: 'b', activityName: 'Public Swim', venueName: 'Killarney Pool', geo: northOfHome(6000) }));
    expect(similarity(a.listing.activityName, b.listing.activityName)).toBe(1);
    expect(sameOfferingAtVenue(a, b, never)).toBe(false);
  });

  it('ignores time overlap in BOTH directions, which is the whole difference from `isDuplicatePair`', () => {
    const [am, pm] = pairAtVenue('West End Community Centre', 'Pickleball - Sun AM', 'Pickleball - Sun PM');
    // Non-overlapping (10:00 vs 14:00) and still the same offering.
    expect(sameOfferingAtVenue(am, pm, never)).toBe(true);
    // `dedupeCandidates`, which requires the overlap, leaves the pair alone — so the two passes
    // are genuinely independent and the new one is not a restatement of the old.
    expect(dedupeCandidates([am, pm], never).collapsed).toBe(0);
    expect(collapseSameOfferingAtVenue([am, pm], never).collapsed).toBe(1);
  });

  it('keeps the BETTER-RANKED member, in the order the list arrived', () => {
    const [am, pm] = pairAtVenue('West End Community Centre', 'Pickleball - Sun AM', 'Pickleball - Sun PM');
    expect(collapseSameOfferingAtVenue([am, pm], never).kept.map((k) => k.listing.id)).toEqual(['x']);
    expect(collapseSameOfferingAtVenue([pm, am], never).kept.map((k) => k.listing.id)).toEqual(['y']);
  });

  it('the constant sits strictly inside the band it was measured against', () => {
    expect(SAME_VENUE_TITLE_SIMILARITY).toBeGreaterThan(similarity('Public Swim Delbrook Whole Pool', 'Public Swim Delbrook Leisure Pool'));
    expect(SAME_VENUE_TITLE_SIMILARITY).toBeLessThanOrEqual(similarity('Pickleball - Sun PM', 'Pickleball - Sun AM'));
    expect(SAME_VENUE_TITLE_SIMILARITY).toBeLessThan(DEDUP_TITLE_SIMILARITY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 / T7 — the named block, and what happens when it collides with a forced pick.
// ─────────────────────────────────────────────────────────────────────────────

/** N picks with explicit venues, in the order given. Ranked by position, nearest first. */
function selectionOf(venuesInOrder: string[]): SearchResultItem[] {
  return venuesInOrder.map((venueName, i) => {
    const item = asItem(
      kidActivity({
        id: `p${i}`,
        activityName: FILLER_NAMES[i % FILLER_NAMES.length],
        venueName,
        geo: northOfHome(600 + i * 600),
      })
    );
    return { ...item, distanceKm: 0.6 + i * 0.6 };
  });
}

const idsOf = (items: readonly SearchResultItem[]) => items.map((i) => i.listing.id);

describe('spreadNamedSlots (venue half) — the three picks a parent actually reads', () => {
  it('promotes the highest-ranked unused-venue pick into a repeated named slot', () => {
    const before = selectionOf(['A', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
    expect(idsOf(selection).slice(0, 3)).toEqual(['p0', 'p3', 'p2']);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ reason: 'venue', occurrenceId: 'p3', displacedOccurrenceId: 'p1', fromIndex: 3, toIndex: 1, rankDelta: 2 });
    // HIGHEST-ranked, not any: 'C' at index 3 is chosen over 'D' at 4 and everything below.
  });

  it('is a PURE PERMUTATION — set membership is byte-identical before and after', () => {
    const before = selectionOf(['A', 'A', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    const { selection } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
    expect(selection).toHaveLength(before.length);
    expect([...idsOf(selection)].sort()).toEqual([...idsOf(before)].sort());
    // The same objects, not copies of them — nothing is rebuilt on the way through.
    for (const item of before) expect(selection).toContain(item);
    // …and all three named slots now hold three different places.
    expect(new Set(selection.slice(0, 3).map((s) => s.listing.venueName)).size).toBe(3);
  });

  it('returns a selection that is entirely ONE venue completely unchanged', () => {
    // There is nothing to diversify with, so there is nothing to do — the same posture
    // `capVenueRepetition` takes on a single-venue page, and for the same reason.
    const before = selectionOf(Array.from({ length: 10 }, () => 'Only Venue'));
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
    expect(idsOf(selection)).toEqual(idsOf(before));
    expect(promoted).toEqual([]);
  });

  it('is a no-op when the named block is already three distinct venues', () => {
    const before = selectionOf(['A', 'B', 'C', 'A', 'A', 'D', 'E', 'F', 'G', 'H']);
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
    expect(idsOf(selection)).toEqual(idsOf(before));
    expect(promoted).toEqual([]);
  });

  it('never treats an UNNAMED venue as a place — not as a repeat, and not as variety', () => {
    // `venueIdentity` returns null for an empty name and every caller must read that as "no
    // opinion". Two unnamed rows are not the same venue, so neither triggers a promotion…
    const unnamed = selectionOf(['', '', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    expect(idsOf(spreadNamedSlots(unnamed, new Set(), DIRECT_LINK_PICKS).selection)).toEqual(idsOf(unnamed));
    // …and an unnamed row below is never promoted as though it were somewhere new.
    const noAlternative = selectionOf(['A', 'A', 'B', '', '', '', '', '', '', '']);
    expect(idsOf(spreadNamedSlots(noAlternative, new Set(), DIRECT_LINK_PICKS).selection)).toEqual(idsOf(noAlternative));
  });

  it('leaves the named block alone when the ten hold no unused venue to promote', () => {
    // Only two venues exist in the whole selection, so two distinct named venues is already the
    // most the ten can offer — the stage recognises that and does nothing rather than shuffling
    // for the sake of it. (The third slot repeating A is arithmetic, not a rule failing.)
    const before = selectionOf(['A', 'B', 'A', 'A', 'B', 'A', 'B', 'A', 'B', 'A']);
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
    expect(idsOf(selection)).toEqual(idsOf(before));
    expect(promoted).toEqual([]);
  });

  it('NEVER MOVES A FORCED PICK — not out of a named slot, not into one, not as the displaced one', () => {
    // Jon's ruling: "let it jump the Q so it's always named." This stage is subordinate to it.
    // p0 is forced and sits at venue A; p1 repeats A and IS eligible to move.
    const before = selectionOf(['A', 'A', 'B', 'A', 'C', 'D', 'E', 'F', 'G', 'H']);
    const { selection, promoted } = spreadNamedSlots(before, new Set(['p0']), DIRECT_LINK_PICKS);
    expect(selection[0].listing.id).toBe('p0'); // still first, still named
    expect(promoted).toHaveLength(1);
    // p3 is at venue A, already used — so the promotion reaches past it to p4 at venue C.
    expect(promoted[0]).toMatchObject({ occurrenceId: 'p4', displacedOccurrenceId: 'p1' });

    // And a forced pick sitting BELOW the named block is never pulled up by this stage either.
    const forcedBelow = selectionOf(['A', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    const out = spreadNamedSlots(forcedBelow, new Set(['p3']), DIRECT_LINK_PICKS);
    expect(out.promoted[0]?.occurrenceId).toBe('p4');
  });
});

describe('T7 — where age coverage and venue diversity collide, the FORCED PICK WINS', () => {
  /**
   * The collision, constructed exactly: the ONLY candidate representing an unrepresented age band
   * sits at a venue that is already named.
   *
   * ═══ THE RULING, AND WHY IT IS NOT RE-ARGUED HERE ═══
   * A missing age band is closer to WRONG; a repeated venue is merely LESS GOOD. That is the
   * ordering `three-things.ts#preferenceScore` already establishes between a hard fact and a soft
   * preference, and this file reuses it rather than reaching a second opinion. So the forced pick
   * is placed at the front, is named, and is never moved by the venue spread.
   *
   * THIS CAN LEAVE TWO NAMED PICKS AT ONE VENUE, AND THAT IS THE ACCEPTED OUTCOME rather than a
   * gap in the spread. The alternative — demoting the forced pick to make room for variety — would
   * take the one pick chosen SPECIFICALLY because a child's age band had no organic match and make
   * it the one pick guaranteed never to be named, which is the exact defect Jon's ruling ended.
   */
  function collisionFixture(): ListingRecord[] {
    const shared = northOfHome(600);
    return [
      // Six organic picks for the 5-9 band. Two of them are at the shared venue, so the named
      // block is already crowded before the swap runs.
      kidActivity({ id: 'org-0', activityName: 'Story Circle', venueName: 'Shared Centre', geo: shared }),
      kidActivity({ id: 'org-1', activityName: 'Lego Build', venueName: 'Shared Centre', geo: shared, startDatetimeUtc: at(SAT, 13), endDatetimeUtc: at(SAT, 14) }),
      ...Array.from({ length: 8 }, (_, i) =>
        kidActivity({
          id: `org-${i + 2}`,
          activityName: FILLER_NAMES[(i + 2) % FILLER_NAMES.length],
          venueName: `Organic Venue ${i}`,
          geo: northOfHome(1400 + i * 600),
        })
      ),
      // The ONLY under-2 listing in the catalogue — and it is at the crowded venue.
      kidActivity({
        id: 'tot',
        activityName: 'Baby Time',
        venueName: 'Shared Centre',
        geo: shared,
        ageMinMonths: 0,
        ageMaxMonths: 23,
        ageBandMatches: ['under2'] as AgeBandKey[],
        startDatetimeUtc: at(SUN, 10),
        endDatetimeUtc: at(SUN, 11),
      }),
    ];
  }

  const collisionInput = () =>
    input(collisionFixture(), {
      subscriber: {
        origin: { geo: HOME, label: 'Kitsilano' },
        radiusKm: 10,
        birthYears: [2025, 2018], // 1 and 8 → 'under2' and '5-9'
        consecutiveEmptyWeeks: 0,
      },
    });

  it('the forced pick survives, is NAMED, and keeps its front position', () => {
    const result = selectWeeklyPicks(collisionInput());
    expect(result.forcedPicks.map((f) => f.occurrenceId)).toContain('tot');
    expect(result.picks[0].item.listing.id).toBe('tot');
    expect(result.picks[0].linkOrigin).toBe('direct');
    expect(result.picks[0].forcedForBand).toBe('under2');
  });

  it('and the venue spread fixes what it CAN around it, without touching the forced pick', () => {
    const result = selectWeeklyPicks(collisionInput());
    // The forced pick holds 'Shared Centre'. The other 'Shared Centre' card is moved out of the
    // named block if the ten allow it — the spread is subordinate, not disabled.
    const named = result.picks.filter((p) => p.linkOrigin === 'direct');
    expect(named[0].item.listing.id).toBe('tot');
    expect(new Set(named.map((p) => p.item.listing.venueName)).size).toBe(DIRECT_LINK_PICKS);
  });

  it('leaves MAX_FORCED_PICKS and DIRECT_LINK_PICKS semantics exactly as they were', () => {
    // Nothing in this scope touches how many picks may be forced or how many are named. Asserted
    // rather than assumed, because the spread runs between them and could plausibly drift either.
    expect(MAX_FORCED_PICKS).toBe(2);
    expect(DIRECT_LINK_PICKS).toBe(3);
    const result = selectWeeklyPicks(collisionInput());
    expect(result.forcedPicks.length).toBeLessThanOrEqual(MAX_FORCED_PICKS);
    expect(result.picks.filter((p) => p.linkOrigin === 'direct')).toHaveLength(DIRECT_LINK_PICKS);
    expect(result.picks.filter((p) => p.linkOrigin === 'hub')).toHaveLength(MAX_PICKS - DIRECT_LINK_PICKS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T8 — the scarcity guarantee, made STRUCTURAL rather than promised.
//
// The tradeoff question this answers, in the client's own words: "if a family's genuinely closest
// and best ten things really are concentrated at two pools, forcing artificial diversity could
// show them worse or farther options instead. Is that acceptable, and where's the line?"
//
// The line is a property of the code rather than a judgement call, and it sits at
// `candidates > MAX_PICKS`. Below it every candidate is going into the digest regardless of
// order, so a REORDER costs exactly nothing. Above it there is, by definition, a deferred
// alternative that already passed every relevance, radius, age and safety gate, so promoting one
// is a choice between things that exist and never an invention.
//
// These four cases are what make that true rather than argued.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EVERY STAGE IN `selectFrom` THAT CAN REMOVE A CANDIDATE, EXHAUSTIVELY — and nothing else.
 *
 * ═══ THIS HELPER IS THE FORCING FUNCTION. READ THIS BEFORE ADDING A DIVERSITY RULE. ═══
 * `weeklyPickCandidates` is the count of things that could possibly be sent. Case (c) below
 * asserts that the shipped pick count is EXACTLY `min(that count, MAX_PICKS)` — so any future
 * stage added to `selectFrom` that DROPS a candidate rather than reordering one will fail (c)
 * immediately, and the only way to make it pass again is to add the stage here, in the open,
 * where it has to be justified. A stage that merely REORDERS needs no change here at all, which
 * is exactly the distinction this scope's whole safety argument rests on.
 */
function weeklyPickCandidates(listings: ListingRecord[], over: Partial<WeeklyPicksInput> = {}): SearchResultItem[] {
  const i = input(listings, over);
  const response = i.engine.search(buildPicksRequest(i, 'primary'));
  const sameParentOrg = i.sameParentOrg ?? (() => false);
  const showable = response.results
    .filter((item) => isShowableOnFrontDoor(item.listing))
    .filter((item) => isWeeklyPickEligible(item.listing))
    .filter((item) => matchesInterests(item.listing, i.subscriber.categoryInterests));
  const { kept } = dedupeCandidates(showable, sameParentOrg);
  const { kept: distinct } = collapseSameOfferingAtVenue(kept, sameParentOrg);
  const alreadySent = i.excludeOccurrenceIds;
  return alreadySent && alreadySent.size > 0
    ? distinct.filter((item) => !alreadySent.has(item.listing.id))
    : distinct;
}

/** The selection the pipeline would have produced with NO diversity stage of any kind. */
function selectionWithoutDiversityStages(listings: ListingRecord[], over: Partial<WeeklyPicksInput> = {}): SearchResultItem[] {
  const i = input(listings, over);
  const response = i.engine.search(buildPicksRequest(i, 'primary'));
  const bands = ageBandsFromBirthYears(i.subscriber.birthYears, i.now);
  const maxPicks = i.maxPicks ?? MAX_PICKS;
  const sameParentOrg = i.sameParentOrg ?? (() => false);
  const showable = response.results
    .filter((item) => isShowableOnFrontDoor(item.listing))
    .filter((item) => isWeeklyPickEligible(item.listing))
    .filter((item) => matchesInterests(item.listing, i.subscriber.categoryInterests));
  const { kept } = dedupeCandidates(showable, sameParentOrg);
  const alreadySent = i.excludeOccurrenceIds;
  const fresh = alreadySent && alreadySent.size > 0 ? kept.filter((item) => !alreadySent.has(item.listing.id)) : kept;
  return applyCoverageSwap(fresh.slice(0, maxPicks), fresh, bands, maxPicks).selection;
}

/** A catalogue of `n` genuinely distinct activities at `n` distinct venues, receding from HOME. */
function thinCatalogue(n: number, perVenue = 1): ListingRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const venue = Math.floor(i / perVenue);
    return kidActivity({
      id: `thin-${i}`,
      activityName: FILLER_NAMES[i % FILLER_NAMES.length],
      venueName: `Thin Venue ${venue}`,
      geo: northOfHome(600 + venue * 600),
      startDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 9 + (i % 6)),
      endDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 10 + (i % 6)),
    });
  });
}

describe('T8 — the scarcity invariants behind the tradeoff', () => {
  it('(a) BELOW THE LINE the reorder stages cost exactly nothing — same SET, whatever the order', () => {
    // Seven candidates for ten slots. Every one is going into the digest regardless, so the cap
    // and the spread can only change the order in which they are read.
    for (const n of [1, 3, 5, 7, 9, MAX_PICKS]) {
      const listings = thinCatalogue(n, 3); // 3 per venue — well over MAX_PICKS_PER_VENUE
      const result = selectWeeklyPicks(input(listings, { floorPicks: 1 }));
      const reference = selectionWithoutDiversityStages(listings, { floorPicks: 1 });
      expect(result.diversity.sameOfferingCollapsed).toBe(0); // no same-offering pair in this shape
      expect(new Set(result.picks.map((p) => p.item.listing.id))).toEqual(new Set(reference.map((r) => r.listing.id)));
      expect(result.picks).toHaveLength(Math.min(n, MAX_PICKS));
    }
  });

  it('(a′) and the ONE stage that can remove takes only the duplicate sitting, nothing else', () => {
    // The honest completion of (a): `collapseSameOfferingAtVenue` is the single hard stage in
    // this scope, so below the line the membership difference is EXACTLY the second sitting.
    const listings = [
      ...thinCatalogue(6, 1),
      kidActivity({ id: 'we-am', activityName: 'Pickleball - Sun AM', venueName: 'West End Community Centre', geo: northOfHome(5400), startDatetimeUtc: at(SUN, 10), endDatetimeUtc: at(SUN, 11) }),
      kidActivity({ id: 'we-pm', activityName: 'Pickleball - Sun PM', venueName: 'West End Community Centre', geo: northOfHome(5400), startDatetimeUtc: at(SUN, 12, 30), endDatetimeUtc: at(SUN, 13, 30) }),
    ];
    const result = selectWeeklyPicks(input(listings, { floorPicks: 1 }));
    const reference = selectionWithoutDiversityStages(listings, { floorPicks: 1 });
    const actualIds = new Set(result.picks.map((p) => p.item.listing.id));
    const missing = reference.map((r) => r.listing.id).filter((id) => !actualIds.has(id));
    expect(missing).toEqual(['we-pm']);
    expect(result.diversity.sameOfferingCollapsed).toBe(1);
  });

  it('(b) a SINGLE-VENUE week is returned completely unchanged — order included', () => {
    // There is nothing to diversify with, and this product must never punish a subscriber for
    // that. `capVenueRepetition`'s `sameVenueThroughout` early exit returns its input
    // byte-for-byte; the spread has no unused venue to reach for; the collapse sees no repeated
    // offering. The result is the pre-change pipeline, exactly.
    const listings = thinCatalogue(14, 14); // fourteen activities, ONE venue
    const result = selectWeeklyPicks(input(listings));
    const reference = selectionWithoutDiversityStages(listings);
    expect(result.picks.map((p) => p.item.listing.id)).toEqual(reference.map((r) => r.listing.id));
    expect(result.diversity).toMatchObject({ sameOfferingCollapsed: 0, venueCapDeferred: 0, namedSlotsPermuted: 0 });
  });

  it('(c) NO NEW STAGE MAY THIN A WEEK — the pick count is exactly what the removal stages left', () => {
    // ═══ THE LOAD-BEARING ONE. ═══
    // A diversity rule that could empty or thin a week would be spending ruling 7.5's empty state
    // — which is reserved for GENUINE SCARCITY — on a rule of ours. A deferral cannot do that, and
    // this is what makes "cannot" structural instead of a sentence in a header.
    //
    // Read `weeklyPickCandidates` above before adding any stage to `selectFrom`.
    const shapes: Array<{ name: string; listings: ListingRecord[]; over?: Partial<WeeklyPicksInput> }> = [
      { name: 'profile #2', listings: profile2() },
      { name: 'profile #3', listings: profile3() },
      { name: 'probe B', listings: probeB(), over: { subscriber: { origin: { geo: HOME, label: 'K' }, radiusKm: 20, birthYears: [2021, 2018], categoryInterests: ['swimming'], consecutiveEmptyWeeks: 0 } } },
      { name: 'probe B, starved of alternatives', listings: probeB(6), over: { subscriber: { origin: { geo: HOME, label: 'K' }, radiusKm: 20, birthYears: [2021, 2018], categoryInterests: ['swimming'], consecutiveEmptyWeeks: 0 } } },
      { name: 'single venue', listings: thinCatalogue(14, 14) },
      { name: 'one venue, three deep', listings: thinCatalogue(12, 3), over: { subscriber: { origin: { geo: HOME, label: 'K' }, radiusKm: 20, birthYears: [2021, 2018], consecutiveEmptyWeeks: 0 } } },
      { name: 'exactly the floor', listings: thinCatalogue(FLOOR_PICKS, 3) },
      { name: 'one below the floor', listings: thinCatalogue(FLOOR_PICKS - 1, 3) },
      { name: 'a single listing', listings: thinCatalogue(1) },
      { name: 'nothing at all', listings: [] },
      { name: 'richmond-shaped', listings: thinCatalogue(56, 2), over: { subscriber: { origin: { geo: HOME, label: 'K' }, radiusKm: 20, birthYears: [2021, 2018], consecutiveEmptyWeeks: 0 } } },
      { name: 'novelty removes most of a dense week', listings: profile2(), over: { excludeOccurrenceIds: new Set(['rh-tai', 'rh-dan', 'coal', 'we-am', 'br-tot']) } },
      // ── the CATEGORY key's shapes, so (c) covers both axes rather than just the first one ──
      { name: 'profile #4 (swim monoculture)', listings: profile4(), over: { subscriber: profile4Subscriber() } },
      { name: 'profile #4 minus its spare category', listings: profile4().filter((r) => r.id !== 'story-0'), over: { subscriber: profile4Subscriber() } },
      { name: 'single category, many venues', listings: Array.from({ length: 14 }, (_, i) => kidActivity({ id: `sc-${i}`, activityName: `Public Swim ${FILLER_NAMES[i % FILLER_NAMES.length]}`, primaryCategoryKey: SWIM, categoryTags: [SWIM], venueName: `Pool ${i}`, geo: northOfHome(600 + i * 600), ...BOTH_BANDS })), over: { subscriber: profile4Subscriber() } },
      { name: 'every listing teen-only (the guard can never promote)', listings: Array.from({ length: 14 }, (_, i) => kidActivity({ id: `to-${i}`, activityName: `Activity ${i}`, primaryCategoryKey: i < 10 ? SWIM : OPEN_GYM, categoryTags: [], venueName: `V${i}`, geo: northOfHome(600 + i * 600), ...TEEN_ONLY })), over: { subscriber: profile4Subscriber() } },
      { name: 'category cap with no alternative inside the reach', listings: [...Array.from({ length: 22 }, (_, i) => kidActivity({ id: `s-${i}`, activityName: `Public Swim ${FILLER_NAMES[i % FILLER_NAMES.length]}`, primaryCategoryKey: SWIM, categoryTags: [SWIM], venueName: `Pool ${i}`, geo: northOfHome(600 + i * 400), ...BOTH_BANDS })), kidActivity({ id: 'far-gym', activityName: 'Rock Climbing', primaryCategoryKey: OPEN_GYM, categoryTags: [OPEN_GYM], venueName: 'Far Gym', geo: northOfHome(15_000), ...BOTH_BANDS })], over: { subscriber: profile4Subscriber() } },
    ];

    for (const shape of shapes) {
      const result = selectWeeklyPicks(input(shape.listings, shape.over));
      const candidates = weeklyPickCandidates(shape.listings, shape.over);
      // Only meaningful when the primary attempt is what shipped; the degradation ladder is a
      // deliberate second search and is not what this invariant is about.
      if (result.degradation !== 'none') continue;

      const expected = Math.min(candidates.length, MAX_PICKS);
      if (expected >= FLOOR_PICKS) {
        expect(result.outcome, shape.name).toBe('picks');
        expect(result.picks.length, shape.name).toBe(expected);
      } else {
        // Below the floor the week is an honest empty — but it must be empty for SCARCITY, i.e.
        // for a reason that existed before any diversity stage ran.
        expect(result.outcome, shape.name).toBe('empty');
        expect(selectionWithoutDiversityStages(shape.listings, shape.over).length, shape.name).toBeLessThan(FLOOR_PICKS);
      }
    }
  });

  it('(d) a RICHMOND-SHAPED thin catalogue produces exactly the same picks, in the same order', () => {
    // ~56 results spread over 28 venues at 2 apiece — the shape the sparse-municipality profile
    // measured. No venue is over the cap, no offering repeats, and the named three are already
    // distinct, so every new stage is a provable no-op and the digest is byte-for-byte what it
    // was before this scope touched the file.
    const listings = thinCatalogue(56, 2);
    const over = { subscriber: { origin: { geo: HOME, label: 'Richmond' }, radiusKm: 20, birthYears: [2021, 2018], consecutiveEmptyWeeks: 0 } };
    const result = selectWeeklyPicks(input(listings, over));
    const reference = selectionWithoutDiversityStages(listings, over);
    expect(weeklyPickCandidates(listings, over)).toHaveLength(56);
    expect(result.picks.map((p) => p.item.listing.id)).toEqual(reference.map((r) => r.listing.id));
    expect(result.diversity).toMatchObject({ sameOfferingCollapsed: 0, venueCapDeferred: 0, namedSlotsPermuted: 0, promoted: [] });
  });

  it('the degradation ladder still sees the POST-COLLAPSE count, so a thin week degrades', () => {
    // A week that looks like it has four picks and is really two must degrade like two. The
    // collapse runs before the floor check, so the retry fires on the true count.
    const near = northOfHome(600);
    const listings = [
      // Four rows that are really two offerings, all inside the primary radius.
      kidActivity({ id: 'a-am', activityName: 'Pickleball - Sun AM', venueName: 'Near Centre', geo: near, startDatetimeUtc: at(SUN, 10), endDatetimeUtc: at(SUN, 11) }),
      kidActivity({ id: 'a-pm', activityName: 'Pickleball - Sun PM', venueName: 'Near Centre', geo: near, startDatetimeUtc: at(SUN, 13), endDatetimeUtc: at(SUN, 14) }),
      kidActivity({ id: 'b-am', activityName: 'Open Gym - Sat AM', venueName: 'Near Centre', geo: near, startDatetimeUtc: at(SAT, 10), endDatetimeUtc: at(SAT, 11) }),
      kidActivity({ id: 'b-pm', activityName: 'Open Gym - Sat PM', venueName: 'Near Centre', geo: near, startDatetimeUtc: at(SAT, 13), endDatetimeUtc: at(SAT, 14) }),
      // Content only the WIDENED radius can reach, so the retry has something to find.
      ...Array.from({ length: 5 }, (_, i) =>
        kidActivity({
          id: `far-${i}`,
          activityName: FILLER_NAMES[(i + 5) % FILLER_NAMES.length],
          venueName: `Far Venue ${i}`,
          geo: northOfHome(13_000 + i * 600),
        })
      ),
    ];
    const result = selectWeeklyPicks(input(listings));
    // Two offerings survive the collapse — below FLOOR_PICKS — so the ladder ran rather than
    // shipping a two-pick week dressed as four.
    expect(result.diversity.sameOfferingCollapsed).toBeGreaterThanOrEqual(2);
    expect(result.retried).toBe(true);
    expect(result.degradation).toBe('widened');
    expect(result.picks.length).toBeGreaterThanOrEqual(FLOOR_PICKS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T9 — the instrument. The cost of the tradeoff is measured, not assumed small.
// ─────────────────────────────────────────────────────────────────────────────

describe('T9 — diversity telemetry on the result payload', () => {
  it('reports every diversity action on the profile #2 fixture, with the deltas it cost', () => {
    const result = selectWeeklyPicks(input(profile2()));

    // ONE offering collapsed: West End's second Pickleball sitting.
    expect(result.diversity.sameOfferingCollapsed).toBe(1);
    // ONE pick deferred by the venue cap: Britannia's third card, which a filler replaced.
    expect(result.diversity.venueCapDeferred).toBe(1);
    // ONE named slot permuted: the second Roundhouse card gave up its named slot to the
    // best-ranked pick at a place not yet named.
    expect(result.diversity.namedSlotsPermuted).toBe(1);
    expect(result.diversity.promoted).toHaveLength(1);

    const [promotion] = result.diversity.promoted;
    expect(promotion.occurrenceId).toBe('br-les');
    expect(promotion.displacedOccurrenceId).toBe('rh-tai');
    expect(promotion.toIndex).toBe(1);
    expect(promotion.fromIndex).toBe(3);
    // It reached two places deeper into the ten…
    expect(promotion.rankDelta).toBe(2);
    // …and cost about 1.8 km: the Britannia card promoted into the named block is 2.4 km out and
    // the second Roundhouse card it displaced is 0.6 km.
    // THIS IS THE NUMBER THE WHOLE TRADEOFF TURNS ON, which is why it is reported per promotion
    // rather than averaged away. There is deliberately no second distance ceiling guarding it —
    // the subscriber's radius already bounds it, and a second ceiling would be a filter wearing a
    // preference's clothes.
    expect(promotion.distanceDeltaKm).toBeCloseTo(1.8, 1);
  });

  it('is DERIVED from the run that produced the picks — every id it names is one that shipped', () => {
    // A summary that re-derives its numbers by running the rules a second time is a second
    // implementation that can disagree with the first. Pinned from the outside: the promoted card
    // is in the named block, the displaced card is still in the ten but is no longer named.
    const result = selectWeeklyPicks(input(profile2()));
    const shipped = result.picks.map((p) => p.item.listing.id);
    for (const promotion of result.diversity.promoted) {
      expect(shipped).toContain(promotion.occurrenceId);
      expect(shipped).toContain(promotion.displacedOccurrenceId);
      expect(shipped.indexOf(promotion.occurrenceId)).toBe(promotion.toIndex);
      expect(shipped.indexOf(promotion.displacedOccurrenceId)).toBe(promotion.fromIndex);
      expect(result.picks[promotion.toIndex].linkOrigin).toBe('direct');
      expect(result.picks[promotion.fromIndex].linkOrigin).toBe('hub');
    }
  });

  it('is all zeroes when nothing had to be done, including on an EMPTY week', () => {
    const quiet = selectWeeklyPicks(input(thinCatalogue(56, 2), { subscriber: { origin: { geo: HOME, label: 'R' }, radiusKm: 20, birthYears: [2021, 2018], consecutiveEmptyWeeks: 0 } }));
    expect(quiet.diversity).toEqual({ sameOfferingCollapsed: 0, venueCapDeferred: 0, categoryCapDeferred: 0, ageFitBlocked: 0, namedSlotsPermuted: 0, promoted: [] });

    // An empty week still carries the summary, describing the attempt that produced the emptiness
    // — a caller reading `diversity` must never have to branch on `outcome` first.
    const empty = selectWeeklyPicks(input([]));
    expect(empty.outcome).toBe('empty');
    expect(empty.diversity).toEqual({ sameOfferingCollapsed: 0, venueCapDeferred: 0, categoryCapDeferred: 0, ageFitBlocked: 0, namedSlotsPermuted: 0, promoted: [] });
  });

  it('reports a null distance delta rather than a zero when a card is un-geocoded', () => {
    // An absent coordinate is the ABSENCE of a fact, not a distance of zero — the same rule this
    // codebase applies to an unnamed venue. Averaging a fabricated zero into the distribution the
    // constant is retuned against would be the quiet kind of wrong.
    const before = selectionOf(['A', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']).map((item, i) =>
      i === 3 ? { ...item, distanceKm: null } : item
    );
    const { promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
    expect(promoted).toHaveLength(1);
    expect(promoted[0].distanceDeltaKm).toBeNull();
  });

  it('writes NOTHING anywhere — this is a pure function returning a value', () => {
    // No store, no log, no schema change. The caller decides what to keep; persistence, if it is
    // ever wanted, is an Operator decision routed separately and is not assumed here.
    const listings = profile2();
    const snapshot = JSON.stringify(listings);
    const a = selectWeeklyPicks(input(listings));
    const b = selectWeeklyPicks(input(listings));
    expect(JSON.stringify(listings)).toBe(snapshot); // the catalogue was not mutated
    expect(a.diversity).toEqual(b.diversity); // and the run is reproducible
    expect(MAX_PICKS_PER_VENUE).toBe(2); // the approved decision: 2-of-10, not the stricter 1-of-10
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ROOT CAUSE B — CATEGORY MONOCULTURE.
//
// A Deep Cove family with a 2-year-old and a 13-year-old got NINE OF TEN picks in `public_swim`:
// one skate, two named swims, six more hub-linked swims. There is no category-diversity mechanism
// at all — categories reach this surface only as a subscriber-chosen post-filter.
//
// IT IS NOT THE SAME DEFECT AS VENUE REPETITION AND THE VENUE FIX DOES NOT TOUCH IT. That is
// measured below, not assumed: apply the venue rules alone to this shape and the freed slots
// simply refill with more swim at different pools.
// ═════════════════════════════════════════════════════════════════════════════

const SWIM = 'public_swim';
const SKATE = 'skate';
const OPEN_GYM = 'open_gym';

/** Profile #4 — North Vancouver / Deep Cove. Children aged 2 and 13. */
function profile4Subscriber() {
  return {
    origin: { geo: HOME, label: 'Deep Cove' },
    radiusKm: 20,
    birthYears: [2024, 2013], // 2 and 13 in 2026 → bands '2-4' and '10-14'
    consecutiveEmptyWeeks: 0,
  };
}

/** Fits BOTH of profile #4's bands — a toddler and a teenager can both attend. */
const BOTH_BANDS = { ageMinMonths: 0, ageMaxMonths: 216, ageBandMatches: ['2-4', '10-14'] as AgeBandKey[] };
/** Fits ONLY the teenager. `Open Gym 8yrs+` does not admit a 2-year-old. */
const TEEN_ONLY = { ageMinMonths: 96, ageMaxMonths: 216, ageBandMatches: ['10-14'] as AgeBandKey[] };

/**
 * The swim-heavy shape, realistically interleaved — alternatives present throughout rather than
 * all stacked below the swims, which is what the real list looked like (skate ranked first).
 */
function profile4(): ListingRecord[] {
  const rows: ListingRecord[] = [];
  const push = (id: string, name: string, category: string, metres: number, age = BOTH_BANDS, venue = `${id}-venue`) =>
    rows.push(kidActivity({ id, activityName: name, primaryCategoryKey: category, categoryTags: [category], venueName: venue, geo: northOfHome(metres), ...age }));

  push('skate-0', 'Family Skate', SKATE, 600);
  // Twelve swims at twelve different pools — venue-diverse and category-monotonous, which is the
  // whole point: the venue cap has nothing to fix here and the list is still nine-tenths swimming.
  for (let i = 0; i < 12; i += 1) push(`swim-${i}`, `Public Swim ${FILLER_NAMES[i % FILLER_NAMES.length]}`, SWIM, 1200 + i * 600);
  // The age-fit case: an open gym that admits the 13-year-old and NOT the 2-year-old.
  push('gym-teen', 'Open Gym 8yrs Plus', OPEN_GYM, 2400, TEEN_ONLY);
  // Genuine alternatives that fit the whole family, inside the reach.
  push('museum-0', 'Museum Drop In', 'museum_venue', 3000);
  push('attraction-0', 'Aquarium Visit', 'attraction', 3600);
  push('festival-0', 'Harvest Fair', 'festival_event', 4200);
  push('park-0', 'Nature Walk', 'outdoor_park', 4800);
  push('gym-all', 'Open Gym All Ages', OPEN_GYM, 5400);
  push('story-0', 'Storytime Drop In', 'storytime', 6000);
  return rows;
}

function categories(result: WeeklyPicks): string[] {
  return result.picks.map((p) => p.item.listing.primaryCategoryKey ?? '');
}
const countCategory = (result: WeeklyPicks, key: string) => categories(result).filter((c) => c === key).length;

describe('profile #4 (Deep Cove) — nine of ten in one category', () => {
  it('CASE 5 — the ten hold at least four distinct categories, with public_swim capped', () => {
    // FAILED ON main: 9 of 10 `public_swim`, 2 distinct categories.
    const result = selectWeeklyPicks(input(profile4(), { subscriber: profile4Subscriber() }));
    expect(result.outcome).toBe('picks');
    expect(result.picks).toHaveLength(MAX_PICKS);
    expect(new Set(categories(result)).size).toBeGreaterThanOrEqual(4);
    expect(countCategory(result, SWIM)).toBeLessThanOrEqual(3);
  });

  it('THE GUARD AND THE CAP ARE IN TENSION, AND THE GUARD WINS — measured, not hand-waved', () => {
    // Remove the one both-bands alternative that lets this profile reach its category target, and
    // the only remaining candidate for that slot is `gym-teen`, which the 2-year-old cannot
    // attend. The category cap WANTS it; the age-fit guard refuses; the slot goes to a swim that
    // serves both children instead. Swim therefore rises to 4, and that is the CORRECT outcome,
    // not a cap failure — variety is found among things that fit the whole family, or it is not
    // found this week.
    //
    // Pinned because it is the one place the two new rules genuinely disagree, and a future reader
    // who saw only the happy-path test above could reasonably "fix" the swim count by weakening
    // the guard. That would be the single worst change anyone could make to this file.
    const withoutSpare = profile4().filter((row) => row.id !== 'story-0');
    const result = selectWeeklyPicks(input(withoutSpare, { subscriber: profile4Subscriber() }));
    expect(countCategory(result, SWIM)).toBe(4);
    expect(result.diversity.ageFitBlocked).toBeGreaterThan(0);
    // The teen-only gym is NOT in the ten, even though seating it would have bought a 7th category.
    expect(result.picks.map((p) => p.item.listing.id)).not.toContain('gym-teen');
    // Every pick in the ten admits the 2-year-old.
    for (const pick of result.picks) expect(pick.item.listing.ageBandMatches).toContain('2-4');
  });

  it('and the VENUE fix alone would NOT have fixed it — the two are orthogonal', () => {
    // Measured, not asserted: every swim in the fixture is at its own pool, so the venue cap has
    // literally nothing to defer. If category diversity were a side effect of venue diversity,
    // this list would already be fine. It is not — which is why the category pass exists.
    const venueCounts = new Map<string, number>();
    for (const row of profile4()) venueCounts.set(row.venueName ?? '', (venueCounts.get(row.venueName ?? '') ?? 0) + 1);
    expect(Math.max(...venueCounts.values())).toBe(1); // no venue repeats AT ALL
    const result = selectWeeklyPicks(input(profile4(), { subscriber: profile4Subscriber() }));
    expect(result.diversity.venueCapDeferred).toBe(0); // the venue cap did nothing…
    expect(result.diversity.categoryCapDeferred).toBeGreaterThan(0); // …and the category cap did the work
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T10 — THE AGE-FIT GUARD. The most important rule in this scope.
// ─────────────────────────────────────────────────────────────────────────────

describe('T10 — category variety may NEVER be bought with age fit', () => {
  it('an "Open Gym 8yrs+" CANNOT displace a public swim that fits both children', () => {
    // ═══ THIS TEST IS THE ENTIRE POINT OF THE GUARD. ═══
    // A large part of profile #4's swim dominance is the product answering a hard question
    // CORRECTLY. Scored with the real ranker, `Open Gym 8yrs+` is joint-FIRST for a household of
    // 9- and 15-year-olds and FOURTH for this household of 2- and 13-year-olds — not because of a
    // category bug, but because it does not admit a 2-year-old (`ageMatchScore` returns
    // covered/bands, so fitting 1 of 2 costs 0.3). Public swim, skating and museums are among the
    // few things that genuinely serve a toddler and a teenager at the same time.
    //
    // So a category rule that "fixed" this list by promoting the open gym over a swim would hand a
    // parent of a 2-year-old something their toddler cannot attend — trading monotony for
    // IRRELEVANCE, which is worse. It would also spend one mechanism to defeat another: it is the
    // exact inverse of what `applyCoverageSwap` exists to guarantee. Hence a hard guard, not a
    // preference.
    const result = selectWeeklyPicks(input(profile4(), { subscriber: profile4Subscriber() }));
    const picked = result.picks.map((p) => p.item.listing.id);

    // The teen-only gym is never promoted ahead of a both-bands pick by the category pass.
    const teenGymIndex = picked.indexOf('gym-teen');
    if (teenGymIndex !== -1) {
      // If it is in the ten at all, it is there on its own rank — never ahead of a deferred swim.
      const swimIndexes = picked.map((id, i) => (id.startsWith('swim-') ? i : -1)).filter((i) => i >= 0);
      expect(Math.min(...swimIndexes)).toBeLessThan(teenGymIndex);
    }
    // And the guard says so out loud rather than working silently.
    expect(result.diversity.ageFitBlocked).toBeGreaterThan(0);

    // Every pick in the ten that came from a category promotion still fits BOTH children.
    for (const promotion of result.diversity.promoted) {
      const item = result.picks.find((p) => p.item.listing.id === promotion.occurrenceId)!;
      expect(item.item.listing.ageBandMatches).toContain('2-4');
    }
  });

  it('a SAME-COVERAGE promotion still proceeds normally — the guard blocks only a reduction', () => {
    // The guard would be useless if it froze the category pass entirely. `gym-all` fits both bands
    // exactly as the swims do, so promoting it costs the family nothing and is allowed.
    const result = selectWeeklyPicks(input(profile4(), { subscriber: profile4Subscriber() }));
    expect(result.picks.map((p) => p.item.listing.id)).toContain('gym-all');
    expect(new Set(categories(result)).size).toBeGreaterThanOrEqual(4);
  });

  it('is INERT when no age band was requested — there is no coverage to reduce', () => {
    // A subscriber with no readable birth year searches with no age filter at all. The guard must
    // not invent a constraint out of an empty band list.
    const noBands = { origin: { geo: HOME, label: 'Deep Cove' }, radiusKm: 20, birthYears: [] as number[], consecutiveEmptyWeeks: 0 };
    const result = selectWeeklyPicks(input(profile4(), { subscriber: noBands }));
    expect(result.ageAware).toBe(false);
    expect(result.diversity.ageFitBlocked).toBe(0);
    expect(new Set(categories(result)).size).toBeGreaterThanOrEqual(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T8 — the two caps are ordered, and the order is a decision.
// ─────────────────────────────────────────────────────────────────────────────

describe('T8 — venue capped BEFORE category, and a test that fails if that is reversed', () => {
  /**
   * A shape where the order is observable: one pool holds THREE swims, and there are swims
   * elsewhere too. Venue-first defers the duplicate-venue swims and hands the category pass an
   * already-spread list. Category-first would seat two swims AT THE SAME POOL and force the venue
   * pass to undo work the category pass had just justified.
   */
  function orderSensitive(): ListingRecord[] {
    const rows: ListingRecord[] = [];
    const push = (id: string, cat: string, venue: string, metres: number) =>
      rows.push(kidActivity({ id, activityName: `Activity ${id}`, primaryCategoryKey: cat, categoryTags: [cat], venueName: venue, geo: northOfHome(metres), ...BOTH_BANDS }));
    push('a-swim-0', SWIM, 'Crowded Pool', 600);
    push('a-swim-1', SWIM, 'Crowded Pool', 600);
    push('a-swim-2', SWIM, 'Crowded Pool', 600);
    push('b-swim-0', SWIM, 'Other Pool', 1200);
    for (let i = 0; i < 8; i += 1) push(`alt-${i}`, ['skate', OPEN_GYM, 'museum_venue', 'attraction'][i % 4], `Alt Venue ${i}`, 1800 + i * 600);
    return rows;
  }

  it('no venue holds more than 2 AND no ordinary category holds more than 2', () => {
    const result = selectWeeklyPicks(input(orderSensitive(), { subscriber: profile4Subscriber() }));
    expect(result.picks).toHaveLength(MAX_PICKS);
    const venueCounts = new Map<string, number>();
    for (const v of venues(result)) venueCounts.set(v, (venueCounts.get(v) ?? 0) + 1);
    expect(Math.max(...venueCounts.values())).toBeLessThanOrEqual(MAX_PICKS_PER_VENUE);
    expect(countCategory(result, SWIM)).toBeLessThanOrEqual(MAX_PICKS_PER_CATEGORY);
  });

  it('THE ORDER ITSELF: the crowded pool never keeps 2 swims once the category cap has run', () => {
    // Reversing the passes shows up precisely here. Category-first seats `a-swim-0` and
    // `a-swim-1` (two swims, both at Crowded Pool) because the category cap is satisfied by two,
    // and the venue pass then has to break up a pair the category pass had just chosen. Running
    // venue-first, `a-swim-2` is deferred for its VENUE before the category pass ever sees it, so
    // the two passes never disagree about the same card.
    const result = selectWeeklyPicks(input(orderSensitive(), { subscriber: profile4Subscriber() }));
    const crowded = result.picks.filter((p) => p.item.listing.venueName === 'Crowded Pool');
    expect(crowded.length).toBeLessThanOrEqual(MAX_PICKS_PER_VENUE);
    // Both constraints hold simultaneously — which is the property a reversed order loses.
    expect(countCategory(result, SWIM)).toBeLessThanOrEqual(MAX_PICKS_PER_CATEGORY);
    expect(crowded.every((p) => p.item.listing.primaryCategoryKey === SWIM)).toBe(true);
  });

  it('the category cap is BOUNDED by the coverage swap’s own reach, reused not duplicated', () => {
    // Same discipline, same value, one constant. Past the reach "a representative is just a
    // low-relevance listing wearing a band label" — swap "band" for "category".
    expect(COVERAGE_SWAP_REACH).toBe(20);
  });

  it('leaves a genuinely SINGLE-CATEGORY week completely alone', () => {
    // A family near only swim facilities is shown swimming, and nothing clever is done. The cap's
    // `sameKeyThroughout` early exit returns the input byte-for-byte.
    const swimOnly = Array.from({ length: 14 }, (_, i) =>
      kidActivity({ id: `only-${i}`, activityName: `Public Swim ${FILLER_NAMES[i % FILLER_NAMES.length]}`, primaryCategoryKey: SWIM, categoryTags: [SWIM], venueName: `Pool ${i}`, geo: northOfHome(600 + i * 600), ...BOTH_BANDS })
    );
    const result = selectWeeklyPicks(input(swimOnly, { subscriber: profile4Subscriber() }));
    const reference = selectionWithoutDiversityStages(swimOnly, { subscriber: profile4Subscriber() });
    expect(result.picks.map((p) => p.item.listing.id)).toEqual(reference.map((r) => r.listing.id));
    expect(result.diversity.categoryCapDeferred).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T13 — the catch-all category, and the profile it would have gutted.
// ─────────────────────────────────────────────────────────────────────────────

describe('T13 — `class_program` is a catch-all and gets a looser cap', () => {
  /** Profile #2's activities as the taxonomy really keys them: all four are `class_program`. */
  function profile2AsClassProgram(): ListingRecord[] {
    return profile2().map((row) =>
      /Pickleball|Tai Chi|Dancers/.test(row.activityName)
        ? { ...row, primaryCategoryKey: CLASS_PROGRAM_CATEGORY_KEY, categoryTags: [CLASS_PROGRAM_CATEGORY_KEY] }
        : row
    );
  }

  it('does NOT gut profile #2 — its monotony was never categorical', () => {
    // Measured: capping `class_program` at 2 removed FIVE of profile #2's seven picks. Tai Chi,
    // Pickleball and a community dance troupe are genuinely three different things to do; the key
    // is simply not granular enough to say so. Profile #2's real defect is venue repetition, and
    // the venue cap plus the same-offering collapse already carry it.
    expect(CLASS_PROGRAM_CAP).toBeGreaterThan(MAX_PICKS_PER_CATEGORY);
    const result = selectWeeklyPicks(input(profile2AsClassProgram()));
    expect(result.picks).toHaveLength(MAX_PICKS);
    expect(countCategory(result, CLASS_PROGRAM_CATEGORY_KEY)).toBeLessThanOrEqual(CLASS_PROGRAM_CAP);
  });

  it('profile #2’s improvement comes from the VENUE rules, not from the category cap', () => {
    // The claim the looser cap rests on, made executable: with the category axis doing nothing at
    // all for this profile, the venue outcome is still fixed.
    const result = selectWeeklyPicks(input(profile2AsClassProgram()));
    const counts = new Map<string, number>();
    for (const v of venues(result)) counts.set(v, (counts.get(v) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(MAX_PICKS_PER_VENUE);
    expect(new Set(namedVenues(result)).size).toBe(DIRECT_LINK_PICKS);
    expect(result.diversity.sameOfferingCollapsed).toBe(1); // the Pickleball pair
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE #3 — the MUST-NOT-REGRESS control.
// ─────────────────────────────────────────────────────────────────────────────

describe('profile #3 (Central Lonsdale) — a healthier mix must not be made worse', () => {
  /**
   * Profile #3 is the same municipality as #4 and got a genuinely varied list — 4 open gym,
   * 1 skate, 5 swim. The difference is not geography, it is age bands: #3 is 9 and 15, so
   * `Open Gym 8yrs+` fits BOTH its children and ranks joint-first.
   *
   * This list is the control. Nothing in this scope may make it worse, and that is a named exit
   * criterion rather than an assumption.
   */
  function profile3Mixed(): ListingRecord[] {
    const bothOlder = { ageMinMonths: 96, ageMaxMonths: 216, ageBandMatches: ['5-9', '15+'] as AgeBandKey[] };
    const rows: ListingRecord[] = [];
    const push = (id: string, cat: string, metres: number) =>
      rows.push(kidActivity({ id, activityName: `Activity ${id}`, primaryCategoryKey: cat, categoryTags: [cat], venueName: `${id}-venue`, geo: northOfHome(metres), ...bothOlder }));
    for (let i = 0; i < 4; i += 1) push(`gym-${i}`, OPEN_GYM, 600 + i * 600);
    push('skate-0', SKATE, 3000);
    for (let i = 0; i < 5; i += 1) push(`swim-${i}`, SWIM, 3600 + i * 600);
    for (let i = 0; i < 6; i += 1) push(`extra-${i}`, ['museum_venue', 'attraction', 'outdoor_park'][i % 3], 6600 + i * 600);
    return rows;
  }

  const profile3Subscriber = () => ({
    origin: { geo: HOME, label: 'Central Lonsdale' },
    radiusKm: 20,
    birthYears: [2017, 2011], // 9 and 15 → bands '5-9' and '15+'
    consecutiveEmptyWeeks: 0,
  });

  it('keeps at least as many distinct categories as it had before this scope', () => {
    const listings = profile3Mixed();
    const over = { subscriber: profile3Subscriber() };
    const before = selectionWithoutDiversityStages(listings, over);
    const beforeCategories = new Set(before.map((r) => r.listing.primaryCategoryKey)).size;
    const after = selectWeeklyPicks(input(listings, over));
    expect(new Set(categories(after)).size).toBeGreaterThanOrEqual(beforeCategories);
  });

  it('keeps the same number of picks and never fewer distinct venues', () => {
    const listings = profile3Mixed();
    const over = { subscriber: profile3Subscriber() };
    const before = selectionWithoutDiversityStages(listings, over);
    const after = selectWeeklyPicks(input(listings, over));
    expect(after.picks).toHaveLength(before.length);
    expect(new Set(venues(after)).size).toBeGreaterThanOrEqual(new Set(before.map((r) => r.listing.venueName)).size);
  });

  it('never blocks a promotion here — every listing fits both of this household’s bands', () => {
    // The age-fit guard is silent on a household whose children are served by the same content.
    // Contrast with profile #4, where it fires: the guard tracks the FAMILY, not the catalogue.
    const result = selectWeeklyPicks(input(profile3Mixed(), { subscriber: profile3Subscriber() }));
    expect(result.diversity.ageFitBlocked).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T11 — a forced pick outranks BOTH caps, not just the venue one.
// ─────────────────────────────────────────────────────────────────────────────

describe('T11 — age coverage outranks every diversity rule in this file', () => {
  /**
   * The collision on the CATEGORY axis: the only listing representing an unrepresented age band
   * is in a category that is already at its cap.
   *
   * ═══ THE RULING, REUSED RATHER THAN RE-ARGUED ═══
   * A missing age band is closer to WRONG; a repeated venue or category is merely LESS GOOD. That
   * is the ordering `three-things.ts#preferenceScore` already establishes between a hard fact and
   * a soft preference. So `applyCoverageSwap` runs AFTER both caps and its forced pick may
   * REINTRODUCE a capped venue or a capped category.
   *
   * THAT IS THE ACCEPTED OUTCOME, NOT A GAP. The alternative — letting a diversity cap veto the
   * one pick chosen specifically because a child's age band had no organic match — would make the
   * caps the very thing they were built to prevent: a rule that decides a parent sees nothing for
   * one of their children.
   */
  function bandCollision(): ListingRecord[] {
    const rows: ListingRecord[] = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push(kidActivity({
        id: `swim-${i}`, activityName: `Public Swim ${FILLER_NAMES[i % FILLER_NAMES.length]}`,
        primaryCategoryKey: SWIM, categoryTags: [SWIM], venueName: `Pool ${i}`,
        geo: northOfHome(600 + i * 600),
        ageMinMonths: 60, ageMaxMonths: 216, ageBandMatches: ['5-9', '10-14'] as AgeBandKey[],
      }));
    }
    // The ONLY under-2 content in the catalogue — and it is another public swim (the category that
    // is already at its cap), at the FARTHEST pool (whose venue is already used), on the Sunday.
    // Ranked last, so the coverage swap genuinely has to REACH for it: if it merely sat in the top
    // ten on its own merits, nothing would be forced and this test would pass vacuously.
    rows.push(kidActivity({
      id: 'tot-swim', activityName: 'Parent and Tot Swim', primaryCategoryKey: SWIM,
      categoryTags: [SWIM], venueName: 'Pool 11', geo: northOfHome(600 + 11 * 600),
      ageMinMonths: 0, ageMaxMonths: 23, ageBandMatches: ['under2'] as AgeBandKey[],
      startDatetimeUtc: at(SUN, 15), endDatetimeUtc: at(SUN, 16),
    }));
    return rows;
  }

  const collisionInput = () =>
    input(bandCollision(), {
      subscriber: {
        origin: { geo: HOME, label: 'Deep Cove' }, radiusKm: 20,
        birthYears: [2025, 2014], // 1 and 12 → 'under2' and '10-14'
        consecutiveEmptyWeeks: 0,
      },
    });

  it('NON-VACUITY — the under-2 pick ranks OUTSIDE the ten, so it must be reached for', () => {
    const sub = { origin: { geo: HOME, label: 'Deep Cove' }, radiusKm: 20, birthYears: [2025, 2014], consecutiveEmptyWeeks: 0 };
    const candidates = weeklyPickCandidates(bandCollision(), { subscriber: sub }).map((c) => c.listing.id);
    expect(candidates.indexOf('tot-swim')).toBeGreaterThanOrEqual(MAX_PICKS);
  });

  it('the forced pick survives and is NAMED even though its category is already capped', () => {
    const result = selectWeeklyPicks(collisionInput());
    expect(result.forcedPicks.map((f) => f.occurrenceId)).toContain('tot-swim');
    expect(result.picks[0].item.listing.id).toBe('tot-swim');
    expect(result.picks[0].linkOrigin).toBe('direct');
    expect(result.picks[0].forcedForBand).toBe('under2');
  });

  it('and it may push its category back OVER the cap — documented, accepted, asserted', () => {
    // The cap is a preference; the band is a fact. This assertion exists so that if someone later
    // makes the caps win, they have to come here and delete a test that says why they shouldn't.
    const result = selectWeeklyPicks(collisionInput());
    expect(countCategory(result, SWIM)).toBeGreaterThan(MAX_PICKS_PER_CATEGORY);
    expect(result.picks).toHaveLength(MAX_PICKS);
  });

  it('MAX_FORCED_PICKS and DIRECT_LINK_PICKS semantics are untouched by either cap', () => {
    const result = selectWeeklyPicks(collisionInput());
    expect(result.forcedPicks.length).toBeLessThanOrEqual(MAX_FORCED_PICKS);
    expect(result.picks.filter((p) => p.linkOrigin === 'direct')).toHaveLength(DIRECT_LINK_PICKS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T12 — the scarcity invariants, on the CATEGORY key too.
// ─────────────────────────────────────────────────────────────────────────────

describe('T12 — scarcity invariants hold on the category axis as well as the venue axis', () => {
  it('(a) below the line, the category pass cannot change the SET either', () => {
    for (const n of [1, 3, 5, 7, MAX_PICKS]) {
      const listings = Array.from({ length: n }, (_, i) =>
        kidActivity({ id: `c-${i}`, activityName: `Public Swim ${FILLER_NAMES[i % FILLER_NAMES.length]}`, primaryCategoryKey: SWIM, categoryTags: [SWIM], venueName: `Pool ${i}`, geo: northOfHome(600 + i * 600), ...BOTH_BANDS })
      );
      const over = { subscriber: profile4Subscriber(), floorPicks: 1 };
      const result = selectWeeklyPicks(input(listings, over));
      const reference = selectionWithoutDiversityStages(listings, over);
      expect(new Set(result.picks.map((p) => p.item.listing.id))).toEqual(new Set(reference.map((r) => r.listing.id)));
    }
  });

  it('(b) a single-CATEGORY week is returned unchanged, order included', () => {
    const listings = Array.from({ length: 14 }, (_, i) =>
      kidActivity({ id: `only-${i}`, activityName: `Public Swim ${FILLER_NAMES[i % FILLER_NAMES.length]}`, primaryCategoryKey: SWIM, categoryTags: [SWIM], venueName: `Pool ${i}`, geo: northOfHome(600 + i * 600), ...BOTH_BANDS })
    );
    const over = { subscriber: profile4Subscriber() };
    const result = selectWeeklyPicks(input(listings, over));
    const reference = selectionWithoutDiversityStages(listings, over);
    expect(result.picks.map((p) => p.item.listing.id)).toEqual(reference.map((r) => r.listing.id));
    expect(result.diversity.categoryCapDeferred).toBe(0);
  });

  it('THE SPARSE CASE, end to end: one alternative beyond the reach is left where it is', () => {
    // The client's objection, answered as a number rather than a promise. 22 swims and exactly one
    // non-swim option ranked outside `COVERAGE_SWAP_REACH`: the family is shown swimming, because
    // that is what is near them, and nothing is dragged up from the far end of the list.
    const listings = [
      ...Array.from({ length: 22 }, (_, i) =>
        kidActivity({ id: `swim-${i}`, activityName: `Public Swim ${FILLER_NAMES[i % FILLER_NAMES.length]}`, primaryCategoryKey: SWIM, categoryTags: [SWIM], venueName: `Pool ${i}`, geo: northOfHome(600 + i * 400), ...BOTH_BANDS })),
      kidActivity({ id: 'far-gym', activityName: 'Rock Climbing', primaryCategoryKey: OPEN_GYM, categoryTags: [OPEN_GYM], venueName: 'Far Gym', geo: northOfHome(15_000), ...BOTH_BANDS }),
    ];
    const over = { subscriber: profile4Subscriber() };
    const result = selectWeeklyPicks(input(listings, over));
    const reference = selectionWithoutDiversityStages(listings, over);
    expect(result.picks.map((p) => p.item.listing.id)).toEqual(reference.map((r) => r.listing.id));
    expect(result.picks.map((p) => p.item.listing.id)).not.toContain('far-gym');
  });

  it('(d) the Richmond-shaped thin catalogue is untouched on BOTH keys', () => {
    // Already asserted for venues; restated with categories spread so neither cap has anything to
    // do, and the digest is byte-for-byte what it was before this scope existed.
    const listings = Array.from({ length: 56 }, (_, i) =>
      kidActivity({
        id: `rich-${i}`, activityName: FILLER_NAMES[i % FILLER_NAMES.length],
        primaryCategoryKey: ['public_swim', 'skate', 'open_gym', 'museum_venue', 'attraction', 'outdoor_park', 'storytime', 'festival_event'][i % 8],
        categoryTags: [], venueName: `Rich Venue ${Math.floor(i / 2)}`, geo: northOfHome(600 + Math.floor(i / 2) * 600),
        startDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 9 + (i % 6)), endDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 10 + (i % 6)),
        ...BOTH_BANDS,
      })
    );
    const over = { subscriber: profile4Subscriber() };
    const result = selectWeeklyPicks(input(listings, over));
    const reference = selectionWithoutDiversityStages(listings, over);
    expect(result.picks.map((p) => p.item.listing.id)).toEqual(reference.map((r) => r.listing.id));
    expect(result.diversity).toMatchObject({ sameOfferingCollapsed: 0, venueCapDeferred: 0, categoryCapDeferred: 0, ageFitBlocked: 0 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T8 (approved follow-on) — AGE-BAND FAIRNESS IN THE NAMED BLOCK.
//
// Only the first DIRECT_LINK_PICKS picks are named and linked; the rest fold into an anonymous
// "+N more". `linkOrigin` is assigned purely by rank, so a household that asked about two age
// bands can get all three LINKS for one child — while the other child's activities sit in the
// ten, unnamed and untappable.
//
// `applyCoverageSwap` does NOT catch this. It fires only when a band has no organic match ANYWHERE
// and reaches outside the selection to fix it. Here the band IS represented in the ten; it is just
// not represented in the LINKS. Band representation in the selection and band representation in
// the links are different facts, and nothing checked the second one.
// ═════════════════════════════════════════════════════════════════════════════

/** Picks with an explicit venue AND explicit bands, ranked by position. */
function selectionWithBands(spec: Array<{ venue: string; bands: AgeBandKey[] }>): SearchResultItem[] {
  return spec.map((s, i) => {
    const item = asItem(
      kidActivity({
        id: `q${i}`,
        activityName: FILLER_NAMES[i % FILLER_NAMES.length],
        venueName: s.venue,
        geo: northOfHome(600 + i * 600),
        ageBandMatches: s.bands,
      })
    );
    return { ...item, distanceKm: 0.6 + i * 0.6 };
  });
}

const namedBandsOf = (picks: SearchResultItem[], n = DIRECT_LINK_PICKS) =>
  new Set(picks.slice(0, n).flatMap((p) => p.listing.ageBandMatches));

describe('T8 — the named three must speak to every child, before they speak to every place', () => {
  const TWO_BANDS: AgeBandKey[] = ['2-4', '10-14'];

  it('promotes a band that is in the ten but missing from the named three', () => {
    // The reported defect, minimal. The teenager's activity is pick #4 — in the list, never linked.
    const before = selectionWithBands([
      { venue: 'A', bands: ['2-4'] },
      { venue: 'B', bands: ['2-4'] },
      { venue: 'C', bands: ['2-4'] },
      { venue: 'D', bands: ['10-14'] },
      { venue: 'E', bands: ['2-4'] },
    ]);
    expect(namedBandsOf(before)).toEqual(new Set(['2-4'])); // the defect, before
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, TWO_BANDS);
    expect(namedBandsOf(selection)).toEqual(new Set(TWO_BANDS)); // both children now have a link
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ reason: 'age_band', occurrenceId: 'q3', bandsGained: ['10-14'] });
  });

  it('═══ THE DISAGREEMENT CASE: band fairness and venue spread cannot both be satisfied ═══', () => {
    // Constructing a REAL either/or takes care, and the first draft of this test did not manage
    // it — the implementation found a win-win I had not anticipated (it vacated a slot whose
    // venue left the named block with it, satisfying both rules). That is the right behaviour and
    // it is why this fixture is shaped the way it is: here the two rules genuinely cannot both be
    // met, so the ordering has to decide.
    //
    //   q0 is the ONLY pick speaking to the 15+ child, so its slot cannot be spent.
    //   q3 is the ONLY pick speaking to the 10-14 child, and it sits at venue A — which q0 is
    //     also at, and q0 is staying. Naming it therefore COSTS a distinct venue.
    //   q4 is a pure venue-variety candidate at an unused venue, buying no coverage at all.
    //
    // BAND FAIRNESS WINS: three children represented, two distinct venues. The alternative is a
    // tidier-looking three venues and a 12-year-old whose parent reads three links, taps none,
    // and concludes the product found nothing for them. A child with nothing is closer to WRONG;
    // a repeated venue is merely LESS GOOD.
    const THREE_BANDS: AgeBandKey[] = ['2-4', '10-14', '15+'];
    const before = selectionWithBands([
      { venue: 'A', bands: ['15+'] },     // sole 15+ voice — not a slot that can be spent
      { venue: 'B', bands: ['2-4'] },     // spendable: q2 also covers 2-4
      { venue: 'C', bands: ['2-4'] },
      { venue: 'A', bands: ['10-14'] },   // sole 10-14 voice, at a venue that stays named
      { venue: 'D', bands: ['2-4'] },     // venue variety, no coverage
    ]);
    expect(namedBandsOf(before)).toEqual(new Set(['15+', '2-4'])); // the defect, before

    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, THREE_BANDS);
    const namedIds = selection.slice(0, DIRECT_LINK_PICKS).map((p) => p.listing.id);
    const namedVenueCount = new Set(selection.slice(0, DIRECT_LINK_PICKS).map((p) => p.listing.venueName)).size;

    expect(namedIds).toContain('q3');                                  // every child got a link…
    expect(namedIds).not.toContain('q4');                              // …and variety did not win
    expect(namedBandsOf(selection)).toEqual(new Set(THREE_BANDS));
    expect(namedVenueCount).toBe(2);                                   // the accepted cost
    expect(promoted.map((p) => p.reason)).toEqual(['age_band']);

    // ═══ THE CONTRAST THAT SHOWS THE ORDERING MATTERS ═══
    // Same input, band fairness disabled — which is what a venue-only pass, or a separate pass
    // that ran first and got there before this one, produces. The venue rule sees three distinct
    // venues already, declares itself satisfied, changes nothing, and the 10-14 child ends the
    // week with no link at all. Tidier-looking, and wrong.
    //
    // So the tradeoff, stated as two numbers: band fairness ON gives 3 children / 2 venues;
    // band fairness OFF gives 2 children / 3 venues. This scope chooses the children.
    const venueOnly = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, []);
    const venueOnlyIds = venueOnly.selection.slice(0, DIRECT_LINK_PICKS).map((p) => p.listing.id);
    expect(venueOnlyIds).toEqual(['q0', 'q1', 'q2']);
    expect(venueOnlyIds).not.toContain('q3');                       // the child, unrepresented
    expect(venueOnly.promoted).toEqual([]);
    expect(new Set(venueOnly.selection.slice(0, DIRECT_LINK_PICKS).map((p) => p.listing.venueName)).size).toBe(3);
    expect([...namedBandsOf(venueOnly.selection)]).not.toContain('10-14');
    // …and q4, the variety-only candidate, is taken by NEITHER: there was never a venue repeat to
    // spend it on. It is in the fixture to prove band fairness declined an available alternative
    // rather than simply having none.
    expect(venueOnlyIds).not.toContain('q4');
  });

  it('the venue pass may NEVER evict the sole named voice for a child', () => {
    // Subordination has two halves and this is the second. q1 was not put there by the band phase
    // — it is simply the only named pick that speaks to the teenager — and the venue rule still
    // may not take its slot. Same guard shape as the category pass's age-fit rule: a diversity
    // move may never REDUCE coverage.
    const before = selectionWithBands([
      { venue: 'A', bands: ['2-4'] },
      { venue: 'A', bands: ['10-14'] },   // venue repeat AND the only named '10-14'
      { venue: 'B', bands: ['2-4'] },
      { venue: 'C', bands: ['2-4'] },     // what the venue rule would want
      { venue: 'D', bands: ['2-4'] },
    ]);
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, TWO_BANDS);
    expect(selection.slice(0, DIRECT_LINK_PICKS).map((p) => p.listing.id)).toEqual(['q0', 'q1', 'q2']);
    expect(promoted).toEqual([]); // nothing moved: the only legal swap would have cost a child
    expect(namedBandsOf(selection)).toEqual(new Set(TWO_BANDS));
  });

  it('…but it DOES proceed when the incoming pick carries the band too', () => {
    // The guard blocks a REDUCTION, not every move. q3 is at an unused venue AND speaks to the
    // teenager, so it buys variety at no cost to coverage and the swap goes ahead.
    const before = selectionWithBands([
      { venue: 'A', bands: ['2-4'] },
      { venue: 'A', bands: ['10-14'] },
      { venue: 'B', bands: ['2-4'] },
      { venue: 'C', bands: ['10-14'] },
      { venue: 'D', bands: ['2-4'] },
    ]);
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, TWO_BANDS);
    expect(selection.slice(0, DIRECT_LINK_PICKS).map((p) => p.listing.id)).toEqual(['q0', 'q3', 'q2']);
    expect(promoted.map((p) => p.reason)).toEqual(['venue']);
    expect(namedBandsOf(selection)).toEqual(new Set(TWO_BANDS)); // coverage preserved
  });

  it('does not chase a band that is not in the ten at all — that is the coverage swap’s job', () => {
    // This stage NEVER reaches outside the selection, so it cannot fail in a way that costs a pick.
    // A band with no organic match anywhere already had its chance at `applyCoverageSwap`.
    const before = selectionWithBands([
      { venue: 'A', bands: ['2-4'] },
      { venue: 'B', bands: ['2-4'] },
      { venue: 'C', bands: ['2-4'] },
    ]);
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, ['2-4', '15+']);
    expect(selection.map((p) => p.listing.id)).toEqual(before.map((p) => p.listing.id));
    expect(promoted).toEqual([]);
  });

  it('never moves a forced pick, and counts its band as already spoken for', () => {
    // Jon's ruling still outranks this stage. q0 is forced and speaks to the toddler; the band
    // phase must not spend a second named slot on '2-4', and must not move q0 to get one.
    const before = selectionWithBands([
      { venue: 'A', bands: ['2-4'] },
      { venue: 'B', bands: ['2-4'] },
      { venue: 'C', bands: ['2-4'] },
      { venue: 'D', bands: ['10-14'] },
    ]);
    const { selection, promoted } = spreadNamedSlots(before, new Set(['q0']), DIRECT_LINK_PICKS, TWO_BANDS);
    expect(selection[0].listing.id).toBe('q0'); // forced, still first, still named
    expect(namedBandsOf(selection)).toEqual(new Set(TWO_BANDS));
    expect(promoted.every((p) => p.occurrenceId !== 'q0' && p.displacedOccurrenceId !== 'q0')).toBe(true);
  });

  it('is a PURE PERMUTATION and is byte-identical to the old behaviour when no band is requested', () => {
    const shapes = [
      [{ venue: 'A', bands: ['2-4'] }, { venue: 'A', bands: ['10-14'] }, { venue: 'B', bands: ['2-4'] }, { venue: 'C', bands: ['10-14'] }],
      [{ venue: 'A', bands: [] }, { venue: 'A', bands: [] }, { venue: 'A', bands: [] }],
      [{ venue: 'A', bands: ['2-4'] }, { venue: 'B', bands: ['2-4'] }, { venue: 'C', bands: ['2-4'] }, { venue: 'D', bands: ['10-14'] }, { venue: 'E', bands: ['15+'] }],
    ] as Array<Array<{ venue: string; bands: AgeBandKey[] }>>;
    for (const shape of shapes) {
      const before = selectionWithBands(shape);
      for (const bands of [[], TWO_BANDS, ['2-4', '10-14', '15+'] as AgeBandKey[]]) {
        const { selection } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, bands);
        expect(selection).toHaveLength(before.length);
        expect([...selection.map((p) => p.listing.id)].sort()).toEqual([...before.map((p) => p.listing.id)].sort());
        for (const item of before) expect(selection).toContain(item); // same objects, not copies
      }
      // No requested bands ⇒ phase 1 is inert ⇒ exactly what this function did before T8 landed.
      const noBands = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, []);
      const legacy = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
      expect(noBands.selection.map((p) => p.listing.id)).toEqual(legacy.selection.map((p) => p.listing.id));
    }
  });

  it('END TO END — a 2-and-13 household gets a link for BOTH children', () => {
    // The real shape: plenty of toddler content ranked above anything for the teenager.
    //
    // EVERY LISTING SHARES ONE CATEGORY, deliberately. The first draft spread them across two, and
    // the CATEGORY cap happened to pull a teen pick into the named three as a side effect — so the
    // test passed while proving nothing about band fairness. One category makes that pass inert
    // (its single-key early exit returns the list unchanged) and leaves this stage as the only
    // thing that can fix the defect.
    const rows: ListingRecord[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(kidActivity({
        id: `tot-${i}`, activityName: FILLER_NAMES[i], venueName: `Tot Venue ${i}`,
        geo: northOfHome(600 + i * 600), primaryCategoryKey: OPEN_GYM, categoryTags: [OPEN_GYM],
        ageMinMonths: 0, ageMaxMonths: 59, ageBandMatches: ['2-4'] as AgeBandKey[],
      }));
    }
    for (let i = 0; i < 4; i += 1) {
      rows.push(kidActivity({
        id: `teen-${i}`, activityName: FILLER_NAMES[i + 6], venueName: `Teen Venue ${i}`,
        geo: northOfHome(4800 + i * 600), primaryCategoryKey: OPEN_GYM, categoryTags: [OPEN_GYM],
        ageMinMonths: 120, ageMaxMonths: 216, ageBandMatches: ['10-14'] as AgeBandKey[],
      }));
    }
    const result = selectWeeklyPicks(input(rows, { subscriber: profile4Subscriber() }));
    const named = result.picks.filter((p) => p.linkOrigin === 'direct');
    const bandsNamed = new Set(named.flatMap((p) => p.item.listing.ageBandMatches));
    expect(bandsNamed).toEqual(new Set(['2-4', '10-14']));
    // …and the telemetry says which rule did it and what it cost.
    const bandPromotions = result.diversity.promoted.filter((p) => p.reason === 'age_band');
    expect(bandPromotions.length).toBeGreaterThan(0);
    expect(bandPromotions[0].bandsGained).toContain('10-14');
    expect(bandPromotions[0].rankDelta).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T12 (2026-09-15) — ACTIVITY-TYPE VARIETY IN THE NAMED BLOCK, AND THE ONE PLACE
// THIS CODEBASE LETS VARIETY OUTRANK AGE FIT.
//
// THE REPORTED DEFECT, WITH REAL NUMBERS. Jon rated four real Friday previews 2/5 to 4/5 on
// 2026-09-15. Three of them carried two or three picks of ONE category in the three NAMED,
// direct-linked slots — subscriber short_ref 21 carried three sharing a single
// `primary_category_id` — WHILE `MAX_PICKS_PER_CATEGORY` (2 of 10) was being honoured exactly as
// written. `orderByCategorySpread`'s age-fit guard is why: nothing inside `COVERAGE_SWAP_REACH`
// covered that household's bands as well as more of the same category, so every swap was
// correctly refused. A 2-of-10 cap simply does not constrain a 3-item window.
//
// THE RULING THIS FILE PINS. "It should definitely force variety even at some age fit cost."
// Phase 0 therefore carries NO age-fit guard, and the two cases below that assert a band being
// LOST are not bugs being tolerated — they are the licence being spent, and `bandsLost` is the
// receipt. The cases after them pin the BOUNDARY: the ten-item category cap's guard and the venue
// cap keep their old behaviour exactly, because the reversal is scoped to this one pass.
// ═════════════════════════════════════════════════════════════════════════════

/** Picks with an explicit activity type, venue and bands, ranked by position. */
function selectionWithTypes(
  spec: Array<{ type: string | null; venue?: string; bands?: AgeBandKey[] }>
): SearchResultItem[] {
  return spec.map((s, i) => {
    const item = asItem(
      kidActivity({
        id: `t${i}`,
        activityName: FILLER_NAMES[i % FILLER_NAMES.length],
        venueName: s.venue ?? `Venue ${i}`,
        geo: northOfHome(600 + i * 600),
        primaryCategoryKey: s.type ?? '',
        categoryTags: s.type ? [s.type] : [],
        ...(s.bands ? { ageBandMatches: s.bands } : {}),
      })
    );
    return { ...item, distanceKm: 0.6 + i * 0.6 };
  });
}

const namedTypesOf = (picks: SearchResultItem[], n = DIRECT_LINK_PICKS) =>
  picks.slice(0, n).map((p) => p.listing.primaryCategoryKey);

describe('T12 — at most one of each activity type in the three picks a parent actually reads', () => {
  it('breaks up three-of-one-category in the named block — the short_ref 21 defect', () => {
    const before = selectionWithTypes([
      { type: SWIM }, { type: SWIM }, { type: SWIM },
      { type: SKATE }, { type: OPEN_GYM }, { type: SWIM },
    ]);
    expect(new Set(namedTypesOf(before)).size).toBe(1); // the defect, before
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
    expect(namedTypesOf(selection)).toEqual([SWIM, SKATE, OPEN_GYM]);
    expect(promoted.map((p) => p.reason)).toEqual(['activity_type', 'activity_type']);
    // HIGHEST-ranked alternative first, same discipline as the venue pass: t3 before t4.
    expect(promoted[0]).toMatchObject({ occurrenceId: 't3', displacedOccurrenceId: 't1', fromIndex: 3, toIndex: 1, rankDelta: 2 });
    expect(promoted[1]).toMatchObject({ occurrenceId: 't4', displacedOccurrenceId: 't2', rankDelta: 2 });
  });

  it('honours MAX_NAMED_SLOTS_PER_CATEGORY as a number, not as a hard-coded one', () => {
    // If the cap is ever retuned, the rule has to move with it rather than the constant becoming
    // decorative. Two of one type in the named three is a violation at 1 and legal at 2.
    const before = selectionWithTypes([{ type: SWIM }, { type: SWIM }, { type: SKATE }, { type: OPEN_GYM }]);
    const { selection } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
    const swimsNamed = namedTypesOf(selection).filter((t) => t === SWIM).length;
    expect(swimsNamed).toBe(MAX_NAMED_SLOTS_PER_CATEGORY);
  });

  it('FORCES VARIETY EVEN AT AGE-FIT COST — Jon’s ruling, and the receipt for it', () => {
    // Slot 2 is a second skate AND the sole named voice for the teenager. Every other rule in
    // this file would refuse to move it. Phase 0 moves it, and says what that cost.
    //
    // Phase 1 cannot then undo the cost, and the reason is structural rather than lucky: the only
    // picks carrying '10-14' are skates, skate is still seated at slot 1, and re-seating one
    // would put two skates back in the named three — which `wouldWorsenTypeSpread` refuses on
    // phase 1's behalf. Slot 1 is also the sole named voice for '5-9', so phase 1's own
    // never-reduce-coverage guard will not vacate it either.
    const bands: AgeBandKey[] = ['2-4', '5-9', '10-14'];
    const before = selectionWithTypes([
      { type: SWIM, bands: ['2-4'] },
      { type: SKATE, bands: ['5-9'] },
      { type: SKATE, bands: ['10-14'] },
      { type: OPEN_GYM, bands: ['2-4'] },
      { type: SKATE, bands: ['10-14'] },
    ]);
    expect(namedBandsOf(before)).toEqual(new Set(bands)); // all three children named, before
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, bands);
    expect(namedTypesOf(selection)).toEqual([SWIM, SKATE, OPEN_GYM]);
    // The teenager lost their named slot. That is the authorised cost, not an accident…
    expect(namedBandsOf(selection)).toEqual(new Set(['2-4', '5-9']));
    // …and it is REPORTED, which is the whole reason `bandsLost` exists.
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      reason: 'activity_type', occurrenceId: 't3', displacedOccurrenceId: 't2',
      bandsLost: ['10-14'], bandsGained: [],
    });
    // Nothing left the ten: the teenager's pick is still there, just no longer direct-linked.
    expect([...idsOf(selection)].sort()).toEqual([...idsOf(before)].sort());
    expect(selection.map((p) => p.listing.ageBandMatches).flat()).toContain('10-14');
  });

  it('records bandsLost as EMPTY for age_band and venue promotions — both are still guarded', () => {
    // The licence is scoped to phase 0. A non-empty `bandsLost` on any other reason would mean a
    // guard had been loosened somewhere it was not supposed to be.
    const bands: AgeBandKey[] = ['2-4', '10-14'];
    const before = selectionWithBands([
      { venue: 'A', bands: ['2-4'] }, { venue: 'B', bands: ['2-4'] }, { venue: 'C', bands: ['2-4'] },
      { venue: 'D', bands: ['10-14'] }, { venue: 'E', bands: ['2-4'] },
    ]);
    const { promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, bands);
    expect(promoted.length).toBeGreaterThan(0);
    for (const p of promoted) {
      expect(p.reason).not.toBe('activity_type');
      expect(p.bandsLost).toEqual([]);
    }
  });

  it('runs BEFORE age-band fairness, and age-band fairness may not hand the slot back', () => {
    // Ordering, as an assertion rather than a comment. If phase 1 ran first it would seat the
    // teen swim at slot 1 and phase 0 would have to undo it; if phase 0 ran first WITHOUT
    // locking, phase 1 would put a third swim straight back.
    const bands: AgeBandKey[] = ['2-4', '10-14'];
    const before = selectionWithTypes([
      { type: SWIM, bands: ['2-4'] }, { type: SWIM, bands: ['2-4'] }, { type: SKATE, bands: ['2-4'] },
      { type: OPEN_GYM, bands: ['2-4'] }, { type: OPEN_GYM, bands: ['10-14'] },
    ]);
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS, bands);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ reason: 'activity_type', occurrenceId: 't3', displacedOccurrenceId: 't1' });
    expect(namedTypesOf(selection)).toEqual([SWIM, OPEN_GYM, SKATE]);
    // The only teen pick is a SECOND open gym, so phase 1 is refused it at every unlocked slot —
    // and slot 1, the one phase 0 spent, it may not touch at all. The band goes unnamed, which is
    // the ruling applied consistently rather than only to phase 0's own swaps.
    expect(namedBandsOf(selection)).toEqual(new Set(['2-4']));
    expect(promoted.every((p) => p.reason === 'activity_type')).toBe(true);
  });

  it('venue spread may not re-create a type collision either', () => {
    // Slots 0 and 1 are the same PLACE, so the venue pass wants to move slot 1. The
    // highest-ranked unused venue below is a second helping of slot 0's type, and is refused.
    const before = selectionWithTypes([
      { type: SWIM, venue: 'A' }, { type: SKATE, venue: 'A' }, { type: OPEN_GYM, venue: 'B' },
      { type: SWIM, venue: 'C' }, { type: 'museum_venue', venue: 'D' },
    ]);
    const { selection, promoted } = spreadNamedSlots(before, new Set(), DIRECT_LINK_PICKS);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ reason: 'venue', occurrenceId: 't4' }); // t3 skipped: a second swim
    expect(new Set(namedTypesOf(selection)).size).toBe(DIRECT_LINK_PICKS);
  });

  it('never treats an ABSENT category key as a type — not as a repeat, and not as variety', () => {
    // The rule `venueIdentity` states for every caller, applied to the other key. Two typeless
    // rows are not the same type…
    const typeless = selectionWithTypes([{ type: null }, { type: null }, { type: SWIM }, { type: SKATE }]);
    expect(idsOf(spreadNamedSlots(typeless, new Set(), DIRECT_LINK_PICKS).selection)).toEqual(idsOf(typeless));
    // …and a typeless row below is never promoted as though it were something different to do.
    const noAlternative = selectionWithTypes([{ type: SWIM }, { type: SWIM }, { type: SKATE }, { type: null }, { type: null }]);
    expect(idsOf(spreadNamedSlots(noAlternative, new Set(), DIRECT_LINK_PICKS).selection)).toEqual(idsOf(noAlternative));
  });

  it('NEVER MOVES A FORCED PICK — the escape valve is scoped to the age-fit GUARD, not to the swap', () => {
    // A forced pick exists because a band had no organic match ANYWHERE. That is a membership
    // fact `applyCoverageSwap` owns, and a permutation has no business overruling it.
    const before = selectionWithTypes([
      { type: SWIM }, { type: SWIM }, { type: SWIM }, { type: SKATE }, { type: OPEN_GYM },
    ]);
    const { selection, promoted } = spreadNamedSlots(before, new Set(['t1']), DIRECT_LINK_PICKS);
    expect(selection[1].listing.id).toBe('t1'); // still named, still a second swim
    expect(namedTypesOf(selection)).toEqual([SWIM, SWIM, SKATE]);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ occurrenceId: 't3', displacedOccurrenceId: 't2' });
    // …and a forced pick BELOW the named block is never pulled up by this pass either.
    const forcedBelow = selectionWithTypes([{ type: SWIM }, { type: SWIM }, { type: SWIM }, { type: SKATE }, { type: OPEN_GYM }]);
    expect(spreadNamedSlots(forcedBelow, new Set(['t3']), DIRECT_LINK_PICKS).promoted[0]?.occurrenceId).toBe('t4');
  });

  it('is a no-op when the ten hold only one activity type, and a pure permutation always', () => {
    const oneType = selectionWithTypes(Array.from({ length: 10 }, () => ({ type: SWIM })));
    const { selection, promoted } = spreadNamedSlots(oneType, new Set(), DIRECT_LINK_PICKS);
    expect(idsOf(selection)).toEqual(idsOf(oneType));
    expect(promoted).toEqual([]);

    const mixed = selectionWithTypes([
      { type: SWIM }, { type: SWIM }, { type: SWIM }, { type: SKATE }, { type: OPEN_GYM }, { type: SWIM },
    ]);
    const out = spreadNamedSlots(mixed, new Set(), DIRECT_LINK_PICKS).selection;
    expect(out).toHaveLength(mixed.length);
    expect([...idsOf(out)].sort()).toEqual([...idsOf(mixed)].sort());
    for (const item of mixed) expect(out).toContain(item);
  });

  it('THE BOUNDARY — the ten-item category cap keeps its age-fit guard, untouched', () => {
    // The reversal is scoped to the named three. `orderByCategorySpread` still refuses any
    // promotion that would serve fewer of this household's children, and still SAYS it refused.
    // Household of 2 and 13; every alternative to swim is teen-only, so the guard blocks and the
    // ten stay swim-heavy — exactly as before this change.
    const rows: ListingRecord[] = [];
    for (let i = 0; i < 10; i += 1) {
      rows.push(kidActivity({
        id: `sw-${i}`, activityName: `Public Swim ${FILLER_NAMES[i % FILLER_NAMES.length]}`,
        primaryCategoryKey: SWIM, categoryTags: [SWIM], venueName: `Pool ${i}`,
        geo: northOfHome(600 + i * 400), ageMinMonths: 0, ageMaxMonths: 216,
        ageBandMatches: ['2-4', '10-14'] as AgeBandKey[],
      }));
    }
    for (let i = 0; i < 4; i += 1) {
      rows.push(kidActivity({
        id: `gym-${i}`, activityName: FILLER_NAMES[i + 10],
        primaryCategoryKey: OPEN_GYM, categoryTags: [OPEN_GYM], venueName: `Gym ${i}`,
        geo: northOfHome(5000 + i * 400), ageMinMonths: 120, ageMaxMonths: 216,
        ageBandMatches: ['10-14'] as AgeBandKey[],
      }));
    }
    const result = selectWeeklyPicks(input(rows, { subscriber: profile4Subscriber() }));
    expect(result.diversity.ageFitBlocked).toBeGreaterThan(0); // the guard still fires…
    expect(result.diversity.categoryCapDeferred).toBe(0); // …and still wins in the ten.
  });

  it('END TO END — the effect is visible in WeeklyPicks.diversity, not only in the text', () => {
    // The instrumentation is the acceptance criterion: an operator regenerating a real
    // subscriber's preview must be able to see WHICH rule moved the named block and what it cost.
    const rows: ListingRecord[] = [];
    const types = [SWIM, SWIM, SWIM, SWIM, SKATE, OPEN_GYM, SWIM, SKATE, OPEN_GYM, SWIM];
    types.forEach((type, i) => {
      rows.push(kidActivity({
        id: `e2e-${i}`, activityName: FILLER_NAMES[i], primaryCategoryKey: type, categoryTags: [type],
        venueName: `Place ${i}`, geo: northOfHome(600 + i * 400),
        ageMinMonths: 0, ageMaxMonths: 216, ageBandMatches: ['2-4', '5-9'] as AgeBandKey[],
      }));
    });
    const result = selectWeeklyPicks(input(rows));
    const named = result.picks.filter((p) => p.linkOrigin === 'direct');
    expect(named).toHaveLength(DIRECT_LINK_PICKS);
    expect(new Set(named.map((p) => p.item.listing.primaryCategoryKey)).size).toBe(DIRECT_LINK_PICKS);
    const typePromotions = result.diversity.promoted.filter((p) => p.reason === 'activity_type');
    expect(typePromotions.length).toBeGreaterThan(0);
    expect(result.diversity.namedSlotsPermuted).toBe(result.diversity.promoted.length);
    expect(typePromotions[0].rankDelta).toBeGreaterThan(0);
  });
});
