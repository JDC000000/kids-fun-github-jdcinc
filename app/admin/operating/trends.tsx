// app/admin/operating/trends.tsx — trend presentation for the operating review
// (M7 / T41, G-T41-2).
//
// The half of the operating dashboard that makes every KPI a DIRECTION rather than a
// point-in-time number: a per-KPI card carrying its sparkline, its movement between
// the last two COMPLETE periods, a plain-language verdict and its target read; the
// daily/monthly review-mode switch; the numeric detail table; and the Sentry panel.
//
// Presentational and server-compatible (no `use client`) — these render inside the
// server page, so the whole review is in the SSR DOM. The one client island on the
// page is the shared <TrendChart>, which page.tsx imports directly; nothing here
// needs interactivity, so nothing here ships JavaScript.
//
// ── THREE RULES THIS FILE ENFORCES ─────────────────────────────────────────────
// 1. Direction is NEVER colour-only. Every arrow glyph is paired with a Badge whose
//    TEXT states the verdict ("improving", "worsening", "not enough data"), so the
//    trend is legible to screen readers and colour-blind reviewers (WCAG 1.4.1).
// 2. The in-progress period is never presented as a result. It is drawn as a dashed
//    sparkline leg, labelled "in progress", italicised in the table, and excluded
//    from every comparison.
// 3. A number the data cannot support is an em-dash, not a zero — and a number from a
//    small denominator carries an explicit "low sample" badge rather than being shown
//    with the same authority as a well-powered one.
import Link from 'next/link';
import { Badge, Card, type BadgeVariant } from '@/components/ui';
import { EM_DASH, formatCount, formatMeasure } from '@/lib/admin/format';
import { plotArea, niceCeil, scaleX, scaleY, linePath, type PlotBox, type XY } from '@/components/charts/scale';
import {
  MIN_RATE_SAMPLE,
  isPreHistory,
  type KpiFormat,
  type OperatingGrain,
  type OperatingKpi,
  type OperatingPeriodCounts,
  type TrendDirection,
  type TrendVerdict,
} from '@/lib/analytics/operating';
import { earliestDataMs, type OperatingDataAnchors, type OperatingOpsPeriod } from '@/lib/admin/operating';
import type { SentryIssueTrend } from '@/lib/observability/sentry-issues';
import styles from './_components/Operating.module.css';

// EM_DASH is imported from lib/admin/format rather than redeclared: the glyph and the
// helper that emits it should never be able to drift apart.

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** Format a KPI value for its declared format. Null → em-dash (never a fake 0). */
export function formatKpiValue(value: number | null, format: KpiFormat): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  if (format === 'pct') return `${value}%`;
  if (format === 'perDay') return `${value.toLocaleString('en-CA', { maximumFractionDigits: 1 })} / day`;
  return formatCount(value);
}

/** Signed delta for the movement line, in the KPI's own unit. Null → em-dash. */
export function formatKpiDelta(delta: number | null, format: KpiFormat): string {
  if (delta == null || !Number.isFinite(delta)) return EM_DASH;
  const sign = delta > 0 ? '+' : '';
  const magnitude = delta.toLocaleString('en-CA', { maximumFractionDigits: 1 });
  return format === 'pct' ? `${sign}${magnitude} pp` : `${sign}${magnitude}`;
}

/** Arrow glyph for a raw direction. Always accompanied by the verdict TEXT. */
export function directionGlyph(direction: TrendDirection): string {
  if (direction === 'up') return '▲';
  if (direction === 'down') return '▼';
  if (direction === 'flat') return '▬';
  return '·';
}

/** Plain-language verdict text — the non-colour, non-glyph channel. */
export function verdictText(verdict: TrendVerdict): string {
  if (verdict === 'improving') return 'improving';
  if (verdict === 'worsening') return 'worsening';
  if (verdict === 'steady') return 'steady';
  return 'not enough data';
}

/** Badge tone for a verdict. Reinforcement only — never the sole signal. */
function verdictVariant(verdict: TrendVerdict): BadgeVariant {
  if (verdict === 'improving') return 'confirmed';
  if (verdict === 'worsening') return 'expected';
  if (verdict === 'steady') return 'info';
  return 'neutral';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sparkline geometry — pure, exported for unit tests
// ─────────────────────────────────────────────────────────────────────────────

const SPARK_BOX: PlotBox = { width: 260, height: 40, padTop: 5, padRight: 6, padBottom: 5, padLeft: 6 };

export interface SparkGeometry {
  /** Path for the closed (complete-period) portion of the line, or '' if too short. */
  completePath: string;
  /** Path for the final leg into the in-progress period, or '' when absent. */
  partialPath: string;
  /** The last plotted point, for the end marker. Null when nothing is plottable. */
  lastPoint: XY | null;
  /** y of the zero baseline. */
  baselineY: number;
  /** True when there is not a single non-null value to draw. */
  empty: boolean;
}

/**
 * Project a KPI series into sparkline geometry.
 *
 * Nulls are GAPS, not zeros — a period with no data breaks the line rather than
 * dropping it to the floor, because drawing a null as 0 is exactly the "misleading
 * placeholder" this dashboard is not allowed to show. The final leg is split into its
 * own path so the in-progress period can be drawn dashed.
 */
export function buildSparkGeometry(values: (number | null)[], hasPartialTail: boolean): SparkGeometry {
  const area = plotArea(SPARK_BOX);
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  const baselineY = scaleY(0, 1, area);

  if (finite.length === 0) {
    return { completePath: '', partialPath: '', lastPoint: null, baselineY, empty: true };
  }

  const yMax = Math.max(1, niceCeil(Math.max(...finite)));
  const points: (XY | null)[] = values.map((v, i) =>
    v == null || !Number.isFinite(v) ? null : { x: scaleX(i, values.length, area), y: scaleY(v, yMax, area) }
  );

  // The complete portion excludes the final (in-progress) point when there is one.
  const completeCount = hasPartialTail ? points.length - 1 : points.length;
  const completeRuns: XY[][] = [];
  let run: XY[] = [];
  for (let i = 0; i < completeCount; i++) {
    const p = points[i];
    if (p) {
      run.push(p);
    } else if (run.length) {
      completeRuns.push(run);
      run = [];
    }
  }
  if (run.length) completeRuns.push(run);

  const completePath = completeRuns
    .filter((r) => r.length > 1)
    .map((r) => linePath(r))
    .join(' ');

  // The dashed leg from the last complete point into the in-progress one.
  let partialPath = '';
  if (hasPartialTail && points.length >= 2) {
    const tail = points[points.length - 1];
    const prior = points[points.length - 2];
    if (tail && prior) partialPath = linePath([prior, tail]);
  }

  const lastPoint = [...points].reverse().find((p): p is XY => p != null) ?? null;
  return { completePath, partialPath, lastPoint, baselineY, empty: false };
}

/**
 * A KPI's sparkline.
 *
 * `aria-hidden`: this SVG is decorative reinforcement of numbers that are ALL
 * reachable as text — the headline value and delta sit next to it, and every plotted
 * period is a row in <OperatingDetailTable> below. Announcing the path would add
 * noise, not information (the same table-twin rationale <TrendChart> documents).
 */
function Sparkline({ kpi }: { kpi: OperatingKpi }) {
  const hasPartialTail = kpi.points.some((p) => p.partial);
  const geo = buildSparkGeometry(
    kpi.points.map((p) => p.value),
    hasPartialTail
  );

  if (geo.empty) {
    return <p className={styles.sparkEmpty}>No data in this window yet.</p>;
  }

  return (
    <svg
      className={styles.spark}
      viewBox={`0 0 ${SPARK_BOX.width} ${SPARK_BOX.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <line
        className={styles.sparkBaseline}
        x1={0}
        y1={geo.baselineY}
        x2={SPARK_BOX.width}
        y2={geo.baselineY}
      />
      {geo.completePath && <path className={styles.sparkLine} d={geo.completePath} />}
      {geo.partialPath && <path className={styles.sparkPartial} d={geo.partialPath} />}
      {geo.lastPoint && <circle className={styles.sparkMarker} cx={geo.lastPoint.x} cy={geo.lastPoint.y} r={3} />}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Review-mode switch (G-T41-2: daily-review and monthly-review layouts)
// ─────────────────────────────────────────────────────────────────────────────

const MODES: { grain: OperatingGrain; view: string; label: string }[] = [
  { grain: 'day', view: 'daily', label: 'Daily review' },
  { grain: 'month', view: 'monthly', label: 'Monthly review' },
];

/**
 * The two review layouts, as links rather than a client-side toggle: each mode is a
 * real, shareable, bookmarkable URL an operator can drop into a standup or a calendar
 * invite (which is what docs/kpi-cadence.md asks reviewers to do), and it keeps the
 * page a pure server component.
 *
 * ── DELIBERATE: the interim `?token=` admin secret is NOT propagated into these
 * hrefs. Rendering a shared secret into page HTML puts it in every screenshot of a
 * dashboard whose whole purpose is to be screenshotted into a review note. The
 * sibling admin pages already omit it from their cross-links, so this matches
 * precedent; the cost is that a reviewer using the interim TOKEN path (rather than a
 * real admin session, which is the primary gate) must re-append `&token=` when
 * switching modes. Flagged rather than silently traded away.
 */
export function ReviewModeSwitch({ grain }: { grain: OperatingGrain }) {
  return (
    <nav className={styles.modeSwitch} aria-label="Review cadence">
      {MODES.map((mode) => {
        const active = mode.grain === grain;
        return (
          <Link
            key={mode.view}
            href={`/admin/operating?view=${mode.view}`}
            aria-current={active ? 'page' : undefined}
            className={active ? `${styles.modeLink} ${styles.modeLinkActive}` : styles.modeLink}
          >
            {mode.label}
          </Link>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI trend cards
// ─────────────────────────────────────────────────────────────────────────────

/** Human name for the comparison the delta describes. */
function comparisonLabel(grain: OperatingGrain): string {
  return grain === 'month' ? 'vs previous full month' : 'vs previous full day';
}

/** The target badge, or nothing when the KPI carries no target. */
function targetBadge(kpi: OperatingKpi) {
  if (!kpi.target) return null;
  const comparator = kpi.target.direction === 'gte' ? '≥' : '≤';
  const suffix = kpi.format === 'pct' ? '%' : '';
  const text = `target ${comparator}${kpi.target.value}${suffix}`;
  if (kpi.met == null) return <Badge variant="neutral">{text}</Badge>;
  return <Badge variant={kpi.met ? 'confirmed' : 'expected'}>{kpi.met ? `${text} — met` : `${text} — missed`}</Badge>;
}

/** One KPI: headline value, movement, verdict, target, sparkline, provenance. */
export function KpiTrendCard({ kpi, grain }: { kpi: OperatingKpi; grain: OperatingGrain }) {
  const headingId = `kpi-${kpi.key}`;
  return (
    <Card className={styles.kpiCard} aria-labelledby={headingId}>
      <div className={styles.kpiLabel} id={headingId}>
        {kpi.label}
      </div>

      <div className={styles.kpiValueRow}>
        <span className={styles.kpiValue}>{formatKpiValue(kpi.current, kpi.format)}</span>
        <span className={styles.kpiDelta}>
          <span aria-hidden="true">{directionGlyph(kpi.direction)}</span>{' '}
          {formatKpiDelta(kpi.delta, kpi.format)} {comparisonLabel(grain)}
        </span>
      </div>

      <div className={styles.badgeRow}>
        <Badge variant={verdictVariant(kpi.verdict)}>{verdictText(kpi.verdict)}</Badge>
        {kpi.lowSample && <Badge variant="expected">low sample (&lt;{MIN_RATE_SAMPLE})</Badge>}
        {targetBadge(kpi)}
      </div>

      <Sparkline kpi={kpi} />

      <p className={styles.kpiSub}>
        In progress now: <strong>{formatKpiValue(kpi.inProgress, kpi.format)}</strong> · {kpi.description}
      </p>
      <p className={styles.kpiProvenance}>{kpi.provenance}</p>
    </Card>
  );
}

/** The KPI grid for one review. */
export function KpiTrendGrid({ kpis, grain }: { kpis: OperatingKpi[]; grain: OperatingGrain }) {
  return (
    <div className={styles.kpiGrid}>
      {kpis.map((kpi) => (
        <KpiTrendCard key={kpi.key} kpi={kpi} grain={grain} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Period-axis arithmetic — shared so the header and the table caption can never
// tell the reviewer two different stories about the same axis.
// ─────────────────────────────────────────────────────────────────────────────

/** One entry of the bucket axis, as OperatingDashboardData publishes it. */
export interface PeriodAxisEntry {
  period: string;
  label: string;
  partial: boolean;
  /** No domain could have recorded anything in this bucket. */
  preHistory: boolean;
}

/**
 * Buckets the review can actually be READ off: complete (not in progress) and capable
 * of having contained a measurement.
 *
 * Counting pre-history buckets here would over-claim the review's depth and contradict
 * the detail-table caption, which discloses those same buckets as "not shown … nothing
 * to measure in them". Exported (rather than inlined in the page) precisely so that
 * contradiction is testable: see the reconciliation identity in the tests.
 */
export function countReviewablePeriods(periods: PeriodAxisEntry[]): number {
  return periods.filter((p) => !p.partial && !p.preHistory).length;
}

/** Buckets hidden from the detail table because no domain could have measured them. */
export function countPreHistoryPeriods(periods: PeriodAxisEntry[]): number {
  return periods.filter((p) => p.preHistory).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Numeric detail table — the text twin of every plotted series
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every counter behind every KPI, one row per period. This is the accessibility twin
 * for the sparklines (colour and shape are never the only channel) AND the artifact a
 * reviewer copies into the review note the cadence doc asks them to write.
 *
 * ── PER-COLUMN pre-history, not per-row (regression fix) ───────────────────────
 * Each column group is sourced from a DIFFERENT table, and those tables have
 * different histories — that is the whole reason {@link OperatingDataAnchors} exists.
 * So a cell is dashed when ITS OWN domain had no history in that bucket, not when the
 * row as a whole did.
 *
 * This matters because the earlier fix (correctly) stopped dropping rows that predate
 * analytics but still have real ops data. Rendering every column with `formatCount`
 * then printed `Active=0, Searches=0` for days before analytics instrumentation
 * existed, while the KPI cards for the same period read "—" — the same page giving two
 * different answers, and a direct breach of this module's load-bearing rule that a
 * dash is not a zero. A reviewer scanning the table could have read three
 * pre-instrumentation days as a traffic outage. Dashing per column closes that: the
 * table and the cards now agree cell-for-cell.
 */
export function OperatingDetailTable({
  counts,
  ops,
  grain,
  anchors,
}: {
  counts: OperatingPeriodCounts[];
  ops: OperatingOpsPeriod[];
  grain: OperatingGrain;
  /**
   * Per-table history starts. Omitted ⇒ nothing is dashed and nothing is dropped,
   * the same "no anchor, suppress nothing" default {@link isPreHistory} uses.
   */
  anchors?: Partial<OperatingDataAnchors>;
}) {
  const opsByPeriod = new Map(ops.map((o) => [o.period, o]));
  // Newest first — a reviewer reads the most recent period, not the oldest.
  const all = [...counts].reverse();

  // Per-domain "this bucket predates the table this column reads".
  const before = (period: string, anchorMs: number | null | undefined) =>
    isPreHistory(period, grain, anchorMs ?? null);
  const analyticsBefore = (period: string) => before(period, anchors?.analyticsMs);
  const correctionsBefore = (period: string) => before(period, anchors?.correctionMs);
  const checkRunsBefore = (period: string) => before(period, anchors?.checkRunMs);

  // A row is only DROPPED when no domain could have recorded anything in it — the
  // exact claim the caption makes. Anything else is rendered, with its unmeasurable
  // columns dashed rather than zeroed.
  const earliestMs = anchors ? earliestDataMs({
    analyticsMs: anchors.analyticsMs ?? null,
    checkRunMs: anchors.checkRunMs ?? null,
    correctionMs: anchors.correctionMs ?? null,
  }) : null;
  const rows = all.filter((c) => !isPreHistory(c.period, grain, earliestMs));
  const hidden = all.length - rows.length;

  /** A single counter: em-dash when its own domain had nothing to measure yet. */
  const cell = (isBefore: boolean, value: number) => (isBefore ? EM_DASH : formatCount(value));
  /** A paired "a / b" counter, dashed as ONE unit so half a pair is never implied. */
  const pair = (isBefore: boolean, a: number, b: number) =>
    isBefore ? EM_DASH : `${formatCount(a)} / ${formatCount(b)}`;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>
          Every counter behind the KPIs above, one row per {grain === 'month' ? 'month' : 'day'}, newest first. The
          in-progress period is italicised — it is incomplete and is excluded from all trend comparisons.
          {hidden > 0 &&
            ` ${hidden} earlier ${grain === 'month' ? 'month(s)' : 'day(s)'} are not shown: they closed before the first recorded event, so there was nothing to measure in them.`}
        </caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Active</th>
            <th scope="col">New</th>
            <th scope="col">Activated</th>
            <th scope="col">Returning</th>
            <th scope="col">Searches</th>
            <th scope="col">Zero-result</th>
            <th scope="col">Recovered</th>
            <th scope="col">Views</th>
            <th scope="col">Source clicks</th>
            <th scope="col">Saved / email</th>
            <th scope="col">Corrections +/−</th>
            <th scope="col">Checks ok/total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const o = opsByPeriod.get(c.period);
            const noAnalytics = analyticsBefore(c.period);
            const noCorrections = correctionsBefore(c.period);
            const noCheckRuns = checkRunsBefore(c.period);
            return (
              <tr key={c.period} className={c.partial ? styles.rowPartial : undefined}>
                <th scope="row">
                  {c.label}
                  {c.partial ? ' (in progress)' : ''}
                </th>
                <td>{cell(noAnalytics, c.activeActors)}</td>
                <td>{cell(noAnalytics, c.newActors)}</td>
                <td>{cell(noAnalytics, c.activatedNewActors)}</td>
                <td>{cell(noAnalytics, c.returningActors)}</td>
                <td>{cell(noAnalytics, c.searches)}</td>
                <td>{cell(noAnalytics, c.zeroResultSearches)}</td>
                <td>{cell(noAnalytics, c.recoveredZeroResultSearches)}</td>
                <td>{cell(noAnalytics, c.listingViews)}</td>
                <td>{cell(noAnalytics, c.outboundClicks)}</td>
                <td>{pair(noAnalytics, c.savedSearches, c.emailOptIns)}</td>
                <td>{pair(noCorrections, o?.correctionsOpened ?? 0, o?.correctionsResolved ?? 0)}</td>
                <td>{pair(noCheckRuns, o?.okCheckRuns ?? 0, o?.checkRuns ?? 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty-dataset disclosure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the banner says when the analytics table is completely empty (H1 item 2).
 *
 * ── WHY THIS IS A COMPONENT AND NOT INLINE PROSE ───────────────────────────────
 * It used to be a sentence inside page.tsx promising that "every KPI below will read
 * as an em-dash rather than a zero" on an empty database. The page did not do that,
 * and independent QA reproduced the disagreement live: the rate KPIs correctly showed
 * "—" while `Daily active users`, `Corrections reported`, `Corrections resolved` and
 * `Searches per day` all showed "0 · steady". A banner teaching a reading rule the
 * page beside it does not follow is worse than no banner, because it trains the
 * reviewer to mistrust the dashes that ARE load-bearing everywhere else.
 *
 * ── WHICH WAY IT WAS FIXED, AND WHY ────────────────────────────────────────────
 * The prose changed, not the numbers. `isPreHistory(_, _, null) === false` is a
 * deliberate, documented contract: with no anchor we cannot claim a period predates
 * anything. On an empty database a count of 0 is the TRUE measured count — there
 * really were zero corrections today — so dashing it would be the same class of lie
 * pointing the other way, hiding a real measurement behind "no data". The page was
 * right; the sentence was wrong.
 *
 * Living here, next to the em-dash rendering it describes, is the point: the claim and
 * the behaviour are now in one file and one test file, so they cannot drift apart
 * again the way they did across page.tsx and lib/analytics/operating.ts.
 */
export function EmptyDatasetNotice() {
  return (
    <>
      There is no analytics data yet. <strong>Rate</strong> KPIs below read as an em-dash because they have no
      denominator to divide by; <strong>count</strong> KPIs read 0, which is the honest measured count of an empty
      period rather than a stand-in for missing data. With no first event on record there is no anchor, so no period is
      treated as predating the data and nothing is hidden from you — the period count in the heading below is how many
      buckets closed inside the review window, not how many of them contain anything.
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentry issue trend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Production error trend, in whichever of its three honest states applies.
 *
 * The 'unconfigured' and 'unavailable' states are rendered as explicit prose in a
 * visually distinct, dashed container — deliberately NOT as stat tiles showing 0 —
 * because a zero on an error panel must always mean "Sentry reported zero", never
 * "we could not reach Sentry".
 */
export function SentryIssuePanel({ sentry }: { sentry: SentryIssueTrend }) {
  if (sentry.state !== 'ok') {
    const heading = sentry.state === 'unconfigured' ? 'Not configured in this environment' : 'Trend unavailable';
    return (
      <div className={styles.panel}>
        <p className={styles.unknownState}>
          <strong>Sentry issue trend — {heading}.</strong> {sentry.reason} No error numbers are shown here rather than
          showing zeros, because a zero on this panel must always mean Sentry really reported zero.
        </p>
      </div>
    );
  }

  // Unwatched days are excluded from both aggregates rather than counted as 0 (H1).
  // Treating them as zeros would drag "busiest day" and the window total toward a
  // calmer picture than the watched period actually had.
  const measured = sentry.points.filter((p) => p.newIssues != null).map((p) => p.newIssues as number);
  const unmeasured = sentry.points.length - measured.length;
  const peak = measured.reduce((max, n) => Math.max(max, n), 0);
  const total = measured.reduce((sum, n) => sum + n, 0);

  return (
    <div className={styles.panel}>
      <div className={styles.panelStats}>
        <div className={styles.panelStat}>
          <span className={styles.panelStatLabel}>Unresolved issues</span>
          <span className={styles.panelStatValue}>
            {formatCount(sentry.unresolvedIssues)}
            {sentry.truncated ? '+' : ''}
          </span>
        </div>
        <div className={styles.panelStat}>
          <span className={styles.panelStatLabel}>Events · last {sentry.windowDays}d</span>
          <span className={styles.panelStatValue}>{formatCount(sentry.totalEvents)}</span>
        </div>
        <div className={styles.panelStat}>
          <span className={styles.panelStatLabel}>New issues · last {sentry.windowDays}d</span>
          <span className={styles.panelStatValue}>{formatCount(total)}</span>
        </div>
        <div className={styles.panelStat}>
          <span className={styles.panelStatLabel}>Busiest day</span>
          <span className={styles.panelStatValue}>{formatCount(peak)}</span>
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>
            New Sentry issues by the UTC day they were first seen, {sentry.org}/{sentry.project}, unresolved only.
            {sentry.truncated
              ? ` List capped at the API page limit, so these counts are a floor, not an exact total.`
              : ''}
            {unmeasured > 0
              ? ` ${unmeasured} day(s) read “—”: they closed before this project was being watched, so nothing could have been reported in them. Those days are excluded from the totals above rather than counted as zero.`
              : ''}
          </caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">New issues</th>
            </tr>
          </thead>
          <tbody>
            {/* `newIssues` is number | null, so formatCount() no longer accepts it —
                the compiler now enforces what a comment here used to have to ask for. */}
            {[...sentry.points].reverse().map((p) => (
              <tr key={p.date}>
                <th scope="row">{p.date}</th>
                <td>{formatMeasure(p.newIssues)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
