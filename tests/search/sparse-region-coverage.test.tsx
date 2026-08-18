// tests/search/sparse-region-coverage.test.tsx — an area we barely cover must SAY SO, and an
// area we cover well must be untouched.
//
// THE DEFECT (independent test round, P0-1). West Vancouver and Burnaby hold effectively no
// listings (0 and 2), and /search presented them exactly like Vancouver: the same "Nothing
// matches … right now" empty state, the same offer to widen dates and ages, the same
// alternative-day chips. Every one of those sentences is true about a QUERY and none of them is
// why the page was empty, so 5 of 15 test parents followed the advice into a dead end.
//
// The fix is a measurement, not a filter: lib/search/coverage.ts counts distinct activities in a
// selected area over the WHOLE catalogue with no query constraint, so the number is a fact about
// our coverage rather than about one search. This file measures the whole chain the defect lived
// in — engine → derivation → rendered notice — because each of the three looked correct alone.
//
// HALF OF THIS FILE EXISTS TO KEEP THE OTHER HALF FROM BEING VACUOUS. A change that shouted
// "limited coverage" on every search would pass every assertion about the sparse case, so the
// well-covered case is asserted just as hard: same results, same total, same ordering, no notice
// anywhere in the markup.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { RegionHierarchy } from '@/lib/geo/region';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { assessRegionCoverage, SPARSE_REGION_MAX_ACTIVITIES } from '@/lib/search/coverage';
import { describeSparseCoverage } from '@/app/search/_lib/coverage-notice';
import { SparseCoverageNotice } from '@/app/search/_components/SparseCoverageNotice';
import type { ListingRecord } from '@/lib/search/types';

const NOW = new Date('2026-08-17T15:00:00Z'); // 08:00 local Monday — the day is wide open

/** One confirmed, free, drop-in swim today, in `municipalityId`. */
function swim(id: string, municipalityId: string, overrides: Partial<ListingRecord> = {}): ListingRecord {
  return makeListing({
    id,
    activityName: `Public Swim ${id}`,
    startDatetimeUtc: '2026-08-17T17:00:00.000Z',
    endDatetimeUtc: '2026-08-17T18:00:00.000Z',
    statusState: 'confirmed',
    costStatus: 'free',
    municipalityId,
    ...overrides,
  });
}

/**
 * The real shape of the problem: Vancouver covered, Burnaby down to two, West Vancouver empty.
 * (West Van needs no rows — its emptiness IS the fixture.)
 */
const CATALOGUE: ListingRecord[] = [
  ...Array.from({ length: 40 }, (_, i) => swim(`van-${i}`, 'van')),
  swim('bby-0', 'bby'),
  swim('bby-1', 'bby'),
];

function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: false,
  });
}

const engine = engineOver(CATALOGUE);
const searchIn = (regionChipIds: string[]) => engine.search({ q: '', regionChipIds, now: NOW, minResults: 3, limit: 60 });

describe('the engine measures how much of the catalogue an area actually holds', () => {
  it('reports an EMPTY area as sparse, with its real count of zero', () => {
    const res = searchIn(['wvan']);
    expect(res.regionCoverage).toEqual([
      { chipId: 'wvan', regionName: 'West Vancouver', activityCount: 0, sparse: true },
    ]);
  });

  it('reports a NEARLY empty area as sparse, with its real count', () => {
    const res = searchIn(['bby']);
    expect(res.regionCoverage).toEqual([{ chipId: 'bby', regionName: 'Burnaby', activityCount: 2, sparse: true }]);
  });

  it('reports a WELL-COVERED area as not sparse', () => {
    const res = searchIn(['van']);
    expect(res.regionCoverage).toEqual([{ chipId: 'van', regionName: 'Vancouver', activityCount: 40, sparse: false }]);
  });

  it('measures the AREA, not the query — a query that matches nothing in Vancouver still reports Vancouver as covered', () => {
    // The distinction the whole feature turns on. This search returns zero results, exactly like
    // the West Van search above, and the two are NOT the same event.
    const res = engine.search({ q: 'archery', regionChipIds: ['van'], now: NOW, minResults: 3, limit: 60 });
    expect(res.total).toBe(0);
    expect(res.regionCoverage[0]).toMatchObject({ regionName: 'Vancouver', sparse: false });
  });

  it('says nothing at all when no area is selected', () => {
    expect(engine.search({ q: '', now: NOW, minResults: 3, limit: 60 }).regionCoverage).toEqual([]);
  });

  it('IGNORES an area chip it cannot read, rather than calling it empty', () => {
    // Same rule as matchesRegion: a typo, a stale shared link or a renamed municipality must not
    // make the page announce that we have no data for an area we may cover perfectly well.
    expect(searchIn(['not-a-region']).regionCoverage).toEqual([]);
    // A recognised chip alongside an unreadable one is still reported.
    expect(searchIn(['not-a-region', 'bby']).regionCoverage).toHaveLength(1);
  });

  it('reports every selected area, so a multi-select can never lose one', () => {
    expect(searchIn(['wvan', 'bby']).regionCoverage.map((c) => c.chipId)).toEqual(['wvan', 'bby']);
  });
});

describe('what the coverage count counts', () => {
  const regions = new RegionHierarchy(REGIONS);

  it('counts distinct ACTIVITIES, not occurrences — one weekly programme is not a covered city', () => {
    // Twelve occurrences of ONE series. Counting rows would report Burnaby as comfortably
    // covered on the strength of a single drop-in swim.
    const twelveOfOne = Array.from({ length: 12 }, (_, i) => swim(`bby-w${i}`, 'bby', { seriesId: 'bby-weekly' }));
    const [coverage] = assessRegionCoverage(twelveOfOne, regions, ['bby']);
    expect(coverage.activityCount).toBe(1);
    expect(coverage.sparse).toBe(true);
  });

  it('rolls a sub-area up to its municipality, exactly as the area filter does', () => {
    const listings = [swim('e-1', 'van-east'), swim('w-1', 'van-westside')];
    expect(assessRegionCoverage(listings, regions, ['van'])[0].activityCount).toBe(2);
  });

  it('does not count listings no parent could ever be shown', () => {
    // Both are unconditional exclusions in filters/predicate.ts. Counting them would report
    // coverage a search can never deliver — the opposite of what this measurement is for.
    const unshowable = [
      swim('bby-x', 'bby', { statusState: 'cancelled' }),
      swim('bby-y', 'bby', { activityName: 'Adults Only Lane Swim' }),
    ];
    expect(assessRegionCoverage(unshowable, regions, ['bby'])[0].activityCount).toBe(0);
  });

  it('puts the sparse/covered boundary exactly where the constant says', () => {
    const build = (n: number) => Array.from({ length: n }, (_, i) => swim(`bby-${i}`, 'bby'));
    const at = assessRegionCoverage(build(SPARSE_REGION_MAX_ACTIVITIES), regions, ['bby'])[0];
    const over = assessRegionCoverage(build(SPARSE_REGION_MAX_ACTIVITIES + 1), regions, ['bby'])[0];
    expect(at.sparse).toBe(true);
    expect(over.sparse).toBe(false);
  });
});

describe('the notice a parent actually reads', () => {
  it('names the area and states we hold nothing, for an empty one', () => {
    const notice = describeSparseCoverage(searchIn(['wvan']).regionCoverage);
    expect(notice).not.toBeNull();
    expect(notice!.lede).toBe('Limited coverage in West Vancouver.');
    expect(notice!.body).toContain('nothing listed in West Vancouver yet');
    // It must never dress a coverage gap up as a quiet week — that is the sentence the old empty
    // state effectively made, and it is the one thing this notice exists to contradict.
    expect(notice!.body).toContain('not a quiet week');
    expect(notice!.regions).toEqual([{ chipId: 'wvan', regionName: 'West Vancouver' }]);
  });

  it('states the REAL number for a nearly-empty one', () => {
    const notice = describeSparseCoverage(searchIn(['bby']).regionCoverage);
    expect(notice!.lede).toBe('Limited coverage in Burnaby.');
    expect(notice!.body).toContain('just 2 activities in Burnaby');
  });

  it('names every sparse area when several are selected', () => {
    const notice = describeSparseCoverage(searchIn(['wvan', 'bby']).regionCoverage);
    expect(notice!.lede).toBe('Limited coverage in West Vancouver and Burnaby.');
    expect(notice!.regions.map((r) => r.chipId)).toEqual(['wvan', 'bby']);
  });

  it('names ONLY the sparse area when a covered one is selected alongside it', () => {
    const notice = describeSparseCoverage(searchIn(['van', 'wvan']).regionCoverage);
    expect(notice!.lede).toBe('Limited coverage in West Vancouver.');
    expect(notice!.regions.map((r) => r.chipId)).toEqual(['wvan']);
  });

  it('says nothing for a covered area, for no area, and for a response that has no coverage field', () => {
    expect(describeSparseCoverage(searchIn(['van']).regionCoverage)).toBeNull();
    expect(describeSparseCoverage([])).toBeNull();
    expect(describeSparseCoverage(undefined)).toBeNull();
    expect(describeSparseCoverage(null)).toBeNull();
  });
});

describe('the rendered state: honest message + a way to be told', () => {
  const render = (chipIds: string[]) =>
    renderToStaticMarkup(<SparseCoverageNotice coverage={searchIn(chipIds).regionCoverage} />);

  it('a sparse-area search renders the limited-coverage message AND the capture form', () => {
    const html = render(['bby']);
    expect(html).toContain('Limited coverage in Burnaby.');
    expect(html).toContain('just 2 activities in Burnaby');
    // The capture: a real, labelled email field and a real submit control.
    expect(html).toContain('Email me when Burnaby is live');
    expect(html).toContain('type="email"');
    expect(html).toContain('name="email"');
    expect(html).toContain('Notify me');
    // The label is wired to the field it labels (the whole control is useless to a screen
    // reader otherwise).
    const id = html.match(/for="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    // Announced after the filter navigation, like the sibling notices.
    expect(html).toContain('role="status"');
  });

  it('an EMPTY area renders it too — zero listings is the strongest case for saying so', () => {
    const html = render(['wvan']);
    expect(html).toContain('Limited coverage in West Vancouver.');
    expect(html).toContain('Email me when West Vancouver is live');
  });

  it('a multi-area selection captures for BOTH areas, never silently one', () => {
    expect(render(['wvan', 'bby'])).toContain('Email me when West Vancouver and Burnaby is live');
  });

  it('a WELL-COVERED area renders absolutely nothing', () => {
    expect(render(['van'])).toBe('');
    expect(renderToStaticMarkup(<SparseCoverageNotice coverage={[]} />)).toBe('');
    expect(renderToStaticMarkup(<SparseCoverageNotice coverage={undefined} />)).toBe('');
  });
});

describe('a well-covered search is completely unaffected', () => {
  it('returns the same results, in the same order, with and without an area chip that we cover', () => {
    // The guard against a "fix" that quietly changed what search returns. Coverage is a
    // measurement bolted onto the response; it must not touch a single listing.
    const withChip = searchIn(['van']);
    const unchipped = engine.search({ q: '', now: NOW, minResults: 3, limit: 60 });

    expect(withChip.total).toBe(40);
    expect(withChip.results.map((r) => r.listing.id)).toEqual(
      unchipped.results.filter((r) => r.listing.municipalityId === 'van').map((r) => r.listing.id),
    );
    // Nothing was broadened, and no constraint was reported as blocking, on a full page.
    expect(withChip.broadening.applied).toEqual([]);
    expect(withChip.broadening.emptyState).toBeNull();
  });

  it('leaves the SPARSE area\'s own listings reachable — this explains a thin page, it does not empty one', () => {
    // Burnaby's two listings are still returned. The notice sits above a real (if short) result
    // set; suppressing them would be a worse defect than the one being fixed.
    const res = searchIn(['bby']);
    expect(res.total).toBe(2);
    expect(res.results.map((r) => r.listing.id).sort()).toEqual(['bby-0', 'bby-1']);
  });
});
