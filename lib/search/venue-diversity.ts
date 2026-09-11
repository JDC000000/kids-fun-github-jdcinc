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

/** Options for the key-agnostic cap. See `capByGroupingKey`. */
export interface GroupingCapOptions<T> {
  /**
   * Items from one key permitted per round — a flat number, or a function of the key when one
   * group legitimately deserves a different allowance than the rest.
   *
   * THE FUNCTION FORM EXISTS FOR A MEASURED REASON, not for generality's sake: a taxonomy can be
   * unevenly granular, so one key may be a catch-all holding several genuinely different things
   * while its neighbours are specific. Capping such a key as tightly as a specific one removes
   * real choices (see `CLASS_PROGRAM_CAP` in lib/sms/weekly-picks.ts). A resolved cap below 1 is
   * clamped UP to 1 rather than honoured: this module's contract is that it reorders and never
   * drops, and a cap of zero has no meaning inside that contract.
   */
  maxPerKey?: number | ((key: string) => number);
  /** How many items a round is. */
  windowSize?: number;
  /**
   * Only the first `reach` items are subject to the cap; everything below is appended in rank
   * order and is NEVER promoted ahead of a deferred item. Omit for the unbounded behaviour the
   * venue cap has always had. See the header below for why a low-cardinality key needs this.
   */
  reach?: number;
  /**
   * Veto a promotion. Consulted ONLY when something is already deferred — i.e. only when seating
   * this item really would move it ahead of a higher-ranked one. Return false and the item is
   * deferred alongside them instead, preserving the original order between the two.
   *
   * The shared module has no opinion about what makes a promotion unacceptable; it only knows
   * when one is about to happen. The caller supplies the judgement (see
   * lib/sms/weekly-picks.ts's age-fit guard, which is the reason this exists).
   */
  canPromote?: (candidate: T, deferred: readonly T[]) => boolean;
}

/**
 * Reorder items so each round of up to `windowSize` holds at most `maxPerKey` items per GROUPING
 * KEY, preserving rank order otherwise. Returns a new array holding exactly the same items as the
 * input.
 *
 * ═══ THIS IS `capVenueRepetition`'S ALGORITHM, UNCHANGED, WITH THE KEY MADE A PARAMETER ═══
 * Everything the venue cap's header describes — the rounds, the rank-preserving deferral, the
 * `sameKeyThroughout` early exit, the reorder-never-drop contract, resolving each item's key once
 * rather than once per visit — is here and is shared. The algorithm was already key-agnostic in
 * everything but the name of its parameter; this makes that explicit so a second key does not
 * mean a second implementation that can drift from this one.
 *
 * `capVenueRepetition` below is now a thin wrapper over this with its original defaults, so
 * /search, the front door's three-card hero, both digests and invariants/card-honesty.test.ts see
 * NO behavioural change. That is asserted by a property test against a frozen copy of the
 * pre-change implementation over randomised pools, not by reading.
 *
 * ═══ WHY `reach` EXISTS, AND WHY THE VENUE KEY DOES NOT NEED IT ═══
 * Venues are HIGH-cardinality: a crowded page still holds many of them, so the cap satisfies
 * itself a few positions deep. Categories are LOW-cardinality — there are about ten — so an
 * unbounded cap of 2 on a stratified pool reached original rank #92 to find its sixth category.
 * That is the failure the client named: nobody wants a worse, farther option dragged up from
 * rank ninety to hit a quota.
 *
 * `reach` bounds it. The cap applies within the top `reach` items; below that, items keep their
 * rank order and are never promoted past something the cap deferred. This is not invented — it is
 * `applyCoverageSwap`'s existing, approved discipline (`COVERAGE_SWAP_REACH = 20`), whose own
 * header gives the reasoning: past the reach, "a 'representative' is just a low-relevance listing
 * wearing a band label." Swap "band" for "category" and the sentence is still true.
 *
 * AN ITEM WITH NO KEY IS NEVER CAPPED — `keyOf` returning null is the ABSENCE of a fact, not a
 * group two items can share, and treating every unkeyed item as one group would demote unrelated
 * items for a resemblance that does not exist. It is still subject to `canPromote`, because a
 * promotion is a promotion whatever key the promoted item carries.
 */
export function capByGroupingKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string | null,
  options: GroupingCapOptions<T> = {}
): T[] {
  const maxPerKey = options.maxPerKey ?? MAX_CARDS_PER_VENUE;
  const windowSize = options.windowSize ?? VENUE_CAP_WINDOW;
  const { reach, canPromote } = options;
  // Clamped to >= 1 — see `maxPerKey`. This is also what keeps the liveness argument below true
  // for the function form: a round's first item can always be seated.
  const capFor = typeof maxPerKey === 'function'
    ? (key: string) => Math.max(1, maxPerKey(key))
    : () => Math.max(1, maxPerKey);

  // BOUNDED REACH: cap the head, pass the tail through untouched. Appending the tail AFTER the
  // capped head is what makes "never promoted ahead of a deferred item" structural — the head's
  // deferrals come out at the end of the head, so everything below the reach is still behind them.
  if (reach != null && reach < items.length) {
    if (reach <= 0) return [...items];
    const head = capByGroupingKey(items.slice(0, reach), keyOf, { ...options, reach: undefined });
    return [...head, ...items.slice(reach)];
  }

  // The scalar early return, unchanged for the number form (which is the only form
  // `capVenueRepetition` uses): fewer items than the cap means nothing can breach it.
  if (typeof maxPerKey === 'number' && (items.length <= maxPerKey || maxPerKey < 1)) return [...items];
  if (windowSize < 1) return [...items];

  const out: T[] = [];
  // The key is read ONCE per item rather than once per visit: an item can be looked at in several
  // rounds, and re-deriving the key on every one of those visits was measurably the bulk of the
  // cost on a page with a dominant group.
  let pending: Seat<T>[] = items.map((item) => ({ item, key: keyOf(item) }));

  while (pending.length > 0) {
    const placedByKey = new Map<string, number>();
    // Items this round could not seat, in rank order. They are all ranked ABOVE anything still
    // unread in `pending`, so putting them at the head of the next round is what keeps the
    // reorder rank-preserving rather than a reshuffle.
    const deferred: Seat<T>[] = [];
    let placed = 0;
    let index = 0;

    for (; index < pending.length && placed < windowSize; index += 1) {
      const seat = pending[index];
      // Nothing is deferred yet ⇒ seating this cannot be a promotion ⇒ the guard has no opinion.
      // This is ALSO what guarantees every round seats at least one item: the first item of a
      // round meets empty counters and an empty `deferred`, so neither the cap nor the guard can
      // turn it away, so `pending` always shrinks and the loop always terminates.
      const wouldPromote = deferred.length > 0;
      if (seat.key == null) {
        if (wouldPromote && canPromote && !canPromote(seat.item, deferred.map((d) => d.item))) {
          deferred.push(seat);
          continue;
        }
        out.push(seat.item);
        placed += 1;
        continue;
      }
      const held = placedByKey.get(seat.key) ?? 0;
      if (held >= capFor(seat.key)) {
        deferred.push(seat);
        continue;
      }
      if (wouldPromote && canPromote && !canPromote(seat.item, deferred.map((d) => d.item))) {
        deferred.push(seat);
        continue;
      }
      placedByKey.set(seat.key, held + 1);
      out.push(seat.item);
      placed += 1;
    }

    // Every round places at least one item (see `wouldPromote` above), so this always shrinks.
    pending = [...deferred, ...pending.slice(index)];

    // Nothing left to interleave WITH: one group's items can only ever come back in the order
    // they went in (each round takes the first `maxPerKey` of them), so dealing them out round
    // by round would burn passes to reproduce the input. Emit them and stop. This is an early
    // exit, not a relaxation — the output is identical, which the "single-venue page is returned
    // unchanged" test pins from the other side.
    if (pending.length > 0 && sameKeyThroughout(pending)) {
      for (const seat of pending) out.push(seat.item);
      break;
    }
  }

  return out;
}

/**
 * Reorder collapsed cards so each round of up to `windowSize` holds at most `maxPerVenue` cards
 * per venue, preserving rank order otherwise. Returns a new array holding exactly the same cards
 * as the input.
 *
 * A card whose venue is unnamed is never capped: an empty venue name is the absence of a fact,
 * not a venue two cards can share, and treating every unnamed venue as one place would demote
 * unrelated listings for a resemblance that does not exist.
 *
 * NOW A THIN WRAPPER over `capByGroupingKey` with venue as the key and this module's original
 * constants as the defaults. Signature, defaults and behaviour are UNCHANGED — the generalisation
 * added a parameter, it did not change this function's answer to anything. Four consumers depend
 * on that (`engine.ts` calls it from `runPrimary` twice and `runExpected`, which is /search, the
 * three-card hero and both digests) plus `invariants/card-honesty.test.ts`, so the empty
 * behavioural diff is proven by property test rather than asserted here.
 */
export function capVenueRepetition(cards: CollapsedListing[], options: VenueCapOptions = {}): CollapsedListing[] {
  return capByGroupingKey(cards, venueKey, {
    maxPerKey: options.maxPerVenue ?? MAX_CARDS_PER_VENUE,
    windowSize: options.windowSize ?? VENUE_CAP_WINDOW,
  });
}

/** An item with its grouping key already resolved, so the rounds never re-derive it. */
interface Seat<T> {
  item: T;
  key: string | null;
}

/** True when every queued item carries the same key (an absent key is its own answer: false). */
function sameKeyThroughout<T>(seats: Seat<T>[]): boolean {
  const first = seats[0].key;
  if (first == null) return false;
  for (let i = 1; i < seats.length; i += 1) if (seats[i].key !== first) return false;
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
