-- 0050_admin_dashboard_snapshot.sql — precomputed admin-dashboard payloads, so a review
-- surface stops re-deriving 2.9M rows on every page load.
--
-- WHY THIS TABLE EXISTS. Measured on production 2026-09-18, analytics_event = 2,965,374 rows
-- / 1,298 MB heap, growing 65–93K rows/day:
--
--   /admin/operating   (day,30 — the default)   45,820 ms   FAILED (two reads hit the 45s budget)
--   /admin/operating   (month,12)               ~45,000 ms  FAILED
--   /admin/product-health                       19,394 ms
--   /admin/dashboard                            16,775 ms
--
-- and the individual reads, standalone, with the budget lifted:
--
--   getEngagementSeries(day,30)   70,462 ms   ← over the page budget ON ITS OWN
--   getLifecycleSeries(day,30)    15,369 ms
--   getActiveUsers                 9,444 ms
--   getAccountCounts               8,207 ms
--
-- ═══ WHY CACHING, AND NOT A DATE BOUND (THE OBVIOUS ANSWER, MEASURED AND REJECTED) ═══
-- On 2026-09-14 /admin/dashboard's widgets were date-bounded and /admin/operating deliberately
-- was NOT, because its 30-day/12-month windows are its actual review grain and a blind bound
-- there corrupts the numbers under an unchanged label (MAU measured 74% understated). That call
-- still holds, and today's row distribution shows a bound would not even buy speed:
--
--   rows in the last 30 days = 2,964,728 of 2,965,374 = 99.98% OF THE TABLE.
--
-- The review window IS the whole table, so there is no bound to apply — the only way to stop
-- paying for the scan on the request path is to stop doing it on the request path.
--
-- ═══ WHY A WHOLE-PAYLOAD CACHE AND NOT A PER-METRIC ROLLUP ═══
-- A rollup that re-derives monthly figures by summing daily ones silently breaks every
-- distinct-actor and retention metric here (an actor active on 12 days is 1 MAU, not 12), which
-- is the same class of error as the bound above. This table instead stores WHAT THE CANONICAL
-- FUNCTIONS ALREADY COMPUTE, verbatim and per (grain, periods) key, so no KPI is re-expressed
-- and no number can drift from the definition the code owns. Cheaper to verify, and the
-- honesty properties in lib/analytics/operating.ts keep holding for free.
CREATE TABLE IF NOT EXISTS admin_dashboard_snapshot (
  -- Which payload this is: 'operating:day:30', 'operating:month:12', 'dashboard',
  -- 'product-health'. Grain and period count are IN the key because they change the numbers —
  -- one row per thing a reader can actually ask for. See ADMIN_SNAPSHOT_KEYS in
  -- lib/admin/snapshot.ts for the single source of truth.
  key          text        PRIMARY KEY,

  -- The assembled payload exactly as the page's data function returned it.
  payload      jsonb       NOT NULL,

  -- When the numbers were computed — NOT when the row was written. The page renders this, so a
  -- reader is never shown a stale figure that looks live. This is the whole reason a cache is
  -- acceptable on a review surface: the staleness is stated, not hidden.
  computed_at  timestamptz NOT NULL DEFAULT now(),

  -- How long the computation took. Kept because this table exists to make a measured problem go
  -- away, and the next person deserves to see whether it still is one without re-instrumenting.
  compute_ms   integer     NOT NULL,

  -- analytics_event's row count at compute time. Provenance for the figure above: 70s at 2.9M
  -- rows and 70s at 20M rows are very different facts about this system.
  source_rows  bigint,

  CONSTRAINT admin_dashboard_snapshot_compute_ms_sane CHECK (compute_ms >= 0),
  CONSTRAINT admin_dashboard_snapshot_source_rows_sane CHECK (source_rows IS NULL OR source_rows >= 0)
);

-- No index beyond the primary key ON PURPOSE. Every read is `WHERE key = $1` (one row, by PK)
-- and the table holds one row per dashboard view — four today. An index on computed_at would be
-- larger than the gain on a four-row table.
COMMENT ON TABLE admin_dashboard_snapshot IS
  'Precomputed /admin/* dashboard payloads, refreshed by POST /api/admin/snapshot/refresh/run. '
  'Page loads read this instead of re-scanning analytics_event (99.98% of which falls inside the '
  '30-day review window, so no date bound can help). Derived data only: safe to TRUNCATE, the '
  'next refresh rebuilds it.';

-- ── default-deny, same posture as every table since 0018 ────────────────────────────────────
-- RLS ON with NO policies = reachable by the service role only. The app never uses the public
-- REST surface and this table is not a reason to start.
--
-- It matters slightly more here than for an ordinary cache, which is worth saying out loud:
-- these payloads are the ASSEMBLED ADMIN DASHBOARDS. Individually the figures are aggregates,
-- but one row carries the whole operating review — DAU/WAU/MAU, retention, sign-in counts,
-- ingestion health, the corrections queue and the Sentry trend — in a single readable object.
-- That is exactly the surface app/admin/_lib/gate.ts exists to put behind an admin check, so
-- leaving it fetchable by `anon` would route around that gate completely.
ALTER TABLE admin_dashboard_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_dashboard_snapshot FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS admin_dashboard_snapshot;
--   (Derived data only — dropping it costs nothing but a slow first page load until the next
--   scheduled refresh rebuilds it.)
