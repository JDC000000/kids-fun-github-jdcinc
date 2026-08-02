// lib/search/filters/audience.ts — Adult/senior-only exclusion for a children's product.
//
// KIDS FUN is a kids app. A vendor's "drop-in" calendar is a WHOLE-FACILITY calendar, so it
// carries adult and senior programming alongside the children's content — "Adult 19yrs+ Swim",
// "Seniors Tai Chi", "Mah Jong", "Cardiac Coffee". Those rows are not de-prioritised, they are
// removed: they are not this product's content at all. (Jon, 2026-08-01: "Remove adult senior-only
// content entirely from the kids app. Keep it for parent and child sessions.")
//
// The one thing that MUST NOT be removed is a session a grown-up attends WITH a child —
// "Adult / Early Years (0-6years) Swim", "Reserve In Advance: Family Badminton (6-13 with adult)",
// "Children's Badminton w/Adult". Those all say "adult" and are all core kids content, so the
// parent-and-child framing is checked FIRST and always wins.
//
// Two independent signals, because neither alone is trustworthy on today's data:
//   1. TITLE prose — "adult", "senior", "19+", "55+". The only signal for the many rows whose
//      age columns were mis-parsed ("Adult 19yrs+ Swim" is stored as age_min_months = 0).
//   2. STRUCTURED age — an OPEN-ENDED minimum at or above the age of majority. This is what
//      catches the senior-centre programming no title regex could ("Mah Jong", "Bridge Drop-In",
//      "Open Lounge"), which carries no adult word but is stored as 55y+ with no upper bound.
//
// The open-ended requirement in (2) is load-bearing, not incidental. A genuine adult/senior
// program is unbounded at the top ("19+", "65+"); a BOUNDED range with a high floor is a
// mis-parsed kids listing ("Art of Tennis Summer Camp" arrives as 24–29y). Requiring
// ageMaxMonths === null keeps every such mis-parse visible — the failure direction we want,
// since this filter is a hard exclusion with no user-facing escape hatch.

import type { ListingRecord } from '../types';

/**
 * The minimum a title/age must clear to read as adult-only: 19 years in months. BC's age of
 * majority, and the exact threshold every source in the corpus writes ("19yrs+", "19+").
 * Deliberately NOT 18: the product's top age band is `15+`, so an 18-year-old is still a kid
 * here, and "18+" listings stay visible.
 */
export const ADULT_ONLY_AGE_MIN_MONTHS = 228;

/**
 * "A grown-up comes WITH a child" framing. Checked before any adult/senior signal and always
 * wins, so a parent-and-child session is never mistaken for adult-only programming.
 */
const PARENT_AND_CHILD =
  /\bparent\b|\bcaregiver\b|\bguardian\b|\bfamil(y|ies)\b|\btots?\b|\btoddler|\bbab(y|ies)\b|\bchild(ren)?'?s?\b|\bkids?\b|\byouth\b|\bteens?\b|\bpreschool|\bearly\s+years\b|\ball\s+ages\b|with\s+(an\s+)?adult\b|w\/\s*adult\b|\bmy\s+first\b/i;

/**
 * Explicit adult-/senior-only framing in the title. The numeric alternation lists only ages at
 * or above the age of majority — "15yrs+" and "12yrs+" are teen content and must not match.
 */
const ADULT_ONLY_TITLE =
  /\badults?\b|\bseniors?\b|\bactive\s+aging\b|\b(19|21|50|55|60|65)\s*(\+|yrs?\.?\s*\+|years?\s*\+)/i;

/** The subset of a listing this predicate reads — so both the DB record and the UI DTO satisfy it. */
export interface AudienceSignalInput {
  activityName: string;
  ageMinMonths?: number | null;
  ageMaxMonths?: number | null;
}

/**
 * True when a listing is adult-only or senior-only programming and does not belong in a
 * children's product at all. Parent-and-child sessions return false even when they say "adult".
 */
export function isAdultOrSeniorOnly(listing: AudienceSignalInput): boolean {
  const title = listing.activityName ?? '';
  if (PARENT_AND_CHILD.test(title)) return false;
  if (ADULT_ONLY_TITLE.test(title)) return true;
  return hasOpenEndedAdultAgeFloor(listing);
}

/** An age range that starts at/above the age of majority and never closes → adult/senior only. */
function hasOpenEndedAdultAgeFloor(listing: AudienceSignalInput): boolean {
  const min = listing.ageMinMonths;
  return min != null && min >= ADULT_ONLY_AGE_MIN_MONTHS && listing.ageMaxMonths == null;
}

/** Narrowing helper for call sites that hold a full `ListingRecord`. */
export function isAdultOrSeniorOnlyListing(listing: ListingRecord): boolean {
  return isAdultOrSeniorOnly(listing);
}
