// lib/profile/child-age-bands.ts — the ONE place an on-device child profile crosses into the
// product's age vocabulary (design §10, S2).
//
// A profile holds real ages in MONTHS. The search stack consumes quantised `AgeBandKey`s. This
// module is the whole of the conversion and nothing else: pure, no storage, no DOM, no clock.
// It is deliberately separate from lib/profile/child-profile.ts so the storage module keeps
// zero imports and knows nothing about search, and so this crossing is greppable.
//
// ─── BANDS QUANTISE; A PROFILE DOES NOT ──────────────────────────────────────────────────
// "Maya is 3" is a fact with month precision; `2-4` is a 36-month bucket. Deriving a band
// throws most of that away. That is correct for FILTERING (bands are the only vocabulary the
// engine's `ageBands` speaks) and wrong for MATCHING — `ListingRecord` already carries exact
// `ageMinMonths`/`ageMaxMonths` (lib/search/types.ts:93-94), so a "does this activity fit this
// specific child" predicate should read the months, not the band derived here. That is the
// sibling-fit work (design §6c, M1-M3), a separate unit. Do not reach for this function to
// answer it: band-level containment over-approximates and produces false positives in the
// direction that matters (a 12-month-wide programme straddling a boundary claims both bands
// and fits neither child — design §6b).
//
// ─── WHAT A 15-YEAR-OLD DOES, AND WHY THAT IS NO LONGER A HOLE ───────────────────────────
// The design doc (§2a, written against f59cd71) names this as a real gap: `15+` existed in the
// taxonomy and the facet counts but had NO chip on the rail, so a profile could express an age
// the UI could not select, and `parseOrderedCsv` dropped a stale `?age=15%2B`. THAT IS FIXED IN
// THIS BASE. Jon reinstated the chip on 2026-08-18 (app/search/_lib/params.ts:112-149,
// tests/search/age-band-15plus.test.ts), so every band this module can derive has a chip that
// selects it and a URL spelling that round-trips. Nothing here needs a special case for it and
// nothing downstream needs to learn about it — see params.ts's own note: a consumer that
// special-cases `15+` has stopped being data-driven, and that is the bug to fix.
//
// ─── THE BOUNDS, AND HOW THEY ARE KEPT HONEST ────────────────────────────────────────────
// Canonical source: the seeded `age_band` table (supabase/seeds/age_bands.sql), restated in
// worker/core/age.ts:16-22. `age_min_months` is INCLUSIVE, `age_max_months` EXCLUSIVE, and
// `15+` is open-ended (upper = NULL). The bands partition [0, ∞) with no gap and no overlap
// (pinned by tests/age_bands.test.ts), which is what lets this module state only each band's
// LOWER bound: every upper is the next band's lower, and the open-ended top falls out of the
// ordering rather than being written down. Two drift guards, neither of which is a convention
// anyone has to remember:
//   • `Record<AgeBandKey, number>` is exhaustive — add a band to the union and this file stops
//     compiling until its bound is stated.
//   • tests/age_bands.test.ts asserts this table equals the seeded rows, against a real
//     database, so a seed change that moved a boundary fails there rather than silently
//     re-banding every stored child.

import { AGE_BAND_ORDER } from '@/lib/search/filters/age';
import type { AgeBandKey } from '@/lib/search/types';
import type { ChildEntry } from './child-profile';

/**
 * Each band's INCLUSIVE lower bound in months. Uppers are deliberately absent: they are the
 * next band's lower, and stating them twice is how two tables drift apart.
 */
export const AGE_BAND_LOWER_MONTHS: Record<AgeBandKey, number> = {
  under2: 0,
  '2-4': 24,
  '5-9': 60,
  '10-14': 120,
  '15+': 180,
};

/**
 * The band a child of `ageMonths` falls in, or `null` for anything that is not a real month
 * count (negative, fractional, non-finite, not a number).
 *
 * Walks the canonical order from the OLDEST band down and takes the first whose lower bound the
 * age reaches. Because the bands partition [0, ∞), that is exact for every finite age and needs
 * no upper bounds and no open-ended special case: an age of 180, 216 or 9_000 months all resolve
 * to `15+` by the same rule that puts 24 in `2-4`.
 */
export function ageMonthsToBand(ageMonths: number): AgeBandKey | null {
  if (typeof ageMonths !== 'number' || !Number.isInteger(ageMonths) || ageMonths < 0) return null;
  for (let i = AGE_BAND_ORDER.length - 1; i >= 0; i -= 1) {
    const band = AGE_BAND_ORDER[i];
    if (ageMonths >= AGE_BAND_LOWER_MONTHS[band]) return band;
  }
  return null; // unreachable while the youngest band starts at 0; not asserted, just not trusted
}

/**
 * The band selection a profile implies: one band per child, de-duplicated, in canonical
 * youngest-first order — exactly the shape and ordering `SearchState.ages` and the `age=` param
 * already use (`parseOrderedCsv`, `toggleInList`), so the result is indistinguishable from a
 * selection a parent tapped.
 *
 * Two children in the same band collapse to one band, which is right: the bands are an OR-set
 * ("we'll match either age" — FilterRail.tsx:241), not a multiset, and a duplicate would be a
 * no-op the URL still had to carry.
 *
 * Children whose age does not resolve are skipped rather than defaulting to a band. A profile
 * this module cannot read is not a reason to apply a filter nobody asked for — and an empty
 * result here means "no age filter", which is today's bare-browse behaviour.
 */
export function childrenToAgeBands(children: readonly ChildEntry[]): AgeBandKey[] {
  if (!Array.isArray(children)) return [];
  const bands = new Set<AgeBandKey>();
  for (const child of children) {
    const band = child && ageMonthsToBand(child.ageMonths);
    if (band) bands.add(band);
  }
  return AGE_BAND_ORDER.filter((band) => bands.has(band));
}
