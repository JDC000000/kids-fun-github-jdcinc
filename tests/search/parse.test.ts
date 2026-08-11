// tests/search/parse.test.ts — Query parser (G-T16-1).

import { describe, it, expect } from 'vitest';
import { parseQuery } from '../../lib/search/parse';
import { FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';

describe('parseQuery', () => {
  it('parses "open gym near me saturday morning free" into a structured context (AC G-T16-1)', () => {
    const ctx = parseQuery('open gym near me saturday morning free', { now: FIXTURE_NOW });
    expect(ctx.terms).toEqual(['open', 'gym']);
    expect(ctx.nearMe).toBe(true);
    expect(ctx.timeOfDay).toBe('morning');
    expect(ctx.costFree).toBe(true);
    expect(ctx.date?.kind).toBe('weekday');
    expect(ctx.date?.weekday).toBe(6); // Saturday
  });

  it('extracts radius and age bands, and still STRIPS the now-inert include-unknown phrase', () => {
    const ctx = parseQuery('toddler swim within 20km include unknown', { now: FIXTURE_NOW });
    expect(ctx.radiusKm).toBe(20);
    expect(ctx.ageBands).toEqual(expect.arrayContaining(['under2', '2-4']));
    // "include unknown" no longer sets anything — unknown-cost listings are always included —
    // but it must still be stripped from the text, or a parent typing it would have "include"
    // and "unknown" ranked as if they were the activity they were looking for.
    expect(ctx.terms).toEqual(['swim']);
  });

  it('defaults radius to 10km and best_match sort', () => {
    const ctx = parseQuery('storytime', { now: FIXTURE_NOW });
    expect(ctx.radiusKm).toBe(10);
    expect(ctx.sort).toBe('best_match');
    expect(ctx.timeOfDay).toBeNull();
    expect(ctx.date).toBeNull();
  });

  it('maps "tonight" to today + evening and "rainy day" / "indoor" to the rainy-day chip', () => {
    const ctx = parseQuery('open gym tonight rainy day', { now: FIXTURE_NOW });
    expect(ctx.timeOfDay).toBe('evening');
    expect(ctx.date?.kind).toBe('today');
    expect(ctx.rainyDay).toBe(true);
  });

  it('does not leak intent words into free-text terms', () => {
    const ctx = parseQuery('free indoor bookable now skate today afternoon', { now: FIXTURE_NOW });
    expect(ctx.terms).toEqual(['skate']);
    expect(ctx.costFree).toBe(true);
    expect(ctx.rainyDay).toBe(true);
    expect(ctx.bookableNow).toBe(true);
    expect(ctx.timeOfDay).toBe('afternoon');
    expect(ctx.date?.kind).toBe('today');
  });

  it('STILL STRIPS an "under $N" price phrase, while producing no ceiling (Jon, 2026-08-11)', () => {
    // The price ceiling is gone from the product. What must NOT go with it is the STRIP, and
    // this test exists to hold that line. The phrase is cost INTENT, not content; the matcher
    // ORs user terms (lib/search/match.ts), so leaving "under" and "20" in the term list would
    // start pulling coincidental relevance out of descriptions — widening results and degrading
    // ranking. Deleting the parser is therefore a regression, not a simplification. The parse
    // survives so the words can be removed; only the VALUE is thrown away.
    expect(parseQuery('swim under $20', { now: FIXTURE_NOW }).terms).toEqual(['swim']);
    expect(parseQuery('up to 50 gym', { now: FIXTURE_NOW }).terms).toEqual(['gym']);
    expect(parseQuery('below 30 skate', { now: FIXTURE_NOW }).terms).toEqual(['skate']);
    // And the number reaches the context as no constraint of any kind. Asserted on the KEY SET
    // rather than as `ctx.costMaxCad === null`, because the field is gone from SearchContext: a
    // property read that no longer type-checks would have been deleted to make the file
    // compile, taking the guard with it. (Not asserted by serialising the context and looking
    // for "20" either — `ctx.raw` echoes the query verbatim, so that can never pass.)
    expect(Object.keys(parseQuery('swim under $20', { now: FIXTURE_NOW }))).not.toContain('costMaxCad');
    // The phrase must also leave the rest of the parse alone — it is discarded, not reinterpreted.
    // `raw` is excluded because it echoes the query verbatim by design; everything the engine
    // actually filters or ranks on must be identical to the query with the phrase never typed.
    const { raw: _typedRaw, ...typed } = parseQuery('swim under $20', { now: FIXTURE_NOW });
    const { raw: _plainRaw, ...plain } = parseQuery('swim', { now: FIXTURE_NOW });
    expect(typed).toEqual(plain);
  });

  it('the "under 2" AGE phrase is NOT swallowed by the price-phrase strip (single digit)', () => {
    // The 2+ digit requirement outlived the ceiling it was written for, and still has to: a
    // greedier strip would eat the age band instead.
    const ctx = parseQuery('under 2 swim', { now: FIXTURE_NOW });
    expect(ctx.ageBands).toEqual(['under2']);
    expect(ctx.terms).toEqual(['swim']);
  });

  it('parses the "drop-in" chip phrase into dropIn and strips it (G-T21-3)', () => {
    const ctx = parseQuery('drop-in gym', { now: FIXTURE_NOW });
    expect(ctx.dropIn).toBe(true);
    expect(ctx.terms).toEqual(['gym']);
    expect(parseQuery('drop in skate', { now: FIXTURE_NOW }).dropIn).toBe(true);
  });
});
