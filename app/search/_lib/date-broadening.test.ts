// app/search/_lib/date-broadening.test.ts
//
// The engine may widen a date request to a nearby window when the exact one is too thin
// (lib/search/broaden.ts). Before this unit the /search page rendered that widened set with
// no notice at all — indistinguishable from an exact match — so the page silently answered a
// different question from the one the parent asked. These pin the disclosure.
import { describe, expect, it } from 'vitest';
import { describeDateBroadening, type AppliedRungDto } from './date-broadening';
import { DEFAULT_STATE, type SearchState } from './params';

const state = (patch: Partial<SearchState> = {}): SearchState => ({ ...DEFAULT_STATE, ...patch });

const dateRung = (from: string, to: string): AppliedRungDto => ({
  key: 'adjacent_date',
  context: { date: { isoDate: from, endIsoDate: to } },
});

const RADIUS_RUNG: AppliedRungDto = { key: 'radius_expand', context: { date: null } };

describe('describeDateBroadening', () => {
  it('DECISIVE: says nothing when nothing was widened', () => {
    expect(describeDateBroadening(state({ dateFrom: '2026-09-14', dateTo: '2026-09-14' }), [])).toBeNull();
    expect(describeDateBroadening(state(), undefined)).toBeNull();
  });

  it('names the requested range and the window actually shown', () => {
    const notice = describeDateBroadening(state({ dateFrom: '2026-09-14', dateTo: '2026-09-14' }), [
      dateRung('2026-09-11', '2026-09-17'),
    ]);
    expect(notice).toEqual({ requested: 'Sep 14', shown: 'Sep 11 – Sep 17' });
  });

  it('names a WHEN quick-pick in the parent’s own words, not as a date', () => {
    const notice = describeDateBroadening(state({ when: 'weekend' }), [dateRung('2026-07-15', '2026-07-21')]);
    expect(notice?.requested).toBe('This weekend');
    expect(notice?.shown).toBe('Jul 15 – Jul 21');
  });

  it('refuses to name a date intent the URL state cannot see (free text), but still discloses', () => {
    // "swim saturday" parses to a date the WHEN chip knows nothing about; naming it "Any day"
    // would be a second small lie on top of the one this notice exists to end.
    const notice = describeDateBroadening(state({ q: 'swim saturday' }), [dateRung('2026-07-15', '2026-07-21')]);
    expect(notice).toEqual({ requested: null, shown: 'Jul 15 – Jul 21' });
  });

  it('ignores the other rungs — a radius widen is not a date substitution', () => {
    // radius_expand fires on the default 10km radius even with no origin to measure from, so
    // keying the notice on "any broadening happened" would badge searches nothing was done to.
    expect(describeDateBroadening(state({ dateFrom: '2026-09-14', dateTo: '2026-09-14' }), [RADIUS_RUNG])).toBeNull();
  });

  it('is defensive about a rung with no usable window', () => {
    const half: AppliedRungDto = { key: 'adjacent_date', context: { date: { isoDate: '2026-09-11' } } };
    expect(describeDateBroadening(state(), [half])).toBeNull();
    expect(describeDateBroadening(state(), [{ key: 'adjacent_date' }])).toBeNull();
  });
});
