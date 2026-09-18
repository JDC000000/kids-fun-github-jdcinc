// tests/admin/snapshot-store-db.test.ts — the snapshot store against REAL Postgres.
//
// The mocked suite (snapshot-refresh.test.ts) pins the job's control flow; this one pins the
// things only a real database can answer: that the jsonb round-trip is lossless, that the
// upsert is genuinely an upsert, and that the read is the cheap primary-key lookup the pages
// are now relying on rather than something that merely looks like one.
//
// DB-gated like its siblings (skipped without DATABASE_URL). It owns its own rows by key
// prefix and never truncates the table, so it cannot disturb a real snapshot if this is
// pointed at a populated database.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../../lib/db/client';
import {
  readAdminSnapshot,
  snapshotOrCompute,
  type AdminSnapshotKey,
} from '../../lib/admin/snapshot';

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

// Deliberately NOT one of the real keys: this suite must never overwrite a production payload
// if someone runs it against a populated database. Cast because the store is key-typed.
const TEST_KEY = 'test:snapshot-store-db' as AdminSnapshotKey;
const MISSING_KEY = 'test:never-written' as AdminSnapshotKey;

async function put(key: string, payload: unknown, computeMs = 42, sourceRows: number | null = 7) {
  await query(
    `INSERT INTO admin_dashboard_snapshot (key, payload, computed_at, compute_ms, source_rows)
     VALUES ($1, $2::jsonb, now(), $3, $4)
     ON CONFLICT (key) DO UPDATE
       SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at,
           compute_ms = EXCLUDED.compute_ms, source_rows = EXCLUDED.source_rows`,
    [key, JSON.stringify(payload), computeMs, sourceRows]
  );
}

d('admin_dashboard_snapshot store', () => {
  beforeEach(async () => {
    await query(`DELETE FROM admin_dashboard_snapshot WHERE key LIKE 'test:%'`);
  });
  afterAll(async () => {
    await query(`DELETE FROM admin_dashboard_snapshot WHERE key LIKE 'test:%'`);
    await closePool();
  });

  it('returns null for a key that was never written', async () => {
    // Not an empty payload. A dashboard of confident zeroes is the failure this avoids.
    expect(await readAdminSnapshot(MISSING_KEY)).toBeNull();
  });

  it('round-trips a nested payload losslessly', async () => {
    // The real payloads are deep: arrays of period buckets, nulls that MEAN "not measurable"
    // (never 0), ISO timestamps. A null that came back as 0 would turn "nothing to measure"
    // into "measured zero" — the exact distinction lib/analytics/prehistory.ts exists to keep.
    const payload = {
      generatedAt: '2026-09-18T20:00:00.000Z',
      grain: 'day',
      periods: [{ period: '2026-09-17', label: '2026-09-17', partial: false, preHistory: false }],
      kpis: [{ key: 'retention', value: null, sample: 0, nested: { deep: [1, null, 'x'] } }],
      coverage: { firstEventAt: null, daysOfData: 0, totalEvents: 0 },
    };
    await put(TEST_KEY, payload);
    const got = await readAdminSnapshot<typeof payload>(TEST_KEY);
    expect(got).not.toBeNull();
    expect(got!.payload).toEqual(payload);
    // Specifically: null survived as null, and did not become 0 or undefined.
    expect(got!.payload.kpis[0].value).toBeNull();
    expect(got!.payload.coverage.firstEventAt).toBeNull();
  });

  it('reports provenance: computedAt, computeMs, sourceRows and a non-negative age', async () => {
    await put(TEST_KEY, { a: 1 }, 70_462, 2_965_374);
    const got = await readAdminSnapshot<{ a: number }>(TEST_KEY);
    expect(got!.computeMs).toBe(70_462);
    // bigint comes back from pg as a string; the store must hand the page a number.
    expect(got!.sourceRows).toBe(2_965_374);
    expect(typeof got!.sourceRows).toBe('number');
    expect(got!.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(Date.parse(got!.computedAt)).toBeGreaterThan(0);
  });

  it('keeps exactly one row per key across repeated writes, and serves the newest', async () => {
    await put(TEST_KEY, { version: 'first' }, 1);
    await put(TEST_KEY, { version: 'second' }, 2);
    const rows = await query<{ n: string }>(
      `SELECT count(*)::int AS n FROM admin_dashboard_snapshot WHERE key = $1`,
      [TEST_KEY]
    );
    expect(Number(rows[0].n)).toBe(1);
    const got = await readAdminSnapshot<{ version: string }>(TEST_KEY);
    expect(got!.payload.version).toBe('second');
  });

  it('rejects a negative compute_ms at the database level', async () => {
    // The CHECK constraint is the backstop for a clock going backwards mid-refresh; a negative
    // duration would render as a nonsense provenance figure on the page.
    await expect(put(TEST_KEY, { a: 1 }, -1)).rejects.toThrow();
  });

  it('accepts a null source_rows (the count is provenance, not a gate)', async () => {
    await put(TEST_KEY, { a: 1 }, 5, null);
    const got = await readAdminSnapshot<{ a: number }>(TEST_KEY);
    expect(got!.sourceRows).toBeNull();
  });

  it('snapshotOrCompute prefers the stored payload and does NOT compute', async () => {
    await put(TEST_KEY, { from: 'cache' });
    let computed = false;
    const got = await snapshotOrCompute<{ from: string }>(TEST_KEY, async () => {
      computed = true;
      return { from: 'live' };
    });
    expect(computed).toBe(false);
    expect(got.payload.from).toBe('cache');
    expect(got.age).not.toBeNull();
    expect(got.computedAt).not.toBeNull();
  });

  it('snapshotOrCompute falls back to computing, and says the result is live', async () => {
    const got = await snapshotOrCompute<{ from: string }>(MISSING_KEY, async () => ({ from: 'live' }));
    expect(got.payload.from).toBe('live');
    // Null age is how the page knows to render "computed live" instead of a staleness notice.
    expect(got.age).toBeNull();
    expect(got.computedAt).toBeNull();
  });

  it('reads by INDEX, not by scanning — the page load depends on it', async () => {
    // The pages traded a 45s scan for this read. If it ever became a sequential scan over a
    // table that grows a row per dashboard view, the trade would quietly erode.
    await put(TEST_KEY, { a: 1 });
    const plan = await query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT payload, computed_at, compute_ms, source_rows
         FROM admin_dashboard_snapshot WHERE key = $1`,
      [TEST_KEY]
    );
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan/);
  });
});
