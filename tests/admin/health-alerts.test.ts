// tests/admin/health-alerts.test.ts — pure unit tests for the dashboard health-alert
// logic. These SIMULATE failure / staleness cases (a failing source, a stale source, a
// never-run source) against a fixed `now`, so the display logic is exercised without a DB
// and without breaking live staging (whose sources are all healthy).
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CADENCE_SECONDS,
  STALE_CADENCE_GRACE,
  isSourceStale,
} from '../../lib/admin/dashboard';
import { formatCadence } from '../../lib/admin/format';

const NOW = Date.parse('2026-07-14T12:00:00Z');
const DAY = 86_400; // seconds
const agoMs = (seconds: number): number => NOW - seconds * 1000;

describe('isSourceStale', () => {
  it('a source that succeeded within its cadence is NOT stale', () => {
    // 1-day cadence, last success 2h ago → fresh.
    expect(
      isSourceStale({ lastSuccessAtMs: agoMs(2 * 3600), lastRunAtMs: agoMs(2 * 3600), cadenceSeconds: DAY }, NOW)
    ).toBe(false);
  });

  it('tolerates one missed cycle (within grace) — NOT stale', () => {
    // 1-day cadence, last success ~1.5 days ago (< grace=2× cadence) → still tolerated.
    expect(
      isSourceStale({ lastSuccessAtMs: agoMs(1.5 * DAY), lastRunAtMs: agoMs(1.5 * DAY), cadenceSeconds: DAY }, NOW)
    ).toBe(false);
  });

  it('flags a source whose last success is older than grace × cadence', () => {
    // 1-day cadence, last success 3 days ago (> grace=2 days) → stale.
    expect(
      isSourceStale({ lastSuccessAtMs: agoMs(3 * DAY), lastRunAtMs: agoMs(3 * DAY), cadenceSeconds: DAY }, NOW)
    ).toBe(true);
  });

  it('respects the boundary exactly at grace × cadence (not yet stale)', () => {
    const cadence = DAY;
    expect(
      isSourceStale(
        { lastSuccessAtMs: agoMs(STALE_CADENCE_GRACE * cadence), lastRunAtMs: agoMs(cadence), cadenceSeconds: cadence },
        NOW
      )
    ).toBe(false); // strictly greater-than is required to be stale
  });

  it('a source that has been attempted but NEVER succeeded is stale (failing source)', () => {
    expect(
      isSourceStale({ lastSuccessAtMs: null, lastRunAtMs: agoMs(3600), cadenceSeconds: DAY }, NOW)
    ).toBe(true);
  });

  it('a never-run source is NOT stale (no runs yet, not a failure)', () => {
    expect(isSourceStale({ lastSuccessAtMs: null, lastRunAtMs: null, cadenceSeconds: DAY }, NOW)).toBe(false);
  });

  it('uses the default cadence when none is configured', () => {
    // No cadence → falls back to DEFAULT_CADENCE_SECONDS (1 day); 3 days ago > 2× default → stale.
    expect(
      isSourceStale({ lastSuccessAtMs: agoMs(3 * DEFAULT_CADENCE_SECONDS), lastRunAtMs: agoMs(3 * DAY), cadenceSeconds: null }, NOW)
    ).toBe(true);
    // Within 2× the default → not stale.
    expect(
      isSourceStale({ lastSuccessAtMs: agoMs(0.5 * DEFAULT_CADENCE_SECONDS), lastRunAtMs: agoMs(3600), cadenceSeconds: 0 }, NOW)
    ).toBe(false);
  });

  it('scales the threshold with a longer (weekly) cadence', () => {
    const week = 7 * DAY;
    // 10 days since success, weekly cadence → 10d < 14d (2×) → not stale.
    expect(isSourceStale({ lastSuccessAtMs: agoMs(10 * DAY), lastRunAtMs: agoMs(10 * DAY), cadenceSeconds: week }, NOW)).toBe(false);
    // 20 days since success → 20d > 14d → stale.
    expect(isSourceStale({ lastSuccessAtMs: agoMs(20 * DAY), lastRunAtMs: agoMs(20 * DAY), cadenceSeconds: week }, NOW)).toBe(true);
  });
});

describe('formatCadence', () => {
  it('formats whole-day / hour / minute / second cadences', () => {
    expect(formatCadence(DAY)).toBe('1d');
    expect(formatCadence(2 * DAY)).toBe('2d');
    expect(formatCadence(6 * 3600)).toBe('6h');
    expect(formatCadence(30 * 60)).toBe('30m');
    expect(formatCadence(45)).toBe('45s');
  });

  it('returns an em dash for null / zero / negative', () => {
    expect(formatCadence(null)).toBe('—');
    expect(formatCadence(0)).toBe('—');
    expect(formatCadence(-100)).toBe('—');
  });
});
