// lib/sms/registration.ts — "is this a multi-session commitment?", for the weekly text only.
//
// DRAFT (SMS pivot). Implements Jon's §8 Q1 ruling (PRD v2.8 §2.2 step 2): large, advance-
// registration, MULTI-SESSION programs (classes, camps, courses) stay excluded from the weekly
// picks — but a ONE-OFF activity that merely requires booking is NOT excluded. The distinction is
// duration and commitment, not "any registration at all".
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE INSIGHT: THE SHARED CLASSIFIER'S VOCABULARY ALREADY CONTAINS BOTH IDEAS, MIXED
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// `lib/search/filters/registration.ts`'s REGISTRATION_TITLE is one alternation, but its terms
// answer two different questions:
//
//   HOW LONG IS IT?     camp, lesson, course, class, workshop, clinic, academy, series,
//                       "intro to", "learn to", "Level/Stage/Star N", "Session N", "Week N",
//                       certificate, and the PROGRAM_LEVEL pattern ("Power Skate 1").
//                       → a COMMITMENT. Jon excludes these.
//
//   HOW DO YOU GET IN?  "Reserve In Advance:", "registration", "register", "registered".
//                       → a BOOKING MECHANISM. Says nothing about duration. Jon keeps these.
//
// Jon's line falls exactly along that seam, so the distinction needs no new data — only a way to
// ask which half fired. That is what `isMultiSessionCommitment` does.
//
// ── HOW IT ASKS, WITHOUT COPYING THE VOCABULARY ─────────────────────────────────────────
// Restating the commitment half here would be a second copy of a fifteen-term alternation that
// was audited against 9,988 live rows, free to drift from the original. So instead this RE-RUNS
// the shared classifier on the title with the booking-mechanism words removed:
//
//     still registration-shaped without them  →  a COMMITMENT fired. Exclude.
//     no longer registration-shaped           →  only the booking mechanism fired. Keep.
//
// Two properties fall out of that, both of which a copied list would not have:
//   • Only FOUR patterns live here — the booking-mechanism ones — instead of fifteen.
//   • A term added to REGISTRATION_TITLE later is automatically treated as a COMMITMENT, i.e.
//     it keeps being excluded. That is the safe direction: a new multi-session word slipping into
//     the weekly text is noise, whereas a drop-in wrongly excluded is a thinner week.
//
// ── WHAT THIS IS NOT, AND THE FOLLOW-UP IT DOES NOT PRE-EMPT ────────────────────────────
// This is a TITLE-LEVEL APPROXIMATION of a DATA question, and it should be read as one. The real
// signal is `activity_series.recurrence_rule` (migration 0004: "RRULE-style string; null for
// one-off/open-hours series") — a genuine, structural "is this a single occurrence" fact that no
// vocabulary can match for reliability. `ListingRecord` does not carry it, and wiring it would
// mean changing lib/search/types.ts and lib/search/postgres-repository.ts, which this branch has
// deliberately never touched. That change is raised as its own question rather than taken here.
// See docs/sms-pivot-draft-feasibility-notes.md §ae.

import { isRegistrationShaped } from '@/lib/search/filters/registration';
import type { ListingRecord } from '@/lib/search/types';

/**
 * Title vocabulary that describes HOW YOU GET IN, not HOW LONG IT RUNS.
 *
 * Transcribed from the booking-mechanism terms inside REGISTRATION_TITLE, and deliberately no
 * others — every remaining term in that alternation is about duration or progression.
 *
 * Global so `.replace` strips every occurrence; recreated per call because a global regex carries
 * `lastIndex` state and a shared instance would intermittently miss matches.
 */
const BOOKING_MECHANISM_TITLE_SOURCE =
  '\\breserve\\s+in\\s+advance\\b|\\bregistrations?\\b|\\bregisters?\\b|\\bregistered\\b';

/** Does this title carry a booking-mechanism term at all? */
export function hasBookingMechanismWording(activityName: string): boolean {
  return new RegExp(BOOKING_MECHANISM_TITLE_SOURCE, 'i').test(activityName ?? '');
}

/** The title with its booking-mechanism wording removed, leaving only what it says about duration. */
export function stripBookingMechanismWording(activityName: string): string {
  return (activityName ?? '')
    .replace(new RegExp(BOOKING_MECHANISM_TITLE_SOURCE, 'gi'), ' ')
    // A "Reserve In Advance:" prefix leaves a dangling colon/dash that means nothing on its own.
    .replace(/^[\s:;,\-–—|]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Is this a large multi-session program the weekly text should not offer?
 *
 * TRUE  → a course, camp, class, lesson series, levelled program. Excluded from the picks.
 * FALSE → anything else, INCLUDING a one-off that must be booked in advance.
 *
 * ── THE PERSISTED FLAG IS A BOOKING FACT, NOT A DURATION FACT ───────────────────────────
 * `registrationRequired === true` is the strongest signal the shared classifier has, and it
 * outranks even the drop-in veto there — correctly, because it is the vendor's own answer to "must
 * you book?". But that is the question this predicate is NOT asking. A BiblioCommons event whose
 * `registrationInfo` says you must log in to register is, very often, a single Saturday storytime:
 * booked, yes; a multi-week commitment, no. So the re-run neutralises the flag along with the
 * words, and duration is judged on what the title actually says.
 *
 * That is the single biggest behaviour change here, and it is the one Jon's ruling most directly
 * asks for: today a registration-flagged one-off library event is silently absent from the weekly
 * text, and it should not be.
 */
export function isMultiSessionCommitment(listing: ListingRecord): boolean {
  // Not registration content at all (or vetoed by a drop-in signal) → nothing to reconsider.
  if (!isRegistrationShaped(listing)) return false;

  const withoutBooking = stripBookingMechanismWording(listing.activityName ?? '');

  // Re-ask the SHARED classifier, with the booking mechanism removed in BOTH forms it can take:
  // the words, and the persisted flag. Whatever still answers "registration-shaped" is a term
  // about duration or progression.
  return isRegistrationShaped({
    activityName: withoutBooking,
    suitabilityTags: listing.suitabilityTags,
    categoryTags: listing.categoryTags,
    registrationRequired: null,
  });
}

/**
 * The weekly picks' registration gate: may this listing appear in a text?
 *
 * The inverse of `isMultiSessionCommitment`, named for the question the pipeline actually asks so
 * the call site reads as an allow-list rather than a double negative.
 */
export function isWeeklyPickEligible(listing: ListingRecord): boolean {
  return !isMultiSessionCommitment(listing);
}
