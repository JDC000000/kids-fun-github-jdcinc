// lib/audit/types.ts — the source-neutral record + finding shapes for the catalogue
// safety auditor (G-SAFE-1).
//
// WHY A SEPARATE RECORD TYPE, AND NOT `ListingRecord`
// The auditor's whole job is to compare what the SOURCE said against what WE derived. Both
// halves have to be present in one object, and they have to be labelled as such, or a rule
// author will reach for a derived field thinking it is evidence. So the record is split into
// two explicitly-named halves — `source` (text a scraper copied off a real page, never
// computed by us) and `derived` (tags/bands this codebase produced) — and every rule is
// handed both. `ListingRecord` (lib/search/types.ts) mixes them and is shaped for rendering,
// so it is mapped into this rather than reused.
//
// THE THIRD-PATTERN REQUIREMENT
// A finding class like this keeps producing new shapes, so a rule is a plain object with a
// pure `detect`. Adding pattern 3 is a new file plus one line in registry.ts — no change to
// the prefilter, the LLM stage, the report, or the CLI.

/** A source's own words. Nothing in here was computed by this codebase. */
export interface AuditSourceText {
  /** The activity title, verbatim from the source listing. */
  title: string;
  /**
   * The scraped body text. EMPTY FOR THE ENTIRE LIVE CATALOGUE TODAY — nothing in worker/
   * ever writes `activity_occurrence.description_snippet`, so the column is null and the
   * search API renders it ''. Kept in the shape (rules read it, tests exercise it) so the
   * auditor gains power the day ingestion starts persisting it, rather than needing a
   * rewrite. See docs/safety-auditor.md.
   */
  description: string;
  /**
   * The source's own age/audience wording, recovered from `occurrence_age.age_notes`. For
   * the rows the deterministic parser could not resolve this is the RAW string it was fed,
   * `unresolved: ` prefix stripped — which for library/rec-centre sources is the source's
   * structured audience tag list, e.g.
   *   "International Overdose Awareness Day, Health, Life Skills and Personal Growth, Adults, English"
   * That is the single richest piece of real source text the API exposes, and it is what
   * makes pattern 2 detectable at all today.
   */
  ageWording: string;
  /** Venue name — weak evidence (a venue called "…Park CC" is not an outdoor claim). */
  venueName: string;
  /** The venue's standing-hours sentence, verbatim, when it has one. */
  openHoursLabel: string;
}

/** What this codebase decided about the listing. Never treated as evidence, only as the claim under test. */
export interface AuditDerived {
  /** Suitability tags AS SERVED to a visitor (`indoor` here renders "Rainy-day friendly"). */
  suitabilityTags: string[];
  /** Category + raw tag keys; `primaryCategoryKey` is the first element's source. */
  categoryTags: string[];
  primaryCategoryKey: string;
  /** Age bands the listing matched. EMPTY IS NOT NEUTRAL — see `admittedToChildSearch`. */
  ageBandMatches: string[];
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
}

export interface AuditListing {
  id: string;
  seriesId: string | null;
  organisation: string;
  sourceUrl: string | null;
  source: AuditSourceText;
  derived: AuditDerived;
}

/**
 * Evidence strength. The prefilter is deliberately allowed to be loose; this is how a rule
 * tells the adjudicator how much to trust each candidate.
 *   strong — the source states the contradicting fact in words that mean only one thing
 *            ("Outdoor", "Rain/Shine", a literal "Adults" audience tag).
 *   weak   — the source contains a word that is USUALLY that fact but has innocent readings
 *            ("park" in a title, "adults" inside a supervision sentence). These exist to be
 *            resolved by the LLM stage, not to be reported raw.
 */
export type EvidenceStrength = 'strong' | 'weak';

export interface RuleEvidence {
  /** The exact substring the rule matched. Goes in the report so a human can check it. */
  quote: string;
  /** Which field of `source` the quote came from. */
  field: keyof AuditSourceText;
  strength: EvidenceStrength;
}

/** What a rule returns when it thinks a listing contradicts itself. `null` = no finding. */
export interface RuleSignal {
  evidence: RuleEvidence[];
  /** The derived value being contradicted, in human words (goes straight into the report). */
  derivedClaim: string;
  /** Why this listing was let through the false-positive guards. One short sentence. */
  note?: string;
}

/** Severity: 3 = a child-safety mislabel a parent could act on. Matches the tonight incidents. */
export type Severity = 1 | 2 | 3;

export interface AuditRule {
  /** Stable machine id — appears in output, so treat as a wire format. */
  id: string;
  title: string;
  severity: Severity;
  /** PURE. No I/O, no clock, no randomness — the prefilter runs this over every row. */
  detect(listing: AuditListing): RuleSignal | null;
}

/** A prefilter hit, before any LLM has looked at it. */
export interface Candidate {
  ruleId: string;
  severity: Severity;
  listing: AuditListing;
  signal: RuleSignal;
  /** True when every piece of evidence is `weak` — the cases the LLM stage exists for. */
  weakOnly: boolean;
  /** Anthropic requires ^[a-zA-Z0-9_-]{1,64}$; `<ruleShortId>-<uuid>` fits. */
  customId: string;
}

/** The adjudicated verdict for one candidate. */
export interface AuditVerdict {
  /** true = the source really does contradict the derived value. */
  contradiction: boolean;
  confidence: number;
  reason: string;
}

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  listingId: string;
  /**
   * The programme this occurrence belongs to. The collapse key for `occurrences` below — a
   * repeating class shares one seriesId across every occurrence, so this is what makes "the
   * same problem, 5 times" report as one row instead of five.
   */
  seriesId: string | null;
  activityName: string;
  organisation: string;
  /** Deep link a reviewer can open. */
  previewUrl: string;
  sourceUrl: string | null;
  evidence: RuleEvidence[];
  derivedClaim: string;
  /**
   * How many occurrence rows in the swept catalogue carry this same contradiction. The search
   * collapses a repeating programme to ONE representative occurrence, but WHICH occurrence
   * depends on the date window the sweep asked for — so a weekly class surfaces under several
   * ids. Reporting each of them separately turned 16 real problems into 33 rows in the first
   * live run. One finding per programme, with the count beside it.
   */
  occurrences: number;
  /** null when the run was prefilter-only (dry run / LLM not enabled). */
  verdict: AuditVerdict | null;
  /** 'prefilter' when no LLM ran; otherwise 'llm'. */
  adjudicatedBy: 'prefilter' | 'llm';
}
