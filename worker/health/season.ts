// worker/health/season.ts — G-T15-1: general season STATE MACHINE + occurrence-level
// status inheritance (TSD §7.1). This is the broad, source-type-agnostic seasonality
// infrastructure. It deliberately REUSES (does not fork) the seasonal-watcher signal
// mapping built by Round 22 / Task MM in worker/adapters/seasonal/map.ts:
//   • SeasonState / SEASON_STATES     — the persisted `season_state` enum vocabulary
//   • resolveSeasonState + SeasonOverride — signal→state + "manual override always wins"
//   • applySeasonState (atomic CTE)   — the single-statement write of season_state
// map.ts covers "watcher signal → season_state transition for ONE source family". This
// file adds what map.ts explicitly deferred to T15:
//   1. a TRANSITION GRAPH (which season_state → season_state moves are legal, and the
//      universal "→ suspended on official status" edge), usable by ANY source type;
//   2. OCCURRENCE-LEVEL status inheritance — a source/series season_state cascades onto
//      its occurrences' status_state (seasonal_active / seasonal_preseason /
//      seasonal_out_of_season / suspended), which is what actually moves listings in and
//      out of the public search result sections (lib/search/filters/status.ts).
//
// NOTE on "dormant": the scope narrative's lifecycle is
//   unknown → pre_season → in_season → post_season → dormant → … , → suspended.
// The persisted `season_state` enum (supabase/migrations/0002_enums.sql) has no separate
// `dormant` member; `post_season` IS the off-season / dormant resting phase in this schema
// (an occurrence in it inherits `seasonal_out_of_season`). We model the full cycle over the
// existing enum rather than add a new value, because a new enum member is a cross-cutting
// change (migration + app/admin/sources vocab + the season_state drift guard test) well
// outside this task's file scope. See the findings doc for the full reasoning.
import type { Pool } from 'pg';
import {
  SEASON_STATES,
  resolveSeasonState,
  applySeasonState,
  type SeasonState,
  type SeasonOverride,
  type SeasonStateMapping,
  type SeasonSourceSelector,
  type SeasonTransition,
} from '../adapters/seasonal/map';
import type { SeasonalStatusSignal } from '../adapters/seasonal/index';

export {
  SEASON_STATES,
  resolveSeasonState,
  applySeasonState,
  type SeasonState,
  type SeasonOverride,
  type SeasonStateMapping,
  type SeasonSourceSelector,
  type SeasonTransition,
};

// ─────────────────────────────────────────────────────────────────────────────
// Transition graph. `from → [allowed to…]`. Edges encode the ORDERED seasonal
// lifecycle so a flapping/out-of-order signal can't corrupt the machine:
//   • the cycle runs pre_season → in_season → post_season(=dormant) → pre_season → …
//     and CANNOT skip a phase (pre_season ↛ post_season, in_season ↛ pre_season,
//     post_season ↛ in_season, active ↛ in_season are all illegal).
//   • unknown is the bootstrap state → it may resolve to anything once learned, and
//     any state may fall back to unknown (we can always admit we lost signal).
//   • active is the non-seasonal "just operating" default (activity_series default);
//     it enters seasonality via pre_season.
//   • suspended is reachable from EVERY state (isValidTransition special-cases it — the
//     "→ suspended on official status" rule) and recovery restores any operational state.
// A same-state "transition" (from === to) is always legal (idempotent re-apply).
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED: Record<SeasonState, readonly SeasonState[]> = {
  unknown: ['active', 'pre_season', 'in_season', 'post_season', 'suspended'],
  active: ['pre_season', 'suspended', 'unknown'],
  pre_season: ['in_season', 'suspended', 'unknown'],
  in_season: ['post_season', 'suspended', 'unknown'],
  post_season: ['pre_season', 'active', 'suspended', 'unknown'],
  suspended: ['active', 'pre_season', 'in_season', 'post_season', 'unknown'],
};

/** Every state can be forced to `suspended` on an official out-of-service/closure. */
export const OFFICIAL_SUSPEND_TARGET: SeasonState = 'suspended';

/** Is `from → to` a legal season_state transition? Same-state moves are always legal. */
export function isValidTransition(from: SeasonState, to: SeasonState): boolean {
  if (from === to) return true;
  if (to === OFFICIAL_SUSPEND_TARGET) return true; // official suspend from anywhere
  return (ALLOWED[from] ?? []).includes(to);
}

export interface TransitionEvaluation {
  from: SeasonState;
  to: SeasonState;
  valid: boolean;
  /** When invalid, the state we clamp to instead (stay put) so a bad signal can't
   *  corrupt the machine; the caller can surface `valid=false` for review. */
  applied: SeasonState;
  reason: string;
}

/**
 * Evaluate moving `from` toward `to`. An official suspend always applies. A legal
 * transition applies. An ILLEGAL transition is rejected — we clamp to `from` (stay put)
 * and flag it, rather than silently writing a corrupt jump — EXCEPT `unknown` as a
 * target is always allowed (we can always admit we no longer know).
 */
export function evaluateTransition(from: SeasonState, to: SeasonState): TransitionEvaluation {
  if (isValidTransition(from, to)) {
    return { from, to, valid: true, applied: to, reason: `${from} → ${to}` };
  }
  return {
    from,
    to,
    valid: false,
    applied: from,
    reason: `illegal transition ${from} → ${to} rejected; staying at ${from}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Occurrence-level status inheritance. A source's season_state governs the
// status_state its occurrences present with. The target status_state values are the
// seasonal members of the status_state enum (0002_enums.sql); lib/search/filters/status.ts
// then routes them to the primary vs "expected/seasonal" result sections.
// ─────────────────────────────────────────────────────────────────────────────

/** season_state → the status_state its occurrences should inherit, or null = leave as-is
 *  (`active`/`unknown` impose no seasonal status — occurrences keep their ingest status). */
export function statusStateForSeason(season: SeasonState): string | null {
  switch (season) {
    case 'in_season':
      return 'seasonal_active';
    case 'pre_season':
      return 'seasonal_preseason';
    case 'post_season':
      return 'seasonal_out_of_season';
    case 'suspended':
      return 'suspended';
    case 'active':
    case 'unknown':
    default:
      return null;
  }
}

/**
 * status_states an occurrence may be MOVED AWAY FROM by season inheritance. Restricted to
 * auto-derived "live/seasonal/default" statuses so inheritance never clobbers a more
 * specific human/booking decision (cancelled / postponed / full / waitlist /
 * manual_candidate stay put). Includes the seasonal states + `suspended` so a source that
 * comes back in-season can re-activate occurrences it previously seasonally-suspended.
 */
export const SEASON_INHERITABLE_FROM: readonly string[] = [
  'confirmed',
  'bookable_open',
  'not_yet_bookable',
  'schedule_not_published',
  'inferred_recurring',
  'needs_review',
  'stale',
  'seasonal_active',
  'seasonal_preseason',
  'seasonal_out_of_season',
  'suspended',
];

export interface InheritanceResult {
  season: SeasonState;
  targetStatus: string | null;
  /** Occurrences whose status_state this call changed. 0 when target is null or nothing matched. */
  updated: number;
}

/**
 * Cascade a source's season_state onto its (non-archived) occurrences' status_state.
 * Only occurrences currently in a SEASON_INHERITABLE_FROM status and not already at the
 * target are touched. No-op (updated:0) for `active`/`unknown` seasons. Occurrences are
 * reached via activity_series.source_id.
 */
export async function inheritOccurrenceStatus(
  pool: Pool,
  sourceId: string,
  season: SeasonState
): Promise<InheritanceResult> {
  const targetStatus = statusStateForSeason(season);
  if (!targetStatus) return { season, targetStatus: null, updated: 0 };

  const { rowCount } = await pool.query(
    `UPDATE activity_occurrence o
        SET status_state = $2::status_state
       FROM activity_series s
      WHERE o.series_id = s.id
        AND s.source_id = $1
        AND o.archived_at IS NULL
        AND o.status_state <> $2::status_state
        AND o.status_state::text = ANY($3::text[])`,
    [sourceId, targetStatus, SEASON_INHERITABLE_FROM]
  );
  return { season, targetStatus, updated: rowCount ?? 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// The machine's public "apply" surface.
// ─────────────────────────────────────────────────────────────────────────────

export interface SeasonMachineResult {
  transition: SeasonTransition;
  evaluation: TransitionEvaluation;
  inheritance: InheritanceResult;
}

interface ApplyOpts {
  reason?: string;
  /** Cascade the resolved state onto the source's occurrences (default true). */
  cascade?: boolean;
  /** Stamp source.last_check_at = now() (default true, matches map.applySeasonState). */
  touchLastCheck?: boolean;
}

async function loadSourceState(pool: Pool, sourceId: string): Promise<SeasonState> {
  const { rows } = await pool.query<{ season_state: SeasonState }>(
    `SELECT season_state FROM source WHERE id = $1 LIMIT 1`,
    [sourceId]
  );
  if (!rows[0]) throw new Error(`source not found: ${sourceId}`);
  return rows[0].season_state;
}

/**
 * Drive one source through the machine to a desired `to` state, enforcing the transition
 * graph, then (by default) cascading occurrence status inheritance. Rejects illegal
 * transitions (stays put, `evaluation.valid=false`) so a spurious signal can't corrupt the
 * lifecycle — an official suspend is always honoured.
 */
export async function applySeasonTransition(
  pool: Pool,
  sourceId: string,
  to: SeasonState,
  opts: ApplyOpts = {}
): Promise<SeasonMachineResult> {
  const from = await loadSourceState(pool, sourceId);
  const evaluation = evaluateTransition(from, to);
  const transition = await applySeasonState(
    pool,
    { id: sourceId },
    evaluation.applied,
    { reason: opts.reason ?? evaluation.reason, touchLastCheck: opts.touchLastCheck }
  );
  const inheritance =
    opts.cascade === false
      ? { season: evaluation.applied, targetStatus: statusStateForSeason(evaluation.applied), updated: 0 }
      : await inheritOccurrenceStatus(pool, sourceId, evaluation.applied);
  return { transition, evaluation, inheritance };
}

/**
 * Resolve a watcher signal (+ optional manual override) into a season_state via Task MM's
 * resolveSeasonState, then run it through the machine (transition-checked + cascaded). This
 * is the seam runSeasonalWatch (worker/adapters/seasonal) can call to get transition-safety
 * and occurrence inheritance on top of the raw signal→state mapping.
 */
export async function applySeasonSignal(
  pool: Pool,
  sourceId: string,
  signal: SeasonalStatusSignal,
  override?: SeasonOverride,
  opts: ApplyOpts = {}
): Promise<SeasonMachineResult & { mapping: SeasonStateMapping }> {
  const mapping = resolveSeasonState(signal, override);
  const result = await applySeasonTransition(pool, sourceId, mapping.seasonState, {
    ...opts,
    reason: opts.reason ?? mapping.reason,
  });
  return { ...result, mapping };
}

/** Convenience: force a source to `suspended` (official out-of-service/closure). Always legal. */
export async function suspendOnOfficialStatus(
  pool: Pool,
  sourceId: string,
  reason: string,
  opts: ApplyOpts = {}
): Promise<SeasonMachineResult> {
  return applySeasonTransition(pool, sourceId, OFFICIAL_SUSPEND_TARGET, {
    ...opts,
    reason: `official status suspend: ${reason}`,
  });
}
