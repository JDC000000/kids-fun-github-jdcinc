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
