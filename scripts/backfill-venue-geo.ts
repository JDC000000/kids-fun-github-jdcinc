// scripts/backfill-venue-geo.ts — Task 36 opt-in venue-geo enrichment runner.
//
// Out-of-band (NOT part of the deterministic ingest loop in worker/core/venue.ts): finds
// venues that already have a real street address but no coordinates, geocodes each address
// once via Mapbox (lib/geo/geocode.ts), and fills the missing geo. Idempotent — the UPDATE
// only ever writes a NULL geo, so re-runs and concurrent ingest can't be clobbered, and a
// venue whose address doesn't resolve is simply left NULL to retry later.
//
// Lives in the ROOT project (not worker/) so it is typechecked by `npm run typecheck` and
// shares the same lib/geo + lib/db code that the app and tests use. Run it with vite-node,
// which is bundled with vitest and resolves the repo's TS + "@/" alias exactly like the
// test suite (a plain `node` invocation cannot resolve the extensionless TS imports).
//
// Usage (DATABASE_URL + GEOCODING_API_KEY in env):
//   npx vite-node scripts/backfill-venue-geo.ts -- --dry-run
//   npx vite-node scripts/backfill-venue-geo.ts -- --limit 50
// (equivalently: node_modules/.bin/vite-node scripts/backfill-venue-geo.ts -- --dry-run)
import { query, closePool } from '../lib/db/client';
import { geocode } from '../lib/geo/geocode';
import { VENUE_GEO_AUTHORITY } from '../worker/core/venue-geo-authority';
import {
  enrichVenueGeo,
  type EnrichVenueGeoDeps,
  type VenueGeoRow,
} from '../lib/geo/venue-geo-enrichment';

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

const LIST_MISSING_SQL = `
  SELECT id, name, address
  FROM venue
  WHERE geo IS NULL AND address IS NOT NULL AND btrim(address) <> ''
  ORDER BY name
  LIMIT $1`;

// Idempotent: fills a NULL geo only; never overwrites an existing (feed/deterministic) point.
//
// `AND geo IS NULL` IS RETAINED ON PURPOSE AND IS STRICTER THAN THE AUTHORITY RULE. Migration
// 0025 stamps every pre-existing coordinate `geo_authority = 0`, and this writer declares
// tier 5 — so under the authority rule ALONE (5 > 0) this script would newly be permitted to
// overwrite every legacy hand-placed coordinate in the database with an address-derived
// Mapbox guess. That would be a regression introduced by a change whose entire purpose is to
// protect coordinates. The ordinal is a CEILING on what a writer may do, not a licence; this
// path is deliberately stricter than its ceiling, and it stays the only writer in the system
// that structurally cannot clobber.
const SET_GEO_SQL = `
  UPDATE venue
  SET geo = ST_SetSRID(ST_MakePoint($2::double precision, $3::double precision), 4326)::geography,
      geo_authority = $4::smallint,
      geo_source = 'geocoder:mapbox-backfill',
      geo_set_at = now()
  WHERE id = $1 AND geo IS NULL`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const dryRun = hasFlag(argv, '--dry-run');
  const limit = Number(argValue(argv, '--limit') ?? 100);

  const deps: EnrichVenueGeoDeps = {
    listMissing: (lim) => query<VenueGeoRow>(LIST_MISSING_SQL, [lim]),
    async setGeo(id, lat, lng) {
      // pg params: $2 = lng (x), $3 = lat (y) → ST_MakePoint(lng, lat).
      await query(SET_GEO_SQL, [id, lng, lat, VENUE_GEO_AUTHORITY.GEOCODER_BACKFILL]);
    },
    geocode: (address) => geocode(address, { region: 'CA' }),
  };

  try {
    const result = await enrichVenueGeo(deps, {
      limit,
      dryRun,
      delayMs: 200, // stay comfortably under Mapbox rate limits
      // eslint-disable-next-line no-console
      onProgress: (m) => console.log(m),
    });
    // JSON summary only; no connection strings or secrets.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ dryRun, ...result }));
    return 0;
  } finally {
    await closePool();
  }
}

// This file is a standalone CLI entry (never imported by app or test code), so run on load.
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
    );
    process.exit(1);
  });
