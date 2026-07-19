// tests/admin/manual-listing-vocab.test.ts — G-T34-3 pure validation for manual intake.
import { describe, expect, it } from 'vitest';
import { parseManualListingInput, normalizeToUtcIso } from '@/app/admin/listings/_lib/vocab';

const base: Record<string, string> = {
  title: 'Family Storytime',
  sourceId: '',
  costStatus: 'unknown',
  statusState: 'manual_candidate',
  confidenceLabel: 'unscored',
  startDatetimeUtc: '2026-09-01T10:00',
};

describe('normalizeToUtcIso', () => {
  it('treats a bare datetime-local value as UTC', () => {
    expect(normalizeToUtcIso('2026-09-01T10:00')).toBe('2026-09-01T10:00:00.000Z');
  });
  it('parses a value already carrying Z', () => {
    expect(normalizeToUtcIso('2026-09-01T10:00:00Z')).toBe('2026-09-01T10:00:00.000Z');
  });
  it('returns null for empty and INVALID for garbage', () => {
    expect(normalizeToUtcIso('')).toBeNull();
    expect(normalizeToUtcIso('not-a-date')).toBe('INVALID');
  });
});

describe('parseManualListingInput', () => {
  it('accepts a valid timed listing', () => {
    const r = parseManualListingInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe('Family Storytime');
      expect(r.value.startDatetimeUtc).toBe('2026-09-01T10:00:00.000Z');
      expect(r.value.sourceId).toBeNull();
    }
  });

  it('accepts an open-hours listing with no start time', () => {
    const r = parseManualListingInput({ ...base, startDatetimeUtc: '', openHoursState: 'Daily 9am–5pm' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.startDatetimeUtc).toBeNull();
      expect(r.value.openHoursState).toBe('Daily 9am–5pm');
    }
  });

  it('requires a start time OR open hours (mirrors the DB CHECK)', () => {
    const r = parseManualListingInput({ ...base, startDatetimeUtc: '', openHoursState: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.startDatetimeUtc).toBeTruthy();
  });

  it('requires a title', () => {
    const r = parseManualListingInput({ ...base, title: '  ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.title).toBeTruthy();
  });

  it('rejects end before start', () => {
    const r = parseManualListingInput({ ...base, endDatetimeUtc: '2026-08-01T10:00' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.endDatetimeUtc).toBeTruthy();
  });

  it('requires both lat and lng or neither', () => {
    const only = parseManualListingInput({ ...base, venueLat: '49.28' });
    expect(only.ok).toBe(false);
    const both = parseManualListingInput({ ...base, venueName: 'Central Library', venueLat: '49.28', venueLng: '-123.11' });
    expect(both.ok).toBe(true);
    if (both.ok) {
      expect(both.value.venueLat).toBe(49.28);
      expect(both.value.venueLng).toBe(-123.11);
    }
  });

  it('rejects an out-of-range latitude and a bad cost status', () => {
    expect(parseManualListingInput({ ...base, venueLat: '999', venueLng: '0' }).ok).toBe(false);
    expect(parseManualListingInput({ ...base, costStatus: 'maybe' }).ok).toBe(false);
  });
});
