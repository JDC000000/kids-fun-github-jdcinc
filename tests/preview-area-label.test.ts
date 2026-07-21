import { describe, it, expect } from 'vitest';
import { mapSearchItemToActivity, type ListingRecordDto } from '../app/preview/_data/search-api';

// BUG-009 (bug bash G-T39-3, Round 27) → BUG-008 in evals/bugs.json:
// labelArea() used to fall back to the raw municipalityId (an opaque UUID) before the
// generic 'Metro Vancouver' default, so ~30% of cards rendered a database id where a
// neighbourhood name belongs. The fix drops municipalityId from the fallback chain.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function listing(overrides: Partial<ListingRecordDto> = {}): ListingRecordDto {
  return {
    id: 'occ-area',
    activityName: 'Remembrance Day',
    primaryCategoryKey: 'festival',
    venueName: 'City Hall',
    organisation: 'City of Vancouver',
    descriptionSnippet: '',
    startDatetimeUtc: '2026-11-11T18:00:00.000Z',
    endDatetimeUtc: '2026-11-11T19:00:00.000Z',
    costStatus: 'free',
    costMinCad: null,
    costMaxCad: null,
    statusState: 'confirmed',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-07-20T16:00:00.000Z',
    ageMinMonths: null,
    ageMaxMonths: null,
    geo: null,
    displayArea: null,
    neighbourhood: null,
    municipalityId: '10000000-0000-0000-0000-000000000010',
    sourceUrl: 'https://vancouver.ca/events/remembrance',
    bookingUrl: null,
    locationUrl: null,
    ...overrides,
  };
}

const activity = (o: Partial<ListingRecordDto> = {}) =>
  mapSearchItemToActivity({ distanceKm: null, listing: listing(o) });

describe('BUG-008: area label never renders a raw municipality UUID', () => {
  it('falls back to "Metro Vancouver" when neighbourhood and displayArea are both null', () => {
    const a = activity({ neighbourhood: null, displayArea: null });
    expect(a.area).toBe('Metro Vancouver');
  });

  it('never renders the raw municipalityId UUID for any listing', () => {
    // The exact staging repro id, plus a differently-shaped uuid, must both be hidden.
    for (const municipalityId of [
      '10000000-0000-0000-0000-000000000010',
      'abcdef01-2345-6789-abcd-ef0123456789',
    ]) {
      const a = activity({ neighbourhood: null, displayArea: null, municipalityId });
      expect(a.area).not.toMatch(UUID_RE);
      expect(a.area).toBe('Metro Vancouver');
    }
  });

  it('still prefers a real neighbourhood, then displayArea, when present', () => {
    expect(activity({ neighbourhood: 'Kitsilano' }).area).toBe('Kitsilano');
    expect(activity({ neighbourhood: null, displayArea: 'Downtown' }).area).toBe('Downtown');
  });
});
