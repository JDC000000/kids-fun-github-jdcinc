// tests/geo/radius.test.ts — Radius filter + distance (G-T18-1) and origin resolution (G-T18-2).

import { describe, it, expect } from 'vitest';
import { distanceKm, withinRadius, distanceDecay, DEFAULT_RADIUS_KM } from '../../lib/geo/radius';
import { resolveOrigin, OriginResolutionError } from '../../lib/geo/origin';
import { RegionHierarchy } from '../../lib/geo/region';
import { REGIONS, REGION_IDS } from '../../lib/search/__fixtures__/regions';
import { fixtureGeocoder } from '../../lib/search/__fixtures__/engine';

const hierarchy = new RegionHierarchy(REGIONS);
const eastVan = { lat: 49.26, lng: -123.07 };

describe('radius + distance (BR-06, G-T18-1)', () => {
  it('default radius is 10km', () => {
    expect(DEFAULT_RADIUS_KM).toBe(10);
  });

  it('computes plausible great-circle distances and filters by radius', () => {
    const richmond = { lat: 49.1666, lng: -123.1336 };
    const d = distanceKm(eastVan, richmond);
    expect(d).toBeGreaterThan(10);
    expect(withinRadius(eastVan, richmond, 10)).toBe(false);
    expect(withinRadius(eastVan, { lat: 49.32, lng: -123.07 }, 10)).toBe(true); // North Van ~6.7km
  });

  it('un-geocoded venues are excluded from a radius filter and have null distance', () => {
    expect(withinRadius(eastVan, null, 10)).toBe(false);
  });

  it('distance-decay is 1 at origin and 0 at/after the radius edge', () => {
    expect(distanceDecay(0, 10)).toBe(1);
    expect(distanceDecay(10, 10)).toBe(0);
    expect(distanceDecay(null, 10)).toBe(0);
  });
});

describe('origin resolution, 3 modes (G-T18-2)', () => {
  it('near_me resolves from geolocation coords (anon allowed)', () => {
    const o = resolveOrigin({ mode: 'near_me', coords: eastVan }, { hierarchy, geocoder: fixtureGeocoder, signedIn: false });
    expect(o.geo).toEqual(eastVan);
  });

  it('area_chip resolves to the region centroid (anon allowed)', () => {
    const o = resolveOrigin({ mode: 'area_chip', areaChipId: REGION_IDS.vancouver }, { hierarchy, geocoder: fixtureGeocoder, signedIn: false });
    expect(o.geo).toEqual(hierarchy.centroid(REGION_IDS.vancouver));
    expect(o.label).toBe('Vancouver');
  });

  it('saved_home requires sign-in and geocodes the saved postal', () => {
    expect(() =>
      resolveOrigin({ mode: 'saved_home', homePostal: 'V5L 1A1' }, { hierarchy, geocoder: fixtureGeocoder, signedIn: false }),
    ).toThrow(OriginResolutionError);
    const o = resolveOrigin({ mode: 'saved_home', homePostal: 'V5L 1A1' }, { hierarchy, geocoder: fixtureGeocoder, signedIn: true });
    expect(o.geo).toBeTruthy();
    expect(o.mode).toBe('saved_home');
  });
});
