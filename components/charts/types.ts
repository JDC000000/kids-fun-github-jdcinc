// components/charts/types.ts — shared trend-chart data contract (M5 / T32).
//
// Plain, serialisable shapes the server page computes and hands to the client
// <TrendChart> island as props (so the SVG's initial markup is server-rendered —
// present in the SSR DOM for the axe audit and legible with JS disabled).

/** One plotted line/area: an identity + its per-x values, aligned to the x-axis labels. */
export interface TrendSeries {
  /** Stable key (also the a11y/id anchor), e.g. 'dau'. */
  key: string;
  /** Human label shown in the legend, tooltip and table, e.g. 'DAU (24h)'. */
  label: string;
  /**
   * The CSS custom-property reference carrying this series' mark colour, e.g.
   * 'var(--kf-chart-1)'. The colour lives in a validated design token — the
   * component never receives a raw hex, so light/dark swap in one place and the
   * palette stays the audited one.
   */
  colorVar: string;
  /**
   * One value per x-axis position (same length/order as the chart's `x`).
   *
   * `null` means "this x had nothing to measure" — a period before the data source
   * existed — and is rendered as a GAP in the line and an em-dash in the table, never
   * as a zero. A real, measured zero is `0` and stays a visible point on the baseline:
   * that traffic-cliff signal is the whole reason these charts exist (H1).
   */
  values: (number | null)[];
}

/** A number formatter for axis ticks / tooltip / table values (defaults to en-CA). */
export type ValueFormatter = (n: number) => string;
