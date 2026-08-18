// lib/audit/rules/adult-subject-child-bands.ts — PATTERN 3: we did not fail to decide. We
// decided, and we were wrong.
//
// The real instance this exists for:
//   "International Overdose Awareness"   (id 97670289-a949-4ebb-8f47-d33adf92d404)
//   age_notes:        "all-ages"
//   ageBandMatches:   ['under2', '2-4', '5-9', '10-14', '15+']   ← ALL FIVE, ageMinMonths 0
//   organisation:     City of Vancouver events calendar
// A parent filtering to `ages=under2` is told, affirmatively, that a public overdose-awareness
// event is programming for their baby.
//
// ── WHY PATTERN 2 DOES NOT COVER THIS, AND WHAT THE ACTUAL GAP WAS ────────────────────────
// It is tempting to say pattern 2 only looks at UNRESOLVED rows. It does not: its
// `exposedToChildSearch()` handles both exposure shapes — child band present, and no bands at
// all — and tests/audit/rules.test.ts pins the child-band case. The gap is not on the exposure
// side. It is on the EVIDENCE side.
//
// Pattern 2 asks whether the source names an adult AUDIENCE. For this row it cannot, because
// there is no audience wording left to read: whatever the CityCalendar adapter fed the age
// parser resolved to "all ages", and resolving DESTROYS the wording. `age_notes` keeps the raw
// source text only for rows that stayed unresolved (`"unresolved: …"`); a resolved row keeps
// the parser's own verdict. So the auditor's `source.ageWording` for this listing is the string
// "all-ages" — which is not source text at all, it is OUR OUTPUT wearing the source's field.
// (Which upstream field produced it is genuinely unknown from stored data — the age-provenance
// initiative owns that; this rule does not guess.)
//
// What is left is the title, and the title's adult signal is not an audience — it is a SUBJECT.
// "Overdose" names subject matter, and no audience word anywhere in the record contradicts it,
// because the only audience claim in the record is the one we invented. That is the whole
// pattern:
//
//     the source's SUBJECT is adult-only, and we AFFIRMATIVELY published a child age band.
//
// ── WHY "AFFIRMATIVELY" IS PART OF THE RULE, NOT DECORATION ───────────────────────────────
// This rule requires a child band to be PRESENT. It deliberately does not fire on the
// empty-band case, even though the search filter's "empty → don't hide" rule makes that
// exposure just as real, for two reasons:
//   1. pattern 2 already owns the empty-band case, and a second rule reporting the same rows
//      under a second id turns one problem into two lines of a report;
//   2. the two are different defects with different fixes. An empty band list is a KNOWN
//      unknown — the parser said "I could not tell" and the filter chose to be permissive. A
//      populated one is a false statement of fact. Only the second is a claim we made.
// The evidence classes are likewise disjoint: pattern 2 reads audience wording, this reads
// subject matter, so a listing is not normally reported twice.
//
// ── FALSE-POSITIVE GUARDS, AND WHY SUBJECT MATTER NEEDS ITS OWN ───────────────────────────
// A children's bereavement group, a family harm-reduction info night and a teen mental-health
// workshop are all real programmes that name an adult-only subject and legitimately reach a
// child band. So the source naming ANY young audience (`CHILD_AUDIENCE_RE`) or describing a
// caregiver-attended programme (`CAREGIVER_PROGRAMME_RE`, shared with pattern 2) drops the
// listing outright — not demoted to weak, dropped. Pattern 3's entire claim is "the source
// never said a child could come"; if the source said so, there is nothing left to report.
//
// Those guards read TITLE AND DESCRIPTION ONLY. They must NOT read `ageWording`, for the exact
// reason this rule exists: on the instance above `ageWording` is the derived string "all-ages",
// and letting a derived value satisfy a source-side guard would make the rule silently
// unfalsifiable — the bug would be its own alibi.
//
// Measured against the live catalogue on 2026-08-18 (4,530 rows swept, 2,090 of them carrying
// an affirmative child band): ONE strong candidate, the row above, and one weak candidate
// ("Kitsilano MS Support Group", also tagged all five bands). No guarded-out rows and no false
// positives. That ratio is the point — a severity-3 report is only worth reading if it is small.
import type { AuditListing, AuditRule, RuleEvidence, RuleSignal } from '../types';
import { CAREGIVER_PROGRAMME_RE, CHILD_AUDIENCE_RE, affirmedChildBands } from './adult-signals';

interface SubjectMarker {
  re: RegExp;
  strength: 'strong' | 'weak';
  /** What makes this subject adult-only. Quoted in the rule's note, and in the LLM prompt. */
  why: string;
}

/**
 * Subject matter that is adult-only by its content rather than by an audience label.
 *
 * The bar for `strong` is deliberately high and deliberately narrow: a subject a catalogue
 * should never present as programming for a two-year-old, where the reading is not
 * context-dependent. Anything whose innocent reading is common — "recovery" (of a swim stroke),
 * "support group" (for parents of a child, held with childcare), "crisis" — is `weak`, which
 * under the auditor's promotion rules means it becomes a candidate for adjudication and is
 * never reported unreviewed. See docs/safety-auditor.md, "Evidence tiers".
 *
 * This list is expected to grow ONE MEASURED ENTRY AT A TIME. Adding a term without checking it
 * against a live sweep is how a report starts being filtered to a folder.
 */
const ADULT_SUBJECT_MARKERS: SubjectMarker[] = [
  // ── strong ────────────────────────────────────────────────────────────────
  {
    re: /\b(?:overdose|naloxone|narcan|opioids?|fentanyl|harm\s+reduction|safer\s+supply|substance\s+use|drug\s+use)\b/i,
    strength: 'strong',
    why: 'substance-use / harm-reduction content',
  },
  { re: /\b(?:suicide|self[\s-]?harm)\b/i, strength: 'strong', why: 'suicide / self-harm content' },
  {
    re: /\b(?:bereavement|palliative|hospice|end[\s-]of[\s-]life)\b|\bgrief\s+(?:support|group|circle|counsell?ing)\b/i,
    strength: 'strong',
    why: 'end-of-life / bereavement content',
  },
  {
    re: /\b(?:domestic|intimate[\s-]partner)\s+violence\b|\bsexual\s+assault\b/i,
    strength: 'strong',
    why: 'interpersonal-violence content',
  },
  {
    re: /\b(?:dementia|alzheimer\w*|osteoporosis|menopaus\w+|prostate|incontinence)\b/i,
    strength: 'strong',
    why: 'an adult-only health condition',
  },
  {
    re: /\b(?:income\s+tax|tax\s+clinic|estate\s+planning|wills?\s+and\s+estates?|retirement\s+planning|pension|mortgage)\b/i,
    strength: 'strong',
    why: 'adult financial/legal admin',
  },
  {
    re: /\b(?:smoking|vaping|tobacco)\s+cessation\b|\bgambling\b/i,
    strength: 'strong',
    why: 'addiction-cessation content',
  },
  // ── weak ──────────────────────────────────────────────────────────────────
  // Real signals with common innocent readings. They raise a candidate; they never report one.
  {
    re: /\b(?:addiction|mental\s+health|counsell?ing|support\s+group|crisis)\b/i,
    strength: 'weak',
    why: 'health/support-service language that is often, but not always, adult-only',
  },
  {
    re: /\b(?:violence\s+against\s+women|gender[\s-]based\s+violence)\b/i,
    strength: 'weak',
    why: 'gender-based-violence content, which public commemorations do hold as all-ages events',
  },
  {
    re: /\b(?:job\s+search|r[eé]sum[eé]|career\s+transition|employment\s+readiness)\b/i,
    strength: 'weak',
    why: 'employment content, which youth programmes also run',
  },
];

/** Title and description only — never `ageWording`. See the header. */
const EVIDENCE_FIELDS = ['title', 'description'] as const;

export const adultSubjectChildBandsRule: AuditRule = {
  id: 'adult_subject_child_bands',
  title: 'Source subject is adult-only, but the listing affirmatively claims a child age band',
  severity: 3,

  detect(listing: AuditListing): RuleSignal | null {
    const child = affirmedChildBands(listing.derived.ageBandMatches);
    if (child.length === 0) return null;

    // Source-side guards. Both read the source's OWN words only; a derived age string must
    // never be able to excuse a derived age claim.
    const sourceText = `${listing.source.title}\n${listing.source.description}`;
    if (CHILD_AUDIENCE_RE.test(sourceText)) return null;
    if (CAREGIVER_PROGRAMME_RE.test(sourceText)) return null;

    const evidence: RuleEvidence[] = [];
    const reasons: string[] = [];
    const seen = new Set<string>();
    for (const field of EVIDENCE_FIELDS) {
      const text = listing.source[field];
      if (!text) continue;
      for (const marker of ADULT_SUBJECT_MARKERS) {
        const match = marker.re.exec(text);
        if (!match) continue;
        const key = `${field}:${match[0].toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push({ quote: match[0], field, strength: marker.strength });
        reasons.push(marker.why);
      }
    }

    if (evidence.length === 0) return null;

    const bounds =
      listing.derived.ageMinMonths === null && listing.derived.ageMaxMonths === null
        ? ''
        : ` (ageMinMonths=${listing.derived.ageMinMonths}, ageMaxMonths=${listing.derived.ageMaxMonths})`;

    return {
      evidence,
      derivedClaim:
        `ageBandMatches = [${listing.derived.ageBandMatches.join(', ')}]${bounds} — ` +
        `AFFIRMATIVELY resolved to include child band(s) ${child.join(', ')}, so a child age ` +
        `filter is told this is programming for that age, not merely not hidden from it`,
      note: `subject matter is ${[...new Set(reasons)].join('; ')}, and no child audience is named anywhere in the source's own text`,
    };
  },
};
