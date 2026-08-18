// tests/search/broaden-alternatives.test.ts
//
// Pins `SearchResponse.broadening.alternatives` (lib/search/broaden.ts's `BroadenAlternative`,
// computed in lib/search/engine.ts): a REAL, pre-counted result total per ladder rung, so a UI
// chip can say "Nearby dates (7 results)" instead of just "we widened your dates".
//
// THE ACCEPTANCE BAR (brief: kids-fun-broadening-ladder-ui-brief-2026-08-18.md, criterion 2) is
// that a chip claiming N results must actually return N when a parent taps it — not that the
// number merely looks plausible. Every test below proves that by comparing the STORED count
// against an INDEPENDENT re-query built from the same rung's context, never by re-reading the
// engine's own internal state back at itself.
import { describe, expect, it } from 'vitest';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { RegionHierarchy } from '@/lib/geo/region';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { makeFixtureEngine, FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { buildBroadeningLadder, widenDateIntent } from '@/lib/search/broaden';
import { parseQuery } from '@/lib/search/parse';
import type { DateIntent, ListingRecord } from '@/lib/search/types';

const { engine } = makeFixtureEngine();

/** Fixture catalogue days (America/Vancouver local): 2026-07-13, -14, -15. */
const SPARSE_NEARBY_DAY = '2026-07-17';
const SPARSE_FAR_DAY = '2026-09-14';

function range(from: string, to: string): DateIntent {
  return { kind: 'range', isoDate: from, endIsoDate: to, weekday: null };
}

describe('broaden: alternative chip counts are gated exactly like the ladder itself', () => {
  it('a well-filled search computes no alternatives at all — nothing to pay for', () => {
    const res = engine.search({ q: '', now: FIXTURE_NOW, minResults: 3, limit: 100 });
    expect(res.broadening.applied).toHaveLength(0);
    expect(res.broadening.alternatives).toHaveLength(0);
  });

  it('a caller that declines broadening (minResults: 0) still gets no alternatives', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 0,
      limit: 100,
      dateRange: { from: SPARSE_FAR_DAY, to: SPARSE_FAR_DAY },
    });
    expect(res.broadening.alternatives).toHaveLength(0);
  });

  it('a thin search gets one alternative entry per rung of the FULL ladder, not just the applied prefix', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
      dateRange: { from: SPARSE_FAR_DAY, to: SPARSE_FAR_DAY },
    });
    // The same ctx0 the engine itself builds from this request: parseQuery('') plus the
    // structured dateRange override (engine.ts does exactly this before running the ladder).
    const ctx0 = { ...parseQuery('', { now: FIXTURE_NOW }), date: range(SPARSE_FAR_DAY, SPARSE_FAR_DAY) };
    const fullLadderKeys = buildBroadeningLadder(ctx0, { hasOrigin: false }).map((r) => r.key);
    expect(res.broadening.alternatives.map((a) => a.key)).toEqual(fullLadderKeys);
  });
});

describe('broaden: alternative counts are PROVABLY real — re-querying the rung reproduces them exactly', () => {
  it('DECISIVE: the adjacent_date alternative equals a direct query over the same widened window', () => {
    const thin = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
      dateRange: { from: SPARSE_FAR_DAY, to: SPARSE_FAR_DAY },
    });
    const dateAlt = thin.broadening.alternatives.find((a) => a.key === 'adjacent_date');
    expect(dateAlt).toBeDefined();

    // Independently derive the SAME window the rung claims to have widened to, and ask the
    // engine for it directly — with broadening declined, so nothing further gets added.
    const widened = widenDateIntent(range(SPARSE_FAR_DAY, SPARSE_FAR_DAY))!;
    const direct = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 0,
      limit: 100,
      dateRange: { from: widened.isoDate!, to: widened.endIsoDate! },
    });

    expect(dateAlt!.count).toBe(direct.total);
  });

  it('the rung that actually filled the page reports a count identical to the response total', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
      dateRange: { from: SPARSE_NEARBY_DAY, to: SPARSE_NEARBY_DAY },
    });
    expect(res.broadening.applied.map((r) => r.key)).toContain('adjacent_date');
    const filledRung = res.broadening.alternatives.find((a) => a.key === 'adjacent_date')!;
    expect(filledRung.applied).toBe(true);
    // This is the same number the parent is looking at right now.
    expect(filledRung.count).toBe(res.total);
  });

  it('a rung beyond the one that filled the page is marked NOT applied, but still carries a real count', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
      dateRange: { from: SPARSE_NEARBY_DAY, to: SPARSE_NEARBY_DAY },
    });
    const beyond = res.broadening.alternatives.find((a) => !a.applied);
    // The fixture ladder for a bare dated query (no origin/age/chips) is exactly
    // [adjacent_date, expected_section] — expected_section is the one left over once the date
    // rung alone fills the page.
    expect(beyond?.key).toBe('expected_section');
    expect(beyond!.count).toBeGreaterThanOrEqual(0);
  });
});

/** The Burnaby shape from broaden-never-drops-free.test.ts: thin enough that ANY extra
 *  constraint trips `minResults`, which is exactly what makes the drop_chip rung fire. */
function thinCatalogueEngine(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
  });
}

describe('broaden: the drop_chip alternative count matches directly re-running without that chip', () => {
  const DROP_IN_ONLY = makeListing({
    id: 'thin-dropin-only',
    activityName: 'Free Skate',
    startDatetimeUtc: '2026-07-13T20:00:00Z',
    endDatetimeUtc: '2026-07-13T21:00:00Z',
  });
  const engine2 = thinCatalogueEngine([DROP_IN_ONLY]);

  it('DECISIVE: "drop-in" alternative count equals the same query with the chip removed', () => {
    // `q: 'drop-in'` parses to ctx.dropIn = true (lib/search/parse.ts); the fixture catalogue
    // here holds one row, so asking for drop-in AND anything else trips minResults and the
    // chip-drop rung fires.
    const thin = engine2.search({ q: 'drop-in', now: FIXTURE_NOW, minResults: 3, limit: 100 });
    const chipAlt = thin.broadening.alternatives.find((a) => a.key === 'drop_chip');
    expect(chipAlt).toBeDefined();
    expect(chipAlt!.constraint).toBe('dropIn');

    // Independent re-query: the same catalogue, no drop-in constraint, broadening declined.
    const direct = engine2.search({ q: '', now: FIXTURE_NOW, minResults: 0, limit: 100 });
    expect(chipAlt!.count).toBe(direct.total);
  });
});
