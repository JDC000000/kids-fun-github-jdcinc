// worker/adapters/library/generic-rss.ts — the library family's THIRD platform handler
// (after `bibliocommons` and `communico`): a plain RSS 2.0 events feed with no vendor
// namespace at all. Built for NVDPL (North Vancouver District Public Library,
// nvdpl.events.mylibrary.digital/rss) as a 4th tenant under decision record D-12.
//
// WHY A NEW HANDLER RATHER THAN A CONFIG ENTRY ON AN EXISTING ONE
// The library family's premise is "a new library system is a config entry, not new code",
// and that held for VPL→RPL (same BiblioCommons shape). It does NOT hold here, because
// this feed is materially thinner than either existing platform. Live-verified 2026-07-31
// against a real 97-item pull; every item carries EXACTLY:
//     title · link · guid · pubDate · description · media:content
// No branch element, no age element, no cost element, no structured location, no UTC
// timestamps, no cancellation flag. Everything this adapter emits beyond the title and
// link has to be recovered from free text in `description`, which is what the rest of
// this file does — deterministically, and refusing to guess where the payload is silent.
//
// THE FOUR TRAPS THIS FILE EXISTS TO HANDLE, each measured on that live pull rather
// than assumed:
//
//  1. THE EVENT DATE IS FREE TEXT INSIDE `description`, not a date element:
//     `<strong>Date/Time:</strong> Tue, 4 Aug 2026, 10:30am - 11:00am`.
//     Present on 97/97 items (100%) — see parseDateTimeRange.
//
//  2. `pubDate` IS THE RSS PUBLICATION DATE, NOT THE EVENT DATE. Measured: 96 of 97
//     items carry a pubDate on a DIFFERENT CALENDAR DAY from the event, spread from
//     March to July for an August event window. Using it would have produced a wrong
//     date for ~99% of records while looking perfectly healthy. It is read ONLY as
//     provenance into `raw`, and is structurally incapable of reaching a datetime
//     field: parseDateTimeRange never sees it.
//
//  3. LOCAL WALL CLOCK, NO OFFSET. "10:30am" carries no zone, so it goes through the
//     shared DST-correct converter in worker/core/time.ts — the same one the
//     BiblioCommons and ActiveNet paths use. Not reimplemented here.
//
//  4. NO STRUCTURED VENUE. Venue is recovered from the title, the description prose, or
//     a trailing address block, matched against a CURATED location table — never
//     invented. An item naming no recognisable location keeps the system as its venue
//     and emits no address and no coordinates. See resolveLocation.
//
// AND TWO MORE THIS FILE FOUND THAT THE SCOPING PASS DID NOT (both live-verified):
//
//  5. NOT EVERY ITEM IS AN EVENT. `Library Closure: BC Day` is a service notice with a
//     perfectly valid Date/Time ("Mon, 3 Aug 2026, 10:00am - 6:00pm"). Ingested naively
//     it becomes an 8-hour "activity" on a statutory holiday. See NON_EVENT_TITLE_RE.
//
//  6. THE DATE/TIME SHAPE IS NOT UNIFORM. The scoping pass reported "100% of items carry
//     it in one consistent shape (Ddd, D Mon YYYY, h:mmam - h:mmam)". Re-measuring found
//     100% carry the FIELD but 96/97 carry that SHAPE: `Kindergarten Book Bags` publishes
//     a MULTI-DAY range with a second full date on the end side
//     (`Mon, 24 Aug 2026, 10:00am - Sat, 29 Aug 2026, 5:00pm`). A parser assuming one
//     shape either drops it or mis-reads the end time. Both forms are parsed; the
//     multi-day form is a date-RANGE notice rather than a single occurrence, so it is
//     excluded from records and COUNTED (never silently dropped) — see diagnostics.
//
// COMPLIANCE POSTURE (D-12, narrow): NVDPL's robots.txt is UNREADABLE (HTTP 403,
// Cloudflare managed challenge) — which is fail-closed under this project's own T11
// precedent. Jon explicitly overrode that for NVDPL BY NAME on 2026-07-31; the override
// does not generalise to any other source. See docs/source-register.md and decision
// record D-12. What this file still owes regardless of that override: one plain,
// unauthenticated GET through the shared politeFetch seam, no cookie, no session, no
// credential — asserted behaviourally in tests/compliance/no-bypass.test.ts.
import { zonedLocalToUtcIso } from '../../core/time';
import { firstTag, stripHtml, tagBlocks } from './rss-text';
import type { LibraryBranchLocation, LibrarySystemConfig } from './config';
// The family-wide run-health vocabulary (itemsInFeed / emitted / droppedByLimit, the tally
// line, and the empty-feed / collapse / truncation verdicts). Extracted from this file so
// the BiblioCommons path can reuse it instead of growing a second copy — see ./run-health.ts.
import {
  YIELD_COLLAPSE_RATIO,
  assessLibraryFeedRun,
  formatFeedTally,
  type LibraryFeedTally,
  type LibraryHealthVerdict,
} from './run-health';

/** A generic-RSS event after normalisation. Mirrors what the feed can actually support. */
export interface GenericRssEvent {
  id: string;
  title: string;
  venueName: string;
  startsAt: string;
  endsAt?: string;
  ages?: string;
  url: string;
  descriptionText: string;
  categoryHint: string;
  location?: LibraryBranchLocation;
  /** Which signal resolved the venue — kept for auditability, not for display. */
  venueResolvedFrom: 'address_block' | 'title' | 'description' | 'unresolved';
  /** Why this item was classified as kid-relevant. Same rationale as above. */
  kidSignal: 'title' | 'description';
  /** RSS publication date, verbatim. Provenance ONLY — never an event time (trap 2). */
  pubDate?: string;
}

/**
 * Per-run tallies. Every item the parser declines to emit lands in exactly one bucket,
 * so "why is this source's yield lower than the feed's item count?" always has an
 * answer on the health board instead of needing a re-pull to reconstruct. That invariant —
 * the buckets sum to `itemsInFeed` — is asserted directly in
 * tests/adapters/library-nvdpl-rss.test.ts.
 *
 * `itemsInFeed` / `emitted` / `droppedByLimit` come from the family-wide `LibraryFeedTally`
 * (./run-health.ts); the buckets below are this platform's own. On `emitted` specifically:
 * it is deliberately NOT named `kidRelevant`, because an item can classify kid-relevant and
 * still not be emitted (a multi-day range, an unparseable date), so a field called
 * `kidRelevant` holding the emit count would understate the classifier's own hit rate —
 * measured on the live pull, 42 items classify kid-relevant but 41 emit.
 */
export interface GenericRssParseDiagnostics extends LibraryFeedTally {
  /** Skipped: service notices (closures), not programming. */
  nonEventNotices: number;
  /** Skipped: multi-day date RANGES, which are not single occurrences (trap 6). */
  multiDayRanges: number;
  /** Skipped: no parseable Date/Time — the shape-drift canary. */
  unparseableDateTime: number;
  /** Skipped: real programming, but not for kids/families. */
  notKidRelevant: number;
  /** Skipped: missing title/link, i.e. structurally unusable. */
  malformedItems: number;
}

export interface GenericRssParseResult {
  events: GenericRssEvent[];
  diagnostics: GenericRssParseDiagnostics;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The free-text Date/Time parser (traps 1, 3 and 6).
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The one shape the feed publishes, in both its single-date and multi-date forms:
 *
 *   Tue, 4 Aug 2026, 10:30am - 11:00am                          (96/97 items)
 *   Mon, 24 Aug 2026, 10:00am - Sat, 29 Aug 2026, 5:00pm        (1/97 items)
 *
 * The leading weekday is optional and ignored — it is redundant with the date and would
 * only be a second thing that can disagree. Long month names and an en/em dash separator
 * are accepted because they cost nothing and are the obvious way this feed could drift.
 */
const DATE_TIME_RANGE_RE = new RegExp(
  '^(?:[A-Za-z]{3,9},\\s*)?' + // optional "Tue, "
    '(\\d{1,2})\\s+([A-Za-z]{3,9})\\s+(\\d{4}),\\s*' + // 4 Aug 2026,
    '(\\d{1,2}):(\\d{2})\\s*([ap])\\.?m\\.?' + // 10:30am
    '\\s*[-\u2013\u2014]\\s*' + // - / – / —
    '(?:(?:[A-Za-z]{3,9},\\s*)?(\\d{1,2})\\s+([A-Za-z]{3,9})\\s+(\\d{4}),\\s*)?' + // optional 2nd date
    '(\\d{1,2}):(\\d{2})\\s*([ap])\\.?m\\.?$',
  'i'
);

/** `<strong>Date/Time:</strong> …` up to the end of that HTML block. */
const DATE_TIME_LABEL_RE = /Date\s*\/\s*Time:\s*<\/strong>\s*([^<]+)/i;

export interface ParsedDateTimeRange {
  /** Local wall-clock "YYYY-MM-DDTHH:MM" — input to zonedLocalToUtcIso, never UTC itself. */
  startLocal: string;
  endLocal: string;
  /** True when the end side carried its OWN full date, i.e. a multi-day range (trap 6). */
  spansMultipleDates: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 12-hour → 24-hour. 12:xxam is 00:xx and 12:xxpm is 12:xx; both are easy to get wrong. */
function to24Hour(hour12: number, meridiem: string): number | undefined {
  if (hour12 < 1 || hour12 > 12) return undefined;
  const base = hour12 % 12;
  return meridiem.toLowerCase() === 'p' ? base + 12 : base;
}

/**
 * True only if (y, m, d) is a real calendar date. Needed because Date.UTC silently ROLLS
 * OVER — Date.UTC(2026, 1, 31) is 3 March — so a feed typo like "31 Feb 2026" would
 * otherwise become a confident, wrong, perfectly valid-looking timestamp.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

/** Local calendar day after (y, m, d), as "YYYY-MM-DD". Month/year rollover included. */
function nextLocalDate(year: number, month: number, day: number): string {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/**
 * Parse the feed's free-text Date/Time into local wall-clock strings.
 *
 * Returns undefined — rather than a guess — for anything that does not match: a missing
 * label, an unknown month, an impossible date, an out-of-range hour. An item with no
 * parseable time is counted and skipped, because a listing whose time we invented is
 * worse for a parent than a listing that is absent.
 */
export function parseDateTimeRange(rawRange: string): ParsedDateTimeRange | undefined {
  const m = DATE_TIME_RANGE_RE.exec(rawRange.trim());
  if (!m) return undefined;

  const [, d1, mon1, y1, h1, min1, ap1, d2, mon2, y2, h2, min2, ap2] = m;

  const startMonth = MONTHS[mon1.slice(0, 3).toLowerCase()];
  const startYear = Number(y1);
  const startDay = Number(d1);
  const startHour = to24Hour(Number(h1), ap1);
  const startMinute = Number(min1);
  if (!startMonth || startHour === undefined || !isRealDate(startYear, startMonth, startDay)) {
    return undefined;
  }
  const startLocal = `${startYear}-${pad(startMonth)}-${pad(startDay)}T${pad(startHour)}:${pad(startMinute)}`;

  const endHour = to24Hour(Number(h2), ap2);
  const endMinute = Number(min2);
  if (endHour === undefined) return undefined;
  const endClock = `${pad(endHour)}:${pad(endMinute)}`;

  // Multi-day form: the end side carried its own full date.
  if (d2 && mon2 && y2) {
    const endMonth = MONTHS[mon2.slice(0, 3).toLowerCase()];
    const endYear = Number(y2);
    const endDay = Number(d2);
    if (!endMonth || !isRealDate(endYear, endMonth, endDay)) return undefined;
    return {
      startLocal,
      endLocal: `${endYear}-${pad(endMonth)}-${pad(endDay)}T${endClock}`,
      spansMultipleDates: true,
    };
  }

  // Single-date form. An end clock at or before the start means the event crosses
  // midnight (e.g. "11:00pm - 1:00am"), so the end belongs to the NEXT local day.
  // Resolved on local calendar days and only then converted, so the DST-correct
  // conversion in worker/core/time.ts still gets a well-formed local wall clock.
  const crossesMidnight =
    endHour * 60 + endMinute <= startHour * 60 + startMinute;
  const endDate = crossesMidnight
    ? nextLocalDate(startYear, startMonth, startDay)
    : `${startYear}-${pad(startMonth)}-${pad(startDay)}`;

  return { startLocal, endLocal: `${endDate}T${endClock}`, spansMultipleDates: false };
}

/** Pull the raw Date/Time text out of an item's (already once-decoded) description HTML. */
export function extractDateTimeText(descriptionHtml: string): string | undefined {
  return DATE_TIME_LABEL_RE.exec(descriptionHtml)?.[1]?.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Classification: is this item an event at all, and is it kid programming?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SERVICE NOTICES, not programming (trap 5). `Library Closure: BC Day` publishes a valid
 * Date/Time and would otherwise ingest as an all-day drop-in activity on a day the
 * library is shut. Anchored to the title so a program that merely MENTIONS a closure in
 * its description is unaffected.
 */
const NON_EVENT_TITLE_RE = /^\s*(?:library\s+)?closur(?:e|es)\b|^\s*closed\b|\bclosure:\s/i;

/**
 * Audience vetoes. An explicit adults/seniors-only marker beats any incidental family
 * wording in the same item ("deeper than is tolerated by friends and family" — a real
 * description in this feed, on an adult philosophy discussion group).
 *
 * THE SECOND GROUP OF MARKERS EXISTS BECAUSE OF A REAL MISCLASSIFICATION (QA finding F-A).
 * NVDPL runs a "Summer Reading Rave" series — 5 occurrences in the live feed — which is
 * ADULT programming: silent-reading sessions with a mocktail, some of them after the branch
 * closes to the public. Every one was being emitted as kid content, because `summer reading`
 * is a kid-programming token in the title vocabulary below and a title match short-circuits
 * before the description is ever read. Worse, they were then cited in
 * docs/source-register.md as evidence the classifier had IMPROVED.
 *
 * The discriminator is deliberately SEMANTIC ("with other adults", "mocktail") rather than
 * the series name: matching the literal string "Summer Reading Rave" would break the moment
 * NVDPL renames it, and would not catch the next adult event that reuses a kid-sounding
 * title. Verified against the live feed — these markers hit exactly those 5 items and
 * nothing else, and specifically do NOT catch the "Summer Reading CLUB Celebration" items
 * (medal ceremonies for kids who read 50 days), which are genuine kid programming and stay
 * included. `after hours` / `after dark` were CONSIDERED AND REJECTED as markers: "Camp
 * Parkgate Stuffy Sleepover" is a real after-hours event FOR CHILDREN, so that phrasing does
 * not discriminate.
 */
// NOTE the deliberate absence of a TRAILING \b on the "NN+" alternatives. `\b` after
// `\+` can never match — `+` is a non-word character, so "(55+)" and "55+." both failed
// the veto until a test caught it. The age-marker forms are therefore bounded on the left
// only; the word forms keep both boundaries.
const ADULT_ONLY_RE =
  /\b(?:18|19|55)\s*\+|\b(?:adults?\s+only|seniors?\s+only|adult\s+program)\b|\bwith\s+other\s+adults\b|\bmocktails?\b|\bafter\s+the\s+library\s+doors\s+close\b/i;

/**
 * KID/FAMILY PROGRAM NAMES, in the TITLE. Deliberately restricted to tokens that are
 * kid-specific in a library-programming context, measured against the live feed rather
 * than brainstormed: broad words that appear in adult programming here (`chess`, `play`,
 * `craft`, `music`) are intentionally ABSENT, because they would sweep in Pins & Needles
 * (adult fibre arts) and the Tech Cafés. Genuinely all-ages items still qualify via the
 * description signal below — "Drop-In Chess" is admitted by its own "players of all
 * ages", not by the word "chess".
 */
const KID_TITLE_RE =
  /\b(?:story\s*time|storytime|babytime|baby|toddler(?:time)?|preschool|kindergarten|lego|duplo|tween|teen|kid|child(?:ren)?|famil(?:y|ies)|summer\s+reading|summer\s+fun|koala\s+koders|tinkercad|crafternoon|stuffy|dungeons\s+and\s+dragons|bubble\s+dance|math\s+lab|book\s+bags?)\b/i;

/**
 * AGE / AUDIENCE wording in the DESCRIPTION — the secondary signal, for programming whose
 * title is neutral. Structured age ranges first ("ages 9-11", "0 -12 months", "up to 5
 * years old", "grades 7-12"), then audience nouns. `kids` is matched in the plural
 * deliberately: singular "kid" appears in adult-facing prose in this feed ("if you have a
 * kid heading to university" — an event for outgoing high-school graduates).
 */
const KID_DESCRIPTION_RE =
  /\b(?:ages?\s*\d|\d+\s*-\s*\d+\s*(?:months?|years?)|up\s+to\s+\d+\s*years?|grades?\s*\d|infants?|babies|toddlers?|preschool(?:ers)?|kindergarten(?:ers)?|tweens?|teens?|children|kids|all\s+ages|whole\s+family|caregivers?)\b/i;

/** Raw age wording to carry forward for T13/normalizeHook. Never a resolved age band. */
const AGE_TEXT_RE =
  /(?:ages?|grades?)\s*[\dK][^.\n]{0,40}|\b(?:best\s+for|suitable\s+for|for)\s+[^.\n]{0,60}(?:months?|years?\s+old|year-olds?)|\ball\s+ages\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// The ANCHORED bare-range acceptance — shared with the BiblioCommons parser.
//
// WHY IT LIVES HERE AND NOT IN ./index.ts, which is the more natural home: index.ts
// already imports from this module (the generic_rss parser, its fixture and its run
// assessor), so the dependency runs index → generic-rss. Defining it there and importing
// it back would close that into a module cycle, and a cycle over module-scoped `const`
// RegExps is a TDZ fault at import time, not a lint warning. One definition, in the file
// that is already the leaf.
//
// WHAT IT IS FOR. Both library parsers used to require the literal word `ages`/`grades`
// IMMEDIATELY before the number, so a source stating its age in any other English shape
// was silently dropped — measured 2026-08-18 on the live feeds:
//   NVDPL "Camp Parkgate Stuffy Sleepover"  "best suited for children aged 4-8 years"
//                                           → no ageText at all
//   RPL   "Kids' Bookmark Contest"          "You must be 6-12 years old by August 31st"
//                                           → beaten by the tag "Children-All Ages" (0-15)
//   RPL   "Richmond Reads: Summer Book Club" "Must be 18+ to enter"
//                                           → beaten by the tag "All Ages" → ALL FIVE BANDS
//
// WHY IT IS ANCHORED, and this is the whole design. A BARE `N+` or `N-M years` is not an
// age claim — it is a quantity. `parseAgeText('10+ crafts')` returns [120, null], i.e. a
// craft-kit size published as "ages 10 and up"; the same string is why worker/core/age.ts
// is NOT the place for this and why the gate is at the adapter. So the number must be
// preceded, within a short window, by wording that makes it a statement about PEOPLE. The
// anchor list is docs/age-pattern-extraction-scope.md §8d's, plus `aged` — the exact word
// the one NVDPL record uses, and unambiguous in a way `for` alone is not.
//
// A number that can be an AGE. Lookarounds lifted verbatim from
// worker/adapters/activenet/parse.ts's AGE_NUMBER, which is where they were measured: they
// reject a clock time (6:00-8:00), a decimal skill rating (3.0-4.0) and a price ($5+).
const AGE_NUMBER = '(?<![\\d.,:$])\\d{1,2}(?![.,:]\\d)';
/** Wording that makes the number that follows a claim about people. */
const AGE_ANCHOR =
  '(?:ages?|aged|grades?|must\\s+be|suited\\s+for|best\\s+for|recommended\\s+for|for\\s+children)';
/**
 * The bare value itself: `4-8 years` / `6-12 years old` / `18+`. A range MUST carry a unit
 * — without one, "June 24 - August 31"-shaped copy and "1-2 winners" are indistinguishable
 * from an age. `N+` needs no unit because `+` after a small bare integer is already the
 * age idiom, which is exactly why it may only ever appear behind an anchor.
 */
const BARE_AGE_VALUE = `${AGE_NUMBER}\\s*(?:(?:-|–|—|to)\\s*${AGE_NUMBER}\\s*(?:yrs?|years?|months?|mos?)|\\+)`;
/** Group 1 is the age expression alone — the anchor is a guard, not part of the wording. */
const ANCHORED_BARE_AGE_RE = new RegExp(
  `${AGE_ANCHOR}\\b[^.<\\n]{0,20}?(${BARE_AGE_VALUE}(?:\\s+old)?)`,
  'i'
);

/**
 * The age wording a bare `N-M years` / `N+` offers, or undefined when nothing ANCHORS it.
 *
 * Deliberately a FALLBACK everywhere it is used, never a new alternative inside an existing
 * regex: JS alternation is leftmost-POSITION-wins, so folding this into `AGE_TEXT_RE` /
 * `AGE_RANGE_RE` could change which phrase wins on records that already resolve correctly.
 * As a separate second attempt it can only ever add wording where there was none.
 */
export function anchoredBareAgeWording(text: string): string | undefined {
  return ANCHORED_BARE_AGE_RE.exec(text)?.[1]?.trim();
}

/**
 * The haystack the EXPLICIT age tiers scan: the title as well as the description.
 *
 * NOT used by the keyword/audience tiers, deliberately. A title stating an age outright
 * ("… (Ages 8-12)") is the source's own claim and is strictly more precise than anything
 * downstream; a title merely CONTAINING a kid word is the kid-coded-title-marker inference
 * that was measured at a 57% error rate and killed (see worker/core/title.ts's header).
 * Widening the explicit tiers to the title is the fix; widening the keyword tier to it
 * would be that dead inference coming back through the side door.
 */
export function ageHaystack(title: string, descriptionText: string): string {
  // The '.' terminator matters: every pattern here is bounded by `[^.<\n]`, so it stops a
  // title's trailing words being spliced onto the description's opening ones.
  return `${title}. ${descriptionText}`;
}

/** This feed's raw age wording: the vetted pattern first, the anchored bare form second. */
export function genericRssAgeWording(title: string, descriptionText: string): string | undefined {
  const hay = ageHaystack(title, descriptionText);
  return hay.match(AGE_TEXT_RE)?.[0]?.trim() ?? anchoredBareAgeWording(hay);
}

export type KidRelevance =
  | { kidRelevant: true; signal: 'title' | 'description' }
  | { kidRelevant: false; reason: 'non_event_notice' | 'adult_only' | 'no_kid_signal' };

/**
 * Classify one item. Order matters: a service notice is not programming at all, and an
 * adults-only marker vetoes before any positive signal is consulted.
 *
 * Measured on the live 2026-07-31 pull: 42 of 97 items (43%) classify kid-relevant, with
 * every inclusion and every exclusion reviewed by hand. NOTE for anyone comparing against
 * the scoping pass's 31% — see docs/source-register.md; that figure was a conservative
 * floor from a 12-name keyword list, not a ceiling, and both numbers are recorded there.
 *
 * An earlier revision of this classifier reported 47/97 (48%). That was WRONG: it counted
 * the 5 adult "Summer Reading Rave" occurrences as kid programming (QA finding F-A). 43% is
 * the corrected figure, independently re-derived by QA to the same number.
 */
export function classifyKidRelevance(title: string, descriptionText: string): KidRelevance {
  if (NON_EVENT_TITLE_RE.test(title)) return { kidRelevant: false, reason: 'non_event_notice' };
  if (ADULT_ONLY_RE.test(`${title} ${descriptionText}`)) {
    return { kidRelevant: false, reason: 'adult_only' };
  }
  if (KID_TITLE_RE.test(title)) return { kidRelevant: true, signal: 'title' };
  if (KID_DESCRIPTION_RE.test(descriptionText)) return { kidRelevant: true, signal: 'description' };
  return { kidRelevant: false, reason: 'no_kid_signal' };
}

/** Category hint from the program name. Same vocabulary the BiblioCommons path uses. */
export function genericRssCategoryHint(title: string, descriptionText = ''): string {
  const t = `${title} ${descriptionText}`.toLowerCase();
  if (/story\s*time|babytime|toddlertime|baby\s+social/.test(t)) return 'storytime';
  if (/lego|duplo|free\s+play|bubble\s+dance|doodle/.test(t)) return 'indoor_play';
  return 'class_program';
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Venue resolution (trap 4).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A trailing address block. This feed has no location element, but SOME off-site items
 * append the address as consecutive final paragraphs:
 *
 *   <p>2510 Viewlynn Dr</p><p>North Vancouver, BC</p><p>V7J 2X3</p>
 *
 * Live-measured: present on 4 of 97 items (all Viewlynn Park Storytime occurrences) — a
 * small win, but a real one, and it is the only source of a street address anywhere in
 * this payload. Anchored on the Canadian postal code so it cannot fire on prose.
 */
const ADDRESS_BLOCK_RE =
  /<p>\s*([^<]{4,80}?)\s*<\/p>\s*<p>\s*([^<]{2,40}?),\s*BC\s*<\/p>\s*<p>\s*([A-Z]\d[A-Z]\s*\d[A-Z]\d)\s*<\/p>/i;

interface AddressBlock {
  street: string;
  city: string;
  postalCode: string;
}

function extractAddressBlock(descriptionHtml: string): AddressBlock | undefined {
  const m = ADDRESS_BLOCK_RE.exec(descriptionHtml);
  if (!m) return undefined;
  return {
    street: stripHtml(m[1]),
    city: stripHtml(m[2]),
    postalCode: stripHtml(m[3]).replace(/\s+/g, ' '),
  };
}

/** Case/punctuation-insensitive comparison key, matching the BiblioCommons path's rule. */
function normalizeLocationKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Find a curated location whose name appears in `haystack`. Curated names are matched as
 * whole words on a normalised string so "Capilano" cannot match inside another token, and
 * the LONGEST curated name wins — otherwise "Lynn Valley Library" would be resolved by a
 * shorter "Lynn Valley" entry and lose the more specific match.
 */
function matchCuratedLocation(
  system: LibrarySystemConfig,
  haystack: string
): [string, LibraryBranchLocation] | undefined {
  const needle = ` ${normalizeLocationKey(haystack)} `;
  const candidates = Object.entries(system.branchLocations ?? {}).filter(([name]) =>
    needle.includes(` ${normalizeLocationKey(name)} `)
  );
  if (candidates.length === 0) return undefined;
  return candidates.sort(
    (a, b) => normalizeLocationKey(b[0]).length - normalizeLocationKey(a[0]).length
  )[0];
}

export interface ResolvedGenericRssLocation {
  venueName: string;
  location?: LibraryBranchLocation;
  resolvedFrom: GenericRssEvent['venueResolvedFrom'];
}

/**
 * Resolve a venue from the RSS payload ALONE. Precedence, strongest evidence first:
 *
 *   1. A trailing address block in the description — the feed stating an address outright.
 *   2. A curated location name in the TITLE ("Viewlynn Park Storytime", "Summer Fun at
 *      Parkgate") — the signal the scoping pass identified.
 *   3. A curated location name in the description PROSE ("Join us at Parkgate Library
 *      to…") — free, already in the payload, and it resolves a large share of items whose
 *      titles are bare program names (Babytime, Toddlertime, Family Storytime).
 *   4. Nothing recognisable → the SYSTEM is the venue, with no address and no
 *      coordinates. That is not a fabrication: the event genuinely is an NVDPL event in
 *      North Vancouver; we simply do not know which branch, and say so via
 *      `resolvedFrom: 'unresolved'` rather than picking a plausible branch.
 *
 * NO per-event HTML fetch is attempted at any tier — NVDPL's HTML paths are
 * Cloudflare-challenged (403), and a venue is not worth a challenge-solving fetch.
 * NO geocoder is ever called; coordinates only ever come from the curated table.
 */
export function resolveLocation(
  system: LibrarySystemConfig,
  title: string,
  descriptionHtml: string,
  descriptionText: string
): ResolvedGenericRssLocation {
  const fromTitle = matchCuratedLocation(system, title);
  const fromDescription = fromTitle ? undefined : matchCuratedLocation(system, descriptionText);
  const curated = fromTitle ?? fromDescription;
  const addressBlock = extractAddressBlock(descriptionHtml);

  if (addressBlock) {
    const address = `${addressBlock.street}, ${addressBlock.city}, BC ${addressBlock.postalCode}`;
    return {
      venueName: curated?.[0] ?? addressBlock.street,
      location: {
        address,
        // Coordinates only if the curated entry has them. The feed publishes an address,
        // never a lat/lng, and this adapter does not geocode.
        lat: curated?.[1].lat,
        lng: curated?.[1].lng,
        municipalityName: curated?.[1].municipalityName ?? addressBlock.city,
        displayArea: curated?.[1].displayArea ?? '',
        locationUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,
      },
      resolvedFrom: 'address_block',
    };
  }

  if (curated) {
    return {
      venueName: curated[0],
      location: curated[1],
      resolvedFrom: fromTitle ? 'title' : 'description',
    };
  }

  return { venueName: system.systemName, resolvedFrom: 'unresolved' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The parser.
// ─────────────────────────────────────────────────────────────────────────────

/** guid/link → stable per-item id. This feed's links are `…/event?id=343348`. */
export function eventIdFromLink(link: string): string {
  const fromQuery = /[?&]id=([^&#]+)/i.exec(link)?.[1];
  if (fromQuery) return fromQuery;
  const cleaned = link.split(/[?#]/)[0].replace(/\/$/, '');
  return cleaned.split('/').pop() || cleaned;
}

/** Emit cap when a system config declares none. */
export const DEFAULT_GENERIC_RSS_LIMIT = 40;

/**
 * The cap a generic_rss parse ACTUALLY applies — config value, or the platform default when a
 * system omits it. Shared by the parser and the tally line so the line can never quote a cap
 * the parse did not use. Mirrors `biblioCommonsLimit` in ./index.ts.
 */
function genericRssLimit(system: LibrarySystemConfig): number {
  return system.liveEventsLimit ?? DEFAULT_GENERIC_RSS_LIMIT;
}

export function parseGenericRss(system: LibrarySystemConfig, xml: string): GenericRssParseResult {
  const items = tagBlocks(xml, 'item');
  const limit = genericRssLimit(system);
  const events: GenericRssEvent[] = [];
  const diagnostics: GenericRssParseDiagnostics = {
    itemsInFeed: items.length,
    emitted: 0,
    nonEventNotices: 0,
    multiDayRanges: 0,
    unparseableDateTime: 0,
    notKidRelevant: 0,
    malformedItems: 0,
    droppedByLimit: 0,
  };

  for (const item of items) {
    const title = firstTag(item, 'title');
    const link = firstTag(item, 'link') ?? firstTag(item, 'guid');
    if (!title || !link) {
      diagnostics.malformedItems += 1;
      continue;
    }

    // ONE decode pass yields the ESCAPED HTML this feed puts in <description>
    // (`&lt;p&gt;&lt;strong&gt;…`); stripHtml then flattens that markup to prose.
    // Both representations are needed: the date label and the address block are
    // positional in the MARKUP, while classification reads the PROSE.
    const descriptionHtml = firstTag(item, 'description') ?? '';
    const descriptionText = stripHtml(descriptionHtml);

    const relevance = classifyKidRelevance(title, descriptionText);
    if (!relevance.kidRelevant) {
      if (relevance.reason === 'non_event_notice') diagnostics.nonEventNotices += 1;
      else diagnostics.notKidRelevant += 1;
      continue;
    }

    const rawRange = extractDateTimeText(descriptionHtml);
    const parsed = rawRange ? parseDateTimeRange(rawRange) : undefined;
    if (!parsed) {
      diagnostics.unparseableDateTime += 1;
      continue;
    }
    if (parsed.spansMultipleDates) {
      // A multi-day range (a week-long registration window, a book-bag pickup period) is
      // not a single occurrence. Counted, not silently dropped.
      diagnostics.multiDayRanges += 1;
      continue;
    }

    const startsAt = zonedLocalToUtcIso(parsed.startLocal);
    if (!startsAt) {
      diagnostics.unparseableDateTime += 1;
      continue;
    }

    const { venueName, location, resolvedFrom } = resolveLocation(
      system,
      title,
      descriptionHtml,
      descriptionText
    );

    if (events.length >= limit) {
      diagnostics.droppedByLimit += 1;
      continue;
    }
    diagnostics.emitted += 1;

    events.push({
      id: eventIdFromLink(link),
      title,
      venueName,
      startsAt,
      endsAt: zonedLocalToUtcIso(parsed.endLocal),
      // Title AND description — see ageHaystack. The anchored bare-range form is a second
      // attempt, not a widened first one, so it can only speak where AGE_TEXT_RE is silent.
      ages: genericRssAgeWording(title, descriptionText),
      url: link,
      descriptionText,
      categoryHint: genericRssCategoryHint(title, descriptionText),
      location,
      venueResolvedFrom: resolvedFrom,
      kidSignal: relevance.signal,
      pubDate: firstTag(item, 'pubDate'),
    });
  }

  return { events, diagnostics };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Run health.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The share of a feed's items whose Date/Time may fail to parse before the run is called
 * broken rather than merely thin. The date lives in FREE TEXT, so a vendor changing that
 * one string is the single most likely way this adapter breaks — and it would break
 * quietly, as a low record count on a feed that still answers 200. 20% is well above the
 * measured rate (0 of 97 kid-relevant items failed) and well below "the shape changed".
 */
export const MAX_UNPARSEABLE_DATE_SHARE = 0.2;

/**
 * A run emitting less than this share of its trailing baseline has collapsed.
 *
 * WHY THIS MATTERS MORE HERE THAN FOR A STRUCTURED SOURCE. Everything this adapter emits
 * beyond title and link is recovered from free text, so the realistic failure is PARTIAL,
 * not total: NVDPL rewords the Date/Time label for some templates, or shortens the rolling
 * window, and yield falls 46 → 5 while the feed still answers 200 and `emitted > 0`. The
 * absolute-zero checks would pass that as green. That is the check that catches it — and it
 * now lives in ./run-health.ts, shared with the BiblioCommons path, because the collapse
 * question is identical on any feed. Re-exported here so existing importers of this module
 * keep resolving the same value from the same place.
 */
export { YIELD_COLLAPSE_RATIO };

/** Retained as the generic_rss-facing name for the family-wide verdict shape. */
export type GenericRssHealthVerdict = LibraryHealthVerdict;

/** This platform's skip buckets, in the order the tally line has always rendered them. */
function genericRssSkipBuckets(d: GenericRssParseDiagnostics) {
  return [
    { label: 'not-kid', count: d.notKidRelevant },
    { label: 'notices', count: d.nonEventNotices },
    { label: 'multi-day ranges', count: d.multiDayRanges },
    { label: 'unparseable dates', count: d.unparseableDateTime },
    { label: 'malformed', count: d.malformedItems },
  ];
}

/**
 * Fold parse diagnostics into a verdict for the health board.
 *
 * The universal checks (empty feed, yield collapse) come from `assessLibraryFeedRun`; the
 * ONLY thing this platform adds is the free-text `date_shape_drift` canary below, which is
 * meaningless on a structured feed. It is passed as the platform hook so it keeps its exact
 * previous position in the verdict order — after the collapse checks, and last, now that the
 * client-side-truncation alert that used to follow it has been deleted (see the deletion note
 * in ./run-health.ts). `droppedByLimit` is still counted and still in the tally line.
 *
 * `baselineRecordsFound` is the source's trailing record count (null on a first run, or when
 * the caller has no DB). `live` says whether the run that produced `diagnostics` actually hit
 * the network; see the fixture-trap note on `assessLibraryFeedRun`.
 */
export function assessGenericRssRun(
  system: LibrarySystemConfig,
  diagnostics: GenericRssParseDiagnostics,
  baselineRecordsFound: number | null = null,
  live = false
): GenericRssHealthVerdict {
  return assessLibraryFeedRun(
    system,
    diagnostics,
    formatFeedTally(diagnostics, genericRssSkipBuckets(diagnostics), genericRssLimit(system)),
    baselineRecordsFound,
    live,
    (tally) =>
      diagnostics.unparseableDateTime / diagnostics.itemsInFeed > MAX_UNPARSEABLE_DATE_SHARE
        ? {
            code: 'date_shape_drift',
            alert: true,
            detail: `${system.systemKey}: free-text Date/Time parse failed on >${Math.round(
              MAX_UNPARSEABLE_DATE_SHARE * 100
            )}% of items — ${tally}`,
          }
        : null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Fixture (default, no-network posture).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A REAL slice of the NVDPL feed, captured 2026-07-31, trimmed to four items and
 * otherwise byte-faithful — including the `&lt;p&gt;&lt;strong&gt;` escaped-HTML
 * description shape, which is the single most important thing a hand-written fixture
 * would have gotten wrong.
 *
 * The four items are chosen so the default fixture path exercises every branch of the
 * parser rather than just the happy one:
 *   1. Babytime                — kid signal from the TITLE, venue from description prose
 *   2. Viewlynn Park Storytime — venue from the trailing ADDRESS BLOCK
 *   3. Pins and Needles        — real programming, adult: must be filtered OUT
 *   4. Library Closure: BC Day — a service notice with a valid Date/Time: filtered OUT
 */
export const GENERIC_RSS_FIXTURE_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Events | North Vancouver District Public Library</title>
    <link>https://nvdpl.events.mylibrary.digital/rss</link>
    <item>
      <title>Babytime</title>
      <link>https://nvdpl.events.mylibrary.digital/event?id=343348</link>
      <guid isPermaLink="true">https://nvdpl.events.mylibrary.digital/event?id=343348</guid>
      <description>&lt;p&gt;&lt;strong&gt;Date/Time:&lt;/strong&gt; Tue, 4 Aug 2026, 10:30am - 11:00am&lt;/p&gt;&lt;p&gt;Come learn songs and rhymes to sing to your baby at Lynn Valley Library.&lt;/p&gt;
&lt;p&gt;Best for infants, 0 -12 months.&amp;nbsp;&lt;/p&gt;</description>
      <pubDate>Wed, 20 May 2026 16:14:59 -0700</pubDate>
      <media:content medium="image" url="https://example.invalid/event-images/1708120550-835.jpg" />
    </item>
    <item>
      <title>Viewlynn Park Storytime</title>
      <link>https://nvdpl.events.mylibrary.digital/event?id=345306</link>
      <guid isPermaLink="true">https://nvdpl.events.mylibrary.digital/event?id=345306</guid>
      <description>&lt;p&gt;&lt;strong&gt;Date/Time:&lt;/strong&gt; Wed, 5 Aug 2026, 10:30am - 11:00am&lt;/p&gt;&lt;p&gt;Join a children&amp;rsquo;s librarian at Viewlynn Park for stories, songs and fun under the trees. Suitable for little ones, up to 5 years old.&amp;nbsp;&lt;/p&gt;
&lt;p&gt;&lt;/p&gt;
&lt;p&gt;2510 Viewlynn Dr&lt;/p&gt;
&lt;p&gt;North Vancouver, BC&lt;/p&gt;
&lt;p&gt;V7J 2X3&lt;/p&gt;</description>
      <pubDate>Fri, 31 Jul 2026 13:11:24 -0700</pubDate>
    </item>
    <item>
      <title>Pins and Needles</title>
      <link>https://nvdpl.events.mylibrary.digital/event?id=340111</link>
      <guid isPermaLink="true">https://nvdpl.events.mylibrary.digital/event?id=340111</guid>
      <description>&lt;p&gt;&lt;strong&gt;Date/Time:&lt;/strong&gt; Tue, 4 Aug 2026, 1:00pm - 2:00pm&lt;/p&gt;&lt;p&gt;Pins &amp;amp; Needles welcomes needle workers of all kinds! Gather at the Library for a friendly session of knitting, crocheting, sewing or other fibre arts.&lt;/p&gt;</description>
      <pubDate>Mon, 22 Jun 2026 16:12:10 -0700</pubDate>
    </item>
    <item>
      <title>Library Closure: BC Day</title>
      <link>https://nvdpl.events.mylibrary.digital/event?id=331500</link>
      <guid isPermaLink="true">https://nvdpl.events.mylibrary.digital/event?id=331500</guid>
      <description>&lt;p&gt;&lt;strong&gt;Date/Time:&lt;/strong&gt; Mon, 3 Aug 2026, 10:00am - 6:00pm&lt;/p&gt;&lt;p&gt;All locations of the library are closed today in observance of the BC Day statutory holiday.&lt;/p&gt;</description>
      <pubDate>Wed, 18 Mar 2026 17:20:52 -0700</pubDate>
    </item>
  </channel>
</rss>`;
