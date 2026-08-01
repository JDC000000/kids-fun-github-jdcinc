// lib/geo/venue-geo-enrichment.ts — Task 36: opt-in, idempotent backfill that fills a
// venue's coordinates from its street address via the Mapbox geocoder (lib/geo/geocode.ts).
//
// WHY THIS IS SEPARATE FROM INGEST:
//   worker/core/venue.ts is deterministic by design and never calls an external geocoder
//   during ingest (adapters attach feed-sourced or deterministic-map coordinates, or leave
//   geo NULL). Most venues already have good feed coordinates; the citycalendar adapter
//   even documents "geo stays NULL until enriched" for venues it can't map deterministically.
//   This module is that enrichment step: run out-of-band (not per occurrence), it geocodes
//   ONLY the residual venues that have a real address but no geo, so it can't regress a
//   better existing source and makes at most one call per such venue.
//
// It is pure/injectable: the SQL (listMissing/setGeo) and the geocoder are passed in, so it
// unit-tests offline and the worker runner (worker/src/backfill-venue-geo.ts) supplies the
// live Postgres pool + real Mapbox geocode.

import type { LatLong } from './geocode';

/**
 * The two statements the backfill runs, HERE rather than in the CLI wrapper.
 *
 * They used to live in `scripts/backfill-venue-geo.ts`, which runs `main()` on load and says
 * so in its own comment ("never imported by app or test code"). That made the clobber-guard
 * untestable by anything except a text regex — which proves somebody typed the words, not that
 * the statement behaves that way (QA finding F4). SQL belongs with the module that owns the
 * behaviour, not with the CLI entry point that happens to invoke it.
 */
export const LIST_MISSING_GEO_SQL = `
  SELECT id, name, address
  FROM venue
  WHERE geo IS NULL AND address IS NOT NULL AND btrim(address) <> ''
  ORDER BY name
  LIMIT $1`;

/**
 * `AND geo IS NULL` IS STRICTER THAN THE AUTHORITY RULE, ON PURPOSE. This writer's tier
 * outranks the legacy tier migration 0025 stamps onto every pre-existing coordinate, so the
 * ordinal ALONE would newly let the weakest source in the system overwrite every hand-placed
 * point in the database with an address-derived guess. Deleting this predicate is a silent,
 * global, one-line regression. Full reasoning: `GEOCODER_BACKFILL` in
 * worker/core/venue-geo-authority.ts. Behaviourally pinned by
 * tests/geo/backfill-clobber-guard.test.ts.
 *
 * pg params: $1 = venue id, $2 = lng (x), $3 = lat (y), $4 = geo_authority.
 */
export const SET_GEO_SQL = `
  UPDATE venue
  SET geo = ST_SetSRID(ST_MakePoint($2::double precision, $3::double precision), 4326)::geography,
      geo_authority = $4::smallint,
      geo_source = 'geocoder:mapbox-backfill',
      geo_set_at = now()
  WHERE id = $1 AND geo IS NULL`;

export interface VenueGeoRow {
  id: string;
  name: string;
  address: string;
}

export interface EnrichVenueGeoDeps {
  /** Venues with a real address but no geo yet (bounded by `limit`). */
  listMissing(limit: number): Promise<VenueGeoRow[]>;
  /** Persist a resolved point (idempotent: implementation should only fill a NULL geo). */
  setGeo(id: string, lat: number, lng: number): Promise<void>;
  /** Address → point. Mapbox in production; injected fake in tests. */
  geocode(address: string): Promise<LatLong | null>;
}

export interface EnrichVenueGeoOptions {
  /** Max venues to process this run (default 100). */
  limit?: number;
  /** Preview only — geocode + report but do NOT write. */
  dryRun?: boolean;
  /** Optional politeness delay between geocode calls (ms) to stay well under rate limits. */
  delayMs?: number;
  /** Progress sink (defaults to no-op). */
  onProgress?: (message: string) => void;
  /** Injectable sleep (tests pass a no-op); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EnrichVenueGeoResult {
  considered: number;
  enriched: number;
  /** Names of venues whose address did not resolve (left NULL, safe to retry later). */
  unresolved: string[];
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Backfill venue coordinates from addresses. Returns counts; never throws on an
 * individual geocode miss (that venue stays NULL and is reported in `unresolved`).
 */
export async function enrichVenueGeo(
  deps: EnrichVenueGeoDeps,
  opts: EnrichVenueGeoOptions = {}
): Promise<EnrichVenueGeoResult> {
  const limit = opts.limit ?? 100;
  const report = opts.onProgress ?? (() => {});
  const sleep = opts.sleep ?? realSleep;

  const rows = await deps.listMissing(limit);
  const result: EnrichVenueGeoResult = { considered: rows.length, enriched: 0, unresolved: [] };

  for (const row of rows) {
    const point = await deps.geocode(row.address);
    if (!point) {
      result.unresolved.push(row.name);
      report(`skip (no geocode match): ${row.name} — ${row.address}`);
      continue;
    }
    if (!opts.dryRun) {
      await deps.setGeo(row.id, point.lat, point.long);
    }
    result.enriched += 1;
    report(
      `${opts.dryRun ? '[dry] ' : ''}${row.name} -> ${point.lat.toFixed(5)}, ${point.long.toFixed(5)}`
    );
    if (opts.delayMs && opts.delayMs > 0) await sleep(opts.delayMs);
  }

  return result;
}
