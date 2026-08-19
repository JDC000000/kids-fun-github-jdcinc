// lib/search/filters/age.ts — Age-band intersection predicate (BR-01..04, TSD §6.2).
//
// The user's selected bands are matched against the listing's derived
// `ageBandMatches[]` (non-empty intersection). Orthogonal to geo/time — combined
// in the query, never a dropdown-first gate (§5B age × geography independence).
//
// It also holds the EXACT per-child predicate (`fitsChild`/`fitsAllChildren`), which answers a
// different question against the same listing's raw month bounds rather than its bands — see the
// comment above `fitsChild` for why that has to be a separate mechanism and not a composition of
// the band predicates.

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

/**
 * Does this ONE listing admit a child of exactly this age — an exact month-bounds containment
 * test against the listing's own `[ageMinMonths, ageMaxMonths)`, deliberately not routed through
 * bands at all.
 *
 * WHY THIS CANNOT BE ASKED OF THE TWO PREDICATES ABOVE. Both of those read `ageBandMatches`,
 * which `computeAgeBandMatches` (worker/core/age.ts) fills by interval OVERLAP, not containment.
 * Overlap is the right relation for the question those predicates answer — "does this listing
 * fall within ANY band the parent selected" — and a programme running 48–72 months genuinely does
 * partially sit in both `2-4` (24–60) and `5-9` (60–120), so showing it under either single-band
 * filter is correct and intentional. Overlap is the WRONG relation for "does this listing work
 * for THIS child", because band membership is a claim about the band, not about any particular
 * child inside it.
 *
 * THE FALSE POSITIVE THAT MAKES THIS ITS OWN FUNCTION (design doc §6b, pinned in
 * tests/search/sibling-fit.test.ts). Composing the existing band predicates with AND — requiring
 * `ageBandMatches ⊇ {'2-4','5-9'}` for a 3-year-old and a 7-year-old — looks like the cheap way
 * to answer "works for both kids" and is unsound in the direction that hurts. A listing titled
 * "Ages 4–5" has bounds `[48, 72)` and therefore claims BOTH of those bands under overlap, so
 * band-AND reports it as fitting a 36-month-old and an 84-month-old when 36 and 84 are both
 * outside `[48, 72)`: it fits NEITHER. Band-AND is a strict over-approximation — no false
 * negatives, real false positives — and a false positive here is a parent taking two children to
 * a rec centre where one of them is turned away. Month bounds are already on `ListingRecord`
 * (lib/search/types.ts) and already populated through the whole read path, so the exact answer
 * costs no migration, no new column and no read-model change (§6c).
 *
 * BOUNDS CONVENTION. min INCLUSIVE, max EXCLUSIVE, null = open-ended — worker/core/age.ts:16-20,
 * where a written "Ages 4–5" becomes `[48, 72)` precisely so it still admits five-year-olds up to
 * their sixth birthday. A degenerate inverted range (`min >= max`) admits nobody and needs no
 * special case: no age is both `>= 72` and `< 48`.
 *
 * UNKNOWN BOUNDS ARE NOT A FIT — the guard that is easy to forget. With both bounds null the
 * containment test is vacuously true for every age, which would make an unresolved-age listing a
 * perfect fit for every child on earth. That is the "unresolved is not neutral, it is MAXIMALLY
 * permissive" trap that lib/audit/rules/adult-age-band.ts:13 documents. It is the right trade for
 * `matchesAge`, whose answer only decides visibility and errs toward showing more; it is the
 * wrong trade here, because this predicate exists to back a CONFIDENT claim about a specific
 * child, and a claim with nothing behind it is worse than no claim. So unknown → false. A
 * half-open listing ("Ages 4+", `[48, null)`) is a real claim and is honoured normally.
 *
 * A non-finite or negative `ageMonths` also fails closed rather than propagating: `NaN` from a
 * `Number()` on unparseable input would otherwise silently answer "no fit" on one branch and
 * "fit" on another depending on which bound happened to be null.
 */
export function fitsChild(listing: ListingRecord, ageMonths: number): boolean {
  if (!Number.isFinite(ageMonths) || ageMonths < 0) return false;
  if (listing.ageMinMonths == null && listing.ageMaxMonths == null) return false;
  return (
    (listing.ageMinMonths == null || ageMonths >= listing.ageMinMonths) &&
    (listing.ageMaxMonths == null || ageMonths < listing.ageMaxMonths)
  );
}

/**
 * Does this ONE listing admit EVERY child in the list — the sibling-fit primitive, AND across
 * children where `matchesAge` is OR across bands.
 *
 * The two are different products and the distinction is the point: the rail's own copy promises
 * "we'll match either age" (FilterRail.tsx), and "either" is not "both". Whichever surface
 * eventually consumes this — a section, a badge, a filter — the primitive underneath is the same,
 * which is why it lands correct and tested ahead of that decision.
 *
 * An EMPTY list returns false, matching `hasConfirmedAgeMatch`'s "nothing asked for → nothing to
 * confirm". `[].every()` is true, so the natural reading of this function would otherwise claim
 * every listing fits all zero children — the same vacuity trap as unknown bounds, one level up.
 */
export function fitsAllChildren(listing: ListingRecord, childAgesMonths: number[]): boolean {
  if (childAgesMonths.length === 0) return false;
  return childAgesMonths.every((ageMonths) => fitsChild(listing, ageMonths));
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
