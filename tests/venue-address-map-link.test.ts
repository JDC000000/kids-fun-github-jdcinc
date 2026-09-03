// tests/venue-address-map-link.test.ts — surfacing venue.address, and the map-link fallback.
//
// MEASURED IN PRODUCTION before this was built: of 11,294 live occurrences, 11,293 have a venue
// address and only 45 carry the source's own location_url. So 11,248 — 99.6% of everything a
// parent can land on — had an address in the database and no way to open a map. That ratio is
// why the fallback exists; if it had come back near zero the right answer was not to build it.
import { describe, expect, it } from 'vitest';
import { mapsUrlForAddress, mapListingRecordToActivity } from '../app/preview/_data/search-api';
import { makeListing } from '../lib/search/__fixtures__/factory';

describe('mapsUrlForAddress', () => {
  it('builds a maps SEARCH, not a pinned coordinate', () => {
    // We have an address string, not coordinates. A search that lands imprecisely is visibly a
    // search; a wrong pin looks authoritative.
    const url = mapsUrlForAddress('600 Hamilton St, Vancouver, BC V6B 2P1');
    expect(url).toContain('google.com/maps/search/');
    expect(url).toContain('api=1');
  });

  it('🔴 encodes the address rather than concatenating it', () => {
    // Real addresses in this catalogue carry commas and the occasional # and &. Manual escaping
    // is how one of them silently truncates the query.
    const url = mapsUrlForAddress('130 East 23rd Street, North Vancouver, V7L 3E2', 'Venue & Hall #2');
    expect(url).not.toMatch(/[,#]/);
    expect(decodeURIComponent(url.split('query=')[1])).toBe(
      'Venue & Hall #2, 130 East 23rd Street, North Vancouver, V7L 3E2'
    );
  });

  it('includes the venue name to disambiguate civic addresses', () => {
    expect(decodeURIComponent(mapsUrlForAddress('1 Main St', 'Trout Lake CC').split('query=')[1]))
      .toBe('Trout Lake CC, 1 Main St');
  });
});

describe('🔴 map-link precedence: the source wins, the derived link is only a fallback', () => {
  it("uses the source's own location_url when it has one", () => {
    // It points at the venue's real page or a pinned location — better than a text search we
    // constructed. Overriding it with our guess would be a downgrade on the 0.4% that have one.
    const a = mapListingRecordToActivity(
      makeListing({ locationUrl: 'https://example.org/venue', venueAddress: '1 Main St' })
    );
    expect(a.locationUrl).toBe('https://example.org/venue');
  });

  it('🔴 derives one from the address when the source has none — the 99.6% case', () => {
    const a = mapListingRecordToActivity(makeListing({ locationUrl: null, venueAddress: '1 Main St' }));
    expect(a.locationUrl).toContain('google.com/maps/search/');
    expect(decodeURIComponent(a.locationUrl!)).toContain('1 Main St');
  });

  it('offers NO map link when there is neither — never a search for nothing', () => {
    const a = mapListingRecordToActivity(makeListing({ locationUrl: null, venueAddress: null }));
    expect(a.locationUrl).toBeUndefined();
  });

  it('surfaces the address itself, which was previously never read out of the database', () => {
    const a = mapListingRecordToActivity(makeListing({ venueAddress: '600 Hamilton St' }));
    expect(a.address).toBe('600 Hamilton St');
  });
});
