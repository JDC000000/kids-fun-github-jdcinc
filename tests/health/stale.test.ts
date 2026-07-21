// tests/health/stale.test.ts — G-T15-4 occurrence-level stale detection.
//  • PURE: isOccurrenceStale (grace × cadence, strict boundary).
//  • DB: flipStaleOccurrences demotes past-cadence live occurrences to 'stale' and leaves
//    fresh / human-terminal / never-checked ones alone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isOccurrenceStale,
  flipStaleOccurrences,
  countStaleOccurrences,
  STALE_CADENCE_GRACE,
} from '../../worker/health/stale';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = Date.parse('2026-07-20T12:00:00Z');
const DAY = 86_400;
const agoMs = (s: number): number => NOW - s * 1000;

describe('isOccurrenceStale (pure)', () => {
  it('stale when last check older than grace × cadence', () => {
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(3 * DAY), cadenceSeconds: DAY }, NOW)).toBe(true);
  });
  it('fresh within grace', () => {
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(DAY), cadenceSeconds: DAY }, NOW)).toBe(false);
  });
  it('strict boundary exactly at grace × cadence is NOT yet stale', () => {
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(STALE_CADENCE_GRACE * DAY), cadenceSeconds: DAY }, NOW)).toBe(false);
  });
  it('a never-checked occurrence is not stale', () => {
    expect(isOccurrenceStale({ lastCheckedAtMs: null, cadenceSeconds: DAY }, NOW)).toBe(false);
  });
  it('scales with a weekly cadence', () => {
    const week = 7 * DAY;
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(10 * DAY), cadenceSeconds: week }, NOW)).toBe(false); // <14d
    expect(isOccurrenceStale({ lastCheckedAtMs: agoMs(20 * DAY), cadenceSeconds: week }, NOW)).toBe(true); // >14d
  });
  it('STALE_CADENCE_GRACE matches the source-level dashboard grace (2)', () => {
    expect(STALE_CADENCE_GRACE).toBe(2);
  });
});

describe.skipIf(!hasDb)('flipStaleOccurrences (DB)', () => {
  const TAG = `t15stale_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sourceId = '';
  let seriesId = '';
  const occ = { fresh: '', stale: '', cancelled: '', seasonalActive: '', noCheck: '' };

  async function mkOcc(name: string, status: string, lastCheckedDaysAgo: number | null): Promise<string> {
    const lc = lastCheckedDaysAgo == null ? 'NULL' : `now() - interval '${lastCheckedDaysAgo} days'`;
    const [r] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, last_checked_at)
       VALUES ($1, $2, now() + interval '5 days', $3::status_state, ${lc}) RETURNING id`,
      [seriesId, name, status]
    );
    return r.id;
  }

  beforeAll(async () => {
    const [s] = await query<{ id: string }>(
      // terms_status='allowed': mkOcc seeds 'confirmed' occurrences (later flipped to stale),
      // which the 0021 write-time invariant permits only for a terms-approved source.
      `INSERT INTO source (family, name, baseline_cadence, terms_status) VALUES ('noop', $1, '1 day', 'allowed') RETURNING id`,
      [`${TAG} src`]
    );
    sourceId = s.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`${TAG} series`, sourceId]
    );
    seriesId = ser.id;
    // cadence = 1 day, grace = 2 → threshold 2 days.
    occ.fresh = await mkOcc(`${TAG} fresh`, 'confirmed', 0); // checked ~now → fresh
    occ.stale = await mkOcc(`${TAG} stale`, 'confirmed', 3); // 3d > 2d → stale
    occ.cancelled = await mkOcc(`${TAG} cancelled`, 'cancelled', 5); // not demotable
    occ.seasonalActive = await mkOcc(`${TAG} seasonal`, 'seasonal_active', 5); // demotable → stale
    occ.noCheck = await mkOcc(`${TAG} nocheck`, 'confirmed', null); // never checked → not stale
  });

  afterAll(async () => {
    for (const id of Object.values(occ)) if (id) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [id]);
    if (seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [seriesId]);
    if (sourceId) await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
    await closePool();
  });

  async function statusOf(id: string): Promise<string> {
    const [r] = await query<{ status_state: string }>(`SELECT status_state FROM activity_occurrence WHERE id = $1`, [id]);
    return r.status_state;
  }

  it('flips only the past-cadence, live-status occurrences to stale', async () => {
    const result = await flipStaleOccurrences(getPool());
    expect(result.flipped).toContain(occ.stale);
    expect(result.flipped).toContain(occ.seasonalActive);
    expect(result.flipped).not.toContain(occ.fresh);
    expect(result.flipped).not.toContain(occ.cancelled);
    expect(result.flipped).not.toContain(occ.noCheck);

    expect(await statusOf(occ.stale)).toBe('stale');
    expect(await statusOf(occ.seasonalActive)).toBe('stale');
    expect(await statusOf(occ.fresh)).toBe('confirmed');
    expect(await statusOf(occ.cancelled)).toBe('cancelled'); // human-terminal untouched
    expect(await statusOf(occ.noCheck)).toBe('confirmed');
  });

  it('countStaleOccurrences includes the freshly-flipped rows and is idempotent', async () => {
    const before = await countStaleOccurrences(getPool());
    expect(before.staleCount).toBeGreaterThanOrEqual(2);
    // Re-running the flip is a no-op (already stale, and 'stale' is not in the demote-from set).
    const again = await flipStaleOccurrences(getPool());
    expect(again.flipped).not.toContain(occ.stale);
  });
});
