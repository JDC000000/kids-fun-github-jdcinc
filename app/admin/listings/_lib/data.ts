// app/admin/listings/_lib/data.ts — G-T34-3 manual-curation lane DB model. SERVER-ONLY.
//
// createManualListing reproduces, in ONE transaction, the exact writes the ingestion
// pipeline makes (worker/core: resolveVenue → resolveSeries → upsertOccurrence) so a
// hand-entered listing is structurally identical to an ingested one and renders on
// /search and /preview/[id]. It attaches to a chosen source (or a canonical, get-or-
// created "Manual Curation" source) and writes an admin_audit_log row — all atomic.
import type { PoolClient } from 'pg';
import { query } from '@/lib/db/client';
import { writeAdminAudit, withAdminTransaction, ADMIN_AUDIT_ACTIONS } from '@/lib/admin/audit';
import type { ManualListingInput } from './vocab';

/** Raised for user-fixable problems (e.g. a chosen source id that no longer exists). */
export class ManualListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualListingError';
  }
}

export interface SourceOption {
  id: string;
  label: string;
}

/** Sources for the intake dropdown — the Manual Curation source (if present) floats to the top-of-mind label. */
export async function listSourcesForSelect(): Promise<SourceOption[]> {
  const rows = await query<{ id: string; family: string; name: string }>(
    `SELECT id, family, name FROM source ORDER BY family ASC, name ASC`
  );
  return rows.map((r) => ({ id: r.id, label: `${r.name} (${r.family})` }));
}

/** The health states available in the intake form — the live status_state enum. */
export async function getStatusStateOptions(): Promise<string[]> {
  const rows = await query<{ v: string }>(`SELECT unnest(enum_range(NULL::status_state))::text AS v`);
  return rows.map((r) => r.v);
}

export interface CreateManualListingResult {
  occurrenceId: string;
  seriesId: string;
  sourceId: string;
  venueId: string | null;
}

/**
 * Get-or-create the canonical Manual Curation source (family='manual'). Runs on the
 * caller's transaction client so a first-ever manual listing that also creates the
 * source is still atomic.
 */
async function getOrCreateManualSource(client: PoolClient): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO source (family, name, authority_tier, ingestion_method, terms_status, robots_status, health_state)
     VALUES ('manual', 'Manual Curation', 'manual', 'manual', 'allowed', 'allowed', 'healthy')
     ON CONFLICT (family, name) DO NOTHING
     RETURNING id`
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM source WHERE family = 'manual' AND name = 'Manual Curation' LIMIT 1`
  );
  return existing.rows[0].id;
}

/** Resolve-or-create a venue (mirrors worker/core/venue.ts, on the tx client). */
async function resolveVenue(client: PoolClient, input: ManualListingInput): Promise<string> {
  const name = (input.venueName ?? '').trim();
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM venue WHERE lower(name) = lower($1) LIMIT 1`,
    [name]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO venue (name, address, display_area, geo)
     VALUES (
       $1, $2, $3,
       CASE WHEN $4::double precision IS NULL OR $5::double precision IS NULL
         THEN NULL
         ELSE ST_SetSRID(ST_MakePoint($5::double precision, $4::double precision), 4326)::geography
       END
     )
     RETURNING id`,
    [name, input.venueAddress, input.displayArea, input.venueLat, input.venueLng]
  );
  return inserted.rows[0].id;
}

/** Resolve-or-create the series (mirrors worker/core/series.ts, on the tx client). */
async function resolveSeries(
  client: PoolClient,
  sourceId: string,
  canonicalTitle: string,
  venueId: string | null
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO activity_series (canonical_title, source_id, venue_id, season_state)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (source_id, canonical_title) DO UPDATE SET
       venue_id = COALESCE(activity_series.venue_id, EXCLUDED.venue_id),
       updated_at = now()
     RETURNING id`,
    [canonicalTitle, sourceId, venueId]
  );
  return res.rows[0].id;
}

/**
 * Create a manual listing (venue? → series → occurrence) + its audit row, atomically.
 * @throws ManualListingError for a chosen source id that doesn't exist.
 */
export async function createManualListing(
  input: ManualListingInput,
  adminUserId: string
): Promise<CreateManualListingResult> {
  return withAdminTransaction(async (client) => {
    // 1. source — chosen existing one, else the canonical manual source.
    let sourceId: string;
    if (input.sourceId) {
      const found = await client.query<{ id: string }>(`SELECT id FROM source WHERE id = $1`, [input.sourceId]);
      if (!found.rows[0]) throw new ManualListingError('The selected source no longer exists — reload the form.');
      sourceId = found.rows[0].id;
    } else {
      sourceId = await getOrCreateManualSource(client);
    }

    // 2. venue (optional — needed only for a distance/geo).
    const venueId = input.venueName ? await resolveVenue(client, input) : null;

    // 3. series (get-or-create on source_id + canonical_title).
    const canonicalTitle = input.venueName ? `${input.title} — ${input.venueName}` : input.title;
    const seriesId = await resolveSeries(client, sourceId, canonicalTitle, venueId);

    // 4. occurrence (the listing row search reads).
    const occ = await client.query<{ id: string }>(
      `INSERT INTO activity_occurrence
         (series_id, activity_name, description_snippet, start_datetime_utc, end_datetime_utc, open_hours_state,
          cost_min_cad, cost_max_cad, cost_status, source_url, booking_url, location_url,
          status_state, confidence_label, last_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::cost_status,$10,$11,$12,$13::status_state,$14,now())
       RETURNING id`,
      [
        seriesId,
        input.title,
        input.descriptionSnippet,
        input.startDatetimeUtc,
        input.endDatetimeUtc,
        input.openHoursState,
        input.costMinCad,
        input.costMaxCad,
        input.costStatus,
        input.sourceUrl,
        input.bookingUrl,
        input.locationUrl,
        input.statusState,
        input.confidenceLabel,
      ]
    );
    const occurrenceId = occ.rows[0].id;

    // 5. audit — targets the occurrence (the created listing), snapshotting the whole graph.
    await writeAdminAudit(
      {
        adminUserId,
        action: ADMIN_AUDIT_ACTIONS.LISTING_CREATE,
        targetTable: 'activity_occurrence',
        targetId: occurrenceId,
        before: null,
        after: {
          occurrenceId,
          seriesId,
          sourceId,
          venueId,
          title: input.title,
          statusState: input.statusState,
          confidenceLabel: input.confidenceLabel,
          startDatetimeUtc: input.startDatetimeUtc,
          openHoursState: input.openHoursState,
        },
      },
      client
    );

    return { occurrenceId, seriesId, sourceId, venueId };
  });
}
