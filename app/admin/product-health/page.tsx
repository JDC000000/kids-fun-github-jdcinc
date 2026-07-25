// app/admin/product-health/page.tsx — dedicated PRODUCT-health dashboard (M5 / T32).
//
// The canonical /admin/product-health route: the product-analytics story — launch
// target-vs-actual benchmarks (G-T32-5) and DAU/WAU/MAU + activity-volume trend
// charts (G-T32-6) — as its own surface, a deliberate sibling of /admin/data-health
// (which owns the DATA-pipeline health story). Round 16's KPI *snapshot* tiles stay
// on /admin/dashboard untouched; this route adds the over-time + target view and
// cross-links back. Every number is a live SELECT from analytics_event (read-only —
// this page never writes).
//
// WHY A NEW ROUTE (not more tiles on /admin/dashboard): the canonical scope doc puts
// the benchmark tile under app/admin/product-health/, and /admin/data-health already
// establishes the "one route per health concern" pattern — so product-health (KPIs,
// benchmarks, trends) as its own cohesive route matches precedent and keeps the ops
// dashboard from sprawling. See the round findings doc for the full rationale.
//
// ACCESS CONTROL (G-T34-1): identical to /admin/dashboard and /admin/data-health —
// the shared choke point app/admin/_lib/gate.ts resolveAdminAccess() (real session/
// role primary, interim shared-secret token fallback). An un-gated caller gets a 404;
// the route's existence is not advertised.
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../_lib/gate';
import { getProductHealthKpis } from '@/lib/analytics/kpi';
import { getActivityTrend } from '@/lib/analytics/trends';
import {
  buildFlagshipBenchmarks,
  buildKpiBenchmarks,
  getFlagshipQueryStats,
} from '@/lib/analytics/benchmark';
import { TrendChart } from '@/components/charts/TrendChart';
import type { TrendSeries } from '@/components/charts/types';
import { BenchmarkTile } from './tiles/benchmark';
import styles from './_components/ProductHealth.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
export const metadata = {
  title: 'KIDS FUN — Admin / Product health',
  robots: { index: false, follow: false },
};

const fmtCount = (n: number) => n.toLocaleString('en-CA');

export default async function AdminProductHealthPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // --- admin access gate (G-T34-1, identical to the other admin routes) --------
  const grant = await resolveAdminAccess({
    surface: 'admin_product_health',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) {
    notFound(); // 404 — do not reveal that this route exists to un-gated callers.
  }

  // All reads run concurrently; every one is SELECT-only against analytics_event.
  const [kpis, trend, flagship] = await Promise.all([
    getProductHealthKpis(),
    getActivityTrend(),
    getFlagshipQueryStats(),
  ]);

  const kpiRows = buildKpiBenchmarks(kpis);
  const flagshipRows = buildFlagshipBenchmarks(flagship);

  const dates = trend.points.map((p) => p.date);
  const activeUserSeries: TrendSeries[] = [
    { key: 'dau', label: 'DAU (24h)', colorVar: 'var(--kf-chart-1)', values: trend.points.map((p) => p.dau) },
    {
      key: 'wau',
      label: `WAU (${trend.windows.wauDays}d)`,
      colorVar: 'var(--kf-chart-2)',
      values: trend.points.map((p) => p.wau),
    },
    {
      key: 'mau',
      label: `MAU (${trend.windows.mauDays}d)`,
      colorVar: 'var(--kf-chart-3)',
      values: trend.points.map((p) => p.mau),
    },
  ];
  const volumeSeries: TrendSeries[] = [
    { key: 'events', label: 'Events / day', colorVar: 'var(--kf-chart-1)', values: trend.points.map((p) => p.events) },
  ];

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <nav className={styles.navRow} aria-label="Admin sections">
          <Link href="/admin/dashboard" className={styles.backLink}>
            ← Ops dashboard
          </Link>
          <Link href="/admin/data-health" className={styles.backLink}>
            Data health
          </Link>
          <Link href="/admin/operating" className={styles.backLink}>
            Operating review
          </Link>
        </nav>
        <h1 className={styles.pageTitle}>KIDS FUN — Product health</h1>
        <p className={styles.sub}>
          Internal product-analytics view · read-only · target-vs-actual benchmarks and DAU/WAU/MAU trends, live from{' '}
          <span className={styles.mono}>analytics_event</span>.
        </p>
        <p className={styles.note}>
          🔒 Access gate: real role-based admin sign-in (session + admin role), with the interim shared-secret token
          retained only as a coexistence fallback. The current-window KPI snapshot tiles live on{' '}
          <Link href="/admin/dashboard">/admin/dashboard</Link>; this page adds the over-time and target view.
        </p>
      </header>

      <div className={styles.sections}>
        <BenchmarkTile kpiRows={kpiRows} flagship={flagship} flagshipRows={flagshipRows} />

        <section className={styles.section} aria-label="Active-user and activity trends">
          <h2 className={styles.sectionTitle}>Trends · last {fmtCount(trend.days)} days</h2>
          <p className={styles.hint}>
            Distinct active actors (<span className={styles.mono}>user_or_session</span>) in each rolling window as of
            every day, plus daily activity volume. Hover or focus the chart for a specific day; every value is also in
            the data table under each chart.
          </p>

          <div className={styles.chartGrid}>
            <div className={styles.chartCard}>
              <TrendChart
                title="Active users"
                caption={`DAU (24h) · WAU (${trend.windows.wauDays}d) · MAU (${trend.windows.mauDays}d) — distinct actors`}
                x={dates}
                series={activeUserSeries}
              />
            </div>
            <div className={styles.chartCard}>
              <TrendChart
                title="Activity volume"
                caption="All analytics_event rows recorded per day"
                x={dates}
                series={volumeSeries}
                area
              />
            </div>
          </div>
        </section>
      </div>

      <footer className={styles.foot}>
        Read-only product-health view · numbers are live from the database · no data is modified by this page.
      </footer>
    </main>
  );
}
