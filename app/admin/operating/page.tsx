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
// resolveAdminAccess() (a signed-in admin session; no token path). An un-gated caller gets a 404; the route's existence is not advertised.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveAdminAccess } from '../_lib/gate';
import { getOperatingDashboardData } from '@/lib/admin/operating';
import { describeSnapshotAge, operatingSnapshotKey, readAdminSnapshot } from '@/lib/admin/snapshot';
import { ConnectionAcquireError, QueryTimeoutError } from '@/lib/db/client';
import { defaultPeriods, parseGrain, type OperatingGrain } from '@/lib/analytics/operating';
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
  const grant = await resolveAdminAccess({ surface: 'admin_operating' });
  if (!grant.ok) {
    notFound(); // 404 — do not reveal that this route exists to un-gated callers.
  }

  const grain = parseGrain(searchParams.view);
  const copy = reviewCopy(grain);

  // ═══ A PANEL THAT CANNOT MAKE ITS BUDGET IS NOT A 500 ═══
  // Every read behind this page now runs under ADMIN_ANALYTICS_QUERY_TIMEOUT_MS, which
  // exists to stop an abandoned request leaving multi-minute scans holding pooled
  // connections (see lib/db/client.ts). The ceiling firing is therefore an EXPECTED
  // outcome on the heaviest reads, not an exception — and letting it reach Next's generic
  // error boundary turns a known, named, self-describing limit back into an anonymous 500
  // that a reader has to go to Sentry to identify. Which is the shape the original
  // `terminating connection due to administrator command` report arrived in.
  //
  // TWO failure modes are handled here, and only two. Both are outcomes this page is DESIGNED
  // to produce under load; anything else is a genuine fault and still belongs on the error
  // boundary with its stack intact.
  //
  //   QueryTimeoutError      — a read ran and exceeded its ceiling.
  //   ConnectionAcquireError — a read never started, because this page asks for TWELVE
  //                            connections at once, more than the pool holds.
  //
  // The second one is not the exotic case. getOperatingDashboardData fans 12 concurrent
  // requests (getOperatingPeriodCounts 3 + getProductHealthKpis 3 + 6 singleton reads), so
  // some queue by construction and waiting out the acquire window is ordinary. An
  // earlier version of this block caught only QueryTimeoutError, which left the MORE likely
  // failure falling through to an anonymous 500 — the exact thing this block exists to stop.
  // ═══ THIS PAGE READS A PRECOMPUTED SNAPSHOT. IT DOES NOT COMPUTE THE REVIEW. ═══
  // Measured on production 2026-09-18 (analytics_event = 2,965,374 rows, +65–93K/day), the
  // reads this review needs cost 70,462 ms and 15,369 ms STANDALONE — the first one alone is
  // over the 45s per-query ceiling, so the live path below cannot succeed at any concurrency
  // and the page did not load at all. It is not slow; it is unserveable on the request path.
  //
  // And it cannot be fixed by narrowing the window, which was the obvious move and was checked
  // first: 2,964,728 of 2,965,374 rows (99.98%) fall inside the 30-day review window. There is
  // no bound to apply. The 2026-09-14 decision NOT to date-bound this page therefore still
  // stands on correctness grounds AND would buy nothing on speed.
  //
  // So the work moved off the request path to a schedule (POST /api/admin/snapshot/refresh/run)
  // and this page reads the result: one row, by primary key. The numbers are the SAME numbers —
  // the refresh job calls getOperatingDashboardData verbatim, it does not re-derive a KPI — and
  // the page states when they were computed, because a cached figure that does not say so is
  // worse than a slow one.
  //
  // `?live=1` keeps the old behaviour available for verification. It is not a fallback and is
  // deliberately not automatic: silently attempting a 70s read on a cache miss would reproduce
  // the exact hang this page is being fixed for, on the exact request that found it missing.
  const wantsLive = searchParams.live === '1';
  const snapshotKey = operatingSnapshotKey(grain, defaultPeriods(grain));
  let snapshotAge: string | null = null;
  let snapshotComputedAt: string | null = null;

  if (!wantsLive && snapshotKey) {
    const snapshot = await readAdminSnapshot<Awaited<ReturnType<typeof getOperatingDashboardData>>>(
      snapshotKey
    );
    if (!snapshot) {
      return (
        <main className={styles.page}>
          <h1>{copy.title}</h1>
          <p role="alert">
            <strong>No snapshot has been computed yet.</strong> This review is precomputed on a
            schedule rather than on page load, and no run has stored a{' '}
            <span className={styles.mono}>{snapshotKey}</span> payload yet.
          </p>
          <p>
            Trigger one with an authorised{' '}
            <span className={styles.mono}>POST /api/admin/snapshot/refresh/run</span>, or{' '}
            <Link href={`/admin/operating?view=${grain}&live=1`}>compute it live instead</Link> —
            which is expected to take over a minute and may not finish, which is the reason this
            page is precomputed.
          </p>
        </main>
      );
    }
    snapshotAge = describeSnapshotAge(snapshot.ageSeconds);
    snapshotComputedAt = snapshot.computedAt;
    return renderReview({ data: snapshot.payload, grain, copy, snapshotAge, snapshotComputedAt });
  }

  let data: Awaited<ReturnType<typeof getOperatingDashboardData>>;
  try {
    data = await getOperatingDashboardData(grain);
  } catch (err) {
    const timedOutRunning = err instanceof QueryTimeoutError;
    const neverStarted = err instanceof ConnectionAcquireError;
    if (!timedOutRunning && !neverStarted) throw err;
    return (
      <main className={styles.page}>
        <h1>{copy.title}</h1>
        <p role="alert">
          <strong>This review could not be computed.</strong>{' '}
          {timedOutRunning
            ? `One of its reads exceeded the ${(err as QueryTimeoutError).timeoutMs}ms per-query
               ceiling and was cancelled.`
            : `One of its reads never got a database connection — the pool was fully occupied
               for the whole ${(err as ConnectionAcquireError).timeoutMs}ms acquire window.`}{' '}
          Either way the numbers below would have been incomplete, and an incomplete operating
          review is worse than none, because nothing on the page would say which parts were
          missing.
        </p>
        <p>
          These limits are database guards, not page budgets: without them an abandoned request
          leaves its scans running for minutes and holds connections the rest of the product
          needs. Nothing is broken — this review&rsquo;s reads are simply expensive for the
          volume of analytics data now held, and the fix is on the read side, not here.
        </p>
      </main>
    );
  }

  // The live path renders through the SAME function as the snapshot path — one renderer, so a
  // number cannot be formatted one way when cached and another way when computed. It passes no
  // snapshot provenance, which is how the renderer knows to describe itself as live.
  return renderReview({ data, grain, copy, snapshotAge: null, snapshotComputedAt: null });
}

/**
 * The review renderer, shared by the precomputed and the `?live=1` paths.
 *
 * Split out so the two paths cannot drift: this page's whole value is that the numbers on it
 * are trustworthy, and "the cached view formats this differently" is exactly the kind of
 * divergence that erodes that without ever looking like a bug.
 *
 * `snapshotAge`/`snapshotComputedAt` are null on the live path and set on the cached one, and
 * the renderer STATES WHICH IT IS. That is not cosmetic: a cached dashboard that presents
 * itself as live is a worse artefact than a slow one.
 */
function renderReview({
  data,
  grain,
  copy,
  snapshotAge,
  snapshotComputedAt,
}: {
  data: Awaited<ReturnType<typeof getOperatingDashboardData>>;
  grain: OperatingGrain;
  copy: { title: string; blurb: string };
  snapshotAge: string | null;
  snapshotComputedAt: string | null;
}) {
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
          Internal product-health operating view · read-only · every KPI as a trend, drawn from{' '}
          <span className={styles.mono}>analytics_event</span>, <span className={styles.mono}>correction_report</span>,{' '}
          <span className={styles.mono}>source_check_run</span> and Sentry. Computed{' '}
          {formatTimestampUtc(data.generatedAt)}.
        </p>
        {/* ═══ THE PAGE SAYS WHICH KIND OF NUMBER IT IS SHOWING ═══
            A precomputed review is fine for a daily/monthly review cadence, and a precomputed
            review that looks live is not. So the staleness is stated in words, next to the
            numbers, on every cached render — never left to be inferred from a timestamp the
            reader would have to compare against the clock themselves. */}
        {snapshotAge ? (
          <p className={styles.sub}>
            <strong>Precomputed snapshot · {snapshotAge}.</strong> These numbers were computed on
            a schedule, not when this page was opened, because computing them takes over a minute
            against the current volume of{' '}
            <span className={styles.mono}>analytics_event</span>. They are the same numbers the
            live path produces — the refresh job calls the same code — but they are as of{' '}
            {snapshotComputedAt ? formatTimestampUtc(snapshotComputedAt) : 'the time shown above'}
            , not as of now.{' '}
            <Link href={`/admin/operating?view=${grain}&live=1`}>Recompute live</Link> (slow, and
            may exceed its ceiling).
          </p>
        ) : (
          <p className={styles.sub}>
            <strong>Computed live, on this request.</strong> This is the{' '}
            <span className={styles.mono}>?live=1</span> path, kept for verification against the
            scheduled snapshot. It is expected to be slow and is not the normal way to read this
            page.{' '}
            <Link href={`/admin/operating?view=${grain}`}>Back to the snapshot</Link>.
          </p>
        )}

        <ReviewModeSwitch grain={grain} />

        <p className={styles.note}>
          🔒 Access gate: a signed-in admin session (session + active admin role) is the only way in; there is no
          shared-secret or URL-token access. Review protocol — what to check, who reviews it, what escalates — is
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
        Read-only operating view ·{' '}
        {snapshotAge
          ? 'every number is from the scheduled snapshot named above (or explicitly marked unavailable)'
          : 'every number is live from the database (or explicitly marked unavailable)'}{' '}
        · no data is modified by this page.
      </footer>
    </main>
  );
}
