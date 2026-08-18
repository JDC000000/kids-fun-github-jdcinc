// tests/search/empty-state-names-region-chip.test.ts — the area filter must be nameable.
//
// QA cycle finding P9: the empty state claimed "Relaxing any single filter adds nothing" in a
// case where dropping one filter would have added sixty results.
//
// THE CAUSE WAS STRUCTURAL, not a wording bug. Every narrowing filter the explanation can name
// is a field on `SearchContext`, so `activeConstraints` enumerated them by reading that type.
// Region chips are the single exception: they travel beside the context as a separate
// `regionChipIds` argument, all the way down to filters/predicate.ts. So a parent filtered to
// Vancouver, with sixty Burnaby listings sitting behind the chip, was told the truth had run out
// — "No activities found", or with any second filter on, that no relaxation would help — while
// clearing the area chip alone would have shown all sixty.
//
// Measured here against the real engine, not the pure function alone: the defect lived in the
// SEAM between the two, and the probe signature is the thing that changed.

import { describe, expect, it } from 'vitest';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { RegionHierarchy } from '@/lib/geo/region';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { activeConstraints, buildBroadeningLadder, relaxSingle, type ConstraintKey } from '@/lib/search/broaden';
import type { ListingRecord, SearchContext } from '@/lib/search/types';

const NOW = new Date('2026-08-17T15:00:00Z'); // 08:00 local Monday — the day is wide open

/** Sixty drop-in swims, all of them in Burnaby. */
const BURNABY_CATALOGUE: ListingRecord[] = Array.from({ length: 60 }, (_, i) =>
  makeListing({
    id: `bby-${i}`,
    activityName: `Public Swim ${i}`,
    startDatetimeUtc: '2026-08-17T17:00:00.000Z',
    endDatetimeUtc: '2026-08-17T18:00:00.000Z',
    statusState: 'confirmed',
    costStatus: 'free',
    municipalityId: 'bby',
  }),
);

function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: false,
  });
}

describe('the empty state names the area filter when the area filter is what emptied it', () => {
  it('reports the area filter and the real number it would add', () => {
    const engine = engineOver(BURNABY_CATALOGUE);
    const res = engine.search({ q: '', regionChipIds: ['van'], now: NOW, minResults: 3, limit: 60 });

    expect(res.total).toBe(0);
    expect(res.broadening.emptyState?.blockingConstraint).toBe<ConstraintKey>('region');
    expect(res.broadening.emptyState?.message).toContain('area filter');
    // The count is the REAL one — the same search without the chip returns exactly this many.
    expect(res.broadening.emptyState?.message).toContain('60 more');
    expect(engine.search({ q: '', now: NOW, minResults: 3, limit: 60 }).total).toBe(60);
  });

  // The regression in its original words. This is the sentence P9 caught, and it must not be
  // reachable while an area chip alone would unblock the search.
  it('never says "relaxing any single filter adds nothing" when clearing the area chip would', () => {
    const res = engineOver(BURNABY_CATALOGUE).search({
      q: '',
      regionChipIds: ['van'],
      // A second, genuinely useless constraint — this is what used to push the message into the
      // "nothing helps" branch instead of the "no constraints at all" one.
      free: true,
      now: NOW,
      minResults: 3,
      limit: 60,
    });
    expect(res.broadening.emptyState?.message).not.toContain('adds nothing');
    expect(res.broadening.emptyState?.blockingConstraint).toBe<ConstraintKey>('region');
  });

  it('does not name the area filter when a different filter is the one blocking', () => {
    // Everything is in Vancouver, so the area chip matches; the age filter is what empties it.
    const vancouver = BURNABY_CATALOGUE.map((l) => ({ ...l, municipalityId: 'van', ageBandMatches: ['5-9' as const] }));
    const res = engineOver(vancouver).search({
      q: '',
      regionChipIds: ['van'],
      ageBands: ['under2'],
      now: NOW,
      minResults: 3,
      limit: 60,
    });
    expect(res.total).toBe(0);
    expect(res.broadening.emptyState?.blockingConstraint).toBe<ConstraintKey>('ageBands');
  });

  it('leaves an unfiltered-by-area search exactly as it was', () => {
    const res = engineOver(BURNABY_CATALOGUE).search({ q: '', free: true, now: NOW, minResults: 3, limit: 60 });
    expect(res.total).toBe(60);
    expect(res.broadening.emptyState).toBeNull();
  });
});

describe('the region constraint is wired consistently into the constraint vocabulary', () => {
  const bareCtx = (): SearchContext => ({
    raw: '',
    terms: [],
    date: null,
    timeOfDay: null,
    ageBands: [],
    radiusKm: 20,
    nearMe: false,
    costFree: false,
    includeRegistration: false,
    bookableNow: false,
    rainyDay: false,
    dropIn: false,
    sort: 'best_match',
  });

  it('is active only when chips are actually applied', () => {
    expect(activeConstraints(bareCtx(), { regionChipIds: ['van'] })).toContain<ConstraintKey>('region');
    expect(activeConstraints(bareCtx(), { regionChipIds: [] })).not.toContain<ConstraintKey>('region');
    expect(activeConstraints(bareCtx())).not.toContain<ConstraintKey>('region');
  });

  // `relaxSingle` deliberately cannot relax it: region chips are not on the context. Pinning the
  // no-op stops a future reader "fixing" the switch by inventing a context field for them.
  it('is a no-op in relaxSingle, because there is nothing on the context to relax', () => {
    const ctx = bareCtx();
    expect(relaxSingle(ctx, 'region')).toBe(ctx);
  });

  // THE TRAP THIS CLOSES. Explaining a constraint and ACTING on it are different permissions, and
  // `region` now has the first without the second. Adding it to CHIP_RESTRICTIVENESS would look
  // like a natural completion of this change and would be strictly worse than doing nothing: the
  // rung would fire, announce "Dropped the area filter", and — because relaxSingle cannot touch
  // the chips — change not one result. A notice that reports a widen which did not happen is the
  // exact failure mode this module's own header spends three paragraphs warning about.
  it('is never emitted as a ladder rung — the ladder cannot actually drop it', () => {
    const withChips = { ...bareCtx(), bookableNow: true };
    const rungs = buildBroadeningLadder(withChips, { regionChipIds: ['van'] });
    expect(rungs.some((r) => r.constraint === 'region')).toBe(false);
    // The chip rung that IS droppable still fires, so this is a targeted exclusion, not a
    // ladder that quietly stopped working.
    expect(rungs.some((r) => r.key === 'drop_chip' && r.constraint === 'bookableNow')).toBe(true);
  });
});
