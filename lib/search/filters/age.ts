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

/**
 * The POSITIVE half of `matchesAge` — a genuine band intersection, as distinct from the
 * "unknown → don't hide" pass that predicate also grants.
 *
 * WHY BOTH PREDICATES EXIST. `matchesAge` answers one question ("may this listing be shown?")
 * and is deliberately permissive: a listing whose source never stated an age is admitted under
 * every age filter, because an honestly-unknown age is not grounds for hiding a listing (Jon's
 * standing ruling; the empty-array branch above is NOT to be inverted). But "may be shown" and
 * "matches the age you asked for" are two different claims, and the result list used to make
 * only the first one while presenting it as the second — an unresolved-age listing sat silently
 * among genuine 2–4 matches with nothing to tell a parent which was which.
 *
 * So the second question gets its own predicate rather than a second reading of the first.
 * `hasConfirmedAgeMatch` is what SearchEngine partitions the primary result list on: true → the
 * confirmed section, false (under an active filter) → the separate "age not confirmed" section
 * (lib/search/engine.ts, `ageUnconfirmed`). Nothing is excluded either way — this decides which
 * heading a listing appears under, never whether it appears.
 *
 * Returns false when no age filter is active: with nothing selected there is no claim to confirm,
 * which is why the engine only consults this once `userBands` is non-empty.
 */
export function hasConfirmedAgeMatch(listing: ListingRecord, userBands: AgeBandKey[]): boolean {
  if (userBands.length === 0) return false; // nothing asked for → nothing to confirm
  return userBands.some((b) => listing.ageBandMatches.includes(b));
}

/** The bands in order, youngest first. Adjacency is only meaningful against this ordering. */
export const AGE_BAND_ORDER: AgeBandKey[] = ['under2', '2-4', '5-9', '10-14', '15+'];

/**
 * Widen a band selection to include each selected band's immediate NEIGHBOURS — the bounded
 * relaxation behind the broadening ladder's `adjacent_age` rung (lib/search/broaden.ts).
 *
 * WHY AGE GETS ITS OWN BOUNDED RUNG RATHER THAN BEING DROPPED WITH THE CHIPS. Age was one of
 * five entries in the ladder's "drop the most restrictive chip" rung, which relaxes by setting
 * the constraint to its empty value — for age, `ageBands: []`. The other four are opt-in
 * BOOLEANS (Bookable now, Drop-in, Rainy-day, Free): off is their only relaxation, so dropping
 * one is the only move available. Age is not a boolean. It is an ORDERED SCALE, so it has a
 * middle ground, and emptying it is the single worst thing to do with it — a parent filtering
 * for an under-2 gets teen programming back, which is not a widened answer to their question
 * but a different question. Neighbours only: `under2` can reach `2-4`, never `10-14`.
 *
 * Returns the selection unchanged when it is empty (nothing to widen) or already spans
 * everything, so the caller can tell "no widen available" from "widened".
 */
export function adjacentAgeBands(userBands: AgeBandKey[]): AgeBandKey[] {
  if (userBands.length === 0) return [];
  const widened = new Set<AgeBandKey>(userBands);
  for (const band of userBands) {
    const i = AGE_BAND_ORDER.indexOf(band);
    if (i < 0) continue;
    if (i > 0) widened.add(AGE_BAND_ORDER[i - 1]);
    if (i < AGE_BAND_ORDER.length - 1) widened.add(AGE_BAND_ORDER[i + 1]);
  }
  return AGE_BAND_ORDER.filter((b) => widened.has(b));
}
