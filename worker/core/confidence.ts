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
//                     cadence-adherence + parse-yield over a rolling window). True
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
//     BR-05 posture, whereas 'manual_candidate' = 'expected' is still surfaced and is
//     reserved for T14 dedup / T34 manually-entered leads, not auto-ingested rows.
import type { Pool } from 'pg';
import {
  cadenceAdherent,
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
  const adherent = cadenceAdherent({ lastSuccessAtMs, cadenceSeconds }, nowMs);
  const health = computeSourceHealth({
    adherent,
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
