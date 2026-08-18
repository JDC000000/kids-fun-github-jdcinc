// The "age not stated by source" section — Jon's ruling 2026-08-18, option (b).
//
// THE RESIDUAL THIS CLOSES. `matchesAge` admits a listing with NO derived age bands under EVERY
// age filter ("all-ages / unknown → don't hide", lib/search/filters/age.ts). That rule is correct
// and is NOT under test here — an honestly-unknown age is not grounds for hiding a listing, and
// the option (a) alternative (invert the default and exclude them) was explicitly rejected. What
// WAS wrong is what happened after the admission: those listings were mixed into the confirmed
// result list and ranked beside genuine matches, so a page headed "results for ages 2–4" carried
// listings nobody had ever established were for 2–4s.
//
// The fix is a SECTION, not a filter. So every assertion below is about WHERE a listing lands and
// never about whether it survives — and the reachability tests are written to fail loudly if the
// split ever starts deleting instead of separating.

import { describe, expect, it } from 'vitest';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { RegionHierarchy } from '../../lib/geo/region';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import { hasConfirmedAgeMatch, matchesAge } from '../../lib/search/filters/age';
import { scoreListing } from '../../lib/search/rank';
import type { ListingRecord } from '../../lib/search/types';

const NOW = new Date('2026-08-08T18:00:00Z');

function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: true,
  });
}

/** minResults: 0 declines the broadening ladder, so each test observes the raw filtered set. */
const search = (engine: SearchEngine, extra: Record<string, unknown> = {}) =>
  engine.search({ q: 'swim', now: NOW, minResults: 0, ...extra });

const ids = (items: Array<{ listing: { id: string } }>) => items.map((i) => i.listing.id);

/** Confirmed for 2–4: the source stated an age and it covers the band. */
const banded = makeListing({
  id: 'banded',
  activityName: 'Parent and Tot Public Swim',
  primaryCategoryKey: 'public_swim',
  ageBandMatches: ['2-4'],
  ageMinMonths: 24,
  ageMaxMonths: 60,
  startDatetimeUtc: '2026-08-08T20:30:00Z',
  endDatetimeUtc: '2026-08-08T23:00:00Z',
});

/** The residual case: admitted by the "unknown → don't hide" rule, confirmed by nothing. */
const unstated = makeListing({
  id: 'unstated',
  activityName: 'Community Public Swim Session',
  primaryCategoryKey: 'public_swim',
  ageBandMatches: [],
  ageMinMonths: null,
  ageMaxMonths: null,
  startDatetimeUtc: '2026-08-08T21:00:00Z',
  endDatetimeUtc: '2026-08-08T22:00:00Z',
});

/** Stated, and genuinely for a different age — the filter's ordinary job. */
const teen = makeListing({
  id: 'teen',
  activityName: 'Teen Night Public Swim',
  primaryCategoryKey: 'public_swim',
  ageBandMatches: ['10-14'],
  ageMinMonths: 120,
  ageMaxMonths: 180,
  startDatetimeUtc: '2026-08-08T21:30:00Z',
  endDatetimeUtc: '2026-08-08T22:30:00Z',
});

describe('the age predicates: one for inclusion, one for sectioning', () => {
  it('matchesAge is UNCHANGED — an unstated age is still admitted under every filter', () => {
    // Pinned deliberately. The section split must never be "fixed" by inverting this default;
    // that is option (a) and it was ruled out.
    expect(matchesAge(unstated, ['2-4'])).toBe(true);
    expect(matchesAge(unstated, ['under2', '10-14'])).toBe(true);
    expect(matchesAge(unstated, [])).toBe(true);
  });

  it('hasConfirmedAgeMatch is the POSITIVE half — it separates a real match from a mere admission', () => {
    expect(hasConfirmedAgeMatch(banded, ['2-4'])).toBe(true);
    expect(hasConfirmedAgeMatch(banded, ['5-9'])).toBe(false);
    expect(hasConfirmedAgeMatch(unstated, ['2-4'])).toBe(false);
    // With no selection there is no claim to confirm — the engine never asks in this state.
    expect(hasConfirmedAgeMatch(banded, [])).toBe(false);
  });
});

describe('the primary list splits only when an age filter is active', () => {
  const engine = engineOver([banded, unstated, teen]);

  it('with NO age filter, everything stays in results and the section is empty', () => {
    const res = search(engine);
    expect(ids(res.results).sort()).toEqual(['banded', 'teen', 'unstated']);
    expect(res.ageUnconfirmed).toEqual([]);
  });

  it('with an age filter, an unstated-age listing leaves the confirmed list for its own section', () => {
    const res = search(engine, { ageBands: ['2-4'] });
    expect(ids(res.results)).toEqual(['banded']);
    expect(ids(res.ageUnconfirmed)).toEqual(['unstated']);
  });

  it('a listing whose STATED bands miss the selection is filtered out, not re-sectioned', () => {
    // The split is not a hiding place for things the filter is supposed to exclude. `teen`
    // declares 10–14; under a 2–4 search it is gone from both sections, which is the age filter
    // doing exactly its job.
    const res = search(engine, { ageBands: ['2-4'] });
    expect(ids(res.results)).not.toContain('teen');
    expect(ids(res.ageUnconfirmed)).not.toContain('teen');
  });

  it('nothing an un-aged search could reach becomes unreachable', () => {
    const open = new Set(ids(search(engine).results));
    const res = search(engine, { ageBands: ['2-4'] });
    const reachable = new Set([...ids(res.results), ...ids(res.ageUnconfirmed)]);
    for (const id of open) {
      // Only a listing with stated, non-matching bands may disappear.
      const stated = [banded, unstated, teen].find((l) => l.id === id)!.ageBandMatches.length > 0;
      const matches = hasConfirmedAgeMatch([banded, unstated, teen].find((l) => l.id === id)!, ['2-4']);
      if (stated && !matches) continue;
      expect(reachable.has(id), `"${id}" was dropped entirely by the age split`).toBe(true);
    }
  });
});

describe('the counts stay whole', () => {
  const engine = engineOver([banded, unstated, teen]);

  it('total counts BOTH primary sections — the split moves cards, it does not delete them', () => {
    const res = search(engine, { ageBands: ['2-4'] });
    expect(res.total).toBe(res.results.length + res.ageUnconfirmed.length);
    expect(res.total).toBe(2);
  });

  it('facets.total still equals total, because both count what survives the same selection', () => {
    // The facet counter runs `passesAllFilters` (which uses the PERMISSIVE matchesAge) over the
    // candidate set. If `total` had been narrowed to the confirmed section, the rail would have
    // started promising a different number from the page underneath it.
    const res = search(engine, { ageBands: ['2-4'], facets: true });
    expect(res.facets?.total).toBe(res.total);
  });
});

describe('a collapsed card is sectioned by the group, not by its representative', () => {
  it('one series-day whose occurrences disagree about age stays ONE card, in the confirmed section', () => {
    // Age is a per-occurrence fact, so two slots of the same series on the same day can legitimately
    // disagree. Splitting before collapsing would emit this as two cards — one per section — and
    // double-count it against facets.total. One real match earns the card its confirmed heading.
    const early = makeListing({
      id: 'mixed-early',
      seriesId: 'mixed-series',
      activityName: 'Family Public Swim',
      primaryCategoryKey: 'public_swim',
      ageBandMatches: [],
      startDatetimeUtc: '2026-08-08T20:00:00Z',
      endDatetimeUtc: '2026-08-08T21:00:00Z',
    });
    const late = makeListing({
      id: 'mixed-late',
      seriesId: 'mixed-series',
      activityName: 'Family Public Swim',
      primaryCategoryKey: 'public_swim',
      ageBandMatches: ['2-4'],
      startDatetimeUtc: '2026-08-08T22:00:00Z',
      endDatetimeUtc: '2026-08-08T23:00:00Z',
    });
    const res = search(engineOver([early, late]), { ageBands: ['2-4'], facets: true });

    expect(res.results).toHaveLength(1);
    expect(res.ageUnconfirmed).toHaveLength(0);
    expect(res.results[0].slots.map((s) => s.id).sort()).toEqual(['mixed-early', 'mixed-late']);
    expect(res.total).toBe(1);
    expect(res.facets?.total).toBe(1);
  });
});

describe('ranking: an unresolved age earns no age credit', () => {
  const ctx = {
    origin: null,
    radiusKm: 10,
    ageBands: ['2-4', '5-9'] as const,
    date: null,
    rainyDay: false,
    now: NOW,
  };

  it('scores unknown BELOW the weakest genuine partial match, instead of tying with it', () => {
    // The defect this closes: unknown used to score a flat 0.5, which EQUALS a listing that
    // genuinely covers one of two selected bands and BEATS one that covers one of three. A guess
    // outranking evidence is the ranking half of the same dishonesty the section split fixes.
    const unknownScore = scoreListing({ listing: unstated, relevance: 1 } as never, ctx as never);
    const partialScore = scoreListing({ listing: banded, relevance: 1 } as never, ctx as never);
    expect(unknownScore.components.ageMatch).toBe(0);
    expect(partialScore.components.ageMatch).toBe(0.5); // covers 1 of the 2 selected bands
    expect(unknownScore.components.ageMatch).toBeLessThan(partialScore.components.ageMatch);
  });

  it('says nothing at all when no age filter is active', () => {
    const noFilter = { ...ctx, ageBands: [] as const };
    expect(scoreListing({ listing: unstated, relevance: 1 } as never, noFilter as never).components.ageMatch).toBe(0);
    expect(scoreListing({ listing: banded, relevance: 1 } as never, noFilter as never).components.ageMatch).toBe(0);
  });
});
