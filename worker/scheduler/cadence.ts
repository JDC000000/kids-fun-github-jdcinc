// worker/scheduler/cadence.ts — G-T15-2: tiered cadence ENGINE (TSD §7.2).
// The decision core the scheduler (worker/scheduler/tiered.ts) applies: given a source
// ROW's own columns, resolve which cadence TIER it is in and the effective interval to
// stamp onto next_check_at. Everything is read FROM THE SOURCE TABLE (baseline_cadence,
// near_date_cadence, ingestion_method) plus a near-date occurrence signal — nothing is
// hardcoded per source, so changing a row changes its scheduling.
//
// This supersedes the original 2-tier COALESCE(near_date_cadence, baseline_cadence) logic
// that lived inline in tiered.ts: near_date_cadence is now only used when the source
// actually HAS an occurrence coming up (the "volatile / near-date" tier), not
// unconditionally. tiered.ts imports resolveCadenceTier so the tier rules exist once here.
//
// Tiers (scope §G-T15-2):
//   • manual        — operator-fed (ingestion_method='manual'); NOT auto-scheduled.
//   • near_date     — sub-daily (30–120 min) volatile tier: a near-term occurrence exists
//                     AND the source declares a near_date_cadence → use near_date_cadence.
//   • seasonal      — weekly tier: a weekly-or-longer baseline_cadence (a status watcher).
//   • baseline      — daily default: baseline_cadence.

export type CadenceTier = 'manual' | 'near_date' | 'seasonal' | 'baseline';

/** Fallback when a source somehow has no baseline (baseline_cadence is NOT NULL, so
 *  defensive only). Mirrors lib/admin/dashboard.ts DEFAULT_CADENCE_SECONDS (1 day). */
export const DEFAULT_CADENCE_SECONDS = 24 * 60 * 60;

/** A baseline cadence at/above this (7 days) puts a source in the weekly "seasonal" tier. */
export const SEASONAL_MIN_SECONDS = 7 * 24 * 60 * 60;

/** How far ahead an occurrence counts as "near-term" and escalates a source to the
 *  sub-daily near_date tier. A source with imminent occurrences is checked more often. */
export const NEAR_DATE_HORIZON_DAYS = 7;

/** ingestion_method values that mean "not auto-crawled" → the manual tier. */
const MANUAL_INGESTION_METHODS = new Set(['manual']);

/** The source-table fields the tier decision reads. All come straight off the `source`
 *  row except hasNearOccurrence, which is a per-source EXISTS over its upcoming occurrences. */
export interface CadenceInputs {
  ingestionMethod: string;
  /** EXTRACT(EPOCH FROM baseline_cadence). */
  baselineCadenceSeconds: number | null;
  /** EXTRACT(EPOCH FROM near_date_cadence), or null when the column is NULL. */
  nearDateCadenceSeconds: number | null;
  /** True when the source has a non-archived occurrence starting within NEAR_DATE_HORIZON. */
  hasNearOccurrence: boolean;
}

export interface CadenceResolution {
  tier: CadenceTier;
  /** Effective interval, in seconds, to schedule the next check at. null ⟺ not scheduled
   *  (manual tier) — the scheduler must skip these. */
  cadenceSeconds: number | null;
  /** Whether the auto-scheduler should enqueue this source. False only for the manual tier. */
  scheduled: boolean;
  reason: string;
}

function positive(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve a source's cadence tier + effective interval purely from its row. Precedence:
 *   manual  →  near_date (imminent + near_date_cadence)  →  seasonal (weekly baseline)  →  baseline.
 * Pure and DB-free so it is exhaustively unit-testable on known inputs.
 */
export function resolveCadenceTier(input: CadenceInputs): CadenceResolution {
  if (MANUAL_INGESTION_METHODS.has(input.ingestionMethod)) {
    return {
      tier: 'manual',
      cadenceSeconds: null,
      scheduled: false,
      reason: `manual tier — ingestion_method=${input.ingestionMethod} is operator-fed, not auto-scheduled`,
    };
  }

  const baseline = positive(input.baselineCadenceSeconds) ?? DEFAULT_CADENCE_SECONDS;
  const nearDate = positive(input.nearDateCadenceSeconds);

  if (input.hasNearOccurrence && nearDate != null) {
    return {
      tier: 'near_date',
      cadenceSeconds: nearDate,
      scheduled: true,
      reason: `near_date tier — upcoming occurrence within ${NEAR_DATE_HORIZON_DAYS}d; sub-daily cadence ${nearDate}s`,
    };
  }

  if (baseline >= SEASONAL_MIN_SECONDS) {
    return {
      tier: 'seasonal',
      cadenceSeconds: baseline,
      scheduled: true,
      reason: `seasonal tier — weekly-or-longer baseline cadence ${baseline}s`,
    };
  }

  return {
    tier: 'baseline',
    cadenceSeconds: baseline,
    scheduled: true,
    reason: `baseline tier — daily-default baseline cadence ${baseline}s`,
  };
}

/** The seconds to advance next_check_at by for a resolved source (falls back to the
 *  default cadence for a manual/none source so a caller never stamps a null interval). */
export function nextCheckIntervalSeconds(resolution: CadenceResolution): number {
  return resolution.cadenceSeconds ?? DEFAULT_CADENCE_SECONDS;
}
