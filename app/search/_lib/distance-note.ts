// Why this page's cards have no distance on them — answered once, at the page level.
//
// WHY THIS IS A PAGE-LEVEL FACT AND NOT A PER-CARD ONE. A distance needs two things: an origin
// (where the parent is starting from) and a venue coordinate. Only the second is a property of
// an individual result — and the search pipeline makes it unreachable in combination with the
// first, because the radius filter drops un-geocoded venues whenever an origin exists
// (lib/search/filters/predicate.ts: `if (origin && !withinRadius(origin.geo, listing.geo, …))`,
// and withinRadius is false for a null geo by construction). So on any /api/search response:
//
//     some result has distanceKm === null   ⟺   the whole response has origin === null
//
// Verified mechanically against the engine (tests/search/origin-distance-invariant.test.ts) and
// empirically against live production (5 queries × 100 results with an origin: zero nulls).
//
// That is why the CARD copy stays the flat, always-true "Distance unavailable" — a card cannot
// be the thing that explains a request-level absence, and repeating an identical actionable
// sentence on sixty cards would be noise, not help. The explanation and the thing to do about
// it belong here, stated once, next to the results they describe.
//
// The third state is the one worth having the API's `originError` for: a parent who DID set a
// location we then failed to resolve must not be told to set a location. They did. We failed.

import type { SearchResponseDto } from '../../preview/_data/search-api';

export type DistanceAvailability =
  /** An origin was resolved — every result carries a real measured distance. No note. */
  | 'measured'
  /** No origin was asked for. Distances are unknowable, and the parent can fix that. */
  | 'no_origin'
  /** An origin WAS asked for and could not be resolved. Not the parent's to fix by asking again. */
  | 'origin_failed';

/**
 * Read the response's own account of what it could measure from. Deliberately reads the
 * RESOLVED origin rather than the request's parameters: "we sent coordinates" and "the engine
 * had an origin" are different claims, and only the second one produces distances.
 *
 * A response with no `origin` key at all (hand-built fixtures, older cached shapes) is treated
 * as 'measured' — i.e. it renders no note. Silence is the safe default here: a spurious
 * "distances aren't shown" over a page that IS showing them would be its own false statement.
 */
export function distanceAvailability(response: Pick<SearchResponseDto, 'origin' | 'originError'> | undefined): DistanceAvailability {
  if (!response || response.origin === undefined) return 'measured';
  if (response.origin !== null) return 'measured';
  return response.originError ? 'origin_failed' : 'no_origin';
}

/**
 * The note itself, or null when there is nothing to explain.
 *
 * "Near me" is named because that is the control's own label in the filter rail, and it is the
 * ONLY control on this page that produces an origin for an anonymous parent. Region chips
 * deliberately are NOT offered as an alternative: they send `region=` (a filter over the
 * catalogue), not `area=` (an origin), so narrowing to North Vancouver does not make a distance
 * appear — telling a parent it would is exactly the kind of small false promise this whole fix
 * exists to remove.
 */
export function distanceNote(availability: DistanceAvailability): string | null {
  switch (availability) {
    case 'measured':
      return null;
    case 'no_origin':
      return 'Distances aren’t shown — we don’t know where you’re starting from. Use “Near me” to see how far each activity is.';
    case 'origin_failed':
      return 'We couldn’t use the location you set, so distances aren’t shown for these results.';
  }
}
