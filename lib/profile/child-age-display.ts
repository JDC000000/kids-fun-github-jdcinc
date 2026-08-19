// lib/profile/child-age-display.ts — the parent-facing HALF of the child profile: the words a
// stored age is shown as, and the unit a parent types it in (design §10, U1/U2).
//
// Pure: no storage, no DOM, no clock, no React. It sits beside child-age-bands.ts, which is the
// same idea pointed the other way — that module translates months into the SEARCH vocabulary
// (`AgeBandKey`), this one translates months into the PARENT's vocabulary (years, and a phrase).
// Keeping them apart keeps the search crossing greppable and lets the copy change without
// anything filter-shaped moving.
//
// ─── WHY YEARS IN, MONTHS STORED ─────────────────────────────────────────────────────────
// "How old is your child?" is answered in years by every parent alive; months is the canonical
// unit of the rest of the product (`occurrence_age`, `age_band`, `ChildEntry.ageMonths`). So the
// UI captures years and this module is the ONE place the two meet. The conversion is deliberately
// lossy in the safe direction: 3 years → 36 months, which is the START of that year, so a child
// is never banded older than they are. `ageMonthsToBand` puts 36 in `2-4`, which is where a
// 3-year-old belongs whether they are 3y0m or 3y11m.
//
// ─── NO NAMES, HERE LEAST OF ALL ─────────────────────────────────────────────────────────
// This module writes the string a parent reads at the top of the page, which is exactly where a
// name would be most tempting. There is none, by ruling (design §9-Q2, Jon 2026-08-19: ages
// only) and by construction — `ChildEntry` has no name field to render. "For a 3-year-old and a
// 7-year-old" is the whole of the personalisation, and it needs no new class of PII to say.

import { MAX_AGE_MONTHS, type ChildEntry } from './child-profile';

/** Whole months in a year. Named because `/ 12` in five places is five places to get it wrong. */
const MONTHS_PER_YEAR = 12;

/**
 * The oldest age the capture UI offers, in YEARS, derived from the store's own month cap so the
 * form can never accept an age `sanitizeChildren` would then drop. Do not restate it as a literal.
 */
export const MAX_AGE_YEARS = Math.floor(MAX_AGE_MONTHS / MONTHS_PER_YEAR);

/** Whole years → the stored month count (the START of that year — see the header). */
export function yearsToAgeMonths(years: number): number {
  return Math.round(years) * MONTHS_PER_YEAR;
}

/** Stored months → the whole years a parent typed, for pre-filling an edit form. */
export function ageMonthsToYears(ageMonths: number): number {
  return Math.floor(ageMonths / MONTHS_PER_YEAR);
}

/**
 * True when `years` is something the store will actually keep: a whole number inside the caps.
 * The form gates on this rather than on the input's own `min`/`max`, because a number input is
 * a suggestion to a browser and not a validation anywhere.
 */
export function isStorableAgeYears(years: number): boolean {
  return Number.isInteger(years) && years >= 0 && years <= MAX_AGE_YEARS;
}

/** One child, in words. Under a year has no whole-year form, so it gets said rather than rounded to 0. */
function describeOneAge(ageMonths: number): string {
  const years = ageMonthsToYears(ageMonths);
  return years < 1 ? 'a baby under 1' : `a ${years}-year-old`;
}

/**
 * The children as one parent-readable phrase: "a 3-year-old and a 7-year-old".
 *
 * YOUNGEST FIRST, always, regardless of the order they were entered — the phrase is a
 * description of a household, not a list in input order, and a stable ordering means the header
 * does not reshuffle itself when a parent edits one age. Empty (no resolvable ages) returns the
 * empty string, and every caller renders nothing rather than an "For" with nothing after it.
 */
export function describeChildAges(children: readonly ChildEntry[]): string {
  if (!Array.isArray(children)) return '';
  const parts = children
    .filter((child) => child && Number.isInteger(child.ageMonths) && child.ageMonths >= 0)
    .map((child) => child.ageMonths)
    .sort((a, b) => a - b)
    .map(describeOneAge);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
