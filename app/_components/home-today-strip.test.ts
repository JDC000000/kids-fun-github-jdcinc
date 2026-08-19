// Which rows the front door's "On now across Metro Vancouver" strip is allowed to show.
//
// THE REPORTED DEFECT, reproduced here with the live rows' exact shape. Measured against
// /api/search on 2026-08-19, the top CONFIRMED results behind that heading — on a page headed
// "See what's on for your kids today" — were Zumba, Step and Strength, Group Fitness: Strength
// and Core and Muay Thai Kickboxing, every one of them carrying `ageMinMonths: null` and an
// `ageNotes` beginning `unresolved:`. Three bare cards, no heading, no caveat, on a claim about
// children.
//
// The first test below pins the thing that is easy to get wrong about the diagnosis: this is NOT
// an `isAdultOrSeniorOnly` miss. That filter is given nothing to work with by a title like
// "Group Fitness - Zumba", and it already runs unconditionally upstream on every row either
// backend returns (lib/search/filters/predicate.ts:55; pinned at engine level by
// tests/search/engine-registration-audience.test.ts). The defect is UNRESOLVED AGE DATA reaching
// a surface with nowhere to disclose it — which is a different problem with a different fix.
//
// `frontDoorCards` is a pure function over a response precisely so this is assertable: the suite
// runs in the node environment with no DOM and no jsdom (vitest.config.ts).

import { describe, expect, it } from 'vitest';
import { isAdultOrSeniorOnly } from '@/lib/search/filters/audience';
import { FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import { FIXTURE_LISTINGS } from '@/lib/search/__fixtures__/listings';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { SearchEngine } from '@/lib/search/engine';
import type { ListingRecord } from '@/lib/search/types';
import { frontDoorCards, STRIP_REQUEST } from './HomeTodayStrip';
import type { ListingRecordDto, SearchItemDto, SearchResponseDto } from '../preview/_data/search-api';

interface RowSpec {
  id: string;
  activityName: string;
  ageMinMonths?: number | null;
  ageMaxMonths?: number | null;
  ageNotes?: string | null;
  statusState?: string;
}

function row({
  id,
  activityName,
  ageMinMonths = 60,
  ageMaxMonths = 144,
  ageNotes = null,
  statusState = 'confirmed',
}: RowSpec): SearchItemDto {
  const listing: ListingRecordDto = {
    id,
    activityName,
    primaryCategoryKey: 'open_gym',
    venueName: 'Sunset Community Centre',
    organisation: 'City of Vancouver',
    descriptionSnippet: '',
    startDatetimeUtc: '2026-08-19T18:00:00.000Z',
    endDatetimeUtc: '2026-08-19T19:00:00.000Z',
    costStatus: 'known',
    costMinCad: 5,
    costMaxCad: 5,
    statusState,
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-08-19T06:00:00.000Z',
    ageMinMonths,
    ageMaxMonths,
    ageNotes,
    geo: { lat: 49.24, lng: -123.09 },
    displayArea: 'Vancouver',
    neighbourhood: 'Sunset',
    municipalityId: null,
    sourceUrl: 'https://vancouver.ca/x',
    bookingUrl: null,
    locationUrl: null,
  };
  return { listing, distanceKm: null };
}

const response = (results: SearchItemDto[], rest: Partial<SearchResponseDto> = {}): SearchResponseDto => ({
  results,
  expected: [],
  meta: { fixtureBacked: false, sort: 'best_match', backend: 'database' },
  ...rest,
});

const ids = (items: ReturnType<typeof frontDoorCards>) => items.map((a) => a.id);

/** Three, per HomeTodayStrip's MAX_CARDS — restated here because that constant is private. */
const MAX_CARDS_EXPECTED = 3;

/** The four rows actually measured at the top of the strip on 2026-08-19, verbatim shape. */
const UNRESOLVED_LIVE_ROWS = [
  row({ id: 'zumba', activityName: 'Group Fitness - Zumba', ageMinMonths: null, ageMaxMonths: null, ageNotes: 'unresolved: Group Fitness - Zumba' }),
  row({ id: 'step', activityName: 'Step and Strength', ageMinMonths: null, ageMaxMonths: null, ageNotes: 'unresolved: Step and Strength' }),
  row({ id: 'core', activityName: 'Group Fitness: Strength and Core', ageMinMonths: null, ageMaxMonths: null, ageNotes: 'unresolved: Group Fitness: Strength and Core' }),
  row({ id: 'muaythai', activityName: 'Muay Thai Kickboxing', ageMinMonths: null, ageMaxMonths: null, ageNotes: 'unresolved: Muay Thai Kickboxing' }),
];

describe('the reported rows are an UNRESOLVED-AGE problem, not an adult-signal miss', () => {
  it('gives isAdultOrSeniorOnly nothing to catch — so the existing hard exclusion is not at fault', () => {
    // No adult/senior word in the title, no adult-audience tag in `ageNotes` (the `unresolved:`
    // marker is followed by the source's own title, not an audience list), and no open-ended
    // floor at the age of majority. All three of that filter's signals are genuinely silent.
    for (const { listing } of UNRESOLVED_LIVE_ROWS) {
      expect(isAdultOrSeniorOnly(listing)).toBe(false);
    }
  });

  it('is what it looks like: the source never stated an age for any of them', () => {
    for (const { listing } of UNRESOLVED_LIVE_ROWS) {
      expect(listing.ageMinMonths).toBeNull();
      expect(listing.ageNotes?.startsWith('unresolved:')).toBe(true);
    }
  });
});

describe('frontDoorCards — only rows this surface can stand behind', () => {
  it('EXCLUDES the unresolved rows entirely and keeps the resolved one — not a reorder', () => {
    const storytime = row({ id: 'storytime', activityName: 'Family Storytime', ageMinMonths: 24, ageMaxMonths: 72 });
    const cards = frontDoorCards(response([...UNRESOLVED_LIVE_ROWS, storytime]));
    // The resolved row is not merely promoted above the unresolved ones — the unresolved ones are
    // gone, so a reordering that left them in the tail would fail here.
    expect(ids(cards)).toEqual(['storytime']);
    for (const { listing } of UNRESOLVED_LIVE_ROWS) {
      expect(ids(cards)).not.toContain(listing.id);
    }
  });

  it('fills all three cards from resolved rows that rank BELOW the unresolved ones', () => {
    // The live ordering: the unresolved rows come first. Dropping them has to let the rows behind
    // them through, or the fix trades a wrong strip for an empty one.
    const cards = frontDoorCards(
      response([
        ...UNRESOLVED_LIVE_ROWS,
        row({ id: 'swim', activityName: 'Family Swim' }),
        row({ id: 'skate', activityName: 'Parent & Tot Skate' }),
        row({ id: 'gym', activityName: 'Open Gym for Kids' }),
      ])
    );
    expect(ids(cards)).toEqual(['swim', 'skate', 'gym']);
  });

  it('keeps a genuinely resolved ALL-AGES listing — 0 is a real number, not an unknown', () => {
    // This is the distinction the null check turns on. An all-ages row holds ageMinMonths = 0;
    // treating "0 or missing" as one case would have hidden the product's most inclusive content.
    const cards = frontDoorCards(
      response([row({ id: 'allages', activityName: 'Drop-in Playtime', ageMinMonths: 0, ageMaxMonths: null })])
    );
    expect(ids(cards)).toEqual(['allages']);
  });

  it('excludes adult-only programming whose age IS resolved — gate 2 is not subsumed by gate 1', () => {
    // "Adult 19yrs+ Swim" is stored with age_min_months = 0 (audience.ts's own note on the
    // mis-parse), so it clears the null check on a real number. Only the title signal catches it.
    const cards = frontDoorCards(
      response([
        row({ id: 'adult-swim', activityName: 'Adult 19yrs+ Swim Karen Magnussen Sunday 8:00-9:00am', ageMinMonths: 0, ageMaxMonths: null }),
        row({ id: 'seniors', activityName: 'Mah Jong', ageMinMonths: 660, ageMaxMonths: null }),
        row({ id: 'kids-swim', activityName: 'Family Swim' }),
      ])
    );
    expect(ids(cards)).toEqual(['kids-swim']);
  });

  it('keeps a parent-and-child session even though it says "adult"', () => {
    const cards = frontDoorCards(
      response([row({ id: 'with-adult', activityName: 'Family Badminton (6-13 with adult)', ageMinMonths: 72, ageMaxMonths: 168 })])
    );
    expect(ids(cards)).toEqual(['with-adult']);
  });

  it('caps at three cards however many qualify', () => {
    const cards = frontDoorCards(
      response(['a', 'b', 'c', 'd', 'e'].map((id) => row({ id, activityName: `Family Swim ${id}` })))
    );
    expect(ids(cards)).toEqual(['a', 'b', 'c']);
  });

  it('empties the ageUnconfirmed section by definition, not by special case', () => {
    // That section IS the rows whose age the source never stated, so the same rule removes all of
    // them. /search keeps them under a heading that says so; this strip has no such heading.
    const cards = frontDoorCards(
      response([], {
        ageUnconfirmed: [row({ id: 'unconfirmed', activityName: 'Community Drop-In', ageMinMonths: null, ageMaxMonths: null })],
      })
    );
    expect(cards).toEqual([]);
  });

  it('still shows only the CONFIRMED section — the filter adds a gate, it does not open one', () => {
    const cards = frontDoorCards(
      response([
        row({ id: 'stale', activityName: 'Family Swim', statusState: 'stale' }),
        row({ id: 'needs-review', activityName: 'Family Swim', statusState: 'needs_review' }),
        row({ id: 'bookable', activityName: 'Family Swim', statusState: 'bookable_open' }),
      ])
    );
    expect(ids(cards)).toEqual(['bookable']);
  });

  it('renders nothing when nothing qualifies, exactly as before', () => {
    expect(frontDoorCards(response(UNRESOLVED_LIVE_ROWS))).toEqual([]);
    expect(frontDoorCards(response([]))).toEqual([]);
  });
});

describe('the request leaves headroom for the filter above', () => {
  it('asks for a candidate POOL, not three rows', () => {
    // Asking for exactly MAX_CARDS would have blanked the strip on the measured data: the four
    // top-ranked confirmed rows are all unresolved-age, so a three-row response filters to zero.
    expect(STRIP_REQUEST.limit).toBe(24);
    expect(STRIP_REQUEST.limit).toBeGreaterThan(3);
    // …while still being a small fraction of the old limit=100 / 165,596-byte payload (X2).
    expect(STRIP_REQUEST.limit!).toBeLessThan(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHICH LAYER REMOVES WHAT — run through the REAL engine, not a hand-built response.
//
// This block exists to keep one claim honest and one claim from being made: the client-side
// `isAdultOrSeniorOnly` gate is redundant (the engine already removed those rows), and the
// unresolved-age gate is NOT (the engine returns those rows by design, because /search discloses
// them under `ageUnconfirmed`). A future edit that deletes the null-age gate on the reasoning
// "the engine handles this" fails here, with the distinction spelled out.
//
// The response is JSON round-tripped, which is exactly what the wire does to it
// (app/api/search/route.ts hands the engine's SearchResponse straight to `json()`), so this is
// the real DTO the component receives rather than a cast.
// ─────────────────────────────────────────────────────────────────────────────
describe('what /api/search itself already removes, and what it deliberately does not', () => {
  const plant = (over: Partial<ListingRecord>): ListingRecord =>
    makeListing({ ...FIXTURE_LISTINGS[0], ...over });

  // Every one of these is caught by the shipped hard exclusion, by a different signal each.
  const ADULT_ONLY: ListingRecord[] = [
    plant({ id: 'p-adult-swim', seriesId: 's-adult-swim', activityName: 'Adult 19yrs+ Swim Karen Magnussen Sunday 8:00-9:00am', ageMinMonths: 0, ageMaxMonths: null }),
    plant({ id: 'p-mahjong', seriesId: 's-mahjong', activityName: 'Mah Jong', ageMinMonths: 660, ageMaxMonths: null }),
    plant({ id: 'p-seniors', seriesId: 's-seniors', activityName: 'Smart Device Workshop for Seniors' }),
    plant({ id: 'p-tagged', seriesId: 's-tagged', activityName: 'Tech Help', ageNotes: 'unresolved: Digital Essentials, Adults, Seniors, English' }),
  ];
  // The rows Jon actually saw. None of them is adult-only by any signal; all are age-unresolved.
  const UNRESOLVED: ListingRecord[] = [
    plant({ id: 'p-zumba', seriesId: 's-zumba', activityName: 'Group Fitness - Zumba', ageMinMonths: null, ageMaxMonths: null, ageNotes: 'unresolved: Group Fitness - Zumba' }),
    plant({ id: 'p-muaythai', seriesId: 's-muaythai', activityName: 'Muay Thai Kickboxing', ageMinMonths: null, ageMaxMonths: null, ageNotes: 'unresolved: Muay Thai Kickboxing' }),
  ];

  const wire = (): SearchResponseDto => {
    const engine = new SearchEngine({
      repository: new InMemoryListingRepository([...ADULT_ONLY, ...UNRESOLVED, ...FIXTURE_LISTINGS]),
      aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
      regionHierarchy: new RegionHierarchy(REGIONS),
      geocoder: fsaGeocoder,
    });
    return JSON.parse(JSON.stringify(engine.search({ q: '', now: FIXTURE_NOW, ...STRIP_REQUEST })));
  };

  const returnedIds = (body: SearchResponseDto) =>
    [...body.results, ...(body.ageUnconfirmed ?? []), ...body.expected].map((i) => i.listing.id);

  it('already removes every adult/senior-only row — so this component’s own check is redundant', () => {
    // predicate.ts:55 runs isAdultOrSeniorOnly unconditionally on both backends. Kept in the
    // component anyway (it does not otherwise assert that upstream guarantee), but it is a no-op
    // on any /api/search-sourced response, and this is the measurement that says so.
    const ids = returnedIds(wire());
    for (const l of ADULT_ONLY) {
      expect(isAdultOrSeniorOnly(l)).toBe(true);
      expect(ids).not.toContain(l.id);
    }
  });

  it('deliberately DOES return the unresolved-age rows — which is why the null-age gate is here', () => {
    const ids = returnedIds(wire());
    for (const l of UNRESOLVED) {
      expect(isAdultOrSeniorOnly(l)).toBe(false); // nothing for the adult filter to catch
      expect(ids).toContain(l.id); // …so they reach this component, unlabelled
    }
  });

  it('and the strip’s own filter is what keeps them off the front door', () => {
    const cards = frontDoorCards(wire());
    expect(cards).toHaveLength(MAX_CARDS_EXPECTED);
    for (const l of UNRESOLVED) expect(ids(cards)).not.toContain(l.id);
    for (const l of ADULT_ONLY) expect(ids(cards)).not.toContain(l.id);
  });
});
