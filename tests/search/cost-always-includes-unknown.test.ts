// tests/search/cost-always-includes-unknown.test.ts
//
// UNKNOWN-COST LISTINGS ARE ALWAYS RETURNED — asserted at the HTTP boundary, not just in the
// predicate, because the boundary is where the defect lived.
//
// THE TRAP THIS FILE EXISTS FOR. The removed "Include unknown cost" toggle had two readers with
// OPPOSITE defaults for the same absent parameter:
//   • app/search/_lib/params.ts   — absent `includeUnknownCost` meant TRUE  (include)
//   • app/api/search/route.ts     — absent `includeUnknownCost` meant FALSE (exclude), via isOn()
// So deleting the chip and letting the UI simply stop sending the param would have flipped
// production from "include" to "exclude" — the exact opposite of the requested behaviour, with
// no control left anywhere to correct it, and with every pre-existing test still green (they
// all passed the flag explicitly, so none of them ever exercised the absent case).
//
// That is why these assertions are made through the REAL route handler with the parameter
// ABSENT. A unit test of matchesCost() alone would have passed both before and after the
// mistake. `?includeUnknownCost=0` is asserted too: a stale bookmark, an old saved search or a
// third-party caller must not be able to reinstate the suppression.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET } from '../../app/api/search/route';
import { matchesCost, type CostFilter } from '../../lib/search/filters/cost';
import { makeListing } from '../../lib/search/__fixtures__/factory';

interface Item { listing: { id: string; costStatus: string } }
interface Body { results?: Item[]; expected?: Item[]; total?: number }

async function call(qs: string): Promise<{ status: number; body: Body }> {
  const res = await GET(new Request(`http://localhost/api/search?${qs}`));
  return { status: res.status, body: (await res.json()) as Body };
}

const items = (b: Body): Item[] => [...(b.results ?? []), ...(b.expected ?? [])];
const unknownCostCount = (b: Body): number =>
  items(b).filter((i) => i.listing.costStatus === 'unknown' || i.listing.costStatus === 'check_source').length;

// A bare browse over the whole fixture catalogue: minResults 0 keeps the broadening ladder out
// of the way, so what comes back is the raw filtered set and nothing else.
const BROWSE = 'q=&minResults=0&limit=100';

describe('/api/search — unknown-cost listings are returned with the param ABSENT', () => {
  const savedBackend = process.env.KIDS_FUN_SEARCH_BACKEND;
  beforeEach(() => {
    delete process.env.KIDS_FUN_SEARCH_BACKEND; // fixture mode: hermetic, no DB
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.KIDS_FUN_SEARCH_BACKEND;
    else process.env.KIDS_FUN_SEARCH_BACKEND = savedBackend;
  });

  it('THE TRAP: no includeUnknownCost param at all → unknown-cost listings still come back', async () => {
    const { status, body } = await call(BROWSE);
    expect(status).toBe(200);
    // Assert the catalogue is non-empty FIRST. A route that returned nothing at all would
    // otherwise satisfy "no unknown-cost listing was wrongly excluded" vacuously.
    expect(items(body).length).toBeGreaterThan(0);
    expect(unknownCostCount(body)).toBeGreaterThan(0);
  });

  it('sending the old param either way changes NOTHING — same ids, same order', async () => {
    const { body: absent } = await call(BROWSE);
    const { body: on } = await call(`${BROWSE}&includeUnknownCost=1`);
    const { body: off } = await call(`${BROWSE}&includeUnknownCost=0`);
    const ids = (b: Body) => items(b).map((i) => i.listing.id);

    expect(ids(absent).length).toBeGreaterThan(0);
    expect(ids(on)).toEqual(ids(absent));
    // The one that matters: an explicit OFF must be INERT, not obeyed. If this ever fails, a
    // stale link can suppress listings again and nothing in the UI can undo it.
    expect(ids(off)).toEqual(ids(absent));
    expect(unknownCostCount(off)).toBe(unknownCostCount(absent));
  });

  it('a "free" search shows unknown-cost listings, and the free/unknown DISTINCTION survives', async () => {
    const { body } = await call('q=free&minResults=0&limit=100');
    expect(items(body).length).toBeGreaterThan(0);
    expect(unknownCostCount(body)).toBeGreaterThan(0);
    // Shown is not the same as relabelled: nothing in the payload has been recast as free.
    for (const i of items(body)) {
      if (i.listing.costStatus === 'unknown') expect(i.listing.costStatus).not.toBe('free');
    }
  });
});

describe('matchesCost — the predicate itself has no inclusion switch left', () => {
  const unknown = makeListing({ costStatus: 'unknown' });
  const checkSource = makeListing({ costStatus: 'check_source' });
  const paid = makeListing({ costStatus: 'known', costMinCad: 40, costMaxCad: 40 });

  it('admits unknown/check-source under every filter shape there is', () => {
    for (const listing of [unknown, checkSource]) {
      expect(matchesCost(listing, { free: false })).toBe(true);
      expect(matchesCost(listing, { free: true })).toBe(true);
    }
    // "Every filter shape there is" is now literally two, because `free` is the only key
    // CostFilter carries since the ceiling was removed (Jon, 2026-08-11). Pinned at the type
    // level: re-adding `maxCad` makes this directive unused and `tsc --noEmit` fails by name.
    // @ts-expect-error — CostFilter carries no price ceiling any more.
    matchesCost(unknown, { free: false, maxCad: 1 } satisfies CostFilter);
  });

  it('ANTI-FIX GUARD (rewritten 2026-08-11): the FREE filter still has teeth', () => {
    // WHAT THIS GUARD USED TO SAY, AND WHY IT NO LONGER SAYS IT.
    // It read "a KNOWN price over the ceiling is still excluded", and it was written to stop
    // someone satisfying the always-include-unknown assertions above by gutting cost filtering
    // into `return true`. Jon removed the max-price ceiling from the product on 2026-08-11
    // ("remove the price ceiling from search, full stop — it can be found on the original
    // source site"), which makes that assertion's premise false: an expensive listing is now
    // SUPPOSED to come back. The guard is rewritten rather than deleted because the trap it was
    // defending against is still open — `matchesCost` returning true unconditionally would
    // still pass everything above.
    //
    // WHAT IT GUARDS INSTEAD: the one exclusion that survives. `free` is a parent naming the
    // kind of thing they want, not a control quietly managing what they may see, so it stays —
    // and if it ever stops excluding a known-paid listing, cost filtering really has been
    // gutted and this line is what says so.
    expect(matchesCost(paid, { free: true })).toBe(false);
    // The honesty distinction the Free filter rests on, restated here so the two cannot drift:
    // unknown is not free, but it is not hidden from a free search either.
    expect(matchesCost(unknown, { free: true })).toBe(true);
    // And with no free constraint, a $40 listing comes back — the removal itself.
    expect(matchesCost(paid, { free: false })).toBe(true);
  });
});

describe('/api/search — a typed price ceiling reaches the engine as nothing (Jon, 2026-08-11)', () => {
  // Asserted at the HTTP boundary for the same reason as everything else in this file: the
  // beta round removed the ceiling's URL path and left the free-text path live, and that
  // asymmetry is what silently emptied weekly emails. A predicate-only test would not have
  // caught it. This one follows the real route, with the phrase a parent actually types.
  const savedBackend = process.env.KIDS_FUN_SEARCH_BACKEND;
  beforeEach(() => {
    delete process.env.KIDS_FUN_SEARCH_BACKEND; // fixture mode: hermetic, no DB
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.KIDS_FUN_SEARCH_BACKEND;
    else process.env.KIDS_FUN_SEARCH_BACKEND = savedBackend;
  });

  it('"aquarium under $20" returns the $40 aquarium, identically to "aquarium"', async () => {
    const plain = await call('q=aquarium&minResults=0&limit=100');
    const typed = await call('q=aquarium+under+%2420&minResults=0&limit=100');
    const ids = (r: { body: Body }) => items(r.body).map((i) => i.listing.id);

    expect(plain.status).toBe(200);
    expect(typed.status).toBe(200);
    // Non-vacuous: the over-ceiling listing is really in the catalogue and really returned.
    expect(ids(plain)).toContain('l-aquarium-van');
    expect(ids(typed)).toContain('l-aquarium-van');
    // Same ids in the same order. Equality (not merely "contains") is what also catches the
    // other way this can go wrong: the stripped words leaking into the term list and changing
    // what matches or how it ranks.
    expect(ids(typed)).toEqual(ids(plain));
  });
});
