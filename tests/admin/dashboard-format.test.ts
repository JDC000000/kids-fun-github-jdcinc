// tests/admin/dashboard-format.test.ts — pure display helpers for the admin dashboard.
import { describe, it, expect } from 'vitest';
import { formatAge, formatCount, formatDurationMs, formatTimestampUtc } from '../../lib/admin/format';

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

  it('formats counts with a zero fallback', () => {
    expect(formatCount(null)).toBe('0');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe('1,234');
  });
});
