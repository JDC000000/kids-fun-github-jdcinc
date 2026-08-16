import { describe, it, expect } from 'vitest';
import { ACTIVITIES } from '../app/preview/_data/fixtures';
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  applyFilters,
  partitionSections,
  sortActivities,
} from '../app/preview/_data/filter';
import { statusMeta } from '../app/preview/_data/format';
import type { FilterState } from '../app/preview/_data/filter';
import type { Activity } from '../app/preview/_data/types';

const withFilters = (patch: Partial<FilterState>): FilterState => ({ ...DEFAULT_FILTERS, ...patch });

/** A card the search could measure no distance for — the DEFAULT state when no origin was given. */
const NO_DISTANCE: Activity = { ...ACTIVITIES[0], id: 'no-distance', distanceKm: null, driveMinutes: null };

/** Nulls-last ordering key: an unmeasured distance is never "closest". */
const distanceKey = (a: Activity): number => a.distanceKm ?? Number.POSITIVE_INFINITY;

describe('applyFilters', () => {
  it('defaults to a 20 km radius and drops farther listings', () => {
    const results = applyFilters(ACTIVITIES, DEFAULT_FILTERS);
    expect(results.every((a) => a.distanceKm == null || a.distanceKm <= 20)).toBe(true);
    expect(results.some((a) => a.distanceKm != null && a.distanceKm > 20)).toBe(false);
  });

  it('tightens to 5 km', () => {
    const results = applyFilters(ACTIVITIES, withFilters({ radiusKm: 5 }));
    expect(results.every((a) => a.distanceKm == null || a.distanceKm <= 5)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('keeps a card whose distance is unknown, at every radius', () => {
    // "We could not measure this" is not evidence that it is far. Excluding unknowns would
    // empty the list on any search with no origin, which is the common case.
    for (const radiusKm of [5, 10, 20] as const) {
      const results = applyFilters([...ACTIVITIES, NO_DISTANCE], withFilters({ radiusKm }));
      expect(results.map((a) => a.id)).toContain('no-distance');
    }
  });

  it('bookable-now only returns bookable_now listings', () => {
    const results = applyFilters(ACTIVITIES, withFilters({ bookableNow: true }));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((a) => a.booking === 'bookable_now')).toBe(true);
  });

  it('toddler only returns bands that reach age 3 or under', () => {
    const results = applyFilters(ACTIVITIES, withFilters({ toddler: true }));
    expect(results.every((a) => a.ageMin <= 3)).toBe(true);
  });

  it('rainy-day only returns rainy-day-friendly listings', () => {
    const results = applyFilters(ACTIVITIES, withFilters({ rainyDay: true }));
    expect(results.every((a) => a.rainyDay)).toBe(true);
  });

  it('returns nothing for an over-constrained combination (drives the empty state)', () => {
    const results = applyFilters(ACTIVITIES, withFilters({ free: true, indoors: true, timeOfDay: 'evening' }));
    expect(results).toHaveLength(0);
  });
});

describe('partitionSections', () => {
  it('splits confirmed from expected without losing or duplicating cards', () => {
    const { confirmed, expected } = partitionSections(ACTIVITIES);
    expect(confirmed.every((a) => statusMeta(a.status).section === 'confirmed')).toBe(true);
    expect(expected.every((a) => statusMeta(a.status).section === 'expected')).toBe(true);
    expect(confirmed.length + expected.length).toBe(ACTIVITIES.length);
  });
});

describe('sortActivities', () => {
  it('orders by distance ascending', () => {
    const sorted = sortActivities(ACTIVITIES, 'distance');
    for (let i = 1; i < sorted.length; i += 1) {
      expect(distanceKey(sorted[i])).toBeGreaterThanOrEqual(distanceKey(sorted[i - 1]));
    }
  });

  it('sorts an unknown distance LAST, never first — under "distance" and "best match" alike', () => {
    for (const key of ['distance', 'best_match'] as const) {
      const sorted = sortActivities([NO_DISTANCE, ...ACTIVITIES], key);
      expect(sorted[sorted.length - 1].id).toBe('no-distance');
    }
  });

  it('orders by soonest start ascending', () => {
    const sorted = sortActivities(ACTIVITIES, 'soonest');
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].startIso >= sorted[i - 1].startIso).toBe(true);
    }
  });

  it('puts free first and unknown cost last for lowest-cost', () => {
    const sorted = sortActivities(ACTIVITIES, 'lowest_cost');
    expect(sorted[0].costStatus).toBe('free');
    expect(sorted[sorted.length - 1].costStatus).toBe('unknown');
  });

  it('does not mutate the input array', () => {
    const before = ACTIVITIES.map((a) => a.id);
    sortActivities(ACTIVITIES, 'distance');
    expect(ACTIVITIES.map((a) => a.id)).toEqual(before);
  });
});

describe('activeFilterCount', () => {
  it('counts defaults as zero', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
  });
  it('counts toggles, time-of-day and a non-default radius', () => {
    expect(activeFilterCount(withFilters({ free: true }))).toBe(1);
    expect(activeFilterCount(withFilters({ free: true, radiusKm: 5 }))).toBe(2);
    expect(activeFilterCount(withFilters({ timeOfDay: 'morning' }))).toBe(1);
  });
});
