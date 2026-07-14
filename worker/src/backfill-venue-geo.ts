// worker/src/backfill-venue-geo.ts — Task 36 opt-in venue-geo enrichment runner.
//
// Out-of-band (NOT part of the deterministic ingest loop in worker/core/venue.ts): finds
// venues that already have a real street address but no coordinates, geocodes each address
// once via Mapbox (lib/geo/geocode.ts), and fills the missing geo. Idempotent — the UPDATE
// only ever writes a NULL geo, so re-runs and concurrent ingest can't be clobbered, and a
// venue whose address doesn't resolve is simply left NULL to retry later.
//
// Usage (DATABASE_URL + GEOCODING_API_KEY in env):
//   node --experimental-strip-types worker/src/backfill-venue-geo.ts --dry-run
//   node --experimental-strip-types worker/src/backfill-venue-geo.ts --limit 50
import { createPool } from './db';
import { geocode } from '../../lib/geo/geocode';
import { enrichVenueGeo, type EnrichVenueGeoDeps } from '../../lib/geo/venue-geo-enrichment';

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
const SET_GEO_SQL = `
  UPDATE venue
  SET geo = ST_SetSRID(ST_MakePoint($2::double precision, $3::double precision), 4326)::geography
  WHERE id = $1 AND geo IS NULL`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const dryRun = hasFlag(argv, '--dry-run');
  const limit = Number(argValue(argv, '--limit') ?? 100);
  const pool = createPool();

  const deps: EnrichVenueGeoDeps = {
    async listMissing(lim) {
      const { rows } = await pool.query<{ id: string; name: string; address: string }>(
        LIST_MISSING_SQL,
        [lim]
      );
      return rows;
    },
    async setGeo(id, lat, lng) {
      // pg params: $2 = lng (x), $3 = lat (y) → ST_MakePoint(lng, lat).
      await pool.query(SET_GEO_SQL, [id, lng, lat]);
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
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
      process.exit(1);
    });
}
