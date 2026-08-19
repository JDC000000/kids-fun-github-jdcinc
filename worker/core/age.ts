// worker/core/age.ts — deterministic age-band normaliser (T13 deterministic-first layer).
//
// Adapters capture `record.ageText` as raw free-text ("ages 0-2", "All ages",
// "grades K-3", "toddler time"). Until now nothing resolved that into the
// structured `occurrence_age` row (age_min_months / age_max_months /
// age_band_matches[]) the search-side age filter reads — so every listing looked
// like "all ages / unknown" and the age facet was effectively inert.
//
// This module is the DETERMINISTIC-first half of §5.2's "deterministic-first,
// LLM-fallback" boundary. It resolves the common, unambiguous wordings with
// regex/keyword rules and leaves genuinely ambiguous text UNRESOLVED (bounds
// null, raw kept in age_notes) as a clean worklist for the future,
// credential-gated LLM-fallback. No external calls, no new credential, no new
// migration (occurrence_age + age_band already exist since 0005_taxonomy).
//
// Convention: age_min_months is INCLUSIVE, age_max_months is EXCLUSIVE
// ("up to but not including"), null = open-ended. A written year range "A-B"
// includes B-year-olds, i.e. up to the (B+1)th birthday -> max = (B+1)*12. This
// lines the derived ranges up exactly with the seeded bands (under2 0-24,
// 2-4 24-60, 5-9 60-120, 10-14 120-180, 15+ 180-∞) so band matching is clean.

import type { Pool } from 'pg';

export interface AgeParse {
  ageMinMonths: number | null;
  ageMaxMonths: number | null; // exclusive upper; null = open-ended
  resolved: boolean;
  notes?: string;
  /**
   * The SEPARATE ranges this parse was built from, when it came from more than one independent
   * claim (a structured audience tag list). Absent for an ordinary single-phrase parse.
   *
   * WHY THE BOUNDS ABOVE ARE NOT ENOUGH. `ageMinMonths`/`ageMaxMonths` are the CONVEX HULL of
   * those ranges — the lowest low and the highest high — and a hull silently fills in the gap
   * between two disjoint claims. Tags ["Babies", "Adults"] hull to [0, ∞), which matches all
   * five bands when the source claimed exactly two of them. The hull is still the honest answer
   * for the DISPLAYED min/max (a listing spanning babies and adults does start at 0 and has no
   * ceiling), but it must not decide band MEMBERSHIP. `computeAgeBandMatches` uses these
   * components when present, so bands are the true union of what was actually claimed.
   */
  components?: Array<{ ageMinMonths: number | null; ageMaxMonths: number | null }>;
}

export interface AgeBandRow {
  id: string;
  key: string;
  lowerMonthsInclusive: number;
  upperMonthsExclusive: number | null;
}

const YEARS = 12;
const UNRESOLVED: AgeParse = { ageMinMonths: null, ageMaxMonths: null, resolved: false };

/** Keyword → [minInclusive, maxExclusive) months. Ordered most-specific first. */
const KEYWORD_BANDS: Array<{ re: RegExp; min: number; max: number | null }> = [
  { re: /\b(?:newborn|infants?|babies|baby|babytime)\b/, min: 0, max: 24 },
  { re: /\b(?:toddlers?|toddler\s*time)\b/, min: 12, max: 36 },
  // `ers?` not `ers`: the singular "preschooler" is a real title word ("|Parent and
  // Preschooler|", live and unresolved in production) and `preschool(?:ers)?` cannot match it —
  // \b fails after "preschool" and the "ers" alternative needs the plural. Same claim as the
  // plural already makes, one character apart.
  { re: /\b(?:preschool(?:ers?)?|pre-?k|kindergarten|kinder)\b/, min: 36, max: 60 },
  { re: /\b(?:tweens?)\b/, min: 108, max: 156 },
  { re: /\b(?:teens?|teenagers?|youth)\b/, min: 144, max: 216 },
  // Broad "kids/children/school-age" last so a more specific word above wins.
  { re: /\b(?:kids?|children|child|school[-\s]?age)\b/, min: 60, max: 144 },
];

// "all ages" / "family" / "everyone" / "all welcome" → open range [0, ∞).
const ALL_AGES_RE = /\ball[-\s]?ages?\b|\bfamil(?:y|ies)\b|\beveryone\b|\ball\s+welcome\b/;

// NOT PART OF A DECIMAL. Both numeric rules below run over titles as well as prose, and a
// title's most common number is not an age — it is a skill rating. "Pickleball - 3.0+" was
// resolving to `0+` (the "0" of "3.0"), i.e. ages ZERO AND UP, matching all five bands and
// putting an adult pickleball session in front of a parent searching for a baby; "Pickleball
// 3.0-4.0" read the "0-4" across the decimal point and published the session as "ages 0-4",
// a TODDLER-ONLY label on adult programming. Both directions are the same mistake — a digit
// that belongs to a decimal is not a standalone number — so the guard is shared rather than
// patched onto whichever rule was noticed first.
//
// Verified against production 2026-08-16: 2 live listings held the 0+/all-five-bands form.
// The count is small and the failure is not: this is the exact "?age=under2 returns
// pickleball" harm the effectiveness review reported, and it recurs for ANY decimal in a
// title, which rec-centre skill ratings supply endlessly (2.5, 3.0, 3.5, 4.0).
// `:` IS IN THE CLASS BECAUSE A CLOCK TIME IS THE SAME MISTAKE WITH A DIFFERENT SEPARATOR, and
// it is the worse one. A decimal rating usually leaves the string unresolvable; a clock time
// forms a plausible RANGE, and RANGE_RE runs BEFORE the keyword fallback — so it does not merely
// fail, it OVERRIDES a correct audience word sitting in the same title:
//   "teens 6:00-8:00pm"        was 0-108 months  — a TEEN programme claiming BABIES, its own
//                                                  correct [10-14, 15+] thrown away
//   "toddler time 10:00-11:00" was 0-144 months  — same shape, same loss
//   "Adult Swim 6:00-7:00pm"   was 0-96  months  — a session titled "Adult Swim", claiming babies
//   "Pickleball 1:00-2:00"     was 0-36  months  — the pickleball harm again, via ':' not '.'
// Found by QA fuzzing the decimal guard. Rec-centre titles carry a session time far more often
// than they carry a skill rating, so this is the commoner half of the same defect.
const NOT_DECIMAL_BEFORE = /(?<![\d.,:])/.source; // not preceded by a digit, decimal or clock colon
const NOT_DECIMAL_AFTER = /(?![.,:]\d)/.source; //  not the leading part of a decimal or clock time

// A SKILL LEVEL IS THE THIRD MEMBER OF THE SAME FAMILY: a title number that is not an age.
// "Balanced Body Pilates (Level 1-2)" published as ages 12-36 months — an adult Pilates class
// labelled UNDER-2s AND 2-4s, resolved:true, i.e. stated as fact rather than left unknown.
// "Pickleball Lesson – Skills & Drills Level (1-2)" is the same, and "Wushu Level 2+ Novice-
// Intermediate" is the same defect through MIN_ONLY_RE instead of RANGE_RE ("level 2 and up"
// read as "age 2 and up", four bands including 2-4). Verified on the live catalogue
// 2026-08-18: 5 distinct programmes, 2 via the range rule and 3 via the min-only rule.
//
// WHY THIS IS A STRIP AND NOT ANOTHER LOOKAROUND, WHICH IS WHERE THE OBVIOUS FIX BREAKS
// The decimal/clock guards work as lookarounds because a digit inside "3.0" is disqualified by
// what touches it. A skill level is not: "Level 1-2" and "Aikido Beginner Level (5-7yrs)" have
// the SAME shape and only the second is an age — the difference is the unit "yrs", which sits
// AFTER the number a lookbehind would have to reject. A `(?<!level\s*\(?\s*)` guard therefore
// throws away the correct age on the second title, which is live and currently right. So the
// disqualifier is "labelled AND unit-less", and it is applied by removing the level phrase
// before parsing rather than by guarding each numeric rule:
//   • one place instead of two, so MIN_ONLY_RE cannot be left behind the way it was for the
//     decimal guard's first cut;
//   • it preserves the existing "skip the bad number, keep looking" behaviour that
//     tests/ingestion/age.test.ts pins for clock times — "Level 1-2 (ages 5-7)" still resolves
//     to 5-7, because only "Level 1-2" is removed.
// Labels are the three the live data actually carries (level/lvl, stage, set). Widening this
// list is a measured change, not a guess: "Session 1-2" and "Week 1-2" are plausible and absent
// from the catalogue today, and each new word is a new chance to eat a real age range.
const SKILL_LABEL = /(?:levels?|lvl|stages?|sets?)/.source;
/**
 * A number that is NOT immediately qualified as an age — "1", "2+", but not "5yrs".
 *
 * `(?!\d)` is load-bearing, not tidiness: without it the engine satisfies the unit check by
 * BACKTRACKING to a shorter number, so "Level (8-12yrs)" matched "8-1" and left "2yrs)" behind —
 * turning a correct 8-12 year listing into a 2-year-old one. Caught by running this against the
 * live catalogue rather than against the two titles the fix was written for.
 */
const UNLABELLED_NUM = `\\d{1,2}(?!\\d)\\s*\\+?(?!\\s*(?:years?|yrs?|yr|months?|mos?|mo)\\b)`;
const LABEL_GAP = `\\b[\\s:#.\\-–—]*\\(?\\s*`;
const RANGE_SEP = `\\s*(?:[-–—/&]|to|and)\\s*`;
// Ordered longest-first: the range form must win, and the single form must then REFUSE to match
// half of a range it rejected — otherwise "Level (5-7yrs)" falls back to stripping "Level (5"
// and destroys the very age the range form was protecting.
const SKILL_LEVEL_RE = new RegExp(
  `\\b${SKILL_LABEL}${LABEL_GAP}${UNLABELLED_NUM}${RANGE_SEP}${UNLABELLED_NUM}\\s*\\)?` +
    `|\\b${SKILL_LABEL}${LABEL_GAP}${UNLABELLED_NUM}(?!${RANGE_SEP}\\d)\\s*\\)?`,
  'gi'
);

/**
 * Remove "Level 1-2" / "Stage 2" / "Set 1" style skill markers so their numbers cannot be read
 * as ages. Only the marker is removed, never the rest of the string — the remaining text is
 * still parsed normally.
 */
export function stripSkillLevels(text: string): string {
  return text.replace(SKILL_LEVEL_RE, ' ');
}

// Explicit numeric year/month ranges: "ages 0-2", "0 - 2 years", "2 to 4", "6-18 months".
//
// EACH END CARRIES ITS OWN OPTIONAL UNIT, because a source is allowed to change units mid-range
// and several do: "age 10 months to 2 years" (Richmond Public Library's Toddler Time), "6 mo-5
// yrs", "18 months to 3 years". The unit used to be readable only after the SECOND number, so
// any range that named a unit on the FIRST one failed to match AT ALL — the separator had to
// follow the digits immediately and "months" is not a separator. Those listings then fell all
// the way through to `unresolved`, which is the one outcome that is not true here: the source
// stated the age plainly, in words this module already understands on their own.
//
// A single trailing unit still governs BOTH ends ("6-18 months" is 6 and 18 MONTHS, not 6 years
// to 18 months) — that is what `?? ` below preserves, and it is why the first unit is optional
// rather than required.
const AGE_UNIT = /(years?|yrs?|yr|months?|mos?|mo)?/.source;
const RANGE_RE = new RegExp(
  `(?:ages?\\s*)?${NOT_DECIMAL_BEFORE}(\\d{1,2})${NOT_DECIMAL_AFTER}\\s*${AGE_UNIT}\\s*(?:-|–|—|to)\\s*${NOT_DECIMAL_BEFORE}(\\d{1,2})${NOT_DECIMAL_AFTER}\\s*${AGE_UNIT}`
);
// "5+", "5 years and up", "18 months+".
const MIN_ONLY_RE = new RegExp(
  `${NOT_DECIMAL_BEFORE}(\\d{1,2})${NOT_DECIMAL_AFTER}\\s*(years?|yrs?|yr|months?|mos?|mo)?\\s*(?:\\+|and\\s+up|&\\s*up|and\\s+older|plus)`
);
// "under 5", "under 2 years".
const UNDER_RE = /under\s*(\d{1,2})\s*(years?|yrs?|yr|months?|mos?|mo)?/;
// "grades K-3", "grade 2-5", "gr K–3". Grade g → ages [g+5, g+6]; K = 0.
const GRADE_RE = /grades?\s*(k|\d{1,2})\s*(?:-|–|—|to)?\s*(k|\d{1,2})?/;

function isMonths(unit?: string): boolean {
  return !!unit && /^m/.test(unit);
}

function gradeToMonths(g: string): number {
  const grade = g === 'k' ? 0 : Number(g);
  return (grade + 5) * YEARS; // start age of that grade
}

// ── free-text age WORDING extraction (the step BEFORE parseAgeText) ───────────
//
// parseAgeText() resolves wording that has already been isolated. Pulling that
// wording OUT of a prose description is a separate job, and it belongs here rather
// than inside an adapter: G-T10-2 needed it for Eventbrite descriptions and would
// otherwise have authored a THIRD private copy of the same idea.
//
// KNOWN DUPLICATION, recorded rather than silently widened: two adapters already
// carry their own tuned variants —
//   • worker/adapters/library/index.ts   (AGE_RANGE_RE + AGE_HINT_RE) — the pair
//     this helper is modelled on, for the same reason: BiblioCommons descriptions
//     are free prose in which an explicit "ages 5-9" should beat a bare "family".
//   • worker/adapters/citycalendar/index.ts (AGE_HINT_RE) — deliberately DIFFERENT
//     (narrower 30-char window, includes seniors/adults) because the Trumba feed's
//     structured "Audiences" field is preferred first and the regex is only a
//     fallback for the rare item without one.
// They are NOT interchangeable today, so this helper does not rewrite them — that
// consolidation is a real, separately-QA'd change to two other adapters' behaviour
// and is logged as a follow-up, not smuggled into this task.

/**
 * An explicit numeric age/grade range — the strongest signal, preferred when present.
 * Widened by one alternation over the library adapter's version: `aged` as well as
 * `age`/`ages`, because "children aged 3-6" is ordinary prose in an organizer-written
 * Eventbrite description and the narrower pattern silently loses it to a bare "family"
 * keyword elsewhere in the same text. Verified against the fixture in
 * worker/adapters/eventbrite/__fixtures__/.
 *
 * EXPORTED so a caller can ask "does THIS text state an age on its own?" before deciding
 * to feed it in. That question is the eventbrite adapter's title gate (see its
 * `titleStatesAge`), and it must be answered by the SAME pattern extractAgeWording will
 * later apply — a fourth private copy of "what counts as a stated age" is the drift
 * hazard documents/kids-fun-open-findings-2026-08-18.md §3e/§3g both flag. Stateless
 * (no /g), so `.test()` from anywhere is safe.
 */
export const AGE_RANGE_RE = /(?:age[sd]?|grades?)\s*[\dK][^.<\n]{0,40}/i;
/** An audience keyword — the weaker fallback when no numeric range is stated. */
const AGE_KEYWORD_RE =
  /(?:children|kids|teens?|tweens?|youth|toddlers?|babies|baby|infants?|preschool(?:ers?)?|kindergarten|family|families|all ages)[^.<\n]{0,40}/i;

/**
 * Pull the age WORDING out of free prose, preferring an explicit numeric range over an
 * audience keyword. Returns undefined when the text says nothing about age — which is a
 * neutral signal (no age claim), not a parse failure, and is what the confidence
 * formula's `ageResolved: null` case expects. Feed the result to parseAgeText().
 */
export function extractAgeWording(...texts: Array<string | null | undefined>): string | undefined {
  const hay = texts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!hay) return undefined;
  const range = AGE_RANGE_RE.exec(hay);
  if (range) return range[0].trim();
  const keyword = AGE_KEYWORD_RE.exec(hay);
  return keyword ? keyword[0].trim() : undefined;
}

/**
 * Deterministically resolve free-text age wording into an inclusive-min /
 * exclusive-max month range. Returns { resolved:false } (null bounds) when the
 * text is empty or too ambiguous for confident rules — those are the cases the
 * LLM-fallback is meant to handle later.
 */
export function parseAgeText(ageText?: string | null): AgeParse {
  if (!ageText) return { ...UNRESOLVED };
  const raw = ageText.toLowerCase().trim();
  if (!raw) return { ...UNRESOLVED };
  // Skill-level markers are removed before ANY rule runs, so no numeric rule can read one as an
  // age. A string that is NOTHING BUT a level marker ("Set 1") strips to empty and falls through
  // to the unresolved branch below — deliberately, because that branch keeps the untouched
  // original in `notes`, and the LLM-fallback worklist must show what the source actually said
  // rather than what this module chose to ignore.
  const text = stripSkillLevels(raw).trim();

  // Explicit numeric range wins over everything else.
  const range = RANGE_RE.exec(text);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[3]);
    // A unit stated only after the SECOND number governs both ends, as it always has; a unit on
    // the first end now speaks for that end alone. No unit anywhere still means years.
    const loUnit = range[2] ?? range[4];
    const hiUnit = range[4];
    const min = isMonths(loUnit) ? lo : lo * YEARS;
    // The upper bound is EXCLUSIVE and the written one is inclusive, so it steps one unit past
    // what the source wrote: "6-18 months" includes 18-month-olds, "ages 2-4" includes
    // 4-year-olds up to their fifth birthday. Applied per-end, the mixed case follows the same
    // rule with no special pleading — "10 months to 2 years" ends where a 2-year-old's year
    // does, at 36 months. That is this module's ONE documented convention (see the file header)
    // applied uniformly, not a reading invented for mixed units; if the convention itself is
    // ever revisited, this case must move with it rather than being exempted.
    const max = isMonths(hiUnit) ? hi + 1 : (hi + 1) * YEARS;
    // Compared in MONTHS, not in the raw digits. "10 months to 2 years" is an ascending range
    // whose written numbers descend (10 > 2), and a digit comparison rejects it as reversed.
    if (max > min) return { ageMinMonths: min, ageMaxMonths: max, resolved: true };
  }

  const under = UNDER_RE.exec(text);
  if (under) {
    const n = Number(under[1]);
    const max = isMonths(under[2]) ? n : n * YEARS;
    return { ageMinMonths: 0, ageMaxMonths: max, resolved: true };
  }

  const minOnly = MIN_ONLY_RE.exec(text);
  if (minOnly) {
    const n = Number(minOnly[1]);
    const min = isMonths(minOnly[2]) ? n : n * YEARS;
    return { ageMinMonths: min, ageMaxMonths: null, resolved: true };
  }

  const grade = GRADE_RE.exec(text);
  if (grade) {
    const min = gradeToMonths(grade[1]);
    const hi = grade[2] ?? grade[1];
    const max = gradeToMonths(hi) + YEARS; // through the end of that grade year
    if (max > min) return { ageMinMonths: min, ageMaxMonths: max, resolved: true };
  }

  if (ALL_AGES_RE.test(text)) {
    return { ageMinMonths: 0, ageMaxMonths: null, resolved: true, notes: 'all-ages' };
  }

  for (const band of KEYWORD_BANDS) {
    if (band.re.test(text)) {
      return { ageMinMonths: band.min, ageMaxMonths: band.max, resolved: true };
    }
  }

  // Nothing matched confidently — leave for the LLM-fallback, keep the raw text.
  return { ageMinMonths: null, ageMaxMonths: null, resolved: false, notes: `unresolved: ${ageText.trim()}` };
}

// ── structured audience labels (a source's OWN taxonomy, not prose) ──────────
//
// parseAgeText() reads ONE free-text phrase and, past the numeric/grade rules,
// takes the FIRST matching KEYWORD_BANDS entry — most-specific-first ordering
// that exists to stop the broad `children` rule stealing a phrase containing a
// narrower word. That ordering is correct for prose and WRONG for a list of
// discrete audience tags, where every tag is an independent claim by the source
// and the honest answer is their UNION: VPL tags a Family Storytime
// ["Storytimes", "Preschool Age Children", "Toddlers", "English"] and means
// toddlers THROUGH preschoolers ([12,60) months), not whichever one the keyword
// table happens to reach first.
//
// Hence a separate entry point rather than a widened parseAgeText: prose keeps
// first-match-wins, structured lists get the union. Non-age tags ("Storytimes",
// "English", "Summer Reading Club") resolve to nothing and contribute nothing,
// so the caller can pass the source's whole tag list unfiltered.

/**
 * Audience words that are only ever a RELIABLE age claim when the source states
 * them as a structured tag. Deliberately NOT added to KEYWORD_BANDS: "adults"
 * inside "Adults accompanying children under 9 must stay in the library" is
 * prose about supervision, not an audience, and a keyword table cannot tell the
 * difference. A tag literally reading "Adults" can.
 */
const ADULT_AUDIENCE_RE = /^\s*(?:adults?|seniors?|older\s+adults?)\b/i;
/**
 * 19 years, BC's age of majority — the SAME floor as
 * lib/search/filters/audience.ts's ADULT_ONLY_AGE_MIN_MONTHS, and it has to be. This was 18
 * years, so a tag-derived adult listing resolved to 216 months: above the ingest side's adult
 * floor, below the search side's, and therefore tagged adult at ingest but never excluded as
 * adult-only by the filter. Changing either constant alone re-opens that 12-month gap.
 */
const ADULT_MIN_MONTHS = 19 * YEARS;

/**
 * A tag that names CHILDREN and then says "all ages" — Richmond publishes exactly this, as
 * "Children-All Ages". Taken at face value the "all ages" half wins (ALL_AGES_RE is checked
 * before the keyword table) and the tag resolves to [0, ∞), so a children's bookmark contest
 * claims the 15+ band. The tenant's own prefix says otherwise: the audience is children.
 *
 * Bounded at the seeded taxonomy's teen boundary (180 months = the lower edge of `15+`) rather
 * than at a number I picked — "all child ages" is exactly "every band below the teen band", so
 * this reads the ceiling off the same table the bands come from instead of inventing one.
 */
const CHILD_ALL_AGES_RE = /\b(?:children|child|kids?)\b/i;
const CHILD_MAX_MONTHS = 15 * YEARS;

/**
 * Resolve a source's structured audience tags into the UNION of every range they
 * claim. Returns { resolved:false } when no tag carries an age signal, which is
 * the caller's cue to fall back to whatever weaker wording it has — an unresolved
 * audience list is silence, not a claim.
 */
export function parseAudienceLabels(labels: Array<string | null | undefined>): AgeParse {
  // Resolve every tag first, then decide which ones SPEAK — because a catch-all tag sitting
  // beside a specific one must not drown it. Richmond tags its preschool storytime
  // ["Children-Preschool", "Families"]: both are real audience tags, but "Families" means
  // caregivers are welcome, not that the programme suits a fifteen-year-old. Unioned flat it
  // resolves to [0, ∞) and matches every band, throwing away the only tag that said anything
  // specific. Same principle as the rest of this fix: the more specific claim wins.
  const resolvedTags: Array<{ label: string; min: number | null; max: number | null; catchAll: boolean }> = [];
  for (const raw of labels) {
    const label = raw?.trim();
    if (!label) continue;
    if (ADULT_AUDIENCE_RE.test(label)) {
      resolvedTags.push({ label, min: ADULT_MIN_MONTHS, max: null, catchAll: false });
      continue;
    }
    const parsed = parseAgeText(label);
    if (!parsed.resolved) continue;
    // `notes === 'all-ages'` is set by exactly one branch of parseAgeText — the ALL_AGES_RE
    // one — so it is a reliable marker for "this tag named no age group at all".
    const catchAll = parsed.notes === 'all-ages';
    const boundedToChildren = catchAll && CHILD_ALL_AGES_RE.test(label);
    resolvedTags.push({
      label,
      min: parsed.ageMinMonths,
      max: boundedToChildren ? CHILD_MAX_MONTHS : parsed.ageMaxMonths,
      // A children-bounded tag IS a real audience claim, so it is not a catch-all any more.
      catchAll: catchAll && !boundedToChildren,
    });
  }

  const specific = resolvedTags.filter((t) => !t.catchAll);
  const speaking = specific.length > 0 ? specific : resolvedTags;

  let min: number | null = null;
  let max: number | null = null;
  let openEnded = false;
  const contributing: string[] = [];
  const components: Array<{ ageMinMonths: number | null; ageMaxMonths: number | null }> = [];

  for (const tag of speaking) {
    contributing.push(tag.label);
    // Each tag's own range is kept intact for band matching; the running hull below is only
    // for the displayed min/max. Collapsing them into one range here is what let two disjoint
    // tags claim every band in between.
    components.push({ ageMinMonths: tag.min, ageMaxMonths: tag.max });
    const lo = tag.min ?? 0;
    min = min === null ? lo : Math.min(min, lo);
    if (tag.max === null) openEnded = true;
    else max = max === null ? tag.max : Math.max(max, tag.max);
  }

  if (!contributing.length) return { ...UNRESOLVED };
  return {
    ageMinMonths: min ?? 0,
    ageMaxMonths: openEnded ? null : max,
    resolved: true,
    notes: `audience: ${contributing.join(', ')}`,
    components,
  };
}

/**
 * Ids of every seeded age_band whose [lower, upper) interval overlaps the
 * listing's [min, maxExclusive) range. Both intervals are half-open, so the
 * overlap test is strict-less-than on both sides — a "5-9" listing ([60,120))
 * matches only the 5-9 band, never bleeding into 2-4 or 10-14. Unknown bounds
 * (unresolved) → no matches, and the search filter's "empty → don't hide" rule
 * keeps the listing visible.
 */
export function computeAgeBandMatches(
  parse: Pick<AgeParse, 'ageMinMonths' | 'ageMaxMonths'> & Pick<Partial<AgeParse>, 'components'>,
  bands: AgeBandRow[]
): string[] {
  // Several independent claims (audience tags) → the UNION of each one's bands, never the
  // bands of their hull. See AgeParse.components: hulling first invents membership in every
  // band that happens to sit in the gap between two disjoint claims.
  const ranges = parse.components?.length ? parse.components : [parse];
  const matched = new Set<string>();
  for (const range of ranges) {
    const { ageMinMonths: min, ageMaxMonths: max } = range;
    if (min === null && max === null) continue;
    const lo = min ?? 0;
    const hiExcl = max ?? Number.POSITIVE_INFINITY;
    for (const b of bands) {
      const bandHi = b.upperMonthsExclusive ?? Number.POSITIVE_INFINITY;
      if (lo < bandHi && b.lowerMonthsInclusive < hiExcl) matched.add(b.id);
    }
  }
  // Preserve the seeded band ORDER rather than Set insertion order, so the stored array is
  // stable regardless of the order the source happened to list its tags in.
  return bands.filter((b) => matched.has(b.id)).map((b) => b.id);
}

/** Load the seeded age bands once per ingest run. */
export async function loadAgeBands(pool: Pool): Promise<AgeBandRow[]> {
  const { rows } = await pool.query<{
    id: string;
    key: string;
    lower_months_inclusive: number;
    upper_months_exclusive: number | null;
  }>(`SELECT id, key, lower_months_inclusive, upper_months_exclusive FROM age_band ORDER BY lower_months_inclusive`);
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    lowerMonthsInclusive: Number(r.lower_months_inclusive),
    upperMonthsExclusive: r.upper_months_exclusive === null ? null : Number(r.upper_months_exclusive),
  }));
}

/**
 * Idempotent upsert of the structured age row for an occurrence, keyed on
 * occurrence_id. Re-ingesting the same record overwrites in place (same
 * discipline as upsertOccurrence) so the age facet never drifts or duplicates.
 */
export async function upsertOccurrenceAge(
  pool: Pool,
  occurrenceId: string,
  parse: AgeParse,
  bandMatchIds: string[]
): Promise<void> {
  await pool.query(
    `INSERT INTO occurrence_age (occurrence_id, age_min_months, age_max_months, age_band_matches, age_notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (occurrence_id) DO UPDATE SET
       age_min_months   = EXCLUDED.age_min_months,
       age_max_months   = EXCLUDED.age_max_months,
       age_band_matches = EXCLUDED.age_band_matches,
       age_notes        = EXCLUDED.age_notes`,
    [occurrenceId, parse.ageMinMonths, parse.ageMaxMonths, bandMatchIds, parse.notes ?? null]
  );
}
