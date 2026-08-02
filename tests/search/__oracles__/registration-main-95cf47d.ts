// tests/search/__oracles__/registration-main-95cf47d.ts
//
// A FROZEN, VERBATIM copy of lib/search/filters/registration.ts's classifier as it exists on
// main@95cf47d — the baseline this branch is cut from. It is a REAL ORACLE, not a
// re-implementation: extracted with `git show 95cf47d:lib/search/filters/registration.ts`,
// so a parity test against it proves the untouched families still classify identically
// rather than proving that two copies of my own logic agree with each other.
//
// DO NOT EDIT to make a test pass. If parity breaks, the branch changed behaviour for rows
// with no persisted fact — which is exactly what this file exists to catch.
/* eslint-disable */
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
interface RegistrationSignalInput {
  activityName: string;
  suitabilityTags?: string[];
  categoryTags?: string[];
}

/** True when the listing carries any positive "no booking needed" signal (tag or title prose). */
export function hasDropInSignalMain(listing: RegistrationSignalInput): boolean {
  const tags = [...(listing.suitabilityTags ?? []), ...(listing.categoryTags ?? [])];
  if (tags.includes(DROP_IN_TAG)) return true;
  return DROP_IN_TITLE.test(listing.activityName ?? '');
}

/**
 * True when the listing reads as a registration-required course/camp/lesson rather than something
 * a parent can turn up to today. A drop-in signal always wins, so this can only ever be true for
 * listings with NO evidence of being drop-in.
 */
export function isRegistrationShapedMain(listing: RegistrationSignalInput): boolean {
  if (hasDropInSignalMain(listing)) return false;
  const title = listing.activityName ?? '';
  return REGISTRATION_TITLE.test(title) || PROGRAM_LEVEL.test(title);
}
