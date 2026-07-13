// lib/search/__fixtures__/engine.ts — Assemble a fixture-backed SearchEngine for tests + the API stub.

import type { GeoPoint } from '../types';
import type { Geocoder } from '../../geo/origin';
import { RegionHierarchy } from '../../geo/region';
import { FixtureAliasResolver } from '../expand';
import { InMemoryListingRepository } from '../repository';
import { SearchEngine } from '../engine';
import { REGIONS } from './regions';
import { ALIAS_SEED } from './aliases';
import { FIXTURE_LISTINGS } from './listings';

/** Minimal postal→point map for the saved-home origin mode (BR-06). */
const POSTAL_FIXTURE: Record<string, GeoPoint> = {
  V5L: { lat: 49.28, lng: -123.07 }, // East Van
  V6K: { lat: 49.264, lng: -123.165 }, // West Side
  V7M: { lat: 49.32, lng: -123.07 }, // North Van
};

export const fixtureGeocoder: Geocoder = {
  geocodePostal(postal: string): GeoPoint | null {
    const key = postal.trim().toUpperCase().slice(0, 3);
    return POSTAL_FIXTURE[key] ?? null;
  },
};

export interface FixtureEngineBundle {
  engine: SearchEngine;
  aliasResolver: FixtureAliasResolver;
  regionHierarchy: RegionHierarchy;
  repository: InMemoryListingRepository;
}

/** Build a fully-wired fixture engine plus its swappable deps (for admin/alias tests). */
export function makeFixtureEngine(): FixtureEngineBundle {
  const regionHierarchy = new RegionHierarchy(REGIONS);
  const aliasResolver = new FixtureAliasResolver(ALIAS_SEED);
  const repository = new InMemoryListingRepository(FIXTURE_LISTINGS);
  const engine = new SearchEngine({
    repository,
    aliasResolver,
    regionHierarchy,
    geocoder: fixtureGeocoder,
  });
  return { engine, aliasResolver, regionHierarchy, repository };
}

/** A stable reference instant for deterministic tests: 2026-07-13T12:00:00-07:00. */
export const FIXTURE_NOW = new Date('2026-07-13T19:00:00Z');
