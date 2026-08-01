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
  requiredGeoAttributions,
} from '../../worker/adapters/activenet/venue-geo';
import { buildVenueIndex, applyVenues } from '../../worker/adapters/activenet/venues';
import { stripCentreSentinel } from '../../worker/adapters/activenet/parse';
import { getTenantConfig } from '../../worker/adapters/activenet/config';
import { CITY_CALENDARS } from '../../worker/adapters/citycalendar/config';
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
      // `attribution` is OPTIONAL, and omitting it is a claim ("no third-party notice
      // owed"), not a default — so an omission is only legal from a `curated` point.
      if (geo.attribution === undefined) {
        expect(geo.source, `${key} omits attribution but claims open data`).toBe('curated');
      } else {
        expect(['ogl-vancouver', 'osm-odbl'], key).toContain(geo.attribution);
      }
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

  it('the 12-facility breakdown is pinned against the table too, not just the source split', () => {
    // QA flagged this as the one set of numbers in the file that nothing checked: fromOpenData,
    // curated and activeNetCentresCovered were pinned against a live reduction, the 12/7/2/3
    // breakdown in the header was prose. A drifting count in THIS file is a lie in the place a
    // reader goes specifically to check whether the data can be trusted.
    //
    // The classification is DISJOINT and ORDER-SENSITIVE, and that is the reason it needs to be
    // code: two co-located entries (killarney pool, renfrew park pool) also name
    // `property-addresses` in their derivedFrom, so counting each marker independently yields
    // 7/4/3 = 14 and silently contradicts the header. Priority: OSM by attribution, then
    // co-located, then property-addresses.
    const entries = Object.entries(VANCOUVER_VENUE_GEO);
    const fromOpenStreetMap = entries.filter(([, g]) => g.attribution === 'osm-odbl');
    const coLocated = entries.filter(
      ([, g]) => g.attribution !== 'osm-odbl' && /co-located/i.test(g.derivedFrom)
    );
    const fromPropertyAddresses = entries.filter(
      ([, g]) =>
        g.attribution !== 'osm-odbl' &&
        !/co-located/i.test(g.derivedFrom) &&
        /property-addresses/i.test(g.derivedFrom)
    );

    const p = VANCOUVER_VENUE_GEO_PROVENANCE;
    expect(coLocated.length, 'co-located').toBe(p.coLocated);
    expect(fromPropertyAddresses.length, 'property-addresses').toBe(p.fromPropertyAddresses);
    expect(fromOpenStreetMap.length, 'OpenStreetMap').toBe(p.fromOpenStreetMap);
    // The three groups must be disjoint AND must sum to the stated total — either half alone
    // would let a miscount hide.
    const named = new Set(
      [...coLocated, ...fromPropertyAddresses, ...fromOpenStreetMap].map(([k]) => k)
    );
    expect(named.size, 'the three groups must not overlap').toBe(
      coLocated.length + fromPropertyAddresses.length + fromOpenStreetMap.length
    );
    expect(named.size, 'and must account for every no-community-centres facility').toBe(
      p.noCommunityCentreRecord
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

  it('Britannia is converged with citycalendar verbatim, and owes no third-party notice', () => {
    // QA F3/F5: resolveVenue OVERWRITES geo (geo = COALESCE(incoming, geo)), so two
    // tables holding different points for one venue name make the stored value churn
    // with ingest order. Britannia is the highest-volume venue and the City's point was
    // the worse of the two (measured 139-172 m further from the building than
    // citycalendar's, against two OSM POIs at 1661 Napier Street). The values are now
    // byte-identical, which is what makes the churn unobservable — so this test pins the
    // exact numbers, not a tolerance.
    const britannia = VANCOUVER_VENUE_GEO['britannia community centre'];
    expect(britannia.lat).toBe(49.2757);
    expect(britannia.lng).toBe(-123.0714);
    expect(britannia.source).toBe('curated');
    expect(
      britannia.attribution,
      'the point is our own curation — claiming the OGL over it would be false provenance'
    ).toBeUndefined();
    expect(britannia.derivedFrom).toMatch(/citycalendar/);

    // The POOL keeps the City's site-level point: it is a separate building on the same
    // campus and no better per-building source exists for it. Re-measured 2026-08-01
    // rather than inherited — an Overpass sweep of the campus returns no named pool
    // feature at all. This is now a one-entry assertion; it used to cover the rink too.
    const pool = VANCOUVER_VENUE_GEO['britannia pool'];
    expect(pool.lat).toBe(49.2756);
    expect(pool.lng).toBe(-123.0738);
    expect(pool.attribution).toBe('ogl-vancouver');
  });

  it('Britannia Rink is on its OWN building footprint, not the campus site-point', () => {
    // Corrected 2026-08-01 (registry round 56). The old value was faithful to its stated
    // source and still 236 m from the building — which is exactly why this file records a
    // per-entry `derivedFrom` instead of a per-file one. Pinned separately from the pool
    // so the two can never silently re-converge onto one point, and asserted on the
    // ATTRIBUTION as well as the coordinate: a point sourced from OSM rendering the City's
    // OGL notice would be a false licence claim of the exact kind source-register §6.6
    // records (the per-venue notice that shipped and had to be pulled).
    const rink = VANCOUVER_VENUE_GEO['britannia rink'];
    expect(rink.lat).toBe(49.276);
    expect(rink.lng).toBe(-123.0706);
    expect(rink.source).toBe('curated');
    expect(rink.attribution).toBe('osm-odbl');
    expect(rink.derivedFrom).toMatch(/way 32896473/);
    // It must NOT have quietly kept the campus site-point it was moved off.
    const pool = VANCOUVER_VENUE_GEO['britannia pool'];
    expect({ lat: rink.lat, lng: rink.lng }).not.toEqual({ lat: pool.lat, lng: pool.lng });
  });

  it('the Britannia convergence is pinned to citycalendar\'s ACTUAL value, not a copy of it', () => {
    // Guards the convergence from BOTH sides: if either table's Britannia point is
    // edited, they stop agreeing, the stored coordinate starts churning with ingest
    // order again, and this fails. A hardcoded literal here would only guard one side.
    const cityGeo = CITY_CALENDARS.find((c) => c.calendarKey === 'vancouver')?.venueGeo;
    const theirs = cityGeo?.['britannia community centre'];
    const ours = VANCOUVER_VENUE_GEO['britannia community centre'];
    expect(theirs, 'citycalendar must still carry this venue for the convergence to mean anything').toBeDefined();
    expect({ lat: ours.lat, lng: ours.lng }).toEqual({ lat: theirs!.lat, lng: theirs!.lng });
  });

  it('names the shared venues that still diverge, so the follow-up stays visible', () => {
    // The other 4 shared names are deliberately NOT converged (measured as a net
    // improvement when the ActiveNet value wins). They still churn with ingest order,
    // which is a tracked follow-up — this test exists so that fact stays discoverable
    // rather than living only in a doc, and so a silent 6th collision cannot appear.
    const cityGeo = CITY_CALENDARS.find((c) => c.calendarKey === 'vancouver')?.venueGeo ?? {};
    const diverging = Object.keys(cityGeo)
      .filter((k) => VANCOUVER_VENUE_GEO[k])
      .filter((k) => {
        const a = VANCOUVER_VENUE_GEO[k];
        const b = cityGeo[k];
        return a.lat !== b.lat || a.lng !== b.lng;
      })
      .sort();
    expect(diverging).toEqual([
      'killarney community centre',
      'kitsilano community centre',
      'renfrew park community centre',
      'trout lake community centre',
    ]);
  });

  it('records the ONE display-only displayArea override, and only that one', () => {
    // QA F4: the City's geo_local_area for 5670 East Boulevard is "Shaughnessy" (an
    // Arbutus-corridor boundary artefact). Shown as "Kerrisdale" because that is the
    // facility's own name; the City's value is preserved in derivedFrom. The
    // COORDINATE is untouched — this must never become a licence to move a point.
    const arena = VANCOUVER_VENUE_GEO['kerrisdale cyclone taylor arena'];
    expect(arena.displayArea).toBe('Kerrisdale');
    expect(arena.derivedFrom).toMatch(/DISPLAY-ONLY OVERRIDE/);
    expect(arena.derivedFrom).toMatch(/Shaughnessy/);
    expect(arena.lat).toBe(49.2359);
    expect(arena.lng).toBe(-123.1535);
    const overrides = Object.entries(VANCOUVER_VENUE_GEO)
      .filter(([, g]) => /DISPLAY-ONLY OVERRIDE/.test(g.derivedFrom))
      .map(([k]) => k);
    expect(overrides, 'a second silent override would be a real regression').toEqual([
      'kerrisdale cyclone taylor arena',
    ]);
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

describe('G-VENUE-3 licence attribution is site-wide and cannot be name-inferred', () => {
  it('publishes the OGL – Vancouver notice verbatim, plus the ODbL notice for the 2 OSM points', () => {
    const attributions = requiredGeoAttributions();
    expect(attributions).toEqual([
      {
        key: 'ogl-vancouver',
        text: 'Contains information licensed under the Open Government Licence – Vancouver',
        url: 'https://opendata.vancouver.ca/pages/licence/',
      },
      {
        key: 'osm-odbl',
        text: '© OpenStreetMap contributors',
        url: 'https://www.openstreetmap.org/copyright',
      },
    ]);
    expect(attributions[0].text).toBe(OGL_VANCOUVER_ATTRIBUTION);
    expect(attributions[0].url).toBe(OGL_VANCOUVER_LICENCE_URL);
  });

  it('lists exactly the notices the table actually uses — no more, no fewer', () => {
    // Entries that owe no third-party notice (attribution omitted) must contribute
    // nothing here — an `undefined` leaking into the footer would render an empty link.
    const used = new Set(
      Object.values(VANCOUVER_VENUE_GEO)
        .map((g) => g.attribution)
        .filter((a): a is NonNullable<typeof a> => a !== undefined)
    );
    expect(requiredGeoAttributions().map((a) => a.key).sort()).toEqual([...used].sort());
    expect(requiredGeoAttributions().every((a) => Boolean(a.text && a.url))).toBe(true);
  });

  it('is deduplicated and stable — 34 OGL entries yield ONE notice, not 34', () => {
    const attributions = requiredGeoAttributions();
    expect(attributions.length).toBe(new Set(attributions.map((a) => a.key)).size);
    expect(attributions.map((a) => a.key)).toEqual(requiredGeoAttributions().map((a) => a.key));
  });

  // ── QA F1 regression. ─────────────────────────────────────────────────────────
  // The removed `venueGeoAttribution(venueName)` claimed OGL licensing for any venue
  // whose NAME matched this table, regardless of where its coordinates came from —
  // and citycalendar/config.ts independently carries 5 byte-identical venue names
  // with different coordinates, so the claim was demonstrably false in fixture mode.
  // The fix is structural: attribution takes no venue input at all, so no name (or
  // hostname, or any other string) can ever be mistaken for provenance.
  it('exposes NO name-keyed attribution lookup — provenance is never inferred from a string', async () => {
    const mod: Record<string, unknown> = await import(
      '../../worker/adapters/activenet/venue-geo'
    );
    expect(mod.venueGeoAttribution, 'the name-keyed lookup must stay deleted').toBeUndefined();
    expect(requiredGeoAttributions).toHaveLength(0); // takes zero arguments, by design
  });

  it('the 5 venue names citycalendar also carries cannot produce a per-venue claim', () => {
    // These exist in BOTH tables with different coordinates (up to ~802 m apart).
    // They must still resolve geo for the ActiveNet adapter…
    const shared = [
      'Renfrew Park Community Centre',
      'Killarney Community Centre',
      'Kitsilano Community Centre',
      'Britannia Community Centre',
      'Trout Lake Community Centre',
    ];
    for (const name of shared) expect(lookupVenueGeo('vancouver', name), name).toBeDefined();
    // …while carrying no venue-level licence claim anywhere for anything to misread.
    expect(requiredGeoAttributions().every((a) => !('venue' in a))).toBe(true);
  });
});
