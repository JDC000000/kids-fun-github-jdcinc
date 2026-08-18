// tests/search/unparsed-query-zerostate.test.ts — a query the parser cannot read returns an
// honest zero-state, not a browse (P0-4).
//
// THE DEFECT. `normalize()` keeps only [a-z0-9], so a query written in any non-Latin script
// reduced to the empty string, `parseQuery` produced `terms: []`, and lib/search/match.ts read
// that as `browseMode` — the same state a bare "show me everything" browse produces. Every
// listing became a candidate and the parent got a limit's worth of unrelated activities
// presented as the results of their search, with `broadening.applied` empty because nothing
// had in fact been widened. The page had no way to know, and said "here are your results".
//
// WHAT THESE TESTS PIN, in both directions — the fix is only worth anything if it fires on
// unreadable input AND stays out of the way of everything else:
//   · unreadable input (non-Latin scripts, punctuation, stop words) → total 0 + an explanation;
//   · a genuine browse (blank q), a chip-composed query with no residual text, an ordinary
//     one-word query, and a partly-readable mixed-script query → all unchanged.
// The "unchanged" half is not decoration: a zero-state that fires on everything is honest and
// useless, so each negative case asserts real results rather than merely "not zero".

import { describe, it, expect } from 'vitest';
import { makeFixtureEngine, FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';
import { parseQuery } from '../../lib/search/parse';
import type { SearchRequest, SearchResponse } from '../../lib/search/engine';

const { engine } = makeFixtureEngine();

/** minResults: 0 — the ladder is not what is under test, and it must not pad any of these. */
function run(req: Partial<SearchRequest> & { q: string }): SearchResponse {
  return engine.search({ now: FIXTURE_NOW, minResults: 0, ...req });
}

/** Every card a response put on the page, across all three sections. */
function cardCount(res: SearchResponse): number {
  return res.results.length + res.ageUnconfirmed.length + res.expected.length;
}

// The whole bug was "an unreadable query returns the catalogue", so every zero assertion below
// is only meaningful against a catalogue that is demonstrably not empty.
const BROWSE_TOTAL = run({ q: '' }).total;

describe('the fixture catalogue is big enough for these assertions to mean something', () => {
  it('a bare browse returns many listings — this is what an unreadable query used to dump', () => {
    expect(BROWSE_TOTAL).toBeGreaterThan(10);
  });
});

describe('parseQuery flags a query it could read nothing of', () => {
  it.each([
    ['Chinese', '游泳课'],
    ['Russian', 'плавание для детей'],
    ['Arabic', 'سباحة'],
    ['Japanese', 'こども プール'],
    ['punctuation only', '!!! ??? ***'],
    ['stop words only', 'the and for me'],
  ])('%s: %s', (_label, q) => {
    const ctx = parseQuery(q, { now: FIXTURE_NOW });
    expect(ctx.terms).toEqual([]);
    expect(ctx.unparsedQuery).toBe(true);
  });

  it.each([
    ['a blank query is a browse, not a failure', ''],
    ['whitespace only is also a browse', '   '],
    ['an ordinary word', 'swim'],
    ['a two-character type-ahead', 'sw'],
    ['pure intent, no residual text (what the filter chips compose)', 'free tomorrow'],
    ['a single age chip phrase', 'toddler'],
    ['recognised-and-discarded price intent', 'under 20'],
    ['partly readable — the English half survives', '游泳 swim'],
  ])('NOT flagged: %s', (_label, q) => {
    expect(parseQuery(q, { now: FIXTURE_NOW }).unparsedQuery).toBe(false);
  });

  it('keeps the readable half of a mixed-script query rather than refusing the whole thing', () => {
    expect(parseQuery('游泳 swim', { now: FIXTURE_NOW }).terms).toEqual(['swim']);
  });
});

describe('SearchEngine returns an honest zero-state for an unreadable query', () => {
  it('a non-English query returns NOTHING instead of the catalogue', () => {
    const res = run({ q: '游泳课' });
    expect(res.total).toBe(0);
    expect(cardCount(res)).toBe(0);
    // The regression itself: this used to equal a browse.
    expect(res.total).not.toBe(BROWSE_TOTAL);
    // The flag travels on the response (as `context`), which is how the page knows this is a
    // "we could not search" zero and not a "we searched and found nothing" zero.
    expect(res.context.unparsedQuery).toBe(true);
  });

  it.each([['плавание для детей'], ['سباحة'], ['!!! ??? ***'], ['the and for me']])(
    'returns nothing for %s',
    (q) => {
      expect(cardCount(run({ q }))).toBe(0);
    },
  );

  it('says WHY, names the text as the blocker, and quotes the query back', () => {
    const res = run({ q: '游泳课' });
    const explanation = res.broadening.emptyState;
    expect(explanation).not.toBeNull();
    expect(explanation?.blockingConstraint).toBe('text');
    expect(explanation?.message).toContain('游泳课');
    expect(explanation?.message).toMatch(/could not read any searchable words/i);
  });

  it('claims no relaxation it did not measure', () => {
    // `explainEmptyState` is deliberately not run here: its only available probe relaxes `text`
    // to `terms: []`, which IS the browse this fix exists to stop, so it would report the whole
    // catalogue as the remedy. An empty list is the honest record of "nothing was probed".
    expect(run({ q: '游泳课' }).broadening.emptyState?.singleRelaxations).toEqual([]);
  });

  it('does not claim to have widened anything, and offers no widening', () => {
    const res = run({ q: '游泳课', minResults: 3 }); // minResults > 0 → the ladder would normally run
    expect(res.broadening.applied).toEqual([]);
    expect(res.broadening.alternatives).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('structured filter chips do not turn it back into a browse', () => {
    // "Everything on today for 2–4s" is still not what a parent asked for when we could not
    // read what they asked for. The chips stay in `context` (the rail keeps rendering them).
    const res = run({ q: '游泳课', when: 'today', ageBands: ['2-4'], free: true });
    expect(cardCount(res)).toBe(0);
    expect(res.context.ageBands).toEqual(['2-4']);
  });

  it('facet counts, when asked for, are real zeros that agree with the total', () => {
    const res = run({ q: '游泳课', facets: true });
    expect(res.facets?.total).toBe(res.total);
    expect(res.facets?.total).toBe(0);
    expect(res.facets?.groups.every((g) => g.values.every((v) => v.count === 0))).toBe(true);
  });

  it('reports the resolved origin honestly — a failed search is not a failed origin', () => {
    const res = run({ q: '游泳课', origin: { mode: 'near_me', coords: { lat: 49.26, lng: -123.07 } } });
    expect(res.origin).not.toBeNull();
    expect(res.originError).toBeNull();
  });
});

describe('the zero-state does not swallow searches that work', () => {
  it('a single common English word still returns real results', () => {
    const res = run({ q: 'swim', minResults: 1 });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.broadening.emptyState?.blockingConstraint).not.toBe('text');
  });

  it('a full query still returns real, relevant results', () => {
    const res = run({ q: 'open gym', minResults: 1 });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].listing.primaryCategoryKey).toBe('open_gym');
  });

  it('a bare browse still returns the catalogue', () => {
    const res = run({ q: '' });
    expect(res.total).toBe(BROWSE_TOTAL);
    expect(res.broadening.emptyState).toBeNull();
  });

  it('a chip-only query (no residual free text) still filters rather than zeroing', () => {
    // What app/search/_lib/params.ts composes into `q` when a parent sets chips and types
    // nothing. Every word is stripped as intent, so `terms` is empty here too — and this is
    // exactly the case the fix must not catch.
    const res = run({ q: 'free' });
    expect(res.total).toBeGreaterThan(0);
    expect(res.context.costFree).toBe(true);
  });

  it('a partly-readable query searches for the part it could read', () => {
    const mixed = run({ q: '游泳 swim', minResults: 1 });
    const english = run({ q: 'swim', minResults: 1 });
    expect(mixed.results.length).toBeGreaterThan(0);
    expect(mixed.results.map((r) => r.listing.id)).toEqual(english.results.map((r) => r.listing.id));
  });

  it('Latin-script gibberish is READ, then matches nothing — a different, already-honest path', () => {
    // "zzzqqx" tokenises fine, so it is not an unparsed query; the matcher simply finds no
    // listing for it. Pinned so the new flag is never widened into "any query with no results".
    const res = run({ q: 'zzzqqx' });
    expect(res.context.unparsedQuery).toBe(false);
    expect(cardCount(res)).toBe(0);
  });
});
