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

/** One collapsed-group member's own age bounds, in months — the canonical unit (`occurrence_age`). */
export interface AgeFacts {
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
}

/**
 * What may be said about a collapsed card's age.
 *   • `agreed` → every member states the same bounds; print them exactly as a single card always did.
 *   • `varies` → the members DISAGREE, and no single range is true of all of them.
 */
export type AgeRead =
  | { kind: 'agreed'; ageMinMonths: number | null; ageMaxMonths: number | null }
  | { kind: 'varies' };

/**
 * Decide what may be said about the age of a COLLAPSED CARD — one card standing for every
 * same-series-same-day occurrence of one activity (lib/search/collapse.ts). Pure, and the exact
 * counterpart of `readGroupCost` (lib/search/filters/cost.ts) for the other per-occurrence fact a
 * collapsed card asserts on its face.
 *
 * THE DEFECT THIS CLOSES. A collapsed card printed its REPRESENTATIVE's age bounds as though they
 * spoke for the whole group. `occurrence_age` is keyed per OCCURRENCE (migration 0005), so a group
 * can legitimately hold a 19+ evening session beside an all-ages daytime one — and the card said
 * whichever the representative happened to be. Which member that is, is decided by rank+sort BEFORE
 * collapse (lib/search/engine.ts) and has nothing to do with age, so the claim on the face was
 * effectively arbitrary. When the representative is the less-restrictive member, the card publishes
 * "All ages" for a group containing a session no child may attend. That is the same family as the
 * age-provenance work: a confident claim that exceeds what the source actually said.
 *
 * THE RULE — DECLINE, DON'T RECONCILE. When members disagree the answer is `varies`, and the card
 * states that in words rather than printing a range:
 *   • The most-restrictive ENVELOPE (highest floor, lowest ceiling) is wrong to print, because it
 *     over-claims in the other direction: [0,∞) beside [15,∞) would render "Ages 15+" and hide a
 *     genuinely all-ages session from the parent of a toddler. It can also invert ([5,9] beside
 *     [15,∞)), leaving nothing printable anyway.
 *   • The UNION span is wrong to print because it is exactly the less-restrictive claim this
 *     function exists to stop — "Ages 0–19" reads as one session admitting everyone.
 * Neither bound is a fact about the group, so neither is printed. This differs deliberately from
 * `readGroupCost`, which CAN state a union span ("Varies: $103–$240") because a price span is
 * still a true statement about what a parent might pay; an age span is read as a permission, and a
 * permission that is true of only one session is the harm. Per-session bounds stay available via
 * `slots` for any surface that wants to list them.
 *
 * A single-member group takes the `agreed` arm, so every uncollapsed card is unchanged to the byte.
 */
export function readGroupAge(slots: AgeFacts[]): AgeRead {
  // No members is not a group. `collapseSameDaySeries` always seats at least the representative,
  // but "the source stated nothing" is the honest answer if one ever arrives.
  if (slots.length === 0) return { kind: 'agreed', ageMinMonths: null, ageMaxMonths: null };

  const first = slots[0];
  const agreed = slots.every(
    (s) => s.ageMinMonths === first.ageMinMonths && s.ageMaxMonths === first.ageMaxMonths,
  );
  return agreed
    ? { kind: 'agreed', ageMinMonths: first.ageMinMonths, ageMaxMonths: first.ageMaxMonths }
    : { kind: 'varies' };
}
