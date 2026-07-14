// tests/admin/dashboard-data.test.ts — admin dashboard data layer (DB-gated).
// Skips when DATABASE_URL is unset (mirrors tests/admin_guard.test.ts). Asserts the
// SHAPE and read-only invariants rather than exact counts, so it passes against an
// empty CI database or a populated staging one.
import { describe, it, expect, afterAll } from 'vitest';
import {
  ENABLED_TERMS_STATUS,
  getAdminDashboardData,
  getAnalyticsSummary,
  getIngestionHealth,
  getSourceRegistrySummary,
} from '../../lib/admin/dashboard';
import { closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('admin dashboard data layer', () => {
  afterAll(async () => {
    await closePool();
  });

  it('registry summary returns consistent non-negative totals', async () => {
    const r = await getSourceRegistrySummary();
    expect(r.totalSources).toBeGreaterThanOrEqual(0);
    expect(r.enabledSources).toBeGreaterThanOrEqual(0);
    expect(r.enabledSources).toBeLessThanOrEqual(r.totalSources);
  });

  it('ingestion health only returns enabled sources, with sane counts', async () => {
    const rows = await getIngestionHealth();
    for (const s of rows) {
      expect(s.termsStatus).toBe(ENABLED_TERMS_STATUS);
      expect(s.seriesCount).toBeGreaterThanOrEqual(0);
      expect(s.occurrenceCount).toBeGreaterThanOrEqual(0);
      expect(typeof s.name).toBe('string');
    }
  });

  it('analytics summary is internally consistent', async () => {
    const a = await getAnalyticsSummary();
    expect(a.totalEvents).toBeGreaterThanOrEqual(0);
    expect(a.listingViewed).toBeGreaterThanOrEqual(0);
    expect(a.listingViewed).toBeLessThanOrEqual(a.totalEvents);
    const summed = a.byType.reduce((n, r) => n + r.count, 0);
    expect(summed).toBe(a.totalEvents);
  });

  it('assembles the full dashboard payload', async () => {
    const data = await getAdminDashboardData();
    expect(Number.isNaN(Date.parse(data.generatedAt))).toBe(false);
    expect(data.registry.enabledSources).toBe(data.ingestion.length);
  });
});
