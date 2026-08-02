// tests/preview-registration-mapping.test.ts — QA round 139 F1.
//
// `mapSearchItemToActivity` reaches its registration verdict by TWO different routes, and
// they must agree:
//   • LIST path   — the engine already computed it and supplies `item.registrationRequired`.
//   • DETAIL path — no engine result to hand, so it recomputes locally via isRegistrationShaped.
// The detail path takes an explicit subset of the listing. Dropping `registrationRequired`
// from that subset makes the detail page silently fall back to the TITLE HEURISTIC while the
// card it was opened from used the persisted FACT — so a card reading "Registration required"
// opens a page that does not, or worse, a drop-in card opens a page that says you must book.
// That mutation survived every prior test.
import { describe, expect, it } from 'vitest';
import { mapListingRecordToActivity, mapSearchItemToActivity } from '../app/preview/_data/search-api';
import { makeListing } from '../lib/search/__fixtures__/factory';

/** A drop-in-SHAPED title the source says you MUST register for — the disagreeing case. */
const factSaysRegister = makeListing({
  activityName: 'Baby Storytime',
  registrationRequired: true,
  statusState: 'confirmed',
  sourceUrl: 'https://example.org/e/1',
});

/** A course-SHAPED title the source says you need NOT register for. */
const factSaysDropIn = makeListing({
  activityName: 'Skating Level 1',
  registrationRequired: false,
  statusState: 'confirmed',
  sourceUrl: 'https://example.org/e/2',
});

/** The silent majority — the heuristic still decides. */
const sourceSilent = makeListing({
  activityName: 'Frozen Ballet Dance Camp 3-5yrs',
  registrationRequired: null,
  statusState: 'confirmed',
  sourceUrl: 'https://example.org/e/3',
});

describe('registration verdict — list and detail paths agree', () => {
  it.each([
    ['fact says register, title says drop-in', factSaysRegister, true],
    ['fact says drop-in, title says course', factSaysDropIn, false],
    ['source silent, heuristic decides', sourceSilent, true],
  ])('%s', (_label, listing, expected) => {
    // DETAIL path: recomputed locally from the listing alone.
    const detail = mapListingRecordToActivity(listing);
    expect(Boolean(detail.registrationRequired)).toBe(expected);

    // LIST path: the engine's own verdict, supplied on the item.
    const list = mapSearchItemToActivity({ listing, distanceKm: null, registrationRequired: expected });
    expect(Boolean(list.registrationRequired)).toBe(expected);

    // The two must never disagree — that is the regression this pins.
    expect(Boolean(detail.registrationRequired)).toBe(Boolean(list.registrationRequired));
  });

  it('the detail path reads the FACT, not just the title', () => {
    // Both titles are unchanged from what the heuristic would see; only the persisted column
    // differs. If the detail path stopped forwarding it, both of these would flip.
    expect(mapListingRecordToActivity(factSaysRegister).registrationRequired).toBe(true);
    expect(mapListingRecordToActivity({ ...factSaysRegister, registrationRequired: null }).registrationRequired).toBeUndefined();

    expect(mapListingRecordToActivity(factSaysDropIn).registrationRequired).toBeUndefined();
    expect(mapListingRecordToActivity({ ...factSaysDropIn, registrationRequired: null }).registrationRequired).toBe(true);
  });
});
