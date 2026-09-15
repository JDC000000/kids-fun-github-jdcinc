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
//
// RE-AUDITED 2026-09-15 against 3,692 distinct live PRODUCTION activity names (28,821
// occurrences), after Jon found two multi-week programmes in a real Friday text that this file
// read as drop-in. `scripts/registration-vocabulary-probe.sh` is that audit made repeatable —
// run it before and after any edit here and diff the two `--json` outputs, so the population a
// change was measured against is a file a reviewer can read rather than a claim in a commit
// message. What the re-audit found, and the vocabulary that answers it, is documented on
// `MARTIAL_ART_PROGRAM` and on the two additions to `REGISTRATION_TITLE`.
//
// WHAT THE RE-AUDIT DELIBERATELY DID NOT ADD, because the measurement said no. A skill-level word
// ("Beginner", "Intermediate", "All Levels") looked like the highest-yield generic rule available
// and matches 281 live titles — but among them are "Adult Sports: Badminton - All Levels",
// "Badminton Intermediate Play" and "Ball Hockey (Co-ed) - All Levels", which are drop-in sessions
// labelled by skill. A rule that takes those out of the default view is the expensive error this
// file's precision-over-recall rule is about. Recorded here so the next reader does not have to
// rediscover it, and so the idea is rejected on evidence rather than on taste.

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
  /\bcamps?\b|\blessons?\b|\bcourses?\b|\bclass(es)?\b|\bworkshops?\b|\bclinics?\b|\bintro\s+to\b|\blearn\s+to\b|\bregistrations?\b|\bregisters?\b|\bregistered\b|\breserve\s+in\s+advance\b|\bacadem(y|ies)\b|\bseries\b|\b(level|stage|star)\s*\d|\bsession\s*\d|\bweek\s*\d|\bcertificat|\bballerinas?\b|\bcreative\s+(?:ballet|dance|movement)\b/i;

/**
 * A skill-program name followed by a bare level number — "Power Skate 1", "Figure Skating 1",
 * "Hockey 2". The negative lookahead is what makes this safe: it rejects the age ranges that
 * dominate these titles ("Youth Swim 8-14yrs", "Badminton 55+", "Badminton 18+ yrs"), which a
 * plain trailing-number rule would have swept up along with genuine levels. Requiring a known
 * program noun in front also keeps it off titles like "Outdoor Movie — Zootopia 2".
 */
const PROGRAM_LEVEL =
  /\b(skate|skating|hockey|ringette|swim|swimming|gymnastics|dance|ballet|soccer|basketball|tennis|badminton|piano|guitar|violin|drawing|painting|pottery|yoga)\s+\d{1,2}(?![\d\-–+]|\s*(yrs?|years?|\+))/i;

/**
 * A named martial-arts DISCIPLINE, on its own — no level digit required.
 *
 * WHY THIS IS SEPARATE FROM `PROGRAM_LEVEL`, WHICH IS WHERE KARATE/JUDO/AIKIDO USED TO LIVE.
 * Those three sat in the noun list above and therefore only ever fired with a trailing bare level
 * number ("Karate 3"). Audited against the live catalogue on 2026-09-15, that requirement made
 * them almost entirely inert: "Karate - Advanced (Full Month) AUG", "Aikido (August)", "Seiyu
 * Karate - Beginner" and "Olympic Style TaeKwonDo (11-16 yrs)" ALL read as drop-in, because a
 * parenthesised age range or month is not a bare digit. They are moved here rather than left
 * duplicated: this pattern is strictly broader than the alternatives it replaces, so one home per
 * concept and nothing to keep in sync.
 *
 * WHY A BARE DISCIPLINE NOUN IS SAFE HERE WHEN A BARE ACTIVITY NOUN IS NOT. Every one of these
 * names a BELT- OR CURRICULUM-PROGRESSION art, and the audit found no counter-example: across
 * 3,692 distinct live activity names, all 189 occurrences carrying one of these words are
 * month-labelled, level-labelled or belt-labelled programmes ("Axe Capoeira - Beginner mini kids
 * (3-6yrs) SEPT", "Taekwondo - White Belt to Yellow Belt", "Kung Fu: Choy Lee Fut (Oct)"). There
 * is no drop-in martial-arts session in the catalogue to lose, which is exactly the check
 * "swim" or "dance" would fail — those name drop-in sessions and one-off events as readily as
 * courses, and a bare rule on either would be a disaster. `taekwondo` was the reported gap;
 * `capoeira` (63 titles), `boxing` (22), `kickboxing`, `kung fu`, `wushu`, `jiu jitsu` and
 * `muay thai` were found by auditing the same shape rather than by patching the one example.
 *
 * `boxing` CARRIES A NEGATIVE LOOKAHEAD, AND IT IS NOT DECORATION. "Boxing Day" is a date, not a
 * discipline, and a Boxing Day family event is precisely the kind of genuine weekend content this
 * file's precision-over-recall rule exists to protect. The catalogue holds none today only
 * because it is September.
 *
 * DELIBERATELY ABSENT: `wrestling`, `fencing` and `self-defence`. Each has one or two live titles,
 * each reads as something other than a martial-arts programme at least as often as not
 * ("Classical Fencing" is a course; a fencing CONTRACTOR is not), and none of them is the reported
 * defect. Adding a term to answer a question nobody asked is how this alternation stops being
 * auditable.
 */
const MARTIAL_ART_PROGRAM =
  /\b(tae\s*kwon\s*-?\s*do|karate|judo|jiu[\s-]?jitsu|jujitsu|ju[\s-]?jutsu|aikido|hapkido|kendo|kung[\s-]?fu|wushu|muay\s+thai|capoeira|krav[\s-]?maga|martial\s+arts?|kickboxing)\b|\bboxing\b(?!\s+day)/i;

/** The subset of a listing this predicate reads — so both the DB record and the UI DTO satisfy it. */
export interface RegistrationSignalInput {
  activityName: string;
  suitabilityTags?: string[];
  categoryTags?: string[];
  /**
   * `activity_occurrence.registration_required` — what the SOURCE ITSELF said, when it said
   * anything. TRI-STATE: true / false / null-or-undefined = the source was silent.
   *
   * This is the column this module's header anticipated ("sized to be replaced by a real
   * column, not to be permanent"). It is populated today only by the `library` and
   * `perfectmind` families (supabase/migrations/0027); every other row is null and still
   * gets the title heuristic below, unchanged.
   */
  registrationRequired?: boolean | null;
}

/** True when the listing carries any positive "no booking needed" signal (tag or title prose). */
export function hasDropInSignal(listing: RegistrationSignalInput): boolean {
  if (listing.registrationRequired === false) return true;
  const tags = [...(listing.suitabilityTags ?? []), ...(listing.categoryTags ?? [])];
  if (tags.includes(DROP_IN_TAG)) return true;
  return DROP_IN_TITLE.test(listing.activityName ?? '');
}

/**
 * True when the listing reads as a registration-required course/camp/lesson rather than something
 * a parent can turn up to today.
 *
 * A PERSISTED SOURCE FACT WINS OVER THE TITLE, IN BOTH DIRECTIONS. Everything below the first
 * two lines is unchanged and still runs for the ~99% of rows that carry no fact — but where the
 * vendor itself answered the question, guessing from words is strictly worse than reading the
 * answer. The graded policy the investigation recommended, implemented as one branch: structured
 * vendor flag → fact; calendar name → (not wired here); title prose → heuristic.
 *
 * The `true` branch deliberately outranks `hasDropInSignal`'s title vocabulary, and that is the
 * only behaviour change with teeth: a BiblioCommons event titled "Baby Storytime" whose own
 * registrationInfo says you must log in to register is a course you must book, however
 * drop-in-shaped its name reads. The veto in `hasDropInSignal` exists because the registration
 * signal is normally a GUESS; when it is the vendor's own structured flag, the reason for the
 * veto is gone.
 *
 * WHAT THE LIBRARY BOOLEAN NOW MEANS. It is derived from `loginToRegister ||
 * enabledMethods.length > 0` (worker/adapters/library/index.ts) — i.e. the vendor has an
 * enabled registration mechanism. `maxSeats`/`cap` were originally included and were removed
 * in QA round 139: a seat cap with no enabled method asserts "you must register" for an event
 * that cannot be registered for, which would have evicted genuinely walk-in storytimes from
 * the default view. Narrowing cost zero live rows (no configured system uses the gateway path
 * that produces this value). Residual breadth is small but non-zero: an event with an enabled
 * method may still admit walk-ins. Precision remains unmeasured — see source-register F-16 —
 * and that measurement should precede extending this signal to another family.
 */
export function isRegistrationShaped(listing: RegistrationSignalInput): boolean {
  if (listing.registrationRequired === true) return true;
  if (hasDropInSignal(listing)) return false;
  const title = listing.activityName ?? '';
  return REGISTRATION_TITLE.test(title) || PROGRAM_LEVEL.test(title) || MARTIAL_ART_PROGRAM.test(title);
}

/** Narrowing helper for call sites that hold a full `ListingRecord`. */
export function isRegistrationShapedListing(listing: ListingRecord): boolean {
  return isRegistrationShaped(listing);
}
