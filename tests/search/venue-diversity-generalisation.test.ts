// tests/search/venue-diversity-generalisation.test.ts — the cap became key-agnostic; prove it
// still answers every old question exactly the way it used to.
//
// `capVenueRepetition` is now a thin wrapper over `capByGroupingKey`. Four consumers depend on it
// (`engine.ts` calls it from `runPrimary` twice and from `runExpected`, which is /search, the
// front door's three-card hero and both digests) plus `invariants/card-honesty.test.ts`. A
// generalisation that quietly changed one of their answers would be the worst possible outcome of
// this refactor, and "I read it and it looks the same" is not evidence.
//
// So this file holds a FROZEN, VERBATIM COPY of the pre-change implementation — copied from
// main@f544e59, never to be edited — and asserts the shipped wrapper agrees with it byte for byte
// over randomised pools. If someone later "improves" the shared cap, this fails, names the pool it
// failed on, and the improvement has to be justified against four surfaces instead of one.
import { describe, expect, it } from 'vitest';
import {
  MAX_CARDS_PER_VENUE,
  VENUE_CAP_WINDOW,
  capByGroupingKey,
  capVenueRepetition,
  venueIdentity,
} from '@/lib/search/venue-diversity';
import type { CollapsedListing } from '@/lib/search/collapse';

// ─────────────────────────────────────────────────────────────────────────────
// THE FROZEN ORACLE. Copied verbatim from lib/search/venue-diversity.ts at main@f544e59,
// before `capByGroupingKey` existed. DO NOT EDIT THIS TO MAKE A TEST PASS — if the shipped
// implementation disagrees with it, the shipped implementation changed behaviour, which is
// exactly what this file exists to detect.
// ─────────────────────────────────────────────────────────────────────────────
interface FrozenSeat { card: CollapsedListing; venue: string | null }

function frozenSameVenueThroughout(seats: FrozenSeat[]): boolean {
  const first = seats[0].venue;
  if (first == null) return false;
  for (let i = 1; i < seats.length; i += 1) if (seats[i].venue !== first) return false;
  return true;
}

function frozenCapVenueRepetition(
  cards: CollapsedListing[],
  options: { maxPerVenue?: number; windowSize?: number } = {}
): CollapsedListing[] {
  const maxPerVenue = options.maxPerVenue ?? MAX_CARDS_PER_VENUE;
  const windowSize = options.windowSize ?? VENUE_CAP_WINDOW;
  if (cards.length <= maxPerVenue || maxPerVenue < 1 || windowSize < 1) return [...cards];

  const out: CollapsedListing[] = [];
  let pending: FrozenSeat[] = cards.map((card) => ({
    card,
    venue: venueIdentity(card.representative.candidate.listing.venueName),
  }));

  while (pending.length > 0) {
    const placedByVenue = new Map<string, number>();
    const deferred: FrozenSeat[] = [];
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

    pending = [...deferred, ...pending.slice(index)];

    if (pending.length > 0 && frozenSameVenueThroughout(pending)) {
      for (const seat of pending) out.push(seat.card);
      break;
    }
  }

  return out;
}

// ── A deterministic PRNG, so a failure is reproducible from its seed alone ────
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A card carrying only what the cap reads — the venue name — plus an id to compare identity on. */
function card(id: string, venueName: string | null): CollapsedListing {
  return {
    representative: {
      candidate: { listing: { id, venueName } as never, relevance: 0, matchedTerms: [], categoryHit: false },
      score: 0,
      components: {} as never,
      distanceKm: null,
    },
    slots: [],
  } as CollapsedListing;
}

const idsOf = (cards: CollapsedListing[]) => cards.map((c) => c.representative.candidate.listing.id);

/** Pools spanning the shapes the four consumers actually produce, plus the pathological ones. */
function randomPool(random: () => number, size: number): CollapsedListing[] {
  const shape = random();
  return Array.from({ length: size }, (_, i) => {
    if (shape < 0.2) return card(`c${i}`, 'One Venue'); // single-venue page
    if (shape < 0.35) return card(`c${i}`, random() < 0.5 ? '' : null); // all unnamed
    if (shape < 0.6) return card(`c${i}`, `V${Math.floor(random() * 3)}`); // dominant few
    if (shape < 0.8) return card(`c${i}`, random() < 0.25 ? '' : `V${Math.floor(random() * 8)}`); // mixed + unnamed
    return card(`c${i}`, `V${Math.floor(random() * 40)}`); // wide spread
  });
}

describe('capVenueRepetition is now a wrapper — the behavioural diff must be EMPTY', () => {
  it('agrees with the frozen pre-change implementation on 600 randomised pools', () => {
    const random = rng(20260911);
    for (let trial = 0; trial < 600; trial += 1) {
      const size = Math.floor(random() * 60);
      const pool = randomPool(random, size);
      const shipped = capVenueRepetition(pool);
      const frozen = frozenCapVenueRepetition(pool);
      expect(idsOf(shipped), `default options, trial ${trial}, size ${size}`).toEqual(idsOf(frozen));
    }
  });

  it('agrees across the whole option space too, not just the defaults', () => {
    // `VenueCapOptions` is exported and the digest now passes it, so the option path is live code
    // rather than a hypothetical. Degenerate values are included deliberately: 0 and negatives are
    // what the original's `maxPerVenue < 1 || windowSize < 1` early return exists for.
    const random = rng(4224);
    for (const maxPerVenue of [0, 1, 2, 3, 5, -1]) {
      for (const windowSize of [0, 1, 2, 10, 20, 50, -1]) {
        for (let trial = 0; trial < 12; trial += 1) {
          const pool = randomPool(random, Math.floor(random() * 40));
          const shipped = capVenueRepetition(pool, { maxPerVenue, windowSize });
          const frozen = frozenCapVenueRepetition(pool, { maxPerVenue, windowSize });
          expect(idsOf(shipped), `maxPerVenue=${maxPerVenue} windowSize=${windowSize} trial=${trial}`).toEqual(idsOf(frozen));
        }
      }
    }
  });

  it('returns the SAME card objects, never copies — identity is what callers rely on', () => {
    const pool = [card('a', 'V0'), card('b', 'V0'), card('c', 'V0'), card('d', 'V1')];
    const out = capVenueRepetition(pool, { maxPerVenue: 1, windowSize: 2 });
    expect(out).toHaveLength(pool.length);
    for (const c of pool) expect(out).toContain(c);
  });

  it('still reads its defaults from this module’s own constants', () => {
    // The report's numbers for the search page, unchanged by the generalisation.
    expect(MAX_CARDS_PER_VENUE).toBe(3);
    expect(VENUE_CAP_WINDOW).toBe(20);
    const pool = Array.from({ length: 25 }, (_, i) => card(`c${i}`, i < 6 ? 'Dominant' : `V${i}`));
    expect(idsOf(capVenueRepetition(pool))).toEqual(idsOf(capVenueRepetition(pool, { maxPerVenue: 3, windowSize: 20 })));
  });
});

describe('capByGroupingKey — the key is a parameter now', () => {
  it('caps on any key the caller names, not just the venue', () => {
    const pool = [card('a', 'V0'), card('b', 'V0'), card('c', 'V0'), card('d', 'V1'), card('e', 'V1')];
    // Group by the FIRST LETTER of the id instead — an arbitrary key the module knows nothing about.
    const byInitial = capByGroupingKey(pool, (c) => c.representative.candidate.listing.id[0], { maxPerKey: 1, windowSize: 5 });
    expect(byInitial).toHaveLength(5);
    expect(new Set(idsOf(byInitial))).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('is a REORDER, never a filter — every input comes back, on every shape', () => {
    const random = rng(99);
    for (let trial = 0; trial < 200; trial += 1) {
      const pool = randomPool(random, Math.floor(random() * 50));
      for (const reach of [undefined, 0, 1, 5, 20, 1000]) {
        const out = capByGroupingKey(pool, (c) => venueIdentity(c.representative.candidate.listing.venueName), { maxPerKey: 2, windowSize: 10, reach });
        expect(out).toHaveLength(pool.length);
        expect([...idsOf(out)].sort()).toEqual([...idsOf(pool)].sort());
      }
    }
  });
});

describe('the bounded reach — the number that answers "don’t drag up rank ninety"', () => {
  const venueOf = (c: CollapsedListing) => venueIdentity(c.representative.candidate.listing.venueName);

  it('reach: undefined is byte-identical to the unbounded cap it generalises', () => {
    const random = rng(7);
    for (let trial = 0; trial < 200; trial += 1) {
      const pool = randomPool(random, Math.floor(random() * 40));
      const unbounded = capByGroupingKey(pool, venueOf, { maxPerKey: 2, windowSize: 10 });
      const explicit = capByGroupingKey(pool, venueOf, { maxPerKey: 2, windowSize: 10, reach: undefined });
      expect(idsOf(explicit), `trial ${trial}`).toEqual(idsOf(unbounded));
    }
  });

  it('leaves the SPARSE case completely alone — the client’s own objection, as a test', () => {
    // 22 of one kind and exactly ONE alternative, sitting at rank #23. The unbounded cap drags it
    // up; a reach of 20 cannot see it at all, so the family is shown what is actually near them
    // and nothing clever is done. "A family near only swim facilities shouldn't be shown a worse,
    // farther rock-climbing gym just to hit a diversity quota."
    const pool = [
      ...Array.from({ length: 22 }, (_, i) => card(`swim-${i}`, 'Pool')),
      card('gym-far', 'Faraway Gym'),
    ];
    const bounded = capByGroupingKey(pool, venueOf, { maxPerKey: 2, windowSize: 10, reach: 20 });
    expect(idsOf(bounded)).toEqual(idsOf(pool)); // identical to baseline, byte for byte
    expect(idsOf(bounded).slice(0, 10).every((id) => id.startsWith('swim-'))).toBe(true);

    // …and the unbounded cap is what it is being protected FROM: it reaches past the wall.
    const unbounded = capByGroupingKey(pool, venueOf, { maxPerKey: 2, windowSize: 10 });
    expect(idsOf(unbounded).slice(0, 10)).toContain('gym-far');
  });

  it('never promotes anything from below the reach ahead of an item the cap deferred', () => {
    // The ordering contract, stated directly. Everything below `reach` keeps its rank order and
    // sits behind every deferral, so the bound cannot be escaped by a lucky arrangement.
    const pool = [
      card('d0', 'Dom'), card('d1', 'Dom'), card('d2', 'Dom'), card('d3', 'Dom'),
      card('a0', 'Alt0'), card('a1', 'Alt1'),
      card('below0', 'Below0'), card('below1', 'Below1'),
    ];
    const out = idsOf(capByGroupingKey(pool, venueOf, { maxPerKey: 2, windowSize: 4, reach: 6 }));
    // d2 and d3 were deferred inside the reach; below0/below1 came from outside it.
    expect(out.indexOf('below0')).toBeGreaterThan(out.indexOf('d2'));
    expect(out.indexOf('below0')).toBeGreaterThan(out.indexOf('d3'));
    expect(out.indexOf('below1')).toBeGreaterThan(out.indexOf('below0')); // tail keeps rank order
  });

  it('reach at or past the list length is the same as no reach at all', () => {
    const pool = Array.from({ length: 12 }, (_, i) => card(`c${i}`, i < 5 ? 'Dom' : `V${i}`));
    const unbounded = idsOf(capByGroupingKey(pool, venueOf, { maxPerKey: 2, windowSize: 10 }));
    for (const reach of [12, 13, 100]) {
      expect(idsOf(capByGroupingKey(pool, venueOf, { maxPerKey: 2, windowSize: 10, reach })), `reach ${reach}`).toEqual(unbounded);
    }
    // …and a reach of zero or less caps nothing, which is the honest reading of "look no further".
    for (const reach of [0, -1]) {
      expect(idsOf(capByGroupingKey(pool, venueOf, { maxPerKey: 2, windowSize: 10, reach })), `reach ${reach}`).toEqual(idsOf(pool));
    }
  });
});

describe('canPromote — the seam the age-fit guard hangs on', () => {
  const venueOf = (c: CollapsedListing) => venueIdentity(c.representative.candidate.listing.venueName);

  it('is not consulted when nothing is deferred, because nothing is being promoted', () => {
    const pool = [card('a', 'V0'), card('b', 'V1'), card('c', 'V2')];
    const seen: string[] = [];
    const out = capByGroupingKey(pool, venueOf, {
      maxPerKey: 2, windowSize: 10,
      canPromote: (c) => { seen.push(c.representative.candidate.listing.id); return true; },
    });
    expect(seen).toEqual([]); // no cap pressure ⇒ no promotions ⇒ no questions asked
    expect(idsOf(out)).toEqual(['a', 'b', 'c']);
  });

  it('vetoing a promotion defers the candidate instead, preserving the original order', () => {
    // 'x' would be promoted over the deferred 'd2'. The veto puts it behind d2 rather than
    // dropping it — a guard on this seam may never remove anything.
    const pool = [card('d0', 'Dom'), card('d1', 'Dom'), card('d2', 'Dom'), card('x', 'Other')];
    const vetoed = idsOf(capByGroupingKey(pool, venueOf, {
      maxPerKey: 2, windowSize: 10, canPromote: (c) => c.representative.candidate.listing.id !== 'x',
    }));
    expect(vetoed).toEqual(['d0', 'd1', 'd2', 'x']);
    expect(vetoed).toHaveLength(pool.length);

    // Without the veto, 'x' takes the seat d2 could not have.
    const allowed = idsOf(capByGroupingKey(pool, venueOf, { maxPerKey: 2, windowSize: 10 }));
    expect(allowed).toEqual(['d0', 'd1', 'x', 'd2']);
  });

  it('TERMINATES even when the guard refuses everything it is asked about', () => {
    // The loop's liveness argument: a round's first item meets empty counters AND an empty
    // `deferred`, so neither the cap nor the guard can turn it away. A guard that always says no
    // therefore still makes progress rather than spinning. This is the test that would hang
    // rather than fail if that reasoning were wrong, which is why it is here.
    const pool = Array.from({ length: 30 }, (_, i) => card(`c${i}`, `V${i % 3}`));
    const out = capByGroupingKey(pool, venueOf, { maxPerKey: 1, windowSize: 2, canPromote: () => false });
    expect(out).toHaveLength(30);
    expect([...idsOf(out)].sort()).toEqual([...idsOf(pool)].sort());
  });

  it('a veto can never change the population, only the order', () => {
    const random = rng(555);
    for (let trial = 0; trial < 150; trial += 1) {
      const pool = randomPool(random, Math.floor(random() * 40));
      const out = capByGroupingKey(pool, venueOf, {
        maxPerKey: 2, windowSize: 10, reach: 20,
        canPromote: () => random() < 0.5,
      });
      expect([...idsOf(out)].sort(), `trial ${trial}`).toEqual([...idsOf(pool)].sort());
    }
  });
});
