// invariants/_corpus.ts — A deterministic catalogue built RELATIVE to a pinned clock.
//
// WHY NOT lib/search/__fixtures__/listings.ts. That fixture is hard-pinned to July 2026 (its own
// header says so: "reference now for tests is 2026-07-13T12:00:00-07:00"). This suite runs the
// same query space against FOUR pinned clocks, including 22:35 America/Vancouver and a DST
// transition day, and against a July-2026 catalogue every one of those clocks would return an
// empty date-filtered set — a suite that asserts invariants over nothing and passes.
//
// So the corpus is GENERATED from the pinned `now`: every dated occurrence is placed at a stated
// Vancouver-LOCAL day offset and local wall-clock time, converted to UTC by invariants/_time.ts
// (which does not import from lib/). Change the clock and the catalogue moves with it, so the
// same combination of filters is exercised the same way at 07:15 and at 22:35.
//
// Two halves:
//   • a GENERATED body — a seeded, reproducible walk over the region × age × cost × status ×
//     day-part × tag space, so the filter combinations have bulk behind them; and
//   • a hand-authored TRAP set — the specific shapes whose handling is a documented product
//     ruling (adult/senior-only titles, parent-and-child titles that say "adult", registration
//     vocabulary and its drop-in veto, the asymmetric free-cost cells, open-hours rows with and
//     without published hours, a multi-day occurrence, a midnight-crossing occurrence, an
//     un-geocoded venue, a region tag no hierarchy knows).
//
// NAMING RULE, and it is load-bearing: every generated name is deliberately inert against
// lib/search/filters/registration.ts and lib/search/filters/audience.ts. A generated listing
// called "Open Gym Session 2" would be silently reclassified as registration content and the
// generated body would stop meaning what the dimension table says it means. Traps are the ONLY
// listings allowed to carry those words, and each one says which rule it is aiming at.

import type { AgeBandKey, CostStatus, ListingRecord, StatusState } from '../lib/search/types';
import { makeListing } from '../lib/search/__fixtures__/factory';
import { REGION_IDS, REGIONS } from '../lib/search/__fixtures__/regions';
import { RegionHierarchy } from '../lib/geo/region';
import { FixtureAliasResolver } from '../lib/search/expand';
import { InMemoryListingRepository } from '../lib/search/repository';
import { SearchEngine } from '../lib/search/engine';
import { addDays, localDay, localToUtc } from './_time';

/** Every listing carries this in its description so a text query can address the whole corpus. */
export const CORPUS_TOKEN = 'fixturecorpus';

/** A venue point per region, roughly matching lib/search/__fixtures__/regions.ts centroids. */
const POINTS = {
  eastVan: { lat: 49.26, lng: -123.07 },
  westSide: { lat: 49.25, lng: -123.16 },
  northVan: { lat: 49.32, lng: -123.07 },
  burnaby: { lat: 49.2488, lng: -122.98 },
  richmond: { lat: 49.1666, lng: -123.1336 },
} as const;

/** The origin every radius-bearing query in this suite measures from. */
export const ORIGIN_COORDS = POINTS.eastVan;

interface RegionSpec {
  key: string;
  municipalityId: string | null;
  displayArea: string | null;
  geo: { lat: number; lng: number } | null;
}

const REGION_SPECS: RegionSpec[] = [
  { key: 'van-east', municipalityId: REGION_IDS.vancouver, displayArea: REGION_IDS.vanEast, geo: POINTS.eastVan },
  { key: 'van-west', municipalityId: REGION_IDS.vancouver, displayArea: REGION_IDS.vanWestSide, geo: POINTS.westSide },
  { key: 'nvan', municipalityId: REGION_IDS.northVan, displayArea: null, geo: POINTS.northVan },
  { key: 'bby', municipalityId: REGION_IDS.burnaby, displayArea: null, geo: POINTS.burnaby },
  // Richmond sits ~11km from the East-Van origin, i.e. OUTSIDE the default 10km radius and
  // INSIDE the ladder's 20km rung — which is what makes the radius rung observable at all.
  { key: 'rmd', municipalityId: REGION_IDS.richmond, displayArea: null, geo: POINTS.richmond },
  // Un-geocoded and untagged: excluded by radius (withinRadius rejects a null point) but visible
  // to every non-geo query. Its presence is what keeps "adding an origin narrows" non-vacuous.
  { key: 'untagged', municipalityId: null, displayArea: null, geo: null },
];

interface CostSpec {
  key: string;
  costStatus: CostStatus;
  costMinCad: number | null;
  costMaxCad: number | null;
}

/**
 * The cost cells, including the two whose asymmetry lib/search/filters/cost.ts calls out by name.
 * `known/min=null/max=0` IS free; `known/min=0/max=null` is NOT. Anyone paraphrasing that as
 * "both bounds zero" gets the first cell wrong, so both are in the corpus, both under the Free
 * filter, every run.
 */
const COST_SPECS: CostSpec[] = [
  { key: 'free', costStatus: 'free', costMinCad: null, costMaxCad: null },
  { key: 'known-zero-ceiling', costStatus: 'known', costMinCad: null, costMaxCad: 0 },
  { key: 'known-zero-floor', costStatus: 'known', costMinCad: 0, costMaxCad: null },
  { key: 'known-5', costStatus: 'known', costMinCad: 5, costMaxCad: 5 },
  { key: 'known-85', costStatus: 'known', costMinCad: 85, costMaxCad: 120 },
  { key: 'unknown', costStatus: 'unknown', costMinCad: null, costMaxCad: null },
  { key: 'check-source', costStatus: 'check_source', costMinCad: null, costMaxCad: null },
];

const AGE_SPECS: Array<{ key: string; bands: AgeBandKey[]; min: number | null; max: number | null }> = [
  { key: 'under2', bands: ['under2'], min: 0, max: 24 },
  { key: '2-4', bands: ['2-4'], min: 24, max: 60 },
  { key: '5-9', bands: ['5-9'], min: 60, max: 120 },
  { key: '10-14', bands: ['10-14'], min: 120, max: 180 },
  { key: '15+', bands: ['15+'], min: 180, max: null },
  { key: 'span', bands: ['under2', '2-4', '5-9'], min: 0, max: 120 },
  // All-ages / unknown: matchesAge deliberately does NOT hide these under an age filter.
  { key: 'allages', bands: [], min: null, max: null },
];

const STATUS_SPECS: StatusState[] = [
  'confirmed',
  'bookable_open',
  'inferred_recurring',
  'seasonal_active',
  'stale',
  'waitlist',
  // expected-section class
  'seasonal_preseason',
  'manual_candidate',
  // hidden class — never shown in ANY mode; present so the safety invariant is non-vacuous.
  'cancelled',
  'needs_review',
];

/** Local start hours, one per day-part window plus two boundary cases. */
const START_HOURS = [9, 11, 14, 16, 19, 21];

const TAG_SPECS: string[][] = [[], ['indoor'], ['drop_in'], ['indoor', 'drop_in']];

/** Local day offsets from the pinned clock's local day. -1 and +4 sit OUTSIDE the ±3 ladder. */
const DAY_OFFSETS = [-1, 0, 1, 2, 4];

/** Inert names — nothing here trips the registration or adult/senior vocabularies. */
const NAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Juliett', 'Kilo', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec',
  'Romeo', 'Sierra', 'Tango', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu',
];

/**
 * A 32-bit LCG (Numerical Recipes constants). Seeded, so "sampled deterministically" means the
 * same catalogue and the same query sample on every machine and every run — a metamorphic suite
 * that shuffled its own inputs would report a different bug each night and none of them twice.
 */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Deterministic pick from a list. */
function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length) % list.length];
}

export interface CorpusOptions {
  /** How many generated (non-trap) listings. Default 66. */
  size?: number;
  /** Seed for the generated body. Default 20260818. */
  seed?: number;
}

/**
 * Build the catalogue for a pinned clock. Deterministic in (now, seed, size).
 *
 * Every dated row is placed by LOCAL day + LOCAL hour, so "an afternoon activity tomorrow" is
 * exactly that in Vancouver regardless of what the UTC calendar says at the pinned instant.
 */
export function buildCorpus(now: Date, opts: CorpusOptions = {}): ListingRecord[] {
  const size = opts.size ?? 66;
  const rng = lcg(opts.seed ?? 20260818);
  const today = localDay(now);
  const at = (offset: number, hour: number, minute = 0) => localToUtc(addDays(today, offset), hour, minute);

  const listings: ListingRecord[] = [];

  for (let i = 0; i < size; i += 1) {
    const region = REGION_SPECS[i % REGION_SPECS.length];
    const cost = COST_SPECS[i % COST_SPECS.length];
    const age = AGE_SPECS[i % AGE_SPECS.length];
    const status = STATUS_SPECS[i % STATUS_SPECS.length];
    const offset = DAY_OFFSETS[i % DAY_OFFSETS.length];
    const hour = START_HOURS[i % START_HOURS.length];
    const tags = pick(rng, TAG_SPECS);
    const name = NAMES[i % NAMES.length];
    // Every 9th row shares a series with the row 9 before it, on the same local day — the
    // collapse path (one card per series per local day) has to be exercised by the bulk of the
    // corpus, not only by a hand-authored group, or "compare result SETS" silently means
    // "compare representative ids".
    const seriesId = i >= 9 && i % 9 === 0 ? `gen-series-${i - 9}` : `gen-series-${i}`;
    listings.push(
      makeListing({
        id: `gen-${String(i).padStart(3, '0')}`,
        seriesId,
        activityName: `Fixture ${name} ${region.key}`,
        primaryCategoryKey: i % 3 === 0 ? 'open_gym' : i % 3 === 1 ? 'storytime' : 'swim',
        categoryTags: tags,
        suitabilityTags: tags,
        venueName: `${region.key} Community Hall`,
        descriptionSnippet: `${CORPUS_TOKEN} generated row ${i}`,
        startDatetimeUtc: at(i >= 9 && i % 9 === 0 ? DAY_OFFSETS[(i - 9) % DAY_OFFSETS.length] : offset, hour).toISOString(),
        endDatetimeUtc: at(i >= 9 && i % 9 === 0 ? DAY_OFFSETS[(i - 9) % DAY_OFFSETS.length] : offset, hour + 1).toISOString(),
        costStatus: cost.costStatus,
        costMinCad: cost.costMinCad,
        costMaxCad: cost.costMaxCad,
        statusState: status,
        confidenceLabel: 'official',
        lastCheckedAtUtc: at(-2, 8).toISOString(),
        ageBandMatches: age.bands,
        ageMinMonths: age.min,
        ageMaxMonths: age.max,
        geo: region.geo,
        municipalityId: region.municipalityId,
        displayArea: region.displayArea,
      }),
    );
  }

  listings.push(...traps(at));
  return listings;
}

type At = (offset: number, hour: number, minute?: number) => Date;

/**
 * The rows whose treatment is a stated product ruling rather than a dimension of the table. Each
 * one names the rule it exists to keep honest; delete one and an invariant below quietly starts
 * passing over a corpus that cannot violate it.
 */
function traps(at: At): ListingRecord[] {
  const base = {
    primaryCategoryKey: 'general',
    venueName: 'Trap Community Hall',
    confidenceLabel: 'official' as const,
    geo: POINTS.eastVan,
    municipalityId: REGION_IDS.vancouver,
    displayArea: REGION_IDS.vanEast,
    costStatus: 'free' as const,
    ageBandMatches: [] as AgeBandKey[],
  };

  return [
    // ── audience.ts: adult/senior-only content is removed from a kids product unconditionally.
    makeListing({
      ...base,
      id: 'trap-adult-title',
      activityName: 'Adult 19yrs+ Swim',
      descriptionSnippet: `${CORPUS_TOKEN} adult-only by title prose`,
      startDatetimeUtc: at(0, 10).toISOString(),
      endDatetimeUtc: at(0, 11).toISOString(),
      ageMinMonths: 0,
      ageMaxMonths: 216,
      statusState: 'confirmed',
    }),
    makeListing({
      ...base,
      id: 'trap-senior-title',
      activityName: 'Seniors Tai Chi',
      descriptionSnippet: `${CORPUS_TOKEN} senior-only by title prose`,
      startDatetimeUtc: at(0, 14).toISOString(),
      endDatetimeUtc: at(0, 15).toISOString(),
      statusState: 'bookable_open',
    }),
    makeListing({
      ...base,
      id: 'trap-senior-structural',
      // No adult/senior WORD at all: caught only by the open-ended 55y+ age floor.
      activityName: 'Mah Jong',
      descriptionSnippet: `${CORPUS_TOKEN} senior-only by open-ended age floor`,
      startDatetimeUtc: at(1, 13).toISOString(),
      endDatetimeUtc: at(1, 15).toISOString(),
      ageMinMonths: 660,
      ageMaxMonths: null,
      statusState: 'confirmed',
    }),
    // ── audience.ts: a grown-up attending WITH a child is core kids content and must survive.
    makeListing({
      ...base,
      id: 'trap-parent-and-child',
      activityName: 'Family Badminton (6-13 with adult)',
      descriptionSnippet: `${CORPUS_TOKEN} parent-and-child, says "adult", must NOT be excluded`,
      startDatetimeUtc: at(0, 16).toISOString(),
      endDatetimeUtc: at(0, 17).toISOString(),
      ageBandMatches: ['5-9', '10-14'],
      ageMinMonths: 72,
      ageMaxMonths: 168,
      statusState: 'bookable_open',
    }),
    // ── registration.ts: opt-in course content, off by default, labelled when shown.
    makeListing({
      ...base,
      id: 'trap-registration-course',
      activityName: 'Beginner Pottery Course',
      descriptionSnippet: `${CORPUS_TOKEN} registration-shaped by title vocabulary`,
      startDatetimeUtc: at(0, 10).toISOString(),
      endDatetimeUtc: at(0, 12).toISOString(),
      ageBandMatches: ['5-9'],
      ageMinMonths: 60,
      ageMaxMonths: 120,
      statusState: 'bookable_open',
    }),
    makeListing({
      ...base,
      id: 'trap-registration-flag',
      // Drop-in-shaped NAME, but the source's own structured flag says you must register.
      activityName: 'Baby Storytime',
      descriptionSnippet: `${CORPUS_TOKEN} registration-shaped by the source's own flag`,
      registrationRequired: true,
      startDatetimeUtc: at(1, 10, 30).toISOString(),
      endDatetimeUtc: at(1, 11).toISOString(),
      ageBandMatches: ['under2'],
      ageMinMonths: 0,
      ageMaxMonths: 24,
      statusState: 'confirmed',
    }),
    makeListing({
      ...base,
      id: 'trap-registration-vetoed',
      // "Reserve In Advance" AND a drop-in signal: the veto keeps it in the default view.
      activityName: 'Reserve In Advance: Public Swim',
      descriptionSnippet: `${CORPUS_TOKEN} registration words vetoed by a drop-in signal`,
      startDatetimeUtc: at(0, 15).toISOString(),
      endDatetimeUtc: at(0, 17).toISOString(),
      ageBandMatches: ['2-4', '5-9'],
      ageMinMonths: 24,
      ageMaxMonths: 120,
      statusState: 'bookable_open',
    }),
    // ── cost.ts: the asymmetric free cells, stated again as first-class rows.
    makeListing({
      ...base,
      id: 'trap-cost-known-85',
      activityName: 'Fixture Priced Row',
      descriptionSnippet: `${CORPUS_TOKEN} a CONFIRMED price the Free filter must never return`,
      costStatus: 'known',
      costMinCad: 85,
      costMaxCad: 85,
      startDatetimeUtc: at(0, 10).toISOString(),
      endDatetimeUtc: at(0, 11).toISOString(),
      statusState: 'confirmed',
    }),
    makeListing({
      ...base,
      id: 'trap-cost-preseason-priced',
      // A known-priced row in the EXPECTED section: predicate.ts applies cost in both modes
      // precisely so this cannot arrive under the Free filter through the section next door.
      activityName: 'Fixture Preseason Priced Row',
      descriptionSnippet: `${CORPUS_TOKEN} priced seasonal row, expected section`,
      costStatus: 'known',
      costMinCad: 85,
      costMaxCad: 85,
      startDatetimeUtc: at(2, 10).toISOString(),
      endDatetimeUtc: at(2, 11).toISOString(),
      statusState: 'seasonal_preseason',
    }),
    makeListing({
      ...base,
      id: 'trap-cost-contradictory',
      activityName: 'Fixture Contradictory Bounds',
      descriptionSnippet: `${CORPUS_TOKEN} min > max — readCost must decline to state it`,
      costStatus: 'known',
      costMinCad: 7,
      costMaxCad: 0,
      startDatetimeUtc: at(0, 11).toISOString(),
      endDatetimeUtc: at(0, 12).toISOString(),
      statusState: 'confirmed',
    }),
    makeListing({
      ...base,
      id: 'trap-cost-negative',
      activityName: 'Fixture Negative Bound',
      descriptionSnippet: `${CORPUS_TOKEN} a negative bound is reachable through the admin form`,
      costStatus: 'known',
      costMinCad: -5,
      costMaxCad: -5,
      startDatetimeUtc: at(1, 11).toISOString(),
      endDatetimeUtc: at(1, 12).toISOString(),
      statusState: 'confirmed',
    }),
    // ── time.ts: open-hours rows belong to no single day and match every date filter.
    makeListing({
      ...base,
      id: 'trap-openhours-known',
      activityName: 'Fixture Aquarium',
      descriptionSnippet: `${CORPUS_TOKEN} open-hours with published local hours`,
      openHours: true,
      openHoursLocal: { startMin: 10 * 60, endMin: 17 * 60 },
      openHoursLabel: 'Daily 10:00 AM–5:00 PM',
      startDatetimeUtc: null,
      endDatetimeUtc: null,
      costStatus: 'known',
      costMinCad: 12,
      costMaxCad: 12,
      statusState: 'confirmed',
    }),
    makeListing({
      ...base,
      id: 'trap-openhours-unknown',
      activityName: 'Fixture Mini Train',
      descriptionSnippet: `${CORPUS_TOKEN} open-hours with NO published hours — never hidden`,
      openHours: true,
      openHoursLocal: null,
      startDatetimeUtc: null,
      endDatetimeUtc: null,
      costStatus: 'unknown',
      statusState: 'confirmed',
    }),
    // ── time.ts: an occurrence is a SPAN. This runs every day of the window, not just its first.
    makeListing({
      ...base,
      id: 'trap-multiday',
      activityName: 'Fixture Long Programme',
      descriptionSnippet: `${CORPUS_TOKEN} one row spanning many local days`,
      startDatetimeUtc: at(-5, 9).toISOString(),
      endDatetimeUtc: at(10, 17).toISOString(),
      ageBandMatches: ['5-9'],
      ageMinMonths: 60,
      ageMaxMonths: 120,
      statusState: 'confirmed',
    }),
    // ── time.ts: crosses local midnight, so its end minutes precede its start minutes.
    makeListing({
      ...base,
      id: 'trap-midnight',
      activityName: 'Fixture Late Night Watch',
      descriptionSnippet: `${CORPUS_TOKEN} 21:00 local to 00:30 the next local day`,
      startDatetimeUtc: at(0, 21).toISOString(),
      endDatetimeUtc: at(1, 0, 30).toISOString(),
      statusState: 'confirmed',
    }),
    // ── time.ts: THE HOURS THAT USED TO BELONG TO NO DAY-PART AT ALL.
    //
    // The generated body starts every row between 09:00 and 21:00 (START_HOURS), which is inside
    // the old 05:00–22:00 span — so the day-part invariants could not have caught the gap that
    // made an Evening search at 22:35 return nothing, because no row in the catalogue lived
    // there. These two rows put the catalogue where the defect was. They are traps, not extra
    // START_HOURS, deliberately: adding hours would reshuffle every generated row through
    // `i % START_HOURS.length` and change what a dozen unrelated invariants are sampling.
    makeListing({
      ...base,
      id: 'trap-late-night',
      activityName: 'Fixture Late Public Swim',
      descriptionSnippet: `${CORPUS_TOKEN} 22:30 local — inside the old 22:00–05:00 dead window`,
      startDatetimeUtc: at(0, 22, 30).toISOString(),
      endDatetimeUtc: at(0, 23, 30).toISOString(),
      statusState: 'confirmed',
    }),
    makeListing({
      ...base,
      id: 'trap-after-midnight',
      activityName: 'Fixture Midnight Skate',
      descriptionSnippet: `${CORPUS_TOKEN} 00:30 local — past midnight, still the evening day-part`,
      startDatetimeUtc: at(0, 0, 30).toISOString(),
      endDatetimeUtc: at(0, 1, 30).toISOString(),
      statusState: 'confirmed',
    }),
    // ── region.ts: a tag no hierarchy in this product knows. Must not be a filtering accident.
    makeListing({
      ...base,
      id: 'trap-foreign-region',
      activityName: 'Fixture Out Of Area',
      descriptionSnippet: `${CORPUS_TOKEN} tagged to a region id the hierarchy does not hold`,
      municipalityId: 'surrey',
      displayArea: null,
      geo: { lat: 49.1, lng: -122.8 },
      startDatetimeUtc: at(0, 13).toISOString(),
      endDatetimeUtc: at(0, 14).toISOString(),
      statusState: 'confirmed',
    }),
    // ── collapse.ts: four occurrences, one series, one local day → one card, four slots.
    ...[0, 1, 2, 3].map((n) =>
      makeListing({
        ...base,
        id: `trap-collapse-${n}`,
        seriesId: 'trap-collapse-series',
        activityName: 'Fixture Repeated Slot',
        descriptionSnippet: `${CORPUS_TOKEN} same series, same local day, slot ${'abcd'[n]}`,
        startDatetimeUtc: at(0, 9 + n * 2).toISOString(),
        endDatetimeUtc: at(0, 10 + n * 2).toISOString(),
        costStatus: n === 3 ? 'unknown' : 'free',
        ageBandMatches: ['2-4'],
        ageMinMonths: 24,
        ageMaxMonths: 60,
        statusState: 'confirmed',
      }),
    ),
    // ── collapse.ts, the RECURRING shape: one series, one occurrence on each of four local days.
    // This is the corpus's only cross-day group and it exists so the card-honesty invariant about
    // a multi-day card (it may state its DAYS, never a single time span) is asserted over
    // something rather than passing vacuously. A date-filtered query narrows it back to one day,
    // so both shapes of card get exercised by the same rows.
    ...[-1, 0, 1, 2].map((offset, n) =>
      makeListing({
        ...base,
        id: `trap-recurring-${n}`,
        seriesId: 'trap-recurring-series',
        activityName: 'Fixture Weekly Slot',
        descriptionSnippet: `${CORPUS_TOKEN} same series, day offset ${offset}`,
        startDatetimeUtc: at(offset, 10).toISOString(),
        endDatetimeUtc: at(offset, 11).toISOString(),
        costStatus: 'free',
        ageBandMatches: ['2-4'],
        ageMinMonths: 24,
        ageMaxMonths: 60,
        statusState: 'confirmed',
      }),
    ),
    // ── status.ts: the hidden class, present so "never shown" is a real assertion.
    makeListing({
      ...base,
      id: 'trap-suspended',
      activityName: 'Fixture Suspended Row',
      descriptionSnippet: `${CORPUS_TOKEN} suspended — never surfaced in any mode`,
      startDatetimeUtc: at(0, 10).toISOString(),
      endDatetimeUtc: at(0, 11).toISOString(),
      statusState: 'suspended',
    }),
  ];
}

/** A fixture-backed engine over a corpus. No aliases: text expansion is not what this suite tests. */
export function makeEngine(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: true,
  });
}
