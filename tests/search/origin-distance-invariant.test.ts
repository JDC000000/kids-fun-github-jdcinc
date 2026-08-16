// The invariant the page-level distance note is built on (app/search/_lib/distance-note.ts):
//
//     some result has distanceKm === null   ⟺   the response has origin === null
//
// It is NOT self-evident — it holds because of an interaction between two files that know
// nothing about each other. rank.ts returns a null distance for an un-geocoded venue OR for a
// missing origin; predicate.ts separately drops un-geocoded venues from the result set whenever
// an origin exists (withinRadius is false for a null geo). The second one is what collapses the
// first into a request-level fact, and it is the kind of thing a future radius refactor could
// remove without anyone noticing that a page's copy depended on it.
//
// So this file pins the interaction, not either half. If it fails, the /search distance note is
// making a claim the data no longer supports and needs to become per-card again.

import { describe, it, expect } from 'vitest';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import { makeFixtureEngine, FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';

const EAST_VAN = { lat: 49.26, lng: -123.07 };

function engineOver(listings: ReturnType<typeof makeListing>[]): SearchEngine {
  const { aliasResolver, regionHierarchy } = makeFixtureEngine();
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver,
    regionHierarchy,
    geocoder: { geocodePostal: () => null },
  });
}

const GEOCODED = makeListing({
  id: 'has-geo',
  activityName: 'Public Swim',
  primaryCategoryKey: 'public_swim',
  geo: { lat: 49.27, lng: -123.15 },
  statusState: 'confirmed',
  openHours: true,
});

const UN_GEOCODED = makeListing({
  id: 'no-geo',
  activityName: 'Public Swim',
  primaryCategoryKey: 'public_swim',
  geo: null,
  statusState: 'confirmed',
  openHours: true,
});

const items = (res: { results: { listing: { id: string }; distanceKm: number | null }[]; expected: { listing: { id: string }; distanceKm: number | null }[] }) => [
  ...res.results,
  ...res.expected,
];

describe('origin ⇒ distance, as a request-level fact', () => {
  const engine = engineOver([GEOCODED, UN_GEOCODED]);

  it('WITH an origin: every returned result has a real distance — the un-geocoded one is filtered out, not returned distance-less', () => {
    const res = engine.search({ q: 'swim', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: EAST_VAN }, minResults: 0 });
    expect(res.origin).not.toBeNull();
    expect(items(res).length).toBeGreaterThan(0);
    expect(items(res).every((r) => r.distanceKm != null)).toBe(true);
    // The venue we cannot locate is absent from the page entirely (radius filter), which is
    // precisely why "this card specifically is un-geocoded" is not a state the UI must express.
    expect(items(res).map((r) => r.listing.id)).not.toContain('no-geo');
  });

  it('WITHOUT an origin: every result is returned, and EVERY one has a null distance', () => {
    const res = engine.search({ q: 'swim', now: FIXTURE_NOW, minResults: 0 });
    expect(res.origin).toBeNull();
    expect(items(res).map((r) => r.listing.id)).toEqual(expect.arrayContaining(['has-geo', 'no-geo']));
    expect(items(res).every((r) => r.distanceKm == null)).toBe(true);
  });

  it('never returns a MIXED page — nulls and numbers together', () => {
    for (const origin of [{ mode: 'near_me' as const, coords: EAST_VAN }, null]) {
      const res = engine.search({ q: 'swim', now: FIXTURE_NOW, ...(origin ? { origin } : {}), minResults: 0 });
      const nulls = items(res).filter((r) => r.distanceKm == null).length;
      expect(nulls === 0 || nulls === items(res).length).toBe(true);
    }
  });
});

describe('an origin the engine could not resolve is origin-LESS, not origin-having', () => {
  const engine = engineOver([GEOCODED, UN_GEOCODED]);

  it('reports the failure AND a null origin when a saved home cannot be geocoded', () => {
    // The seam that makes the distinction matter: the REQUEST asked for an origin, so anything
    // reading the request parameters would conclude "origin present" and stay silent about
    // missing distances. The response knows better.
    const res = engine.search({
      q: 'swim',
      now: FIXTURE_NOW,
      signedIn: true,
      origin: { mode: 'saved_home', homePostal: 'V0V0V0' },
      minResults: 0,
    });
    expect(res.origin).toBeNull();
    expect(res.originError).toContain('geocode_failed');
    expect(items(res).every((r) => r.distanceKm == null)).toBe(true);
  });

  it('reports auth_required rather than silently searching as if a location were set', () => {
    const res = engine.search({
      q: 'swim',
      now: FIXTURE_NOW,
      origin: { mode: 'saved_home', homePostal: 'V5L1A1' },
      minResults: 0,
    });
    expect(res.origin).toBeNull();
    expect(res.originError).toContain('auth_required');
  });
});
