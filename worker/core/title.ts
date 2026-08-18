// worker/core/title.ts — ingest-time title normalisation (P1-3).
//
// THE DEFECT. Source systems publish their listing title as a packed field rather than a
// name: `|Public Swim|` arrives with the vendor's own field delimiters still attached, and
// PerfectMind's EventName routinely carries the price and the session's weekday/time inside
// the string — `$3 Open Gym 8yrs+ Delbrook Thursday 3:30-5:00pm`. All three of those facts
// are ALREADY columns on activity_occurrence (cost_min_cad/cost_status,
// start_datetime_utc/end_datetime_utc) and are already rendered next to the title on the
// card, so the title was repeating structured data back at the reader in the source's own
// punctuation. It reads as unprocessed scrape output, which is exactly the impression a
// listing index cannot afford.
//
// WHY AT INGEST AND NOT AT RENDER. Same discipline as every other correction in this
// pipeline: fix it as close to the source as possible, once, and keep the raw value. A
// render-time strip would run on every request, would have to be duplicated in the search
// index, the card, the detail page and the weekly email, and would leave the DB holding the
// junk — so `activity_series.canonical_title`, the FTS vector and every dedup comparison
// would still be computed over `|Public Swim|`. Normalising here means the catalogue itself
// is clean and there is exactly one implementation.
//
// ── WHAT IS STRIPPED, AND THE EVIDENCE EACH RULE DEMANDS ───────────────────────────────
// This normaliser is deliberately timid. A title is an activity's NAME, and this project has
// already been burned once by a title rule that was too eager (see worker/core/age.ts's note
// on the title-as-age-claim inference, measured at 33/33 false positives). Every rule below
// therefore requires an UNAMBIGUOUS marker, never a bare number:
//
//   • pipes and square brackets — `|`, `[`, `]`. Field delimiters, never name punctuation in
//     any of the six families. The CHARACTERS are removed; whatever sat between them is
//     kept, because the delimiter is the junk, not the words.
//   • price — only a `$`-marked amount (`$3`, `$3.00`, `$0.00 - $8.75`). The currency sign is
//     the evidence. A bare number is NEVER a price here.
//   • clock times, and a weekday ONLY when it is attached to one. A time token must carry a
//     colon (`3:30`) or a meridiem (`5pm`); a bare number never qualifies. This is what keeps
//     `8yrs+`, `0-12 yrs`, `Ages 6-13`, `Level 2`, `Grades K-7` and the rec-centre skill
//     ratings (`Pickleball - 3.0+`) intact — none of them can reach the time rules at all.
//
// A BARE WEEKDAY WITH NO TIME IS LEFT ALONE, on purpose. `Monday Funday`, `Saturday Club` and
// `Sunday Skate` are real program names on these sources; a weekday only becomes redundant
// noise once it is sitting next to the session time that start_datetime_utc already states.
//
// ── WHAT THIS MUST NOT DISTURB ─────────────────────────────────────────────────────────
// PIPELINE ORDER IS LOAD-BEARING. worker/core/ingest.ts applies this AFTER adapter.extract()
// and normalizeHook() have both run, and that is a correctness constraint, not a style
// choice: two adapters derive `ageText` from the raw title (activenet's extractAgeText, which
// admits the whole title when it states an age, and eventbrite's extractAgeWording over
// e.name). Normalising before extract would hand those a string this file had already edited.
// Running after means worker/core/age.ts's inputs — `record.ageText` and
// `record.ageAudienceLabels` — are byte-identical to what they were before this module
// existed. age.ts does not read `record.title` at all.
import type { StructuredRecord } from './adapter';

/** Vendor field delimiters. Removed as characters; the words between them survive. */
const DELIMITER_CHARS_RE = /[|[\]]+/g;

/** `$3`, `$3.00`, `$1,250`, and `$0.00 - $8.75`. The `$` is the whole evidence. */
const AMOUNT = String.raw`\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?`;
const PRICE_RE = new RegExp(String.raw`${AMOUNT}(?:\s*(?:-|–|—|to)\s*(?:\$\s*)?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)?`, 'gi');

// A clock time needs a colon with TWO following digits (`3:30`) or a meridiem (`5pm`,
// `5 p.m.`). `2:1 ratio` fails the two-digit rule; `8yrs+` and `3.0+` fail both.
const MERIDIEM = String.raw`[ap]\.?\s?m\.?`;
const CLOCK = String.raw`\d{1,2}:\d{2}(?:\s*${MERIDIEM})?`;
const HOUR_WITH_MERIDIEM = String.raw`\d{1,2}\s*${MERIDIEM}`;
const TIME_TOKEN = String.raw`(?:${CLOCK}|${HOUR_WITH_MERIDIEM})`;
// A range may open with a bare hour (`3-5pm`) only because its CLOSING token proves the pair
// is a time. `0-12 yrs` cannot match: `12 yrs` is not a time token.
const TIME_RANGE = String.raw`(?:\d{1,2}(?::\d{2})?\s*(?:-|–|—|to)\s*${TIME_TOKEN}|${TIME_TOKEN}(?:\s*(?:-|–|—|to)\s*${TIME_TOKEN})?)`;

const WEEKDAY = String.raw`(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?s?`;
/** Weekday list (`Mon & Wed`, `Tues/Thurs`) — matched ONLY as a prefix of a real time. */
const WEEKDAY_PREFIX = String.raw`(?:\b${WEEKDAY}\b[\s,&/+]*(?:and\s+)?(?:-\s*)?)*`;

const WEEKDAY_TIME_RE = new RegExp(String.raw`\b${WEEKDAY_PREFIX}${TIME_RANGE}`, 'gi');

/** Bracket/paren pairs left holding nothing once their contents were stripped. */
const EMPTY_GROUP_RE = /\(\s*\)|\{\s*\}/g;
/** Separator punctuation stranded at either end, or doubled up mid-string, by a removal. */
const EDGE_PUNCT_RE = /^[\s\-–—:;,/&]+|[\s\-–—:;,/&]+$/g;
const DOUBLED_SEPARATOR_RE = /\s*([-–—:;,/])\s*(?:[-–—:;,/]\s*)+/g;

/**
 * Strip source-system packaging from a listing title, preserving everything that could be
 * part of the activity's actual name.
 *
 * TOTAL, AND NEVER EMPTY. If every rule fires and nothing survives (a title that was only
 * ever a price and a time), the trimmed ORIGINAL is returned rather than an empty string:
 * a blank `activity_name` is a worse outcome than a noisy one, and it would violate the
 * column's NOT NULL besides.
 */
export function normalizeTitle(raw: string): string {
  const original = (raw ?? '').trim();
  if (!original) return original;

  const cleaned = original
    .replace(DELIMITER_CHARS_RE, ' ')
    .replace(PRICE_RE, ' ')
    .replace(WEEKDAY_TIME_RE, ' ')
    .replace(EMPTY_GROUP_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(DOUBLED_SEPARATOR_RE, ' $1 ')
    .replace(EDGE_PUNCT_RE, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || original;
}

/**
 * Apply normalisation to one record, preserving the source's own wording in `sourceTitle`.
 *
 * `sourceTitle` IS SET UNCONDITIONALLY, including when nothing changed. Setting it only on a
 * changed title would save a few bytes and buy an ambiguity: a null could then mean either
 * "the source said exactly this" or "this row predates the normaliser", and no reader could
 * tell which — the precise failure mode migration 0031's null-semantics note is about. Set
 * always, `sourceTitle` means one thing: what the source published.
 *
 * An adapter that has already set `sourceTitle` keeps it — it knows better than this hop what
 * its own raw wording was.
 */
export function withNormalizedTitle(record: StructuredRecord): StructuredRecord {
  const normalized = normalizeTitle(record.title);
  return {
    ...record,
    title: normalized,
    sourceTitle: record.sourceTitle ?? record.title,
  };
}
