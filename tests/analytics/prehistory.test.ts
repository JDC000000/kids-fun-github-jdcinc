// tests/analytics/prehistory.test.ts — the shared "measured zero vs. nothing to
// measure" primitive (H1).
//
// Pure, no database, no clock. This is the rule six shipped defects came from getting
// wrong, in both directions, so both directions are pinned here:
//
//   • UNDER-suppression — the original bug. A period that closed before a data source
//     existed rendered as a confident 0, which on a dashboard reads as an outage.
//   • OVER-suppression — the mirror-image bug an anxious fix produces. A genuinely
//     quiet period AFTER the source existed must keep reading 0. Swallowing that into
//     "no data" hides the exact traffic cliff the dashboards exist to catch, and is
//     the more dangerous of the two because it fails silent.
//
// It also pins the STRUCTURAL property H1 was raised to establish: there is exactly
// one definition of this rule in the codebase. Re-derivation per surface is what
// failed five call sites across three files.
import { describe, expect, it } from 'vitest';
import { anchorMsFromIso, isPreHistory, periodEndMs } from '../../lib/analytics/prehistory';
import * as operating from '../../lib/analytics/operating';
import * as prehistory from '../../lib/analytics/prehistory';

const ms = (iso: string) => Date.parse(iso);

describe('periodEndMs', () => {
  it('returns the EXCLUSIVE end of a day bucket', () => {
    expect(periodEndMs('2026-07-19', 'day')).toBe(Date.UTC(2026, 6, 20));
  });

  it('returns the EXCLUSIVE end of a month bucket, rolling the year over correctly', () => {
    expect(periodEndMs('2026-07-01', 'month')).toBe(Date.UTC(2026, 7, 1));
    expect(periodEndMs('2026-12-01', 'month')).toBe(Date.UTC(2027, 0, 1));
  });

  it('returns NaN for an unparseable bucket key rather than a wrong instant', () => {
    expect(Number.isNaN(periodEndMs('not-a-date', 'day'))).toBe(true);
  });
});

describe('isPreHistory — suppresses only what predates the source', () => {
  const firstEvent = ms('2026-07-21T09:30:00Z');

  it('suppresses a day that CLOSED before the first event', () => {
    expect(isPreHistory('2026-07-19', 'day', firstEvent)).toBe(true);
    expect(isPreHistory('2026-07-20', 'day', firstEvent)).toBe(true);
  });

  it('does NOT suppress the day the first event landed on', () => {
    // That day's bucket closes at 2026-07-22T00:00Z, i.e. AFTER the first event, so it
    // is genuinely measurable — partially, but measurably.
    expect(isPreHistory('2026-07-21', 'day', firstEvent)).toBe(false);
  });

  it('does NOT suppress a genuinely quiet day AFTER the first event', () => {
    // THE REGRESSION THIS GUARDS: a zero-traffic day post-launch is a real, measured
    // zero — the traffic-cliff signal — and must never be hidden behind an em-dash.
    expect(isPreHistory('2026-07-22', 'day', firstEvent)).toBe(false);
    expect(isPreHistory('2027-01-01', 'day', firstEvent)).toBe(false);
  });

  it('treats a bucket ending EXACTLY at the first event as pre-history (half-open bounds)', () => {
    // Bucket bounds are half-open [start, end), so an event at exactly the boundary
    // belongs to the NEXT bucket — the earlier one really did close with nothing in it.
    expect(isPreHistory('2026-07-20', 'day', Date.UTC(2026, 6, 21))).toBe(true);
    expect(isPreHistory('2026-07-21', 'day', Date.UTC(2026, 6, 21))).toBe(false);
  });

  it('suppresses nothing at all when there is no anchor', () => {
    // Documented, deliberate contract: "no rows yet" and "this period predates the
    // source" are different claims, and only the second is knowable from an absent
    // anchor. This is also what makes the empty-database banner (H1 item 2) accurate.
    for (const anchor of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isPreHistory('1999-01-01', 'day', anchor as number | null)).toBe(false);
    }
  });

  it('applies the same rule at month grain', () => {
    const july = ms('2026-07-21T00:00:00Z');
    expect(isPreHistory('2026-06-01', 'month', july)).toBe(true);
    expect(isPreHistory('2026-07-01', 'month', july)).toBe(false);
    expect(isPreHistory('2026-08-01', 'month', july)).toBe(false);
  });

  it('does not suppress on an unparseable bucket key (NaN end ⇒ no claim)', () => {
    expect(isPreHistory('garbage', 'day', firstEvent)).toBe(false);
  });
});

describe('anchorMsFromIso', () => {
  it('parses an ISO instant', () => {
    expect(anchorMsFromIso('2026-07-21T09:30:00Z')).toBe(ms('2026-07-21T09:30:00Z'));
  });

  it('degrades a missing or unparseable anchor to "no anchor", never to epoch 0', () => {
    // Epoch 0 would be catastrophic here: it is BEFORE every plausible bucket, so it
    // would suppress nothing — but a value like NaN silently coerced the other way
    // could suppress everything. Both must land on null.
    for (const bad of [null, undefined, '', 'not-a-date']) {
      expect(anchorMsFromIso(bad)).toBeNull();
    }
  });
});

describe('STRUCTURAL: exactly one definition of the rule', () => {
  it('lib/analytics/operating.ts re-exports the primitive rather than owning a copy', () => {
    // H1's root cause was re-derivation: five call sites across three files each
    // reimplementing this, and three of them getting it wrong. If someone
    // reintroduces a local copy in operating.ts to "avoid the import", these
    // identity checks fail and say why.
    expect(operating.isPreHistory).toBe(prehistory.isPreHistory);
    expect(operating.periodEndMs).toBe(prehistory.periodEndMs);
    expect(operating.anchorMsFromIso).toBe(prehistory.anchorMsFromIso);
  });
});
