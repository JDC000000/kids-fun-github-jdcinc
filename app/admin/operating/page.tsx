// app/admin/operating/page.tsx — the PRODUCT-HEALTH OPERATING dashboard (M7 / T41).
//
// The route a human actually runs the daily and monthly product-health review from.
// It is the fourth admin health surface and deliberately the one that spans the other
// three: product analytics (/admin/product-health), data health (/admin/data-health)
// and the ops console (/admin/dashboard) each answer one question well; the operating
// review needs all of them side by side, as TRENDS rather than snapshots, in a layout
// matched to the cadence being run. See docs/kpi-cadence.md for the review protocol
// this page is built to serve.
//
// WHY A NEW ROUTE, NOT MORE TILES ELSEWHERE: the canonical scope puts the operating
// view at app/admin/operating/, and the existing "one route per health concern"
// convention (dashboard / data-health / product-health) is what makes each surface
// legible. Nothing here forks a KPI: every number is computed by the canonical
// lib/analytics/kpi.ts · trends.ts · benchmark.ts · lib/admin/dashboard.ts ·
// data-health.ts implementations that T32/T33/T36 already built — this page adds the
// period bucketing, the trend read and the review layouts on top of them.
//
// ACCESS CONTROL: identical to /admin/dashboard, /admin/data-health and
// /admin/product-health — the shared choke point app/admin/_lib/gate.ts
// resolveAdminAccess() (real session/role primary, interim shared-secret token
// fallback). An un-gated caller gets a 404; the route's existence is not advertised.
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../_lib/gate';
import { getOperatingDashboardData } from '@/lib/admin/operating';
import { parseGrain, type OperatingGrain } from '@/lib/analytics/operating';
import { formatCount, formatTimestampUtc } from '@/lib/admin/format';
import { TrendChart } from '@/components/charts/TrendChart';
import type { TrendSeries } from '@/components/charts/types';
import {
  EmptyDatasetNotice,
  KpiTrendGrid,
  OperatingDetailTable,
  ReviewModeSwitch,
  SentryIssuePanel,
  countReviewablePeriods,
} from './trends';
import styles from './_components/Operating.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
export const metadata = {
  title: 'KIDS FUN — Admin / Operating review',
  robots: { index: false, follow: false },
};

/** Below this many days of real data, rate KPIs are labelled as directionally unreliable. */
const THIN_DATA_DAYS = 14;
/** A complete calendar month needs roughly this much history before it can exist. */
const MONTHLY_REVIEW_MIN_DAYS = 60;

/** Copy for the review mode, so the page states what the reviewer is looking at. */
function reviewCopy(grain: OperatingGrain): { title: string; blurb: string } {
  return grain === 'month'
    ? {
        title: 'Monthly review',
        blurb:
          'Month-by-month direction over the last 12 calendar months. Read this for whether the product is compounding — reach, activation, retention and account value — not for incident response.',
      }
    : {
        title: 'Daily review',
        blurb:
          'Day-by-day direction over the last 30 days. Read this for whether anything broke or moved sharply in the last 24 hours — errors, ingestion failures, zero-result spikes, correction reports.',
      };
}

export default async function AdminOperatingPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // --- admin access gate (identical to the other admin routes) -----------------
  const grant = await resolveAdminAccess({
    surface: 'admin_operating',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) {
    notFound(); // 404 — do not reveal that this route exists to un-gated callers.
  }

  const grain = parseGrain(searchParams.view);
  const data = await getOperatingDashboardData(grain);
  const copy = reviewCopy(grain);

  const { coverage, sourceFreshness, correctionsQueue, activeUserTrend } = data;
  // Counts ONLY buckets that could actually contain a measurement. Shared with the
  // detail table's own arithmetic so the header and the caption can never disagree.
  const completePeriods = countReviewablePeriods(data.periods);
  const dataIsThin = coverage.daysOfData < THIN_DATA_DAYS;
  const monthlyImpossible = grain === 'month' && coverage.daysOfData < MONTHLY_REVIEW_MIN_DAYS;

  // Rolling-window active-user + volume charts, reused verbatim from the canonical
  // T32 trend series (NOT recomputed here) so these lines and the /admin/product-health
  // ones can never disagree.
  const dates = activeUserTrend.points.map((p) => p.date);
  const activeUserSeries: TrendSeries[] = [
    { key: 'dau', label: 'DAU (24h)', colorVar: 'var(--kf-chart-1)', values: activeUserTrend.points.map((p) => p.dau) },
    {
      key: 'wau',
      label: `WAU (${activeUserTrend.windows.wauDays}d)`,
      colorVar: 'var(--kf-chart-2)',
      values: activeUserTrend.points.map((p) => p.wau),
    },
    {
      key: 'mau',
      label: `MAU (${activeUserTrend.windows.mauDays}d)`,
      colorVar: 'var(--kf-chart-3)',
      values: activeUserTrend.points.map((p) => p.mau),
    },
  ];
  const volumeSeries: TrendSeries[] = [
    {
      key: 'events',
      label: 'Events / day',
      colorVar: 'var(--kf-chart-1)',
      values: activeUserTrend.points.map((p) => p.events),
    },
  ];

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <nav className={styles.navRow} aria-label="Admin sections">
          <Link href="/admin/dashboard" className={styles.backLink}>
            ← Ops dashboard
          </Link>
          <Link href="/admin/product-health" className={styles.backLink}>
            Product health
          </Link>
          <Link href="/admin/data-health" className={styles.backLink}>
            Data health
          </Link>
        </nav>
        <h1 className={styles.pageTitle}>KIDS FUN — Operating review</h1>
        <p className={styles.sub}>
          Internal product-health operating view · read-only · every KPI as a trend, live from{' '}
          <span className={styles.mono}>analytics_event</span>, <span className={styles.mono}>correction_report</span>,{' '}
          <span className={styles.mono}>source_check_run</span> and Sentry. Generated{' '}
          {formatTimestampUtc(data.generatedAt)}.
        </p>

        <ReviewModeSwitch grain={grain} />

        <p className={styles.note}>
          🔒 Access gate: real role-based admin sign-in (session + admin role), with the interim shared-secret token
          retained only as a coexistence fallback. Review protocol — what to check, who reviews it, what escalates — is
          in <span className={styles.mono}>docs/kpi-cadence.md</span>.
        </p>

        {/* The data-thinness disclosure. This is a first-class part of the dashboard,
            not a caveat in a footnote: KIDS FUN launched 2026-07-21, so most rates
            here are currently computed over very small denominators and a reviewer
            must know that before acting on an arrow. */}
        {(dataIsThin || monthlyImpossible) && (
          <div className={styles.thinBanner} role="note">
            <strong>Read these numbers with the dataset in mind.</strong>{' '}
            {coverage.firstEventAt ? (
              <>
                There are <strong>{formatCount(coverage.daysOfData)} day(s)</strong> of analytics data (first event{' '}
                {formatTimestampUtc(coverage.firstEventAt)}) and {formatCount(coverage.totalEvents)} event(s) in total.
              </>
            ) : (
              // EMPTY-DATABASE BRANCH (H1 item 2) — copy lives next to the em-dash
              // rendering it describes, so the claim and the behaviour cannot drift
              // apart again. See EmptyDatasetNotice for the full account.
              <EmptyDatasetNotice />
            )}{' '}
            Rates computed over small denominators are directionally unreliable and are badged{' '}
            <strong>low sample</strong>. A KPI showing “—” has no data to state, which is not the same as 0.
            {monthlyImpossible && (
              <>
                {' '}
                <strong>This monthly view has no complete calendar month yet</strong>, so month-over-month direction
                will honestly read “not enough data” until one closes — that is correct behaviour, not a bug.
              </>
            )}
          </div>
        )}
      </header>

      <div className={styles.sections}>
        <section className={styles.section} aria-label={`${copy.title} KPIs`}>
          <h2 className={styles.sectionTitle}>
            {copy.title} · {completePeriods} complete {grain === 'month' ? 'month(s)' : 'day(s)'} + 1 in progress
          </h2>
          <p className={styles.hint}>{copy.blurb}</p>
          <p className={styles.hint}>
            Each headline number is the <strong>last complete period</strong>; the movement beside it compares that to
            the period before it. The still-running period is shown separately as “in progress” and is never used as a
            comparison endpoint — comparing a part-period against a whole one is the most common way a dashboard lies.
          </p>
          <KpiTrendGrid kpis={data.kpis} grain={grain} />
        </section>

        <section className={styles.section} aria-label="Production error trend">
          <h2 className={styles.sectionTitle}>Sentry — production issue trend</h2>
          <p className={styles.hint}>
            Unresolved issues and newly-appearing issues from the live Sentry project. This is the only panel on the
            page that reads from outside the database; if it cannot be read, it says so rather than showing zeros.
          </p>
          <SentryIssuePanel sentry={data.sentry} />
        </section>

        <section className={styles.section} aria-label="Active users and activity volume">
          <h2 className={styles.sectionTitle}>Active users · rolling windows, last {activeUserTrend.days} days</h2>
          <p className={styles.hint}>
            Distinct active actors (<span className={styles.mono}>user_or_session</span>) in each rolling window as of
            every day, plus daily activity volume. These are the same canonical series{' '}
            <Link href="/admin/product-health">/admin/product-health</Link> plots — one computation, two surfaces.
          </p>
          <div className={styles.chartGrid}>
            <div className={styles.chartCard}>
              <TrendChart
                title="Active users"
                caption={`DAU (24h) · WAU (${activeUserTrend.windows.wauDays}d) · MAU (${activeUserTrend.windows.mauDays}d) — distinct actors`}
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

        <section className={styles.section} aria-label="Live queue and freshness state">
          <h2 className={styles.sectionTitle}>Live state · corrections queue and source freshness</h2>
          <p className={styles.hint}>
            Point-in-time depth to pair with the trends above — both reused verbatim from{' '}
            <Link href="/admin/data-health">/admin/data-health</Link>.
          </p>
          <div className={styles.panel}>
            <div className={styles.panelStats}>
              <div className={styles.panelStat}>
                <span className={styles.panelStatLabel}>Open corrections</span>
                <span className={styles.panelStatValue}>{formatCount(correctionsQueue.openCount)}</span>
              </div>
              <div className={styles.panelStat}>
                <span className={styles.panelStatLabel}>In review</span>
                <span className={styles.panelStatValue}>{formatCount(correctionsQueue.inReviewCount)}</span>
              </div>
              <div className={styles.panelStat}>
                <span className={styles.panelStatLabel}>Unresolved total</span>
                <span className={styles.panelStatValue}>{formatCount(correctionsQueue.unresolvedCount)}</span>
              </div>
              <div className={styles.panelStat}>
                <span className={styles.panelStatLabel}>Oldest open</span>
                <span className={styles.panelStatValue}>{formatTimestampUtc(correctionsQueue.oldestOpenAt)}</span>
              </div>
              <div className={styles.panelStat}>
                <span className={styles.panelStatLabel}>Sources within cadence</span>
                <span className={styles.panelStatValue}>
                  {sourceFreshness.adherencePct == null ? '—' : `${sourceFreshness.adherencePct}%`}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section} aria-label="Per-period detail">
          <h2 className={styles.sectionTitle}>Detail · every counter, per period</h2>
          <p className={styles.hint}>
            The text twin of every sparkline above — no value on this page is reachable only by looking at a line. Copy
            the top row into the review note the cadence doc asks for.
          </p>
          <OperatingDetailTable counts={data.counts} ops={data.opsCounts} grain={grain} anchors={data.anchors} />
        </section>
      </div>

      <footer className={styles.foot}>
        Read-only operating view · every number is live from the database (or explicitly marked unavailable) · no data
        is modified by this page.
      </footer>
    </main>
  );
}
