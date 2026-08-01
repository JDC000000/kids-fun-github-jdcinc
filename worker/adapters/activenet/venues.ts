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
// PHONE. The same centerdetails response carries each facility's public phone number,
// and until 2026-08-01 this file read it into ResolvedVenue and nothing carried it any
// further — StructuredRecord had no field and `venue` had no column, so it was fetched
// and dropped every run. It now lands in `venue.phone` (migration 0024) through
// StructuredRecord.venuePhone and resolveVenue()'s existing COALESCE enrichment. Stored
// verbatim, guarded by normaliseVenuePhone() below, and read by NOTHING parent-facing
// yet — that is a deliberate sequencing call, recorded in ActivityDetail.tsx.
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

/**
 * Dial-string shape: an optional `+`, then only digits and the punctuation a phone
 * number is actually written with, then an optional extension. The 7–24 bound is what
 * separates a number from a sentence of digits; the 24 ceiling is load-bearing, since
 * an unbounded run of digits is not a phone number.
 */
const PHONE_SHAPE = /^\+?[\d\s().-]{7,24}(\s*(?:ext|x|extension)\.?\s*\d{1,6})?$/i;
/**
 * Minimum DIGITS (not characters). Seven is the shortest real NANP subscriber number
 * (local, no area code); every value this source has ever returned carries ten or
 * eleven. Checked separately from PHONE_SHAPE — see below for why both are needed.
 */
const MIN_PHONE_DIGITS = 7;

/**
 * The source's own phone string, trimmed — or nothing.
 *
 * WHY A GUARD AT ALL, when 43/43 measured values are clean. `phone` is a free-text
 * field on an undocumented, unversioned vendor payload. The failure that matters is not
 * a malformed number, it is PROSE: the day someone types "call the centre" or an
 * opening-hours line into that field, an unguarded wire writes it into a column named
 * `phone`, and every downstream reader is entitled to treat it as callable. Dropping a
 * value we cannot stand behind is cheaper and more honest than storing a lie, and it
 * costs the record nothing else — address, geo and occurrences all still land.
 *
 * TWO CHECKS, NOT ONE, and this is deliberate (QA F2, 2026-08-01). The original guard
 * was a digit COUNT alone, which correctly dropped digit-free prose but happily kept
 * digit-BEARING prose — QA demonstrated `Mon-Fri 9:00-17:00, Sat 10:00-14:00`,
 * `Ages 0-5, 6-12, 13-18, 19-64, 65+` and 37 unbroken digits all landing in a column
 * named `phone`. PHONE_SHAPE closes exactly that class. But the reverse is also true and
 * was measured before adopting it: PHONE_SHAPE's `{7,24}` counts CHARACTERS from a class
 * containing non-digits, so `(((((((`, `..........` and `()()()()()()` all satisfy it on
 * their own. Neither check subsumes the other, so both run. Verified over 43 real values
 * (36 distinct) plus the `ext.`/`x`/bare-local forms — 100% kept — against 16 prose and
 * degenerate cases — 100% dropped.
 *
 * WHY NOT A DB CHECK CONSTRAINT instead: a phone number has no canonical shape worth
 * asserting in SQL, and this function already means the column never sees garbage. See
 * 0024_venue_phone.sql, which also records the measured cost of the CHECK alternative
 * (every record at ONE venue, not the run — an earlier claim that it would fail a whole
 * municipality's run was wrong and is corrected there).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: reformat. `(604) 718-8222` and
 * `+1 (604) 257-8195` are both stored exactly as published. Picking a canonical
 * rendering is a display decision and nothing parent-facing reads this yet.
 */
export function normaliseVenuePhone(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  if (!PHONE_SHAPE.test(value)) return undefined;
  if (value.replace(/\D/g, '').length < MIN_PHONE_DIGITS) return undefined;
  return value;
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
      venuePhone: normaliseVenuePhone(detail.phone),
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
 * Attach venue name/address/phone/municipality/geo to each record. Records keep the venue
 * name parse.ts already derived when centerdetails has nothing better; only the address,
 * the phone, the canonical name and the coordinates come from the index.
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
      venuePhone: venue.venuePhone,
      venueMunicipalityName: venue.venueMunicipalityName,
      // Attaching geo here is the whole of the write path — no core or DB change needed.
      //
      // WORDING MATTERS HERE, and an earlier version of this comment got it wrong.
      // resolveVenue() does NOT gap-fill: it runs `geo = COALESCE(<incoming>, geo)`, so a
      // non-null incoming coordinate OVERWRITES whatever the venue row already held, and
      // the existing value survives only when we send nothing. That is LAST-WRITER-WINS.
      // It is invisible while one adapter owns a venue name, and load-bearing the moment
      // two do — `worker/adapters/citycalendar/config.ts` carries its own venueGeo map
      // with 5 names byte-identical to venue-geo.ts's, so those rows change with ingest
      // order. Converging both tables is a tracked follow-up; the one venue where the
      // divergence measurably hurt (Britannia) is already converged in venue-geo.ts.
      //
      // PHONE RIDES THE SAME WIRE, and is NOT a special case. resolveVenue() enriches it
      // with the identical `phone = COALESCE(<incoming>, phone)` it already uses for
      // address/display_area/official_url/geo, so the last-writer-wins reading above
      // applies verbatim. It is invisible today only because ActiveNet is the sole
      // family that populates phone — the five venue rows citycalendar also writes
      // (Britannia, Killarney, Kitsilano, Renfrew Park, Trout Lake community centres)
      // churn on `geo` because both families send coordinates, and cannot churn on
      // `phone` because citycalendar sends none. That is a property of the CURRENT
      // coverage, not of the field: a second populating family turns it into the same
      // churn geo already has, with the same converge-the-tables fix.
      //
      // NO OTHER FAMILY POPULATES IT, and each decline is a decision, not an oversight
      // (surveyed 2026-08-01 against live payloads, not just against the code):
      //   • citycalendar (Trumba) — HAS an "Organizer phone" custom field, populated on
      //     2 of 39 live events. Declined on MEANING, not coverage: it is the phone of
      //     whoever runs the EVENT, frequently a community volunteer, and writing it to
      //     the shared `venue` row would republish one organiser's number as the
      //     facility's own on every other event at that venue. That is the same class of
      //     false claim G-VENUE-3's QA F1 closed (attribution inferred from a venue
      //     NAME), plus a real personal-data exposure the venue column cannot justify.
      //   • library / generic-rss (NVDPL) — phone numbers exist ONLY inside free-text
      //     HTML descriptions ("Register by phone (604-987-4471 ext. 8175)"), never as a
      //     structured field. Harvesting them means regexing prose for a number whose
      //     referent is unknown; this adapter family does not do fuzzy inference.
      //   • perfectmind, eventbrite — no phone anywhere in the payload (checked the full
      //     key set of the captured fixtures; PerfectMind exposes `Email`, not a phone).
      //   • venue (aquarium/space centre), seasonal — hand-curated config with no
      //     upstream feed. A phone here would be a NEW hand-authored fact, which this
      //     project requires per-entry attribution for (venue-geo.ts's shape). Cheap and
      //     worth doing; deliberately not smuggled into this task's diff.
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
