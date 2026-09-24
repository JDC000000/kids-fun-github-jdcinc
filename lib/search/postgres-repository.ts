// lib/search/postgres-repository.ts — DB-backed listing read model for /api/search.
// Loads a denormalised activity_occurrence read model from Postgres into the
// existing search engine shape. The route keeps this behind an explicit backend
// flag; fixture/default mode is a separate local/demo path.
import type { Pool } from 'pg';
import { HIDDEN_STATUSES } from './filters/status';
import { INDOOR_CATEGORY_KEYS, indoorTextVerdict } from './indoor';
import type { ConfidenceLabel, CostStatus, ListingRecord, StatusState } from './types';
import { TtlPromiseCache } from './ttl-cache';
import { SharedCatalogueCache } from './shared-catalogue-cache';
import { nextDataCacheStore } from './next-data-cache-store';

interface ListingRow {
  id: string;
  series_id: string;
  activity_name: string;
  primary_category_key: string | null;
  tag_keys: string[] | null;
  venue_name: string | null;
  venue_address: string | null;
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
  registration_required: boolean | null;
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
 * The catalogue's CONTENT VERSION: a hash, computed inside Postgres, of exactly the rows and
 * columns `loadPostgresListings` reads — minus `last_checked_at` — for the rows visible at `cutoff`.
 * ~100 bytes cross the wire instead of the ~8.4MB catalogue. Consumed by the shared catalogue
 * cache (./shared-catalogue-cache.ts) to decide whether a reload is needed at all.
 *
 * WHY IT REUSES THE LOAD'S OWN SELECT, JOINS AND GROUP BY RATHER THAN HASHING BASE TABLES
 * So it cannot drift from what the load returns. Every column the read model gains is hashed the
 * day it is added, with no second list to remember to update; a hash over hand-picked base-table
 * columns would silently stop seeing changes to anything it forgot. The cost is that one probe is
 * one catalogue-sized query of database CPU (~0.7s on the current instance) — which is why probes
 * are rationed to one per interval, globally.
 *
 * WHY `last_checked_at` IS EXCLUDED: every crawl bumps it on every row it touches, so a hash that
 * includes it changes on every crawl and gates nothing (measured, 2026-09-23). Its staleness is
 * bounded by the cache's freshness floor instead.
 *
 * WHY A FIXED `cutoff` AND NOT `now()`: with `now()`, the visible set — and so the hash — changes
 * every time any occurrence ends, i.e. constantly. With a fixed cut-off at or before every request
 * the snapshot will serve, the hashed set is a SUPERSET of what any of those requests can see, so
 * any change to a row they could see changes the hash. Rows that end are dropped per request by
 * the cache itself, not detected here.
 */
export async function probePostgresCatalogueVersion(pool: Pool, cutoff: Date): Promise<string> {
  const { rows } = await pool.query<{ version: string | null; row_count: number }>(
    `SELECT count(*)::int AS row_count,
            md5(string_agg(md5((to_jsonb(catalogue) - 'last_checked_at')::text), '' ORDER BY catalogue.id)) AS version
       FROM (
         ${listingSelectSql()}
         WHERE ${visibleOccurrenceAtCutoffSql()}
           AND o.status_state::text <> ALL($1::text[])
         ${listingGroupBySql()}
       ) AS catalogue`,
    [HIDDEN_STATUSES, cutoff.toISOString()]
  );
  const row = rows[0];
  // An empty catalogue hashes to NULL; it still needs a version, and one no non-empty hash can equal.
  return `${row?.row_count ?? 0}:${row?.version ?? 'empty'}`;
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
       v.address AS venue_address,
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
       o.registration_required,
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

/**
 * The rows a parent may be shown: not archived, and either genuinely dateless or not yet over.
 *
 * THE `open_hours_state` ARM IS DELIBERATELY NARROWER THAN THE COLUMN'S NULLABILITY.
 * `open_hours_state IS NOT NULL` alone is NOT a safe "this record has no date" test, because
 * migration 0004's constraint is `CHECK (start_datetime_utc IS NOT NULL OR open_hours_state IS
 * NOT NULL)` — an OR, not an exclusive one. Nothing in the schema stops a row carrying BOTH a
 * standing-hours sentence AND a real (possibly long-past) start time; `assertSeparation()`
 * (worker/adapters/venue/separate.ts) enforces the split for the venue family only, so a bug in
 * any other adapter can produce one. Such a row would take the open-hours arm and skip the date
 * check entirely — a stale date hidden behind an hours string.
 *
 * So the dateless arm requires the date to be ACTUALLY ABSENT. A pool or drop-in gym with no
 * fixed date (open_hours_state set, start_datetime_utc null) stays visible indefinitely, which
 * is correct and unchanged; a row that has a date is judged on that date no matter what else it
 * carries.
 */
function visibleOccurrenceWhereSql(): string {
  return `o.archived_at IS NULL
       AND (
         (o.start_datetime_utc IS NULL AND o.open_hours_state IS NOT NULL)
         OR COALESCE(o.end_datetime_utc, o.start_datetime_utc) >= now()
       )`;
}

/**
 * `visibleOccurrenceWhereSql` with its `now()` instant replaced by the bound cut-off `$2` — the
 * version probe's visibility rule (see probePostgresCatalogueVersion).
 *
 * DERIVED, NOT COPIED, so the probe can never hash a different set of rows than the load returns:
 * any change to the predicate reaches both. And `visibleOccurrenceWhereSql` itself stays exactly as
 * it was, because tests/search/today-window-exhaustion.test.ts pins its body to the `now()`
 * instant (the JS mirror in occurrence-visibility.ts depends on it). If the predicate is ever
 * rewritten so that it no longer contains exactly one `>= now()`, this throws — the shared cache
 * then falls back to the direct load, and tests/search/catalogue-snapshot.test.ts goes red.
 */
function visibleOccurrenceAtCutoffSql(): string {
  const instant = '>= now()';
  const sql = visibleOccurrenceWhereSql();
  if (sql.split(instant).length !== 2) {
    throw new Error(
      'visibleOccurrenceWhereSql no longer contains exactly one `>= now()`; the catalogue version probe ' +
        'cannot derive its cut-off predicate from it. Update visibleOccurrenceAtCutoffSql.'
    );
  }
  return sql.replace(instant, '>= $2::timestamptz');
}

function listingGroupBySql(): string {
  return `GROUP BY
       o.id, o.series_id, o.activity_name, c.key, v.name, v.address, s.name, ser.canonical_title, s.authority_tier,
       o.description_snippet, o.start_datetime_utc, o.end_datetime_utc, o.open_hours_state,
       o.cost_status, o.cost_min_cad, o.cost_max_cad, o.source_url, o.booking_url,
       o.location_url, o.registration_required, o.status_state, o.confidence_label, o.last_checked_at,
       oa.age_min_months, oa.age_max_months, oa.age_notes, v.geo, v.municipality_id, v.neighbourhood, v.display_area, v.phone`;
}

function rowToListing(row: ListingRow): ListingRecord {
  const categoryKey = row.primary_category_key ?? categoryKeyFromTitle(row.activity_name);
  const tagKeys = row.tag_keys ?? [];
  const sourceName = row.source_name ?? 'Source';
  // NEVER the source's name. `source.name` is an internal ingestion label, not a place: the
  // venue-less citywide rows of the operator-curated import rendered "Operator manual research —
  // annual events & evergreen venues (2026-09)" as their venue on the card, the detail page and
  // the browser tab (QA, 2026-09-24). An empty name is this codebase's existing spelling of "no
  // venue known" — venueIdentity() reads it as no opinion, ThreeThings/SMS/InstantPicks already
  // omit it, and the display layer prints VENUE_NOT_STATED in its place.
  const venueName = row.venue_name ?? venueFromSeriesTitle(row.series_title ?? row.activity_name) ?? '';

  return {
    id: row.id,
    seriesId: row.series_id,
    activityName: row.activity_name,
    primaryCategoryKey: categoryKey,
    categoryTags: unique([categoryKey, ...tagKeys]),
    venueName,
    organisation: sourceName,
    descriptionSnippet: row.description_snippet ?? '',
    suitabilityTags: suitabilityTags(categoryKey, tagKeys, row),
    startDatetimeUtc: iso(row.start_datetime_utc),
    endDatetimeUtc: iso(row.end_datetime_utc),
    openHours: Boolean(row.open_hours_state),
    openHoursLocal: null,
    // The venue's own standing-hours sentence, verbatim. `openHoursLocal` above stays null
    // because nothing parses this free text into a numeric window yet — but the SENTENCE is
    // still the only honest "when" a dateless listing has, so it must reach the UI rather than
    // being selected and dropped here (which left the card with no date and no hours, and so
    // with nothing to print but a fabricated one).
    openHoursLabel: cleanText(row.open_hours_state),
    costStatus: row.cost_status,
    costMinCad: money(row.cost_min_cad),
    costMaxCad: money(row.cost_max_cad),
    statusState: row.status_state,
    confidenceLabel: confidence(row.confidence_label, row.source_authority_tier, row.last_checked_at),
    lastCheckedAtUtc: iso(row.last_checked_at),
    ageBandMatches: (row.age_band_keys ?? []).filter(isAgeBandKey),
    ageMinMonths: row.age_min_months,
    ageMaxMonths: row.age_max_months,
    ageNotes: sourceAgeNotes(row),
    geo: row.lat != null && row.lng != null ? { lat: Number(row.lat), lng: Number(row.lng) } : null,
    municipalityId: row.municipality_id,
    neighbourhood: row.neighbourhood,
    displayArea: row.display_area,
    venuePhone: row.phone,
    // Passed through VERBATIM, including the null. Coercing an absent value to false here
    // would turn "the source never said" into "the source says drop-in" at the one boundary
    // where the distinction stops being recoverable — see supabase/migrations/0027.
    registrationRequired: row.registration_required,
    sourceUrl: row.source_url,
    bookingUrl: row.booking_url,
    venueAddress: row.venue_address,
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

/**
 * The listing's own tags, plus an `indoor` tag ONLY where the category genuinely carries that
 * claim and nothing in the listing's own words contradicts it.
 *
 * `class_program` used to be in the deriving set and is now excluded on purpose: it is the
 * fallback `categoryKeyFromTitle` above returns when it cannot classify a title at all (and the
 * `certainty: 'generic'` bucket in worker/core/taxonomy.ts), so it is a statement about OUR
 * knowledge, not about the activity. It was tagging 2,280 of 2,335 sampled live listings `indoor`
 * — rendered to parents as "Indoor" and "Rainy-day friendly" — including "Sportball Outdoor Soccer
 * (5-7yrs) Rain/Shine". See ./indoor.ts for the measurement and the full reasoning.
 *
 * Source tags pass through untouched, nulls and contradictions included, exactly as
 * `registrationRequired` does below: this function's job is to stop INVENTING a claim, not to
 * start editing what the source said. A source that says both indoor and outdoor is resolved
 * where it is rendered (`readIndoorOutdoor`), not by deleting half of it here.
 */
function suitabilityTags(categoryKey: string, tagKeys: string[], row: ListingRow): string[] {
  const out = new Set(tagKeys);
  const claimsIndoor =
    INDOOR_CATEGORY_KEYS.has(categoryKey) &&
    !out.has('outdoor') &&
    indoorTextVerdict(row.activity_name, row.description_snippet) !== 'outdoor';
  if (claimsIndoor) out.add('indoor');
  return [...out];
}

function confidence(label: string | null, authority: string | null, checked: Date | string | null): ConfidenceLabel {
  const daysOld = checked ? (Date.now() - new Date(checked).getTime()) / 86_400_000 : Number.POSITIVE_INFINITY;
  if (authority === 'official' && daysOld <= 7) return 'official_recent';
  if (authority === 'official') return 'official';
  // OUR OWN RESEARCH IS NEVER "THE OFFICIAL SOURCE". A 'manual'-tier source is operator-authored
  // (the same provenance sourceAgeNotes() keys on), and the operator's own 'high' confidence in a
  // row is not the organiser confirming it — yet the line below turned it into 'official', which
  // the detail page renders as "Verified — confirmed directly by the official source" (122 curated
  // rows, QA 2026-09-24). Capped at 'editorial': "not directly confirmed by the venue or organiser".
  if (authority === 'manual') return label === 'high' || label === 'medium' ? 'editorial' : 'inferred';
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

/**
 * `occurrence_age.age_notes` ONLY when it is the source's own words.
 *
 * `ListingRecord.ageNotes` is a quotation — ActivityDetail prints it as "From the source: …" and
 * /api/search returns it — so a row whose SOURCE IS US has no source text to quote. The operator
 * import (authority_tier 'manual', the only such tier in production) wrote its internal reviewer
 * rationale into this column ("babies score low", "completely irrelevant to anyone in double
 * digits"), which then reached parents attributed to the partner organisation (QA, 2026-09-24).
 * Keyed on provenance, not on the text, so any future operator-authored batch is covered too.
 * Measured before the change: dropping these notes flips the adult/senior audience filter on 0 of
 * the 446 curated rows, so nothing about which listings are shown moves.
 */
function sourceAgeNotes(row: ListingRow): string | null {
  if (row.source_authority_tier === 'manual') return null;
  return cleanText(row.age_notes);
}

function venueFromSeriesTitle(title: string): string | null {
  const parts = title.split(' — ');
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

function isAgeBandKey(value: string): value is ListingRecord['ageBandMatches'][number] {
  return ['under2', '2-4', '5-9', '10-14', '15+'].includes(value);
}

// ── Catalogue caching for the serverless read path ────────────────────────────────────────────
//
// TWO LAYERS SINCE 2026-09-23 (egress Thread 3, Options B + C). `getCachedPostgresListings` serves
// from the SHARED, version-gated catalogue cache (./shared-catalogue-cache.ts — read its header for
// the design, the staleness it trades and why), and falls back to the per-instance TTL cache
// described below whenever the shared path is switched off (`KIDS_FUN_CATALOGUE_SHARED_CACHE=off`)
// or misbehaves. Everything below describes that TTL layer, which is unchanged: it is the fallback,
// the kill-switch path, and exactly the behaviour before the shared cache.
//
// WHY THIS EXISTS (it is the completion of the catalogue-cap fix, not a separate optimisation)
// Removing the 500-row pre-search cap was correct — a parent searching `soccer` got nothing while
// 81 eligible soccer rows sat below the cut — but it made the LOAD the dominant per-request cost,
// because `/api/search` reloads the whole read model on every invocation. Measured back to back
// against live staging at 4,967 eligible rows:
//
//     capped 500 rows   264ms load +  28ms match = 292ms per request
//     uncapped, no cache 428ms load + 132ms match = 560ms per request   ← 1.9x slower
//     uncapped + cache + matcher memoisation                ≈ 149ms per request
//
// So the uncapped read model as first shipped trades a correctness defect for a latency one, and
// the latency term grows with the catalogue. This closes that without giving back any visibility.
//
// WHY A TTL CACHE IS THE RIGHT SHAPE HERE
// It is the pattern this module's two immediate neighbours already use, for the same reason, on
// the same route: postgres-alias-resolver.ts (KIDS_FUN_ALIAS_CACHE_MS) and
// postgres-region-hierarchy.ts. Same serverless warm-instance rationale, same env-var shape.
// Listings do change more often than aliases, which is why the staleness budget is stated
// explicitly below rather than inherited by analogy.
//
// WHY THIS TTL IS 10 MINUTES WHEN ITS NEIGHBOURS ARE 60s (2026-09-23, egress Thread 3, Option A)
// The TTL was 60s, like the alias and region caches. But this load is the whole visible catalogue
// with no LIMIT (~11.5k rows, ~8.4MB on the wire), and every warm Vercel instance reloads it
// independently on each expiry — so this one cache was the architectural baseline of the Postgres
// egress bill (~3.5GB/day after the 2026-09-22 search rate limit removed the bot-driven peak). A
// 10-minute TTL cuts the reloads per warm instance up to 10x (fewer in practice: cold starts
// still load once, whatever the TTL). The alias and region loads are small and stay at 60s.
// The cost is the staleness budget below at 10 minutes instead of one. Jon approved that
// trade explicitly; `KIDS_FUN_LISTING_CACHE_MS` can still shorten (or with `0` disable) it
// per environment without a code change.
//
// WHAT ONE TTL OF STALENESS ACTUALLY COSTS — stated so it can be judged, not assumed:
//   · A newly ingested activity takes up to one TTL to become searchable. Ingest runs on a
//     scheduler measured in minutes-to-hours, so a 10-minute window is inside that cadence.
//   · `visibleOccurrenceWhereSql` evaluates `now()` in SQL, so a cached model can retain an
//     occurrence that has ended since it loaded, for up to one TTL. (Corrected 2026-09-23: this
//     used to say the engine's date/time filters remove such rows per request. They do not — see
//     "WHY THE ENGINE CANNOT BE LEFT TO DROP ENDED EVENTS" in ./shared-catalogue-cache.ts. The
//     shared path prunes them itself; this fallback path keeps the old, TTL-bounded edge.)
//   · An operator hiding or cancelling a listing takes up to one TTL to reach search — and every
//     other surface that reads this cache through lib/search/server-engine.ts (the homepage's
//     three picks, the SMS instant-picks route, the signup and account pages, and the sparse-area
//     notice's measurement in lib/sms/sparse-measure.ts — /sms/start and /api/sms/waitlist).
// DELIBERATELY NOT CACHED: `loadPostgresListingById`. A shared or deep link must always render
// current truth, and a detail lookup has no scan cost to amortise — so the staleness budget stays
// confined to the list surface that actually benefits from it.
// See ./ttl-cache for the env-var parsing and the stampede protection this shares with the alias
// resolver and the region hierarchy. Stampede protection matters most HERE: this is the expensive
// 8-join catalogue scan, and all three caches go cold together on every deploy and scale-out.
/** Default TTL of the catalogue read-model cache, when `KIDS_FUN_LISTING_CACHE_MS` is unset. */
export const LISTING_CACHE_DEFAULT_MS = 10 * 60_000;

const readModelCache = new TtlPromiseCache<readonly ListingRecord[]>(
  'KIDS_FUN_LISTING_CACHE_MS',
  LISTING_CACHE_DEFAULT_MS
);

/** The fallback / kill-switch layer, exactly as `getCachedPostgresListings` was before the shared cache. */
const legacyCatalogueCache = {
  get: (pool: Pool, now: number) =>
    readModelCache.get(async () => Object.freeze(await loadPostgresListings(pool)), now),
  clear: () => readModelCache.clear(),
};

const sharedCatalogueCache = new SharedCatalogueCache({
  store: nextDataCacheStore,
  legacy: legacyCatalogueCache,
  loadListings: loadPostgresListings,
  probeVersion: probePostgresCatalogueVersion,
});

/**
 * Cached accessor for every catalogue-wide surface: the complete visible catalogue, served from the
 * shared version-gated cache (see ./shared-catalogue-cache.ts), or — with the kill switch set, or
 * whenever the shared path fails — reloaded from Postgres at most once per TTL window.
 *
 * Both paths return the same thing: the records `loadPostgresListings` produces, in its order, in
 * a frozen array. Callers cannot tell them apart, and must not need to.
 *
 * Deliberately takes NO limit. A cache keyed on nothing but time must only ever hold one
 * population, and for this route that population is "everything a parent could be shown" — the
 * whole point of the cap fix. Callers that want a bounded diagnostic page call
 * `loadPostgresListings` directly and are not served from, or written into, this cache.
 *
 * SHARED-ARRAY INVARIANT — read before you write code against the return value.
 * The SAME array, holding the SAME `ListingRecord` objects, is handed to every concurrent request
 * for as long as it is cached. It is therefore READ-ONLY: mutating it, or any record in it, corrupts other
 * in-flight requests and every request for the rest of the window. Two levels of enforcement:
 *   · The array itself is frozen, so `push`/`splice`/an in-place `sort` throws immediately (ESM is
 *     strict mode). In-place sorting a "list of listings" is the realistic mistake here, and it is
 *     silent without this. `readonly ListingRecord[]` states the same thing at compile time.
 *   · The RECORDS are deliberately NOT deep-frozen: that is ~5k objects with nested arrays on
 *     every reload, a real cost paid on every request path, to defend against a mutation that
 *     exists nowhere in the repo today. Treat records as immutable; copy before you edit.
 *
 * INCIDENT LEVERS. `KIDS_FUN_CATALOGUE_SHARED_CACHE=off` returns to the per-instance TTL layer.
 * `KIDS_FUN_LISTING_CACHE_MS` tunes ONLY that layer — so disabling caching entirely (every call
 * reloads) now takes both: the kill switch off AND `KIDS_FUN_LISTING_CACHE_MS=0`.
 */
export async function getCachedPostgresListings(
  pool: Pool,
  now: number = Date.now()
): Promise<readonly ListingRecord[]> {
  return sharedCatalogueCache.get(pool, now);
}

/**
 * MANUAL BUST, for the rare correction that cannot wait for the probe cycle (a listing that must
 * come down or change NOW). Invalidates the shared catalogue entries for every instance and drops
 * this instance's copies; every instance serves the corrected catalogue within about two re-check
 * intervals (~2 minutes at the defaults). Must run inside a Next.js route handler or server action.
 * Exposed as POST /api/admin/catalogue-cache/bust.
 */
export async function bustSharedCatalogueCache(): Promise<void> {
  await sharedCatalogueCache.bust();
  readModelCache.clear();
}

/**
 * Test/ops hook: drop this instance's cached read model (both layers) so the next access goes back
 * to the shared store or the DB. Does not touch the shared store itself.
 */
export function clearPostgresListingsCache(): void {
  sharedCatalogueCache.clear();
  readModelCache.clear();
}
