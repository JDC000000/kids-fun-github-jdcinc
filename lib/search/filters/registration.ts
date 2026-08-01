// lib/search/filters/registration.ts — "Is this a registration-required course?" (read-side heuristic).
//
// Jon, testing live staging: "Any courses that need registration in advance and then run for weeks
// or months — no one searching for something to do today wants to see those." His instruction
// (2026-08-01): don't hide it outright, but make it OPT-IN — off by default, and clearly labelled
// as registration content whenever it IS shown.
//
// This module answers only the classification half. The engine owns the opt-in behaviour
// (`SearchContext.includeRegistration`) and the card owns the label.
//
// WHY A TITLE HEURISTIC. Nothing in the schema records "registration required" today: the
// distinction lives in adapter CONFIG, is applied as a fetch-time include/exclude, and is never
// persisted on a row (see docs/kids-fun-dropin-vs-registration-investigation.md, Q1). Persisting
// the signal that vendors already put on the wire is a separate, larger change. So this is a
// deliberately CONSERVATIVE reading of the one field that exists — and it is sized to be replaced
// by a real column, not to be permanent.
//
// PRECISION OVER RECALL, BY DESIGN. Because the classification is a guess, being wrong in the
// "this is a course" direction is the expensive error: it takes real drop-in content out of the
// default view. So a positive drop-in signal ALWAYS beats a registration signal (see
// `hasDropInSignal`), and a listing we cannot read confidently is simply left alone. The
// consequence is that some genuine courses stay in the default results — "Sportball Multisport
// (3-5 yrs)", "Indoor T-Ball (3-5 yrs)" carry no keyword at all. That is the correct trade: they
// are noise, whereas a wrongly-hidden public swim is a broken product.
//
// The drop-in override is also what handles the case the investigation flagged as having no clean
// answer — a slot that is genuinely BOTH at once. "Reserve In Advance: Public Swim" reserves in
// advance AND is a public swim; it stays in the default view. "Reserve In Advance: Figure Skating
// (Level Star 2 +)" has no drop-in signal and does not.
//
// Every rule below was audited against all 9,988 live staging occurrences before landing; see
// tests/search/registration-filter.test.ts for the titles each one is pinned to.

import type { ListingRecord } from '../types';

/** The persisted "just show up" suitability tag (worker/core/taxonomy.ts). */
const DROP_IN_TAG = 'drop_in';

/**
 * Vocabulary that means "turn up, no booking". Any hit here vetoes the registration
 * classification entirely, so a mixed listing keeps its place in the default results.
 *
 * Every entry has to be evidence about BOOKING, not about anything else. "All ages" was in this
 * list and is deliberately not: it describes who may come, not whether you must book first, and it
 * was the only thing keeping "Reserve In Advance: Table Tennis All Ages" in the default view while
 * "Reserve In Advance: Badminton (8-17yrs)" was excluded — the same vendor, the same booking model,
 * split on an irrelevant word. Both are opt-in now.
 */
const DROP_IN_TITLE =
  /drop[\s-]?in|public\s+swim|public\s+skate|family\s+skate|lane\s+swim|leisure\s+lane|\blanes?\b|\blengths?\b|widths|open\s+gym|open\s+swim|free\s+swim|free\s+play|open\s+play|play\s*time|play\s+palace|storytime|story\s*time|babytime|toddlertime|parent\s+and\s+tot|parent\s+participation|youth\s+centre|youth\s+night|general\s+admission|no\s+registration|just\s+show\s+up|swim\s+club/i;

/**
 * Vocabulary that means "you must register/book to attend": named courses, camps, lesson
 * programs, and the vendor's own explicit "Reserve In Advance:" prefix.
 */
const REGISTRATION_TITLE =
  /\bcamps?\b|\blessons?\b|\bcourses?\b|\bclass(es)?\b|\bworkshops?\b|\bclinics?\b|\bintro\s+to\b|\blearn\s+to\b|\bregistrations?\b|\bregisters?\b|\bregistered\b|\breserve\s+in\s+advance\b|\bacadem(y|ies)\b|\bseries\b|\b(level|stage|star)\s*\d|\bsession\s*\d|\bweek\s*\d|\bcertificat/i;

/**
 * A skill-program name followed by a bare level number — "Power Skate 1", "Figure Skating 1",
 * "Hockey 2". The negative lookahead is what makes this safe: it rejects the age ranges that
 * dominate these titles ("Youth Swim 8-14yrs", "Badminton 55+", "Badminton 18+ yrs"), which a
 * plain trailing-number rule would have swept up along with genuine levels. Requiring a known
 * program noun in front also keeps it off titles like "Outdoor Movie — Zootopia 2".
 */
const PROGRAM_LEVEL =
  /\b(skate|skating|hockey|ringette|swim|swimming|gymnastics|dance|ballet|soccer|basketball|tennis|badminton|karate|judo|aikido|piano|guitar|violin|drawing|painting|pottery|yoga)\s+\d{1,2}(?![\d\-–+]|\s*(yrs?|years?|\+))/i;

/** The subset of a listing this predicate reads — so both the DB record and the UI DTO satisfy it. */
export interface RegistrationSignalInput {
  activityName: string;
  suitabilityTags?: string[];
  categoryTags?: string[];
}

/** True when the listing carries any positive "no booking needed" signal (tag or title prose). */
export function hasDropInSignal(listing: RegistrationSignalInput): boolean {
  const tags = [...(listing.suitabilityTags ?? []), ...(listing.categoryTags ?? [])];
  if (tags.includes(DROP_IN_TAG)) return true;
  return DROP_IN_TITLE.test(listing.activityName ?? '');
}

/**
 * True when the listing reads as a registration-required course/camp/lesson rather than something
 * a parent can turn up to today. A drop-in signal always wins, so this can only ever be true for
 * listings with NO evidence of being drop-in.
 */
export function isRegistrationShaped(listing: RegistrationSignalInput): boolean {
  if (hasDropInSignal(listing)) return false;
  const title = listing.activityName ?? '';
  return REGISTRATION_TITLE.test(title) || PROGRAM_LEVEL.test(title);
}

/** Narrowing helper for call sites that hold a full `ListingRecord`. */
export function isRegistrationShapedListing(listing: ListingRecord): boolean {
  return isRegistrationShaped(listing);
}
