// tests/admin/dashboard-format.test.ts — pure display helpers for the admin dashboard.
import { describe, it, expect } from 'vitest';
import {
  EM_DASH,
  formatAge,
  formatCount,
  formatDurationMs,
  formatMeasure,
  formatTimestampUtc,
} from '../../lib/admin/format';

describe('admin dashboard format helpers', () => {
  it('formats UTC timestamps compactly and handles nulls', () => {
    expect(formatTimestampUtc('2026-07-14T03:33:00.110Z')).toBe('2026-07-14 03:33:00Z');
    expect(formatTimestampUtc(null)).toBe('—');
    expect(formatTimestampUtc('not-a-date')).toBe('—');
  });

  it('formats relative age against a fixed now', () => {
    const now = Date.parse('2026-07-14T12:00:00Z');
    expect(formatAge(null, now)).toBe('never');
    expect(formatAge('2026-07-14T11:59:40Z', now)).toBe('just now');
    expect(formatAge('2026-07-14T11:30:00Z', now)).toBe('30m ago');
    expect(formatAge('2026-07-14T09:00:00Z', now)).toBe('3h ago');
    expect(formatAge('2026-07-11T12:00:00Z', now)).toBe('3d ago');
  });

  it('formats durations', () => {
    expect(formatDurationMs(null)).toBe('—');
    expect(formatDurationMs(850)).toBe('850ms');
    expect(formatDurationMs(11222)).toBe('11.2s');
  });

  it('formats known counts, including a genuine zero', () => {
    // A real, measured 0 must stay a plainly visible "0" — that is the traffic-cliff
    // signal the operating dashboards exist to catch.
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe('1,234');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The absence/zero boundary (H1 follow-up, QA A1).
//
// H1 typed measures `number | null` so that a surface forgetting the pre-history
// distinction would fail to COMPILE. formatCount() punched straight through that: it
// accepted null and returned "0", so `<td>{formatCount(point.dau)}</td>` typechecked,
// linted and rendered a confident zero for a period that never existed.
// ─────────────────────────────────────────────────────────────────────────────

describe('formatCount / formatMeasure — "measured zero" vs. "nothing to measure"', () => {
  it('COMPILE-TIME GUARD: formatCount rejects a nullable measure', () => {
    // These @ts-expect-error directives ARE the assertion, and they are checked by
    // `tsc --noEmit` in CI, not at runtime. If someone widens formatCount's signature
    // back to `number | null | undefined`, each suppression becomes an UNUSED
    // suppression, which TypeScript reports as an error — so the typecheck fails and
    // says exactly why. This is the strongest available proof of H1's central claim:
    // getting this wrong is a compile error, not a silent lie.
    const measure: number | null = null;

    // @ts-expect-error — a nullable measure must not be formattable as a known count.
    formatCount(measure);
    // @ts-expect-error — null is not a count.
    formatCount(null);
    // @ts-expect-error — undefined is not a count.
    formatCount(undefined);

    // The escape hatches remain available, but only when stated EXPLICITLY at the call
    // site, where a reviewer can see the claim being made and judge it.
    expect(formatCount(measure ?? 0)).toBe('0');
    expect(formatMeasure(measure)).toBe(EM_DASH);
  });

  it('formatMeasure renders absence as an em-dash, never as a zero', () => {
    expect(formatMeasure(null)).toBe(EM_DASH);
    expect(formatMeasure(undefined)).toBe(EM_DASH);
    expect(formatMeasure(Number.NaN)).toBe(EM_DASH);
    expect(formatMeasure(Number.POSITIVE_INFINITY)).toBe(EM_DASH);
  });

  it('NO-REGRESSION: formatMeasure renders a genuine zero as a visible 0', () => {
    // The mirror-image bug. If absence and a measured zero both rendered as "—", a
    // real outage would be indistinguishable from pre-history and the dashboard would
    // go blind — worse than the defect being fixed, because it fails silent.
    expect(formatMeasure(0)).toBe('0');
    expect(formatMeasure(0)).not.toBe(EM_DASH);
    expect(formatMeasure(1234)).toBe('1,234');
  });

  it('formatCount does not fabricate a zero for a non-number', () => {
    expect(formatCount(Number.NaN)).toBe(EM_DASH);
  });
});
