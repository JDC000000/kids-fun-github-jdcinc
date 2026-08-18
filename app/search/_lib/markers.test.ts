import { describe, expect, it } from 'vitest';
import type { Activity } from '../../preview/_data/types';
import type { SearchItemDto } from '../../preview/_data/search-api';
import { buildMarkers, geoIndex, type SearchMarker } from './markers';

/** Minimal SearchItemDto with just the fields geoIndex reads. */
function item(id: string, geo: { lng: number; lat: number } | null): SearchItemDto {
  return {
    // Only `id` and `geo` are read by geoIndex; the rest satisfies the type shape.
    listing: { id, geo } as SearchItemDto['listing'],
    distanceKm: null,
  };
}

/** Minimal Activity with just the fields buildMarkers reads. */
function activity(id: string, overrides: Partial<Activity> = {}): Activity {
  return {
    id,
    activityName: `Activity ${id}`,
    venue: `Venue ${id}`,
    area: `Area ${id}`,
    category: 'swim',
    ...overrides,
  } as Activity;
}

describe('geoIndex', () => {
  it('indexes items that have a valid coordinate', () => {
    const idx = geoIndex([item('a', { lng: -123.1, lat: 49.2 })]);
    expect(idx.get('a')).toEqual({ lng: -123.1, lat: 49.2 });
  });

  it('skips un-geocoded listings (geo === null)', () => {
    const idx = geoIndex([item('a', null)]);
    expect(idx.has('a')).toBe(false);
  });

  it('skips malformed / non-finite coordinates', () => {
    const idx = geoIndex([
      item('nan', { lng: Number.NaN, lat: 49.2 }),
      item('inf', { lng: -123.1, lat: Number.POSITIVE_INFINITY }),
    ]);
    expect(idx.size).toBe(0);
  });

  it('keeps the first coordinate seen for a duplicated id', () => {
    const idx = geoIndex([
      item('a', { lng: -123.1, lat: 49.2 }),
      item('a', { lng: -122.0, lat: 48.0 }),
    ]);
    expect(idx.get('a')).toEqual({ lng: -123.1, lat: 49.2 });
  });
});

describe('buildMarkers', () => {
  it('plots only activities that have a resolved coordinate', () => {
    const geo = geoIndex([item('a', { lng: -123.1, lat: 49.2 })]);
    const markers = buildMarkers([activity('a'), activity('b')], [], geo);
    expect(markers.map((m) => m.id)).toEqual(['a']);
  });

  it('carries name/venue/area/category through and preserves the section split', () => {
    const geo = geoIndex([
      item('a', { lng: -123.1, lat: 49.2 }),
      item('b', { lng: -123.0, lat: 49.3 }),
    ]);
    const markers = buildMarkers(
      [activity('a', { activityName: 'Public swim', venue: 'Trout Lake', area: 'East Van', category: 'swim' })],
      [activity('b', { category: 'skate' })],
      geo
    );
    const byId = Object.fromEntries(markers.map((m) => [m.id, m])) as Record<string, SearchMarker>;
    expect(byId.a).toMatchObject({
      lng: -123.1,
      lat: 49.2,
      name: 'Public swim',
      venue: 'Trout Lake',
      area: 'East Van',
      category: 'swim',
      section: 'confirmed',
    });
    expect(byId.b.section).toBe('expected');
  });

  it('returns confirmed markers before expected ones', () => {
    const geo = geoIndex([
      item('c1', { lng: -123.1, lat: 49.2 }),
      item('e1', { lng: -123.0, lat: 49.3 }),
    ]);
    const markers = buildMarkers([activity('c1')], [activity('e1')], geo);
    expect(markers.map((m) => m.section)).toEqual(['confirmed', 'expected']);
  });

  it('plots the age-not-stated section as its OWN section, in rendered order', () => {
    // The list keeps three sections apart; the map must not merge two of them back together.
    // Order matches the page (confirmed → age-not-stated → expected) so a parent reading the
    // list and scanning the map is looking at the same thing in the same order.
    const geo = geoIndex([
      item('c1', { lng: -123.1, lat: 49.2 }),
      item('u1', { lng: -123.05, lat: 49.25 }),
      item('e1', { lng: -123.0, lat: 49.3 }),
    ]);
    const markers = buildMarkers([activity('c1')], [activity('e1')], geo, [activity('u1')]);
    expect(markers.map((m) => m.id)).toEqual(['c1', 'u1', 'e1']);
    expect(markers.map((m) => m.section)).toEqual(['confirmed', 'age_unconfirmed', 'expected']);
  });

  it('defaults the age-not-stated section to empty, so existing two-section callers are unchanged', () => {
    const geo = geoIndex([item('c1', { lng: -123.1, lat: 49.2 })]);
    expect(buildMarkers([activity('c1')], [], geo).map((m) => m.section)).toEqual(['confirmed']);
  });
});
