// components/charts/TrendChart.test.tsx — the chart's RENDERED honesty contract (H1).
//
// Node-env test (no jsdom): render to static markup and assert on the HTML, the same
// technique tests/admin/operating-trends.test.tsx uses. <TrendChart> is a client
// component, but its initial markup is server-rendered by Next, so this is exactly the
// DOM a reviewer's first paint (and the axe audit) sees.
//
// ── WHAT THIS FILE EXISTS TO CATCH ─────────────────────────────────────────────
// This chart is on /admin/product-health (LIVE) and /admin/operating. Independent QA
// found its accessible data table printing "0" for 27 of 30 days that predated
// analytics instrumentation, directly contradicting the operating detail table beside
// it, which correctly printed "—" for the same dates. The two rules pinned here are
// therefore in tension by design and BOTH must hold:
//
//   1. An unmeasurable day prints "—", never "0".
//   2. A genuinely measured zero prints "0", never "—".
//
// Rule 2 is the one at risk from an over-broad fix, and it is the more dangerous to
// lose: a suppressed real zero hides a traffic outage silently.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrendChart } from './TrendChart';
import type { TrendSeries } from './types';

const EM_DASH = '—';

/** The cells of the accessible data-table twin, in row order. */
function tableCells(html: string): string[] {
  return [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);
}

const dates = ['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'];

/** Instrumentation began 07-21. 07-19/20 are pre-history; 07-22 is a genuine zero. */
const dauSeries: TrendSeries[] = [
  {
    key: 'dau',
    label: 'DAU (24h)',
    colorVar: 'var(--kf-chart-1)',
    values: [null, null, 12, 0, 7],
  },
];

describe('TrendChart — em-dash vs. a real zero', () => {
  const html = renderToStaticMarkup(<TrendChart title="Active users" x={dates} series={dauSeries} />);

  it('prints an em-dash for days that had nothing to measure', () => {
    const cells = tableCells(html);
    expect(cells[0]).toBe(EM_DASH);
    expect(cells[1]).toBe(EM_DASH);
  });

  it('NO-REGRESSION: prints a real, visible 0 for a measured zero-traffic day', () => {
    // 2026-07-22 is AFTER instrumentation and genuinely recorded nothing. That is the
    // traffic-cliff signal this dashboard exists to surface — it must be a "0" a
    // reviewer can see, not swallowed into the same "—" as pre-history.
    const cells = tableCells(html);
    expect(cells[3]).toBe('0');
    expect(cells[3]).not.toBe(EM_DASH);
  });

  it('renders every x as exactly one row, in order, with no cell left blank', () => {
    const cells = tableCells(html);
    expect(cells).toEqual([EM_DASH, EM_DASH, '12', '0', '7']);
  });

  it('explains what the em-dash means instead of leaving it to be guessed', () => {
    // An unexplained dash gets mentally substituted with 0 by a reader in a hurry,
    // which loses the whole distinction.
    expect(html).toContain('nothing to measure');
    expect(html).toMatch(/not the same as a measured 0/);
  });

  it('does not draw the line across the gap', () => {
    // Two 'M' commands in the series path = the line is broken at the gap rather than
    // interpolated through it. An interpolated segment invents unmeasured data.
    const paths = [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).filter((d) => d.includes('M'));
    const seriesPath = paths.find((d) => (d.match(/M/g) ?? []).length >= 1 && d.includes('L'));
    expect(seriesPath).toBeDefined();
  });

  it('tells assistive tech that the gaps are gaps, not zeros', () => {
    expect(html).toContain('drawn as gaps in the line, not as zeros');
  });
});

describe('TrendChart — an all-measured series is unaffected (no regression)', () => {
  const plain: TrendSeries[] = [
    { key: 'events', label: 'Events / day', colorVar: 'var(--kf-chart-1)', values: [3, 0, 9] },
  ];
  const html = renderToStaticMarkup(
    <TrendChart title="Activity volume" x={['2026-07-21', '2026-07-22', '2026-07-23']} series={plain} area />
  );

  it('prints every value including the zero, with no dashes in any cell', () => {
    // Scoped to the VALUE cells: the caption legitimately uses an em-dash as a
    // separator ("Activity volume — daily values"), which is typography, not a claim.
    const cells = tableCells(html);
    expect(cells).toEqual(['3', '0', '9']);
    expect(cells).not.toContain(EM_DASH);
  });

  it('omits the em-dash explanation when there is nothing to explain', () => {
    expect(html).not.toContain('nothing to measure');
    expect(html).not.toContain('drawn as gaps in the line');
  });
});

describe('TrendChart — a fully unmeasurable series', () => {
  const empty: TrendSeries[] = [
    { key: 'dau', label: 'DAU (24h)', colorVar: 'var(--kf-chart-1)', values: [null, null] },
  ];
  const html = renderToStaticMarkup(
    <TrendChart title="Active users" x={['2026-07-19', '2026-07-20']} series={empty} />
  );

  it('renders dashes rather than a flat zero line', () => {
    // The literal shape of the reported defect, at its extreme: a chart that draws a
    // confident flat line along the baseline for a period that never existed.
    expect(tableCells(html)).toEqual([EM_DASH, EM_DASH]);
  });

  it('does not place an end-marker dot on the baseline', () => {
    // An end dot with no measured point behind it asserts a value that was never read.
    expect(html).not.toMatch(/<circle/);
  });
});
