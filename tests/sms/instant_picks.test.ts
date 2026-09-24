// tests/sms/instant_picks.test.ts — the Instant Picks selection wrapper (plan v1.0, task 1).
//
// Pure module over a FIXTURE-BACKED engine, the same pattern tests/sms/weekly_picks.test.ts uses:
// build a small catalogue whose every relevant property is visible in this file, run the REAL
// SearchEngine over it, and assert on what the wrapper decided. No DB, no network, no ambient
// clock — so this file stays in the `unit` lane (vitest.workspace.ts).
//
// ═══ THE TWO TESTS THIS FILE EXISTS FOR ═══
// §PAUSE and §NO-PERSISTENCE below guard the two defects the plan named as real risks BEFORE
// anyone wrote the feature. Both are the kind that arrive by pattern-matching the weekly cron's
// code, both are invisible until they have already cost a real subscriber something, and neither
// is caught by any other suite. If you are changing lib/sms/instant-picks.ts and one of them goes
// red, it has found what it was put here to find.
//
// FIXTURE NAMES: unrelated words, never "Activity 1 / Activity 2", and never registration-shaped
// ("class", "lesson", "camp"). Both rules are inherited from weekly_picks.test.ts, which learned
// them the hard way — numbered names are trigram-similar enough for the dedup pass to collapse the
// whole fixture, and registration-shaped titles are dropped by the engine before the selector sees
// them. See that file's header.
import { describe, expect, it, vi } from 'vitest';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import type { AgeBandKey, GeoPoint, ListingRecord } from '@/lib/search/types';
import {
  INSTANT_PICKS_EMPTY_WEEKS,
  selectInstantPicks,
  type InstantPicksInput,
} from '@/lib/sms/instant-picks';
import {
  FLOOR_PICKS,
  MAX_PICKS,
  selectWeeklyPicks,
  type WeeklyPicks,
  type WeeklyPicksInput,
} from '@/lib/sms/weekly-picks';

// ── The clock and the geography ──────────────────────────────────────────────
/** Friday 2026-08-28, 16:00 PDT. The weekend that resolves from it is Sat 08-29 + Sun 08-30. */
const FRIDAY_4PM = new Date('2026-08-28T23:00:00Z');
/** Tuesday 2026-09-01, 10:00 PDT — a press mid-week. The weekend is still Sat 09-05 + Sun 09-06. */
const TUESDAY_10AM = new Date('2026-09-01T17:00:00Z');

const SAT = '2026-08-29';
const SUN = '2026-08-30';
/** The Saturday that follows TUESDAY_10AM — nothing on it is reachable from FRIDAY_4PM. */
const NEXT_SAT = '2026-09-05';

/** A Vancouver postal. `fsaGeocoder` resolves V5L → the 'van' municipality centroid. */
const POSTAL = 'V5L 1A1';
/** That centroid, so fixtures can be placed a known distance from what the wrapper will resolve. */
const VAN: GeoPoint = { lng: -123.1207, lat: 49.2827 };

/** Unrelated activity names — see this file's header. */
const NAMES = [
  'Splash Time', 'Story Circle', 'Lego Build', 'Puppet Show', 'Nature Walk', 'Music Makers',
  'Gym Romp', 'Art Studio', 'Chess Club', 'Dance Party', 'Science Lab', 'Yoga Kids',
];

function at(isoDate: string, localHour: number): string {
  // America/Vancouver is UTC-7 in late August / early September.
  return `${isoDate}T${String(localHour + 7).padStart(2, '0')}:00:00Z`;
}

/** A listing that passes every gate: confirmed, a stated age floor, geocoded, inside the weekend. */
function kidActivity(partial: Partial<ListingRecord> & { id: string }): ListingRecord {
  return makeListing({
    statusState: 'confirmed',
    ageMinMonths: 24,
    ageMaxMonths: 120,
    ageBandMatches: ['2-4', '5-9'] as AgeBandKey[],
    geo: VAN,
    startDatetimeUtc: at(SAT, 10),
    endDatetimeUtc: at(SAT, 11),
    venueName: 'Trout Lake Community Centre',
    primaryCategoryKey: 'general',
    ...partial,
  });
}

function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
  });
}

/** N genuinely distinct activities: different names, venues, places and times. */
function distinctActivities(n: number, over: Partial<ListingRecord> = {}): ListingRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const name = NAMES[i % NAMES.length];
    return kidActivity({
      id: `act-${i}`,
      activityName: name,
      venueName: `${name} Centre`,
      geo: { lat: VAN.lat + i * 0.002, lng: VAN.lng }, // ~220m apart, cumulative
      startDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 9 + (i % 6)),
      endDatetimeUtc: at(i % 2 === 0 ? SAT : SUN, 10 + (i % 6)),
      ...over,
    });
  });
}

function input(listings: ListingRecord[], over: Partial<InstantPicksInput> = {}): InstantPicksInput {
  return {
    engine: engineOver(listings),
    now: FRIDAY_4PM,
    ...over,
    subscriber: {
      postalCode: POSTAL,
      birthYears: [2021, 2018], // 5 and 8 in 2026 → both land in '5-9'
      ...over.subscriber,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// §PAUSE — the landmine. THE MOST IMPORTANT TESTS IN THIS FILE.
//
// `selectWeeklyPicks` reports `shouldPause: consecutiveEmptyWeeks + 1 >= 3` on an empty result.
// Correct for the Friday cron; catastrophic here, where the trigger is a BUTTON. A parent who
// presses this on a quiet Tuesday must not be able to pause their own subscription.
//
// The wrapper has two independent guards (a hard-zero counter, and a return type with no field
// for the flag). These tests attack them SEPARATELY, because a refactor that defeats one will
// usually leave the other standing — and a test that only proves the happy path would pass
// against a wrapper that had lost both.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks · the pause flag cannot reach this path', () => {
  it('passes a hard zero as the empty-week counter, never a real one', () => {
    const select = vi.fn<(i: WeeklyPicksInput) => WeeklyPicks>(() => EMPTY_RESULT);

    selectInstantPicks(input(distinctActivities(6), { select }));

    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0].subscriber.consecutiveEmptyWeeks).toBe(0);
    expect(INSTANT_PICKS_EMPTY_WEEKS).toBe(0);
  });

  it('a zero counter makes the selector itself report shouldPause: false — checked end to end', () => {
    // Not a tautology about the wrapper: this runs the REAL selector over a catalogue with nothing
    // in it, which is the exact situation that produces a pause on the cron path, and proves the
    // value the wrapper passes is one the selector cannot turn into a pause. If somebody changes
    // INSTANT_PICKS_EMPTY_WEEKS to 2 "because that is what the subscriber has", this goes red.
    const captured: WeeklyPicks[] = [];
    const select = (i: WeeklyPicksInput) => {
      const real = selectWeeklyPicks(i);
      captured.push(real);
      return real;
    };
    const result = selectInstantPicks(input([], { select }));

    expect(result.outcome).toBe('empty');
    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe('empty');
    expect(captured[0].shouldPause).toBe(false);
  });

  it('DROPS shouldPause even when the selector insists on it', () => {
    // The second guard, attacked on its own. Here the selector is stubbed to demand a pause — the
    // state the real one would reach at consecutiveEmptyWeeks >= 2. Nothing the wrapper returns
    // may carry it onward, by any name, in any shape.
    const select = () => ({ ...EMPTY_RESULT, shouldPause: true });

    const result = selectInstantPicks(input([], { select }));

    expect(result.outcome).toBe('empty');
    expect(Object.values(result)).not.toContain(true);
    for (const key of Object.keys(result)) {
      expect(key.toLowerCase()).not.toContain('pause');
    }
    // Belt and braces against a rename: nothing truthy anywhere in the serialised result.
    expect(JSON.stringify(result)).not.toMatch(/pause/i);
  });

  it('the picks path cannot carry it either', () => {
    // The empty branch is where the real flag is computed, so it gets the stub above. This covers
    // the OTHER return statement in the wrapper — a successful press — against the same mistake,
    // because there are two places a `shouldPause` could be copied into and only one of them is
    // the obvious one.
    const result = selectInstantPicks(input(distinctActivities(6)));

    expect(result.outcome).toBe('picks');
    expect(JSON.stringify(result)).not.toMatch(/pause/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §NO-PERSISTENCE — behavioural half. The static half is
// tests/sms/instant_picks_no_persistence.test.ts, which proves the module cannot even IMPORT a
// writer; this proves it does not reach one through the engine it was handed either.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks · writes nothing', () => {
  it('reaches the engine ONLY through search() — a stand-in with nothing else still works', () => {
    const listings = distinctActivities(6);
    const real = engineOver(listings);
    const requests: unknown[] = [];

    // A stand-in exposing ONE method. If the wrapper reached for any other member of SearchEngine
    // — something that logged, recorded or persisted — it would find `undefined` and throw, so
    // this passing IS the assertion that `search` is the entire surface it touches.
    //
    // A Proxy was the first attempt and is the wrong tool: `search` runs with `this` bound to the
    // proxy, so the engine's own internals trip the trap and the recording says more about the
    // engine's implementation than about the wrapper's use of it.
    const onlySearch = {
      search: (req: Parameters<SearchEngine['search']>[0]) => {
        requests.push(req);
        return real.search(req);
      },
    } as unknown as SearchEngine;

    const result = selectInstantPicks(input(listings, { engine: onlySearch }));

    expect(result.outcome).toBe('picks');
    expect(requests.length).toBeGreaterThan(0);
  });

  it('is a pure function of its inputs — two identical presses agree exactly', () => {
    const listings = distinctActivities(6);
    const a = selectInstantPicks(input(listings));
    const b = selectInstantPicks(input(listings));
    expect(a).toEqual(b);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §WINDOW — the decision that the list is about THE WEEKEND, not today.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks · the window is the weekend', () => {
  it('pressed on a Tuesday, returns the COMING weekend and not Tuesday', () => {
    const tuesdayThing = kidActivity({
      id: 'tue-1',
      activityName: 'Marble Run',
      venueName: 'Mid-Week Hall',
      startDatetimeUtc: at('2026-09-01', 14),
      endDatetimeUtc: at('2026-09-01', 15),
    });
    const weekendThings = distinctActivities(6).map((l, i) => ({
      ...l,
      startDatetimeUtc: at(NEXT_SAT, 9 + i),
      endDatetimeUtc: at(NEXT_SAT, 10 + i),
    }));

    const result = selectInstantPicks(
      input([tuesdayThing, ...weekendThings], { now: TUESDAY_10AM })
    );

    expect(result.outcome).toBe('picks');
    expect(result.picks.map((p) => p.occurrenceId)).not.toContain('tue-1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §FLOOR — the thin-day behaviour, left deliberately as the selector has it.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks · the floor is not lowered', () => {
  it('does not override floorPicks or maxPicks', () => {
    const select = vi.fn<(i: WeeklyPicksInput) => WeeklyPicks>(() => EMPTY_RESULT);
    selectInstantPicks(input(distinctActivities(6), { select }));
    // Left undefined so the selector applies its own defaults. Handing it a lower floor would skip
    // the widening retry — and that widening is what produces the longer list this button is for.
    expect(select.mock.calls[0][0].floorPicks).toBeUndefined();
    expect(select.mock.calls[0][0].maxPicks).toBeUndefined();
    expect(FLOOR_PICKS).toBe(3);
  });

  it('below the floor it reports an honest empty rather than a short list', () => {
    // Two things on, and the floor is three. Nothing else is reachable to widen into, so the
    // ladder runs out and the answer is "nothing", not "here are two".
    const result = selectInstantPicks(input(distinctActivities(2)));
    expect(result.outcome).toBe('empty');
    expect(result.picks).toHaveLength(0);
    expect(result.emptyReason).not.toBeNull();
  });

  it('does not pass a novelty exclusion — the fuller list may repeat what was texted', () => {
    const select = vi.fn<(i: WeeklyPicksInput) => WeeklyPicks>(() => EMPTY_RESULT);
    selectInstantPicks(input(distinctActivities(6), { select }));
    expect(select.mock.calls[0][0].excludeOccurrenceIds).toBeUndefined();
    expect(select.mock.calls[0][0].excludeSeriesIds).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §OUTCOMES — what the page actually renders.
// ═════════════════════════════════════════════════════════════════════════════
describe('instant picks · outcomes', () => {
  it('returns a ranked list, capped at the selector’s ceiling, with the area label', () => {
    const result = selectInstantPicks(input(distinctActivities(12)));

    expect(result.outcome).toBe('picks');
    expect(result.areaLabel).toBe('Vancouver');
    expect(result.picks.length).toBeGreaterThanOrEqual(FLOOR_PICKS);
    expect(result.picks.length).toBeLessThanOrEqual(MAX_PICKS);
    expect(result.picks.map((p) => p.rank)).toEqual(
      Array.from({ length: result.picks.length }, (_, i) => i + 1)
    );
    for (const pick of result.picks) {
      expect(pick.activityName).toBeTruthy();
      // A PLAIN activity link, never a short link: these picks were never sent, so there is no
      // send for a tap to be attributed to. See `InstantPick.href`.
      expect(pick.href).toBe(`/activity/${pick.occurrenceId}`);
      expect(pick.href).not.toMatch(/^\/s\//);
    }
  });

  it('is a FULLER list than the three-item panel it sits under', () => {
    // The whole ask. Twelve distinct things on, so the selector has room to run past three.
    const result = selectInstantPicks(input(distinctActivities(12)));
    expect(result.picks.length).toBeGreaterThan(3);
  });

  it('an out-of-area postal is `unavailable`, never `empty`', () => {
    // V3L is New Westminster — deliberately absent from FSA_REGION, so it resolves to no origin.
    // "We could not check" and "there is nothing on" are different claims about the catalogue, and
    // reporting the first as the second tells a parent their weekend is empty about a search that
    // never ran.
    const result = selectInstantPicks(
      input(distinctActivities(12), { subscriber: { postalCode: 'V3L 1A1', birthYears: [2018] } })
    );
    expect(result.outcome).toBe('unavailable');
    expect(result.areaLabel).toBeNull();
    expect(result.picks).toHaveLength(0);
  });

  it('a purged row (no postal code) is `unavailable` rather than a throw', () => {
    const result = selectInstantPicks(
      input(distinctActivities(12), { subscriber: { postalCode: null, birthYears: [] } })
    );
    expect(result.outcome).toBe('unavailable');
  });

  it('reports the selector’s own degradation rather than inferring it', () => {
    const select = () => ({ ...EMPTY_RESULT, retried: true, interestsDropped: true });
    const result = selectInstantPicks(input([], { select }));
    expect(result.widened).toBe(true);
    expect(result.interestsDropped).toBe(true);
  });
});

// ── Fixtures for the stubbed-selector tests ──────────────────────────────────
const BASE: WeeklyPicks = {
  outcome: 'empty',
  picks: [],
  emptyReason: 'nothing_reached',
  ageBands: [],
  ageAware: false,
  degradation: 'none',
  retried: false,
  interestsDropped: false,
  radiusKmUsed: 10,
  reached: { primary: 0, retry: null },
  forcedPicks: [],
  deduped: 0,
  novelExcluded: 0,
  diversity: {} as WeeklyPicks['diversity'],
  shouldPause: false,
};
const EMPTY_RESULT: WeeklyPicks = BASE;
