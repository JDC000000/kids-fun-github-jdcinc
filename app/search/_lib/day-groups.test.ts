import { describe, expect, it } from 'vitest';
import type { Activity } from '../../preview/_data/types';
import { groupActivitiesByDay, formatDayHeading, formatRangeLabel } from './day-groups';

/** Minimal Activity — groupActivitiesByDay reads only `id` and (as a fallback) `startIso`. */
function activity(id: string, startIso: string): Activity {
  return { id, activityName: `Activity ${id}`, startIso } as Activity;
}

describe('groupActivitiesByDay (T26 / FR-04)', () => {
  it('splits results into one group per local day, ascending', () => {
    const acts = [
      activity('a', '2026-07-14T17:00:00Z'),
      activity('b', '2026-07-13T17:00:00Z'),
      activity('c', '2026-07-13T21:00:00Z'),
      activity('d', '2026-07-15T23:00:00Z'),
    ];
    const dayById = new Map<string, string | null>([
      ['a', '2026-07-14'],
      ['b', '2026-07-13'],
      ['c', '2026-07-13'],
      ['d', '2026-07-15'],
    ]);
    const groups = groupActivitiesByDay(acts, dayById);
    expect(groups.map((g) => g.isoDate)).toEqual(['2026-07-13', '2026-07-14', '2026-07-15']);
    // Two occurrences land on the first day; input order preserved within a group.
    expect(groups[0].items.map((a) => a.id)).toEqual(['b', 'c']);
    expect(groups[1].items.map((a) => a.id)).toEqual(['a']);
  });

  it('puts open-hours / undated listings in a single trailing "Available any day" group', () => {
    const acts = [
      activity('open', '2026-07-13T12:00:00Z'),
      activity('dated', '2026-07-14T17:00:00Z'),
      activity('open2', '2026-07-13T12:00:00Z'),
    ];
    const dayById = new Map<string, string | null>([
      ['open', null],
      ['dated', '2026-07-14'],
      ['open2', null],
    ]);
    const groups = groupActivitiesByDay(acts, dayById);
    expect(groups.map((g) => g.isoDate)).toEqual(['2026-07-14', null]);
    const openGroup = groups[groups.length - 1];
    expect(openGroup.isoDate).toBeNull();
    expect(openGroup.label).toBe('Available any day');
    expect(openGroup.items.map((a) => a.id)).toEqual(['open', 'open2']);
  });

  it('falls back to the Activity startIso when an id is missing from the day lookup', () => {
    const acts = [activity('x', '2026-07-14T20:00:00Z')]; // 13:00 local PDT → 2026-07-14
    const groups = groupActivitiesByDay(acts, new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0].isoDate).toBe('2026-07-14');
  });

  it('returns no groups for an empty result set', () => {
    expect(groupActivitiesByDay([], new Map())).toEqual([]);
  });
});

describe('date heading / range labels', () => {
  it('formats a day heading with weekday, month and day', () => {
    expect(formatDayHeading('2026-07-18')).toBe('Saturday, Jul 18');
  });

  it('formats a range label, collapsing a single-day range', () => {
    expect(formatRangeLabel('2026-07-18', '2026-07-20')).toBe('Jul 18 – Jul 20');
    expect(formatRangeLabel('2026-07-18', '2026-07-18')).toBe('Jul 18');
  });
});
