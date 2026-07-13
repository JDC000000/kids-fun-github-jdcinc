// lib/search/filters/age.ts — Age-band intersection predicate (BR-01..04, TSD §6.2).
//
// The user's selected bands are matched against the listing's derived
// `ageBandMatches[]` (non-empty intersection). Orthogonal to geo/time — combined
// in the query, never a dropdown-first gate (§5B age × geography independence).

import type { AgeBandKey, ListingRecord } from '../types';

/** True when any user-selected band intersects the listing's matching bands. */
export function matchesAge(listing: ListingRecord, userBands: AgeBandKey[]): boolean {
  if (userBands.length === 0) return true; // no age filter
  if (listing.ageBandMatches.length === 0) return true; // all-ages / unknown → don't hide
  return userBands.some((b) => listing.ageBandMatches.includes(b));
}
