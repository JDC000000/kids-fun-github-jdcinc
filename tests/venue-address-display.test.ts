// tests/venue-address-display.test.ts — display-only address tidying (copy audit, 2026-09-03).
import { describe, expect, it } from 'vitest';
import { formatVenueAddress, addressRepeatsVenueName } from '../app/preview/_data/format';
import { mapListingRecordToActivity, mapsUrlForAddress } from '../app/preview/_data/search-api';
import { makeListing } from '../lib/search/__fixtures__/factory';

describe('formatVenueAddress — the three problems seen live', () => {
  it('inserts the missing space in a 6-character postal code', () => {
    expect(formatVenueAddress('931 Lytton Street, North Vancouver, V7H2M5')).toBe(
      '931 Lytton Street, North Vancouver, V7H 2M5'
    );
  });

  it('abbreviates a spelled-out province, including the dotted form', () => {
    expect(formatVenueAddress('600 Hamilton St, Vancouver, British Columbia')).toBe(
      '600 Hamilton St, Vancouver, BC'
    );
    expect(formatVenueAddress('1 Main St, Vancouver, B.C.')).toBe('1 Main St, Vancouver, BC');
  });

  it('settles comma spacing without inventing or dropping fields', () => {
    expect(formatVenueAddress('1 Main St ,Vancouver ,  BC')).toBe('1 Main St, Vancouver, BC');
  });

  it('🔴 does NOT mangle a street whose name contains the province', () => {
    // "British Columbia Way" is a real street-name shape. A naive global replace renames it.
    expect(formatVenueAddress('20 British Columbia Way, Vancouver, BC')).toContain('BC Way');
  });

  it('returns null for absent or empty input rather than an empty line', () => {
    for (const v of [null, undefined, '', '   ']) expect(formatVenueAddress(v)).toBeNull();
  });
});

describe('addressRepeatsVenueName — the 2-of-113 case', () => {
  it('🔴 suppresses an address whose street token IS the venue name', () => {
    expect(addressRepeatsVenueName('Granville St, Vancouver, BC', 'Granville Street')).toBe(true);
  });

  it('🔴 does NOT suppress an ordinary address', () => {
    // The failure that would matter: hiding a real address because of a loose match.
    expect(addressRepeatsVenueName('931 Lytton Street, North Vancouver', 'Harry Jerome Centre')).toBe(false);
    expect(addressRepeatsVenueName('600 Hamilton St, Vancouver', 'Hamilton Community Centre')).toBe(false);
  });

  it('handles missing inputs', () => {
    expect(addressRepeatsVenueName(null, 'X')).toBe(false);
    expect(addressRepeatsVenueName('1 Main St', null)).toBe(false);
  });
});

describe('🔴 the Maps link still builds from the RAW address, not the tidied one', () => {
  // The explicit requirement. Formatting runs at the render site; the mapper is untouched, so the
  // query handed to Google is byte-identical to what it was before this change.
  it('derives the maps query from the unformatted source string', () => {
    const raw = '931 Lytton Street, North Vancouver, V7H2M5';
    const a = mapListingRecordToActivity(
      makeListing({ venueAddress: raw, venueName: 'Harry Jerome Centre', locationUrl: null })
    );
    expect(a.address).toBe(raw); // Activity carries the RAW value
    expect(decodeURIComponent(a.locationUrl!)).toContain(raw);
    expect(a.locationUrl).toBe(mapsUrlForAddress(raw, 'Harry Jerome Centre'));
  });

  it('🔴 the tidied form and the raw form differ, so this test could actually fail', () => {
    // Without this the assertion above passes vacuously if formatVenueAddress were a no-op.
    const raw = '931 Lytton Street, North Vancouver, V7H2M5';
    expect(formatVenueAddress(raw)).not.toBe(raw);
  });
});
