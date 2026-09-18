// lib/admin/snapshot.ts — the READ side of the precomputed admin dashboards.
//
// One table (migration 0050), one row per dashboard view, read by primary key. The refresh
// side lives in snapshot-refresh.ts and is deliberately a separate module: the pages import
// THIS one, and nothing a page imports should be able to start a 3-minute computation.
//
// WHY THE PAGES READ A SNAPSHOT AT ALL — the measured case is in 0050's header and in
// lib/db/budgets.ts. Short version: 99.98% of analytics_event falls inside /admin/operating's
// 30-day review window, so there is no date bound to apply, and the page's two heaviest reads
// cost 70s and 15s standalone against a 45s budget. The page does not load. Moving the work
// off the request path is the only shape that fixes it without re-expressing a single KPI.
import { queryWithTimeout } from '@/lib/db/client';

/**
 * The snapshot keys, and the ONLY place their spelling is decided.
 *
 * Grain and period count are part of the key because they change the numbers — `operating:day:30`
 * and `operating:month:12` are different answers, not different renderings of one answer. A page
 * asking for a grain nobody precomputed must find NOTHING rather than the wrong row, which is
 * what {@link operatingSnapshotKey} returning a plain string (and the caller handling null)
 * gives us.
 */
export const ADMIN_SNAPSHOT_KEYS = {
  operatingDay: 'operating:day:30',
  operatingMonth: 'operating:month:12',
  dashboard: 'dashboard',
  productHealth: 'product-health',
} as const;

export type AdminSnapshotKey = (typeof ADMIN_SNAPSHOT_KEYS)[keyof typeof ADMIN_SNAPSHOT_KEYS];

/** Every key the refresh job builds, in the order it builds them. */
export const ALL_ADMIN_SNAPSHOT_KEYS: readonly AdminSnapshotKey[] = [
  ADMIN_SNAPSHOT_KEYS.operatingDay,
  ADMIN_SNAPSHOT_KEYS.operatingMonth,
  ADMIN_SNAPSHOT_KEYS.dashboard,
  ADMIN_SNAPSHOT_KEYS.productHealth,
];

/**
 * The snapshot key for an operating view, or `null` when that view is not one of the
 * precomputed ones.
 *
 * ═══ NULL IS THE LOAD-BEARING CASE ═══
 * /admin/operating accepts `?periods=` up to MAX_PERIODS (36), so a reader can ask for a
 * combination no cache holds. Returning the nearest key would answer a question nobody asked
 * — 36 periods of data presented under a 30-period label. So an off-menu request gets `null`,
 * and the page then says it has no snapshot rather than showing the wrong one.
 */
export function operatingSnapshotKey(grain: 'day' | 'month', periods: number): AdminSnapshotKey | null {
  if (grain === 'day' && periods === 30) return ADMIN_SNAPSHOT_KEYS.operatingDay;
  if (grain === 'month' && periods === 12) return ADMIN_SNAPSHOT_KEYS.operatingMonth;
  return null;
}

/**
 * A snapshot read back out, with the provenance the page is required to render.
 *
 * `computedAt` is not decoration. A cached dashboard that does not say when it was computed is
 * strictly worse than a slow one, because a stale number and a live number look identical.
 */
export interface AdminSnapshot<T> {
  payload: T;
  /** When the numbers were computed (ISO 8601). */
  computedAt: string;
  /** Whole seconds since the numbers were computed, at read time. */
  ageSeconds: number;
  /** How long the computation itself took. */
  computeMs: number;
  /** analytics_event row count when it was computed, or null if it was not recorded. */
  sourceRows: number | null;
}

/**
 * The budget for reading a snapshot: one row, by primary key, from a table with one row per
 * dashboard. This is a different KIND of read from the ones the rest of this directory makes,
 * and it gets a budget that says so — if a four-row PK lookup ever takes two seconds, the
 * honest outcome is an error naming this read, not a page that waits 45s for it.
 */
export const SNAPSHOT_READ_TIMEOUT_MS = 2_000;

interface SnapshotRow {
  payload: unknown;
  computed_at: Date | string;
  compute_ms: number;
  source_rows: string | number | null;
}

/**
 * Read one precomputed payload, or `null` when it has never been built.
 *
 * `null` covers two genuinely different situations that the CALLER must not conflate with a
 * third: "the refresh job has not run yet" and "this view is not precomputed" both land here,
 * and neither is "the numbers are all zero". Every caller renders an explicit notice for null;
 * none of them substitutes an empty payload, because a dashboard of confident zeroes is the
 * exact failure this codebase keeps legislating against.
 *
 * A missing TABLE is also `null` rather than a throw (undefined_table, 42P01): the page must
 * still render on a database where migration 0050 has not been applied yet — that is the
 * ordinary state of every environment between deploy and migrate, and of the unit-test lane.
 */
export async function readAdminSnapshot<T>(key: AdminSnapshotKey): Promise<AdminSnapshot<T> | null> {
  let rows: SnapshotRow[];
  try {
    rows = await queryWithTimeout<SnapshotRow>(
      `SELECT payload, computed_at, compute_ms, source_rows
         FROM admin_dashboard_snapshot
        WHERE key = $1`,
      [key],
      SNAPSHOT_READ_TIMEOUT_MS
    );
  } catch (err) {
    if ((err as { code?: string })?.code === '42P01') return null;
    throw err;
  }

  const row = rows[0];
  if (!row) return null;

  const computedMs = new Date(row.computed_at).getTime();
  if (!Number.isFinite(computedMs)) return null;

  return {
    payload: row.payload as T,
    computedAt: new Date(computedMs).toISOString(),
    // Clamped at 0: a snapshot computed microseconds ago on a machine whose clock differs
    // slightly from the database's must not render as "-3 seconds old".
    ageSeconds: Math.max(0, Math.floor((Date.now() - computedMs) / 1000)),
    computeMs: row.compute_ms,
    sourceRows: row.source_rows == null ? null : Number(row.source_rows),
  };
}

/**
 * Human-readable age, for the "as of" line every page that reads a snapshot must render.
 * Deliberately coarse — the reader needs to know whether this is minutes or days old, and a
 * false precision ("2h 14m 33s") invites treating a cache as live.
 */
export function describeSnapshotAge(ageSeconds: number): string {
  if (ageSeconds < 90) return 'just now';
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(ageSeconds / 3_600);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(ageSeconds / 86_400)}d ago`;
}

/**
 * A payload plus where it came from.
 *
 * `computedAt`/`age` are null when the payload was computed on this request. Callers render
 * that distinction; see {@link snapshotOrCompute}.
 */
export interface SnapshotOrLive<T> {
  payload: T;
  /** Set only when the payload came from the cache. */
  computedAt: string | null;
  /** Coarse human age, set only when the payload came from the cache. */
  age: string | null;
}

/**
 * Read a snapshot, or compute the payload live if none has been stored.
 *
 * ═══ WHY THIS HAS A LIVE FALLBACK AND /admin/operating DOES NOT ═══
 * This is not an inconsistency, it is the measurement. Falling back to a live computation is
 * only honest when the live computation can actually finish:
 *
 *   /admin/dashboard        16,775 ms   succeeds  → fallback is a slow page
 *   /admin/product-health   19,394 ms   succeeds  → fallback is a slow page
 *   /admin/operating        45,820 ms   FAILS     → fallback is a hang, then a 500
 *
 * For the first two, a cache miss should cost the reader time and nothing else. For the third,
 * an automatic fallback would re-run the 70s read that the snapshot exists to avoid, on the
 * very request unlucky enough to arrive during a cold cache — so that page states the miss
 * instead, and keeps the live path behind an explicit `?live=1`.
 *
 * Re-measure before extending the fallback to a new page. The honest default for a read that
 * cannot make its budget is to say so, not to try anyway.
 */
export async function snapshotOrCompute<T>(
  key: AdminSnapshotKey,
  compute: () => Promise<T>
): Promise<SnapshotOrLive<T>> {
  const snapshot = await readAdminSnapshot<T>(key);
  if (snapshot) {
    return {
      payload: snapshot.payload,
      computedAt: snapshot.computedAt,
      age: describeSnapshotAge(snapshot.ageSeconds),
    };
  }
  return { payload: await compute(), computedAt: null, age: null };
}
