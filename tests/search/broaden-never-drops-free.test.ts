// tests/search/broaden-never-drops-free.test.ts
//
// THE LIVE DEFECT, measured on production 2026-08-16:
//
//   GET /api/search?q=free&region=bby
//     → total 2, context.costFree FALSE, applied [radius_expand, drop_chip, expected_section]
//     → both results "Hockey Skills & Scrimmage (12-16yrs)", costStatus 'known', $21.25
//
//   GET /api/search?q=free&region=bby&minResults=0      ← the same query, broadening declined
//     → total 0, context.costFree TRUE
//
// The second call is the control, and it is decisive: the honest answer to "free things in
// Burnaby" is NOTHING. The broadening ladder converted that into two confirmed $21.25 hockey
// sessions, by reaching the drop-a-chip rung and stripping `costFree` outright. Burnaby holds
// only 2 listings in total, so ANY additional constraint there trips `minResults`, and no
// higher rung had anything left to relax.
//
// THIS IS NOT THE UNKNOWN-COST RULING. Jon's ruling (lib/search/filters/cost.ts) is that
// unknown/check_source listings stay visible under the Free filter, labelled honestly — we do
// not withhold a listing because its source omitted a price. That ruling covers listings whose
// price we DO NOT HOLD. It has nothing to say about a listing whose price we hold, know, and
// can print: $21.25 is not an unknown cost, and no ruling makes it free.
//
// So `costFree` is now excluded from the chip-drop rung entirely. The three chips that remain
// there (Bookable now, Drop-in, Rainy-day) are conveniences — dropping one shows a parent
// something they can still do, perhaps with a booking. Free is not a convenience. A parent
// filtering for free may be unable to pay, and a ladder that answers them with a priced
// activity has not widened their search, it has ignored the only part of it that was binding.
// The ladder's job is to find more of what was asked for, never to bill for it.
import { describe, expect, it } from 'vitest';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { RegionHierarchy } from '@/lib/geo/region';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import { isFree, isUnknownCost } from '@/lib/search/filters/cost';
import type { ListingRecord } from '@/lib/search/types';

/** The Burnaby shape: a scope so thin that any extra constraint trips `minResults`. */
function thinCatalogueEngine(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
  });
}

/** A confirmed, definitely-priced activity — the production row, in miniature. */
const PAID_HOCKEY = makeListing({
  id: 'thin-hockey-1',
  activityName: 'Hockey Skills & Scrimmage (12-16yrs)',
  costStatus: 'known',
  costMinCad: 21.25,
  costMaxCad: 21.25,
  startDatetimeUtc: '2026-07-13T20:00:00Z',
  endDatetimeUtc: '2026-07-13T21:00:00Z',
});
const PAID_HOCKEY_2 = makeListing({ ...PAID_HOCKEY, id: 'thin-hockey-2', seriesId: 'thin-hockey-2-series' });

/**
 * A known-priced row in the EXPECTED/seasonal class — the other door into the same defect.
 *
 * `allShown` below spans both sections precisely because a parent does not experience them as
 * two products, and the assertions were written to cover both. But every catalogue in this file
 * held only primary-class rows, so the expected-section half of every one of those assertions
 * was vacuous — it ranged over an empty array and could not have failed. Seeding this row is
 * what makes those assertions mean what they say.
 *
 * It is not a hypothetical shape: the expected section ran with cost filtering bypassed
 * entirely (filters/predicate.ts gated matchesCost on `mode === 'primary'`), so this $85 row
 * came back under `q=free` with `context.costFree: true`, in a section the page renders with no
 * price-related caveat. Reverting that gate reddens the DECISIVE test below.
 */
const PAID_PRESEASON = makeListing({
  id: 'thin-preseason',
  activityName: 'Outdoor Pool Season Pass',
  costStatus: 'known',
  costMinCad: 85,
  costMaxCad: 85,
  statusState: 'seasonal_preseason',
  startDatetimeUtc: '2026-07-13T20:00:00Z',
});

/** Every result a parent can see, primary list and expected section alike. */
const allShown = (res: { results: { listing: ListingRecord }[]; expected: { listing: ListingRecord }[] }) =>
  [...res.results, ...res.expected].map((r) => r.listing);

describe('broaden: a Free-filtered search is never answered with a priced activity', () => {
  const engine = thinCatalogueEngine([PAID_HOCKEY, PAID_HOCKEY_2, PAID_PRESEASON]);

  it('DECISIVE: the production case — thin scope, free intent, known-priced pool', () => {
    const res = engine.search({ q: 'free', now: FIXTURE_NOW, minResults: 3, limit: 100 });

    // The constraint SURVIVES the ladder. This is the assertion the old code failed.
    expect(res.context.costFree).toBe(true);

    // And nothing with a real price got in — the whole point of the filter.
    for (const listing of allShown(res)) {
      expect(
        isFree(listing) || isUnknownCost(listing),
        `${listing.activityName} (${listing.costStatus} $${listing.costMinCad}) was shown under a Free filter`,
      ).toBe(true);
    }
    expect(allShown(res)).toHaveLength(0); // the honest answer here is "nothing free"
  });

  it('declines gracefully rather than padding: it says WHY it is empty', () => {
    const res = engine.search({ q: 'free', now: FIXTURE_NOW, minResults: 3, limit: 100 });
    expect(res.total).toBe(0);
    // An honest empty state, not a silent substitution.
    expect(res.broadening.emptyState).not.toBeNull();
    expect(res.broadening.emptyState?.message).toBeTruthy();
    // Whatever the ladder did try is disclosed; what it must NOT have tried is dropping cost.
    expect(res.broadening.applied.map((r) => r.constraint)).not.toContain('costFree');
  });

  it('broadening OFF and broadening ON now agree about cost — they used to contradict', () => {
    const honest = engine.search({ q: 'free', now: FIXTURE_NOW, minResults: 0, limit: 100 });
    const broadened = engine.search({ q: 'free', now: FIXTURE_NOW, minResults: 3, limit: 100 });
    expect(honest.context.costFree).toBe(true);
    expect(broadened.context.costFree).toBe(true);
    expect(allShown(broadened)).toHaveLength(allShown(honest).length);
  });

  it('KEEPS Jon’s unknown-cost ruling: an unpriced listing still shows under Free', () => {
    // The half of the "Free admits unpriced items" complaint that is DELIBERATE, and which this
    // fix must not quietly take away while closing the other half.
    const unknown = makeListing({
      id: 'thin-unknown',
      activityName: 'Family Storytime',
      costStatus: 'unknown',
      startDatetimeUtc: '2026-07-13T20:00:00Z',
    });
    const res = thinCatalogueEngine([PAID_HOCKEY, unknown]).search({
      q: 'free',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
    });
    const shown = allShown(res).map((l) => l.id);
    expect(shown).toContain('thin-unknown'); // unknown cost: still visible, labelled honestly
    expect(shown).not.toContain('thin-hockey-1'); // known price: still excluded
  });

  it('the unknown-cost ruling reaches the EXPECTED section too — cost filtering is not a purge', () => {
    // Applying the Free filter to the expected section must exclude a KNOWN price and nothing
    // else. An unpublished price is the section's ordinary shape (a listing is "expected"
    // precisely because its details are not posted yet), so if this row vanished the fix would
    // have emptied the section instead of filtering it.
    const unknownPreseason = makeListing({
      id: 'thin-preseason-unknown',
      activityName: 'Wading Pool Summer Season',
      costStatus: 'unknown',
      statusState: 'seasonal_preseason',
      startDatetimeUtc: '2026-07-13T20:00:00Z',
    });
    const res = thinCatalogueEngine([PAID_PRESEASON, unknownPreseason]).search({
      q: 'free',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
    });
    expect(res.expected.map((r) => r.listing.id)).toEqual(['thin-preseason-unknown']);
    expect(allShown(res).map((l) => l.id)).not.toContain('thin-preseason');
  });

  it('a genuinely free listing is returned, so the filter is enforced and not merely empty', () => {
    const free = makeListing({
      id: 'thin-free',
      activityName: 'Free Drop-In Gym',
      costStatus: 'free',
      startDatetimeUtc: '2026-07-13T20:00:00Z',
    });
    const res = thinCatalogueEngine([PAID_HOCKEY, PAID_PRESEASON, free]).search({
      q: 'free',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
    });
    expect(allShown(res).map((l) => l.id)).toContain('thin-free');
    expect(allShown(res).map((l) => l.id)).not.toContain('thin-hockey-1');
    expect(allShown(res).map((l) => l.id)).not.toContain('thin-preseason');
  });

  it('the OTHER chips are still droppable — this narrows the rung, it does not delete it', () => {
    // Bookable now / Drop-in / Rainy-day are conveniences; a drop is still their relaxation.
    const res = thinCatalogueEngine([PAID_HOCKEY, PAID_HOCKEY_2]).search({
      q: 'drop-in',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
    });
    expect(res.broadening.applied.map((r) => r.constraint)).toContain('dropIn');
    expect(res.context.dropIn).toBe(false);
  });
});
