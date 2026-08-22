// lib/audit/rules/adult-signals.ts — the age-exposure vocabulary shared by the two age rules.
//
// WHY THIS FILE EXISTS
// Pattern 2 (rules/adult-age-band.ts) and pattern 3 (rules/adult-subject-child-bands.ts) ask
// different questions of the same listing — "does the source name an adult AUDIENCE?" versus
// "is the source's SUBJECT adult-only?" — but they share the parts that are expensive to get
// right and dangerous to get wrong: which bands put a listing in front of a child, and the
// false-positive guards that stop a children's programme being reported as adult programming.
//
// Those guards are not incidental. `SUPERVISION_RE` + `MAX_TAG_WORDS` exist because
// worker/core/age.ts:245-250 documents a sentence — "Adults accompanying children under 9 must
// stay in the library" — that the shipped `ADULT_AUDIENCE_RE` resolves to 18+ because it is
// anchored at the start of a tag and that sentence starts with "Adults". `CAREGIVER_PROGRAMME_RE`
// exists because "Parent & Tot Swim" mentions an adult and belongs in a toddler search. A second
// rule that re-derived either of them would drift from the first the moment one was tuned, and
// the drift would show up as a false positive on a child-safety report — the one output whose
// credibility the whole auditor depends on. So they live here, with one owner, and both rules
// import them.
//
// Nothing in this file knows about a specific rule. Rule-specific vocabulary (adult markers,
// adult subjects) stays in the rule that owns it.
import { parseAudienceLabels } from '@/worker/core/age';

/**
 * 18 years in months. DELIBERATELY LOWER than the two other "age of adulthood" constants in this
 * codebase, and NOT a copy of either: worker/core/age.ts's own ADULT_MIN_MONTHS and
 * lib/search/filters/audience.ts's ADULT_ONLY_AGE_MIN_MONTHS are both 19 years (228), BC's real
 * age of majority. An earlier version of this comment claimed to mirror worker/core/age.ts; that
 * became false when that file moved to 19 and is corrected here.
 *
 * DO NOT "align" this to 228. The direction of caution is OPPOSITE between the two roles:
 *   - Those two are FILTERS. They decide what to HIDE from a child's search results, so a HIGHER
 *     floor is the cautious setting - it keeps more listings visible only to adults.
 *   - This is a DETECTOR floor. It decides what to FLAG for a human on the child-safety report, so
 *     a LOWER floor is the cautious setting. At 216 the auditor reports both 18+ and 19+ listings
 *     that a child's search can reach; at 228 it would silently stop reporting the 18+ ones.
 * Raising this number would make the auditor catch LESS, not more.
 *
 * Ruled by Jon 2026-08-22, verbatim: "Regarding the adult signals age cutoff from the earlier
 * brief, yes, I approve your recommendation" - the recommendation being to leave this at 18 and
 * document why it differs. See _open_notes id kids-fun-3b-adult-signals-third-copy-2026-08-19 in
 * documents/agent-brains/development-orchestrator/activity/pending-gates.json.
 */
export const ADULT_MIN_MONTHS = 18 * 12;

/** Bands whose presence puts the listing in front of a child. */
export const CHILD_BANDS = new Set(['under2', '2-4', '5-9']);

/**
 * Language that makes a string prose about supervision rather than an audience label. Any tag
 * matching this is not a tag — it is a sentence that happens to begin with "Adults".
 */
export const SUPERVISION_RE =
  /\b(?:accompan\w+|caregivers?|guardians?|supervis\w+|chaperone\w*|must\s+stay|must\s+remain|remain\s+with|stay\s+with|attend\s+with|responsible\s+for)\b/i;

/**
 * A real audience tag is short — "Adults", "Seniors", "Older Adults", "Children-Preschool".
 * Six words is generous (VPL's longest is "Preschool Age Children"); anything past it is prose.
 * This is the second half of the trap guard: the warning sentence is nine words before it even
 * reaches "library".
 */
export const MAX_TAG_WORDS = 6;

/**
 * A programme FOR children that adults attend. "Parent & Tot", "Adult & Child Swim",
 * "Family Storytime", "Caregiver and Baby Yoga" — every one of these mentions adults and every
 * one belongs in a toddler search. Matching this anywhere in title or description drops the
 * whole listing: the adult reference is explained.
 */
export const CAREGIVER_PROGRAMME_RE =
  /\b(?:parent|adult|caregiver|grown[\s-]?up|mommy|mummy|daddy|guardian)s?\s*(?:&|and|\+|\/)\s*(?:tot|child|kid|baby|babies|toddler|me|preschooler)s?\b|\bfamil(?:y|ies)\b|\bcaregivers?\b|\bwith\s+(?:a\s+)?(?:parent|caregiver|guardian|grown[\s-]?up)\b|\bparent\s+participation\b/i;

/**
 * The source naming a young audience — "Board Games for Adults and Teens", "All Ages Welcome",
 * "Craft Night for Youth & Adults". What the two rules DO with this differs and that difference
 * is deliberate:
 *   • pattern 2 DEMOTES free-text adult evidence to weak, because a mixed audience genuinely may
 *     include the child band it reached;
 *   • pattern 3 DROPS the listing, because its whole claim is that the source never said a child
 *     could come — and here the source said so.
 */
export const CHILD_AUDIENCE_RE =
  /\b(?:teens?|teenagers?|youth|kids?|child(?:ren)?|toddlers?|preschoolers?|infants?|babies|baby|famil(?:y|ies)|all[\s-]ages)\b/i;

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
export function adultTagQuote(ageWording: string): string {
  const tags = structuredTags(ageWording);
  const adult = tags.filter((t) => {
    const p = parseAudienceLabels([t]);
    return p.resolved && p.ageMinMonths !== null && p.ageMinMonths >= ADULT_MIN_MONTHS;
  });
  return adult.join(', ') || ageWording;
}

/**
 * The child bands this listing AFFIRMATIVELY claims — i.e. bands we resolved and published,
 * as distinct from the empty-band case where the search filter admits the listing by default.
 * Pattern 3 turns on this distinction; see that rule's header.
 */
export function affirmedChildBands(bands: string[]): string[] {
  return bands.filter((b) => CHILD_BANDS.has(b)).sort();
}
