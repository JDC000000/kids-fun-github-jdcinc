// lib/search/venue-diversity.ts — no single venue may own the page.
//
// Collapsing (lib/search/collapse.ts) removes the same PROGRAMME repeated down a page. This
// removes the same PLACE repeated down a page, which is a different defect with the same
// symptom: the 2026-08-18 independent report (P1-2) measured result pages whose top rows were
// one community centre's whole timetable, so "60 results" was really one venue offering a parent
// no choice of where to go. Its remedy, adopted verbatim as the default here: cap any single
// venue at 3 cards in the top 20.
//
// A REORDER, NEVER A FILTER. Nothing is dropped, hidden or reclassified — a card over the cap is
// DEFERRED to the next round, not removed, so `results.length`, `total`, `facets.total` and the
// broadening ladder's "is this page thin?" test all see exactly the population they saw before.
// That is what makes this safe to run inside the ladder's probe loop, and it is the same shape as
// the one other ordering-only step in this pipeline (sort.ts#prioritizeConfirmedFreeWhenFreeActive):
// a stable partition layered on top of the sort, never a second opinion about what belongs.
//
// WHY ROUNDS RATHER THAN "THE TOP 20". A one-shot cap on the first 20 cards just re-piles the
// deferred cards at position 21, so a parent who scrolls meets the wall the cap was meant to
// remove. Instead the page is dealt in ROUNDS: each round walks what is left in rank order and
// seats at most 3 cards per venue, up to 20 cards, and whatever it could not seat leads the next
// round. On the pages the report measured — many venues, one of them over-represented — a round IS
// the top 20 and the rule reads exactly as the report wrote it.
//
// WHAT THIS CANNOT DO, SAID PLAINLY. "No venue holds more than 3 of any 20 results" is only
// achievable if the page HAS 20 results spread over enough venues. A search that returns ten
// listings, eight of them at one recreation centre, cannot satisfy it without hiding six real
// answers — and hiding them is exactly what this module refuses to do. In that case the rounds
// simply get shorter: the first three cards from the crowded venue, then everything else, then
// the rest of the crowded venue. The parent still meets the alternatives before the eighth
// Delbrook row; they are not told the other five do not exist. On a page that is ALL one venue
// the output is byte-for-byte the input — every round defers what it cannot seat and the next
// round seats it next, in rank order — so a single-venue search is never punished for having
// nothing to diversify with.

// COST, MEASURED RATHER THAN ASSUMED — the broadening ladder probes this on every rung it walks,
// so a cost here can be paid ~10 times in one search. One pass per round is O(cards × rounds),
// and rounds is ceil(the biggest venue's share ÷ 3): 1 round for an ordinary page, but 1,667 for
// a page that is 5,000 cards of ONE venue — which measured at 253 ms per call, for a page the
// reorder cannot change at all. Two things fix that, and both are below: venue identity is
// resolved once per card rather than once per visit, and `sameVenueThroughout` ends the deal as
// soon as everything still queued belongs to one venue, because there is then provably nothing
// left to interleave. Re-measured after: 0.6 ms for the 5,000-card single-venue page, 5.6 ms for
// 5,000 cards spread over 40 venues (which is not a page the ladder ever probes — a page that
// size is not thin).

import type { CollapsedListing } from './collapse';

/** Cards from one venue permitted per round. The report's number. */
export const MAX_CARDS_PER_VENUE = 3;
/** How many cards a page-worth (one round) is. The report's number. */
export const VENUE_CAP_WINDOW = 20;

export interface VenueCapOptions {
  maxPerVenue?: number;
  windowSize?: number;
}

/**
 * Reorder collapsed cards so each round of up to `windowSize` holds at most `maxPerVenue` cards
 * per venue, preserving rank order otherwise. Returns a new array holding exactly the same cards
 * as the input.
 *
 * A card whose venue is unnamed is never capped: an empty venue name is the absence of a fact,
 * not a venue two cards can share, and treating every unnamed venue as one place would demote
 * unrelated listings for a resemblance that does not exist.
 */
export function capVenueRepetition(cards: CollapsedListing[], options: VenueCapOptions = {}): CollapsedListing[] {
  const maxPerVenue = options.maxPerVenue ?? MAX_CARDS_PER_VENUE;
  const windowSize = options.windowSize ?? VENUE_CAP_WINDOW;
  if (cards.length <= maxPerVenue || maxPerVenue < 1 || windowSize < 1) return [...cards];

  const out: CollapsedListing[] = [];
  // Venue identity is read ONCE per card rather than once per visit: a card can be looked at in
  // several rounds, and `trim().toLowerCase()` on every one of those visits was measurably the
  // bulk of the cost on a page with a dominant venue.
  let pending: Seat[] = cards.map((card) => ({ card, venue: venueKey(card) }));

  while (pending.length > 0) {
    const placedByVenue = new Map<string, number>();
    // Cards this round could not seat, in rank order. They are all ranked ABOVE anything still
    // unread in `pending`, so putting them at the head of the next round is what keeps the
    // reorder rank-preserving rather than a reshuffle.
    const deferred: Seat[] = [];
    let placed = 0;
    let index = 0;

    for (; index < pending.length && placed < windowSize; index += 1) {
      const seat = pending[index];
      if (seat.venue == null) {
        out.push(seat.card);
        placed += 1;
        continue;
      }
      const held = placedByVenue.get(seat.venue) ?? 0;
      if (held >= maxPerVenue) {
        deferred.push(seat);
        continue;
      }
      placedByVenue.set(seat.venue, held + 1);
      out.push(seat.card);
      placed += 1;
    }

    // Every round places at least one card (its counters start empty), so this always shrinks.
    pending = [...deferred, ...pending.slice(index)];

    // Nothing left to interleave WITH: one venue's cards can only ever come back in the order
    // they went in (each round takes the first `maxPerVenue` of them), so dealing them out round
    // by round would burn passes to reproduce the input. Emit them and stop. This is an early
    // exit, not a relaxation — the output is identical, which the "single-venue page is returned
    // unchanged" test pins from the other side.
    if (pending.length > 0 && sameVenueThroughout(pending)) {
      for (const seat of pending) out.push(seat.card);
      break;
    }
  }

  return out;
}

/** A card with its venue identity already resolved, so the rounds never re-derive it. */
interface Seat {
  card: CollapsedListing;
  venue: string | null;
}

/** True when every queued card names the same venue (an unnamed venue is its own answer: false). */
function sameVenueThroughout(seats: Seat[]): boolean {
  const first = seats[0].venue;
  if (first == null) return false;
  for (let i = 1; i < seats.length; i += 1) if (seats[i].venue !== first) return false;
  return true;
}

/**
 * Case/whitespace-insensitive venue identity; null when nothing names a venue.
 *
 * Exported because the front door's "three things" block (lib/recommend/three-things.ts) applies
 * the same soft preference ACROSS its three slots that this module applies WITHIN one list, and
 * the two must agree on when two cards are at the same place. Taking the raw name rather than a
 * card keeps it usable from a caller holding any shape — the cap below still reads it off a
 * `CollapsedListing`, one hop away in `venueKey`.
 *
 * The null is the load-bearing part and is the rule stated in `capVenueRepetition`'s header: an
 * empty venue name is the ABSENCE of a fact, not a venue two cards can share. Every caller must
 * treat null as "no opinion", never as a group.
 */
export function venueIdentity(venueName: string | null | undefined): string | null {
  const name = venueName?.trim().toLowerCase();
  return name ? name : null;
}

/** Case/whitespace-insensitive venue identity; null when the listing names no venue. */
function venueKey(card: CollapsedListing): string | null {
  return venueIdentity(card.representative.candidate.listing.venueName);
}
