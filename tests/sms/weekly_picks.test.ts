// tests/sms/weekly_picks.test.ts — the weekly SMS pick selection (PRD §2.2).
//
// Pure module over a FIXTURE-BACKED engine, the same pattern the three-things and digest suites
// use: build a small catalogue whose every relevant property is visible in this file, run the
// REAL SearchEngine over it, and assert on what the selector decided. No DB, no network, no
// ambient clock.
//
// A NOTE ON THE FIXTURE NAMES, because the first draft of this file got it wrong. The activity
// names below are deliberately unrelated words, not "Activity 1 / Activity 2". Numbered titles
// are trigram-SIMILAR: measured with the real similarity(), "Toddler Session 0" ~ "Toddler
// Session 1" scores 0.800, above the 0.78 cutoff. The first draft used numbered names AND put
// them at one venue at one time, so the dedup pass correctly collapsed the whole fixture and two
// tests failed for a reason that had nothing to do with what they were testing. The max pairwise
// similarity across the ACTIVITY_NAMES list below is 0.333.
//
// AND NO NAME BELOW MAY READ AS A REGISTRATION-SHAPED COURSE. The second draft used "Cooking
// Class" and "Skate Lesson", and both vanished from the engine's results before the selector ever
// saw them: `SearchRequest.includeRegistration` defaults to FALSE, so `isRegistrationShaped`
// (lib/search/filters/registration.ts) drops any title matching \bclass(es)?\b, \blessons?\b,
// \bcamps?\b and friends. That default is INHERITED here deliberately — see the note on
// `buildPicksRequest` — but it silently ate two fixture rows and made a cap test look like a cap
// bug. `isRegistrationShaped` returns false for every name in the list below.
import { describe, expect, it } from 'vitest';
import { SearchEngine, type SearchResultItem } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import type { ListingRecord, AgeBandKey, GeoPoint } from '@/lib/search/types';
import { similarity } from '@/lib/search/text/trigram';
import {
  COVERAGE_SWAP_REACH,
  DIRECT_LINK_PICKS,
  MAX_FORCED_PICKS,
  ageBandsFromBirthYears,
  applyCoverageSwap,
  buildPicksRequest,
  dedupeCandidates,
  selectWeeklyPicks,
  widenRadiusKm,
  type WeeklyPicksInput,
} from '@/lib/sms/weekly-picks';

// ── The clock and the geography ──────────────────────────────────────────────
// Friday 2026-08-28, 16:00 PDT — the PRD's send moment. The weekend that resolves from it is
// Sat 2026-08-29 + Sun 2026-08-30; the retry window extends through Tue 2026-09-01.
const FRIDAY_4PM = new Date('2026-08-28T23:00:00Z');
const SAT = '2026-08-29';
const SUN = '2026-08-30';
const MON = '2026-08-31';
const TUE = '2026-09-01';

const HOME: GeoPoint = { lat: 49.28, lng: -123.07 }; // East Van

/** ~160m from HOME — inside the 500m dedup radius. */
const NEXT_DOOR: GeoPoint = { lat: 49.2814, lng: -123.07 };
/** ~4km from HOME — outside the 500m dedup radius, inside a 10km search radius. */
const ACROSS_TOWN: GeoPoint = { lat: 49.316, lng: -123.07 };
/** ~13km from HOME — outside a 10km radius, inside a widened 20km one. */
const FAR: GeoPoint = { lat: 49.397, lng: -123.07 };

/** Unrelated activity names — max pairwise trigram similarity 0.333. See this file's header. */
const ACTIVITY_NAMES = [
  'Splash Time', 'Story Circle', 'Lego Build', 'Puppet Show', 'Nature Walk', 'Music Makers',
  'Gym Romp', 'Art Studio', 'Chess Club', 'Dance Party', 'Science Lab', 'Yoga Kids',
  'Forest Explorers', 'Bike Rodeo', 'Marble Run', 'Drama Games', 'Coding Club', 'Garden Club',
  'Rock Climbing', 'Board Games', 'Karate Basics', 'Pottery Wheel', 'Film Night', 'Bird Watching',
];

function at(isoDate: string, localHour: number): string {
  // America/Vancouver is UTC-7 in August.
  return `${isoDate}T${String(localHour + 7).padStart(2, '0')}:00:00Z`;
}

/**
 * A listing that passes every gate by default: confirmed, a real stated age floor (the
 * front-door gate rejects `ageMinMonths === null`), geocoded, and dated inside the weekend.
 */
function kidActivity(partial: Partial<ListingRecord> & { id: string }): ListingRecord {
  return makeListing({
    statusState: 'confirmed',
    ageMinMonths: 24,
    ageMaxMonths: 120,
    ageBandMatches: ['2-4', '5-9'] as AgeBandKey[],
    geo: HOME,
    startDatetimeUtc: at(SAT, 10),
    endDatetimeUtc: at(SAT, 11),
    venueName: 'Trout Lake Community Centre',
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
      origin: { geo: HOME, label: 'East Van' },
      radiusKm: 10,
      birthYears: [2021, 2018], // 5 and 8 in 2026 → both land in '5-9'
      consecutiveEmptyWeeks: 0,
      ...over.subscriber,
    },
  };
}

/** N genuinely distinct activities: different names, venues, places and times. */
function distinctActivities(
  n: number,
  over: Partial<ListingRecord> = {},
  offset = 0
): ListingRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const name = ACTIVITY_NAMES[(offset + i) % ACTIVITY_NAMES.length];
    return kidActivity({
      id: `act-${offset + i}`,
      activityName: name,
      venueName: `${name} Centre`,
      geo: { lat: HOME.lat + i * 0.002, lng: HOME.lng }, // ~220m apart, cumulative
      startDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 9 + (i % 6)),
      endDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 10 + (i % 6)),
      ...over,
    });
  });
}

/** A minimal SearchResultItem, for unit-testing the pure selection helpers directly. */
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

// ─────────────────────────────────────────────────────────────────────────────

describe('ageBandsFromBirthYears', () => {
  it('computes bands from birth YEARS at call time, in canonical order', () => {
    // 2026 − 2025 = 1 → 'under2'; 2026 − 2024 = 2 → '2-4'; 2026 − 2017 = 9 → '5-9'.
    expect(ageBandsFromBirthYears([2024, 2017, 2025], FRIDAY_4PM)).toEqual([
      'under2',
      '2-4',
      '5-9',
    ]);
  });

  it('collapses two children in one band to one band, and skips unreadable years', () => {
    expect(ageBandsFromBirthYears([2020, 2019], FRIDAY_4PM)).toEqual(['5-9']);
    // A future year, an implausible age and a non-integer are skipped, never defaulted.
    expect(ageBandsFromBirthYears([2030, 1900, 2020.5], FRIDAY_4PM)).toEqual([]);
    expect(ageBandsFromBirthYears([], FRIDAY_4PM)).toEqual([]);
    expect(ageBandsFromBirthYears(null, FRIDAY_4PM)).toEqual([]);
  });

  it('pins the ACCEPTED year-only drift rather than hiding it', () => {
    // A child born December 2021 is 4 until December 2026, but a year-only record reads 5 all
    // year. Asserted so nobody "fixes" it by accident: this is a PRD tradeoff (§1.2), not a bug.
    expect(ageBandsFromBirthYears([2021], FRIDAY_4PM)).toEqual(['5-9']);
  });
});

describe('buildPicksRequest', () => {
  it('always passes minResults: 0, on both attempts', () => {
    // The engine's broadening ladder relaxes DATES first, so a non-zero minimum would let it
    // print next Tuesday under a promise that says "this weekend".
    const i = input([]);
    expect(buildPicksRequest(i, 'primary').minResults).toBe(0);
    expect(buildPicksRequest(i, 'retry').minResults).toBe(0);
  });

  it('asks for the weekend on the primary attempt and Sat→Tue on the retry', () => {
    const i = input([]);
    const primary = buildPicksRequest(i, 'primary');
    expect(primary.when).toBe('weekend');
    expect(primary.dateRange).toBeUndefined();
    expect(primary.radiusKm).toBe(10);

    const retry = buildPicksRequest(i, 'retry');
    expect(retry.when).toBeUndefined(); // a range and a quick-pick are mutually exclusive
    expect(retry.dateRange).toEqual({ from: SAT, to: TUE });
    expect(retry.radiusKm).toBe(20); // one step up the product's own radius ladder
  });

  it('is NON-COMPOUNDING: the retry is built from the input, never from the primary request', () => {
    const i = input([]);
    // Building the retry ten times can never widen ten times, because there is no state to
    // widen from. This is the structural half of the PRD's "non-compounding" retry.
    for (let n = 0; n < 10; n += 1) {
      expect(buildPicksRequest(i, 'retry').radiusKm).toBe(20);
    }
    expect(widenRadiusKm(5)).toBe(10);
    expect(widenRadiusKm(10)).toBe(20);
    expect(widenRadiusKm(20)).toBe(30); // past the ladder, one fixed fallback step
  });

  it('sends the resolved coordinate as near_me, because saved_home requires sign-in', () => {
    expect(buildPicksRequest(input([]), 'primary').origin).toEqual({
      mode: 'near_me',
      coords: HOME,
    });
  });

  it('omits the age filter entirely when no birth year resolves', () => {
    const req = buildPicksRequest(
      input([], { subscriber: { origin: { geo: HOME, label: 'x' }, birthYears: [], consecutiveEmptyWeeks: 0 } }),
      'primary'
    );
    expect(req.ageBands).toBeUndefined();
  });
});

describe('the dedup pass (PRD §2.2 step 3)', () => {
  it('merges the PRD calibration pairs — both score below the OLD 0.85 cutoff', () => {
    // Asserted against the real similarity() so the test fails if either the threshold or the
    // metric moves under it.
    expect(similarity('Parent & Tot Swim', 'Parent and Tot Swim')).toBeCloseTo(0.8, 2);
    expect(similarity('Preschool Storytime', 'Preschool Story Time')).toBeCloseTo(0.783, 2);

    const listings = [
      kidActivity({ id: 'a1', activityName: 'Parent & Tot Swim', venueName: 'Templeton Pool' }),
      kidActivity({ id: 'a2', activityName: 'Parent and Tot Swim', venueName: 'Templeton Pool' }),
      kidActivity({
        id: 'b1',
        activityName: 'Preschool Storytime',
        venueName: 'Britannia Library',
        startDatetimeUtc: at(SUN, 14),
        endDatetimeUtc: at(SUN, 15),
      }),
      kidActivity({
        id: 'b2',
        activityName: 'Preschool Story Time',
        venueName: 'Britannia Library',
        startDatetimeUtc: at(SUN, 14),
        endDatetimeUtc: at(SUN, 15),
      }),
    ];
    const result = selectWeeklyPicks(input(listings, { floorPicks: 1 }));
    const names = result.picks.map((p) => p.item.listing.activityName);
    expect(result.deduped).toBe(2);
    expect(names).toHaveLength(2);
    expect(names.some((n) => /Swim/.test(n))).toBe(true);
    expect(names.some((n) => /Story/.test(n))).toBe(true);
  });

  it('does NOT merge the same title at two unrelated venues — the case title-alone gets wrong', () => {
    // The PRD's own warning, made executable: identical titles score 1.000, so if the venue
    // condition ever stopped being ANDed in, this is the test that catches it.
    expect(similarity('Public Swim', 'Public Swim')).toBe(1);

    const listings = [
      kidActivity({ id: 'p1', activityName: 'Public Swim', venueName: 'Templeton Pool', geo: HOME }),
      kidActivity({
        id: 'p2',
        activityName: 'Public Swim',
        venueName: 'Killarney Pool',
        geo: ACROSS_TOWN, // ~4km — far outside the 500m venue radius
      }),
    ];
    const result = selectWeeklyPicks(input(listings, { floorPicks: 1 }));
    expect(result.deduped).toBe(0);
    expect(result.picks).toHaveLength(2);
  });

  it('merges an identical title at two venue names 160m apart (the ~500m arm)', () => {
    const listings = [
      kidActivity({ id: 'p1', activityName: 'Public Swim', venueName: 'Pool Annex A', geo: HOME }),
      kidActivity({ id: 'p2', activityName: 'Public Swim', venueName: 'Pool Annex B', geo: NEXT_DOOR }),
    ];
    const result = selectWeeklyPicks(input(listings, { floorPicks: 1 }));
    expect(result.deduped).toBe(1);
    expect(result.picks).toHaveLength(1);
  });

  it('does NOT merge a same-title, same-venue pair whose times do not overlap', () => {
    // Saturday morning and Sunday afternoon at one rink are two outings, not one.
    const items = [
      asItem(kidActivity({
        id: 't1',
        activityName: 'Family Skate',
        startDatetimeUtc: at(SAT, 9),
        endDatetimeUtc: at(SAT, 10),
      })),
      asItem(kidActivity({
        id: 't2',
        activityName: 'Family Skate',
        startDatetimeUtc: at(SUN, 15),
        endDatetimeUtc: at(SUN, 16),
      })),
    ];
    const { kept, collapsed } = dedupeCandidates(items, () => false);
    expect(collapsed).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it('merges back-to-back sittings at one venue (edge-inclusive overlap)', () => {
    const items = [
      asItem(kidActivity({
        id: 'q1',
        activityName: 'Public Swim',
        startDatetimeUtc: at(SAT, 10),
        endDatetimeUtc: at(SAT, 11),
      })),
      asItem(kidActivity({
        id: 'q2',
        activityName: 'Public Swim',
        startDatetimeUtc: at(SAT, 11),
        endDatetimeUtc: at(SAT, 12),
      })),
    ];
    expect(dedupeCandidates(items, () => false).collapsed).toBe(1);
  });

  it('never merges a dateless open-hours listing with a dated one', () => {
    const dated = asItem(kidActivity({ id: 'o1', activityName: 'Aquarium Visit' }));
    const openHours = asItem(
      kidActivity({
        id: 'o2',
        activityName: 'Aquarium Visit',
        openHours: true,
        startDatetimeUtc: null,
        endDatetimeUtc: null,
        openHoursLabel: 'Daily 10:00 AM-5:00 PM',
      })
    );
    expect(dedupeCandidates([dated, openHours], () => false).collapsed).toBe(0);
    // Two open-hours rows for the same attraction DO collapse — they are both simply "open".
    const openHours2 = asItem({ ...openHours.listing, id: 'o3' });
    expect(dedupeCandidates([openHours, openHours2], () => false).collapsed).toBe(1);
  });

  it('honours an injected sameParentOrg predicate as the third venue arm', () => {
    const items = [
      asItem(kidActivity({ id: 'r1', activityName: 'Public Swim', venueName: 'Pool A', geo: HOME })),
      asItem(kidActivity({ id: 'r2', activityName: 'Public Swim', venueName: 'Pool B', geo: ACROSS_TOWN })),
    ];
    expect(dedupeCandidates(items, () => false).collapsed).toBe(0);
    expect(dedupeCandidates(items, () => true).collapsed).toBe(1);
  });

  it('runs BEFORE the floor check, so a collapsed pair cannot fake a sendable week', () => {
    // Four rows, two distinct activities. With the floor at 3 this must degrade to an empty
    // week rather than sending 2 while believing it sent 4.
    const listings = [
      kidActivity({ id: 'd1', activityName: 'Parent & Tot Swim', venueName: 'Templeton Pool' }),
      kidActivity({ id: 'd2', activityName: 'Parent and Tot Swim', venueName: 'Templeton Pool' }),
      kidActivity({
        id: 'd3',
        activityName: 'Preschool Storytime',
        venueName: 'Britannia Library',
        startDatetimeUtc: at(SUN, 14),
        endDatetimeUtc: at(SUN, 15),
      }),
      kidActivity({
        id: 'd4',
        activityName: 'Preschool Story Time',
        venueName: 'Britannia Library',
        startDatetimeUtc: at(SUN, 14),
        endDatetimeUtc: at(SUN, 15),
      }),
    ];
    const result = selectWeeklyPicks(input(listings));
    expect(result.outcome).toBe('empty');
    expect(result.emptyReason).toBe('none_showable');
  });
});

describe('normal fill', () => {
  it('caps at 10 picks and splits direct vs hub links', () => {
    const result = selectWeeklyPicks(input(distinctActivities(14)));
    expect(result.outcome).toBe('picks');
    expect(result.picks).toHaveLength(10);
    expect(result.retried).toBe(false);
    expect(result.picks.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.picks.filter((p) => p.linkOrigin === 'direct')).toHaveLength(DIRECT_LINK_PICKS);
    expect(result.picks.filter((p) => p.linkOrigin === 'hub')).toHaveLength(7);
    expect(result.shouldPause).toBe(false);
    expect(result.emptyReason).toBeNull();
  });

  it('sends a 4-pick week as a 4-pick week — the floor is 3, not 5', () => {
    const result = selectWeeklyPicks(input(distinctActivities(4)));
    expect(result.outcome).toBe('picks');
    expect(result.picks).toHaveLength(4);
    expect(result.retried).toBe(false);
    expect(result.picks.filter((p) => p.linkOrigin === 'direct')).toHaveLength(3);
    expect(result.picks.filter((p) => p.linkOrigin === 'hub')).toHaveLength(1);
  });
});

describe('the age-coverage swap (PRD §2.2 step 4)', () => {
  it('forces at most 2 picks, one per band, when 3 requested bands are unrepresented', () => {
    // Ten toddler activities sit close to home and rank first; three older-band listings sit
    // ~13km out, inside the search radius and inside the top-20 reach but below the cut of 10.
    const toddler = distinctActivities(10, {
      ageBandMatches: ['under2'],
      ageMinMonths: 0,
      ageMaxMonths: 24,
    });
    const older: ListingRecord[] = (['2-4', '5-9', '10-14'] as AgeBandKey[]).map((band, i) =>
      kidActivity({
        id: `old-${band}`,
        activityName: ACTIVITY_NAMES[12 + i],
        venueName: `${ACTIVITY_NAMES[12 + i]} Hall`,
        geo: { lat: FAR.lat + i * 0.01, lng: FAR.lng },
        ageBandMatches: [band],
        ageMinMonths: 24 + i * 36,
        ageMaxMonths: 60 + i * 36,
      })
    );

    const result = selectWeeklyPicks(
      input([...toddler, ...older], {
        // A 1-year-old, a 3-year-old, a 7-year-old and a 12-year-old: four bands requested.
        subscriber: {
          origin: { geo: HOME, label: 'East Van' },
          radiusKm: 20,
          birthYears: [2025, 2023, 2019, 2014],
          consecutiveEmptyWeeks: 0,
        },
      })
    );

    expect(result.ageBands).toEqual(['under2', '2-4', '5-9', '10-14']);
    // THE CAP: three bands are unrepresented, exactly two get a forced pick.
    expect(result.forcedPicks).toHaveLength(MAX_FORCED_PICKS);
    expect(result.forcedPicks).toHaveLength(2);
    // One per band, youngest-first; the third unrepresented band goes without this week.
    expect(result.forcedPicks.map((f) => f.band)).toEqual(['2-4', '5-9']);
    // The selection stayed at the cap — each forced pick displaced one, it did not grow the list.
    expect(result.picks).toHaveLength(10);
    for (const forced of result.forcedPicks) {
      expect(forced.displacedOccurrenceId).not.toBeNull();
    }
    // A forced pick never evicts another forced pick.
    const forcedIds = result.forcedPicks.map((f) => f.occurrenceId);
    const displacedIds = result.forcedPicks.map((f) => f.displacedOccurrenceId);
    expect(forcedIds.some((id) => displacedIds.includes(id))).toBe(false);
    // And the forced picks really are in the sent set, tagged with the band they represent.
    const tagged = result.picks.filter((p) => p.forcedForBand);
    expect(tagged.map((p) => p.forcedForBand)).toEqual(['2-4', '5-9']);
  });

  it('does not force anything when every requested band is already represented', () => {
    const result = selectWeeklyPicks(input(distinctActivities(8)));
    expect(result.forcedPicks).toEqual([]);
    expect(result.picks.every((p) => p.forcedForBand === undefined)).toBe(true);
  });

  it('will not reach past the top-20 for a representative — the band goes unrepresented', () => {
    // Tested directly on the pure helper so the assertion is about the REACH CAP and not about
    // however the engine happened to rank a fixture.
    const ranked = [
      ...distinctActivities(COVERAGE_SWAP_REACH, {
        ageBandMatches: ['under2'],
        ageMinMonths: 0,
        ageMaxMonths: 24,
      }),
      kidActivity({
        id: 'tween',
        activityName: 'Tween Hangout',
        venueName: 'Tween Hall',
        ageBandMatches: ['10-14'],
        ageMinMonths: 120,
        ageMaxMonths: 180,
      }),
    ].map(asItem);
    expect(ranked).toHaveLength(21);

    const { selection, forced } = applyCoverageSwap(
      ranked.slice(0, 10),
      ranked,
      ['under2', '10-14'],
      10
    );
    expect(forced).toEqual([]);
    expect(selection.map((s) => s.listing.id)).not.toContain('tween');

    // Move it to index 19 — now inside the reach — and it IS pulled in.
    const reachable = [...ranked.slice(0, 19), ranked[20], ...ranked.slice(19, 20)];
    const inReach = applyCoverageSwap(reachable.slice(0, 10), reachable, ['under2', '10-14'], 10);
    expect(inReach.forced.map((f) => f.occurrenceId)).toEqual(['tween']);
  });

  it('appends rather than displaces when the selection is not yet full', () => {
    const ranked = [
      ...distinctActivities(3, { ageBandMatches: ['under2'], ageMinMonths: 0, ageMaxMonths: 24 }),
      kidActivity({
        id: 'tween',
        activityName: 'Tween Hangout',
        venueName: 'Tween Hall',
        ageBandMatches: ['10-14'],
        ageMinMonths: 120,
        ageMaxMonths: 180,
      }),
    ].map(asItem);

    const { selection, forced } = applyCoverageSwap(
      ranked.slice(0, 3),
      ranked,
      ['under2', '10-14'],
      10
    );
    expect(selection).toHaveLength(4);
    expect(forced).toEqual([
      { band: '10-14', occurrenceId: 'tween', displacedOccurrenceId: null },
    ]);
  });
});

describe('the degradation retry (PRD §2.2 step 5)', () => {
  it('fires exactly once, widens radius AND window, and reports both attempts', () => {
    // Nothing inside 10km this weekend; three things ~13km out, one of them on the Monday that
    // only the relaxed window reaches.
    const listings = [
      kidActivity({ id: 'f1', activityName: 'Splash Time', venueName: 'Far Pool', geo: FAR }),
      kidActivity({
        id: 'f2',
        activityName: 'Story Circle',
        venueName: 'Far Library',
        geo: { lat: FAR.lat + 0.01, lng: FAR.lng },
        startDatetimeUtc: at(SUN, 11),
        endDatetimeUtc: at(SUN, 12),
      }),
      kidActivity({
        id: 'f3',
        activityName: 'Lego Build',
        venueName: 'Far Annex',
        geo: { lat: FAR.lat + 0.02, lng: FAR.lng },
        startDatetimeUtc: at(MON, 10),
        endDatetimeUtc: at(MON, 11),
      }),
    ];

    const result = selectWeeklyPicks(input(listings));
    expect(result.retried).toBe(true);
    expect(result.outcome).toBe('picks');
    expect(result.radiusKmUsed).toBe(20);
    expect(result.reached.primary).toBe(0);
    expect(result.reached.retry).toBe(3);
    // The Monday listing is reachable ONLY through the relaxed window.
    expect(result.picks.map((p) => p.item.listing.id)).toContain('f3');
  });

  it('does not retry when the primary attempt already clears the floor', () => {
    const result = selectWeeklyPicks(input(distinctActivities(5)));
    expect(result.retried).toBe(false);
    expect(result.reached.retry).toBeNull();
    expect(result.radiusKmUsed).toBe(10);
  });

  it('is not compounding: a still-short retry ends the week, it does not widen again', () => {
    const result = selectWeeklyPicks(
      input([kidActivity({ id: 'lonely', activityName: 'Splash Time', venueName: 'Only Pool' })])
    );
    expect(result.retried).toBe(true);
    expect(result.outcome).toBe('empty');
    // 20km — one widening happened, full stop. Never 30km or 40km.
    expect(result.radiusKmUsed).toBe(20);
  });
});

describe('the empty-week outcome (PRD §2.2 step 6)', () => {
  it('distinguishes "nothing reached" from "nothing we can stand behind"', () => {
    const nothing = selectWeeklyPicks(input([]));
    expect(nothing.outcome).toBe('empty');
    expect(nothing.emptyReason).toBe('nothing_reached');

    // Reached, but every candidate is postponed — isShowableOnFrontDoor rejects the lot.
    const postponed = selectWeeklyPicks(
      input(distinctActivities(6).map((l) => ({ ...l, statusState: 'postponed' as const })))
    );
    expect(postponed.outcome).toBe('empty');
    expect(postponed.emptyReason).toBe('none_showable');
  });

  it('flags the third consecutive empty week for the caller, without transitioning anything', () => {
    // The module reports; the send job performs the status change. Two empties behind us plus
    // this one is the third.
    const third = selectWeeklyPicks(
      input([], { subscriber: { origin: { geo: HOME, label: 'East Van' }, birthYears: [2020], consecutiveEmptyWeeks: 2 } })
    );
    expect(third.outcome).toBe('empty');
    expect(third.shouldPause).toBe(true);

    const first = selectWeeklyPicks(
      input([], { subscriber: { origin: { geo: HOME, label: 'East Van' }, birthYears: [2020], consecutiveEmptyWeeks: 0 } })
    );
    expect(first.shouldPause).toBe(false);

    // A week that DOES send never asks the caller to pause, whatever the counter said.
    const sending = selectWeeklyPicks(
      input(distinctActivities(5), {
        subscriber: { origin: { geo: HOME, label: 'East Van' }, radiusKm: 10, birthYears: [2020], consecutiveEmptyWeeks: 2 },
      })
    );
    expect(sending.outcome).toBe('picks');
    expect(sending.shouldPause).toBe(false);
  });
});

describe('registration content (PRD v2.8 §2.2 step 2 — Jon\'s ruling)', () => {
  // NOTE, because this test's reason CHANGED in round 7. It used to pass because the engine's
  // `includeRegistration` defaults to false and dropped these before the selector saw them. The
  // request now sets `includeRegistration: true` deliberately and lib/sms/registration.ts decides
  // instead — so the same assertion now proves OUR rule rather than the engine's default. The
  // vocabulary-level cases live in tests/sms/registration.test.ts; these two prove the wiring.
  it('leaves multi-session courses out', () => {
    const courses = distinctActivities(6).map((l, i) => ({
      ...l,
      activityName: `${l.activityName} Class`,
      id: `course-${i}`,
    }));
    expect(selectWeeklyPicks(input(courses)).outcome).toBe('empty');
    expect(selectWeeklyPicks(input(distinctActivities(6))).outcome).toBe('picks');
  });

  it('now LETS IN a one-off that only needs booking — the round-7 behaviour change', () => {
    // Before Jon's ruling these were dropped by the engine's blanket exclusion. A rec centre's
    // bookable weekend badminton slot is exactly the content the weekly text was missing.
    const bookable = distinctActivities(6).map((l, i) => ({
      ...l,
      activityName: `Reserve In Advance: ${l.activityName}`,
      id: `bookable-${i}`,
    }));
    const result = selectWeeklyPicks(input(bookable));
    expect(result.outcome).toBe('picks');
    expect(result.picks).toHaveLength(6);
  });
});

describe('the novelty filter (PRD v2.8 §2.2 step 4)', () => {
  it('excludes an occurrence the subscriber has already been sent', () => {
    const listings = distinctActivities(6);
    const alreadySent = new Set(['act-0', 'act-1']);

    const before = selectWeeklyPicks(input(listings));
    expect(before.picks).toHaveLength(6);
    expect(before.novelExcluded).toBe(0);

    const after = selectWeeklyPicks(input(listings, { excludeOccurrenceIds: alreadySent }));
    expect(after.picks).toHaveLength(4);
    expect(after.novelExcluded).toBe(2);
    expect(after.picks.map((p) => p.item.listing.id)).not.toContain('act-0');
    expect(after.picks.map((p) => p.item.listing.id)).not.toContain('act-1');
  });

  it('treats an absent or empty exclusion set as no filtering — a first send is not a repeat', () => {
    for (const exclude of [undefined, new Set<string>()]) {
      const result = selectWeeklyPicks(input(distinctActivities(6), { excludeOccurrenceIds: exclude }));
      expect(result.picks).toHaveLength(6);
      expect(result.novelExcluded).toBe(0);
    }
  });

  it('is NOT relaxed by retry step (a) — an empty week stays empty', () => {
    // THE PROPERTY THE PRD IS EXPLICIT ABOUT. Three things exist, all already sent. The widened
    // radius/window retry finds nothing new, and the week must end empty rather than re-serving a
    // repeat to reach the floor.
    const listings = distinctActivities(3);
    const allSent = new Set(listings.map((l) => l.id));

    const result = selectWeeklyPicks(input(listings, { excludeOccurrenceIds: allSent }));
    expect(result.outcome).toBe('empty');
    expect(result.retried).toBe(true);
    expect(result.degradation).toBe('widened');
    expect(result.picks).toEqual([]);
  });

  it('is NOT relaxed by retry step (b) either — dropping interests does not drop novelty', () => {
    // Step (b) exists to widen WHICH activities qualify. It must not widen to activities they have
    // already had: those two relaxations are not interchangeable.
    const listings = distinctActivities(8, { primaryCategoryKey: 'swimming' });
    const allSent = new Set(listings.map((l) => l.id));

    const result = selectWeeklyPicks(
      input(listings, {
        excludeOccurrenceIds: allSent,
        subscriber: {
          origin: { geo: HOME, label: 'East Van' },
          radiusKm: 10,
          birthYears: [2020],
          categoryInterests: ['pottery'],
          consecutiveEmptyWeeks: 0,
        },
      })
    );
    expect(result.outcome).toBe('empty');
    // Step (b) DID fire — the interest filter was dropped — and it still found nothing, because
    // novelty survived it.
    expect(result.degradation).toBe('widened_and_interests_dropped');
    expect(result.interestsDropped).toBe(true);
  });

  it('runs BEFORE the coverage swap, so a forced pick cannot reintroduce a repeat', () => {
    // The ordering the PRD specifies, and the reason for it: the swap both selects from and
    // REACHES INTO the candidate list, so filtering after it would let an already-sent occurrence
    // back in through the forced-pick path.
    const toddler = distinctActivities(10, {
      ageBandMatches: ['under2'],
      ageMinMonths: 0,
      ageMaxMonths: 24,
    });
    const older = kidActivity({
      id: 'old-5-9',
      activityName: ACTIVITY_NAMES[12],
      venueName: 'Big Kid Hall',
      geo: { lat: FAR.lat, lng: FAR.lng },
      ageBandMatches: ['5-9'],
      ageMinMonths: 60,
      ageMaxMonths: 96,
    });

    const subscriber = {
      origin: { geo: HOME, label: 'East Van' },
      radiusKm: 20,
      birthYears: [2025, 2019], // under2 + 5-9
      consecutiveEmptyWeeks: 0,
    };

    // Without the exclusion, the 5-9 listing is forced in to represent its band.
    const forced = selectWeeklyPicks(input([...toddler, older], { subscriber }));
    expect(forced.forcedPicks.map((f) => f.occurrenceId)).toContain('old-5-9');

    // With it excluded as already-sent, the band simply goes unrepresented.
    const withExclusion = selectWeeklyPicks(
      input([...toddler, older], { subscriber, excludeOccurrenceIds: new Set(['old-5-9']) })
    );
    expect(withExclusion.forcedPicks).toEqual([]);
    expect(withExclusion.picks.map((p) => p.item.listing.id)).not.toContain('old-5-9');
  });

  it('counts what it removed AFTER dedup, so a repeat and its duplicate count once', () => {
    // Ordering again: dedup collapses the pair first, so the exclusion removes one candidate
    // rather than two, and novelExcluded reports one.
    const listings = [
      kidActivity({ id: 'dup-a', activityName: 'Parent & Tot Swim', venueName: 'Templeton Pool' }),
      kidActivity({ id: 'dup-b', activityName: 'Parent and Tot Swim', venueName: 'Templeton Pool' }),
      ...distinctActivities(4, {}, 2),
    ];
    const result = selectWeeklyPicks(
      input(listings, { floorPicks: 1, excludeOccurrenceIds: new Set(['dup-a']) })
    );
    expect(result.deduped).toBe(1); // the pair collapsed
    expect(result.novelExcluded).toBe(1); // then one survivor was excluded
    expect(result.picks.map((p) => p.item.listing.id)).not.toContain('dup-a');
    expect(result.picks.map((p) => p.item.listing.id)).not.toContain('dup-b');
  });
});

describe('category interests', () => {
  it('filters on primary category or tags, case-insensitively; no interests means no filter', () => {
    const swimming = distinctActivities(3, { primaryCategoryKey: 'swimming' }, 0);
    const arts = distinctActivities(3, { primaryCategoryKey: 'arts', categoryTags: ['arts'] }, 6);
    const listings = [...swimming, ...arts];

    const unfiltered = selectWeeklyPicks(input(listings, { floorPicks: 1 }));
    expect(unfiltered.picks).toHaveLength(6);

    const swimOnly = selectWeeklyPicks(
      input(listings, {
        floorPicks: 1,
        subscriber: {
          origin: { geo: HOME, label: 'East Van' },
          radiusKm: 10,
          birthYears: [2020],
          categoryInterests: ['Swimming'], // case-insensitive
          consecutiveEmptyWeeks: 0,
        },
      })
    );
    expect(swimOnly.picks).toHaveLength(3);
    expect(swimOnly.picks.every((p) => p.item.listing.primaryCategoryKey === 'swimming')).toBe(true);
  });

});

describe('the interest-drop retry, step (b) (PRD v2.4 §2.2 step 5b)', () => {
  /** Everything on offer is swimming; the subscriber ticked pottery. */
  function narrowInterest(over: Partial<WeeklyPicksInput> = {}) {
    return input(distinctActivities(8, { primaryCategoryKey: 'swimming' }), {
      ...over,
      subscriber: {
        origin: { geo: HOME, label: 'East Van' },
        radiusKm: 10,
        birthYears: [2020],
        categoryInterests: ['pottery'],
        consecutiveEmptyWeeks: 0,
      },
    });
  }

  it('turns an undeserved empty week into a normal send by dropping the interest filter', () => {
    // THE CASE THIS STEP EXISTS FOR. Eight real, showable matches for this child sat right there
    // all weekend; before v2.4 an optional checkbox nobody was required to tick sent an
    // "there's nothing this weekend" text over the top of them.
    const result = selectWeeklyPicks(narrowInterest());
    expect(result.outcome).toBe('picks');
    expect(result.picks).toHaveLength(8);
    expect(result.degradation).toBe('widened_and_interests_dropped');
    expect(result.interestsDropped).toBe(true);
    expect(result.retried).toBe(true);
    // The picks really are outside the stated interest — that is the whole point of the step.
    expect(result.picks.every((p) => p.item.listing.primaryCategoryKey === 'swimming')).toBe(true);
  });

  it('does NOT fire when step (a) alone already cleared the floor', () => {
    // Non-compounding, same discipline as step (a): a step that fires when it was not needed is
    // a subscriber silently getting picks outside the interests they chose.
    const listings = [
      kidActivity({ id: 'f1', activityName: 'Splash Time', venueName: 'Far Pool', geo: FAR, primaryCategoryKey: 'public_swim' }),
      kidActivity({
        id: 'f2',
        activityName: 'Story Circle',
        venueName: 'Far Library',
        geo: { lat: FAR.lat + 0.01, lng: FAR.lng },
        primaryCategoryKey: 'public_swim',
        startDatetimeUtc: at(SUN, 11),
        endDatetimeUtc: at(SUN, 12),
      }),
      kidActivity({
        id: 'f3',
        activityName: 'Lego Build',
        venueName: 'Far Annex',
        geo: { lat: FAR.lat + 0.02, lng: FAR.lng },
        primaryCategoryKey: 'public_swim',
        startDatetimeUtc: at(MON, 10),
        endDatetimeUtc: at(MON, 11),
      }),
    ];
    const result = selectWeeklyPicks(
      input(listings, {
        subscriber: {
          origin: { geo: HOME, label: 'East Van' },
          radiusKm: 10,
          birthYears: [2020],
          categoryInterests: ['public_swim'], // matches — step (a) is enough
          consecutiveEmptyWeeks: 0,
        },
      })
    );
    expect(result.outcome).toBe('picks');
    expect(result.degradation).toBe('widened');
    expect(result.interestsDropped).toBe(false);
  });

  it('does NOT fire on the primary attempt — a full weekend never degrades', () => {
    const result = selectWeeklyPicks(
      input(distinctActivities(8, { primaryCategoryKey: 'public_swim' }), {
        subscriber: {
          origin: { geo: HOME, label: 'East Van' },
          radiusKm: 10,
          birthYears: [2020],
          categoryInterests: ['public_swim'],
          consecutiveEmptyWeeks: 0,
        },
      })
    );
    expect(result.degradation).toBe('none');
    expect(result.retried).toBe(false);
    expect(result.interestsDropped).toBe(false);
  });

  it('is SKIPPED when the subscriber stated no interests — nothing to drop', () => {
    // Degradation must describe what the subscriber actually suffered. Reporting
    // 'interests_dropped' for someone who never set any would be a lie in the send log.
    const result = selectWeeklyPicks(input([kidActivity({ id: 'lonely', activityName: 'Splash Time', venueName: 'Only Pool' })]));
    expect(result.outcome).toBe('empty');
    expect(result.degradation).toBe('widened');
    expect(result.interestsDropped).toBe(false);
  });

  it('still applies every showability gate — dropping interests never drops quality', () => {
    // Everything on offer is postponed. Step (b) must widen WHICH activities qualify, never what
    // the product is willing to stand behind.
    const postponed = distinctActivities(8, {
      primaryCategoryKey: 'swimming',
      statusState: 'postponed' as const,
    });
    const result = selectWeeklyPicks(
      input(postponed, {
        subscriber: {
          origin: { geo: HOME, label: 'East Van' },
          radiusKm: 10,
          birthYears: [2020],
          categoryInterests: ['pottery'],
          consecutiveEmptyWeeks: 0,
        },
      })
    );
    expect(result.outcome).toBe('empty');
    expect(result.degradation).toBe('widened_and_interests_dropped');
    expect(result.emptyReason).toBe('none_showable');
  });

  it('does not search a third time — step (b) reuses step (a) response', () => {
    // Interests are a post-filter, not a query param, so step (b) asks an identical question.
    // Two engine calls total: primary + one widened retry.
    const engine = engineOver(distinctActivities(8, { primaryCategoryKey: 'swimming' }));
    const calls: unknown[] = [];
    const spied = {
      search: (req: Parameters<SearchEngine['search']>[0]) => {
        calls.push(req);
        return engine.search(req);
      },
    } as unknown as SearchEngine;

    const result = selectWeeklyPicks({
      engine: spied,
      now: FRIDAY_4PM,
      subscriber: {
        origin: { geo: HOME, label: 'East Van' },
        radiusKm: 10,
        birthYears: [2020],
        categoryInterests: ['pottery'],
        consecutiveEmptyWeeks: 0,
      },
    });
    expect(result.interestsDropped).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
