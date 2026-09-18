// lib/admin/snapshot-refresh.ts — the WRITE side of the precomputed admin dashboards.
//
// Runs off the request path, on a schedule (POST /api/admin/snapshot/refresh/run). Computes
// each dashboard payload with THE SAME canonical functions the pages used to call directly,
// and stores the result verbatim in admin_dashboard_snapshot.
//
// ═══ THE ONE RULE THIS MODULE HAS ═══
// It does not compute a KPI. It calls the function that already owns that KPI's definition and
// writes down what came back. Every per-metric shortcut available here — summing days into
// months, bounding a window, reusing one grain's actors for another — breaks a distinct-actor
// or retention figure while leaving its label intact, which is the specific failure mode this
// project has now hit twice (see migration 0050's header, and the 2026-09-14 entry: MAU 74%
// understated under an unchanged label). A cache that re-derives is not a cache.
import { getOperatingDashboardData } from './operating';
import { getAdminDashboardData } from './dashboard';
import { getProductHealthKpis } from '@/lib/analytics/kpi';
import { getActivityTrend } from '@/lib/analytics/trends';
import { getFlagshipQueryStats } from '@/lib/analytics/benchmark';
import { query, queryWithTimeout } from '@/lib/db/client';
import {
  ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS,
  adminAnalyticsQueryTimeoutMs,
  withQueryBudget,
} from '@/lib/db/budgets';
import {
  ADMIN_SNAPSHOT_KEYS,
  ALL_ADMIN_SNAPSHOT_KEYS,
  type AdminSnapshotKey,
} from './snapshot';

/** What one key's refresh did. Counts and timings only — never payload contents. */
export interface SnapshotRefreshResult {
  key: AdminSnapshotKey;
  ok: boolean;
  computeMs: number;
  /** Short message when ok is false. Present only on failure. */
  error?: string;
}

export interface RefreshAllResult {
  refreshed: number;
  failed: number;
  totalMs: number;
  sourceRows: number | null;
  results: SnapshotRefreshResult[];
}

/**
 * The builders, keyed exactly as the table is.
 *
 * `product-health` assembles the same three reads the page's own `Promise.all` does, in one
 * object, because the page needs all three or none — caching two of them would just move the
 * slow third onto the request path and leave the page as slow as it was.
 */
const BUILDERS: Record<AdminSnapshotKey, () => Promise<unknown>> = {
  [ADMIN_SNAPSHOT_KEYS.operatingDay]: () => getOperatingDashboardData('day', 30),
  [ADMIN_SNAPSHOT_KEYS.operatingMonth]: () => getOperatingDashboardData('month', 12),
  [ADMIN_SNAPSHOT_KEYS.dashboard]: async () => {
    const [data, kpis] = await Promise.all([getAdminDashboardData(), getProductHealthKpis()]);
    return { data, kpis };
  },
  [ADMIN_SNAPSHOT_KEYS.productHealth]: async () => {
    const [kpis, trend, flagship] = await Promise.all([
      getProductHealthKpis(),
      getActivityTrend(),
      getFlagshipQueryStats(),
    ]);
    return { kpis, trend, flagship };
  },
};

/**
 * analytics_event's row count, recorded alongside each payload as provenance.
 *
 * Failure here is NOT failure of the refresh: this number explains a compute time, it does not
 * gate one. A null `source_rows` column is explicitly allowed by 0050 for exactly this reason.
 */
async function countSourceRows(): Promise<number | null> {
  try {
    const rows = await queryWithTimeout<{ n: string }>(
      `SELECT count(*)::bigint AS n FROM analytics_event`,
      undefined,
      adminAnalyticsQueryTimeoutMs()
    );
    const n = Number(rows[0]?.n);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Rebuild ONE snapshot.
 *
 * ═══ WHY THE WRITE IS A SINGLE UPSERT AND NOT DELETE-THEN-INSERT ═══
 * A reader between the two statements of a delete-then-insert sees NO snapshot, and this
 * codebase treats a missing snapshot as "never computed" and renders a notice. So a refresh
 * would make every concurrent page load flash an "unavailable" state. The upsert replaces the
 * row atomically; a reader sees either the old numbers or the new ones, never neither.
 */
export async function refreshSnapshot(
  key: AdminSnapshotKey,
  sourceRows: number | null
): Promise<SnapshotRefreshResult> {
  const startedAt = Date.now();
  try {
    // The page budget (45s) is the wrong ceiling for work nobody is waiting on, and it is
    // below the standalone cost of getEngagementSeries (70,462 ms measured 2026-09-18) — so
    // under the page budget this job could never build the very payload that exists to stop
    // the page paying that cost. See withQueryBudget's contract in lib/db/budgets.ts.
    const payload = await withQueryBudget(ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS, () => BUILDERS[key]());
    const computeMs = Date.now() - startedAt;

    await query(
      `INSERT INTO admin_dashboard_snapshot (key, payload, computed_at, compute_ms, source_rows)
       VALUES ($1, $2::jsonb, now(), $3, $4)
       ON CONFLICT (key) DO UPDATE
         SET payload     = EXCLUDED.payload,
             computed_at = EXCLUDED.computed_at,
             compute_ms  = EXCLUDED.compute_ms,
             source_rows = EXCLUDED.source_rows`,
      [key, JSON.stringify(payload), computeMs, sourceRows]
    );

    return { key, ok: true, computeMs };
  } catch (err) {
    // ═══ A FAILED KEY MUST NOT DESTROY THE PREVIOUS GOOD ONE ═══
    // Nothing is written on this path, so the existing row survives untouched. Yesterday's
    // numbers, honestly labelled "22h ago", beat an empty dashboard — and the route reports
    // the failure so the staleness is visible as a failure rather than inferred from a date.
    return {
      key,
      ok: false,
      computeMs: Date.now() - startedAt,
      error: (err as Error)?.message?.slice(0, 200) ?? 'snapshot refresh failed',
    };
  }
}

/**
 * Rebuild every snapshot, SEQUENTIALLY.
 *
 * ═══ SEQUENTIAL IS THE WHOLE POINT, NOT A MISSED OPTIMISATION ═══
 * Running these concurrently is what broke the pages. Measured on production 2026-09-18:
 * getDataCoverage costs 1,157 ms alone and 38,337 ms inside /admin/operating's nine-way
 * `Promise.all`, because each of those reads scans substantially the whole 1,298 MB heap
 * against 256 MB of shared_buffers and they evict one another. Concurrency here would make
 * this job slower AND make it a self-inflicted load spike on the same instance serving the
 * product. One at a time, the buffers it warms are the buffers the next one wants.
 */
export async function refreshAllSnapshots(
  keys: readonly AdminSnapshotKey[] = ALL_ADMIN_SNAPSHOT_KEYS
): Promise<RefreshAllResult> {
  const startedAt = Date.now();
  const sourceRows = await countSourceRows();

  const results: SnapshotRefreshResult[] = [];
  for (const key of keys) {
    results.push(await refreshSnapshot(key, sourceRows));
  }

  return {
    refreshed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    totalMs: Date.now() - startedAt,
    sourceRows,
    results,
  };
}
