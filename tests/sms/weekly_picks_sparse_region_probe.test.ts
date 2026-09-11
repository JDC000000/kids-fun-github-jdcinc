// tests/sms/weekly_picks_sparse_region_probe.test.ts
//
// ═══ A DIAGNOSTIC PROBE, NOT A SPECIFICATION. DO NOT MERGE THIS TO main AS-IS. ═══
//
// Written 2026-09-11 by an independent QA pass over the weekly-picks diversity work
// (37793dd / 567f4e6 / e8a2825) against origin/main abbc74b. Its job is to make ONE question
// answerable by running a command instead of by argument:
//
//   What does the Friday text look like for a family in a region that has very few venues?
//
// The diversity rules shipped today are all REORDERS with no distance term. That is correct and
// deliberate on a dense page — there is always a nearby alternative to reach for. In a SPARSE
// region there is not, and the alternative the rules reach for is 18-22 km away. This file
// prints, rather than asserts, exactly what a parent would receive in that case, so the tradeoff
// is a number somebody signed off on rather than a surprise in a beta inbox.
//
// It asserts ONLY the structural invariants that must hold whatever the tuning is:
//   • the diversity passes are reorders, so a full pool still yields a full ten;
//   • nothing crashes on a one-venue, one-category, single-child region.
// It deliberately asserts NOTHING about which venue lands in which slot. Pinning today's
// geography here would convert a tuning decision into a test nobody can change.
//
// Run:  npx vitest run --project unit tests/sms/weekly_picks_sparse_region_probe.test.ts
// Read the console output. Compare against 65d7f73 (the commit before this work) to see the delta.
import { describe, expect, it } from 'vitest';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import type { AgeBandKey, GeoPoint, ListingRecord } from '@/lib/search/types';
import { MAX_PICKS, selectWeeklyPicks, type WeeklyPicksInput } from '@/lib/sms/weekly-picks';

/** Friday 2026-08-28, 16:00 PDT — the PRD's send moment, as in the sibling weekly-picks suites. */
const FRIDAY_4PM = new Date('2026-08-28T23:00:00Z');
const SAT = '2026-08-29';
const HOME: GeoPoint = { lat: 49.28, lng: -123.07 };

const northOfHome = (metres: number): GeoPoint => ({ lat: HOME.lat + metres / 111_320, lng: HOME.lng });
/** America/Vancouver is UTC-7 in August. */
const at = (isoDate: string, localHour: number, localMinute = 0) =>
  `${isoDate}T${String(localHour + 7).padStart(2, '0')}:${String(localMinute).padStart(2, '0')}:00Z`;

// Staggered starts, 15 minutes apart, four to the hour. Cards at ONE venue that share a start time
// satisfy `isDuplicatePair`'s time-overlap arm and collapse — which would make a sparse fixture
// look sparse for the wrong reason. These do not overlap.
const startOf = (i: number) => at(SAT, 8 + Math.floor(i / 4), (i % 4) * 15);
const endOf = (i: number) => at(SAT, 9 + Math.floor(i / 4), (i % 4) * 15);

/** Unrelated words — max pairwise trigram similarity 0.333, well under every dedup threshold. */
const WORDS = [
  'Story Circle', 'Lego Build', 'Puppet Show', 'Nature Walk', 'Music Makers',
  'Gym Romp', 'Art Studio', 'Chess Club', 'Marble Run', 'Bike Rodeo',
  'Forest Explorers', 'Garden Club', 'Board Games', 'Pottery Wheel', 'Bird Watching',
  'Rock Climbing', 'Drama Games', 'Film Night', 'Science Lab', 'Yoga Kids',
];

function kidActivity(partial: Partial<ListingRecord> & { id: string }): ListingRecord {
  return makeListing({
    statusState: 'confirmed',
    ageMinMonths: 24,
    ageMaxMonths: 120,
    ageBandMatches: ['5-9'] as AgeBandKey[],
    startDatetimeUtc: at(SAT, 10),
    endDatetimeUtc: at(SAT, 11),
    primaryCategoryKey: 'general',
    ...partial,
  });
}

const engineOver = (listings: ListingRecord[]) =>
  new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
  });

function input(listings: ListingRecord[], over: Partial<WeeklyPicksInput> = {}): WeeklyPicksInput {
  return {
    engine: engineOver(listings),
    now: FRIDAY_4PM,
    ...over,
    subscriber: {
      origin: { geo: HOME, label: 'Sparse Town' },
      // A wide radius is the precondition for the whole question: at 10 km the distant venues
      // never enter the pool and no diversity rule can reach them.
      radiusKm: 25,
      birthYears: [2018], // ONE child, ONE band — the age-fit guards have nothing to protect.
      consecutiveEmptyWeeks: 0,
      ...over.subscriber,
    },
  };
}

/** A run of `count` distinct activities at one venue, all at the same point. */
function venueBlock(venueName: string, metres: number, ids: string, count: number, wordOffset: number) {
  return Array.from({ length: count }, (_, i) =>
    kidActivity({
      id: `${ids}-${i}`,
      activityName: WORDS[(wordOffset + i) % WORDS.length],
      venueName,
      geo: northOfHome(metres),
      startDatetimeUtc: startOf(i),
      endDatetimeUtc: endOf(i),
    })
  );
}

const shape = (picks: ReturnType<typeof selectWeeklyPicks>['picks']) =>
  picks.map((p) => `${p.item.listing.venueName}@${p.item.distanceKm?.toFixed(1)}km`);
const named = (picks: ReturnType<typeof selectWeeklyPicks>['picks']) =>
  shape(picks.filter((p) => p.linkOrigin === 'direct'));

describe('sparse region — what the diversity rules reach for when there is nothing nearby to reach for', () => {
  it('ONE nearby venue with twelve activities, eight venues 18-22 km out', () => {
    const listings = [...venueBlock('Delbrook Centre', 500, 'near', 12, 0)];
    for (let i = 0; i < 8; i += 1) {
      listings.push(...venueBlock(`Far ${i} Centre`, 18_000 + i * 600, `far${i}`, 1, 12 + i));
    }
    const result = selectWeeklyPicks(input(listings));

    console.log('[sparse/one-venue] ten   :', shape(result.picks));
    console.log('[sparse/one-venue] named :', named(result.picks));
    console.log('[sparse/one-venue] diag  :', JSON.stringify(result.diversity));

    // A reorder cannot thin a week. This is the invariant, and it is the only one.
    expect(result.picks.length).toBe(MAX_PICKS);
  });

  it('TWO nearby venues with six activities each, eight venues 18-22 km out', () => {
    const listings = [
      ...venueBlock('Alpha Centre', 500, 'a', 6, 0),
      ...venueBlock('Beta Centre', 1_200, 'b', 6, 6),
    ];
    for (let i = 0; i < 8; i += 1) {
      listings.push(...venueBlock(`Far ${i} Centre`, 18_000 + i * 600, `far${i}`, 1, 12 + i));
    }
    const result = selectWeeklyPicks(input(listings));

    console.log('[sparse/two-venues] ten   :', shape(result.picks));
    console.log('[sparse/two-venues] named :', named(result.picks));
    console.log('[sparse/two-venues] diag  :', JSON.stringify(result.diversity));

    expect(result.picks.length).toBe(MAX_PICKS);
  });

  it('a one-venue, one-category, single-child region does not crash and loses nothing', () => {
    const result = selectWeeklyPicks(input(venueBlock('Only Centre', 600, 'only', 12, 0)));

    console.log('[sparse/degenerate] ten :', shape(result.picks));
    expect(result.picks.length).toBe(MAX_PICKS);
    expect(new Set(result.picks.map((p) => p.item.listing.venueName)).size).toBe(1);
    // Nothing to spread, so no rule should claim it spread anything.
    expect(result.diversity?.venueCapDeferred).toBe(0);
    expect(result.diversity?.categoryCapDeferred).toBe(0);
  });

  it('an empty catalogue is an empty week, not a crash', () => {
    expect(selectWeeklyPicks(input([])).picks.length).toBe(0);
  });
});
