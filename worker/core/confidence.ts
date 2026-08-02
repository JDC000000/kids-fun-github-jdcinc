// worker/core/confidence.ts — G-T13-6 / BR-13: the real per-occurrence confidence
// formula + the low-confidence QA gate that drives status_state at ingest time.
//
// Before this, worker/core/ingest.ts hardcoded status_state='confirmed' for EVERY
// structured record and set confidence_label from category-name specificity only
// (confidenceLabelForCategory → 'high'/'medium'). That bypassed the low-confidence
// → needs_review safety gate (BR-05) which the schema (0004: DEFAULT 'needs_review')
// and the upsert default already support, and there was no confidence FORMULA at all
// (BR-13 was only aspirational comments). This file supplies both.
//
//   confidence = authority × parse_quality × freshness × volatility        (∈ [0,1])
//
//   • authority     — source.authority_tier (official > editorial > partner > manual).
//   • parse_quality — NEW signal: did the record arrive with its core facts already
//                     STRUCTURED, or did we have to infer/guess? Weighted over
//                     category-signal strength, time anchor, cost, and age.
//   • freshness     — how current the source's data is relative to its cadence
//                     (source.last_check_at / baseline_cadence). A first-ever or
//                     on-cadence check is maximally fresh; an overdue source decays.
//                     (At ingest we've just fetched, so this is usually 1.0; the read
//                     side, lib/search/postgres-repository.ts confidence(), applies
//                     the *ongoing* staleness decay from last_checked_at.)
//   • volatility    — how reliably/stably this source produces parseable records.
//                     Reused from T15's canonical source-health score
//                     (worker/health/sla.ts computeSourceHealth = success-rate +
//                     cadence-adherence + parse-yield over a rolling window). The
//                     cadence-adherence term is CONTINUOUS (sla.ts adherenceFactor) for
//                     the same reason freshness is: a step function inside a product
//                     moves every one of a source's rows at once. True
//                     record-DIFF churn ("how often do this source's rows actually
//                     change") is not tracked anywhere yet — flagged as a follow-up,
//                     NOT fabricated. Source-health is the closest real signal, so we
//                     reuse it instead of inventing a parallel one.
//
// Each factor is clamped to [0,1] with a documented FLOOR so no single missing
// signal can zero the whole product. The product maps to the confidence_label enum
// the DB already CHECKs (0004: 'unscored'|'low'|'medium'|'high') by fixed thresholds.
//
// The gate (statusForConfidence): medium/high → 'confirmed' (surfaced in results);
// low/unscored → 'needs_review'. 'needs_review' is deliberate over 'manual_candidate':
//   • it is the activity_occurrence status default AND the upsert default (the schema
//     already treats it as "the ingestion default" — app/admin/qa-queue vocab);
//   • STATUS_CLASS[needs_review] = 'hidden' (lib/search/filters/status.ts): the row is
//     kept OUT of parent-facing results until a human reviews it — the conservative
//     BR-05 posture, whereas 'manual_candidate' = 'expected' is still surfaced.
//
// ─────────────────────────────────────────────────────────────────────────────
// G-T10-3 AMENDMENT (IR-08) — one sentence above is now WRONG, deliberately.
//
// The original text said 'manual_candidate' is "reserved for T14 dedup / T34 manually-
// entered leads, not auto-ingested rows". IR-08 changes exactly that: an EDITORIAL /
// aggregator source's ingested records must land as 'manual_candidate' — a LEAD awaiting
// official-source verification — instead of ever being written as 'confirmed'. The
// sentence is corrected rather than deleted so the change of intent is visible.
//
// Nothing is forked to do this. 'manual_candidate' already means precisely "a surfaced
// lead that has not been verified", and every downstream treatment an editorial candidate
// needs already exists and is already correct:
//   • lib/search/filters/status.ts  STATUS_CLASS.manual_candidate = 'expected'  → never in
//     the primary/confirmed result list; only the separate "expected" broadening section.
//   • lib/search/rank.ts            STATUS_SCORE.manual_candidate = 0.2         → ranked
//     below every live/confirmed state.
//   • app/preview/_data/format.ts   renders it as UNVERIFIED, never as confirmed.
//   • app/admin/qa-queue           REVIEW_STATES includes it, so a human can verify and
//     promote it to 'confirmed' — which IS the "official-source verification" step.
//   • worker/health/{stale,season}.ts both EXCLUDE it from their auto-demotion/
//     inheritance lists, so an unverified lead is never silently relabelled.
// The whole of G-T10-3 is therefore ONE decision at the write path (below) plus this
// correction — not a second, parallel "editorial" pipeline.
// ─────────────────────────────────────────────────────────────────────────────
import type { Pool } from 'pg';
import {
  adherenceFactor,
  checkSuccessRate,
  parseYieldRate,
  computeSourceHealth,
  DEFAULT_CADENCE_SECONDS,
  HEALTH_WINDOW_DAYS,
  type RunCounts,
} from '../health/sla';

export type ConfidenceLabel = 'unscored' | 'low' | 'medium' | 'high';

// ── authority ────────────────────────────────────────────────────────────────
export function authorityFactor(tier: string | null | undefined): number {
  switch (tier) {
    case 'official':
      return 1.0;
    case 'editorial':
      return 0.75;
    case 'partner':
      return 0.6;
    case 'manual':
      return 0.4;
    default:
      return 0.6; // unknown tier → partner-equivalent (don't over-credit)
  }
}

// ── parse quality ──────────────────────────────────────────────────────────────
export interface ParseQualityInput {
  /** classifyPrimaryCategory(record).certainty. */
  categoryCertainty: 'specific' | 'generic';
  /** classifyPrimaryCategory(record).source === 'hint' — an explicit structured
   *  category is the strongest parse signal, even when the category is broad. */
  explicitCategoryHint: boolean;
  hasStartDatetime: boolean;
  hasOpenHours: boolean;
  costStatus: string | null | undefined;
  /** null  = record carried no age wording (neutral, not a parse failure);
   *  true  = age wording resolved to a structured band; false = present but ambiguous. */
  ageResolved: boolean | null;
}

const PARSE_WEIGHTS = { category: 0.35, time: 0.25, cost: 0.2, age: 0.2 } as const;

export function parseQualityFactor(input: ParseQualityInput): number {
  const category = input.explicitCategoryHint ? 1.0 : input.categoryCertainty === 'specific' ? 0.7 : 0.2;
  const time = input.hasStartDatetime ? 1.0 : input.hasOpenHours ? 0.8 : 0.0;
  const cost =
    input.costStatus === 'known' || input.costStatus === 'free'
      ? 1.0
      : input.costStatus === 'check_source'
        ? 0.5
        : 0.2; // 'unknown' / absent
  const age = input.ageResolved === true ? 1.0 : input.ageResolved === false ? 0.4 : 0.6;
  return clamp01(
    PARSE_WEIGHTS.category * category +
      PARSE_WEIGHTS.time * time +
      PARSE_WEIGHTS.cost * cost +
      PARSE_WEIGHTS.age * age
  );
}

// ── freshness ──────────────────────────────────────────────────────────────────
const FRESHNESS_FLOOR = 0.2;

export function freshnessFactor(
  lastCheckAtMs: number | null,
  cadenceSeconds: number | null,
  nowMs: number
): number {
  if (lastCheckAtMs == null) return 1.0; // first-ever check: data is brand-new to us
  const cadenceMs = (cadenceSeconds != null && cadenceSeconds > 0 ? cadenceSeconds : DEFAULT_CADENCE_SECONDS) * 1000;
  const elapsed = Math.max(0, nowMs - lastCheckAtMs);
  if (elapsed <= cadenceMs) return 1.0; // within one cadence → fully fresh
  return clamp(cadenceMs / elapsed, FRESHNESS_FLOOR, 1.0); // reciprocal decay, floored
}

// ── volatility (reused source-health score) ───────────────────────────────────
const VOLATILITY_NEUTRAL = 0.7; // no track record yet → mild discount (unproven source)
const VOLATILITY_FLOOR = 0.3;

export function volatilityFactor(healthScore: number | null): number {
  if (healthScore == null) return VOLATILITY_NEUTRAL;
  return clamp(healthScore, VOLATILITY_FLOOR, 1.0);
}

// ── label + gate ───────────────────────────────────────────────────────────────
const HIGH_THRESHOLD = 0.75;
const MEDIUM_THRESHOLD = 0.5;
const LOW_THRESHOLD = 0.25;

export function scoreToLabel(score: number): ConfidenceLabel {
  if (score >= HIGH_THRESHOLD) return 'high';
  if (score >= MEDIUM_THRESHOLD) return 'medium';
  if (score >= LOW_THRESHOLD) return 'low';
  return 'unscored';
}

/** BR-05 gate: medium/high → 'confirmed' (surfaced); low/unscored → 'needs_review'
 *  (hidden from search until a human reviews). See file header for why needs_review
 *  and not manual_candidate. */
export function statusForConfidence(label: ConfidenceLabel): 'confirmed' | 'needs_review' {
  return label === 'high' || label === 'medium' ? 'confirmed' : 'needs_review';
}

// ── the composed write-path status decision (BR-13 + IR-08 + Round 27) ────────

/** Every status_state an ingested record may be written with. Nothing else is reachable. */
export type IngestStatusState = 'confirmed' | 'needs_review' | 'manual_candidate';

/**
 * The authority tier whose records are LEADS, not statements of fact: editorial /
 * aggregator listings (a "10 best things to do with kids" round-up, a what's-on blog).
 * They may be right, but the official source has not been consulted, so they are never
 * written as confirmed. IR-08 / TSD §5 row 11.
 */
export const CANDIDATE_AUTHORITY_TIER = 'editorial';

export function isCandidateAuthorityTier(tier: string | null | undefined): boolean {
  return tier === CANDIDATE_AUTHORITY_TIER;
}

export interface IngestStatusInput {
  /** The BR-13 confidence label already computed for this record. */
  confidenceLabel: ConfidenceLabel;
  /** source.authority_tier for the owning source (official/editorial/partner/manual). */
  authorityTier: string | null | undefined;
  /** isTermsApprovedForProduction(source.terms_status) — the Round 27 cap. */
  sourceTermsApproved: boolean;
}

/**
 * THE single decision that turns a scored record into the status_state it is written
 * with. Three gates compose here, in this order, and the order is the point: each one
 * can only ever make the outcome MORE conservative than the one before it.
 *
 *   1. BR-13 confidence gate (statusForConfidence)
 *        medium/high → 'confirmed'   ·   low/unscored → 'needs_review' (hidden)
 *
 *   2. IR-08 editorial-candidate gate  ← G-T10-3, the only new rule
 *        an EDITORIAL-tier source's would-be-'confirmed' record becomes
 *        'manual_candidate': surfaced as an explicitly UNVERIFIED lead, never as fact,
 *        and promotable to 'confirmed' only by the admin QA queue's human verification.
 *        It does NOT touch a 'needs_review' verdict, because 'needs_review' is HIDDEN
 *        and 'manual_candidate' is VISIBLE-but-unverified — promoting a record the
 *        confidence gate just rejected into visibility would invert BR-05. So a
 *        low-confidence editorial record stays hidden, which is strictly safer and
 *        still satisfies "never rendered as confirmed".
 *        Note this is tier-scoped, not family-scoped: 'partner' is deliberately NOT
 *        included. An authorised organizer feed (G-T10-2) is a FIRST-PARTY statement by
 *        the people running the event; an editorial round-up is a third party's summary
 *        of someone else's event. Only the latter is a lead.
 *
 *   3. Round 27 terms cap (the application-layer counterpart of migration 0021's
 *      write-time trigger)
 *        a source that is not terms-approved for production may not surface AT ALL, so
 *        both 'confirmed' AND 'manual_candidate' are held down to 'needs_review'.
 *        'manual_candidate' is included because it is a VISIBLE class ('expected'), and
 *        the incident this cap exists to prevent was pending-source rows becoming
 *        user-visible — which manual_candidate would also be.
 *
 * Pure and total: same inputs → same output, every combination defined. The full matrix
 * is asserted in tests/ingestion/editorial-candidate.test.ts.
 */
export function statusForIngestedRecord(input: IngestStatusInput): IngestStatusState {
  const byConfidence = statusForConfidence(input.confidenceLabel);

  const withCandidateGate: IngestStatusState =
    byConfidence === 'confirmed' && isCandidateAuthorityTier(input.authorityTier)
      ? 'manual_candidate'
      : byConfidence;

  if (!input.sourceTermsApproved && withCandidateGate !== 'needs_review') return 'needs_review';
  return withCandidateGate;
}

// ── whole formula ──────────────────────────────────────────────────────────────
export interface ConfidenceInput {
  authorityTier: string | null | undefined;
  parseQuality: ParseQualityInput;
  lastCheckAtMs: number | null;
  cadenceSeconds: number | null;
  healthScore: number | null;
  nowMs: number;
}

export interface ConfidenceResult {
  score: number;
  label: ConfidenceLabel;
  factors: { authority: number; parseQuality: number; freshness: number; volatility: number };
}

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const authority = authorityFactor(input.authorityTier);
  const parseQuality = parseQualityFactor(input.parseQuality);
  const freshness = freshnessFactor(input.lastCheckAtMs, input.cadenceSeconds, input.nowMs);
  const volatility = volatilityFactor(input.healthScore);
  const score = clamp01(authority * parseQuality * freshness * volatility);
  return { score, label: scoreToLabel(score), factors: { authority, parseQuality, freshness, volatility } };
}

// ── per-run source context loader ──────────────────────────────────────────────
export interface SourceConfidenceContext {
  authorityTier: string | null;
  cadenceSeconds: number | null;
  lastCheckAtMs: number | null;
  /** computeSourceHealth().score over the rolling window, or null when the source
   *  has no completed runs yet (→ volatilityFactor uses its neutral default). */
  healthScore: number | null;
}

/**
 * Load, ONCE per ingest run (not per record), everything the confidence formula
 * needs from the source row + its source_check_run history. Derives the source's
 * health score via the SAME pure helpers T15's SLA computation uses, so ingest
 * confidence and the source-health board can never silently disagree.
 *
 * The run's own in-flight check_run row is status='running', which every stat
 * filter excludes, so this never self-pollutes: on a source's first ingest the
 * history is empty → healthScore null → neutral volatility.
 */
export async function loadSourceConfidenceContext(
  pool: Pool,
  sourceId: string,
  nowMs: number = Date.now(),
  windowDays: number = HEALTH_WINDOW_DAYS
): Promise<SourceConfidenceContext> {
  const { rows } = await pool.query<{
    authority_tier: string | null;
    cadence_seconds: number | null;
    last_check_at: Date | null;
    last_success_at: Date | null;
    attempted: number | null;
    succeeded: number | null;
    with_records: number | null;
  }>(
    `SELECT
       s.authority_tier,
       extract(epoch FROM COALESCE(s.near_date_cadence, s.baseline_cadence))::float8 AS cadence_seconds,
       s.last_check_at,
       success.last_success_at,
       stats.attempted,
       stats.succeeded,
       stats.with_records
     FROM source s
     LEFT JOIN LATERAL (
       SELECT max(started_at) AS last_success_at
       FROM source_check_run cr
       WHERE cr.source_id = s.id AND cr.status IN ('success', 'partial')
     ) success ON true
     LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE cr.status IN ('success', 'partial', 'failed'))::int AS attempted,
         count(*) FILTER (WHERE cr.status IN ('success', 'partial'))::int            AS succeeded,
         count(*) FILTER (WHERE cr.status IN ('success', 'partial')
                            AND COALESCE(cr.records_found, 0) > 0)::int               AS with_records
       FROM source_check_run cr
       WHERE cr.source_id = s.id
         AND cr.started_at >= now() - ($2::int * interval '1 day')
     ) stats ON true
     WHERE s.id = $1`,
    [sourceId, windowDays]
  );

  const r = rows[0];
  if (!r) return { authorityTier: null, cadenceSeconds: null, lastCheckAtMs: null, healthScore: null };

  const counts: RunCounts = {
    attempted: r.attempted ?? 0,
    succeeded: r.succeeded ?? 0,
    withRecords: r.with_records ?? 0,
  };
  const cadenceSeconds = r.cadence_seconds ?? null;
  const lastSuccessAtMs = r.last_success_at ? new Date(r.last_success_at).getTime() : null;
  const adherence = adherenceFactor({ lastSuccessAtMs, cadenceSeconds }, nowMs);
  const health = computeSourceHealth({
    adherence,
    successRate: checkSuccessRate(counts),
    parseYieldRate: parseYieldRate(counts),
    attempted: counts.attempted,
  });

  return {
    authorityTier: r.authority_tier ?? null,
    cadenceSeconds,
    lastCheckAtMs: r.last_check_at ? new Date(r.last_check_at).getTime() : null,
    healthScore: health.score,
  };
}

// ── clamps ─────────────────────────────────────────────────────────────────────
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
