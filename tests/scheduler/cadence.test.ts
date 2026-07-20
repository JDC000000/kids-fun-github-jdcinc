// tests/scheduler/cadence.test.ts — G-T15-2 tiered cadence engine.
//  • PURE: resolveCadenceTier picks the right tier + interval from a source row's columns.
//  • DB: proves changing a source's tier IN THE TABLE changes the scheduler's behaviour
//    (which interval next_check_at is stamped with, and whether it's enqueued at all).
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveCadenceTier,
  nextCheckIntervalSeconds,
  DEFAULT_CADENCE_SECONDS,
  SEASONAL_MIN_SECONDS,
} from '../../worker/scheduler/cadence';
import { enqueueDueJobs } from '../../worker/scheduler/tiered';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400;
const HOUR = 3_600;

describe('resolveCadenceTier (pure, table-driven)', () => {
  it('manual ingestion_method → manual tier, not scheduled', () => {
    const r = resolveCadenceTier({
      ingestionMethod: 'manual',
      baselineCadenceSeconds: DAY,
      nearDateCadenceSeconds: HOUR,
      hasNearOccurrence: true,
    });
    expect(r.tier).toBe('manual');
    expect(r.scheduled).toBe(false);
    expect(r.cadenceSeconds).toBeNull();
    // Even a manual source gets a safe stamp interval if a caller forces one.
    expect(nextCheckIntervalSeconds(r)).toBe(DEFAULT_CADENCE_SECONDS);
  });

  it('near-term occurrence + near_date_cadence → near_date (sub-daily) tier', () => {
    const r = resolveCadenceTier({
      ingestionMethod: 'auto',
      baselineCadenceSeconds: DAY,
      nearDateCadenceSeconds: HOUR,
      hasNearOccurrence: true,
    });
    expect(r.tier).toBe('near_date');
    expect(r.cadenceSeconds).toBe(HOUR);
    expect(r.scheduled).toBe(true);
  });

  it('near_date_cadence set but NO near occurrence → falls back to baseline (daily)', () => {
    const r = resolveCadenceTier({
      ingestionMethod: 'auto',
      baselineCadenceSeconds: DAY,
      nearDateCadenceSeconds: HOUR,
      hasNearOccurrence: false,
    });
    expect(r.tier).toBe('baseline');
    expect(r.cadenceSeconds).toBe(DAY);
  });

  it('weekly-or-longer baseline → seasonal tier', () => {
    const r = resolveCadenceTier({
      ingestionMethod: 'semi',
      baselineCadenceSeconds: 7 * DAY,
      nearDateCadenceSeconds: null,
      hasNearOccurrence: false,
    });
    expect(r.tier).toBe('seasonal');
    expect(r.cadenceSeconds).toBe(7 * DAY);
    expect(SEASONAL_MIN_SECONDS).toBe(7 * DAY);
  });

  it('a seasonal (weekly) source still escalates to near_date when an occurrence is imminent', () => {
    const r = resolveCadenceTier({
      ingestionMethod: 'semi',
      baselineCadenceSeconds: 7 * DAY,
      nearDateCadenceSeconds: DAY,
      hasNearOccurrence: true,
    });
    expect(r.tier).toBe('near_date');
    expect(r.cadenceSeconds).toBe(DAY);
  });

  it('plain daily baseline → baseline tier; missing baseline → default', () => {
    expect(resolveCadenceTier({ ingestionMethod: 'auto', baselineCadenceSeconds: DAY, nearDateCadenceSeconds: null, hasNearOccurrence: false }).tier).toBe('baseline');
    const none = resolveCadenceTier({ ingestionMethod: 'auto', baselineCadenceSeconds: null, nearDateCadenceSeconds: null, hasNearOccurrence: false });
    expect(none.tier).toBe('baseline');
    expect(none.cadenceSeconds).toBe(DEFAULT_CADENCE_SECONDS);
  });
});

describe.skipIf(!hasDb)('tiered scheduler applies the table-driven tier (DB)', () => {
  const TAG = `t15cad_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sourceId = '';
  let seriesId = '';

  beforeEach(async () => {
    // A due, approved, auto source with a daily baseline and an hourly near-date cadence.
    const [s] = await query<{ id: string }>(
      `INSERT INTO source (family, name, terms_status, robots_status, ingestion_method, baseline_cadence, near_date_cadence, next_check_at)
       VALUES ('noop', $1, 'allowed', 'allowed', 'auto', '1 day', '1 hour', now() - interval '1 minute')
       RETURNING id`,
      [`${TAG} src`]
    );
    sourceId = s.id;
  });

  afterEach(async () => {
    if (sourceId) {
      await query(`DELETE FROM job_queue WHERE source_id = $1`, [sourceId]);
      await query(`DELETE FROM activity_occurrence o USING activity_series ser WHERE o.series_id = ser.id AND ser.source_id = $1`, [sourceId]);
      await query(`DELETE FROM activity_series WHERE source_id = $1`, [sourceId]);
      await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
    }
    sourceId = '';
    seriesId = '';
  });

  afterAll(async () => {
    await closePool();
  });

  async function makeDueAgain(): Promise<void> {
    await query(`DELETE FROM job_queue WHERE source_id = $1`, [sourceId]);
    await query(`UPDATE source SET next_check_at = now() - interval '1 minute' WHERE id = $1`, [sourceId]);
  }

  async function secondsUntilNextCheck(): Promise<number> {
    const [r] = await query<{ secs: number }>(
      `SELECT extract(epoch FROM (next_check_at - now()))::float8 AS secs FROM source WHERE id = $1`,
      [sourceId]
    );
    return r.secs;
  }

  it('with no upcoming occurrence, schedules at the BASELINE (daily) interval', async () => {
    const due = await enqueueDueJobs(getPool());
    const mine = due.find((d) => d.id === sourceId);
    expect(mine, 'source is due and enqueued').toBeTruthy();
    expect(mine!.tier).toBe('baseline');
    const secs = await secondsUntilNextCheck();
    expect(secs).toBeGreaterThan(0.9 * DAY);
    expect(secs).toBeLessThanOrEqual(DAY + 1);
  });

  it('adding a near-term occurrence flips it to the NEAR_DATE (hourly) interval', async () => {
    // Change the source's effective tier purely via table data: give it an imminent occurrence.
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`${TAG} series`, sourceId]
    );
    seriesId = ser.id;
    await query(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc)
       VALUES ($1, $2, now() + interval '2 days')`,
      [seriesId, `${TAG} occ`]
    );

    await makeDueAgain();
    const due = await enqueueDueJobs(getPool());
    const mine = due.find((d) => d.id === sourceId);
    expect(mine!.tier).toBe('near_date');
    const secs = await secondsUntilNextCheck();
    expect(secs).toBeGreaterThan(0.5 * HOUR);
    expect(secs).toBeLessThanOrEqual(HOUR + 1);
  });

  it('setting ingestion_method=manual removes it from the scheduler entirely', async () => {
    await query(`UPDATE source SET ingestion_method = 'manual' WHERE id = $1`, [sourceId]);
    await makeDueAgain();
    const due = await enqueueDueJobs(getPool());
    expect(due.find((d) => d.id === sourceId)).toBeUndefined();
    // And next_check_at is left in the past (never advanced) because it was never enqueued.
    const secs = await secondsUntilNextCheck();
    expect(secs).toBeLessThan(0);
  });

  it('a disallowed terms_status source is never enqueued (gate)', async () => {
    await query(`UPDATE source SET terms_status = 'disallowed' WHERE id = $1`, [sourceId]);
    await makeDueAgain();
    const due = await enqueueDueJobs(getPool());
    expect(due.find((d) => d.id === sourceId)).toBeUndefined();
  });
});
