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
  { re: /\b(?:preschool(?:ers)?|pre-?k|kindergarten|kinder)\b/, min: 36, max: 60 },
  { re: /\b(?:tweens?)\b/, min: 108, max: 156 },
  { re: /\b(?:teens?|teenagers?|youth)\b/, min: 144, max: 216 },
  // Broad "kids/children/school-age" last so a more specific word above wins.
  { re: /\b(?:kids?|children|child|school[-\s]?age)\b/, min: 60, max: 144 },
];

// "all ages" / "family" / "everyone" / "all welcome" → open range [0, ∞).
const ALL_AGES_RE = /\ball[-\s]?ages?\b|\bfamil(?:y|ies)\b|\beveryone\b|\ball\s+welcome\b/;

// Explicit numeric year/month ranges: "ages 0-2", "0 - 2 years", "2 to 4", "6-18 months".
const RANGE_RE =
  /(?:ages?\s*)?(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*(years?|yrs?|yr|months?|mos?|mo)?/;
// "5+", "5 years and up", "18 months+".
const MIN_ONLY_RE = /(\d{1,2})\s*(years?|yrs?|yr|months?|mos?|mo)?\s*(?:\+|and\s+up|&\s*up|and\s+older|plus)/;
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
 */
const AGE_RANGE_RE = /(?:age[sd]?|grades?)\s*[\dK][^.<\n]{0,40}/i;
/** An audience keyword — the weaker fallback when no numeric range is stated. */
const AGE_KEYWORD_RE =
  /(?:children|kids|teens?|tweens?|youth|toddlers?|babies|baby|infants?|preschool(?:ers)?|kindergarten|family|families|all ages)[^.<\n]{0,40}/i;

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
  const text = ageText.toLowerCase().trim();
  if (!text) return { ...UNRESOLVED };

  // Explicit numeric range wins over everything else.
  const range = RANGE_RE.exec(text);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (hi >= lo) {
      if (isMonths(range[3])) {
        return { ageMinMonths: lo, ageMaxMonths: hi + 1, resolved: true };
      }
      // year range: B-year-olds included → exclusive max at (B+1) years.
      return { ageMinMonths: lo * YEARS, ageMaxMonths: (hi + 1) * YEARS, resolved: true };
    }
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
const ADULT_MIN_MONTHS = 18 * YEARS;

/**
 * Resolve a source's structured audience tags into the UNION of every range they
 * claim. Returns { resolved:false } when no tag carries an age signal, which is
 * the caller's cue to fall back to whatever weaker wording it has — an unresolved
 * audience list is silence, not a claim.
 */
export function parseAudienceLabels(labels: Array<string | null | undefined>): AgeParse {
  let min: number | null = null;
  let max: number | null = null;
  let openEnded = false;
  const contributing: string[] = [];

  for (const raw of labels) {
    const label = raw?.trim();
    if (!label) continue;
    const parsed = ADULT_AUDIENCE_RE.test(label)
      ? { ageMinMonths: ADULT_MIN_MONTHS, ageMaxMonths: null, resolved: true }
      : parseAgeText(label);
    if (!parsed.resolved) continue;
    contributing.push(label);
    const lo = parsed.ageMinMonths ?? 0;
    min = min === null ? lo : Math.min(min, lo);
    if (parsed.ageMaxMonths === null) openEnded = true;
    else max = max === null ? parsed.ageMaxMonths : Math.max(max, parsed.ageMaxMonths);
  }

  if (!contributing.length) return { ...UNRESOLVED };
  return {
    ageMinMonths: min ?? 0,
    ageMaxMonths: openEnded ? null : max,
    resolved: true,
    notes: `audience: ${contributing.join(', ')}`,
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
export function computeAgeBandMatches(parse: Pick<AgeParse, 'ageMinMonths' | 'ageMaxMonths'>, bands: AgeBandRow[]): string[] {
  const { ageMinMonths: min, ageMaxMonths: max } = parse;
  if (min === null && max === null) return [];
  const lo = min ?? 0;
  const hiExcl = max ?? Number.POSITIVE_INFINITY;
  return bands
    .filter((b) => {
      const bandHi = b.upperMonthsExclusive ?? Number.POSITIVE_INFINITY;
      return lo < bandHi && b.lowerMonthsInclusive < hiExcl;
    })
    .map((b) => b.id);
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
