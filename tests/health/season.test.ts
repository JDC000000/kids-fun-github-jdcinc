// tests/health/season.test.ts — G-T15-1 season state machine.
//  • PURE: the transition graph rejects illegal/out-of-order jumps, honours official
//    suspend, and maps each season_state to the occurrence status it should inherit.
//  • DB: driving a source through the machine cascades onto its occurrences' status_state
//    (and a rejected transition leaves both untouched).
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  isValidTransition,
  evaluateTransition,
  statusStateForSeason,
  applySeasonTransition,
  applySeasonSignal,
  suspendOnOfficialStatus,
  inheritOccurrenceStatus,
} from '../../worker/health/season';
import type { SeasonalStatusSignal } from '../../worker/adapters/seasonal/index';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

describe('season transition graph (pure)', () => {
  it('allows the ordered lifecycle: pre → in → post → pre', () => {
    expect(isValidTransition('pre_season', 'in_season')).toBe(true);
    expect(isValidTransition('in_season', 'post_season')).toBe(true);
    expect(isValidTransition('post_season', 'pre_season')).toBe(true);
  });

  it('rejects phase-skipping / out-of-order jumps', () => {
    expect(isValidTransition('pre_season', 'post_season')).toBe(false);
    expect(isValidTransition('in_season', 'pre_season')).toBe(false);
    expect(isValidTransition('post_season', 'in_season')).toBe(false);
    expect(isValidTransition('active', 'in_season')).toBe(false);
  });

  it('always allows an official suspend from any state, and idempotent same-state', () => {
    for (const from of ['unknown', 'active', 'pre_season', 'in_season', 'post_season', 'suspended'] as const) {
      expect(isValidTransition(from, 'suspended')).toBe(true);
      expect(isValidTransition(from, from)).toBe(true);
    }
  });

  it('unknown bootstraps to anything; any state may fall back to unknown', () => {
    expect(isValidTransition('unknown', 'in_season')).toBe(true);
    expect(isValidTransition('in_season', 'unknown')).toBe(true);
  });

  it('evaluateTransition applies a legal move and clamps an illegal one', () => {
    expect(evaluateTransition('pre_season', 'in_season')).toMatchObject({ valid: true, applied: 'in_season' });
    const bad = evaluateTransition('in_season', 'pre_season');
    expect(bad.valid).toBe(false);
    expect(bad.applied).toBe('in_season'); // stays put
  });
});

describe('season → occurrence status inheritance (pure)', () => {
  it('maps each seasonal state to its status_state; active/unknown impose none', () => {
    expect(statusStateForSeason('in_season')).toBe('seasonal_active');
    expect(statusStateForSeason('pre_season')).toBe('seasonal_preseason');
    expect(statusStateForSeason('post_season')).toBe('seasonal_out_of_season');
    expect(statusStateForSeason('suspended')).toBe('suspended');
    expect(statusStateForSeason('active')).toBeNull();
    expect(statusStateForSeason('unknown')).toBeNull();
  });
});

describe.skipIf(!hasDb)('season state machine drives occurrences (DB)', () => {
  const TAG = `t15season_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sourceId = '';
  let seriesId = '';
  let confirmedOccId = '';
  let cancelledOccId = '';

  async function seed(): Promise<void> {
    const [s] = await query<{ id: string }>(
      `INSERT INTO source (family, name, season_state) VALUES ('noop', $1, 'unknown') RETURNING id`,
      [`${TAG} src`]
    );
    sourceId = s.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id, season_state) VALUES ($1, $2, 'active') RETURNING id`,
      [`${TAG} series`, sourceId]
    );
    seriesId = ser.id;
    const [c] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, $2, now() + interval '3 days', 'confirmed') RETURNING id`,
      [seriesId, `${TAG} confirmed occ`]
    );
    confirmedOccId = c.id;
    const [x] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, $2, now() + interval '3 days', 'cancelled') RETURNING id`,
      [seriesId, `${TAG} cancelled occ`]
    );
    cancelledOccId = x.id;
  }

  async function statusOf(occId: string): Promise<string> {
    const [r] = await query<{ status_state: string }>(`SELECT status_state FROM activity_occurrence WHERE id = $1`, [occId]);
    return r.status_state;
  }
  async function seasonOf(): Promise<string> {
    const [r] = await query<{ season_state: string }>(`SELECT season_state FROM source WHERE id = $1`, [sourceId]);
    return r.season_state;
  }

  afterEach(async () => {
    for (const id of [confirmedOccId, cancelledOccId]) if (id) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [id]);
    if (seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [seriesId]);
    if (sourceId) await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
    sourceId = seriesId = confirmedOccId = cancelledOccId = '';
  });

  afterAll(async () => {
    await closePool();
  });

  it('cascades a legal transition onto inheritable occurrences only', async () => {
    await seed();
    const pool = getPool();

    const r1 = await applySeasonTransition(pool, sourceId, 'pre_season');
    expect(r1.evaluation.valid).toBe(true);
    expect(await seasonOf()).toBe('pre_season');
    expect(r1.inheritance.updated).toBe(1); // only the confirmed occurrence
    expect(await statusOf(confirmedOccId)).toBe('seasonal_preseason');
    expect(await statusOf(cancelledOccId)).toBe('cancelled'); // human decision untouched

    const r2 = await applySeasonTransition(pool, sourceId, 'in_season');
    expect(r2.evaluation.valid).toBe(true);
    expect(await statusOf(confirmedOccId)).toBe('seasonal_active');

    const r3 = await applySeasonTransition(pool, sourceId, 'post_season');
    expect(await seasonOf()).toBe('post_season');
    expect(await statusOf(confirmedOccId)).toBe('seasonal_out_of_season');
  });

  it('rejects an illegal transition and leaves season + occurrences unchanged', async () => {
    await seed();
    const pool = getPool();
    await applySeasonTransition(pool, sourceId, 'pre_season'); // unknown → pre_season (legal)
    await applySeasonTransition(pool, sourceId, 'in_season'); // pre → in (legal)

    const rejected = await applySeasonTransition(pool, sourceId, 'pre_season'); // in → pre (ILLEGAL)
    expect(rejected.evaluation.valid).toBe(false);
    expect(await seasonOf()).toBe('in_season'); // stayed put
    expect(await statusOf(confirmedOccId)).toBe('seasonal_active'); // unchanged
  });

  it('official suspend always applies and inherits suspended onto occurrences', async () => {
    await seed();
    const pool = getPool();
    await applySeasonTransition(pool, sourceId, 'pre_season');
    const s = await suspendOnOfficialStatus(pool, sourceId, 'weather closure');
    expect(s.evaluation.valid).toBe(true);
    expect(await seasonOf()).toBe('suspended');
    expect(await statusOf(confirmedOccId)).toBe('suspended');
  });

  it('applySeasonSignal maps a watcher signal and a manual override wins', async () => {
    await seed();
    const pool = getPool();
    const signal: SeasonalStatusSignal = {
      sourceKey: 'k',
      sourceName: 'n',
      signal: 'open', // → in_season
      matchedText: 'now open',
      weatherRelated: false,
      live: false,
      observedAtIso: '2026-07-20T00:00:00.000Z',
    };
    const r = await applySeasonSignal(pool, sourceId, signal);
    expect(r.mapping.seasonState).toBe('in_season');
    expect(await seasonOf()).toBe('in_season');

    // Manual override always wins over the signal (Task MM resolveSeasonState behaviour).
    const overridden = await applySeasonSignal(pool, sourceId, signal, {
      seasonState: 'suspended',
      reason: 'ops closed it',
      setBy: 'operator-1',
    });
    expect(overridden.mapping.origin).toBe('manual_override');
    expect(await seasonOf()).toBe('suspended');
  });

  it('inheritOccurrenceStatus is a no-op for active/unknown seasons', async () => {
    await seed();
    const pool = getPool();
    const r = await inheritOccurrenceStatus(pool, sourceId, 'active');
    expect(r.updated).toBe(0);
    expect(await statusOf(confirmedOccId)).toBe('confirmed');
  });
});
