// lib/search/__fixtures__/factory.ts — Listing builder with sane defaults for fixtures/tests.

import type { ListingRecord } from '../types';

let seq = 0;

/** Build a full ListingRecord from a partial, filling schema-valid defaults. */
export function makeListing(partial: Partial<ListingRecord> & { id?: string }): ListingRecord {
  const id = partial.id ?? `fx-${String(++seq).padStart(3, '0')}`;
  return {
    id,
    seriesId: partial.seriesId ?? `${id}-series`,
    activityName: partial.activityName ?? 'Activity',
    primaryCategoryKey: partial.primaryCategoryKey ?? 'general',
    categoryTags: partial.categoryTags ?? [],
    venueAddress: partial.venueAddress ?? null,
    venueName: partial.venueName ?? 'Community Centre',
    organisation: partial.organisation ?? null,
    descriptionSnippet: partial.descriptionSnippet ?? '',
    suitabilityTags: partial.suitabilityTags ?? [],
    startDatetimeUtc: partial.startDatetimeUtc ?? null,
    endDatetimeUtc: partial.endDatetimeUtc ?? null,
    openHours: partial.openHours ?? false,
    openHoursLocal: partial.openHoursLocal ?? null,
    openHoursLabel: partial.openHoursLabel ?? null,
    costStatus: partial.costStatus ?? 'known',
    costMinCad: partial.costMinCad ?? null,
    costMaxCad: partial.costMaxCad ?? null,
    statusState: partial.statusState ?? 'confirmed',
    confidenceLabel: partial.confidenceLabel ?? 'official',
    lastCheckedAtUtc: partial.lastCheckedAtUtc ?? null,
    ageBandMatches: partial.ageBandMatches ?? [],
    ageMinMonths: partial.ageMinMonths ?? null,
    ageMaxMonths: partial.ageMaxMonths ?? null,
    // Carried through, because the audience filter now reads it: a fixture that set `ageNotes`
    // and had it silently dropped here would test a listing the product never sees.
    ageNotes: partial.ageNotes ?? null,
    geo: partial.geo ?? null,
    municipalityId: partial.municipalityId ?? null,
    neighbourhood: partial.neighbourhood ?? null,
    displayArea: partial.displayArea ?? null,
    venuePhone: partial.venuePhone ?? null,
    registrationRequired: partial.registrationRequired ?? null,
    sourceUrl: partial.sourceUrl ?? null,
    bookingUrl: partial.bookingUrl ?? null,
    locationUrl: partial.locationUrl ?? null,
  };
}

/** Reset the id sequence (call in test setup for deterministic ids if constructing ad hoc). */
export function resetSeq(): void {
  seq = 0;
}
