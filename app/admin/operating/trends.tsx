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
import { formatCount } from '@/lib/admin/format';
import { plotArea, niceCeil, scaleX, scaleY, linePath, type PlotBox, type XY } from '@/components/charts/scale';
import {
  MIN_RATE_SAMPLE,
  type KpiFormat,
  type OperatingGrain,
  type OperatingKpi,
  type OperatingPeriodCounts,
  type TrendDirection,
  type TrendVerdict,
} from '@/lib/analytics/operating';
import type { OperatingOpsPeriod } from '@/lib/admin/operating';
import type { SentryIssueTrend } from '@/lib/observability/sentry-issues';
import styles from './_components/Operating.module.css';

const EM_DASH = '—';

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
// Numeric detail table — the text twin of every plotted series
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every counter behind every KPI, one row per period. This is the accessibility twin
 * for the sparklines (colour and shape are never the only channel) AND the artifact a
 * reviewer copies into the review note the cadence doc asks them to write.
 */
export function OperatingDetailTable({
  counts,
  ops,
  grain,
  preHistory,
}: {
  counts: OperatingPeriodCounts[];
  ops: OperatingOpsPeriod[];
  grain: OperatingGrain;
  /** Bucket keys that closed before the product recorded anything (see isPreHistory). */
  preHistory?: Set<string>;
}) {
  const opsByPeriod = new Map(ops.map((o) => [o.period, o]));
  // Newest first — a reviewer reads the most recent period, not the oldest.
  const all = [...counts].reverse();
  // Pre-history buckets carry no information (they are all-zero by construction, and
  // their KPI cards read "—"), so they are dropped from the table rather than padding
  // it with rows of zeros that look like measurements. The count of what was dropped
  // is disclosed in the caption — a hidden row is never a silent one.
  const rows = preHistory ? all.filter((c) => !preHistory.has(c.period)) : all;
  const hidden = all.length - rows.length;

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
            return (
              <tr key={c.period} className={c.partial ? styles.rowPartial : undefined}>
                <th scope="row">
                  {c.label}
                  {c.partial ? ' (in progress)' : ''}
                </th>
                <td>{formatCount(c.activeActors)}</td>
                <td>{formatCount(c.newActors)}</td>
                <td>{formatCount(c.activatedNewActors)}</td>
                <td>{formatCount(c.returningActors)}</td>
                <td>{formatCount(c.searches)}</td>
                <td>{formatCount(c.zeroResultSearches)}</td>
                <td>{formatCount(c.recoveredZeroResultSearches)}</td>
                <td>{formatCount(c.listingViews)}</td>
                <td>{formatCount(c.outboundClicks)}</td>
                <td>
                  {formatCount(c.savedSearches)} / {formatCount(c.emailOptIns)}
                </td>
                <td>
                  {formatCount(o?.correctionsOpened ?? 0)} / {formatCount(o?.correctionsResolved ?? 0)}
                </td>
                <td>
                  {formatCount(o?.okCheckRuns ?? 0)} / {formatCount(o?.checkRuns ?? 0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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

  const peak = sentry.points.reduce((max, p) => Math.max(max, p.newIssues), 0);
  const total = sentry.points.reduce((sum, p) => sum + p.newIssues, 0);

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
          </caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">New issues</th>
            </tr>
          </thead>
          <tbody>
            {[...sentry.points].reverse().map((p) => (
              <tr key={p.date}>
                <th scope="row">{p.date}</th>
                <td>{formatCount(p.newIssues)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
