import { describe, it, expect } from 'vitest';
import {
  bookingTag,
  daysSince,
  formatAges,
  formatChecked,
  formatCost,
  formatDistance,
  formatWhen,
  statusMeta,
} from '../app/preview/_data/format';

describe('formatAges', () => {
  it('formats a normal band', () => {
    expect(formatAges(5, 9)).toBe('Ages 5–9');
  });
  it('collapses equal bounds', () => {
    expect(formatAges(4, 4)).toBe('Age 4');
  });
  it('renders an open-at-zero band as "Under n"', () => {
    expect(formatAges(0, 5)).toBe('Under 6');
  });
  it('renders wide bands as "All ages" or "Ages n+"', () => {
    expect(formatAges(0, 99)).toBe('All ages');
    expect(formatAges(16, 99)).toBe('Ages 16+');
  });
});

describe('formatCost', () => {
  it('shows Free for free', () => {
    expect(formatCost({ costStatus: 'free' })).toBe('Free');
  });
  it('shows a single price', () => {
    expect(formatCost({ costStatus: 'known', costMinCad: 7 })).toBe('$7 approx.');
  });
  it('shows a range', () => {
    expect(formatCost({ costStatus: 'known', costMinCad: 3, costMaxCad: 4 })).toBe('$3–$4');
  });
  it('never presents unknown cost as free', () => {
    expect(formatCost({ costStatus: 'unknown' })).toBe('Cost — check source');
  });
});

describe('formatDistance', () => {
  it('renders area, drive time and km', () => {
    expect(formatDistance({ area: 'Trout Lake', driveMinutes: 12, distanceKm: 4.1 })).toBe(
      'Trout Lake · 12 min drive · 4.1 km',
    );
  });
});

describe('freshness math', () => {
  const now = '2026-07-13T09:00:00-07:00';
  it('counts whole days since last check', () => {
    expect(daysSince('2026-07-07T09:00:00-07:00', now)).toBe(6);
    expect(daysSince('2026-07-13T06:00:00-07:00', now)).toBe(0);
  });
  it('produces friendly checked copy', () => {
    expect(formatChecked('2026-07-13T06:00:00-07:00', now)).toBe('Checked today');
    expect(formatChecked('2026-07-12T06:00:00-07:00', now)).toBe('Checked yesterday');
    expect(formatChecked('2026-07-07T06:00:00-07:00', now)).toBe('Checked 6 days ago');
  });
});

describe('formatWhen (America/Vancouver)', () => {
  it('formats a whole-hour afternoon range tightly', () => {
    const when = formatWhen('2026-07-18T14:00:00-07:00', '2026-07-18T16:00:00-07:00');
    expect(when.day).toContain('Jul');
    expect(when.day).toContain('18');
    expect(when.day.startsWith('Sat')).toBe(true);
    expect(when.time).toBe('2 PM–4 PM');
  });
  it('keeps minutes when not on the hour', () => {
    const when = formatWhen('2026-07-19T10:00:00-07:00', '2026-07-19T11:30:00-07:00');
    expect(when.time).toBe('10 AM–11:30 AM');
  });
});

describe('statusMeta', () => {
  it('routes confirmed + bookable to the confirmed section', () => {
    expect(statusMeta('confirmed').section).toBe('confirmed');
    expect(statusMeta('bookable_open').section).toBe('confirmed');
  });
  it('routes not-yet-posted / seasonal / stale / cancelled to expected', () => {
    expect(statusMeta('schedule_not_published').section).toBe('expected');
    expect(statusMeta('seasonal_out_of_season').section).toBe('expected');
    expect(statusMeta('stale').section).toBe('expected');
    expect(statusMeta('cancelled').section).toBe('expected');
  });
  it('interpolates the season label', () => {
    expect(statusMeta('seasonal_out_of_season', 'December').copy).toContain('December');
  });
  it('always carries a text label and an icon (never colour-only)', () => {
    const m = statusMeta('confirmed');
    expect(m.label.length).toBeGreaterThan(0);
    expect(m.icon.length).toBeGreaterThan(0);
  });
});

describe('bookingTag', () => {
  it('maps booking types to copy', () => {
    expect(bookingTag('bookable_now')).toBe('Bookable now');
    expect(bookingTag('drop_in')).toBe('Drop-in');
    expect(bookingTag('registration')).toBe('Registration');
    expect(bookingTag('none')).toBe('');
  });
});
