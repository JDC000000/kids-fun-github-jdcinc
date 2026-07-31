// tests/adapters/activenet-venue-geo.test.ts — G-VENUE-1/2/3.
//
// venue-geo.ts is a hand-authored derivation, so the failure modes are the ones
// hand-authored data has: a transposed lat/lng pair, a facility that appears in the
// feed and was never added, a coordinate quietly changed without its `source` moving
// with it, and a licence notice that stops matching the data it attributes. Each of
// those gets a test here. There is deliberately NO test that fetches anything — the
// zero-network property is itself asserted below.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  VANCOUVER_VENUE_GEO,
  VANCOUVER_VENUE_GEO_PROVENANCE,
  OGL_VANCOUVER_ATTRIBUTION,
  OGL_VANCOUVER_LICENCE_URL,
  lookupVenueGeo,
  hasVenueGeoTable,
  normaliseVenueGeoKey,
  venueGeoAttribution,
} from '../../worker/adapters/activenet/venue-geo';
import { buildVenueIndex, applyVenues } from '../../worker/adapters/activenet/venues';
import { stripCentreSentinel } from '../../worker/adapters/activenet/parse';
import { getTenantConfig } from '../../worker/adapters/activenet/config';
import type { ActiveNetCentreDetail } from '../../worker/adapters/activenet/client';

const FIXTURES = join(process.cwd(), 'worker/adapters/activenet/__fixtures__');
const VANCOUVER = getTenantConfig('vancouver')!;
const BURNABY = getTenantConfig('burnaby')!;

function centreDetails(file: string): ActiveNetCentreDetail[] {
  const parsed = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as {
    body: { center_details: ActiveNetCentreDetail[] };
  };
  return parsed.body.center_details;
}

/** Vancouver's bounding box. Cheap, and it is exactly what catches a transposed pair:
 *  a swapped (lat, lng) lands at (-123, 49), which is off the coast of Africa. */
const LAT_RANGE = [49.19, 49.32] as const;
const LNG_RANGE = [-123.23, -123.02] as const;

describe('G-VENUE-1 Vancouver facility-geo constant', () => {
  it('covers every facility name in the captured Vancouver centerdetails roster', () => {
    const names = centreDetails('vancouver.centerdetails.json')
      .map((d) => stripCentreSentinel(d.name))
      .filter((n): n is string => Boolean(n));

    expect(names.length).toBe(36);
    const missing = names.filter((n) => !lookupVenueGeo('vancouver', n));
    expect(missing, 'every facility in the feed must have a committed coordinate').toEqual([]);
    expect(Object.keys(VANCOUVER_VENUE_GEO).length).toBe(names.length);
  });

  it('every coordinate is inside Vancouver (catches a transposed lat/lng)', () => {
    for (const [key, geo] of Object.entries(VANCOUVER_VENUE_GEO)) {
      expect(Number.isFinite(geo.lat), key).toBe(true);
      expect(Number.isFinite(geo.lng), key).toBe(true);
      expect(geo.lat, key).toBeGreaterThanOrEqual(LAT_RANGE[0]);
      expect(geo.lat, key).toBeLessThanOrEqual(LAT_RANGE[1]);
      expect(geo.lng, key).toBeGreaterThanOrEqual(LNG_RANGE[0]);
      expect(geo.lng, key).toBeLessThanOrEqual(LNG_RANGE[1]);
    }
  });

  it('a shared coordinate is only ever a DECLARED co-location, never a copy-paste', () => {
    // Co-location is real (a pool inside its community centre), so duplicates are
    // EXPECTED — but only where the entry says so. A duplicate that does not declare
    // itself co-located is a copy-paste error.
    const byPoint = new Map<string, string[]>();
    for (const [key, geo] of Object.entries(VANCOUVER_VENUE_GEO)) {
      const point = `${geo.lat},${geo.lng}`;
      byPoint.set(point, [...(byPoint.get(point) ?? []), key]);
    }
    for (const [point, keys] of byPoint) {
      if (keys.length === 1) continue;
      for (const key of keys) {
        expect(
          VANCOUVER_VENUE_GEO[key].derivedFrom,
          `${key} shares point ${point} but does not declare co-location`
        ).toMatch(/co-located|community-centres "/);
      }
    }
  });

  it('carries per-entry provenance and a per-entry licence notice, on every entry', () => {
    for (const [key, geo] of Object.entries(VANCOUVER_VENUE_GEO)) {
      expect(['opendata-vancouver', 'curated'], key).toContain(geo.source);
      expect(['ogl-vancouver', 'osm-odbl'], key).toContain(geo.attribution);
      expect(geo.derivedFrom.length, key).toBeGreaterThan(10);
      expect(geo.displayArea, key).toBeTruthy();
    }
    const counts = Object.values(VANCOUVER_VENUE_GEO).reduce(
      (acc, g) => ({ ...acc, [g.source]: (acc[g.source] ?? 0) + 1 }),
      {} as Record<string, number>
    );
    // The header comment states these numbers; a drifting comment is a lie in a file
    // whose whole value is that its provenance can be trusted.
    expect(counts['opendata-vancouver']).toBe(VANCOUVER_VENUE_GEO_PROVENANCE.fromOpenData);
    expect(counts.curated).toBe(VANCOUVER_VENUE_GEO_PROVENANCE.curated);
    expect(VANCOUVER_VENUE_GEO_PROVENANCE.activeNetCentresCovered).toBe(
      Object.keys(VANCOUVER_VENUE_GEO).length
    );
  });

  it('is keyed on the ACTIVENET name — 0 keys are bare open-data names', () => {
    // The measured finding this file exists to work around: open data says
    // "Hastings", the feed says "Hastings Community Centre". If a key ever becomes a
    // bare open-data name, the join has silently been rebuilt the wrong way round.
    expect(lookupVenueGeo('vancouver', 'Hastings')).toBeUndefined();
    expect(lookupVenueGeo('vancouver', 'Hastings Community Centre')).toBeDefined();
  });

  it('resolves the three hand-authored aliases, and does NOT fuzzy-match', () => {
    // Present, because a human resolved them at authoring time…
    expect(lookupVenueGeo('vancouver', 'Kitsilano Community Centre')).toBeDefined();
    expect(lookupVenueGeo('vancouver', 'RayCam Co-operative Centre')).toBeDefined();
    expect(lookupVenueGeo('vancouver', 'West Point Grey Community Centre - Aberthau')).toBeDefined();
    // …and the open-data spellings are NOT keys: nothing here matches fuzzily.
    expect(lookupVenueGeo('vancouver', 'Kitsilano War Memorial')).toBeUndefined();
    expect(lookupVenueGeo('vancouver', 'Ray-Cam Co-Operative Center')).toBeUndefined();
    expect(lookupVenueGeo('vancouver', 'West Point Grey')).toBeUndefined();
  });

  it('normalises only case and whitespace', () => {
    expect(normaliseVenueGeoKey('  Britannia   Pool ')).toBe('britannia pool');
    expect(lookupVenueGeo('vancouver', '  BRITANNIA   POOL  ')).toBeDefined();
  });

  it('does NOT seed the three open-data centres that carry no programming', () => {
    for (const name of ['Carnegie Centre', 'Evelyne Saller Centre', 'Gathering Place Community Centre']) {
      expect(lookupVenueGeo('vancouver', name), name).toBeUndefined();
    }
  });

  it('covers the 12 pool/rink/arena facilities open data has no record for', () => {
    const curatedFacilities = [
      'Britannia Pool',
      'Britannia Rink',
      'Hillcrest Aquatic Centre',
      'Hillcrest Rink',
      'Kensington Pool',
      'Kerrisdale Cyclone Taylor Arena',
      'Killarney Pool',
      'Lord Byng Pool',
      'Renfrew Park Pool',
      'Sunset Rink',
      'Templeton Park Pool',
      'Trout Lake Rink',
    ];
    for (const name of curatedFacilities) {
      expect(lookupVenueGeo('vancouver', name), name).toBeDefined();
    }
  });

  it('is frozen, and only Vancouver has a table', () => {
    expect(Object.isFrozen(VANCOUVER_VENUE_GEO)).toBe(true);
    expect(hasVenueGeoTable('vancouver')).toBe(true);
    expect(hasVenueGeoTable('burnaby')).toBe(false);
    expect(hasVenueGeoTable('west_vancouver')).toBe(false);
    expect(lookupVenueGeo('burnaby', 'Bonsor Recreation Complex')).toBeUndefined();
  });

  it('makes ZERO network calls at import or lookup', () => {
    // The module is a constant, not an adapter. Its single most important property is
    // that nothing in it can ever reach the network — so assert it on the source, with
    // comments stripped (URLs in the header and in the provenance literal are the
    // derivation's audit trail and are expected; a CALL is not).
    const code = readFileSync(join(process.cwd(), 'worker/adapters/activenet/venue-geo.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/politeFetch|XMLHttpRequest|require\s*\(|\bimport\s/);
  });
});

describe('G-VENUE-2 geo attaches in venues.ts and the gap is NAMED', () => {
  it('attaches lat/lng/displayArea for covered facilities', () => {
    const index = buildVenueIndex(VANCOUVER, centreDetails('vancouver.centerdetails.json'));
    const hastings = index.get(44)!;
    expect(hastings.venueName).toBe('Hastings Community Centre');
    expect(hastings.geo).toMatchObject({ lat: 49.2809, lng: -123.0393, displayArea: 'Hastings-Sunrise' });
    expect(hastings.geoTableAvailable).toBe(true);
  });

  it('reports NO gap for Vancouver — every facility in the roster is covered', () => {
    const index = buildVenueIndex(VANCOUVER, centreDetails('vancouver.centerdetails.json'));
    const applied = applyVenues([], index);
    expect(applied.venuesWithoutGeo).toEqual([]);
    expect(applied.warnings.join(' ')).not.toMatch(/venue-geo/);
  });

  it('a facility present in the feed but absent from the constant is NAMED, never silent', () => {
    const index = buildVenueIndex(VANCOUVER, [
      ...centreDetails('vancouver.centerdetails.json'),
      { id: 9999, name: '*Brand New Aquatic Centre' } satisfies ActiveNetCentreDetail,
    ]);
    const applied = applyVenues([], index);
    expect(applied.venuesWithoutGeo).toEqual(['Brand New Aquatic Centre']);
    expect(applied.warnings.join(' ')).toMatch(
      /venue-geo\.ts has no entry for 1 centre\(s\) present in the feed: Brand New Aquatic Centre/
    );
  });

  it('a tenant with no table at all says so once, naming every facility', () => {
    const index = buildVenueIndex(BURNABY, centreDetails('burnaby.centerdetails.json'));
    const applied = applyVenues([], index);
    expect(applied.venuesWithoutGeo.length).toBe(7);
    const warning = applied.warnings.join(' ');
    expect(warning).toMatch(/no curated venue-geo table for this tenant/);
    // Every one of them, by name — not a count, and not a percentage.
    for (const name of applied.venuesWithoutGeo) expect(warning).toContain(name);
  });
});

describe('G-VENUE-3 licence attribution is derived from the data, not asserted beside it', () => {
  it('returns the OGL – Vancouver notice verbatim for City-sourced coordinates', () => {
    const attribution = venueGeoAttribution('Hastings Community Centre');
    expect(attribution).toEqual({
      key: 'ogl-vancouver',
      text: 'Contains information licensed under the Open Government Licence – Vancouver',
      url: 'https://opendata.vancouver.ca/pages/licence/',
    });
    expect(attribution!.text).toBe(OGL_VANCOUVER_ATTRIBUTION);
    expect(attribution!.url).toBe(OGL_VANCOUVER_LICENCE_URL);
  });

  it('co-located pool/rink entries still carry the OGL notice — the point is the City\'s', () => {
    expect(venueGeoAttribution('Britannia Pool')!.key).toBe('ogl-vancouver');
    expect(venueGeoAttribution('Trout Lake Rink')!.key).toBe('ogl-vancouver');
  });

  it('the two OpenStreetMap coordinates carry the ODbL notice instead, not the OGL one', () => {
    for (const name of ['Lord Byng Pool', 'Sunset Rink']) {
      const attribution = venueGeoAttribution(name);
      expect(attribution!.key, name).toBe('osm-odbl');
      expect(attribution!.text).toBe('© OpenStreetMap contributors');
      expect(attribution!.url).toBe('https://www.openstreetmap.org/copyright');
    }
  });

  it('returns nothing for a venue this table did not contribute to', () => {
    // A false attribution is a false statement of fact — worse than none.
    expect(venueGeoAttribution('H.R. MacMillan Space Centre')).toBeUndefined();
    expect(venueGeoAttribution('Bonsor Recreation Complex')).toBeUndefined();
    expect(venueGeoAttribution(undefined)).toBeUndefined();
    expect(venueGeoAttribution('')).toBeUndefined();
  });
});
