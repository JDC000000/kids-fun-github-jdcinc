// A recurring programme is ONE card, and no single venue owns the page.
//
// WHY THIS FILE EXISTS. The 2026-08-18 independent report, item P1-2, measured both halves of the
// same page defect against live output:
//
//   "q=open gym returns 60 results of which 20+ are the same weekly programmes repeated per day:
//    '$3 Open Gym 8yrs+ Delbrook Tuesday', '…Wednesday', '…Thursday', '…Friday'. […] 60 results
//    become roughly 8 real options, and the parent has to do the deduplication mentally while a
//    toddler pulls on their leg."
//
// and its remedy: "Collapse results by seriesId into one card […] Cap any single venue at 3 cards
// in the top 20 to force venue diversity."
//
// Collapsing across days already had a unit test at the module level (tests/search/collapse.ts);
// what was missing — and what the report is actually about — is the ENGINE's behaviour on a page
// shaped like the one it measured. So these run the whole pipeline: match → filter → rank → sort
// → collapse → venue cap, and assert on what a parent would be handed.

import { describe, expect, it } from 'vitest';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { RegionHierarchy } from '../../lib/geo/region';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import { capVenueRepetition, MAX_CARDS_PER_VENUE, VENUE_CAP_WINDOW } from '../../lib/search/venue-diversity';
import { collapseSeries } from '../../lib/search/collapse';
import type { ScoredListing } from '../../lib/search/rank';
import type { ListingRecord } from '../../lib/search/types';

const NOW = new Date('2026-08-08T12:00:00Z');

function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: true,
  });
}

/** minResults: 0 disables the broadening ladder, so every assertion is about the raw page. */
const search = (engine: SearchEngine, q: string, extra = {}) =>
  engine.search({ q, now: NOW, minResults: 0, ...extra });

/**
 * The report's own example, rebuilt: one weekly Open Gym series at Delbrook running Sat/Sun/Mon/Tue
 * — four occurrences a parent used to meet as four cards.
 */
function openGymWeek(): ListingRecord[] {
  return ['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11'].map((day, i) =>
    makeListing({
      id: `open-gym-${i}`,
      seriesId: 'series-open-gym-delbrook',
      activityName: 'Open Gym',
      primaryCategoryKey: 'drop_in_sport',
      venueName: 'Delbrook Community Recreation Centre',
      startDatetimeUtc: `${day}T20:30:00Z`,
      endDatetimeUtc: `${day}T22:30:00Z`,
    }),
  );
}

describe('a recurring programme collapses to one card carrying every occurrence', () => {
  it('turns N same-series occurrences across N days into 1 result with N slots', () => {
    const engine = engineOver(openGymWeek());
    const response = search(engine, 'open gym');

    expect(response.results).toHaveLength(1);
    expect(response.total).toBe(1);
    expect(response.results[0].slots.map((s) => s.id)).toEqual([
      'open-gym-0',
      'open-gym-1',
      'open-gym-2',
      'open-gym-3',
    ]);
  });

  it('keeps every occurrence REACHABLE through the card — nothing is dropped, only merged', () => {
    // The point of the fix is deduplication, not removal: a parent who opens the card must still
    // be able to pick the Tuesday session. Every id the repository held is still on the page.
    const listings = openGymWeek();
    const response = search(engineOver(listings), 'open gym');
    const reachable = response.results.flatMap((r) => r.slots.map((s) => s.id));
    expect(reachable.sort()).toEqual(listings.map((l) => l.id).sort());
  });

  it('states the DAYS it runs and no single-day span, because it occupies no single span', () => {
    const response = search(engineOver(openGymWeek()), 'open gym');
    const card = response.results[0];
    expect(card.slotDays).toEqual(['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11']);
    // A "1:30 PM Saturday to 3:30 PM Tuesday" span is not a window anyone can attend.
    expect(card.slotSpanEndUtc).toBeNull();
  });

  it('still states a span for a card whose occurrences share one local day', () => {
    const sameDay = [0, 1].map((i) =>
      makeListing({
        id: `piano-${i}`,
        seriesId: 'series-piano',
        activityName: 'Open Gym',
        primaryCategoryKey: 'drop_in_sport',
        venueName: 'Killarney Community Centre',
        startDatetimeUtc: `2026-08-08T22:${i === 0 ? '15' : '45'}:00Z`,
        endDatetimeUtc: `2026-08-08T22:${i === 0 ? '30' : '59'}:00Z`,
      }),
    );
    const card = search(engineOver(sameDay), 'open gym').results[0];
    expect(card.slotDays).toEqual(['2026-08-08']);
    expect(card.slotSpanEndUtc).toBe('2026-08-08T22:59:00Z');
  });

  it('leaves unrelated listings alone — different series stay different cards', () => {
    // Anti-vacuity for the whole file: collapsing must not be "return fewer things".
    const listings = [
      ...openGymWeek(),
      makeListing({
        id: 'other-gym',
        seriesId: 'series-open-gym-parkgate', // same words, different programme
        activityName: 'Open Gym',
        primaryCategoryKey: 'drop_in_sport',
        venueName: 'Parkgate Community Centre',
        startDatetimeUtc: '2026-08-08T20:30:00Z',
        endDatetimeUtc: '2026-08-08T22:30:00Z',
      }),
    ];
    const response = search(engineOver(listings), 'open gym');
    expect(response.results).toHaveLength(2);
    expect(response.results.map((r) => r.listing.seriesId).sort()).toEqual([
      'series-open-gym-delbrook',
      'series-open-gym-parkgate',
    ]);
    // The one-off keeps a one-slot list, so consumers need no special case.
    const single = response.results.find((r) => r.listing.id === 'other-gym');
    expect(single?.slots).toHaveLength(1);
    expect(single?.slotDays).toEqual(['2026-08-08']);
  });
});

describe('venue repetition is capped on the page a parent scans', () => {
  /** `count` distinct one-off programmes at `venue`, ranked in construction order. */
  function programmes(venue: string, count: number, prefix: string): ListingRecord[] {
    return Array.from({ length: count }, (_, i) =>
      makeListing({
        id: `${prefix}-${i}`,
        seriesId: `${prefix}-series-${i}`,
        activityName: 'Open Gym',
        primaryCategoryKey: 'drop_in_sport',
        venueName: venue,
        // Ascending so `soonest` ranks them in construction order, making the assertions about
        // ORDER rather than about whatever the tie-break happened to do.
        startDatetimeUtc: `2026-08-08T${String(14 + i).padStart(2, '0')}:00:00Z`,
        endDatetimeUtc: `2026-08-08T${String(15 + i).padStart(2, '0')}:00:00Z`,
      }),
    );
  }

  it('holds the cap in the top 20 of a page that has the venues to fill one', () => {
    // The report's own measurement condition: a real page, many venues, one over-represented.
    // Eight Delbrook programmes rank ahead of everything else under `soonest`, and seven other
    // venues supply the rest, so the top 20 CAN be diverse — and must be.
    const crowded = programmes('Delbrook Community Recreation Centre', 8, 'del');
    const others = ['Parkgate', 'Killarney', 'Hillcrest', 'Kitsilano', 'Trout Lake', 'Riley Park', 'Renfrew'].flatMap(
      (venue, v) =>
        programmes(venue, 3, `v${v}`).map((l, i) => ({
          ...l,
          // Ranked strictly after the eight Delbrook rows, so without the cap they never make the top 8.
          startDatetimeUtc: `2026-08-09T${String(8 + v).padStart(2, '0')}:${String(i * 10).padStart(2, '0')}:00Z`,
          endDatetimeUtc: `2026-08-09T${String(9 + v).padStart(2, '0')}:${String(i * 10).padStart(2, '0')}:00Z`,
        })),
    );
    const response = search(engineOver([...crowded, ...others]), 'open gym', { sort: 'soonest' });
    const venues = response.results.map((r) => r.listing.venueName);

    expect(venues.length).toBeGreaterThan(VENUE_CAP_WINDOW); // anti-vacuity: there IS a top 20
    expect(venues.slice(0, VENUE_CAP_WINDOW).filter((v) => v === 'Delbrook Community Recreation Centre'))
      .toHaveLength(MAX_CARDS_PER_VENUE);
    // Nothing was dropped to achieve that: every card is still on the page, exactly once.
    expect(response.results).toHaveLength(29);
    expect(response.total).toBe(29);
    expect(new Set(response.results.map((r) => r.listing.id)).size).toBe(29);
  });

  it('when a thin page has no other venue to promote, it defers rather than hides', () => {
    // Eight Delbrook, two Parkgate: capping the top 20 at 3 Delbrook would mean hiding five real
    // answers, which this never does. The parent meets both Parkgate options before Delbrook's
    // fourth row, and all ten listings are still there.
    const listings = [...programmes('Delbrook Community Recreation Centre', 8, 'del'), ...programmes('Parkgate Community Centre', 2, 'park')];
    listings[8].startDatetimeUtc = '2026-08-08T23:00:00Z';
    listings[9].startDatetimeUtc = '2026-08-08T23:30:00Z';

    const response = search(engineOver(listings), 'open gym', { sort: 'soonest' });
    expect(response.results.map((r) => r.listing.id)).toEqual([
      'del-0', 'del-1', 'del-2', 'park-0', 'park-1', 'del-3', 'del-4', 'del-5', 'del-6', 'del-7',
    ]);
    expect(response.total).toBe(10);
  });

  it('promotes the other venue rather than deleting the capped one — a reorder, not a filter', () => {
    const listings = [...programmes('Delbrook Community Recreation Centre', 5, 'del'), ...programmes('Parkgate Community Centre', 1, 'park')];
    listings[5].startDatetimeUtc = '2026-08-08T23:00:00Z'; // ranks LAST before the cap

    const ids = search(engineOver(listings), 'open gym', { sort: 'soonest' }).results.map((r) => r.listing.id);
    // Parkgate was 6th by rank; the cap lifts it to 4th and the two capped Delbrook cards follow.
    expect(ids).toEqual(['del-0', 'del-1', 'del-2', 'park-0', 'del-3', 'del-4']);
  });

  it('leaves a page with no venue repetition problem in exactly its ranked order', () => {
    const listings = [
      ...programmes('Delbrook Community Recreation Centre', 2, 'del'),
      ...programmes('Parkgate Community Centre', 2, 'park'),
      ...programmes('Killarney Community Centre', 2, 'kil'),
    ];
    listings[2].startDatetimeUtc = '2026-08-08T20:00:00Z';
    listings[3].startDatetimeUtc = '2026-08-08T21:00:00Z';
    listings[4].startDatetimeUtc = '2026-08-08T22:00:00Z';
    listings[5].startDatetimeUtc = '2026-08-08T23:00:00Z';

    const ids = search(engineOver(listings), 'open gym', { sort: 'soonest' }).results.map((r) => r.listing.id);
    expect(ids).toEqual(['del-0', 'del-1', 'park-0', 'park-1', 'kil-0', 'kil-1']);
  });
});

describe('capVenueRepetition (lib/search/venue-diversity.ts)', () => {
  function card(id: string, venueName: string) {
    const scored: ScoredListing = {
      candidate: {
        listing: makeListing({ id, seriesId: `${id}-series`, venueName, startDatetimeUtc: '2026-08-08T20:00:00Z' }),
        relevance: 1,
        matchedTerms: [],
        categoryHit: true,
      },
      score: 1,
      distanceKm: null,
      components: {} as ScoredListing['components'],
    };
    return collapseSeries([scored])[0];
  }

  const ids = (cards: ReturnType<typeof card>[]) => cards.map((c) => c.representative.candidate.listing.id);

  it('returns a single-venue page completely unchanged — there is nothing to diversify with', () => {
    // The property that keeps the cap from becoming a truncation: with no alternative venue to
    // promote, every window defers what it cannot seat and the next window seats it next, in rank
    // order. A search in a one-facility town reads exactly as it did before.
    const cards = Array.from({ length: 25 }, (_, i) => card(`only-${i}`, 'Delbrook'));
    expect(ids(capVenueRepetition(cards))).toEqual(ids(cards));
  });

  it('never invents, drops or duplicates a card', () => {
    const cards = [
      ...Array.from({ length: 30 }, (_, i) => card(`del-${i}`, 'Delbrook')),
      ...Array.from({ length: 5 }, (_, i) => card(`park-${i}`, 'Parkgate')),
    ];
    const out = capVenueRepetition(cards);
    expect(out).toHaveLength(cards.length);
    expect(ids(out).sort()).toEqual(ids(cards).sort());
  });

  it('keeps dealing in rounds down the whole page — a scrolling parent meets no wall', () => {
    // Two venues, 30 cards each: with only two to alternate between, "3 per 20" is arithmetically
    // impossible without hiding cards, so the guarantee that holds is the one about RUNS — the
    // list alternates in blocks of at most 3 all the way down, rather than 30 of one then 30 of
    // the other.
    const cards = [
      ...Array.from({ length: 30 }, (_, i) => card(`del-${i}`, 'Delbrook')),
      ...Array.from({ length: 30 }, (_, i) => card(`park-${i}`, 'Parkgate')),
    ];
    const out = capVenueRepetition(cards);

    let run = 0;
    let previous: string | null = null;
    for (const c of out) {
      const venue = c.representative.candidate.listing.venueName;
      run = venue === previous ? run + 1 : 1;
      previous = venue;
      expect(run, `${venue} runs ${run} cards deep`).toBeLessThanOrEqual(MAX_CARDS_PER_VENUE);
    }
    // …and rank order survives WITHIN each venue: no card overtakes a better-ranked sibling.
    expect(ids(out).filter((id) => id.startsWith('del'))).toEqual(ids(cards).filter((id) => id.startsWith('del')));
  });

  it('holds the literal "3 per 20" rule when the page has enough venues to fill a round', () => {
    const cards = [
      ...Array.from({ length: 20 }, (_, i) => card(`del-${i}`, 'Delbrook')),
      ...Array.from({ length: 40 }, (_, i) => card(`v-${i}`, `Venue ${i % 10}`)),
    ];
    const out = capVenueRepetition(cards);
    const perVenue = new Map<string, number>();
    for (const c of out.slice(0, VENUE_CAP_WINDOW)) {
      const v = c.representative.candidate.listing.venueName;
      perVenue.set(v, (perVenue.get(v) ?? 0) + 1);
    }
    for (const [venue, n] of perVenue) {
      expect(n, `${venue} holds ${n} of the top ${VENUE_CAP_WINDOW}`).toBeLessThanOrEqual(MAX_CARDS_PER_VENUE);
    }
  });

  it('never caps listings whose venue is unnamed — an absent fact is not a shared venue', () => {
    const cards = Array.from({ length: 10 }, (_, i) => card(`blank-${i}`, ''));
    expect(ids(capVenueRepetition(cards))).toEqual(ids(cards));
  });
});
