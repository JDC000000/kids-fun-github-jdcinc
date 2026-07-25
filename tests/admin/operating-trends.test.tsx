// tests/admin/operating-trends.test.tsx — the operating review's presentation layer (T41).
//
// Node-env test (no jsdom): render the server components to static markup and assert
// on the produced HTML, the same technique components/ui/__tests__/ui.test.tsx uses.
// Assertions avoid CSS-module class hashing — they check text, semantics and ARIA.
//
// The behaviours pinned here are the ones a well-meaning future edit is most likely to
// break: a trend direction must never be communicated by an arrow ALONE, a value the
// data cannot support must render as an em-dash rather than a zero, an in-progress
// period must stay visibly separate from a result, and an unreadable Sentry must never
// render as "0 issues".
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  KpiTrendCard,
  OperatingDetailTable,
  ReviewModeSwitch,
  SentryIssuePanel,
  buildSparkGeometry,
  directionGlyph,
  formatKpiDelta,
  formatKpiValue,
  verdictText,
} from '../../app/admin/operating/trends';
import { buildOperatingKpi, type OperatingKpiDef, type OperatingPeriodCounts } from '../../lib/analytics/operating';
import type { OperatingOpsPeriod } from '../../lib/admin/operating';

const EM_DASH = '—';

describe('value formatting', () => {
  it('renders each KPI format in its own unit', () => {
    expect(formatKpiValue(42, 'count')).toBe('42');
    expect(formatKpiValue(1234, 'count')).toBe('1,234');
    expect(formatKpiValue(25, 'pct')).toBe('25%');
    expect(formatKpiValue(12.5, 'perDay')).toBe('12.5 / day');
  });

  it('renders "no data" as an em-dash in EVERY format — never as a zero', () => {
    for (const format of ['count', 'pct', 'perDay'] as const) {
      expect(formatKpiValue(null, format)).toBe(EM_DASH);
      expect(formatKpiValue(Number.NaN, format)).toBe(EM_DASH);
    }
  });

  it('signs the delta and uses percentage POINTS for rate KPIs', () => {
    expect(formatKpiDelta(5, 'count')).toBe('+5');
    expect(formatKpiDelta(-5, 'count')).toBe('-5');
    expect(formatKpiDelta(0, 'count')).toBe('0');
    expect(formatKpiDelta(5, 'pct')).toBe('+5 pp'); // points, not "%", which would be wrong
    expect(formatKpiDelta(null, 'pct')).toBe(EM_DASH);
  });

  it('pairs every glyph with distinct verdict TEXT (colour/shape is never the only channel)', () => {
    expect(directionGlyph('up')).not.toBe(directionGlyph('down'));
    const texts = (['improving', 'worsening', 'steady', 'unknown'] as const).map(verdictText);
    expect(new Set(texts).size).toBe(4);
    expect(verdictText('unknown')).toBe('not enough data');
  });
});

describe('buildSparkGeometry', () => {
  it('reports empty when there is nothing plottable', () => {
    const geo = buildSparkGeometry([null, null, null], false);
    expect(geo.empty).toBe(true);
    expect(geo.completePath).toBe('');
    expect(geo.lastPoint).toBeNull();
  });

  it('draws the closed periods and the in-progress leg as separate paths', () => {
    const geo = buildSparkGeometry([1, 2, 3, 9], true);
    expect(geo.empty).toBe(false);
    expect(geo.completePath).not.toBe('');
    expect(geo.partialPath).not.toBe(''); // the dashed leg exists and is separable
    expect(geo.lastPoint).not.toBeNull();
  });

  it('has no partial leg when the series has no in-progress tail', () => {
    const geo = buildSparkGeometry([1, 2, 3], false);
    expect(geo.partialPath).toBe('');
  });

  it('treats a null as a GAP, not as zero', () => {
    // Two separate runs either side of the gap → two "M" move commands in the path.
    const geo = buildSparkGeometry([1, 2, null, 4, 5], false);
    expect((geo.completePath.match(/M/g) ?? []).length).toBe(2);
  });

  it('survives an all-zero series without dividing by a zero axis', () => {
    const geo = buildSparkGeometry([0, 0, 0], false);
    expect(geo.empty).toBe(false);
    expect(Number.isFinite(geo.baselineY)).toBe(true);
    expect(geo.completePath).toContain('M');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendered output
// ─────────────────────────────────────────────────────────────────────────────

const DEF: OperatingKpiDef = {
  key: 'source_ctr',
  label: 'Source click-through rate',
  description: 'outbound clicks ÷ listing views',
  format: 'pct',
  better: 'higher',
  provenance: 'TSD §12.5 KPI #7 (ratified)',
  cadence: 'both',
  target: { value: 25, direction: 'gte', source: 'TSD §12.5 KPI #7' },
};

function pt(period: string, value: number | null, sample: number | null, partial = false) {
  return { period, label: period, value, sample, partial };
}

describe('<KpiTrendCard>', () => {
  it('states the verdict in words alongside the arrow glyph', () => {
    const kpi = buildOperatingKpi(DEF, [pt('a', 10, 100), pt('b', 30, 100), pt('c', 99, 100, true)]);
    const html = renderToStaticMarkup(<KpiTrendCard kpi={kpi} grain="day" />);

    expect(html).toContain('improving'); // the TEXT channel, not just the glyph
    expect(html).toContain('30%'); // the last COMPLETE period is the headline
    expect(html).toContain('+20 pp');
    expect(html).toContain('99%'); // …and the in-progress value is shown separately
    expect(html).toContain('In progress now');
    expect(html).toContain('target ≥25% — met');
  });

  it('says "not enough data" rather than showing a fabricated arrow', () => {
    const kpi = buildOperatingKpi(DEF, [pt('a', null, 0), pt('b', null, 0, true)]);
    const html = renderToStaticMarkup(<KpiTrendCard kpi={kpi} grain="day" />);

    expect(html).toContain('not enough data');
    expect(html).toContain(EM_DASH);
    expect(html).not.toContain('improving');
    expect(html).not.toContain('worsening');
  });

  it('badges a small denominator as low sample', () => {
    const kpi = buildOperatingKpi(DEF, [pt('a', 50, 3), pt('b', 100, 2)]);
    const html = renderToStaticMarkup(<KpiTrendCard kpi={kpi} grain="day" />);
    expect(html).toContain('low sample');
  });

  it('does not badge low sample when the denominator is well-powered', () => {
    const kpi = buildOperatingKpi(DEF, [pt('a', 50, 500), pt('b', 40, 500)]);
    const html = renderToStaticMarkup(<KpiTrendCard kpi={kpi} grain="day" />);
    expect(html).not.toContain('low sample');
    expect(html).toContain('worsening'); // higher-is-better metric that fell
  });
});

describe('<ReviewModeSwitch>', () => {
  it('marks the active review with aria-current, not colour alone', () => {
    const html = renderToStaticMarkup(<ReviewModeSwitch grain="month" />);
    expect(html).toContain('Daily review');
    expect(html).toContain('Monthly review');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('/admin/operating?view=daily');
    expect(html).toContain('/admin/operating?view=monthly');
  });

  it('never renders the interim admin token into a link', () => {
    const html = renderToStaticMarkup(<ReviewModeSwitch grain="day" />);
    expect(html).not.toContain('token');
  });
});

describe('<OperatingDetailTable>', () => {
  const base: OperatingPeriodCounts = {
    period: '2026-07-24',
    label: '2026-07-24',
    partial: false,
    events: 10,
    activeActors: 4,
    searches: 6,
    searchesWithResults: 6,
    zeroResultSearches: 1,
    nonEmptySearches: 5,
    broadenedSearches: 0,
    attributableSearches: 6,
    engagedSearches: 3,
    attributableZeroResultSearches: 1,
    recoveredZeroResultSearches: 1,
    listingViews: 3,
    outboundClicks: 2,
    savedSearches: 1,
    emailOptIns: 1,
    signInEvents: 1,
    signedInActors: 1,
    newActors: 2,
    activatedNewActors: 1,
    returningActors: 2,
    priorActors: 3,
    retainedActors: 2,
  };
  const partial: OperatingPeriodCounts = { ...base, period: '2026-07-25', label: '2026-07-25', partial: true };
  const ops: OperatingOpsPeriod[] = [
    { period: '2026-07-24', label: '2026-07-24', partial: false, correctionsOpened: 2, correctionsResolved: 1, checkRuns: 4, okCheckRuns: 3, failedCheckRuns: 1 },
    { period: '2026-07-25', label: '2026-07-25', partial: true, correctionsOpened: 0, correctionsResolved: 0, checkRuns: 1, okCheckRuns: 1, failedCheckRuns: 0 },
  ];

  it('renders newest-first and labels the in-progress period as such', () => {
    const html = renderToStaticMarkup(<OperatingDetailTable counts={[base, partial]} ops={ops} grain="day" />);
    expect(html).toContain('2026-07-25');
    expect(html).toContain('(in progress)');
    // Newest row must come first in the markup.
    expect(html.indexOf('2026-07-25')).toBeLessThan(html.indexOf('2026-07-24'));
  });

  it('drops pre-history rows but DISCLOSES how many it dropped', () => {
    const preLaunch: OperatingPeriodCounts = { ...base, period: '2026-06-01', label: '2026-06' };
    const html = renderToStaticMarkup(
      <OperatingDetailTable
        counts={[preLaunch, base, partial]}
        ops={ops}
        grain="day"
        preHistory={new Set(['2026-06-01'])}
      />
    );
    expect(html).not.toContain('2026-06');
    expect(html).toContain('1 earlier'); // the disclosure — never a silent truncation
    expect(html).toContain('nothing to measure in them');
  });

  it('is a real data table — every plotted counter is reachable as text', () => {
    const html = renderToStaticMarkup(<OperatingDetailTable counts={[base, partial]} ops={ops} grain="day" />);
    expect(html).toContain('<caption');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('Corrections +/−');
    expect(html).toContain('Checks ok/total');
  });
});

describe('<SentryIssuePanel>', () => {
  it('says it cannot read the trend — and shows NO counts — when unconfigured', () => {
    const html = renderToStaticMarkup(
      <SentryIssuePanel sentry={{ state: 'unconfigured', reason: 'Set SENTRY_ISSUES_API_TOKEN.' }} />
    );
    expect(html).toContain('Not configured in this environment');
    expect(html).toContain('Set SENTRY_ISSUES_API_TOKEN.');
    expect(html).not.toContain('Unresolved issues'); // no stat tiles → no fake zeros
  });

  it('says the trend is unavailable — and shows NO counts — on an API failure', () => {
    const html = renderToStaticMarkup(
      <SentryIssuePanel sentry={{ state: 'unavailable', reason: 'Sentry API returned HTTP 403' }} />
    );
    expect(html).toContain('Trend unavailable');
    expect(html).toContain('HTTP 403');
    expect(html).not.toContain('Unresolved issues');
  });

  it('renders real counts and a per-day table when the read succeeded', () => {
    const html = renderToStaticMarkup(
      <SentryIssuePanel
        sentry={{
          state: 'ok',
          org: 'jdc000000',
          project: 'kids-fun',
          windowDays: 3,
          unresolvedIssues: 7,
          totalEvents: 42,
          truncated: false,
          points: [
            { date: '2026-07-23', newIssues: 1 },
            { date: '2026-07-24', newIssues: 0 },
            { date: '2026-07-25', newIssues: 2 },
          ],
        }}
      />
    );
    expect(html).toContain('Unresolved issues');
    expect(html).toContain('>7<');
    expect(html).toContain('>42<');
    expect(html).toContain('jdc000000');
    expect(html).toContain('2026-07-25');
  });

  it('marks a truncated issue list so its counts are read as a floor', () => {
    const html = renderToStaticMarkup(
      <SentryIssuePanel
        sentry={{
          state: 'ok',
          org: 'o',
          project: 'p',
          windowDays: 1,
          unresolvedIssues: 100,
          totalEvents: 1,
          truncated: true,
          points: [{ date: '2026-07-25', newIssues: 1 }],
        }}
      />
    );
    expect(html).toContain('100+');
    expect(html).toContain('a floor, not an exact total');
  });
});
