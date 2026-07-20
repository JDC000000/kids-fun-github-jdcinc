// tests/corrections/retention.test.ts — the correction_report retention job REALLY
// deletes expired rows, against real Postgres. DB-gated (skipped without DATABASE_URL,
// like the analytics + email suites). Proves F-6's fix: past-retention corrections are
// purged on a job run, fresh rows are untouched, dry-run deletes nothing, the batched
// delete drains, and a normally-written row gets the ~6-month DB-default window.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../../lib/db/client';
import { purgeExpiredCorrectionReports } from '../../lib/corrections/retention';
import { writeCorrectionReport } from '../../lib/corrections/report';

const hasDb = Boolean(process.env.DATABASE_URL);

/** correction_report.occurrence_id is a NOT NULL FK → activity_occurrence, so every
 *  test row needs a real occurrence. One minimal source→series→occurrence chain is
 *  enough for the whole suite (all reports point at the same occurrence). */
let occurrenceId = '';
let seriesId = '';
let sourceId = '';

/** Insert a correction_report row with an explicit retained_until offset (days from now),
 *  tagged via `reporter` so a test only ever asserts on / deletes its own rows. */
async function insertReport(tag: string, retainedOffsetDays: number): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO correction_report (occurrence_id, reporter, issue_type, retained_until)
       VALUES ($1, $2, 'wrong_info', now() + ($3 || ' days')::interval)
     RETURNING id`,
    [occurrenceId, tag, String(retainedOffsetDays)]
  );
  return row.id;
}

async function countByTag(tag: string, onlyExpired = false): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM correction_report
      WHERE reporter = $1 ${onlyExpired ? 'AND retained_until < now()' : ''}`,
    [tag]
  );
  return Number(rows[0]?.n ?? '0');
}

describe.skipIf(!hasDb)('purgeExpiredCorrectionReports (real Postgres)', () => {
  let tag = '';

  beforeAll(async () => {
    const [src] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, ingestion_method)
         VALUES ('test_corr_retention', 'Corr Retention Test Source', 'official', 'auto') RETURNING id`
    );
    sourceId = src.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ('Corr Retention Series', $1) RETURNING id`,
      [sourceId]
    );
    seriesId = ser.id;
    const [occ] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, confidence_label)
         VALUES ($1, 'Corr Retention Listing', '2026-12-01T18:00:00Z', 'needs_review', 'unscored') RETURNING id`,
      [seriesId]
    );
    occurrenceId = occ.id;
  });

  beforeEach(() => {
    tag = `corr-ret-test-${randomUUID().slice(0, 8)}`;
  });

  afterAll(async () => {
    // Best-effort cleanup of the test-tagged rows + the FK fixture chain, then close.
    try {
      await query(`DELETE FROM correction_report WHERE reporter LIKE 'corr-ret-test-%'`);
      if (occurrenceId) await query(`DELETE FROM correction_report WHERE occurrence_id = $1`, [occurrenceId]);
      if (occurrenceId) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [occurrenceId]);
      if (seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [seriesId]);
      if (sourceId) await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
    } finally {
      await closePool();
    }
  });

  it('DRY-RUN counts expired rows but deletes nothing', async () => {
    await insertReport(tag, -10); // expired 10 days ago
    await insertReport(tag, -1); // expired yesterday
    await insertReport(tag, 100); // fresh

    const res = await purgeExpiredCorrectionReports({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.deleted).toBe(0);
    expect(res.expired).toBeGreaterThanOrEqual(2);
    // Nothing was actually removed.
    expect(await countByTag(tag)).toBe(3);
    expect(await countByTag(tag, true)).toBe(2);
  });

  it('REAL run deletes ONLY rows past retained_until, keeping fresh rows', async () => {
    await insertReport(tag, -30);
    await insertReport(tag, -0.001); // just expired
    const freshId = await insertReport(tag, 200);

    const res = await purgeExpiredCorrectionReports({ dryRun: false });
    expect(res.dryRun).toBe(false);
    expect(res.deleted).toBeGreaterThanOrEqual(2);

    // My expired rows are gone; my fresh row survives.
    expect(await countByTag(tag, true)).toBe(0);
    expect(await countByTag(tag)).toBe(1);
    const survivors = await query<{ id: string }>(
      `SELECT id FROM correction_report WHERE reporter = $1`,
      [tag]
    );
    expect(survivors.map((r) => r.id)).toEqual([freshId]);
  });

  it('drains MORE expired rows than one batch (batched delete loops to completion)', async () => {
    for (let i = 0; i < 5; i++) await insertReport(tag, -5);
    expect(await countByTag(tag, true)).toBe(5);

    const res = await purgeExpiredCorrectionReports({ dryRun: false, batchSize: 2 });
    expect(res.deleted).toBeGreaterThanOrEqual(5);
    expect(res.batches).toBeGreaterThanOrEqual(3); // ceil(5/2) = 3 batches minimum
    expect(await countByTag(tag, true)).toBe(0);
  });

  it('the audit line reports the configured retention window in days', async () => {
    const res = await purgeExpiredCorrectionReports({ dryRun: true });
    expect(typeof res.retentionDays).toBe('number');
    expect(res.retentionDays).toBe(183); // ~6 months; must match migration 0020's DB DEFAULT
  });

  it('a normally-written correction (no retained_until set) gets the ~6-month DB default', async () => {
    // Exercises the REAL write path (writeCorrectionReport omits retained_until — the
    // column DEFAULT is the single source of truth for the window; migration 0020).
    const write = await writeCorrectionReport({
      occurrenceId,
      issueType: 'wrong_info',
      note: null,
      reporter: tag,
    });
    expect(write.ok).toBe(true);

    const [row] = await query<{ within_window: boolean }>(
      `SELECT (retained_until > now() + interval '5 months'
               AND retained_until < now() + interval '7 months') AS within_window
         FROM correction_report WHERE id = $1`,
      [write.id]
    );
    expect(row.within_window).toBe(true);
  });
});
