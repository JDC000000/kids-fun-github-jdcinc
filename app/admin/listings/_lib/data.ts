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
import { resolveVenue } from '@/worker/core/venue';
import { VENUE_GEO_AUTHORITY } from '@/worker/core/venue-geo-authority';
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

/**
 * Resolve-or-create a venue on the transaction client, through the SAME function the worker
 * uses — not a copy of it. This replaced a private reimplementation whose "mirrors
 * worker/core/venue.ts" comment had been false for some time; see that file's header for the
 * full story and for why there is now one implementation and two callers.
 *
 * BEHAVIOUR CHANGE WORTH NAMING: a manual listing at an EXISTING venue now updates that
 * venue's address / display_area / coordinates instead of discarding them — which is what
 * the form has always appeared to do.
 *
 * Authority 50, the strongest claim in the system: a human looked at THIS venue on purpose,
 * in-product, and `parseManualListingInput` (./vocab.ts) range-validates the coordinate.
 *
 * `geoIsHumanOverride` IS THE LOAD-BEARING PART OF THAT SENTENCE, and it was missing in the
 * first version of this function (QA finding F1, ship-blocking). Every admin write declares
 * the SAME tier, and the write rule leaves the incumbent at equal authority — so without the
 * flag the first admin coordinate stuck and every later correction was silently swallowed:
 * address and display_area updated, the pin did not, and nothing reported it. This is the ONE
 * caller in the repo permitted to set it; see `VenueInput.geoIsHumanOverride` for why a
 * deliberate human correction is a different kind of event from a repeated adapter run.
 */
async function resolveManualVenue(client: PoolClient, input: ManualListingInput): Promise<string> {
  const hasCoordinate = input.venueLat != null && input.venueLng != null;
  const { venueId } = await resolveVenue(client, {
    name: (input.venueName ?? '').trim(),
    address: input.venueAddress,
    displayArea: input.displayArea,
    lat: input.venueLat,
    lng: input.venueLng,
    geoAuthority: hasCoordinate ? VENUE_GEO_AUTHORITY.ADMIN_MANUAL : undefined,
    geoSource: hasCoordinate ? 'admin:manual-listing' : undefined,
    geoIsHumanOverride: hasCoordinate,
  });
  return venueId;
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
    const venueId = input.venueName ? await resolveManualVenue(client, input) : null;

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
