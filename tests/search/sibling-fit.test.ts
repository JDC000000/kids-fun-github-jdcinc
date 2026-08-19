// tests/search/sibling-fit.test.ts — the exact per-child age predicate, and the unsound
// shortcut it exists to replace.
//
// WHAT THIS FILE IS FOR. `fitsChild`/`fitsAllChildren` (lib/search/filters/age.ts) answer "does
// this ONE listing work for THIS child", and the composition answers "for BOTH of them". Nothing
// consumes them yet — the surface that will (section, badge or filter) is still an open product
// question — so this suite is the whole of their verification, and it is written to fail loudly
// if a later hand replaces them with the obvious-looking band composition.
//
// THE ONE CASE THAT MATTERS MOST is the first describe block: a listing titled "Ages 4-5" claims
// BOTH the `2-4` and `5-9` bands under `computeAgeBandMatches`'s overlap semantics, so a
// band-level AND would report it as fitting a 3-year-old AND a 7-year-old when it fits neither.
// That test asserts the band claim and the truth SIDE BY SIDE on the same fixture, on purpose:
// the point is not that the predicate says false, it is that the predicate says false about the
// exact listing the cheap alternative says true about. `computeAgeBandMatches` is imported here
// as the thing being contrasted with, NOT as something under test — its overlap semantics are
// correct for its own callers (`matchesAge`, `ageMatchScore`, OR across the parent's selected
// bands) and are deliberately untouched.
//
// The second theme is vacuity. Two different ways of claiming a fit out of nothing — a listing
// with no stated bounds, and a call with no children — both have to fail closed, and neither is
// caught by any other suite.

import { describe, expect, it } from 'vitest';
import { fitsAllChildren, fitsChild } from '../../lib/search/filters/age';
import { computeAgeBandMatches, type AgeBandRow } from '../../worker/core/age';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { AgeBandKey } from '../../lib/search/types';

/** The seeded taxonomy, in the shape `computeAgeBandMatches` reads (supabase/seeds/age_bands.sql). */
const BANDS: AgeBandRow[] = [
  { id: 'under2', key: 'under2', lowerMonthsInclusive: 0, upperMonthsExclusive: 24 },
  { id: '2-4', key: '2-4', lowerMonthsInclusive: 24, upperMonthsExclusive: 60 },
  { id: '5-9', key: '5-9', lowerMonthsInclusive: 60, upperMonthsExclusive: 120 },
  { id: '10-14', key: '10-14', lowerMonthsInclusive: 120, upperMonthsExclusive: 180 },
  { id: '15+', key: '15+', lowerMonthsInclusive: 180, upperMonthsExclusive: null },
];

/** The design doc's two worked children: Maya is 3, Sam is 7. */
const MAYA = 36;
const SAM = 84;

const bandsFor = (ageMinMonths: number | null, ageMaxMonths: number | null): string[] =>
  computeAgeBandMatches({ ageMinMonths, ageMaxMonths }, BANDS);

/**
 * A listing whose bands are DERIVED from its bounds by the shipped worker function rather than
 * hand-written. The predicate under test never reads `ageBandMatches`, but a fixture that stated
 * bands inconsistent with its own bounds would make the band-AND contrast above a straw man.
 */
const listing = (ageMinMonths: number | null, ageMaxMonths: number | null) =>
  makeListing({
    ageMinMonths,
    ageMaxMonths,
    ageBandMatches: bandsFor(ageMinMonths, ageMaxMonths) as AgeBandKey[],
  });

describe('the band-AND false positive — a single-year programme straddling a band boundary', () => {
  it('"Ages 4-5" claims both the 2-4 and 5-9 bands, which is what makes band-AND wrong', () => {
    // Not an assertion about the predicate — an assertion that the trap is still live. If a
    // future change made band membership containment-based, this line fails first and tells the
    // next reader that the contrast this file is built on has moved.
    expect(bandsFor(48, 72)).toEqual(['2-4', '5-9']);
  });

  it('does not fit Maya (36mo) and does not fit Sam (84mo) — it fits NEITHER', () => {
    const agesFourToFive = listing(48, 72);

    expect(fitsChild(agesFourToFive, MAYA)).toBe(false); // 36 < 48
    expect(fitsChild(agesFourToFive, SAM)).toBe(false); // 84 >= 72
    expect(fitsAllChildren(agesFourToFive, [MAYA, SAM])).toBe(false);
  });

  it('and it is not rescued by the child order, or by asking about one child at a time', () => {
    const agesFourToFive = listing(48, 72);

    expect(fitsAllChildren(agesFourToFive, [SAM, MAYA])).toBe(false);
    expect(fitsAllChildren(agesFourToFive, [MAYA])).toBe(false);
    expect(fitsAllChildren(agesFourToFive, [SAM])).toBe(false);
  });

  it('a child INSIDE those bounds still fits it — the predicate is exact, not merely strict', () => {
    // The failure mode of an over-corrected fix: rejecting everything is also wrong. A
    // 5-year-old (60mo) is exactly who this programme is for.
    expect(fitsChild(listing(48, 72), 60)).toBe(true);
  });
});

describe('the genuine sibling fit', () => {
  it('"Ages 3-8" ([36,108)) fits Maya and Sam together', () => {
    const agesThreeToEight = listing(36, 108);

    // Same two bands as "Ages 4-5" above — which is exactly why bands cannot tell these two
    // listings apart, and month bounds can.
    expect(bandsFor(36, 108)).toEqual(['2-4', '5-9']);
    expect(fitsChild(agesThreeToEight, MAYA)).toBe(true);
    expect(fitsChild(agesThreeToEight, SAM)).toBe(true);
    expect(fitsAllChildren(agesThreeToEight, [MAYA, SAM])).toBe(true);
  });

  it('holds for more than two children, and one child outside the range sinks the whole claim', () => {
    const agesThreeToEight = listing(36, 108);

    expect(fitsAllChildren(agesThreeToEight, [MAYA, 60, SAM])).toBe(true);
    expect(fitsAllChildren(agesThreeToEight, [MAYA, SAM, 120])).toBe(false); // 10-year-old
  });
});

describe('unknown bounds never earn a fit', () => {
  it('a listing with no stated bounds fits nobody, however permissive the visibility rule is', () => {
    // The trap from lib/audit/rules/adult-age-band.ts:13 — unresolved is not neutral, it is
    // maximally permissive. `matchesAge` admits this listing under every age filter, correctly,
    // because that decides visibility. This predicate backs a claim about a named child, so the
    // same listing must answer false. Without the explicit guard the containment test is
    // vacuously TRUE here, and nothing else in the suite would notice.
    const unresolved = listing(null, null);

    expect(fitsChild(unresolved, MAYA)).toBe(false);
    expect(fitsChild(unresolved, SAM)).toBe(false);
    expect(fitsAllChildren(unresolved, [MAYA, SAM])).toBe(false);
  });

  it('but ONE stated bound is a real claim and is honoured', () => {
    expect(fitsChild(listing(48, null), SAM)).toBe(true); // "Ages 4+"
    expect(fitsChild(listing(48, null), MAYA)).toBe(false);
    expect(fitsChild(listing(null, 72), MAYA)).toBe(true); // "Under 6"
    expect(fitsChild(listing(null, 72), SAM)).toBe(false);
    expect(fitsAllChildren(listing(null, 216), [MAYA, SAM])).toBe(true); // "Youth"
  });

  it('asking about no children at all is not a fit either', () => {
    // `[].every()` is true, so the unguarded reading would claim every listing fits all zero
    // children — the same vacuity as unknown bounds, one level up.
    expect(fitsAllChildren(listing(36, 108), [])).toBe(false);
  });
});

describe('the bounds convention: min inclusive, max exclusive (worker/core/age.ts:16-20)', () => {
  const agesFourToFive = listing(48, 72);

  it('a child exactly on the floor is in', () => {
    expect(fitsChild(agesFourToFive, 48)).toBe(true);
  });

  it('a child exactly on the ceiling is out — 72 months is the sixth birthday', () => {
    expect(fitsChild(agesFourToFive, 72)).toBe(false);
    expect(fitsChild(agesFourToFive, 71)).toBe(true);
  });

  it('an inverted range admits nobody, without needing a special case', () => {
    const degenerate = listing(72, 48);
    for (const age of [0, 36, 48, 60, 72, 84, 240]) {
      expect(fitsChild(degenerate, age)).toBe(false);
    }
  });

  it('age zero is a real age, not a falsy one', () => {
    expect(fitsChild(listing(0, 24), 0)).toBe(true);
    expect(fitsChild(listing(null, 24), 0)).toBe(true);
  });
});

describe('garbage ages fail closed', () => {
  // A `Number()` over an unparseable profile/URL value yields NaN, and Infinity is one bad
  // arithmetic away. Both must answer false rather than depending on which bound is null:
  // NaN comparisons are always false, so an open-ended listing would otherwise pass Infinity.
  it.each([NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])('%p is not a fit', (age) => {
    expect(fitsChild(listing(48, null), age)).toBe(false);
    expect(fitsChild(listing(null, 72), age)).toBe(false);
    expect(fitsChild(listing(0, null), age)).toBe(false);
    expect(fitsAllChildren(listing(0, null), [MAYA, age])).toBe(false);
  });
});

describe('the relationship to band matching is one-directional', () => {
  it('every exact fit is also a band overlap — the predicate only ever tightens, never contradicts', () => {
    // The doc's claim about band-AND is that it is a strict OVER-approximation: real false
    // positives, no false negatives. This pins the "no false negatives" half over a spread of
    // bounds, so a future edit cannot make `fitsChild` reject a child that band matching would
    // have accepted — that would silently hide genuine sibling activities rather than merely
    // over-claiming, and nothing downstream would report it.
    const boundsCases: Array<[number | null, number | null]> = [
      [0, 24], [24, 60], [48, 72], [36, 108], [60, 120], [120, 180], [180, null],
      [0, null], [null, 72], [90, 96], [12, 240],
    ];
    const ages = [0, 6, 23, 24, 36, 47, 48, 59, 60, 71, 84, 119, 120, 179, 180, 240];

    for (const [min, max] of boundsCases) {
      const l = listing(min, max);
      const bands = bandsFor(min, max);
      for (const age of ages) {
        if (!fitsChild(l, age)) continue;
        const bandOfAge = BANDS.find(
          (b) => age >= b.lowerMonthsInclusive && age < (b.upperMonthsExclusive ?? Infinity),
        );
        expect(bands).toContain(bandOfAge!.id);
      }
    }
  });
});
