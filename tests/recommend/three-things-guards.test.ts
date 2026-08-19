// T2 and T3 — the two rulings that this feature can violate SILENTLY, and their controls.
//
// Both guards are written the way tonight's other drift guards had to be rewritten
// (b46de05): an assertion that looks right is not evidence. Each invariant here is paired with a
// POSITIVE CONTROL that plants the violation and shows the check catching it — because a test of
// the form "the bad thing is not in the output" passes just as happily when the bad thing was
// never in the input, and both of these rules are about inputs that only appear on thin days or
// once a parent has entered an age.

import { describe, expect, it } from 'vitest';
import { SearchEngine, type SearchRequest } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { FixtureAliasResolver } from '@/lib/search/expand';
import { RegionHierarchy } from '@/lib/geo/region';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { REGIONS } from '@/lib/search/__fixtures__/regions';
import { ALIAS_SEED } from '@/lib/search/__fixtures__/aliases';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import type { ListingRecord } from '@/lib/search/types';
import { buildSlotRequests, filledSlots, selectThreeThings, type ThreeThingsInput } from '@/lib/recommend/three-things';

const NOW = FIXTURE_NOW; // 2026-07-13T19:00:00Z — noon local
const TODAY = { startDatetimeUtc: '2026-07-13T21:00:00.000Z', endDatetimeUtc: '2026-07-13T22:00:00.000Z' };
const TOMORROW = { startDatetimeUtc: '2026-07-14T21:00:00.000Z', endDatetimeUtc: '2026-07-14T22:00:00.000Z' };
const FREE = { costStatus: 'free' as const, costMinCad: 0, costMaxCad: 0 };
const DOWNTOWN = { lat: 49.2827, lng: -123.1207 };

function listing(over: Partial<ListingRecord> & { id: string }): ListingRecord {
  return makeListing({
    seriesId: `${over.id}-series`,
    activityName: 'Story Time',
    venueName: 'Sunset Community Centre',
    ageMinMonths: 60,
    ageMaxMonths: 144,
    ageBandMatches: ['5-9'],
    geo: DOWNTOWN,
    ...FREE,
    ...TODAY,
    ...over,
  });
}

function engineOf(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
  });
}

/** Records every request the module actually puts to the engine. */
class RecordingEngine extends SearchEngine {
  readonly seen: SearchRequest[] = [];
  search(req: SearchRequest) {
    this.seen.push(req);
    return super.search(req);
  }
}

function recordingEngineOf(listings: ListingRecord[]): RecordingEngine {
  return new RecordingEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    geocoder: fsaGeocoder,
  });
}

const input = (engine: SearchEngine, over: Partial<ThreeThingsInput> = {}): ThreeThingsInput => ({
  engine,
  now: NOW,
  origin: { geo: DOWNTOWN, label: 'downtown Vancouver' },
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — the broadening ladder is NEVER used to fill a slot (ruling 7.5, design §2c)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CHECK ITSELF, extracted so it can be run against a deliberately broken input.
 *
 * Explicitly `=== 0` rather than falsy: `minResults: undefined` is not a zero. The engine reads
 * `req.minResults ?? 3`, so an OMITTED minimum arms the ladder at 3 — the single easiest way for
 * a future edit to reintroduce this defect is to drop the field rather than to set it wrong.
 */
function assertDeclinesBroadening(requests: Array<{ key: string; request: SearchRequest }>): void {
  expect(requests.length).toBeGreaterThan(0);
  for (const { key, request } of requests) {
    expect({ key, minResults: request.minResults }).toEqual({ key, minResults: 0 });
  }
}

describe('T2 — every request this feature issues declines the broadening ladder', () => {
  it('holds for every slot the module builds, with and without an origin', () => {
    const engine = engineOf([listing({ id: 'a' })]);
    assertDeclinesBroadening(buildSlotRequests(input(engine)));
    assertDeclinesBroadening(buildSlotRequests(input(engine, { origin: null })));
    assertDeclinesBroadening(buildSlotRequests(input(engine, { ageBands: ['2-4'] })));
  });

  it('holds for every request that actually reaches the engine, not just the ones we can name', () => {
    // buildSlotRequests is pure and enumerable, but a future edit could put a request to the
    // engine from somewhere else in the module. This watches the seam itself.
    const engine = recordingEngineOf([listing({ id: 'a' })]);
    selectThreeThings(input(engine));
    expect(engine.seen.length).toBe(3);
    assertDeclinesBroadening(engine.seen.map((request, i) => ({ key: `call-${i}`, request })));
  });

  it('POSITIVE CONTROL — the check fails when a non-zero minimum is planted', () => {
    const engine = engineOf([listing({ id: 'a' })]);
    const mutated = buildSlotRequests(input(engine)).map(({ key, request }) => ({
      key,
      request: { ...request, minResults: 6 },
    }));
    expect(() => assertDeclinesBroadening(mutated)).toThrow();

    // …and the omission case, which is the one a reviewer's eye slides over.
    const omitted = buildSlotRequests(input(engine)).map(({ key, request }) => {
      const { minResults: _dropped, ...rest } = request;
      return { key, request: rest as SearchRequest };
    });
    expect(() => assertDeclinesBroadening(omitted)).toThrow();
  });

  it('and this is what the guard actually prevents, measured through the real engine', () => {
    // A day with nothing on it, and a listing tomorrow. This is §2c's defect in miniature: the
    // ladder relaxes DATES first, so a non-zero minimum prints tomorrow under a heading that
    // says today.
    const catalogue = [listing({ id: 'tomorrow-only', ...TOMORROW })];
    const request = buildSlotRequests(input(engineOf(catalogue), { origin: null }))[0].request;

    const honest = engineOf(catalogue).search(request);
    expect(honest.broadening.applied).toEqual([]);
    expect(honest.results).toEqual([]);

    // CONTROL: the same query, the same catalogue, with the ladder armed — it broadens the date
    // and hands back tomorrow's listing, which is precisely the card a parent must never be shown
    // under "on today".
    const broadened = engineOf(catalogue).search({ ...request, minResults: 3 });
    expect(broadened.broadening.applied.length).toBeGreaterThan(0);
    expect(broadened.results.map((r) => r.listing.id)).toContain('tomorrow-only');

    // And end-to-end: the slot stays honestly empty rather than filling itself from tomorrow.
    const three = selectThreeThings(input(engineOf(catalogue), { origin: null }));
    expect(filledSlots(three)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The indoor slot is CITYWIDE — the code-side half of "ensure there are no non-empty results"
// ─────────────────────────────────────────────────────────────────────────────
describe('the indoor slot asks about the whole city, not about the nearby radius', () => {
  it('sends no origin and no radius on the indoor request — only the nearby slot is located', () => {
    // THIS IS THE REGRESSION THAT EMPTIES THE SLOT, and it is a one-line edit away at all times.
    // Measured 2026-08-19: indoor citywide reached 6 cards of which 4 were showable; indoor
    // within 5 km of downtown reached 2, BOTH with `ageMinMonths: null`, so the located version
    // of this slot was empty on the very afternoon the ruling was made. Jon chose citywide for
    // that reason. `scripts/three-things-pool-probe.sh` watches the live pool; this watches the
    // decision, which is the part a future edit can undo without noticing.
    const requests = buildSlotRequests(input(engineOf([listing({ id: 'a' })])));
    const byKey = Object.fromEntries(requests.map((r) => [r.key, r.request]));

    expect(byKey.indoor.rainyDay).toBe(true);
    expect(byKey.indoor.origin).toBeUndefined();
    expect(byKey.indoor.radiusKm).toBeUndefined();

    expect(byKey.free.origin).toBeUndefined();
    expect(byKey.free.radiusKm).toBeUndefined();

    // …and the nearby slot is the ONLY one that carries the parent's location, which is also what
    // scopes the "near downtown Vancouver" wording to that slot alone (Jon's ruling on the copy).
    expect(byKey.nearby.origin).toEqual({ mode: 'near_me', coords: DOWNTOWN });
    expect(byKey.nearby.radiusKm).toBe(5);
  });

  it('so an indoor card may legitimately be further away than the nearby one', () => {
    // The consequence of the ruling, pinned so it reads as intended rather than as a bug: the
    // indoor slot can hold a card outside the radius while the nearby slot holds one inside it.
    const rows = [
      listing({ id: 'far-indoor', activityName: 'Play Palace', suitabilityTags: ['indoor'], geo: { lat: 49.2, lng: -123.05 } }),
      listing({ id: 'close', activityName: 'Open Gym', geo: DOWNTOWN }),
    ];
    const three = selectThreeThings(input(engineOf(rows)));
    const picked = Object.fromEntries(
      three.slots.map((s) => [s.key, s.state === 'filled' ? s.item.listing.id : null]),
    );
    expect(picked.indoor).toBe('far-indoor');
    expect(picked.nearby).toBe('close');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — no slot is ever filled from the age-unconfirmed set (ruling 7.6, design §5b)
// ─────────────────────────────────────────────────────────────────────────────
describe('T3 — slots never draw from the age-unconfirmed set', () => {
  /**
   * A row that lands in `ageUnconfirmed` while PASSING the front-door age gate.
   *
   * This shape is what makes the test non-vacuous, and it takes some care to build. The engine
   * splits on `ageBandMatches` (`hasConfirmedAgeMatch`), while the front-door gate reads
   * `ageMinMonths`. A row with no age data at all fails the gate first, so it would prove
   * nothing about the split — the gate would be doing all the work and the rule under test would
   * never be reached. With bands empty but a real `ageMinMonths`, the ONLY thing keeping this row
   * out of a slot is ruling 7.6.
   */
  const UNCONFIRMED = listing({ id: 'unconfirmed', activityName: 'Open Gym', ageBandMatches: [] });
  const CONFIRMED = listing({ id: 'confirmed-2-4', activityName: 'Play Palace', ageBandMatches: ['2-4'], ageMinMonths: 24, ageMaxMonths: 48 });

  it('NON-VACUITY — under an age filter the row really is reachable, in ageUnconfirmed', () => {
    // If this stops holding, every assertion below is testing an empty set.
    const response = engineOf([UNCONFIRMED, CONFIRMED]).search({
      q: '',
      now: NOW,
      when: 'today',
      free: true,
      ageBands: ['2-4'],
      minResults: 0,
    });
    expect(response.ageUnconfirmed.map((r) => r.listing.id)).toEqual(['unconfirmed']);
    expect(response.results.map((r) => r.listing.id)).toEqual(['confirmed-2-4']);
    // …and it clears the front-door age gate, so nothing but ruling 7.6 excludes it.
    expect(UNCONFIRMED.ageMinMonths).not.toBeNull();
  });

  it('fills from the confirmed row and never the unconfirmed one', () => {
    const three = selectThreeThings(input(engineOf([UNCONFIRMED, CONFIRMED]), { ageBands: ['2-4'] }));
    const picked = filledSlots(three).map((s) => s.item.listing.id);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked).not.toContain('unconfirmed');
    expect(three.ageAware).toBe(true);
  });

  it('leaves the slot EMPTY rather than reaching into ageUnconfirmed to fill it', () => {
    // The sharpest version: the unconfirmed row is the only thing on today. A slot that filled
    // itself here would be claiming an age match the catalogue never made.
    const three = selectThreeThings(input(engineOf([UNCONFIRMED]), { ageBands: ['2-4'], origin: null }));
    expect(filledSlots(three)).toEqual([]);

    // CONTROL: it is genuinely there to be taken — `total` counts both primary sections, so the
    // slot reports `none_showable` ("we found something and declined it"), not `nothing_on`.
    const free = three.slots.find((s) => s.key === 'free')!;
    expect(free.state).toBe('empty');
    if (free.state === 'empty') {
      expect(free.reason).toBe('none_showable');
      expect(free.reached).toBe(1);
    }
  });

  it('WHY THIS GUARD MUST SELECT AN AGE — with none selected the rule is vacuously true', () => {
    // splitAgeUnconfirmed returns everything as `scored` when no band is selected, so
    // `ageUnconfirmed` is ALWAYS empty for an anonymous visitor — the default case. A guard
    // written only against that path would pass on an implementation that reads the array
    // freely. This is the assertion that documents the trap rather than falling into it.
    const anonymous = engineOf([UNCONFIRMED, CONFIRMED]).search({
      q: '',
      now: NOW,
      when: 'today',
      free: true,
      minResults: 0,
    });
    expect(anonymous.ageUnconfirmed).toEqual([]);
    expect(anonymous.results.map((r) => r.listing.id)).toEqual(expect.arrayContaining(['unconfirmed']));

    // …and the pre-age surface says so about itself, which is what ruling 7.6's copy hangs off.
    const three = selectThreeThings(input(engineOf([UNCONFIRMED, CONFIRMED])));
    expect(three.ageAware).toBe(false);
  });
});
