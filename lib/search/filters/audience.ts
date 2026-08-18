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
// Three independent signals, because none alone is trustworthy on today's data:
//   1. TITLE prose — "adult", "senior", "19+", "55+". The only signal for the many rows whose
//      age columns were mis-parsed ("Adult 19yrs+ Swim" is stored as age_min_months = 0).
//   2. The SOURCE'S OWN STATED AUDIENCE, carried verbatim in `ageNotes`. Some sources say who a
//      programme is for in their audience taxonomy and nowhere else: Richmond Public Library's
//      "Supporting People Together: The Basics of Overdose Response" is tagged "…, Adults,
//      English" and has no adult word in its title and no parsed age at all, so signals (1) and
//      (3) both miss it and an adult harm-reduction talk was returned to a search for ages 2-4.
//   3. STRUCTURED age — an OPEN-ENDED minimum at or above the age of majority. This is what
//      catches the senior-centre programming no title regex could ("Mah Jong", "Bridge Drop-In",
//      "Open Lounge"), which carries no adult word but is stored as 55y+ with no upper bound.
//
// Signal (2) reads `ageNotes` and NOT `descriptionSnippet`, which is the other field the source's
// wording could in principle live in. Measured on the live catalogue (2026-08-18, f975a40): 0 of
// 5639 harvested listings have a non-empty `descriptionSnippet` — every source family leaves
// `activity_occurrence.description_snippet` null — so reading it would be unreachable code today,
// and it is the RISKIER field of the two: free description prose is where "adults accompanying
// children must remain in the library" lives, and a hard exclusion must not be driven off prose.
//
// The open-ended requirement in (3) is load-bearing, not incidental. A genuine adult/senior
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

/**
 * An adult/senior audience TAG, anchored at the start of the tag. The anchor is the entire
 * point and is lifted from worker/core/age.ts's ADULT_AUDIENCE_RE, which documents why:
 *
 *   > "adults" inside "Adults accompanying children under 9 must stay in the library" is prose
 *   > about supervision, not an audience, and a keyword table cannot tell the difference. A tag
 *   > literally reading "Adults" can.
 *
 * An unanchored /adults?/ over the same field would hide genuine kids content — the worse
 * failure direction for a hard exclusion with no user-facing escape hatch.
 */
const ADULT_AUDIENCE_TAG = /^\s*(?:adults?|seniors?|older\s+adults?)\b/i;

/**
 * `ageNotes` is `occurrence_age.age_notes` verbatim, and worker/core/age.ts writes it in exactly
 * two prefixed forms — `audience: <tags the source published>` when the tag list resolved, and
 * `unresolved: <the raw source text>` when nothing in it parsed. The tags themselves start after
 * that marker, so an anchored tag match has to step over it first. Stripping BOTH markers rather
 * than just the one today's rows carry is deliberate: the live library rows were ingested before
 * the audience-tag path existed and read `unresolved: …, Adults, English`, and a re-ingest will
 * rewrite the very same rows as `audience: Adults`. This signal must survive that transition.
 *
 * `llm-unresolved:` is the same case, one generation later. lib/llm/age-fallback.ts's no-op
 * branch stamped rows in that shape before 2026-08-18, and what follows the marker is again the
 * SOURCE's own wording, re-embedded verbatim — so those rows must be read, not skipped. (Rows
 * stamped after that date carry the marker as a trailing parenthetical, `Adults (llm-resolved)`,
 * which needs no stripping and is why this list does not have to keep growing.)
 *
 * `llm-resolved:` is deliberately NOT here. A row in that legacy shape holds the MODEL's
 * reasoning — the source's wording was overwritten and is not recoverable from this column — and
 * this function is documented to report what the SOURCE said. Tag-matching model prose would be
 * manufacturing a source claim, which is the wrong kind of input to a hard exclusion.
 */
const AGE_NOTES_MARKER = /^\s*(?:audience|unresolved|llm-unresolved)\s*:\s*/i;

/**
 * A source publishes its audience taxonomy as a LIST, which reaches the read model flattened
 * into one string ("International Overdose Awareness Day, Health, …, Adults, English"). Each
 * separated segment is one independent claim by the source, so the anchor is applied per
 * segment — anchoring at the start of the whole FIELD would only ever see the first tag.
 */
const AUDIENCE_TAG_SEPARATOR = /[,|;\n]+/;

/**
 * Supervision prose — a rule about who must come WITH the child, which is the one sentence shape
 * that both starts with "Adults" and means the opposite of an adult audience. worker/core/age.ts
 * names it as the reason its own tag regex is anchored ("Adults accompanying children under 9
 * must stay in the library"), and the parent-and-child veto only catches it because that
 * particular sentence happens to say "children" — reword it to "…accompanying under-9s…" and the
 * anchor alone would hide a genuine kids listing. Vetoing the sentence SHAPE closes that.
 */
const SUPERVISION_PROSE = /\baccompan(?:y|ies|ied|ying)\b|\bsupervis(?:e|ed|ing|ion|or)\b|\bmust\s+(?:stay|remain|be|not)\b|\bwithin\s+arm'?s?\s+reach\b|\bratio\b/i;

/** The subset of a listing this predicate reads — so both the DB record and the UI DTO satisfy it. */
export interface AudienceSignalInput {
  activityName: string;
  ageMinMonths?: number | null;
  ageMaxMonths?: number | null;
  /** `occurrence_age.age_notes` — the source's own audience wording. See statesAdultAudience(). */
  ageNotes?: string | null;
}

/**
 * True when a listing is adult-only or senior-only programming and does not belong in a
 * children's product at all. Parent-and-child sessions return false even when they say "adult".
 */
export function isAdultOrSeniorOnly(listing: AudienceSignalInput): boolean {
  const title = listing.activityName ?? '';
  if (PARENT_AND_CHILD.test(title)) return false;
  if (ADULT_ONLY_TITLE.test(title)) return true;
  if (statesAdultAudience(listing.ageNotes)) return true;
  return hasOpenEndedAdultAgeFloor(listing);
}

/**
 * True when the SOURCE itself names an adult/senior audience and names no child one.
 *
 * Both vetoes are checked over the whole field before any tag is read, so a mixed audience list
 * ("Babies, Adults") and a supervision sentence ("Adults accompanying children under 9…",
 * "children under 6 must be within arm's reach of an adult") each keep the listing visible.
 * That is the fail-safe direction this filter needs: an ambiguous audience is not a claim of
 * child-appropriateness, but it is not grounds for a silent hard exclusion either.
 */
function statesAdultAudience(ageNotes: string | null | undefined): boolean {
  const notes = ageNotes?.trim();
  if (!notes) return false;
  if (PARENT_AND_CHILD.test(notes) || SUPERVISION_PROSE.test(notes)) return false;
  return notes
    .replace(AGE_NOTES_MARKER, '')
    .split(AUDIENCE_TAG_SEPARATOR)
    .some((tag) => ADULT_AUDIENCE_TAG.test(tag));
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
