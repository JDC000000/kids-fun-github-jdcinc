// worker/core/venue.ts — deterministic venue resolver for ingest.
//
// Search radius/ranking only works when an occurrence's series points at a venue
// row. Adapters may provide venue metadata (name/address/phone/geo); this resolver
// creates or updates the venue once, then returns the venue_id for
// activity_series. It is intentionally deterministic and does not call external
// geocoding services during ingest.
//
// ── TWO MERGE RULES, AND WHY THEY ARE NOT ONE ────────────────────────────────────────
//
// SCALAR FIELDS (address, municipality, display_area, official_url, phone) are merged by
// `COALESCE(<incoming>, <stored>)` — a non-null incoming value OVERWRITES the stored one,
// and the stored one survives only when the adapter sends nothing. That is LAST-WRITER-WINS
// (the wording the venue-geo round's F3/F5 finding corrected). Any new SCALAR venue field
// belongs in that same list; it should not grow a bespoke rule.
//
// GEO IS DIFFERENT, DELIBERATELY, AND IS THE ONE EXCEPTION. Until migration 0025 it was
// merged by the same COALESCE, which meant the coordinate a parent sees was whichever
// adapter's cron fired last. That is not a decision, it is an accident, and it was
// observable: activenet and citycalendar carry five byte-identically-named Vancouver
// venues, four of them up to ~802 m apart, whose stored point changed with ingest order.
// Every distance number, every radius filter and every map pin in the product reads that
// column, and a venue silently dropping out of a 5 km radius is invisible to a parent —
// it looks like fewer results, not an error.
//
// So geo is now ARBITRATED, not overwritten:
//
//     write iff incoming is non-NULL AND (stored geo IS NULL OR incoming authority
//     is STRICTLY GREATER than the stored authority)
//
// Higher authority wins · equal authority leaves the incumbent · lower authority fills a
// NULL only. The ordinal and every rung's justification live in ./venue-geo-authority.ts.
// The consequence worth stating: the stored coordinate is a pure function of WHICH sources
// have run, not of the order they ran in. That is proved, against a real database and over
// every permutation of the contested producers, in tests/geo/venue-geo-golden.test.ts.
//
// WHY THIS FUNCTION IS NO LONGER CALLED `enrichVenue`. "Enrich" means fill what is missing
// and leave what is there; it did the opposite, and the wrong name had already misdescribed
// the behaviour in this file, in worker/adapters/activenet/venues.ts and in a commit message
// — a documented recurrence, not a one-off. It is `writeVenueFacts` now, and the header
// above says which fields overwrite and which arbitrate.
//
// WHY THE CLIENT IS AN INTERFACE, NOT A `Pool`. `app/admin/listings/_lib/data.ts` used to
// carry its own copy of this resolver on a transaction client, under a comment claiming it
// "mirrors worker/core/venue.ts". It did not: the worker overwrote geo, and the admin copy
// returned early on a name hit and never updated geo at all. Two write paths with two merge
// rules and a comment asserting they were the same is how a system starts disagreeing with
// itself. There is now ONE implementation and two callers.
import type { QueryResult, QueryResultRow } from 'pg';
import type { VenueGeoAuthority } from './venue-geo-authority';

/**
 * The narrow slice of `pg` this module needs — satisfied by both a `Pool` (worker ingest)
 * and a `PoolClient` (the admin manual-listing transaction), so both go through the same
 * SQL rather than through two implementations that claim to match.
 */
export interface VenueDbClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
}

export interface VenueInput {
  name: string;
  address?: string | null;
  /**
   * Public contact number for the facility, as its source published it. Merged on exactly
   * the same COALESCE terms as every other SCALAR field here — non-null overwrites, null
   * preserves — so it needs no mechanism of its own. Only the `activenet` family supplies
   * it today; see supabase/migrations/0024_venue_phone.sql.
   */
  phone?: string | null;
  lat?: number | null;
  lng?: number | null;
  /**
   * REQUIRED whenever `lat`/`lng` are finite — supplying a coordinate without declaring
   * where it ranks throws, naming the venue, rather than defaulting. A default would either
   * let an unattributed source outrank a curated one (high default) or make a good source
   * silently useless (low default); both fail quietly, which is the failure mode this whole
   * change exists to remove. tests/compliance/venue-geo-authority-declared.test.ts stops the
   * omission at author time; this throw stops it at run time.
   */
  geoAuthority?: VenueGeoAuthority | null;
  /** Stable identifier for where the coordinate came from, e.g. 'activenet:opendata-vancouver'. */
  geoSource?: string | null;
  /**
   * Third-party licence-notice key the coordinate obliges us to publish ('ogl-vancouver',
   * 'osm-odbl'). Explicit, never inferred from a venue name — that inference is exactly what
   * got the per-venue attribution surface pulled (docs/source-register.md §6.6).
   */
  geoAttribution?: string | null;
  /**
   * This write is a DELIBERATE HUMAN CORRECTION, so it wins at EQUAL authority as well as
   * higher. **Adapters must never set this.** Only `app/admin/listings/` does.
   *
   * WHY THIS DOES NOT WEAKEN THE ORDER-INDEPENDENCE GUARANTEE, which is the whole point of
   * this module and the reason the flag is scoped this tightly. The guarantee is about
   * INTERCHANGEABLE AUTOMATED RUNS: two cron runs of the same adapter are the same event
   * happening twice, so "which ran last" must not decide anything. Two human edits are NOT
   * interchangeable — the later one IS the intent, by definition. Order-dependence among
   * deliberate human corrections is the CORRECT behaviour, not a leak in the rule.
   *
   * WHAT IT COST TO LEARN THAT (QA finding F1, and it was ship-blocking): every admin write
   * declares the same tier, and equal authority leaves the incumbent — so the FIRST admin
   * coordinate stuck and every later correction was silently swallowed. Address and
   * display_area updated, the pin did not, and nothing said so. The commit that introduced
   * the shared resolver claimed admin edits "now update coordinates instead of discarding
   * them"; that claim was TRUE for the first write and FALSE for every one after it.
   *
   * It stays `>=`, never "always wins": at the top tier that only ever ties with another
   * human, and if a higher tier is ever added, a human override must not silently outrank it.
   */
  geoIsHumanOverride?: boolean;
  municipalityName?: string | null;
  displayArea?: string | null;
  officialUrl?: string | null;
}

export interface VenueResult {
  venueId: string;
  created: boolean;
}

function hasFiniteGeo(input: VenueInput): input is VenueInput & { lat: number; lng: number } {
  return Number.isFinite(input.lat) && Number.isFinite(input.lng);
}

interface GeoWrite {
  lat: number | null;
  lng: number | null;
  authority: number | null;
  source: string | null;
  attribution: string | null;
  isHumanOverride: boolean;
}

/** Coordinate + its declared provenance, or all-NULL when the caller sent no usable point. */
function geoWrite(input: VenueInput, name: string): GeoWrite {
  if (!hasFiniteGeo(input)) {
    return {
      lat: null,
      lng: null,
      authority: null,
      source: null,
      attribution: null,
      isHumanOverride: false,
    };
  }
  if (input.geoAuthority === undefined || input.geoAuthority === null) {
    throw new Error(
      `venue "${name}": a coordinate was supplied with no declared geoAuthority. ` +
        'Every path that writes venue.geo must declare where its coordinate ranks — ' +
        'see worker/core/venue-geo-authority.ts.'
    );
  }
  return {
    lat: input.lat,
    lng: input.lng,
    authority: input.geoAuthority,
    source: input.geoSource ?? null,
    attribution: input.geoAttribution ?? null,
    isHumanOverride: input.geoIsHumanOverride === true,
  };
}

/**
 * The arbitration, as one SQL predicate, declared ONCE and interpolated into the UPDATE's
 * five geo assignments. It is a module constant containing nothing but `$n` placeholders —
 * no value is ever interpolated into it — so it carries no injection surface, and writing it
 * once is what stops the five assignments drifting apart.
 *
 * `$12` is the human-override escape: `>=` instead of `>`, for deliberate human corrections
 * ONLY (see `VenueInput.geoIsHumanOverride`). No adapter sets it, so the order-independence
 * guarantee over automated producers is untouched.
 *
 * AN EARLIER VERSION ALSO CARRIED `AND $9::smallint IS NOT NULL`, REMOVED DELIBERATELY (QA
 * finding F3). It was unreachable — `geoWrite()` throws before any caller can get here with a
 * coordinate and no authority — so it was untested code defending nothing, and a mutation
 * deleting it survived the whole suite, which is exactly what untested code looks like. Its
 * removal is also a small improvement: on the impossible path it converted a LOUD CHECK
 * violation (`venue_geo_authority_paired`, migration 0025) into a SILENT no-op, and loud is
 * the posture this change exists to establish. If `geoWrite()`'s throw is ever removed, the
 * database refuses the row rather than storing an unrankable coordinate.
 */
const GEO_INCOMING_WINS = `(
       $6::double precision IS NOT NULL
   AND $7::double precision IS NOT NULL
   AND (
         geo IS NULL
      OR $9::smallint > geo_authority
      OR ($12::boolean AND $9::smallint >= geo_authority)
   )
 )`;

const INCOMING_POINT =
  'ST_SetSRID(ST_MakePoint($7::double precision, $6::double precision), 4326)::geography';

/** Resolve by exact case-insensitive name, then merge incoming facts onto the row. */
export async function resolveVenue(db: VenueDbClient, input: VenueInput): Promise<VenueResult> {
  const name = input.name.trim();
  if (!name) throw new Error('venue name is required');
  const geo = geoWrite(input, name);

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM venue WHERE lower(name) = lower($1) LIMIT 1`,
    [name]
  );

  if (existing.rows[0]) {
    await writeVenueFacts(db, existing.rows[0].id, input, geo);
    return { venueId: existing.rows[0].id, created: false };
  }

  const inserted = await db.query<{ id: string }>(
    `WITH municipality AS (
       SELECT id FROM region WHERE level = 'municipality' AND name = $3 LIMIT 1
     )
     INSERT INTO venue (
       name, address, municipality_id, display_area, official_url, phone,
       geo, geo_authority, geo_source, geo_attribution, geo_set_at
     )
     VALUES (
       $1,
       $2,
       (SELECT id FROM municipality),
       $4,
       $5,
       $8,
       CASE WHEN $6::double precision IS NULL OR $7::double precision IS NULL
         THEN NULL ELSE ${INCOMING_POINT} END,
       -- The four provenance columns move as ONE unit with the coordinate: a row can never
       -- hold a point whose authority is unknown, nor an authority for a point it does not
       -- have (0025's venue_geo_authority_paired CHECK refuses both).
       CASE WHEN $6::double precision IS NULL OR $7::double precision IS NULL
         THEN NULL ELSE $9::smallint END,
       CASE WHEN $6::double precision IS NULL OR $7::double precision IS NULL
         THEN NULL ELSE $10::text END,
       CASE WHEN $6::double precision IS NULL OR $7::double precision IS NULL
         THEN NULL ELSE $11::text END,
       CASE WHEN $6::double precision IS NULL OR $7::double precision IS NULL
         THEN NULL ELSE now() END
     )
     RETURNING id`,
    [
      name,
      input.address ?? null,
      input.municipalityName ?? null,
      input.displayArea ?? null,
      input.officialUrl ?? null,
      geo.lat,
      geo.lng,
      input.phone ?? null,
      geo.authority,
      geo.source,
      geo.attribution,
    ]
  );

  return { venueId: inserted.rows[0].id, created: true };
}

/**
 * Merge incoming venue facts onto an existing row. Scalars overwrite (last-writer-wins);
 * geo is arbitrated by declared coordinate authority. See this file's header for why the
 * two rules differ and why this is no longer called `enrichVenue`.
 */
async function writeVenueFacts(
  db: VenueDbClient,
  venueId: string,
  input: VenueInput,
  geo: GeoWrite
): Promise<void> {
  await db.query(
    `WITH municipality AS (
       SELECT id FROM region WHERE level = 'municipality' AND name = $3 LIMIT 1
     )
     UPDATE venue
     SET
       address = COALESCE($1, address),
       municipality_id = COALESCE((SELECT id FROM municipality), municipality_id),
       display_area = COALESCE($4, display_area),
       official_url = COALESCE($5, official_url),
       phone = COALESCE($8, phone),
       geo             = CASE WHEN ${GEO_INCOMING_WINS} THEN ${INCOMING_POINT} ELSE geo END,
       geo_authority   = CASE WHEN ${GEO_INCOMING_WINS} THEN $9::smallint ELSE geo_authority END,
       geo_source      = CASE WHEN ${GEO_INCOMING_WINS} THEN $10::text ELSE geo_source END,
       geo_attribution = CASE WHEN ${GEO_INCOMING_WINS} THEN $11::text ELSE geo_attribution END,
       geo_set_at      = CASE WHEN ${GEO_INCOMING_WINS} THEN now() ELSE geo_set_at END
     WHERE id = $2`,
    [
      input.address ?? null,
      venueId,
      input.municipalityName ?? null,
      input.displayArea ?? null,
      input.officialUrl ?? null,
      geo.lat,
      geo.lng,
      input.phone ?? null,
      geo.authority,
      geo.source,
      geo.attribution,
      geo.isHumanOverride,
    ]
  );
}
