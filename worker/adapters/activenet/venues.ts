// worker/adapters/activenet/venues.ts — G-T7R-4: centre → venue resolution.
//
// The drop-in feed names a centre but carries no address. `/onlinecalendar/centerdetails`
// returns street address, city, province, postal code and phone for exactly the centres
// that appear in the feed, so venue resolution is ONE batched request per run — not a
// per-record lookup and NOT a geocoder call.
//
// NO GEOCODER AT INGEST. This matches the `city_calendar` precedent (curated geo only,
// so a venue can never be mis-located by a fuzzy geocode). Lat/lng comes from
// ./venue-geo.ts — a committed, per-entry-attributed constant derived ONCE by hand from
// Vancouver's OGL-licensed open data plus curated pool/rink coordinates. Zero network
// calls; exact (normalised) name match only, never a fuzzy join.
//
// Unmapped centres are a WARNING, never a silent null: a centre that appears in the
// feed but not in centerdetails means the batch missed something, and that must be
// visible in the run output. The same rule now applies to geo — a facility with no
// entry in venue-geo.ts is NAMED in the run warnings, so the ~74% of Vancouver drop-in
// volume that happens at pools and rinks can never be mistaken for "geo solved".
import type { StructuredRecord } from '../../core/adapter';
import type { ActiveNetCentreDetail } from './client';
import { stripCentreSentinel } from './parse';
import type { ActiveNetTenantConfig } from './config';
import { lookupVenueGeo, hasVenueGeoTable, type ActiveNetVenueGeo } from './venue-geo';

export interface ResolvedVenue {
  centreId: number;
  venueName: string;
  venueAddress?: string;
  venuePhone?: string;
  venueMunicipalityName: string;
  /** Curated coordinates for this facility, when venue-geo.ts has an entry. */
  geo?: ActiveNetVenueGeo;
  /**
   * Whether this venue's TENANT has a curated geo table at all. Carried per-venue
   * (rather than passed to applyVenues) purely so the missing-geo warning can tell
   * "this tenant was never derived" apart from "this facility slipped through a
   * tenant that was" — two different problems that want two different responses,
   * and applyVenues has no other way to know which it is looking at.
   */
  geoTableAvailable: boolean;
}

/** Join the address fields into one line, skipping blanks (address2 is usually empty). */
function formatAddress(detail: ActiveNetCentreDetail): string | undefined {
  const street = [detail.address1, detail.address2].map((s) => (s ?? '').trim()).filter(Boolean).join(', ');
  const locality = [detail.city, detail.state].map((s) => (s ?? '').trim()).filter(Boolean).join(', ');
  const postal = (detail.zip_code ?? '').trim().toUpperCase();
  const line = [street, locality, postal].filter(Boolean).join(', ');
  return line || undefined;
}

/** Build the per-run venue index from one batched centerdetails response. */
export function buildVenueIndex(
  tenant: ActiveNetTenantConfig,
  details: ActiveNetCentreDetail[]
): Map<number, ResolvedVenue> {
  const index = new Map<number, ResolvedVenue>();
  const geoTableAvailable = hasVenueGeoTable(tenant.tenantKey);
  for (const detail of details) {
    if (!Number.isFinite(detail.id)) continue;
    const name = stripCentreSentinel(detail.name);
    if (!name) continue;
    index.set(detail.id, {
      centreId: detail.id,
      venueName: name,
      venueAddress: formatAddress(detail),
      venuePhone: (detail.phone ?? '').trim() || undefined,
      venueMunicipalityName: tenant.municipality,
      // Committed constant, exact normalised name match. No network, no geocoder,
      // no fuzzy fallback — a miss is reported by applyVenues, never guessed at.
      geo: lookupVenueGeo(tenant.tenantKey, name),
      geoTableAvailable,
    });
  }
  return index;
}

export interface VenueApplyResult {
  records: StructuredRecord[];
  /** Centres seen in the feed that centerdetails did not resolve. */
  unmappedCentreIds: number[];
  /** Records that ended up with no street address. */
  recordsWithoutAddress: number;
  /**
   * Facility names present in the feed that ./venue-geo.ts has no entry for, sorted.
   * Reported as NAMES (not a count) deliberately: "geo coverage is 67%" reads as
   * nearly-solved, whereas "Britannia Pool, Hillcrest Rink, … have no coordinates"
   * says which parents get no distance on which listings.
   */
  venuesWithoutGeo: string[];
  /** Records that ended up with no coordinates. */
  recordsWithoutGeo: number;
  warnings: string[];
}

/** Centre id for a record, recovered from the raw event captured by parse.ts. */
function centreIdOf(record: StructuredRecord): number | undefined {
  const raw = record.raw as { facilities?: Array<{ center_id?: number }> } | undefined;
  const id = raw?.facilities?.find((f) => Number.isFinite(f.center_id))?.center_id;
  if (Number.isFinite(id)) return id;
  // Fall back to the composite sourceRecordId (…:start:centreId:facilities).
  const parts = record.sourceRecordId.split(':');
  const fromKey = Number(parts[2]);
  return Number.isFinite(fromKey) ? fromKey : undefined;
}

/**
 * Attach venue name/address/municipality/geo to each record. Records keep the venue name
 * parse.ts already derived when centerdetails has nothing better; only the address, the
 * canonical name and the coordinates come from the index.
 */
export function applyVenues(
  records: StructuredRecord[],
  index: Map<number, ResolvedVenue>
): VenueApplyResult {
  const unmapped = new Set<number>();
  const warnings: string[] = [];
  let recordsWithoutAddress = 0;
  let recordsWithoutGeo = 0;

  const out = records.map((record) => {
    const centreId = centreIdOf(record);
    const venue = centreId != null ? index.get(centreId) : undefined;
    if (!venue) {
      if (centreId != null) unmapped.add(centreId);
      recordsWithoutAddress += 1;
      recordsWithoutGeo += 1;
      return record;
    }
    if (!venue.venueAddress) recordsWithoutAddress += 1;
    if (!venue.geo) recordsWithoutGeo += 1;
    return {
      ...record,
      venueName: venue.venueName,
      venueAddress: venue.venueAddress,
      venueMunicipalityName: venue.venueMunicipalityName,
      // resolveVenue() COALESCE-enriches an existing venue row, so attaching geo here
      // is the whole of the write path — no core or DB change is needed.
      venueLat: venue.geo?.lat,
      venueLng: venue.geo?.lng,
      venueDisplayArea: venue.geo?.displayArea ?? record.venueDisplayArea,
    } satisfies StructuredRecord;
  });

  const unmappedCentreIds = [...unmapped].sort((a, b) => a - b);
  if (unmappedCentreIds.length > 0) {
    warnings.push(
      `centerdetails did not resolve ${unmappedCentreIds.length} centre(s) present in the feed: ${unmappedCentreIds.join(', ')}`
    );
  }

  // Every facility the feed resolved but venue-geo.ts does not cover, BY NAME. Derived
  // from the index rather than from the records so a newly-added facility surfaces on
  // the first run it appears in the roster, even before it carries any occurrences.
  const venues = [...index.values()];
  const venuesWithoutGeo = venues
    .filter((v) => !v.geo)
    .map((v) => v.venueName)
    .sort((a, b) => a.localeCompare(b));

  if (venuesWithoutGeo.length > 0) {
    const noTable = venues.every((v) => !v.geoTableAvailable);
    warnings.push(
      noTable
        ? `no curated venue-geo table for this tenant — ${venuesWithoutGeo.length} centre(s) present in the feed will have no coordinates: ${venuesWithoutGeo.join(', ')}`
        : `venue-geo.ts has no entry for ${venuesWithoutGeo.length} centre(s) present in the feed: ${venuesWithoutGeo.join(', ')}`
    );
  }

  return {
    records: out,
    unmappedCentreIds,
    recordsWithoutAddress,
    venuesWithoutGeo,
    recordsWithoutGeo,
    warnings,
  };
}
