// tests/llm/watermark-db.test.ts — the incremental watermark (real Postgres, DB-gated):
// advancing moves the high-watermark; a non-advancing run does not; and the SQL predicate
// correctly excludes records changed before the watermark.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../../lib/db/client';
import { advanceWatermark, recordNonAdvancingRun, watermarkPredicate } from '../../lib/llm/watermark';

const hasDb = Boolean(process.env.DATABASE_URL);
const JOB = `vv-wm-${randomUUID().slice(0, 8)}`;

async function readRun() {
  const [row] = await query<{ last_watermark: string; last_status: string; records_considered: number }>(
    `SELECT last_watermark::text AS last_watermark, last_status, records_considered FROM llm_batch_run WHERE job_name = $1`,
    [JOB]
  );
  return row;
}

describe.skipIf(!hasDb)('llm batch watermark (real Postgres)', () => {
  beforeEach(async () => {
    await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB]);
  });
  afterAll(async () => {
    try {
      await query(`DELETE FROM llm_batch_run WHERE job_name = $1`, [JOB]);
    } finally {
      await closePool();
    }
  });

  it('advanceWatermark upserts the high-watermark + stats', async () => {
    await advanceWatermark(JOB, '2026-07-20T00:00:00.000Z', { considered: 5, actioned: 2, status: 'ok' });
    let row = await readRun();
    expect(new Date(row.last_watermark).toISOString()).toBe('2026-07-20T00:00:00.000Z');
    expect(row.last_status).toBe('ok');
    expect(Number(row.records_considered)).toBe(5);

    // A later run advances it further.
    await advanceWatermark(JOB, '2026-07-21T00:00:00.000Z', { considered: 3, actioned: 0 });
    row = await readRun();
    expect(new Date(row.last_watermark).toISOString()).toBe('2026-07-21T00:00:00.000Z');
  });

  it('recordNonAdvancingRun updates stats/status but leaves the watermark unmoved', async () => {
    await advanceWatermark(JOB, '2026-07-20T00:00:00.000Z', { considered: 5, actioned: 2 });
    await recordNonAdvancingRun(JOB, 'dry_run', { considered: 9, actioned: 0 });
    const row = await readRun();
    expect(new Date(row.last_watermark).toISOString()).toBe('2026-07-20T00:00:00.000Z'); // unchanged
    expect(row.last_status).toBe('dry_run');
    expect(Number(row.records_considered)).toBe(9);
  });

  it('watermarkPredicate is true before the watermark passes a record, false after', async () => {
    const [src] = await query<{ id: string }>(`INSERT INTO source (family, name) VALUES ('vvtest', $1) RETURNING id`, [`${JOB}-src`]);
    const [ser] = await query<{ id: string }>(`INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`, [`${JOB}`, src.id]);
    const [occ] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state) VALUES ($1, 'x', now(), 'needs_review') RETURNING id`,
      [ser.id]
    );

    const probe = async () => {
      const [r] = await query<{ fresh: boolean }>(
        `SELECT (${watermarkPredicate('o', 1)}) AS fresh FROM activity_occurrence o WHERE o.id = $2`,
        [JOB, occ.id]
      );
      return r.fresh;
    };

    expect(await probe()).toBe(true); // no watermark row yet → '-infinity'
    await advanceWatermark(JOB, '2999-01-01T00:00:00.000Z', { considered: 1, actioned: 0 }); // watermark in the far future
    expect(await probe()).toBe(false); // record now sits before the watermark

    // cleanup
    await query(`DELETE FROM activity_occurrence WHERE id = $1`, [occ.id]);
    await query(`DELETE FROM activity_series WHERE id = $1`, [ser.id]);
    await query(`DELETE FROM source WHERE id = $1`, [src.id]);
  });
});
