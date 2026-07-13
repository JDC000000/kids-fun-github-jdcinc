import { describe, it, expect, afterAll } from 'vitest';
import { query, closePool } from '../lib/db/client';

// G-T3-1 — age-band boundary test (TSD §6.2 BR-01/02, scope-to-task v1.1 §T3).
// Requires DATABASE_URL (migrations 0002-0007 + supabase/seeds/age_bands.sql
// already applied) — skipped when no DB is configured (e.g. plain `npm test`
// without a local Postgres). CI always sets DATABASE_URL (ci.yml).
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('age_band boundaries (G-T3-1)', () => {
  afterAll(async () => {
    await closePool();
  });

  async function bandForMonths(months: number): Promise<string | undefined> {
    const rows = await query<{ key: string }>(
      `SELECT key FROM age_band
       WHERE lower_months_inclusive <= $1
         AND (upper_months_exclusive IS NULL OR upper_months_exclusive > $1)`,
      [months]
    );
    return rows[0]?.key;
  }

  it('a 2-year-old (24 months) falls in the 2-4 band', async () => {
    expect(await bandForMonths(24)).toBe('2-4');
  });

  it('a 5-year-old (60 months) falls in the 5-9 band', async () => {
    expect(await bandForMonths(60)).toBe('5-9');
  });

  it('a 10-year-old (120 months) falls in the 10-14 band', async () => {
    expect(await bandForMonths(120)).toBe('10-14');
  });

  it('a 15-year-old (180 months) falls in the open-ended 15+ band', async () => {
    expect(await bandForMonths(180)).toBe('15+');
  });

  it('bands are non-overlapping (each month 0-240 maps to at most one band)', async () => {
    const overlapping = await query<{ month: number; matches: string }>(
      `SELECT m.month, count(*) AS matches
       FROM generate_series(0, 240) AS m(month)
       JOIN age_band ab
         ON ab.lower_months_inclusive <= m.month
        AND (ab.upper_months_exclusive IS NULL OR ab.upper_months_exclusive > m.month)
       GROUP BY m.month
       HAVING count(*) > 1`
    );
    expect(overlapping).toHaveLength(0);
  });
});
