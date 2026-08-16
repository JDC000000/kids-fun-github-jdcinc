// tests/email/when-line.test.ts — the digest's "when" line must describe an occurrence the same
// way the card does.
//
// The weekly email is the irreversible channel: by the time anyone notices a wrong date, the
// parent has already read it and possibly acted on it, and there is no way to take it back
// (lib/email/format.ts states this rule for cost; it applies at least as strongly to dates).
// So the same two defects the effectiveness testing found on the card are pinned here:
//   · a multi-week programme described by its first day alone — Richmond Public Library's summer
//     programmes run 24 Jun → 1 Sep as ONE occurrence, and "Wed, Jun 24, 12:00 a.m." reads as an
//     event that finished weeks ago;
//   · a standing open-hours record given a generic placeholder while the venue's own published
//     hours sat unread in the read model.
import { describe, expect, it } from 'vitest';
import { formatWhen } from '@/lib/email/format';
import { makeListing } from '@/lib/search/__fixtures__/factory';

describe('weekly digest when-line', () => {
  it('prints a multi-day programme as a span, not as its first day', () => {
    const listing = makeListing({
      activityName: 'Teen Summer Reading Club 2026',
      startDatetimeUtc: '2026-06-24T07:00:00.000Z', // 2026-06-24 00:00 Vancouver
      endDatetimeUtc: '2026-09-01T06:59:59.000Z', // 2026-08-31 23:59 Vancouver
    });

    expect(formatWhen(listing)).toBe('Jun 24 – Aug 31');
  });

  it('leaves an ordinary same-day occurrence exactly as it was', () => {
    const listing = makeListing({
      startDatetimeUtc: '2026-08-16T21:00:00.000Z', // 2026-08-16 14:00 Vancouver
      endDatetimeUtc: '2026-08-16T23:30:00.000Z',
    });

    const when = formatWhen(listing);
    expect(when).toContain('Aug 16');
    expect(when).toContain('2');
    expect(when).not.toContain('–'); // a single day is not a range
  });

  it('does not treat an occurrence that merely crosses UTC midnight as multi-day', () => {
    const listing = makeListing({
      startDatetimeUtc: '2026-08-17T13:00:00.000Z', // 2026-08-17 06:00 Vancouver
      endDatetimeUtc: '2026-08-18T04:45:00.000Z', // 2026-08-17 21:45 Vancouver
    });

    expect(formatWhen(listing)).not.toContain('–');
    expect(formatWhen(listing)).toContain('Aug 17');
  });

  it('gives a standing open-hours record the venue\'s own published hours', () => {
    const listing = makeListing({
      activityName: 'General Admission',
      openHours: true,
      openHoursLabel: 'Daily 10 AM–5 PM',
    });

    expect(formatWhen(listing)).toBe('Daily 10 AM–5 PM');
  });

  it('says plainly that it has no hours rather than inventing a date', () => {
    const listing = makeListing({ openHours: true });

    const when = formatWhen(listing);
    expect(when).toBe('Open hours — see listing');
    expect(when).not.toContain('1969');
    expect(when).not.toContain(String(new Date().getFullYear()));
  });

  it('never lets a backwards end datetime widen the span', () => {
    const listing = makeListing({
      startDatetimeUtc: '2026-08-16T21:00:00.000Z',
      endDatetimeUtc: '2026-06-01T00:00:00.000Z',
    });

    expect(formatWhen(listing)).toContain('Aug 16');
    expect(formatWhen(listing)).not.toContain('Jun');
  });
});
