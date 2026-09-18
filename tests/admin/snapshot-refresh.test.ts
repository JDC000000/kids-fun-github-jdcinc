// tests/admin/snapshot-refresh.test.ts — the refresh job's CONTRACT, with the builders mocked.
//
// What is pinned here is not "does it compute the right KPI" (the canonical suites already own
// every KPI definition, and this job deliberately re-expresses none of them). It is the job's
// OPERATIONAL behaviour, which has no other home:
//   • a failing key must not cost a healthy key its refresh, or its previously good row;
//   • the keys must be built ONE AT A TIME, because concurrency is what broke the pages;
//   • the widened budget must be in force while a payload is built, and only then.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ANALYTICS_QUERY_TIMEOUT_MS, ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS, adminAnalyticsQueryTimeoutMs } from '../../lib/db/budgets';

const writes: { key: string; payload: string; computeMs: number; sourceRows: number | null }[] = [];
let failKeys = new Set<string>();
/** Budget observed INSIDE each builder, keyed by the snapshot it was building. */
const budgetSeen: Record<string, number> = {};
/** Append-only log of builder start/stop, to prove serialisation. */
const order: string[] = [];

vi.mock('@/lib/db/client', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    if (/INSERT INTO admin_dashboard_snapshot/.test(sql)) {
      writes.push({
        key: String(params?.[0]),
        payload: String(params?.[1]),
        computeMs: Number(params?.[2]),
        sourceRows: params?.[3] == null ? null : Number(params?.[3]),
      });
      return [];
    }
    return [];
  }),
  queryWithTimeout: vi.fn(async (sql: string) => {
    if (/count\(\*\)::bigint AS n FROM analytics_event/.test(sql)) return [{ n: '2965374' }];
    return [];
  }),
}));

/** One mocked builder: records the in-force budget, logs its span, optionally throws. */
function builder(name: string) {
  return vi.fn(async () => {
    budgetSeen[name] = adminAnalyticsQueryTimeoutMs();
    order.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, 5));
    order.push(`end:${name}`);
    if (failKeys.has(name)) throw new Error(`${name} exploded`);
    return { built: name };
  });
}

vi.mock('@/lib/admin/operating', () => ({
  getOperatingDashboardData: vi.fn(async (grain: string) => {
    const name = grain === 'month' ? 'operating:month:12' : 'operating:day:30';
    return builder(name)();
  }),
}));
vi.mock('@/lib/admin/dashboard', () => ({ getAdminDashboardData: () => builder('dashboard')() }));
vi.mock('@/lib/analytics/kpi', () => ({ getProductHealthKpis: async () => ({ kpi: true }) }));
vi.mock('@/lib/analytics/trends', () => ({ getActivityTrend: async () => ({ trend: true }) }));
vi.mock('@/lib/analytics/benchmark', () => ({ getFlagshipQueryStats: async () => ({ flagship: true }) }));

const { refreshAllSnapshots, refreshSnapshot } = await import('../../lib/admin/snapshot-refresh');
const { ADMIN_SNAPSHOT_KEYS, ALL_ADMIN_SNAPSHOT_KEYS } = await import('../../lib/admin/snapshot');

beforeEach(() => {
  writes.length = 0;
  order.length = 0;
  failKeys = new Set();
  for (const k of Object.keys(budgetSeen)) delete budgetSeen[k];
});

describe('refreshSnapshot', () => {
  it('stores the payload the builder returned, verbatim', async () => {
    const result = await refreshSnapshot(ADMIN_SNAPSHOT_KEYS.operatingDay, 2_965_374);
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe(ADMIN_SNAPSHOT_KEYS.operatingDay);
    expect(JSON.parse(writes[0].payload)).toEqual({ built: 'operating:day:30' });
    expect(writes[0].sourceRows).toBe(2_965_374);
  });

  it('builds under the WIDENED budget, not the page budget', async () => {
    // The page ceiling (45s) is below getEngagementSeries' measured 70,462 ms, so under it this
    // job could never build the payload that exists to stop the page paying that cost.
    await refreshSnapshot(ADMIN_SNAPSHOT_KEYS.operatingDay, null);
    expect(budgetSeen['operating:day:30']).toBe(ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS);
  });

  it('does not leave the widened budget in force afterwards', async () => {
    await refreshSnapshot(ADMIN_SNAPSHOT_KEYS.operatingDay, null);
    expect(adminAnalyticsQueryTimeoutMs()).toBe(ADMIN_ANALYTICS_QUERY_TIMEOUT_MS);
  });

  it('WRITES NOTHING when the build fails, so the previous good row survives', async () => {
    // ═══ THE PROPERTY THAT MAKES A STALE DASHBOARD SAFE ═══
    // Yesterday's numbers labelled "22h ago" beat an empty dashboard. That only holds if a
    // failed refresh cannot clear the row — i.e. if the write never happens on the error path.
    failKeys.add('operating:day:30');
    const result = await refreshSnapshot(ADMIN_SNAPSHOT_KEYS.operatingDay, null);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exploded/);
    expect(writes).toHaveLength(0);
  });

  it('reports a failure instead of throwing', async () => {
    // refreshAllSnapshots depends on this to isolate keys; a throw here would abort the loop.
    failKeys.add('dashboard');
    await expect(refreshSnapshot(ADMIN_SNAPSHOT_KEYS.dashboard, null)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('refreshAllSnapshots', () => {
  it('builds every key and reports the tally', async () => {
    const result = await refreshAllSnapshots();
    expect(result.failed).toBe(0);
    expect(result.refreshed).toBe(ALL_ADMIN_SNAPSHOT_KEYS.length);
    expect(writes.map((w) => w.key).sort()).toEqual([...ALL_ADMIN_SNAPSHOT_KEYS].sort());
  });

  it('builds them SEQUENTIALLY, never overlapping', async () => {
    // ═══ CONCURRENCY IS WHAT BROKE THE PAGES ═══
    // Measured 2026-09-18: getDataCoverage costs 1,157 ms alone and 38,337 ms inside
    // /admin/operating's nine-way Promise.all, because each read scans substantially the whole
    // 1,298 MB heap against 256 MB of shared_buffers and they evict one another. A future
    // "optimisation" to Promise.all this loop would make the job slower AND turn it into a load
    // spike on the instance serving the product. The interleaving is the assertion.
    await refreshAllSnapshots();
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].startsWith('start:'), `order: ${order.join(',')}`).toBe(true);
      expect(order[i + 1]).toBe(order[i].replace('start:', 'end:'));
    }
  });

  it('one failing key costs only itself', async () => {
    failKeys.add('operating:day:30');
    const result = await refreshAllSnapshots();
    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(ALL_ADMIN_SNAPSHOT_KEYS.length - 1);
    expect(writes.map((w) => w.key)).not.toContain(ADMIN_SNAPSHOT_KEYS.operatingDay);
    expect(writes.map((w) => w.key)).toContain(ADMIN_SNAPSHOT_KEYS.operatingMonth);
  });

  it('honours an explicit subset of keys', async () => {
    const result = await refreshAllSnapshots([ADMIN_SNAPSHOT_KEYS.dashboard]);
    expect(result.refreshed).toBe(1);
    expect(writes.map((w) => w.key)).toEqual([ADMIN_SNAPSHOT_KEYS.dashboard]);
  });

  it('records the source row count as provenance on every key', async () => {
    const result = await refreshAllSnapshots();
    expect(result.sourceRows).toBe(2_965_374);
    for (const w of writes) expect(w.sourceRows).toBe(2_965_374);
  });
});
