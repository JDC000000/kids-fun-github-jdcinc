// app/search/_lib/broadening-notice.test.ts
//
// The engine's broadening ladder may relax dates, times, ages or a chip when a search is too
// thin (lib/search/broaden.ts). Before this unit the /search page rendered none of that, so a
// widened result set was pixel-identical to an exact one and the page silently answered a
// different question from the one asked. These pin the disclosure — including the two rungs
// that must stay SILENT, because a notice that over-reports is the same defect wearing a
// different hat.
import { describe, expect, it } from 'vitest';
import { describeBroadening, joinPhrases, type AppliedRungDto } from './broadening-notice';

const dateRung = (from: string, to: string): AppliedRungDto => ({
  key: 'adjacent_date',
  context: { date: { isoDate: from, endIsoDate: to } },
});

describe('describeBroadening', () => {
  it('DECISIVE: says nothing when nothing was widened', () => {
    expect(describeBroadening([])).toBeNull();
    expect(describeBroadening(undefined)).toBeNull();
  });

  it('names the date window the results are actually filtered to', () => {
    expect(describeBroadening([dateRung('2026-09-11', '2026-09-17')])).toEqual({
      changes: ['nearby dates (Sep 11 – Sep 17)'],
    });
  });

  it('names the adjacent time bands — and only the adjacent ones', () => {
    const notice = describeBroadening([{ key: 'adjacent_time', context: { timeOfDay: 'morning' } }]);
    expect(notice!.changes[0]).toBe('adjacent times of day (morning and afternoon)');
    expect(notice!.changes[0]).not.toContain('evening');
  });

  it('names the widened age bands', () => {
    const notice = describeBroadening([{ key: 'adjacent_age', context: { ageBands: ['under2', '2-4'] } }]);
    expect(notice!.changes[0]).toBe('neighbouring age groups (Under 2 and 2–4)');
  });

  it('names WHICH chip was set aside, from the rung key rather than by parsing prose', () => {
    const notice = describeBroadening([{ key: 'drop_chip', constraint: 'costFree', context: {} }]);
    expect(notice!.changes[0]).toBe('your Free filter set aside');
  });

  it('reports the radius it actually expanded to', () => {
    expect(describeBroadening([{ key: 'radius_expand', context: { radiusKm: 20 } }])!.changes[0]).toBe(
      'a wider 20 km search',
    );
  });

  it('DECISIVE: stays silent about the inert synonym rung — it changes nothing', () => {
    // `widenText` is read by nothing (lib/search/types.ts). Announcing it would be a fresh lie
    // told by the very feature that exists to end them.
    expect(describeBroadening([{ key: 'synonym_widen', context: {} }])).toBeNull();
  });

  it('stays silent about the expected section — the results page already heads it', () => {
    expect(describeBroadening([{ key: 'expected_section', context: {} }])).toBeNull();
  });

  it('reports several rungs in ladder order, as one readable list', () => {
    const notice = describeBroadening([
      { key: 'synonym_widen', context: {} },
      { key: 'adjacent_time', context: { timeOfDay: 'afternoon' } },
      dateRung('2026-09-11', '2026-09-17'),
      { key: 'adjacent_age', context: { ageBands: ['under2', '2-4'] } },
      { key: 'expected_section', context: {} },
    ]);
    expect(notice!.changes).toHaveLength(3);
    expect(joinPhrases(notice!.changes)).toBe(
      'adjacent times of day (morning, afternoon and evening), nearby dates (Sep 11 – Sep 17) and neighbouring age groups (Under 2 and 2–4)',
    );
  });

  it('is defensive about a rung with no usable context', () => {
    expect(describeBroadening([{ key: 'adjacent_date' }])).toBeNull();
    expect(describeBroadening([{ key: 'adjacent_date', context: { date: { isoDate: '2026-09-11' } } }])).toBeNull();
    expect(describeBroadening([{ key: 'adjacent_age', context: { ageBands: [] } }])).toBeNull();
    expect(describeBroadening([{ key: 'drop_chip', context: {} }])).toBeNull();
    expect(describeBroadening([{ key: 'drop_chip', constraint: 'notAConstraint', context: {} }])).toBeNull();
  });
});

describe('joinPhrases', () => {
  it('reads as a sentence at every length', () => {
    expect(joinPhrases([])).toBe('');
    expect(joinPhrases(['a'])).toBe('a');
    expect(joinPhrases(['a', 'b'])).toBe('a and b');
    expect(joinPhrases(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
