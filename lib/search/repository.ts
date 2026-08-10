// lib/search/repository.ts — Listing data-access seam.
//
// The search core reads listings through this interface only. Fixture impl now;
// a Postgres impl (activity_occurrence ⋈ venue ⋈ series ⋈ category) later — same
// shape, so the engine is unchanged when live data arrives (M1/M2).

import type { ListingRecord } from './types';

export interface ListingRepository {
  /**
   * All candidate listings. A DB impl pre-filters with SQL; the fixture returns the array.
   *
   * `readonly` because the DB impl's array is the shared, cached read model handed to every
   * concurrent request (see `getCachedPostgresListings`) — the search core reads it, never edits
   * it. Widening only: a caller may still pass a mutable array in.
   */
  all(): readonly ListingRecord[];
}

export class InMemoryListingRepository implements ListingRepository {
  constructor(private readonly listings: readonly ListingRecord[]) {}
  all(): readonly ListingRecord[] {
    return this.listings;
  }
}
