// components/charts/scale.test.ts — pure chart-geometry maths (M5 / T32, G-T32-6).
// No React, no DOM, no DB: the SVG plotting logic pinned exactly, incl. the empty/
// zero-data edge cases that must never divide by zero or produce a NaN path.
import { describe, expect, it } from 'vitest';
import {
  areaPath,
  axisMax,
  axisTicks,
  linePath,
  niceCeil,
  plotArea,
  projectValues,
  scaleX,
  scaleY,
  type PlotBox,
} from './scale';

const UNIT_BOX: PlotBox = { width: 100, height: 100, padTop: 0, padRight: 0, padBottom: 0, padLeft: 0 };
const AREA = plotArea(UNIT_BOX);

describe('niceCeil', () => {
  it('rounds up to the nearest 1/2/5×10ⁿ', () => {
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(2)).toBe(2);
    expect(niceCeil(3)).toBe(5);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(12)).toBe(20);
    expect(niceCeil(45)).toBe(50);
    expect(niceCeil(100)).toBe(100);
    expect(niceCeil(150)).toBe(200);
    expect(niceCeil(0.3)).toBeCloseTo(0.5, 10);
  });

  it('returns 1 for zero / negative / non-finite (never a zero-height scale)', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-5)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
    expect(niceCeil(Infinity)).toBe(1);
  });
});

describe('axisTicks / axisMax', () => {
  it('produces clean, evenly-spaced ticks from 0 whose top ≥ the data max', () => {
    expect(axisTicks(100)).toEqual([0, 50, 100]);
    expect(axisTicks(10)).toEqual([0, 5, 10]);
    expect(axisTicks(3)).toEqual([0, 1, 2, 3]);
    for (const raw of [1, 7, 23, 99, 100, 251, 4000]) {
      const ticks = axisTicks(raw);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(raw);
    }
  });

  it('is robust to a zero/empty dataset', () => {
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(axisTicks(-4)).toEqual([0, 1]);
    expect(axisMax(axisTicks(0))).toBe(1);
    expect(axisMax([])).toBe(1);
    expect(axisMax([0, 50, 100])).toBe(100);
  });
});

describe('plotArea', () => {
  it('subtracts padding and never returns a negative dimension', () => {
    const a = plotArea({ width: 200, height: 120, padTop: 10, padRight: 20, padBottom: 30, padLeft: 40 });
    expect(a).toMatchObject({ left: 40, right: 180, top: 10, bottom: 90, w: 140, h: 80 });
    const tiny = plotArea({ width: 10, height: 10, padTop: 20, padRight: 20, padBottom: 20, padLeft: 20 });
    expect(tiny.w).toBe(0);
    expect(tiny.h).toBe(0);
  });
});

describe('scaleX', () => {
  it('spreads points evenly and centres a single point', () => {
    expect(scaleX(0, 2, AREA)).toBe(0);
    expect(scaleX(1, 2, AREA)).toBe(100);
    expect(scaleX(1, 3, AREA)).toBe(50);
    expect(scaleX(0, 1, AREA)).toBe(50); // lone point centred, no divide-by-zero
  });
});

describe('scaleY', () => {
  it('anchors 0 at the baseline and yMax at the top', () => {
    expect(scaleY(0, 10, AREA)).toBe(100); // bottom
    expect(scaleY(10, 10, AREA)).toBe(0); // top
    expect(scaleY(5, 10, AREA)).toBe(50);
  });

  it('pins to the baseline for a non-positive max or non-finite value', () => {
    expect(scaleY(5, 0, AREA)).toBe(100);
    expect(scaleY(Number.NaN, 10, AREA)).toBe(100);
  });
});

describe('projectValues / linePath / areaPath', () => {
  it('maps values to points and builds the expected SVG paths', () => {
    const pts = projectValues([0, 5, 10], 10, AREA);
    expect(pts).toEqual([
      { x: 0, y: 100 },
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ]);
    expect(linePath(pts)).toBe('M0 100L50 50L100 0');
    expect(areaPath(pts, AREA.bottom)).toBe('M0 100L50 50L100 0L100 100L0 100Z');
  });

  it('handles empty and single-point series without producing NaN', () => {
    expect(linePath([])).toBe('');
    expect(areaPath([], 100)).toBe('');
    const one = projectValues([7], 10, AREA);
    expect(one).toEqual([{ x: 50, y: 30 }]);
    expect(linePath(one)).toBe('M50 30L50.01 30'); // tiny dash so the mark is visible
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Null (unmeasurable) values — H1.
//
// A period before the data source existed must be a GAP, not a point on the baseline.
// Visually those are opposite claims: a gap says "we cannot say", the baseline says
// "we measured zero". Weeks of pre-instrumentation days drawn on the baseline is what
// made the product-health chart read as a sustained traffic outage.
// ─────────────────────────────────────────────────────────────────────────────

describe('null handling — a gap is not a zero', () => {
  it('projects null to a null POINT, and a real 0 onto the baseline', () => {
    // The distinction the whole fix rests on: 0 is plotted and plainly visible;
    // null is absent. If null ever projects to y=bottom these are indistinguishable.
    expect(projectValues([null, 0, 10], 10, AREA)).toEqual([null, { x: 50, y: 100 }, { x: 100, y: 0 }]);
  });

  it('breaks the line at a gap instead of interpolating across it', () => {
    // Two sub-paths (two 'M' commands), NOT one line drawn straight through the gap —
    // an interpolated segment would invent data for a day nobody measured.
    // Each side of the gap is a run of ONE point, so each gets the tiny-dash form —
    // two separate sub-paths, neither connected to the other.
    const pts = projectValues([10, null, 10], 10, AREA);
    const d = linePath(pts);
    expect(d).toBe('M0 0L0.01 0M100 0L100.01 0');
    expect(d.split('M').length - 1).toBe(2);
  });

  it('keeps an isolated measured point visible between two gaps', () => {
    // A single real day surrounded by unmeasurable ones still gets the tiny-dash
    // treatment; otherwise the one day that DOES have data renders as nothing.
    expect(linePath(projectValues([null, 5, null], 10, AREA))).toBe('M50 50L50.01 50');
  });

  it('does not wash the area under a gap', () => {
    // Each run closes to the baseline on its own. A fill carried across the gap would
    // reassert the "we measured this" claim the gap exists to deny.
    const d = areaPath(projectValues([10, null, 10], 10, AREA), AREA.bottom);
    expect(d).toBe('M0 0L0 100L0 100ZM100 0L100 100L100 100Z');
    expect(d.split('Z').length - 1).toBe(2);
  });

  it('renders an all-null series as nothing at all rather than a flat baseline', () => {
    // The literal defect: 27 of 30 pre-instrumentation days drawing a flat zero line.
    const pts = projectValues([null, null, null], 10, AREA);
    expect(pts).toEqual([null, null, null]);
    expect(linePath(pts)).toBe('');
    expect(areaPath(pts, AREA.bottom)).toBe('');
  });

  it('leaves an all-numeric series byte-for-byte unchanged (no regression)', () => {
    const pts = projectValues([0, 5, 10], 10, AREA);
    expect(linePath(pts)).toBe('M0 100L50 50L100 0');
    expect(areaPath(pts, AREA.bottom)).toBe('M0 100L50 50L100 0L100 100L0 100Z');
  });
});
