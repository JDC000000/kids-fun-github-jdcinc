// lib/search/repository.ts — Listing data-access seam.
//
// The search core reads listings through this interface only. Fixture impl now;
// a Postgres impl (activity_occurrence ⋈ venue ⋈ series ⋈ category) later — same
// shape, so the engine is unchanged when live data arrives (M1/M2).

import type { ListingRecord } from './types';

export interface ListingRepository {
  /** All candidate listings. A DB impl pre-filters with SQL; the fixture returns the array. */
  all(): ListingRecord[];
}

export class InMemoryListingRepository implements ListingRepository {
  constructor(private readonly listings: ListingRecord[]) {}
  all(): ListingRecord[] {
    return this.listings;
  }
}
