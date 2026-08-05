// lib/search/postgres-repository.ts — DB-backed listing read model for /api/search.
// Loads a denormalised activity_occurrence read model from Postgres into the
// existing search engine shape. The route keeps this behind an explicit backend
// flag; fixture/default mode is a separate local/demo path.
import type { Pool } from 'pg';
import { HIDDEN_STATUSES } from './filters/status';
import type { ConfidenceLabel, CostStatus, ListingRecord, StatusState } from './types';

interface ListingRow {
  id: string;
  series_id: string;
  activity_name: string;
  primary_category_key: string | null;
  tag_keys: string[] | null;
  venue_name: string | null;
  source_name: string | null;
  series_title: string | null;
  source_authority_tier: string | null;
  description_snippet: string | null;
  start_datetime_utc: Date | string | null;
  end_datetime_utc: Date | string | null;
  open_hours_state: string | null;
  cost_status: CostStatus;
  cost_min_cad: string | number | null;
  cost_max_cad: string | number | null;
  source_url: string | null;
  booking_url: string | null;
  location_url: string | null;
  status_state: StatusState;
  confidence_label: string | null;
  last_checked_at: Date | string | null;
  age_min_months: number | null;
  age_max_months: number | null;
  age_notes: string | null;
  age_band_keys: string[] | null;
  lat: number | string | null;
  lng: number | string | null;
  municipality_id: string | null;
  neighbourhood: string | null;
  display_area: string | null;
  phone: string | null;
}

export interface LoadPostgresListingsOptions {
  /**
   * Optional test/operator guard. The production search route must omit this so text and filter
   * matching see the complete visible catalogue; a pre-search SQL cap hides rows from every query.
   */
  limit?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function loadPostgresListings(
  pool: Pool,
  options: LoadPostgresListingsOptions = {}
): Promise<ListingRecord[]> {
  const limit = normalizeLimit(options.limit);
  const limitSql = limit == null ? '' : '\n     LIMIT $2';
  // Hidden-status filtering belongs in SQL so the read model never feeds unrenderable rows into
  // the engine, and so any explicitly requested diagnostic cap is spent only on parent-visible
  // content. Statuses come from HIDDEN_STATUSES so this cannot drift from the engine's `isHidden`.
  const { rows } = await pool.query<ListingRow>(
    `${listingSelectSql()}
     WHERE ${visibleOccurrenceWhereSql()}
       AND o.status_state::text <> ALL($1::text[])
     ${listingGroupBySql()}
     ORDER BY o.start_datetime_utc NULLS LAST, o.last_checked_at DESC NULLS LAST, o.created_at DESC${limitSql}`,
    limit == null ? [HIDDEN_STATUSES] : [HIDDEN_STATUSES, limit]
  );

  return rows.map(rowToListing);
}

/**
 * Load one visible occurrence for the detail page without scanning the whole read model.
 *
 * Deliberately does NOT apply the hidden-status predicate the list query above does. The list path
 * is broad catalogue discovery; a detail lookup is reached by an explicit id, so narrowing it here
 * would only break already-shared links. The detail page renders each status with its own honest
 * copy, so an unverified row stays truthful.
 */
export async function loadPostgresListingById(pool: Pool, id: string): Promise<ListingRecord | null> {
  if (!UUID_RE.test(id)) return null;

  const { rows } = await pool.query<ListingRow>(
    `${listingSelectSql()}
     WHERE ${visibleOccurrenceWhereSql()}
       AND o.id = $1
     ${listingGroupBySql()}
     LIMIT 1`,
    [id]
  );

  return rows[0] ? rowToListing(rows[0]) : null;
}

function listingSelectSql(): string {
  return `SELECT
       o.id,
       o.series_id,
       o.activity_name,
       c.key AS primary_category_key,
       COALESCE(array_remove(array_agg(DISTINCT t.key), NULL), '{}') AS tag_keys,
       v.name AS venue_name,
       s.name AS source_name,
       ser.canonical_title AS series_title,
       s.authority_tier AS source_authority_tier,
       o.description_snippet,
       o.start_datetime_utc,
       o.end_datetime_utc,
       o.open_hours_state,
       o.cost_status,
       o.cost_min_cad,
       o.cost_max_cad,
       o.source_url,
       o.booking_url,
       o.location_url,
       o.status_state,
       o.confidence_label,
       o.last_checked_at,
       oa.age_min_months,
       oa.age_max_months,
       oa.age_notes,
       COALESCE(array_remove(array_agg(DISTINCT ab.key), NULL), '{}') AS age_band_keys,
       CASE WHEN v.geo IS NULL THEN NULL ELSE ST_Y(v.geo::geometry) END AS lat,
       CASE WHEN v.geo IS NULL THEN NULL ELSE ST_X(v.geo::geometry) END AS lng,
       v.municipality_id::text AS municipality_id,
       v.neighbourhood,
       v.display_area,
       v.phone
     FROM activity_occurrence o
     JOIN activity_series ser ON ser.id = o.series_id
     JOIN source s ON s.id = ser.source_id
     LEFT JOIN venue v ON v.id = ser.venue_id
     LEFT JOIN category c ON c.id = o.primary_category_id
     LEFT JOIN occurrence_category_tag oct ON oct.occurrence_id = o.id
     LEFT JOIN tag t ON t.id = oct.tag_id
     LEFT JOIN occurrence_age oa ON oa.occurrence_id = o.id
     LEFT JOIN LATERAL unnest(oa.age_band_matches) AS band_id(id) ON true
     LEFT JOIN age_band ab ON ab.id = band_id.id`;
}

function normalizeLimit(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(1, Math.min(Math.trunc(value), 1000));
}

function visibleOccurrenceWhereSql(): string {
  return `o.archived_at IS NULL
       AND (o.open_hours_state IS NOT NULL OR COALESCE(o.end_datetime_utc, o.start_datetime_utc) >= now())`;
}

function listingGroupBySql(): string {
  return `GROUP BY
       o.id, o.series_id, o.activity_name, c.key, v.name, s.name, ser.canonical_title, s.authority_tier,
       o.description_snippet, o.start_datetime_utc, o.end_datetime_utc, o.open_hours_state,
       o.cost_status, o.cost_min_cad, o.cost_max_cad, o.source_url, o.booking_url,
       o.location_url, o.status_state, o.confidence_label, o.last_checked_at,
       oa.age_min_months, oa.age_max_months, oa.age_notes, v.geo, v.municipality_id, v.neighbourhood, v.display_area, v.phone`;
}

function rowToListing(row: ListingRow): ListingRecord {
  const categoryKey = row.primary_category_key ?? categoryKeyFromTitle(row.activity_name);
  const tagKeys = row.tag_keys ?? [];
  const sourceName = row.source_name ?? 'Source';
  const venueName = row.venue_name ?? venueFromSeriesTitle(row.series_title ?? row.activity_name) ?? sourceName;

  return {
    id: row.id,
    seriesId: row.series_id,
    activityName: row.activity_name,
    primaryCategoryKey: categoryKey,
    categoryTags: unique([categoryKey, ...tagKeys]),
    venueName,
    organisation: sourceName,
    descriptionSnippet: row.description_snippet ?? '',
    suitabilityTags: suitabilityTags(categoryKey, tagKeys),
    startDatetimeUtc: iso(row.start_datetime_utc),
    endDatetimeUtc: iso(row.end_datetime_utc),
    openHours: Boolean(row.open_hours_state),
    openHoursLocal: null,
    costStatus: row.cost_status,
    costMinCad: money(row.cost_min_cad),
    costMaxCad: money(row.cost_max_cad),
    statusState: row.status_state,
    confidenceLabel: confidence(row.confidence_label, row.source_authority_tier, row.last_checked_at),
    lastCheckedAtUtc: iso(row.last_checked_at),
    ageBandMatches: (row.age_band_keys ?? []).filter(isAgeBandKey),
    ageMinMonths: row.age_min_months,
    ageMaxMonths: row.age_max_months,
    ageNotes: cleanText(row.age_notes),
    geo: row.lat != null && row.lng != null ? { lat: Number(row.lat), lng: Number(row.lng) } : null,
    municipalityId: row.municipality_id,
    neighbourhood: row.neighbourhood,
    displayArea: row.display_area,
    venuePhone: row.phone,
    sourceUrl: row.source_url,
    bookingUrl: row.booking_url,
    locationUrl: row.location_url,
  };
}

function categoryKeyFromTitle(title: string): string {
  const t = title.toLowerCase();
  if (/story\s*time|babytime|toddler\s*time/.test(t)) return 'storytime';
  if (/duplo|lego|free\s+play|play\s+time|indoor\s+play/.test(t)) return 'indoor_play';
  if (/swim|pool/.test(t)) return 'public_swim';
  if (/skate|skating/.test(t)) return 'skate';
  if (/open\s+gym|gymnasium/.test(t)) return 'open_gym';
  if (/park|nature|farm|trail/.test(t)) return 'outdoor_park';
  if (/festival|special\s+event/.test(t)) return 'festival_event';
  if (/museum|gallery|exhibit/.test(t)) return 'museum_venue';
  return 'class_program';
}

function suitabilityTags(categoryKey: string, tagKeys: string[]): string[] {
  const out = new Set(tagKeys);
  if (categoryKey === 'storytime' || categoryKey === 'indoor_play' || categoryKey === 'class_program') {
    out.add('indoor');
  }
  return [...out];
}

function confidence(label: string | null, authority: string | null, checked: Date | string | null): ConfidenceLabel {
  const daysOld = checked ? (Date.now() - new Date(checked).getTime()) / 86_400_000 : Number.POSITIVE_INFINITY;
  if (authority === 'official' && daysOld <= 7) return 'official_recent';
  if (authority === 'official') return 'official';
  if (label === 'high') return 'official';
  if (label === 'medium') return 'editorial';
  if (label === 'low') return 'inferred';
  return 'inferred';
}

function money(value: string | number | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Trim source free-text; collapse empty/whitespace-only values to null so the UI can skip them. */
function cleanText(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function venueFromSeriesTitle(title: string): string | null {
  const parts = title.split(' — ');
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

function isAgeBandKey(value: string): value is ListingRecord['ageBandMatches'][number] {
  return ['under2', '2-4', '5-9', '10-14', '15+'].includes(value);
}
