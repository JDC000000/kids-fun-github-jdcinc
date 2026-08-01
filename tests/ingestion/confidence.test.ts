import { describe, expect, it } from 'vitest';
import {
  authorityFactor,
  parseQualityFactor,
  freshnessFactor,
  volatilityFactor,
  scoreToLabel,
  statusForConfidence,
  computeConfidence,
  type ParseQualityInput,
} from '../../worker/core/confidence';

const DAY = 24 * 60 * 60; // seconds
const NOW = 1_700_000_000_000; // fixed ms, so freshness math is deterministic

const BEST_PARSE: ParseQualityInput = {
  categoryCertainty: 'specific',
  explicitCategoryHint: true,
  hasStartDatetime: true,
  hasOpenHours: false,
  costStatus: 'known',
  ageResolved: true,
};

// Mirrors the NoopAdapter fixture: generic category, has a start time, unknown
// cost, no age wording. This is the record the ingest-runner test asserts on.
const NOOP_PARSE: ParseQualityInput = {
  categoryCertainty: 'generic',
  explicitCategoryHint: false,
  hasStartDatetime: true,
  hasOpenHours: false,
  costStatus: 'unknown',
  ageResolved: null,
};

describe('BR-13 confidence — authority factor', () => {
  it('ranks official > editorial > partner > manual, unknown → partner-equivalent', () => {
    expect(authorityFactor('official')).toBe(1.0);
    expect(authorityFactor('editorial')).toBe(0.75);
    expect(authorityFactor('partner')).toBe(0.6);
    expect(authorityFactor('manual')).toBe(0.4);
    expect(authorityFactor(null)).toBe(0.6);
    expect(authorityFactor('nonsense')).toBe(0.6);
  });
});

describe('BR-13 confidence — parse quality factor', () => {
  it('a fully-structured record scores 1.0', () => {
    expect(parseQualityFactor(BEST_PARSE)).toBeCloseTo(1.0, 5);
  });

  it('the generic/unknown Noop-style record scores well below 1.0', () => {
    // 0.35*0.2 + 0.25*1 + 0.20*0.2 + 0.20*0.6 = 0.48
    expect(parseQualityFactor(NOOP_PARSE)).toBeCloseTo(0.48, 5);
  });

  it('an explicit hint beats a title-rule match beats the generic fallback', () => {
    const base = { hasStartDatetime: true, hasOpenHours: false, costStatus: 'known', ageResolved: true } as const;
    const hint = parseQualityFactor({ ...base, categoryCertainty: 'specific', explicitCategoryHint: true });
    const rule = parseQualityFactor({ ...base, categoryCertainty: 'specific', explicitCategoryHint: false });
    const fallback = parseQualityFactor({ ...base, categoryCertainty: 'generic', explicitCategoryHint: false });
    expect(hint).toBeGreaterThan(rule);
    expect(rule).toBeGreaterThan(fallback);
  });

  it('open-hours records get a time anchor just below a fixed start time', () => {
    const start = parseQualityFactor({ ...BEST_PARSE, hasStartDatetime: true, hasOpenHours: false });
    const openHours = parseQualityFactor({ ...BEST_PARSE, hasStartDatetime: false, hasOpenHours: true });
    const neither = parseQualityFactor({ ...BEST_PARSE, hasStartDatetime: false, hasOpenHours: false });
    expect(start).toBeGreaterThan(openHours);
    expect(openHours).toBeGreaterThan(neither);
  });

  it('absent age is neutral, ambiguous age is penalised below a resolved age', () => {
    const resolved = parseQualityFactor({ ...NOOP_PARSE, ageResolved: true });
    const absent = parseQualityFactor({ ...NOOP_PARSE, ageResolved: null });
    const ambiguous = parseQualityFactor({ ...NOOP_PARSE, ageResolved: false });
    expect(resolved).toBeGreaterThan(absent);
    expect(absent).toBeGreaterThan(ambiguous);
  });
});

describe('BR-13 confidence — freshness factor', () => {
  it('first-ever check (null last-check) is maximally fresh', () => {
    expect(freshnessFactor(null, DAY, NOW)).toBe(1.0);
  });

  it('within one cadence is fully fresh, then decays reciprocally to a floor', () => {
    expect(freshnessFactor(NOW - 0.5 * DAY * 1000, DAY, NOW)).toBe(1.0);
    expect(freshnessFactor(NOW - DAY * 1000, DAY, NOW)).toBe(1.0);
    expect(freshnessFactor(NOW - 2 * DAY * 1000, DAY, NOW)).toBeCloseTo(0.5, 5);
    expect(freshnessFactor(NOW - 100 * DAY * 1000, DAY, NOW)).toBe(0.2); // floored
  });

  it('falls back to the default cadence when none is configured', () => {
    expect(freshnessFactor(NOW - 2 * DAY * 1000, null, NOW)).toBeCloseTo(0.5, 5);
  });
});

describe('BR-13 confidence — volatility factor', () => {
  it('no track record → neutral discount; otherwise the source-health score, floored', () => {
    expect(volatilityFactor(null)).toBe(0.7);
    expect(volatilityFactor(1.0)).toBe(1.0);
    expect(volatilityFactor(0.85)).toBe(0.85);
    expect(volatilityFactor(0.05)).toBe(0.3); // floored
  });
});

describe('BR-13 confidence — label thresholds + gate', () => {
  it('maps score to the DB confidence_label enum', () => {
    expect(scoreToLabel(0.9)).toBe('high');
    expect(scoreToLabel(0.75)).toBe('high');
    expect(scoreToLabel(0.6)).toBe('medium');
    expect(scoreToLabel(0.5)).toBe('medium');
    expect(scoreToLabel(0.3)).toBe('low');
    expect(scoreToLabel(0.25)).toBe('low');
    expect(scoreToLabel(0.1)).toBe('unscored');
  });

  it('gates only medium/high to confirmed; low/unscored → needs_review', () => {
    expect(statusForConfidence('high')).toBe('confirmed');
    expect(statusForConfidence('medium')).toBe('confirmed');
    expect(statusForConfidence('low')).toBe('needs_review');
    expect(statusForConfidence('unscored')).toBe('needs_review');
  });
});

describe('BR-13 confidence — whole formula', () => {
  it('a fully-structured record on a healthy official source is high → confirmed', () => {
    const result = computeConfidence({
      authorityTier: 'official',
      parseQuality: BEST_PARSE,
      lastCheckAtMs: null,
      cadenceSeconds: DAY,
      healthScore: 1.0,
      nowMs: NOW,
    });
    expect(result.score).toBeCloseTo(1.0, 5);
    expect(result.label).toBe('high');
    expect(statusForConfidence(result.label)).toBe('confirmed');
  });

  it('the Noop-style generic record on an unproven source is low → needs_review', () => {
    const result = computeConfidence({
      authorityTier: 'official',
      parseQuality: NOOP_PARSE,
      lastCheckAtMs: null, // fresh source
      cadenceSeconds: DAY,
      healthScore: null, // no history → neutral volatility 0.7
      nowMs: NOW,
    });
    // 1.0 × 0.48 × 1.0 × 0.7 = 0.336
    expect(result.score).toBeCloseTo(0.336, 3);
    expect(result.label).toBe('low');
    expect(statusForConfidence(result.label)).toBe('needs_review');
  });

  // ── REGRESSION (2026-08-01) — the cadence-adherence cliff ────────────────────
  // `volatility` is computeSourceHealth's score, of which cadence adherence is a hard
  // 0/1 term worth 0.30. Because confidence MULTIPLIES, that single bit moved every
  // record of a source across the confirm line at once. With SLA_CADENCE_GRACE = 1 an
  // on-time source scored non-adherent on essentially every run (the gap between
  // scheduled runs is `cadence + jitter`, jitter always > 0), so a perfectly healthy
  // official source ran permanently at health 0.70 — and staging's hourly sources
  // flickered between 0.63 and 0.95 run-to-run, reclassifying thousands of occurrences
  // each way. These pin the two ends of that swing so the cliff stays visible.
  it('a healthy on-cadence official source keeps a well-parsed record confirmed', () => {
    const adherentHealth = 0.5 * 1.0 + 0.3 * 1 + 0.2 * 1.0; // 1.0 — success, adherent, yielding
    const result = computeConfidence({
      authorityTier: 'official',
      parseQuality: BEST_PARSE,
      lastCheckAtMs: null,
      cadenceSeconds: 3600,
      healthScore: adherentHealth,
      nowMs: NOW,
    });
    expect(result.label).toBe('high');
    expect(statusForConfidence(result.label)).toBe('confirmed');
  });

  it('losing ONLY the adherence bit is enough to demote a mid-quality record', () => {
    const shared = {
      authorityTier: 'official' as const,
      parseQuality: NOOP_PARSE, // parse quality is identical in both runs
      lastCheckAtMs: null,
      cadenceSeconds: 3600,
      nowMs: NOW,
    };
    // Same source, same records, same success rate and parse yield — only `adherent` differs.
    const adherent = computeConfidence({ ...shared, healthScore: 0.5 * 0.9 + 0.3 + 0.2 }); // 0.95
    const notAdherent = computeConfidence({ ...shared, healthScore: 0.5 * 0.9 + 0.0 + 0.2 }); // 0.65

    // A 0.30 swing in one factor is a 32% swing in the product — two threshold widths.
    expect(adherent.score - notAdherent.score).toBeGreaterThan(0.13);
    expect(adherent.factors.volatility).toBe(0.95);
    expect(notAdherent.factors.volatility).toBe(0.65);
  });

  it('a low-authority source drags an otherwise-good record below the confirm line', () => {
    const result = computeConfidence({
      authorityTier: 'manual', // 0.4
      parseQuality: BEST_PARSE, // 1.0
      lastCheckAtMs: null,
      cadenceSeconds: DAY,
      healthScore: 1.0,
      nowMs: NOW,
    });
    expect(result.score).toBeCloseTo(0.4, 5);
    expect(result.label).toBe('low');
    expect(statusForConfidence(result.label)).toBe('needs_review');
  });
});
