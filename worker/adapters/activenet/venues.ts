// worker/adapters/activenet/venues.ts — G-T7R-4: centre → venue resolution.
//
// The drop-in feed names a centre but carries no address. `/onlinecalendar/centerdetails`
// returns street address, city, province, postal code and phone for exactly the centres
// that appear in the feed, so venue resolution is ONE batched request per run — not a
// per-record lookup and NOT a geocoder call.
//
// NO GEOCODER AT INGEST. This matches the `city_calendar` precedent (curated geo only,
// so a venue can never be mis-located by a fuzzy geocode). Lat/lng for these centres is
// a later venue-enrichment pass (the Vancouver open-data join), deliberately out of
// scope here.
//
// Unmapped centres are a WARNING, never a silent null: a centre that appears in the
// feed but not in centerdetails means the batch missed something, and that must be
// visible in the run output.
import type { StructuredRecord } from '../../core/adapter';
import type { ActiveNetCentreDetail } from './client';
import { stripCentreSentinel } from './parse';
import type { ActiveNetTenantConfig } from './config';

export interface ResolvedVenue {
  centreId: number;
  venueName: string;
  venueAddress?: string;
  venuePhone?: string;
  venueMunicipalityName: string;
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
 * Attach venue name/address/municipality to each record. Records keep the venue name
 * parse.ts already derived when centerdetails has nothing better; only the address and
 * the canonical name come from the index.
 */
export function applyVenues(
  records: StructuredRecord[],
  index: Map<number, ResolvedVenue>
): VenueApplyResult {
  const unmapped = new Set<number>();
  const warnings: string[] = [];
  let recordsWithoutAddress = 0;

  const out = records.map((record) => {
    const centreId = centreIdOf(record);
    const venue = centreId != null ? index.get(centreId) : undefined;
    if (!venue) {
      if (centreId != null) unmapped.add(centreId);
      recordsWithoutAddress += 1;
      return record;
    }
    if (!venue.venueAddress) recordsWithoutAddress += 1;
    return {
      ...record,
      venueName: venue.venueName,
      venueAddress: venue.venueAddress,
      venueMunicipalityName: venue.venueMunicipalityName,
    } satisfies StructuredRecord;
  });

  const unmappedCentreIds = [...unmapped].sort((a, b) => a - b);
  if (unmappedCentreIds.length > 0) {
    warnings.push(
      `centerdetails did not resolve ${unmappedCentreIds.length} centre(s) present in the feed: ${unmappedCentreIds.join(', ')}`
    );
  }
  return { records: out, unmappedCentreIds, recordsWithoutAddress, warnings };
}
