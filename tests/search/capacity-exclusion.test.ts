// Capacity exclusion — `full` and `waitlist` never reach a parent (Jon, 2026-09-03).
//
// THE RULE: a session with no spot left is not an answer to "what can I take my kid to". It was
// previously `primary` — shown in the result list wearing its own "Full" stamp — on the argument
// that a labelled row is an honest row. Jon's ruling is that honest and useful are different
// tests, and a parent scanning results should not be asked to read past rows they cannot act on.
//
// THIS GUARD IS AHEAD OF THE DATA. No connector detects capacity yet: `status_state` has never
// been set to either value on a live occurrence (0 of ~22,318 measured 2026-09-03). The point of
// landing it now is that whichever connector learns to set it cannot ship full sessions into
// results as a side effect of starting to tell the truth about capacity.
//
// WHY THE ASSERTIONS ARE SPREAD OVER THREE LAYERS. The exclusion is expressed ONCE, in
// STATUS_CLASS, and reaches production down two different paths: HIDDEN_STATUSES is passed to the
// read model's SQL (`o.status_state::text <> ALL($1)`), while `isHidden` runs in the in-memory
// engine that backs the fixture path. A test that only checked the table would not notice either
// consumer being bypassed, and one that only searched would not notice the SQL parameter losing
// a value. The weekly SMS lane is checked too, on a stricter rule it already had.
//
// Synthesized listings, never the shared catalogue fixtures: a rule whose whole effect is to
// REMOVE rows from the catalogue cannot be honestly demonstrated with rows other suites are
// simultaneously counting.

import { describe, expect, it } from 'vitest';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { RegionHierarchy } from '../../lib/geo/region';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import { STATUS_CLASS, HIDDEN_STATUSES, isHidden, isPrimaryResult } from '../../lib/search/filters/status';
import { isShowableOnFrontDoor } from '../../lib/recommend/three-things';
import type { ListingRecord, StatusState } from '../../lib/search/types';

const NOW = new Date('2026-08-08T18:00:00Z');
const CAPACITY: StatusState[] = ['full', 'waitlist'];

function swimAt(id: string, statusState: StatusState): ListingRecord {
  return makeListing({
    id,
    activityName: 'Public Swim Delbrook Whole Pool',
    primaryCategoryKey: 'public_swim',
    startDatetimeUtc: '2026-08-08T20:30:00Z',
    endDatetimeUtc: '2026-08-08T23:00:00Z',
    statusState,
    // REQUIRED, and the vacuity check below is why it is here. isShowableOnFrontDoor also
    // demands a known minimum age; the factory defaults ageMinMonths to null, so without this
    // the weekly-pick assertions would have passed on the age gate while proving nothing at all
    // about capacity.
    ageMinMonths: 60,
    ageMaxMonths: 144,
  });
}

const engineOver = (listings: ListingRecord[]) =>
  new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: true,
  });

describe('the classification itself', () => {
  for (const status of CAPACITY) {
    it(`${status} is hidden, not primary`, () => {
      expect(STATUS_CLASS[status]).toBe('hidden');
      expect(isHidden({ statusState: status } as ListingRecord)).toBe(true);
      expect(isPrimaryResult({ statusState: status } as ListingRecord)).toBe(false);
    });

    it(`${status} reaches the SQL read model's exclusion list`, () => {
      // HIDDEN_STATUSES is the literal parameter bound to `o.status_state::text <> ALL($1)`.
      expect(HIDDEN_STATUSES).toContain(status);
    });
  }
});

describe('search results — the first choke point', () => {
  it('returns a bookable session and drops the full and waitlisted ones beside it', () => {
    const engine = engineOver([
      swimAt('open', 'confirmed'),
      swimAt('full', 'full'),
      swimAt('waitlisted', 'waitlist'),
    ]);
    const ids = engine.search({ q: 'public swim', now: NOW, minResults: 0 }).results.map((r) => r.listing.id);
    expect(ids).toContain('open');
    expect(ids).not.toContain('full');
    expect(ids).not.toContain('waitlisted');
  });

  it('does not push them into the broadening section instead of the list', () => {
    // The failure mode worth naming: 'expected' would have moved them rather than removed them,
    // and they would have come back the moment a thin result set triggered the ladder.
    const engine = engineOver([swimAt('full', 'full'), swimAt('waitlisted', 'waitlist')]);
    const response = engine.search({ q: 'public swim', now: NOW });
    const everything = JSON.stringify(response);
    expect(everything).not.toContain('"full"');
    expect(everything).not.toContain('"waitlisted"');
  });

  it('leaves an empty result set rather than a full one', () => {
    const engine = engineOver([swimAt('full', 'full')]);
    expect(engine.search({ q: 'public swim', now: NOW, minResults: 0 }).results).toHaveLength(0);
  });
});

describe('weekly SMS picks — the second choke point', () => {
  // Already excluded before this change, by a strictly stronger rule: the weekly builder filters
  // on isShowableOnFrontDoor, which admits only `confirmed` and `bookable_open`. Pinned here so
  // the two lanes are proven together rather than assumed to agree.
  for (const status of CAPACITY) {
    it(`${status} is not showable as a weekly pick`, () => {
      expect(isShowableOnFrontDoor(swimAt('x', status))).toBe(false);
    });
  }

  it('still admits a bookable session, so the gate is not vacuously false', () => {
    expect(isShowableOnFrontDoor(swimAt('x', 'confirmed'))).toBe(true);
  });
});
