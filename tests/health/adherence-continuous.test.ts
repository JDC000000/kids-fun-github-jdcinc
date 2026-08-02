// tests/health/adherence-continuous.test.ts — the continuous cadence-adherence measure.
//
// WHY THIS FILE EXISTS. Adherence used to be a 0/1 switch worth 0.30 of
// computeSourceHealth, and worker/core/confidence.ts multiplies that health in as
// `volatility`. So a source one second past its grace threshold lost 0.30 of health in
// a single step and moved every one of its occurrences' confidence at once. The
// 2026-08-01 grace fix (SLA_CADENCE_GRACE 1 → 1.5) removed the *unsatisfiable* part of
// that bug but not the cliff: measured on real staging history, the worst in-grace gap
// observed is 1.4626× against a 1.5× boundary — 0.037× of headroom — and one real
// source (H.R. MacMillan Space Centre) has already recorded a 2.0005× gap, which under
// the boolean is a full 1 → 0 drop for one missed nightly cycle.
//
// These tests pin the replacement: a CONTINUOUS measure that is exactly 1.0 everywhere
// the boolean said "adherent" and decays smoothly beyond it. Two invariants matter most
// and are asserted as properties, not examples:
//   1. NO CLIFF   — no small change in lateness may cause a large change in the score.
//   2. NO DRIFT   — the boolean cadenceAdherent() must remain byte-identical in
//                   behaviour to the formula that shipped, so the SLA board, the
//                   health_state machine and the ≥95% P0 target are untouched.
import { describe, expect, it } from 'vitest';
import {
  adherenceFactor,
  cadenceAdherent,
  isFullyAdherent,
  computeSourceHealth,
  SLA_CADENCE_GRACE,
  DEFAULT_CADENCE_SECONDS,
} from '../../worker/health/sla';

const NOW = Date.parse('2026-07-20T12:00:00Z');
const DAY = 86_400;
const HOUR = 3600;
/** A source whose last success was `x` cadences ago. */
const at = (x: number, cadenceSeconds: number = DAY) => ({
  lastSuccessAtMs: NOW - x * cadenceSeconds * 1000,
  cadenceSeconds,
});

describe('adherenceFactor — shape', () => {
  it('is exactly 1.0 anywhere inside the grace window, at every cadence', () => {
    for (const cadence of [HOUR, 2 * HOUR, DAY, 7 * DAY]) {
      for (const x of [0, 0.25, 0.5, 0.9999, 1.0, 1.0007, 1.25, 1.4626, SLA_CADENCE_GRACE]) {
        expect(adherenceFactor(at(x, cadence), NOW), `x=${x} cadence=${cadence}s`).toBe(1);
      }
    }
  });

  it('decays as grace ÷ x beyond the grace window', () => {
    // The only constant in the decay is the grace that already exists. grace/x at
    // x=grace is exactly 1, so the curve joins the plateau with no step.
    expect(adherenceFactor(at(2.0), NOW)).toBeCloseTo(0.75, 10); // one full cycle missed
    expect(adherenceFactor(at(3.0), NOW)).toBeCloseTo(0.5, 10);
    expect(adherenceFactor(at(6.0), NOW)).toBeCloseTo(0.25, 10);
    expect(adherenceFactor(at(24.0), NOW)).toBeCloseTo(0.0625, 10);
  });

  it('is monotonically non-increasing in lateness', () => {
    let prev = Infinity;
    for (let x = 0; x <= 40; x += 0.01) {
      const v = adherenceFactor(at(x), NOW);
      expect(v, `x=${x.toFixed(2)} rose above the previous value`).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });

  it('stays inside [0,1] and tends to 0 for a long-dead source', () => {
    for (let x = 0; x <= 500; x += 0.37) {
      const v = adherenceFactor(at(x), NOW);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // No floor: a source dead for a year must not keep earning health it hasn't
    // delivered. (freshnessFactor floors at 0.2 because confidence MULTIPLIES it and a
    // zero would annihilate the product; computeSourceHealth ADDS this term, so 0 is
    // safe here and is what the boolean already gave.)
    expect(adherenceFactor(at(365), NOW)).toBeLessThan(0.01);
  });

  it('a source that has NEVER succeeded scores 0, exactly as the boolean did', () => {
    expect(adherenceFactor({ lastSuccessAtMs: null, cadenceSeconds: DAY }, NOW)).toBe(0);
    expect(adherenceFactor({ lastSuccessAtMs: null, cadenceSeconds: null }, NOW)).toBe(0);
  });

  it('falls back to the default cadence when the source has none, and ignores clock skew', () => {
    const noCadence = { lastSuccessAtMs: NOW - 3 * DEFAULT_CADENCE_SECONDS * 1000, cadenceSeconds: null };
    expect(adherenceFactor(noCadence, NOW)).toBeCloseTo(0.5, 10);
    expect(adherenceFactor({ lastSuccessAtMs: NOW - 3 * DEFAULT_CADENCE_SECONDS * 1000, cadenceSeconds: 0 }, NOW))
      .toBeCloseTo(0.5, 10);
    // A last-success in the FUTURE (clock skew between the worker and Postgres) must
    // clamp to "on time", never produce a negative or >1 factor — same as freshnessFactor.
    expect(adherenceFactor({ lastSuccessAtMs: NOW + 60_000, cadenceSeconds: DAY }, NOW)).toBe(1);
  });
});

describe('adherenceFactor — NO CLIFF (the reason this change exists)', () => {
  it('never moves more than 0.001 of health for 0.001× of extra lateness', () => {
    // The boolean's worst step was 1.000 of adherence = 0.300 of health, at the grace
    // boundary. Anything of that order is a cliff by definition. The bound below is
    // ~400× tighter and is a property over the whole domain, not a spot check.
    let worst = 0;
    let worstAt = 0;
    for (let x = 0; x <= 40; x += 0.001) {
      const step = Math.abs(adherenceFactor(at(x + 0.001), NOW) - adherenceFactor(at(x), NOW));
      if (step > worst) {
        worst = step;
        worstAt = x;
      }
    }
    expect(worst, `largest step ${worst} at x≈${worstAt.toFixed(3)}`).toBeLessThan(0.001);
    expect(0.3 * worst).toBeLessThan(0.0003); // in health-score terms
  });

  it('is continuous across the grace boundary itself', () => {
    const eps = 1e-9;
    const justInside = adherenceFactor(at(SLA_CADENCE_GRACE - eps), NOW);
    const exactly = adherenceFactor(at(SLA_CADENCE_GRACE), NOW);
    const justOutside = adherenceFactor(at(SLA_CADENCE_GRACE + eps), NOW);
    expect(justInside).toBe(1);
    expect(exactly).toBe(1);
    expect(justOutside).toBeCloseTo(1, 8); // the old code dropped to 0.0 right here
  });

  it('the real 2.0005× missed cycle no longer zeroes the term', () => {
    // H.R. MacMillan Space Centre, staging, observed 2026-08-01: a 2880.65 min gap on a
    // 1440 min cadence. Under the boolean this was 1 → 0; a full 0.30 of health for one
    // missed nightly run.
    const observed = adherenceFactor(at(2.0005), NOW);
    expect(observed).toBeGreaterThan(0.7);
    expect(observed).toBeLessThan(0.76);
  });
});

describe('cadenceAdherent — the boolean is UNCHANGED', () => {
  // The SLA board, the ≥95% P0 target and the health_state machine all key off this
  // predicate. This change must not move any of them, so the boolean is re-derived from
  // the continuous factor and pinned here against the ORIGINAL shipped formula.
  const originalFormula = (
    input: { lastSuccessAtMs: number | null; cadenceSeconds: number | null },
    nowMs: number,
    grace: number = SLA_CADENCE_GRACE
  ): boolean => {
    if (input.lastSuccessAtMs == null) return false;
    const cadence =
      input.cadenceSeconds != null && input.cadenceSeconds > 0 ? input.cadenceSeconds : DEFAULT_CADENCE_SECONDS;
    return nowMs - input.lastSuccessAtMs <= cadence * 1000 * grace;
  };

  it('agrees with the pre-change formula on an exhaustive table', () => {
    const cadences = [null, 0, -1, 60, HOUR, 2 * HOUR, DAY, 7 * DAY];
    const lags = [
      null, -60, 0, 1, 1800, HOUR, HOUR + 30, 1.4626 * HOUR, 1.5 * HOUR, 1.5 * HOUR + 0.001,
      2 * HOUR, DAY - 1, DAY, DAY + 1, DAY + 60, 1.5 * DAY - 1, 1.5 * DAY, 1.5 * DAY + 1,
      2 * DAY, 2.0005 * DAY, 5.38 * DAY, 7.49 * DAY, 12 * DAY, 24 * DAY, 365 * DAY,
    ];
    for (const cadenceSeconds of cadences) {
      for (const lag of lags) {
        const input = { lastSuccessAtMs: lag == null ? null : NOW - lag * 1000, cadenceSeconds };
        expect(cadenceAdherent(input, NOW), `cadence=${cadenceSeconds} lag=${lag}`).toBe(
          originalFormula(input, NOW)
        );
      }
    }
  });

  it('is exactly "the continuous factor is at full value"', () => {
    for (const x of [0, 1, 1.4999, SLA_CADENCE_GRACE, 1.5001, 2, 24]) {
      expect(cadenceAdherent(at(x), NOW)).toBe(isFullyAdherent(adherenceFactor(at(x), NOW)));
    }
    expect(cadenceAdherent({ lastSuccessAtMs: null, cadenceSeconds: DAY }, NOW)).toBe(false);
  });

  it('honours a caller-supplied grace on both forms', () => {
    expect(cadenceAdherent(at(1.9), NOW, 2)).toBe(true);
    expect(adherenceFactor(at(1.9), NOW, 2)).toBe(1);
    expect(adherenceFactor(at(4), NOW, 2)).toBeCloseTo(0.5, 10);
  });
});

describe('computeSourceHealth — the score is continuous, the STATE is not', () => {
  const perfect = { successRate: 1, parseYieldRate: 1, attempted: 5 };

  it('weights adherence at 0.30 of the score, continuously', () => {
    expect(computeSourceHealth({ ...perfect, adherence: 1 }).score).toBe(1);
    expect(computeSourceHealth({ ...perfect, adherence: 0.75 }).score).toBe(0.93); // 0.5+0.225+0.2
    expect(computeSourceHealth({ ...perfect, adherence: 0.5 }).score).toBe(0.85);
    expect(computeSourceHealth({ ...perfect, adherence: 0 }).score).toBe(0.7);
  });

  it('clamps a nonsense adherence into [0,1] rather than corrupting the score', () => {
    expect(computeSourceHealth({ ...perfect, adherence: 5 }).score).toBe(1);
    expect(computeSourceHealth({ ...perfect, adherence: -3 }).score).toBe(0.7);
    expect(computeSourceHealth({ ...perfect, adherence: Number.NaN }).score).toBe(0.7);
  });

  it('keeps the health_state gradient keyed off FULL adherence, unchanged', () => {
    // Deliberately still a step: health_state drives the operational SLA board
    // ("is this source meeting its cadence — yes or no"), which is a pass/fail question.
    // Only the numeric score, which confidence multiplies in, becomes continuous.
    expect(computeSourceHealth({ ...perfect, adherence: 1 }).state).toBe('healthy');
    expect(computeSourceHealth({ ...perfect, adherence: 0.999 }).state).toBe('stale');
    expect(computeSourceHealth({ ...perfect, adherence: 0 }).state).toBe('stale');
    // precedence is unchanged: failing beats stale
    expect(computeSourceHealth({ successRate: 0.4, parseYieldRate: 1, attempted: 5, adherence: 0 }).state)
      .toBe('failing');
    expect(computeSourceHealth({ successRate: null, parseYieldRate: null, attempted: 0, adherence: 1 }))
      .toMatchObject({ state: 'unknown', score: null });
    expect(computeSourceHealth({ successRate: 0.8, parseYieldRate: 1, attempted: 5, adherence: 1 }).state)
      .toBe('degraded');
  });

  it('a partially-adherent source scores between the two boolean outcomes', () => {
    const wasTrue = computeSourceHealth({ ...perfect, adherence: 1 }).score!;
    const wasFalse = computeSourceHealth({ ...perfect, adherence: 0 }).score!;
    const now = computeSourceHealth({ ...perfect, adherence: adherenceFactor(at(2.0005), NOW) }).score!;
    expect(now).toBeGreaterThan(wasFalse);
    expect(now).toBeLessThan(wasTrue);
  });
});
