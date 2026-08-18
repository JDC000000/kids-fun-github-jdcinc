// lib/audit/rules/adult-age-band.ts — PATTERN 2: the source says adults, a child can find it.
//
// The real instance this exists for:
//   "Supporting People Together: The Basics of Overdose Response"
//   age_notes: "unresolved: International Overdose Awareness Day, Health, Life Skills and
//               Personal Growth, Adults, English"
//   ageBandMatches: []          ← returned by an `ages=2-4` search
//
// TWO WAYS A LISTING IS EXPOSED TO A CHILD SEARCH, and the second one is the one that bit us:
//   1. it carries a child band (`under2` / `2-4` / `5-9`), or
//   2. it carries NO bands at all — because the search filter's documented "empty → don't
//      hide" rule then admits it into EVERY age filter. An unresolved age is not neutral; it
//      is maximally permissive. A rule that only looked at bands present would have scored
//      the tonight instance as clean.
//
// ── THE FALSE-POSITIVE TRAP THIS RULE IS BUILT AROUND ─────────────────────────────────────
// worker/core/age.ts:245-250 states it exactly: "adults" inside
//     "Adults accompanying children under 9 must stay in the library"
// is prose about supervision, not an audience, and a keyword table cannot tell the difference.
// A tag literally reading "Adults" can. So the strong tier NEVER pattern-matches the word
// "adults" in free text — it asks worker/core/age.ts's own `parseAudienceLabels()` whether the
// source's STRUCTURED audience list resolves to an adults-only range, reusing the shipped
// semantics (catch-all handling, "Children-All Ages" bounding, union-of-tags) rather than
// re-deriving them here and drifting.
//
// That reuse is necessary but NOT sufficient, because `parseAudienceLabels` is anchored at the
// START of a tag (`/^\s*(?:adults?|seniors?|older\s+adults?)\b/i`) and the trap sentence also
// starts with "Adults". Feeding it that sentence returns min = 216 months — a false positive on
// the exact example the codebase warns about. Hence `structuredTags()` below, which refuses to
// treat prose as a tag list: anything carrying supervision/accompaniment language, or running
// longer than a real audience label ever does, is discarded before the parser sees it.
import { parseAudienceLabels } from '@/worker/core/age';
import type { AuditListing, AuditRule, RuleEvidence, RuleSignal } from '../types';

/** 18 years in months — worker/core/age.ts's own ADULT_MIN_MONTHS. */
const ADULT_MIN_MONTHS = 18 * 12;

/** Bands whose presence puts the listing in front of a child. */
const CHILD_BANDS = new Set(['under2', '2-4', '5-9']);

/**
 * Language that makes a string prose about supervision rather than an audience label. Any tag
 * matching this is not a tag — it is a sentence that happens to begin with "Adults".
 */
const SUPERVISION_RE =
  /\b(?:accompan\w+|caregivers?|guardians?|supervis\w+|chaperone\w*|must\s+stay|must\s+remain|remain\s+with|stay\s+with|attend\s+with|responsible\s+for)\b/i;

/**
 * A real audience tag is short — "Adults", "Seniors", "Older Adults", "Children-Preschool".
 * Six words is generous (VPL's longest is "Preschool Age Children"); anything past it is prose.
 * This is the second half of the trap guard: the warning sentence is nine words before it even
 * reaches "library".
 */
const MAX_TAG_WORDS = 6;

/**
 * A programme FOR children that adults attend. "Parent & Tot", "Adult & Child Swim",
 * "Family Storytime", "Caregiver and Baby Yoga" — every one of these mentions adults and every
 * one belongs in a toddler search. Matching this anywhere in title or description drops the
 * whole listing: the adult reference is explained.
 */
const CAREGIVER_PROGRAMME_RE =
  /\b(?:parent|adult|caregiver|grown[\s-]?up|mommy|mummy|daddy|guardian)s?\s*(?:&|and|\+|\/)\s*(?:tot|child|kid|baby|babies|toddler|me|preschooler)s?\b|\bfamil(?:y|ies)\b|\bcaregivers?\b|\bwith\s+(?:a\s+)?(?:parent|caregiver|guardian|grown[\s-]?up)\b|\bparent\s+participation\b/i;

interface Marker {
  re: RegExp;
  strength: 'strong' | 'weak';
}

/**
 * Adult-only markers read from TITLE and DESCRIPTION. Unlike the audience-tag path these are
 * free text, so only unambiguous constructions earn `strong`: an explicit legal age floor, an
 * explicit "adults only", or a life-stage that cannot include a child at all.
 */
const ADULT_MARKERS: Marker[] = [
  // ── strong ────────────────────────────────────────────────────────────────
  { re: /\b(?:18|19|21|55|65)\s*\+/i, strength: 'strong' },
  { re: /\bages?\s+(?:18|19|21|55|65)\s*(?:\+|and\s+(?:over|up|older|above))/i, strength: 'strong' },
  { re: /\b(?:18|19|21)\s+years?\s+(?:and\s+)?(?:over|older|\+)/i, strength: 'strong' },
  { re: /\badults?\s+only\b/i, strength: 'strong' },
  { re: /\bfor\s+adults\b/i, strength: 'strong' },
  { re: /\bpre[\s-]?natal\b/i, strength: 'strong' },
  { re: /\bpost[\s-]?natal\b/i, strength: 'strong' },
  { re: /\bpost[\s-]?partum\b/i, strength: 'strong' },
  { re: /\bmenopaus(?:e|al)\b/i, strength: 'strong' },
  { re: /\b(?:19|liquor|licensed)\s*(?:\+|and\s+over)?\s*event\b/i, strength: 'strong' },
  // ── weak ──────────────────────────────────────────────────────────────────
  // A bare "adults" or "seniors" in prose. This is the trap's home turf, so it is never
  // reportable on its own — it exists to raise a candidate for adjudication.
  { re: /\badults?\b/i, strength: 'weak' },
  { re: /\bseniors?\b/i, strength: 'weak' },
  { re: /\bolder\s+adults?\b/i, strength: 'weak' },
];

/**
 * The source naming an adult audience AND a young one in the same breath — "Board Games for
 * Adults and Teens", "Craft Night for Youth & Adults". The programme is open to both, so the
 * child-band exposure may be entirely correct. Free-text evidence from such a field is
 * DEMOTED to weak rather than dropped: it is genuinely ambiguous, which is exactly the class
 * of call the adjudication stage exists to make. (This does not touch the structured-tag path
 * — `parseAudienceLabels` already unions a mixed list below the adult floor.)
 */
const MIXED_AUDIENCE_RE =
  /\b(?:teens?|teenagers?|youth|kids?|child(?:ren)?|toddlers?|preschoolers?|famil(?:y|ies)|all\s+ages)\b/i;

const EVIDENCE_FIELDS = ['title', 'description'] as const;

/**
 * Split the source's age wording into candidate STRUCTURED tags, discarding anything that is
 * prose. Returns [] when the wording is a sentence rather than a list — which is the whole
 * point: a sentence is never an audience claim, however it begins.
 */
export function structuredTags(ageWording: string): string[] {
  const raw = ageWording.trim();
  if (!raw) return [];
  return raw
    .split(/[,;|]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => !SUPERVISION_RE.test(t))
    .filter((t) => t.split(/\s+/).length <= MAX_TAG_WORDS);
}

/**
 * True when the source's own structured audience tags resolve to an adults-only range. Uses
 * the hull minimum from `parseAudienceLabels`, so a list carrying BOTH "Adults" and a child
 * audience resolves below the floor and correctly returns false — a mixed audience is not an
 * adult-only one.
 */
export function audienceTagsAreAdultOnly(ageWording: string): boolean {
  const tags = structuredTags(ageWording);
  if (tags.length === 0) return false;
  const parsed = parseAudienceLabels(tags);
  return parsed.resolved && parsed.ageMinMonths !== null && parsed.ageMinMonths >= ADULT_MIN_MONTHS;
}

/** The tag(s) that carried the adult claim, for quoting in the report. */
function adultTagQuote(ageWording: string): string {
  const tags = structuredTags(ageWording);
  const adult = tags.filter((t) => {
    const p = parseAudienceLabels([t]);
    return p.resolved && p.ageMinMonths !== null && p.ageMinMonths >= ADULT_MIN_MONTHS;
  });
  return adult.join(', ') || ageWording;
}

/** Whether this listing can surface in a search filtered to a child age band. */
export function exposedToChildSearch(bands: string[]): { exposed: boolean; why: string } | null {
  const child = bands.filter((b) => CHILD_BANDS.has(b));
  if (child.length > 0) {
    return { exposed: true, why: `carries child age band(s) ${child.sort().join(', ')}` };
  }
  if (bands.length === 0) {
    // The dangerous one. lib/search's age filter treats an empty band list as "don't hide",
    // so an unresolved age is admitted into every age filter, including ages=2-4.
    return {
      exposed: true,
      why: 'has NO age bands, so the search filter\'s "empty → don\'t hide" rule admits it into every age filter including 2-4',
    };
  }
  return null;
}

export const adultAgeBandRule: AuditRule = {
  id: 'adult_source_child_bands',
  title: 'Source says adults / 18+ / seniors / prenatal, but the listing reaches child age filters',
  severity: 3,

  detect(listing: AuditListing): RuleSignal | null {
    const exposure = exposedToChildSearch(listing.derived.ageBandMatches);
    if (!exposure) return null;

    // FP guard — a children's programme that adults attend. Drops the whole listing before any
    // marker runs, because in "Parent & Tot Swim" the word "parent" is the audience's escort,
    // not the audience.
    const caregiverProgramme =
      CAREGIVER_PROGRAMME_RE.test(listing.source.title) ||
      CAREGIVER_PROGRAMME_RE.test(listing.source.description);
    if (caregiverProgramme) return null;

    const evidence: RuleEvidence[] = [];

    // Strong path: the source's own structured audience tags. Prose is filtered out upstream in
    // structuredTags(), so the documented "Adults accompanying children…" sentence cannot reach
    // parseAudienceLabels() and cannot produce this evidence.
    if (audienceTagsAreAdultOnly(listing.source.ageWording)) {
      evidence.push({
        quote: adultTagQuote(listing.source.ageWording),
        field: 'ageWording',
        strength: 'strong',
      });
    }

    // Free-text path over title/description.
    const seen = new Set<string>();
    for (const field of EVIDENCE_FIELDS) {
      const text = listing.source[field];
      if (!text) continue;
      const mixed = MIXED_AUDIENCE_RE.test(text);
      for (const marker of ADULT_MARKERS) {
        const match = marker.re.exec(text);
        if (!match) continue;
        // A weak "adults" sitting inside a supervision sentence is the trap in free-text form.
        if (marker.strength === 'weak' && SUPERVISION_RE.test(text)) continue;
        const key = `${field}:${match[0].toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push({ quote: match[0], field, strength: mixed ? 'weak' : marker.strength });
      }
    }

    if (evidence.length === 0) return null;

    return {
      evidence,
      derivedClaim: `ageBandMatches = [${listing.derived.ageBandMatches.join(', ')}] — ${exposure.why}`,
    };
  },
};
