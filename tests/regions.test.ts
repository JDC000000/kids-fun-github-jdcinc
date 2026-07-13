import { describe, it, expect, afterAll } from 'vitest';
import { query, closePool } from '../lib/db/client';

// G-T3-2 — region hierarchy seed verification (TSD §5B BR-07/08).
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('region hierarchy (G-T3-2)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('Vancouver has at least 2 child sub-areas', async () => {
    const rows = await query<{ n: string }>(
      `SELECT count(*) AS n
       FROM region child
       JOIN region parent ON parent.id = child.parent_id
       WHERE parent.name = 'Vancouver' AND child.level = 'sub_area'`
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2);
  });

  it('all seeded regions have a non-null centroid', async () => {
    const rows = await query<{ n: string }>(`SELECT count(*) AS n FROM region WHERE centroid IS NULL`);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('Metro Vancouver is the root (no parent)', async () => {
    const rows = await query<{ name: string }>(
      `SELECT name FROM region WHERE level = 'metro' AND parent_id IS NULL`
    );
    expect(rows.map((r) => r.name)).toContain('Metro Vancouver');
  });
});
