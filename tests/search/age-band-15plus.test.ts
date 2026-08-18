// tests/search/age-band-15plus.test.ts — the 15+ age band, end to end.
//
// WHAT THIS PINS AND WHY IT IS ITS OWN FILE. `15+` has always existed in the DATA — the
// `AgeBandKey` union, `AGE_BAND_ORDER`, the facet counts, and the seeded `age_band` row
// (180 months → NULL). What it did not have was a chip: it was removed from the parent-facing
// rail on Jon's beta feedback and reinstated on 2026-08-18 ("Let's add for 15 plus kids as
// well"). A band that is selectable in one layer and absent from another is exactly the defect
// that produced the gap in the first place, so the assertions here run ACROSS the layers rather
// than inside any one of them: the seed, the band-membership computation, the filter predicates,
// the chip vocabulary, and a real search.
//
// THE SECOND HALF IS THE MORE IMPORTANT ONE. The ruling was ADDITIVE — 10-14 and every other
// band keep behaving exactly as they did. An added chip can only ever be a new way to NARROW, so
// the property that must hold is monotonicity: adding `15+` to a selection never takes a listing
// away from it. That is asserted over the whole shared fixture catalogue, not over a hand-picked
// example, because a hand-picked example is precisely what would miss a regression here.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AGE_BAND_ORDER, adjacentAgeBands, hasConfirmedAgeMatch, matchesAge } from '../../lib/search/filters/age';
import { computeAgeBandMatches, type AgeBandRow } from '../../worker/core/age';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import { FIXTURE_LISTINGS } from '../../lib/search/__fixtures__/listings';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { RegionHierarchy } from '../../lib/geo/region';
import { AGE_ORDER, AGE_OPTIONS } from '../../app/search/_lib/params';
import type { AgeBandKey, ListingRecord } from '../../lib/search/types';

/**
 * The seeded taxonomy, in the shape `computeAgeBandMatches` reads. Mirrors
 * supabase/seeds/age_bands.sql — and the first test below proves it still does, rather than
 * leaving this literal free to drift away from the database it claims to represent.
 */
const BANDS: AgeBandRow[] = [
  { id: 'under2', key: 'under2', lowerMonthsInclusive: 0, upperMonthsExclusive: 24 },
  { id: '2-4', key: '2-4', lowerMonthsInclusive: 24, upperMonthsExclusive: 60 },
  { id: '5-9', key: '5-9', lowerMonthsInclusive: 60, upperMonthsExclusive: 120 },
  { id: '10-14', key: '10-14', lowerMonthsInclusive: 120, upperMonthsExclusive: 180 },
  { id: '15+', key: '15+', lowerMonthsInclusive: 180, upperMonthsExclusive: null },
];

const YEARS = 12;

describe('15+ — one taxonomy, agreed by every layer', () => {
  it('the seed still says what this file assumes: five contiguous bands, 15+ open-ended and last', () => {
    // Read rather than restated. The band's UPPER BOUND is the one modelling decision this
    // change had to make (open-ended, no ceiling), and it is made in the seed — so the seed is
    // what gets asserted. 15+ is the ONLY open-ended band, which is right for the top of an
    // ordered scale and would be a bug anywhere else: a NULL upper bound in the middle would
    // make that band swallow every band above it.
    const sql = readFileSync(resolve(__dirname, '../../supabase/seeds/age_bands.sql'), 'utf8');
    const rows = [...sql.matchAll(/\('([^']+)',\s*(\d+),\s*(\d+|NULL)\)/g)].map((m) => ({
      key: m[1],
      lower: Number(m[2]),
      upper: m[3] === 'NULL' ? null : Number(m[3]),
    }));
    expect(rows.map((r) => r.key)).toEqual(AGE_BAND_ORDER);
    expect(rows.map((r) => [r.lower, r.upper])).toEqual(BANDS.map((b) => [b.lowerMonthsInclusive, b.upperMonthsExclusive]));
    // Contiguous and non-overlapping: each band starts exactly where the previous one ended.
    for (let i = 1; i < rows.length; i += 1) expect(rows[i].lower).toBe(rows[i - 1].upper);
    expect(rows.filter((r) => r.upper === null).map((r) => r.key)).toEqual(['15+']);
  });

  it('the chip vocabulary and the adjacency ordering are the same list, in the same order', () => {
    // The drift this guards is the exact one being fixed: AGE_ORDER (what the rail offers, and
    // what /api/search validates `age=` against) fell out of step with AGE_BAND_ORDER (what the
    // data holds and what the broadening ladder walks). Equality in ORDER, not just membership —
    // both lists are used as canonical sort orders, so a reshuffle is as wrong as an omission.
    expect(AGE_ORDER).toEqual(AGE_BAND_ORDER);
    expect(AGE_OPTIONS.map((o) => o.key)).toEqual(['under2', '2-4', '5-9', '10-14', '15+']);
  });

  it('15+ is adjacent to 10-14 and to nothing else', () => {
    // The broadening ladder's `adjacent_age` rung reads neighbours off AGE_BAND_ORDER. With 15+
    // at the top, widening from it can only reach downward — a parent asking for a 15-year-old
    // must never be widened into preschool.
    expect(adjacentAgeBands(['15+'])).toEqual(['10-14', '15+']);
    expect(adjacentAgeBands(['10-14'])).toEqual(['5-9', '10-14', '15+']);
    expect(adjacentAgeBands(['5-9'])).not.toContain('15+');
  });
});

describe('15+ — band membership is computed, not merely listed', () => {
  const bandsFor = (minYears: number | null, maxYearsExcl: number | null) =>
    computeAgeBandMatches(
      { ageMinMonths: minYears === null ? null : minYears * YEARS, ageMaxMonths: maxYearsExcl === null ? null : maxYearsExcl * YEARS },
      BANDS,
    );

  it('an open-ended teen range lands in 15+', () => {
    expect(bandsFor(15, null)).toEqual(['15+']);
    expect(bandsFor(16, null)).toEqual(['15+']);
  });

  it('a bounded teen range lands in 15+ without an artificial ceiling of its own', () => {
    // "ages 15-18" — the upper bound is the SOURCE's, and it still resolves to the one open band.
    expect(bandsFor(15, 19)).toEqual(['15+']);
  });

  it('the boundary is exact at 180 months — 14 is not 15', () => {
    expect(bandsFor(null, 15)).toEqual(['under2', '2-4', '5-9', '10-14']);
    // 10y = 120 months is the INCLUSIVE lower edge of 10-14 and the EXCLUSIVE upper edge of
    // 5-9, so a 10-to-under-15 range touches one band, not two. Bounds are half-open on both
    // ends; that is the same rule that makes 15+ start cleanly at 180 rather than overlapping.
    expect(bandsFor(10, 15)).toEqual(['10-14']);
    // …and one month over it is.
    expect(computeAgeBandMatches({ ageMinMonths: 179, ageMaxMonths: 181 }, BANDS)).toEqual(['10-14', '15+']);
  });

  it('a span that reaches the top claims 15+ alongside the bands below it, not instead of them', () => {
    expect(bandsFor(0, null)).toEqual(['under2', '2-4', '5-9', '10-14', '15+']);
    expect(bandsFor(5, null)).toEqual(['5-9', '10-14', '15+']);
  });
});

describe('15+ — the filter predicates', () => {
  /** Teen-only programming: the listing the rail had no way to ask for. */
  const teenOnly = makeListing({
    id: 'teen-only',
    activityName: 'Teen Night Drop-In Basketball',
    primaryCategoryKey: 'sports',
    ageBandMatches: ['15+'],
    ageMinMonths: 15 * YEARS,
    ageMaxMonths: null,
    startDatetimeUtc: '2026-08-08T02:00:00Z',
    endDatetimeUtc: '2026-08-08T04:00:00Z',
  });

  const tweenOnly = makeListing({
    id: 'tween-only',
    activityName: 'Tween Drop-In Basketball',
    primaryCategoryKey: 'sports',
    ageBandMatches: ['10-14'],
    ageMinMonths: 10 * YEARS,
    ageMaxMonths: 15 * YEARS,
    startDatetimeUtc: '2026-08-08T02:00:00Z',
    endDatetimeUtc: '2026-08-08T04:00:00Z',
  });

  it('a 15+ selection matches teen programming, and confirms it', () => {
    expect(matchesAge(teenOnly, ['15+'])).toBe(true);
    expect(hasConfirmedAgeMatch(teenOnly, ['15+'])).toBe(true);
  });

  it('a 15+ selection does not confirm a 10-14 listing, and 10-14 does not confirm a teen one', () => {
    // The two neighbouring bands stay genuinely distinct — the new chip must narrow, not blur.
    expect(hasConfirmedAgeMatch(tweenOnly, ['15+'])).toBe(false);
    expect(hasConfirmedAgeMatch(teenOnly, ['10-14'])).toBe(false);
  });

  it('an age-unstated listing is still admitted under 15+, and still not confirmed by it', () => {
    // The standing "unknown → don't hide" ruling (lib/search/filters/age.ts) applies to the new
    // band exactly as it does to the other four. Nothing about 15+ is special-cased.
    const unstated = makeListing({ id: 'unstated', ageBandMatches: [], ageMinMonths: null, ageMaxMonths: null });
    expect(matchesAge(unstated, ['15+'])).toBe(true);
    expect(hasConfirmedAgeMatch(unstated, ['15+'])).toBe(false);
  });
});

describe('15+ is PURELY ADDITIVE — the other four bands are untouched', () => {
  /** Every listing the shared fixture catalogue holds, plus a teen-only one it does not. */
  const corpus: ListingRecord[] = [
    ...FIXTURE_LISTINGS,
    makeListing({ id: 'teen-corpus', ageBandMatches: ['15+'], ageMinMonths: 15 * YEARS, ageMaxMonths: null }),
  ];

  const matching = (bands: AgeBandKey[]) => corpus.filter((l) => matchesAge(l, bands)).map((l) => l.id).sort();
  const confirmed = (bands: AgeBandKey[]) => corpus.filter((l) => hasConfirmedAgeMatch(l, bands)).map((l) => l.id).sort();

  it('every existing band matches exactly the listings it always did — the new band is not in the answer', () => {
    // Recomputed from `ageBandMatches`, which no part of this change touched. The point of
    // asserting per-band sets rather than counts is that a set names the listing that moved.
    for (const band of ['under2', '2-4', '5-9', '10-14'] as AgeBandKey[]) {
      const ids = confirmed([band]);
      expect(ids, `band ${band} confirmed set`).toEqual(
        corpus.filter((l) => l.ageBandMatches.includes(band)).map((l) => l.id).sort(),
      );
      // The teen-only listing is confirmed by NO existing band.
      expect(ids).not.toContain('teen-corpus');
    }
  });

  it('MONOTONIC: adding 15+ to any selection never removes a listing from it', () => {
    // This is the ruling ("purely additive") stated as a property, checked over every selection
    // of the existing bands rather than over an example. A narrowing filter that took something
    // away when a band was ADDED would be the one way this change could regress the product.
    const existing: AgeBandKey[] = ['under2', '2-4', '5-9', '10-14'];
    const subsets: AgeBandKey[][] = [];
    for (let mask = 1; mask < 1 << existing.length; mask += 1) {
      subsets.push(existing.filter((_, i) => mask & (1 << i)));
    }
    for (const subset of subsets) {
      const before = matching(subset);
      const after = matching([...subset, '15+']);
      for (const id of before) expect(after, `selection ${subset.join('+')} lost ${id} when 15+ was added`).toContain(id);
      expect(after).toContain('teen-corpus');
      expect(before).not.toContain('teen-corpus');
    }
  });
});

describe('15+ — a real search returns teen programming', () => {
  const NOW = new Date('2026-08-08T18:00:00Z');

  const teen = makeListing({
    id: 'teen-search',
    activityName: 'Teen Drop-In Swim',
    primaryCategoryKey: 'public_swim',
    ageBandMatches: ['15+'],
    ageMinMonths: 15 * YEARS,
    ageMaxMonths: null,
    startDatetimeUtc: '2026-08-08T20:30:00Z',
    endDatetimeUtc: '2026-08-08T23:00:00Z',
  });
  const tot = makeListing({
    id: 'tot-search',
    activityName: 'Parent and Tot Swim',
    primaryCategoryKey: 'public_swim',
    ageBandMatches: ['2-4'],
    ageMinMonths: 2 * YEARS,
    ageMaxMonths: 5 * YEARS,
    startDatetimeUtc: '2026-08-08T20:30:00Z',
    endDatetimeUtc: '2026-08-08T23:00:00Z',
  });

  const engine = new SearchEngine({
    repository: new InMemoryListingRepository([teen, tot]),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: true,
  });

  /** minResults: 0 declines the broadening ladder, so each assertion sees the raw filtered set. */
  const run = (ageBands: AgeBandKey[]) =>
    engine.search({ q: 'swim', now: NOW, minResults: 0, ageBands }).results.map((r) => r.listing.id);

  it('the structured age=15+ request reaches the teen listing and only it', () => {
    expect(run(['15+'])).toEqual(['teen-search']);
  });

  it('the 2-4 request is unchanged by the new band existing', () => {
    expect(run(['2-4'])).toEqual(['tot-search']);
  });

  it('the phrase a 15+ chip composes into `q` resolves to the same result', () => {
    // The chip sends BOTH halves during Stage 2a (app/search/_lib/params.ts apiQuery): the typed
    // `age=` param above, and the parent-language phrase composed into `q`. Both must land here.
    expect(engine.search({ q: 'teen swim', now: NOW, minResults: 0 }).results.map((r) => r.listing.id)).toEqual([
      'teen-search',
    ]);
  });
});
