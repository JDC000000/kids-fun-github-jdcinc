// components/charts/scale.ts — pure chart geometry (M5 / T32, G-T32-6).
//
// Framework- and DB-free scale/geometry maths for the hand-rolled SVG trend
// charts. Kept as small, exported pure functions so the plotting logic is
// unit-tested under Vitest with no React, no DOM and no database — the same
// "pure helper" discipline lib/analytics/kpi.ts uses for its derivations.
//
// The charts are hand-rolled SVG (no charting dependency) precisely so every
// dataviz mark spec — 2px lines, a single 0-anchored baseline, hairline
// recessive grid, clean rounded y-ticks — is expressed here in code we control,
// and validated rather than eyeballed.

/** A point in SVG user space. */
export interface XY {
  x: number;
  y: number;
}

/** The chart's outer box and the padding reserved for axis labels / end-labels. */
export interface PlotBox {
  width: number;
  height: number;
  padTop: number;
  padRight: number;
  padBottom: number;
  padLeft: number;
}

/** The inner drawing rectangle (where marks live), derived from a PlotBox. */
export interface PlotArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** width & height of the inner rectangle. */
  w: number;
  h: number;
}

/** Inner drawing rectangle for a box — never returns a negative dimension. */
export function plotArea(box: PlotBox): PlotArea {
  const left = box.padLeft;
  const right = box.width - box.padRight;
  const top = box.padTop;
  const bottom = box.height - box.padBottom;
  return {
    left,
    right,
    top,
    bottom,
    w: Math.max(0, right - left),
    h: Math.max(0, bottom - top),
  };
}

const NICE_STEPS = [1, 2, 5, 10] as const;

/**
 * Smallest "nice" number (1/2/5 × 10ⁿ) ≥ `value`. Used to round a raw data max
 * up to a clean axis top so y-ticks land on human numbers (0 / 50 / 100 …).
 * A non-positive / non-finite input returns 1 so a zero-data chart still has a
 * 1-unit axis (never a zero-height, divide-by-zero scale).
 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const frac = value / base;
  const niceFrac = NICE_STEPS.find((s) => frac <= s + 1e-9) ?? 10;
  return niceFrac * base;
}

/**
 * Clean, evenly-spaced y-axis ticks from 0 up to (at least) `rawMax`, aiming for
 * ~`target` intervals with a nice step. The last tick is the axis top used for
 * scaling — always ≥ rawMax so no mark overflows the plot. Robust to a 0/empty
 * dataset (returns [0, 1]).
 */
export function axisTicks(rawMax: number, target = 4): number[] {
  if (!Number.isFinite(rawMax) || rawMax <= 0) return [0, 1];
  const step = niceCeil(rawMax / Math.max(1, target));
  const top = Math.ceil(rawMax / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step * 1e-6; t += step) {
    // round away binary-float dust so ticks are exact integers/decimals.
    ticks.push(Math.round(t * 1e6) / 1e6);
  }
  return ticks;
}

/** The axis top (max) implied by a set of ticks — the value 100% of the plot height maps to. */
export function axisMax(ticks: number[]): number {
  return ticks.length ? ticks[ticks.length - 1] : 1;
}

/**
 * X position of point `index` of `count`, spread evenly across the plot width.
 * A single point is centred (avoids a divide-by-zero and a mark pinned to the
 * left edge). Clamps a degenerate count.
 */
export function scaleX(index: number, count: number, area: PlotArea): number {
  if (count <= 1) return area.left + area.w / 2;
  const t = clamp01(index / (count - 1));
  return round2(area.left + t * area.w);
}

/**
 * Y position of `value` on a [0 … yMax] scale, with 0 at the baseline (bottom)
 * and yMax at the top. A non-positive yMax pins everything to the baseline
 * rather than dividing by zero.
 */
export function scaleY(value: number, yMax: number, area: PlotArea): number {
  if (!Number.isFinite(value)) return area.bottom;
  if (yMax <= 0) return area.bottom;
  const t = clamp01(value / yMax);
  return round2(area.bottom - t * area.h);
}

/** Map a series of values to XY points across the plot (index → x, value → y). */
export function projectValues(values: number[], yMax: number, area: PlotArea): XY[] {
  const count = values.length;
  return values.map((v, i) => ({ x: scaleX(i, count, area), y: scaleY(v, yMax, area) }));
}

/**
 * SVG path `d` for a polyline through `points` (a 2px stroked line mark). Returns
 * '' for an empty set. A single point becomes a tiny horizontal dash so the line
 * is still visible (an isolated moveto renders nothing with round caps in some
 * engines).
 */
export function linePath(points: XY[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0];
    return `M${p.x} ${p.y}L${p.x + 0.01} ${p.y}`;
  }
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('');
}

/**
 * SVG path `d` for a filled area under `points`, closed down to `baselineY`
 * (the ~10%-opacity single-series wash). Returns '' for an empty set.
 */
export function areaPath(points: XY[], baselineY: number): string {
  if (points.length === 0) return '';
  const top = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('');
  const first = points[0];
  const last = points[points.length - 1];
  return `${top}L${last.x} ${round2(baselineY)}L${first.x} ${round2(baselineY)}Z`;
}

function clamp01(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
