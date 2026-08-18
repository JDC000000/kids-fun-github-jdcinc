// End-to-end result-shaping in the engine: registration opt-in, adult/senior exclusion, and
// same-day collapsing (lib/search/engine.ts).
//
// The unit suites prove each classifier reads a title correctly. This one proves the ENGINE acts
// on them the way Jon asked for: courses gone from the default view but one flag away, adult and
// senior content gone with no flag at all, and repeated slots of one series arriving as one result.

import { describe, expect, it } from 'vitest';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { RegionHierarchy } from '../../lib/geo/region';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { ListingRecord } from '../../lib/search/types';

const NOW = new Date('2026-08-08T18:00:00Z');

function engineOver(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: true,
  });
}

/** minResults: 0 disables the broadening ladder so each test observes the raw filtered set. */
const search = (engine: SearchEngine, q: string, extra = {}) =>
  engine.search({ q, now: NOW, minResults: 0, ...extra });

const swim = makeListing({
  id: 'swim',
  activityName: 'Public Swim Delbrook Whole Pool',
  primaryCategoryKey: 'public_swim',
  startDatetimeUtc: '2026-08-08T20:30:00Z',
  endDatetimeUtc: '2026-08-08T23:00:00Z',
});
const course = makeListing({
  id: 'course',
  activityName: 'Intro to Hockey (8-12yrs)',
  primaryCategoryKey: 'public_swim', // same category so both match the same query text
  startDatetimeUtc: '2026-08-08T21:00:00Z',
  endDatetimeUtc: '2026-08-08T22:00:00Z',
});
const adult = makeListing({
  id: 'adult',
  activityName: 'Adult 19yrs+ Swim Karen Magnussen',
  primaryCategoryKey: 'public_swim',
  startDatetimeUtc: '2026-08-08T21:30:00Z',
  endDatetimeUtc: '2026-08-08T22:30:00Z',
});
const parentAndChild = makeListing({
  id: 'parent-child',
  activityName: 'Adult / Early Years (0-6years) Swim Karen Magnussen',
  primaryCategoryKey: 'public_swim',
  startDatetimeUtc: '2026-08-08T22:00:00Z',
  endDatetimeUtc: '2026-08-08T23:30:00Z',
});

describe('registration content is opt-in and off by default', () => {
  const engine = engineOver([swim, course, adult, parentAndChild]);

  it('leaves registration courses out of the default results entirely', () => {
    const ids = search(engine, 'swim').results.map((r) => r.listing.id);
    expect(ids).toContain('swim');
    expect(ids).not.toContain('course');
  });

  it('brings them back — labelled — when the parent opts in', () => {
    const res = search(engine, 'swim', { includeRegistration: true });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids).toContain('course');
    expect(ids).toContain('swim'); // opting in only ever ADDS; nothing is traded away

    // Clearly marked, so a course never blends in silently with the drop-in results.
    expect(res.results.find((r) => r.listing.id === 'course')?.registrationRequired).toBe(true);
    expect(res.results.find((r) => r.listing.id === 'swim')?.registrationRequired).toBe(false);
  });

  it('keeps registration content out of the expected section too', () => {
    // A course is no more "what's on today" for being seasonal, so the exclusion is not
    // primary-list-only.
    const seasonalCourse = makeListing({
      id: 'seasonal-course',
      activityName: 'Frozen Ballet Summer Camp (3-5yrs)',
      primaryCategoryKey: 'public_swim',
      statusState: 'seasonal_preseason',
      startDatetimeUtc: '2026-08-08T21:00:00Z',
    });
    const withSeasonal = engineOver([swim, seasonalCourse]);
    const hidden = withSeasonal.search({ q: 'swim', now: NOW, minResults: 99 });
    expect(hidden.expected.map((r) => r.listing.id)).not.toContain('seasonal-course');

    const shown = withSeasonal.search({ q: 'swim', now: NOW, minResults: 99, includeRegistration: true });
    expect(shown.expected.map((r) => r.listing.id)).toContain('seasonal-course');
  });
});

describe('adult/senior-only content never appears', () => {
  const engine = engineOver([swim, course, adult, parentAndChild]);

  it('is excluded from the default view', () => {
    expect(search(engine, 'swim').results.map((r) => r.listing.id)).not.toContain('adult');
  });

  it('stays excluded even with the registration filter turned on — it has no opt-in', () => {
    // This is a hard exclusion, not an opt-in: adult programming is not this product's content.
    const ids = search(engine, 'swim', { includeRegistration: true }).results.map((r) => r.listing.id);
    expect(ids).not.toContain('adult');
  });

  it('keeps parent-and-child sessions, even though they say "Adult"', () => {
    expect(search(engine, 'swim').results.map((r) => r.listing.id)).toContain('parent-child');
  });

  it('excludes an adult talk whose ONLY adult signal is the source\'s own audience tag', () => {
    // The reported severity-3 bug, reproduced at engine level with the live row's exact shape:
    // an adult harm-reduction talk with no adult word in the title and NO parsed age, so its
    // ageBandMatches is empty and matchesAge's "unknown → don't hide" rule admits it to every
    // age band — including a parent's search for a 2-4 year-old. The library's audience
    // taxonomy is the only thing that ever said who it was for.
    const overdose = makeListing({
      id: 'overdose',
      activityName: 'Supporting People Together: The Basics of Overdose Response',
      primaryCategoryKey: 'public_swim', // shares the query text so it competes with `swim`
      startDatetimeUtc: '2026-08-08T21:00:00Z',
      endDatetimeUtc: '2026-08-08T22:00:00Z',
      ageBandMatches: [],
      ageMinMonths: null,
      ageMaxMonths: null,
      ageNotes:
        'unresolved: International Overdose Awareness Day, Health, Life Skills and Personal Growth, Adults, English',
    });
    const withTalk = engineOver([swim, parentAndChild, overdose]);

    expect(search(withTalk, 'swim').results.map((r) => r.listing.id)).not.toContain('overdose');
    // …and specifically not in the age-filtered search the bug was reported against. Asserted
    // across BOTH primary sections, because the exclusion is a HARD one: an adult harm-reduction
    // talk must not reach a toddler search under any heading, and the age split added a second
    // place a listing can surface. Excluding it from `results` alone would be the audience filter
    // regressing into a re-heading.
    const forToddlers = search(withTalk, 'swim', { ageBands: ['2-4'] as const });
    const toddlerPrimary = [...forToddlers.results, ...forToddlers.ageUnconfirmed].map((r) => r.listing.id);
    expect(toddlerPrimary).not.toContain('overdose');

    // The parent-and-child session in the same result set is untouched — this exclusion is
    // narrow, not a blanket "anything mentioning adults". It is still REACHABLE…
    expect(toddlerPrimary).toContain('parent-child');
    // …and it lands under the age-not-stated heading rather than among the confirmed 2–4
    // matches, which is the correct answer for THIS fixture: its title says "0-6years" but its
    // `ageBandMatches` is empty, so nothing in the record establishes the band. That is the
    // whole point of the split (Jon's ruling 2026-08-18, option b) — the listing is offered,
    // honestly labelled, instead of being either hidden or presented as a confirmed match.
    expect(forToddlers.results.map((r) => r.listing.id)).not.toContain('parent-child');
    expect(forToddlers.ageUnconfirmed.map((r) => r.listing.id)).toContain('parent-child');

    // Give the same listing the band its title implies and it moves to the confirmed section —
    // the split follows the DATA, not the fixture's identity.
    const withBand = engineOver([
      swim,
      makeListing({ ...parentAndChild, ageBandMatches: ['2-4'] }),
      overdose,
    ]);
    const banded = search(withBand, 'swim', { ageBands: ['2-4'] as const });
    expect(banded.results.map((r) => r.listing.id)).toContain('parent-child');
    expect(banded.ageUnconfirmed.map((r) => r.listing.id)).not.toContain('parent-child');
  });
});

describe('same-series-same-day occurrences arrive as one result', () => {
  const slots = [0, 15, 30, 45, 60].map((offsetMin, i) =>
    makeListing({
      id: `piano-${i}`,
      seriesId: 'forte-piano',
      activityName: 'Forte Piano Practice Room',
      primaryCategoryKey: 'public_swim',
      startDatetimeUtc: new Date(Date.UTC(2026, 7, 8, 22, 15 + offsetMin)).toISOString(),
      endDatetimeUtc: new Date(Date.UTC(2026, 7, 8, 22, 30 + offsetMin)).toISOString(),
    }),
  );
  const engine = engineOver([...slots, swim]);

  it('renders five slots of one series as a single card carrying all five', () => {
    const res = search(engine, 'swim');
    const piano = res.results.filter((r) => r.listing.seriesId === 'forte-piano');
    expect(piano).toHaveLength(1);
    expect(piano[0].slots).toHaveLength(5);
    expect(piano[0].slots.map((s) => s.id)).toEqual(['piano-0', 'piano-1', 'piano-2', 'piano-3', 'piano-4']);
  });

  it('reports the closing edge of the whole span, not of the first slot', () => {
    const piano = search(engine, 'swim').results.find((r) => r.listing.seriesId === 'forte-piano');
    expect(piano?.slotSpanEndUtc).toBe(new Date(Date.UTC(2026, 7, 8, 23, 30)).toISOString());
  });

  it('counts collapsed CARDS in `total`, not repeated slots', () => {
    // Six occurrences in the repository; a parent sees two things.
    expect(search(engine, 'swim').total).toBe(2);
  });

  it('gives an uncollapsed result a one-slot list, so consumers need no special case', () => {
    const single = search(engine, 'swim').results.find((r) => r.listing.id === 'swim');
    expect(single?.slots).toHaveLength(1);
    expect(single?.slots[0].id).toBe('swim');
  });
});
