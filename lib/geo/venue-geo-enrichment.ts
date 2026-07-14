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
