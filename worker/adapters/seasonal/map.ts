// worker/adapters/seasonal/map.ts — G-T12-2: map a watcher signal -> season_state
// transition (TSD §7.1). Two concerns:
//   1. PURE mapping: SeasonalSignal -> season_state, with a manual override hook
//      that always wins over the watched signal.
//   2. DB APPLY: write the resolved season_state onto `source.season_state` and
//      return the transition (from -> to). That column is what the admin sources
//      console (app/admin/sources) reads and renders, so a watched status change
//      becomes queryable/visible in an existing surface with no other wiring.
//
// This does NOT implement the full season STATE MACHINE with occurrence-level
// status inheritance — that is G-T15-1 (worker/health/season.ts). T12 provides the
// signal-driven transition + manual override that T15's machine consumes.
import type { Pool } from 'pg';
import type { SeasonalSignal, SeasonalStatusSignal } from './index';

// Mirrors the `season_state` enum in supabase/migrations/0002_enums.sql. A source
// row can only hold one of these; the app-side vocab (app/admin/sources/_lib/vocab.ts)
// mirrors the same set, and a DB drift test keeps both honest against the column.
export const SEASON_STATES = [
  'active',
  'pre_season',
  'in_season',
  'post_season',
  'suspended',
  'unknown',
] as const;
export type SeasonState = (typeof SEASON_STATES)[number];

/** Deterministic signal -> season_state map (TSD §7.1). */
const SIGNAL_TO_STATE: Record<SeasonalSignal, SeasonState> = {
  open: 'in_season',
  opening_soon: 'pre_season',
  closed_seasonal: 'post_season',
  suspended: 'suspended',
  unknown: 'unknown',
};

/** Pure map from a classified signal to a season_state. */
export function mapSignalToSeasonState(signal: SeasonalSignal): SeasonState {
  return SIGNAL_TO_STATE[signal] ?? 'unknown';
}

/** An operator-supplied override (manual.ts builds one from a manual seasonal record). */
export interface SeasonOverride {
  seasonState: SeasonState;
  reason: string;
  /** Who set the override (operator id / label) — recorded in the transition reason. */
  setBy: string;
}

export interface SeasonStateMapping {
  seasonState: SeasonState;
  reason: string;
  /** Whether the state came from the watched signal or a manual override. */
  origin: 'signal' | 'manual_override';
}

/**
 * Resolve the season_state to apply: a manual override ALWAYS wins over the
 * watched signal (the "manual override hook" from G-T12-2). Otherwise the signal
 * maps deterministically. The returned `reason` is a human/audit string.
 */
export function resolveSeasonState(
  signal: SeasonalStatusSignal,
  override?: SeasonOverride
): SeasonStateMapping {
  if (override) {
    return {
      seasonState: override.seasonState,
      reason: `manual override by ${override.setBy}: ${override.reason}`,
      origin: 'manual_override',
    };
  }
  const seasonState = mapSignalToSeasonState(signal.signal);
  const weather = signal.weatherRelated ? ' (weather hold)' : '';
  const matched = signal.matchedText ? ` matched "${signal.matchedText}"` : '';
  return {
    seasonState,
    reason: `status signal "${signal.signal}"${weather} from ${signal.sourceName}${matched}`,
    origin: 'signal',
  };
}

/** Locate a source row for the transition — by id or by (family, name). */
export type SeasonSourceSelector = { id: string } | { family: string; name: string };

export interface SeasonTransition {
  sourceId: string;
  family: string;
  name: string;
  from: SeasonState;
  to: SeasonState;
  /** True only when the state actually changed (from !== to). */
  changed: boolean;
  reason: string;
}

interface TransitionRow {
  id: string;
  family: string;
  name: string;
  from_state: SeasonState;
  to_state: SeasonState;
}

function selectorClause(selector: SeasonSourceSelector): { sql: string; values: string[] } {
  if ('id' in selector) {
    return { sql: 'id = $1', values: [selector.id] };
  }
  return { sql: 'family = $1 AND name = $2', values: [selector.family, selector.name] };
}

/**
 * Apply a season_state to the selected source row and return the transition.
 * Atomic (single CTE): captures the previous value and writes the new one in one
 * statement, so concurrent watchers can't interleave a read and a write. Setting
 * `touchLastCheck` also stamps last_check_at = now() (the row's updated_at trigger
 * bumps regardless). @throws Error('source not found') when the selector matches no row.
 */
export async function applySeasonState(
  pool: Pool,
  selector: SeasonSourceSelector,
  to: SeasonState,
  opts: { reason?: string; touchLastCheck?: boolean } = {}
): Promise<SeasonTransition> {
  const { sql: where, values } = selectorClause(selector);
  const toParam = `$${values.length + 1}`;
  const setLastCheck = opts.touchLastCheck === false ? '' : ', last_check_at = now()';

  const { rows } = await pool.query<TransitionRow>(
    `WITH prev AS (
       SELECT id, family, name, season_state AS old_state
         FROM source
        WHERE ${where}
        LIMIT 1
     )
     UPDATE source AS s
        SET season_state = ${toParam}::season_state${setLastCheck}
       FROM prev
      WHERE s.id = prev.id
     RETURNING prev.id AS id, prev.family AS family, prev.name AS name,
               prev.old_state AS from_state, s.season_state AS to_state`,
    [...values, to]
  );

  const row = rows[0];
  if (!row) {
    const label = 'id' in selector ? selector.id : `${selector.family} / ${selector.name}`;
    throw new Error(`source not found: ${label}`);
  }

  return {
    sourceId: row.id,
    family: row.family,
    name: row.name,
    from: row.from_state,
    to: row.to_state,
    changed: row.from_state !== row.to_state,
    reason: opts.reason ?? `season_state set to ${to}`,
  };
}
