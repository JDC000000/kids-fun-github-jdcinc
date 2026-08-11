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
import { matchesCost } from '../../lib/search/filters/cost';
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

  it('admits unknown/check-source under every filter shape, including a price ceiling', () => {
    for (const listing of [unknown, checkSource]) {
      expect(matchesCost(listing, { free: false })).toBe(true);
      expect(matchesCost(listing, { free: true })).toBe(true);
      expect(matchesCost(listing, { free: false, maxCad: 1 })).toBe(true);
      expect(matchesCost(listing, { free: true, maxCad: 1 })).toBe(true);
      expect(matchesCost(listing, { free: false, maxCad: null })).toBe(true);
    }
  });

  it('ANTI-FIX GUARD: a KNOWN price over the ceiling is still excluded', () => {
    // Without this, "always return true" would satisfy every assertion above while deleting
    // cost filtering outright. The ceiling is no longer reachable from the UI, but it is still
    // reachable from a typed "under $20", so it must still work.
    expect(matchesCost(paid, { free: false, maxCad: 20 })).toBe(false);
    expect(matchesCost(paid, { free: false, maxCad: 50 })).toBe(true);
    // And a free-only search still excludes a known-paid listing.
    expect(matchesCost(paid, { free: true })).toBe(false);
  });
});
