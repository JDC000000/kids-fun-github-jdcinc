// app/search/_lib/broadening-alternatives.test.ts
//
// `describeBroadeningAlternatives` turns the engine's per-rung counts (lib/search/broaden.ts's
// `BroadenAlternative`) into clickable /search chips. Two things must hold for every chip that
// DOES render: it must be something the parent has not already gotten (not `applied`), and its
// href must actually LAND on the context whose count is being advertised — a chip that says "7
// results" and links somewhere else is the same defect this feature exists to close. And some
// rungs must render NO chip at all — see broadening-alternatives.ts's header for why.
import { describe, expect, it } from 'vitest';
import { describeBroadeningAlternatives } from './broadening-alternatives';
import { DEFAULT_STATE, type SearchState } from './params';
import type { BroadenAlternative } from '@/lib/search/broaden';

/** A minimal, mostly-empty SearchContext — only the fields a given rung actually reads. */
function ctx(patch: Partial<BroadenAlternative['context']> = {}): BroadenAlternative['context'] {
  return {
    raw: '',
    terms: [],
    date: null,
    timeOfDay: null,
    ageBands: [],
    radiusKm: 10,
    nearMe: false,
    costFree: false,
    includeRegistration: false,
    bookableNow: false,
    rainyDay: false,
    dropIn: false,
    widenText: false,
    timeOfDayAdjacent: false,
    includeExpected: false,
    sort: 'best_match',
    ...patch,
  } as BroadenAlternative['context'];
}

function alt(patch: Partial<BroadenAlternative>): BroadenAlternative {
  return {
    rung: 1,
    key: 'radius_expand',
    label: 'Expanded distance to 20km',
    count: 7,
    applied: false,
    context: ctx(),
    ...patch,
  };
}

describe('describeBroadeningAlternatives', () => {
  it('DECISIVE: offers nothing when there is nothing to offer', () => {
    expect(describeBroadeningAlternatives(undefined, DEFAULT_STATE)).toEqual([]);
    expect(describeBroadeningAlternatives([], DEFAULT_STATE)).toEqual([]);
  });

  it('DECISIVE: never offers a rung already reflected in the current results', () => {
    const already = alt({ applied: true });
    expect(describeBroadeningAlternatives([already], DEFAULT_STATE)).toEqual([]);
  });

  it('a radius chip links to the widened radius and states the real count', () => {
    const chips = describeBroadeningAlternatives(
      [alt({ key: 'radius_expand', label: 'Expanded distance to 20km', count: 7, context: ctx({ radiusKm: 20 }) })],
      { ...DEFAULT_STATE, lat: 49.28, lng: -123.12 }, // an origin, so `radius` actually lands in the URL
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].text).toBe('Expanded distance to 20km — 7 results');
    expect(chips[0].href).toContain('radius=20');
  });

  it('a date chip carries the widened window as a structured from/to, and clears the When quick-pick', () => {
    const chips = describeBroadeningAlternatives(
      [
        alt({
          key: 'adjacent_date',
          label: 'Included nearby dates (2026-09-11 to 2026-09-17)',
          count: 12,
          context: ctx({ date: { kind: 'range', isoDate: '2026-09-11', endIsoDate: '2026-09-17', weekday: null } }),
        }),
      ],
      { ...DEFAULT_STATE, when: 'weekend' },
    );
    expect(chips[0].href).toContain('from=2026-09-11');
    expect(chips[0].href).toContain('to=2026-09-17');
    expect(chips[0].href).not.toContain('when=weekend');
  });

  it('an age chip carries the widened bands', () => {
    const chips = describeBroadeningAlternatives(
      [alt({ key: 'adjacent_age', label: 'Included adjacent age groups (under2, 2-4)', count: 4, context: ctx({ ageBands: ['under2', '2-4'] }) })],
      DEFAULT_STATE,
    );
    expect(chips[0].href).toContain('age=under2%2C2-4');
  });

  it.each(['bookableNow', 'dropIn', 'rainyDay'] as const)(
    'a drop_chip chip for %s turns exactly that one filter off, reading the CONTEXT — not just its own constraint key',
    (constraint) => {
      // Mirrors what broaden.ts's drop_chip rung actually produces: the cumulative context has
      // ONLY the dropped constraint false; the other two active chips survive at their ORIGINAL
      // (still-true) values in that same context (CHIP_RESTRICTIVENESS drops one at a time).
      const contextPatch = { bookableNow: true, dropIn: true, rainyDay: true, [constraint]: false };
      const chips = describeBroadeningAlternatives(
        [alt({ key: 'drop_chip', constraint, label: `Dropped the ${constraint} filter`, count: 3, context: ctx(contextPatch) })],
        { ...DEFAULT_STATE, bookableNow: true, dropIn: true, rainyDay: true },
      );
      expect(chips).toHaveLength(1);
      const paramFor = { bookableNow: 'bookable', dropIn: 'dropin', rainyDay: 'rainy' } as const;
      expect(chips[0].href).not.toContain(`${paramFor[constraint]}=1`);
      // The other two toggles survive untouched.
      for (const other of (['bookableNow', 'dropIn', 'rainyDay'] as const).filter((c) => c !== constraint)) {
        expect(chips[0].href).toContain(`${paramFor[other]}=1`);
      }
    },
  );

  it('DECISIVE: a not-yet-applied rung carries forward EARLIER-applied widenings, not just its own field', () => {
    // The exact production shape this guards: radius_expand + adjacent_date already fired (and
    // are reflected in the CURRENT results), and drop_chip is offered NEXT in the same cumulative
    // chain — its context carries the widened radius/date too, not just the dropped chip. A chip
    // built from only `{ dropIn: false }` would silently lose that earlier widening and link to a
    // narrower query than the one the count was measured against (the bug this rewrite fixes).
    const cumulative = ctx({
      radiusKm: 20,
      date: { kind: 'range', isoDate: '2026-07-10', endIsoDate: '2026-07-16', weekday: null },
      dropIn: false,
    });
    const chips = describeBroadeningAlternatives(
      [alt({ key: 'drop_chip', constraint: 'dropIn', label: 'Dropped the Drop-in filter', count: 14, context: cumulative })],
      { ...DEFAULT_STATE, lat: 49.28, lng: -123.12, dropIn: true, dateFrom: '2026-07-13', dateTo: '2026-07-13' },
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].href).toContain('radius=20');
    expect(chips[0].href).toContain('from=2026-07-10');
    expect(chips[0].href).toContain('to=2026-07-16');
    expect(chips[0].href).not.toContain('dropin=1');
  });

  it('DECISIVE: never offers to drop the Free filter — broaden.ts never puts it in a drop_chip rung, but this is a second, independent guard', () => {
    const chips = describeBroadeningAlternatives(
      [alt({ key: 'drop_chip', constraint: 'costFree', label: 'Dropped the Free filter', count: 9 })],
      { ...DEFAULT_STATE, free: true },
    );
    expect(chips).toEqual([]);
  });

  it('DECISIVE: renders no chip for synonym_widen / expected_section — never a real link', () => {
    for (const key of ['synonym_widen', 'expected_section'] as const) {
      const chips = describeBroadeningAlternatives([alt({ key, label: 'irrelevant', count: 99 })], DEFAULT_STATE);
      expect(chips, `${key} rendered a chip it cannot honestly deliver`).toEqual([]);
    }
  });

  it('DECISIVE: renders no chip for adjacent_time — and for ANY later alternative whose cumulative context still carries the adjacency', () => {
    // adjacent_time itself: buildBroadeningLadder always sets timeOfDayAdjacent true on its OWN
    // rung's context (broaden.ts) — there is no URL param for it, so no chip.
    const adjacentTimeAlt = alt({
      key: 'adjacent_time',
      label: 'Included adjacent times of day',
      count: 8,
      context: ctx({ timeOfDay: 'morning', timeOfDayAdjacent: true }),
    });
    // A LATER rung offered in the same cumulative chain (e.g. drop_chip) still carries that same
    // adjacency forward in ITS context too — it must be excluded for the identical reason, even
    // though its own key is perfectly URL-representable.
    const laterAlt = alt({
      key: 'drop_chip',
      constraint: 'dropIn',
      label: 'Dropped the Drop-in filter',
      count: 9,
      context: ctx({ timeOfDay: 'morning', timeOfDayAdjacent: true, dropIn: false }),
    });
    expect(describeBroadeningAlternatives([adjacentTimeAlt, laterAlt], DEFAULT_STATE)).toEqual([]);
  });

  it('a date rung with no usable window renders nothing rather than a broken link', () => {
    const chips = describeBroadeningAlternatives(
      [alt({ key: 'adjacent_date', label: 'Included nearby dates', count: 5, context: ctx({ date: null }) })],
      DEFAULT_STATE,
    );
    expect(chips).toEqual([]);
  });

  it('preserves the rest of the current state alongside the widened field', () => {
    const state: SearchState = { ...DEFAULT_STATE, q: 'swim', regions: ['van'] };
    const chips = describeBroadeningAlternatives(
      [alt({ key: 'radius_expand', label: 'Expanded distance to 20km', count: 7, context: ctx({ radiusKm: 20 }) })],
      { ...state, lat: 49.28, lng: -123.12 },
    );
    expect(chips[0].href).toContain('q=swim');
    expect(chips[0].href).toContain('region=van');
  });
});
