// tests/admin/dashboard-data.test.ts — admin dashboard data layer (DB-gated).
// Skips when DATABASE_URL is unset (mirrors tests/admin_guard.test.ts). Asserts the
// SHAPE and read-only invariants rather than exact counts, so it passes against an
// empty CI database or a populated staging one.
import { describe, it, expect, afterAll } from 'vitest';
import {
  ENABLED_TERMS_STATUS,
  ATTENTION_RUN_LIMIT,
  ATTENTION_RUN_WINDOW_DAYS,
  getAdminDashboardData,
  getAnalyticsSummary,
  getHealthAlerts,
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
    expect(a.searchPerformed).toBeGreaterThanOrEqual(0);
    expect(a.searchPerformed).toBeLessThanOrEqual(a.totalEvents);
    const summed = a.byType.reduce((n, r) => n + r.count, 0);
    expect(summed).toBe(a.totalEvents);
  });

  it('search-analytics rollups have a sane shape', async () => {
    const a = await getAnalyticsSummary();
    for (const r of a.topQueryTerms) {
      expect(typeof r.term).toBe('string');
      expect(r.term.length).toBeGreaterThanOrEqual(3);
      expect(r.count).toBeGreaterThan(0);
    }
    for (const r of a.topSearchRegions) {
      expect(typeof r.region).toBe('string');
      expect(r.count).toBeGreaterThan(0);
    }
    for (const r of a.topSearchFilters) {
      expect(typeof r.filter).toBe('string');
      expect(r.count).toBeGreaterThan(0);
    }
    // A per-term/region/filter count can never exceed the number of searches.
    for (const r of a.topSearchRegions) expect(r.count).toBeLessThanOrEqual(a.searchPerformed);
    for (const r of a.topSearchFilters) expect(r.count).toBeLessThanOrEqual(a.searchPerformed);
  });

  it('health alerts have a sane shape and respect the window/limit', async () => {
    const a = await getHealthAlerts();
    expect(a.windowDays).toBe(ATTENTION_RUN_WINDOW_DAYS);
    expect(a.runsNeedingAttention.length).toBeLessThanOrEqual(ATTENTION_RUN_LIMIT);
    for (const f of a.runsNeedingAttention) {
      expect(typeof f.checkRunId).toBe('string');
      expect(typeof f.sourceName).toBe('string');
      expect(typeof f.family).toBe('string');
      if (f.errorSummary !== null) expect(typeof f.errorSummary).toBe('string');
      if (f.errorCount !== null) expect(f.errorCount).toBeGreaterThanOrEqual(1);
      // F-11: every row is here for exactly one of two reasons — it failed, or it raised a
      // health verdict. A row that is neither means the panel's filter has drifted.
      expect(f.status === 'failed' || f.healthAlertCode !== null).toBe(true);
      if (f.healthAlertCode !== null) expect(f.healthAlertCode.length).toBeGreaterThan(0);
    }
    for (const s of a.staleSources) {
      // Only enabled sources can be stale.
      expect(typeof s.name).toBe('string');
      // A stale source either never succeeded (but ran) or has an old last success.
      expect(s.lastSuccessAt === null || typeof s.lastSuccessAt === 'string').toBe(true);
    }
  });

  it('assembles the full dashboard payload', async () => {
    const data = await getAdminDashboardData();
    expect(Number.isNaN(Date.parse(data.generatedAt))).toBe(false);
    expect(data.registry.enabledSources).toBe(data.ingestion.length);
    expect(data.alerts.windowDays).toBe(ATTENTION_RUN_WINDOW_DAYS);
    expect(Array.isArray(data.alerts.runsNeedingAttention)).toBe(true);
    expect(Array.isArray(data.alerts.staleSources)).toBe(true);
  });
});
