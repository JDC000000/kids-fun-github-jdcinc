// worker/core/venue.ts — deterministic venue resolver for ingest.
//
// Search radius/ranking only works when an occurrence's series points at a venue
// row. Adapters may provide venue metadata (name/address/phone/geo); this resolver
// creates or enriches the venue once, then returns the venue_id for
// activity_series. It is intentionally deterministic and does not call external
// geocoding services during ingest.
//
// ENRICHMENT IS ONE MECHANISM, NOT ONE PER FIELD. Every optional field below is
// enriched by the same `COALESCE(<incoming>, <stored>)` in enrichVenue — a non-null
// incoming value OVERWRITES the stored one, and the stored one survives only when the
// adapter sends nothing. That is LAST-WRITER-WINS, not gap-filling (the wording the
// venue-geo round's F3/F5 finding corrected). Any new venue field belongs in that same
// UPDATE list; it should never grow a bespoke merge rule, because two fields with two
// different merge semantics is how a row starts disagreeing with itself.
import type { Pool } from 'pg';

export interface VenueInput {
  name: string;
  address?: string | null;
  /**
   * Public contact number for the facility, as its source published it. Enriched on
   * exactly the same COALESCE terms as every other optional field here — non-null
   * overwrites, null preserves — so it needs no mechanism of its own. Only the
   * `activenet` family supplies it today; see supabase/migrations/0024_venue_phone.sql.
   */
  phone?: string | null;
  lat?: number | null;
  lng?: number | null;
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

/** Resolve by exact case-insensitive name, then enrich missing metadata. */
export async function resolveVenue(pool: Pool, input: VenueInput): Promise<VenueResult> {
  const name = input.name.trim();
  if (!name) throw new Error('venue name is required');

  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM venue WHERE lower(name) = lower($1) LIMIT 1`,
    [name]
  );

  if (existing.rows[0]) {
    await enrichVenue(pool, existing.rows[0].id, input);
    return { venueId: existing.rows[0].id, created: false };
  }

  const inserted = await pool.query<{ id: string }>(
    `WITH municipality AS (
       SELECT id FROM region WHERE level = 'municipality' AND name = $3 LIMIT 1
     )
     INSERT INTO venue (name, address, municipality_id, display_area, official_url, geo, phone)
     VALUES (
       $1,
       $2,
       (SELECT id FROM municipality),
       $4,
       $5,
       CASE WHEN $6::double precision IS NULL OR $7::double precision IS NULL
         THEN NULL
         ELSE ST_SetSRID(ST_MakePoint($7::double precision, $6::double precision), 4326)::geography
       END,
       $8
     )
     RETURNING id`,
    [
      name,
      input.address ?? null,
      input.municipalityName ?? null,
      input.displayArea ?? null,
      input.officialUrl ?? null,
      hasFiniteGeo(input) ? input.lat : null,
      hasFiniteGeo(input) ? input.lng : null,
      input.phone ?? null,
    ]
  );

  return { venueId: inserted.rows[0].id, created: true };
}

async function enrichVenue(pool: Pool, venueId: string, input: VenueInput): Promise<void> {
  await pool.query(
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
       geo = COALESCE(
         CASE WHEN $6::double precision IS NULL OR $7::double precision IS NULL
           THEN NULL
           ELSE ST_SetSRID(ST_MakePoint($7::double precision, $6::double precision), 4326)::geography
         END,
         geo
       )
     WHERE id = $2`,
    [
      input.address ?? null,
      venueId,
      input.municipalityName ?? null,
      input.displayArea ?? null,
      input.officialUrl ?? null,
      hasFiniteGeo(input) ? input.lat : null,
      hasFiniteGeo(input) ? input.lng : null,
      input.phone ?? null,
    ]
  );
}
