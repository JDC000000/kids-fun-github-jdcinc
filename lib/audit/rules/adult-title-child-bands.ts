// lib/audit/rules/adult-title-child-bands.ts — PATTERN 4: the programme's NAME is the claim.
//
// Origin: the independent test report's own P1-4 detection proposal — a title-based regex gate
// (`/\b(adult|senior|55+|master's|16+|19+|aquafit|lane swim…)\b/i`) for adult content surfacing on
// `swimming` / `library` / `park` queries. This is that signal, narrowed by measurement.
//
// ── WHAT THIS ASKS THAT PATTERNS 2 AND 3 DO NOT ───────────────────────────────────────────
// Pattern 2 asks whether the source names an adult AUDIENCE. Pattern 3 asks whether the source's
// SUBJECT is adult-only. Neither can see this row, live in the catalogue today:
//
//     "Aquafit - Deep"     age_notes: "Aquafit - Deep"   ageBandMatches: []
//
// There is no audience word in it, so pattern 2 finds nothing; "aquafit" is not subject matter,
// so pattern 3 finds nothing; and the empty band list means the search filter's "empty → don't
// hide" rule admits it into `ages=2-4`. What makes it adult-only is neither audience nor subject
// but NAMING CONVENTION: in a municipal recreation catalogue, "Aquafit", "Osteofit" and
// "Master's" name a class that a four-year-old cannot be enrolled in, the same way "Storytime"
// names one for a toddler. The title is the programme's name, so the convention IS the claim.
//
// That is also why the evidence field is TITLE ONLY, unlike patterns 2 and 3 which also scan the
// description. "Aquafit" in a body paragraph ("held after the Aquafit class") is a mention;
// "Aquafit" as the name is a declaration. Restricting the field keeps the rule's stated claim and
// its implementation the same thing — and description text is empty catalogue-wide today anyway,
// so this costs no reach now and keeps the rule honest when ingestion starts persisting it.
//
// ── THE VOCABULARY IS THE REPORT'S, MINUS WHAT MEASUREMENT REMOVED ────────────────────────
// Every term below was counted against the 4,530-row live sweep of 2026-08-18 (the same snapshot
// pattern 3 was measured on: 1,782 rows with no bands, 2,090 carrying an affirmative child band,
// 3,872 exposed to a child search by one shape or the other). Terms the report proposed that are
// NOT here were removed for a measured reason, not an aesthetic one:
//
//   • `adult`, `senior`, `55+`, `19+` — ALREADY PATTERN 2's VOCABULARY. Re-matching them here
//     would report the same row under two rule ids, which the pattern-2/pattern-3 split exists to
//     prevent. Measured cost of leaving them out: ZERO. All 30 exposed rows whose title contains
//     "adult" are caregiver/shared sessions that this rule's own guards drop anyway ("Reserve In
//     Advance: Children with Adult Basketball", "Adult / Early Years (0-6years) Swim …"); the one
//     "senior" title is "Youth Special Event Volunteer - Seniors Holiday Tea", not exposed; "55+"
//     and "19+" have no hits at all. The disjointness is free.
//   • `lane swim` — REMOVED AS A MEASURED FALSE-POSITIVE CLASS. `/\b(?:lane|lap|length)s?\s+swim\b/i`
//     matches 345 exposed rows across 156 distinct titles, nearly all NVRC lane swims carrying
//     bands ['5-9','10-14','15+'] — a derivation that is plausibly CORRECT, because a lane swim is
//     open to anyone who can swim lengths. Shipping it would put 345 rows into a severity-3 report
//     and 345 candidates against a 500-candidate adjudication cap, crowding out the real findings.
//     A severity-3 report is only worth reading if it is small.
//
// Considered and rejected on the same evidence: `zumba` (52 exposed), `pilates` (52), `yoga` (139,
// including "Prenatal Yoga" which pattern 2 already owns), `bootcamp` (6, including "Baby & Me
// Bootcamp"), `mahjong` (24), `social dance` (23), `fitness centre` (13), `women's only` (7, and
// the two live instances read "8yrs+" and "12yrs+"). Every one is a room full of adults most of
// the time and a children's class some of the time, which is not what this rule claims to detect.
//
// ── FALSE-POSITIVE GUARDS ─────────────────────────────────────────────────────────────────
// The two shared guards (`CHILD_AUDIENCE_RE`, `CAREGIVER_PROGRAMME_RE`) apply unchanged — a title
// naming a young audience or a caregiver-attended programme drops the listing outright, because
// this rule's whole claim is that the name excludes children.
//
// This rule adds one of its own, because its evidence is title-position naming and this catalogue
// puts audience ranges IN titles: `SELF_DECLARED_AGE_RE` drops any listing whose title states its
// own age range or floor below 16 — "(0-6years)", "8yrs+", "Tennis 4-6 yrs", "ages 3-5". 605 rows
// across 290 distinct titles carry such a token, and a source that spells out a child-inclusive
// age range in its own name has named a child audience as plainly as the word "kids" would.
// A floor at 16 or above is not caught by it, and is itself a marker below.
//
// Like patterns 2 and 3, every guard reads the SOURCE's own words only — `title` here, never
// `ageWording`, which for a resolved row holds our own output wearing the source's field. A
// derived age string must never be able to excuse a derived age claim.
//
// ── MEASURED RESULT ───────────────────────────────────────────────────────────────────────
// Run through the real prefilter over those 4,530 rows, three rules vs four: 46 → 94 candidates.
// The 48 new ones are 11 distinct titles, every one City of Vancouver ActiveNet, every one
// reached through the EMPTY-BAND exposure shape (0 carry a child band):
//
//   STRONG  25 rows / 7 titles / 10 series — Aquafit - Shallow Moderate (×13), Aquafit - Deep
//           (×2), Aquafit - Mild (×1), Osteofit (×3), Osteofit Level 1 (×2), Osteofit - Sit,
//           Stand and Stabilize (×1), Soccer - Master's Co-Ed (×3)
//   WEAK    23 rows / 4 titles / 4 series — "Group Fitness - Gentle Fit" and its variants, which
//           the promotion rules never report unreviewed
//
// ZERO of the 48 are also raised by pattern 1, 2 or 3, and adding this rule changes those three
// rules' candidate sets by ZERO rows — the registry addition is additive in fact, not just in
// intent.
//
// A LIVE sweep the same night (4,990 rows, 103.4% coverage, 219 requests, prefilter-only) agrees:
// 97 candidates in total, 51 of them this rule's, and reported severity-3 findings go 6 → 18. The
// 12 new findings are Aquafit ×4 variants, Osteofit ×5 variants and Soccer - Master's Co-Ed —
// every one strong, every one empty-band, no row raised by two rules, and no false positive in
// the reported set. The defect reproduces end-to-end on production:
//     /api/search?q=aquafit&ages=2-4  →  16 results, all of them adult aquafit classes.
// That is the report's P1-4 complaint, served to a parent filtering for a two-year-old.
//
// This list is expected to grow ONE MEASURED ENTRY AT A TIME — same discipline as pattern 3's
// subject list. A term added without a sweep behind it is how a report starts being filtered to a
// folder.
import type { AuditListing, AuditRule, RuleEvidence, RuleSignal } from '../types';
import { CAREGIVER_PROGRAMME_RE, CHILD_AUDIENCE_RE } from './adult-signals';
import { exposedToChildSearch } from './adult-age-band';

interface TitleMarker {
  re: RegExp;
  strength: 'strong' | 'weak';
  /** What makes this name adult-only. Quoted in the rule's note and in the LLM prompt. */
  why: string;
}

/**
 * Programme names that are adult-only by convention. Deliberately narrow: a term earns `strong`
 * only when a municipal catalogue never uses it for a children's class, and `weak` when the
 * innocent reading is real. Nothing here overlaps pattern 2's audience vocabulary — see header.
 */
const ADULT_TITLE_MARKERS: TitleMarker[] = [
  // ── strong ────────────────────────────────────────────────────────────────
  {
    re: /\baqua[\s-]?fit(?:ness)?\b/i,
    strength: 'strong',
    why: 'an adult aquatic-fitness class name',
  },
  {
    // `\b` already excludes "Toastmasters"/"mastermind"/"masterclass"; the lookahead drops the
    // academic reading ("Master's of Science", "Master's degree").
    re: /\bmaster'?s\b(?!\s+(?:of|degree)\b)/i,
    strength: 'strong',
    why: "the Masters age category, which in every sport means an adult-only division",
  },
  {
    re: /\bosteo[\s-]?fit\b/i,
    strength: 'strong',
    why: 'a clinical bone-density exercise programme for older adults',
  },
  {
    // Pattern 2 owns the legal-adult floors (18/19/21/55/65). 16+/17+ are not adult floors, but
    // they exclude every child band this auditor cares about, so they belong to somebody — and
    // the only rule that reads them is this one.
    re: /\b1[67]\s*\+|\bages?\s+1[67]\s*(?:\+|and\s+(?:over|up|older|above))\b|\b1[67]\s*(?:yrs?|years?)\s*\+/i,
    strength: 'strong',
    why: 'an explicit 16+/17+ age floor, above every child band',
  },
  // ── weak ──────────────────────────────────────────────────────────────────
  // Real signal with a real innocent reading. Raises a candidate; never reports one.
  {
    re: /\bgentle\s+fit\w*\b/i,
    strength: 'weak',
    why: 'low-impact fitness programming, which is usually but not always older-adult oriented',
  },
];

/**
 * The title stating its OWN age range or floor, below 16 — "(0-6years)", "8yrs+", "4-6 yrs",
 * "ages 3-5". A source that spells out a child-inclusive age range in its own name has named a
 * child audience, whatever else the name says.
 *
 * Anchored on an explicit year unit (`yr`/`yrs`/`year`/`years`) or a leading "ages", so clock
 * times ("Tuesday 9:00-10:00pm") and pool geometry ("(1 lanes x 25m)") — both extremely common in
 * this catalogue's titles — can never be read as ages.
 */
const SELF_DECLARED_AGE_RE = /\b(\d{1,2})\s*(?:-|–|\s+to\s+)?\s*\d{0,2}\s*(?:yrs?|years?)\b|\bages?\s+(\d{1,2})\b/gi;

/** Youngest age, in years, the title states about itself; null when it states none. */
export function selfDeclaredMinAgeYears(title: string): number | null {
  SELF_DECLARED_AGE_RE.lastIndex = 0;
  let min: number | null = null;
  for (const match of title.matchAll(SELF_DECLARED_AGE_RE)) {
    const raw = match[1] ?? match[2];
    if (raw === undefined) continue;
    const years = Number(raw);
    if (!Number.isFinite(years)) continue;
    if (min === null || years < min) min = years;
  }
  return min;
}

/** The age at which a floor stops being a child-audience statement — 16+/17+ are markers, not guards. */
const CHILD_FLOOR_YEARS = 16;

export const adultTitleChildBandsRule: AuditRule = {
  id: 'adult_title_child_bands',
  title: 'Title names an adult-only programme, but the listing reaches child age filters',
  severity: 3,

  detect(listing: AuditListing): RuleSignal | null {
    const exposure = exposedToChildSearch(listing.derived.ageBandMatches);
    if (!exposure) return null;

    const title = listing.source.title;
    if (!title) return null;

    // Source-side guards, title only. `ageWording` is never consulted: on a resolved row it holds
    // our own verdict, and letting it excuse this finding would make the rule unfalsifiable.
    if (CHILD_AUDIENCE_RE.test(title)) return null;
    if (CAREGIVER_PROGRAMME_RE.test(title)) return null;
    const declaredMin = selfDeclaredMinAgeYears(title);
    if (declaredMin !== null && declaredMin < CHILD_FLOOR_YEARS) return null;

    const evidence: RuleEvidence[] = [];
    const reasons: string[] = [];
    const seen = new Set<string>();
    for (const marker of ADULT_TITLE_MARKERS) {
      const match = marker.re.exec(title);
      if (!match) continue;
      const key = match[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({ quote: match[0], field: 'title', strength: marker.strength });
      reasons.push(marker.why);
    }

    if (evidence.length === 0) return null;

    return {
      evidence,
      derivedClaim: `ageBandMatches = [${listing.derived.ageBandMatches.join(', ')}] — ${exposure.why}`,
      note:
        `the programme's own NAME is ${[...new Set(reasons)].join('; ')}, and the title names ` +
        `neither a child audience nor an age range a child falls inside`,
    };
  },
};
