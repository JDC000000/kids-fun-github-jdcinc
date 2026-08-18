// tests/search/engine.test.ts — End-to-end search assembly (G-T16-7, FR-02/09/10).

import { describe, it, expect } from 'vitest';
import { makeFixtureEngine, FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';

const eastVan = { lat: 49.26, lng: -123.07 };

describe('SearchEngine.search (FR-02)', () => {
  const { engine } = makeFixtureEngine();

  it('"open gym near me" returns open-gym listings ranked before unrelated ones', () => {
    const res = engine.search({ q: 'open gym near me', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, minResults: 1 });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].listing.primaryCategoryKey).toBe('open_gym');
    // no unrelated categories, and cancelled/hidden never surfaced
    expect(res.results.every((r) => r.listing.primaryCategoryKey === 'open_gym')).toBe(true);
    expect(res.results.some((r) => r.listing.id === 'l-cancelled-gym')).toBe(false);
    expect(res.meta.fixtureBacked).toBe(true);
  });

  it('confirmed/bookable outranks an otherwise-equal stale listing end-to-end (FR-02 + §5A.3)', () => {
    const res = engine.search({ q: 'open gym', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, minResults: 1 });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids.indexOf('l-rank-confirmed')).toBeLessThan(ids.indexOf('l-rank-stale'));
  });

  it('honours the time-of-day filter at the API layer, not just chips (FR-09)', () => {
    const res = engine.search({ q: 'open gym morning', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, minResults: 1 });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids).toContain('l-opengym-van'); // 10:00 local
    expect(ids).not.toContain('l-gymplay-nvan'); // 14:00 local (afternoon)
  });

  it('honours the cost filter — free excludes unknown unless include-unknown is set (FR-10)', () => {
    const free = engine.search({ q: 'storytime free', now: FIXTURE_NOW, minResults: 1 });
    const freeIds = free.results.map((r) => r.listing.id);
    expect(freeIds).toContain('l-storytime-van'); // genuinely free
    // An unknown-cost listing is still not CLASSIFIED as free, but it is no longer HIDDEN:
    // there is no include-unknown flag to set any more (lib/search/filters/cost.ts).
    expect(freeIds).toContain('l-storytime-unknown');
  });

  it('NO max-price ceiling end-to-end — a typed "under $N" no longer drops pricier listings (Jon, 2026-08-11)', () => {
    // The inverse of the test it replaces. Jon removed the price ceiling from search outright
    // ("it can be found on the original source site"), so the phrase must now change the
    // result set in NO way at all. minResults:0 disables the broadening ladder, so what is
    // compared is the raw filtered set — otherwise "drop the most restrictive chip" could
    // re-add an excluded listing and make a live ceiling look removed.
    const base = engine.search({ q: 'aquarium', now: FIXTURE_NOW, minResults: 0 });
    const typed = engine.search({ q: 'aquarium under $20', now: FIXTURE_NOW, minResults: 0 });
    const ids = (r: typeof base) => r.results.map((x) => x.listing.id);

    // Non-vacuous first: the $40 listing is in the catalogue and is genuinely over the old $20.
    expect(ids(base)).toContain('l-aquarium-van');
    expect(ids(typed)).toContain('l-aquarium-van');
    // Identical, in the same order — the phrase is stripped from the text and then discarded,
    // so it can neither filter (a ceiling) nor rank (residual terms leaking into matching).
    expect(ids(typed)).toEqual(ids(base));
  });

  it('honours a custom date range end-to-end — only in-range days survive, open-hours always (T26/FR-04)', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      dateRange: { from: '2026-07-13', to: '2026-07-14' },
      minResults: 0,
      limit: 100,
    });
    expect(res.context.date).toMatchObject({ kind: 'range', isoDate: '2026-07-13', endIsoDate: '2026-07-14' });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids).toContain('l-opengym-van'); // 2026-07-13 local → inside range
    expect(ids).toContain('l-familydropin-bby'); // 2026-07-14 local → inside range
    expect(ids).not.toContain('l-skate-rmd'); // 2026-07-15 local → outside range
    expect(ids).toContain('l-aquarium-van'); // open-hours → available every day, always in range
  });

  it('canonicalises a reversed date range (from>to) before filtering (T26)', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      dateRange: { from: '2026-07-14', to: '2026-07-13' },
      minResults: 0,
      limit: 100,
    });
    expect(res.context.date).toMatchObject({ kind: 'range', isoDate: '2026-07-13', endIsoDate: '2026-07-14' });
  });

  it('ignores a malformed date range (no date constraint applied) (T26)', () => {
    const res = engine.search({ q: '', now: FIXTURE_NOW, dateRange: { from: 'not-a-date', to: '2026-07-14' }, minResults: 0, limit: 100 });
    expect(res.context.date).toBeNull();
  });

  it('honours the drop-in chip end-to-end — only drop_in-tagged listings survive (G-T21-3)', () => {
    const res = engine.search({ q: 'open gym drop-in', now: FIXTURE_NOW, minResults: 0 });
    expect(res.results.length).toBeGreaterThan(0);
    expect(
      res.results.every((r) => [...r.listing.suitabilityTags, ...r.listing.categoryTags].includes('drop_in')),
    ).toBe(true);
    expect(res.results.map((r) => r.listing.id)).not.toContain('l-rank-confirmed'); // open_gym but not drop_in
  });

  it('applies the distance sort control over the same filtered set', () => {
    const res = engine.search({
      q: 'open gym', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, sort: 'distance', minResults: 1,
    });
    const distances = res.results.map((r) => r.distanceKm ?? Infinity);
    const sorted = [...distances].sort((a, b) => a - b);
    expect(distances).toEqual(sorted);
  });
});

// Stage 2a (roadmap initiative 2, first half) — typed filter-chip params, applied as
// post-parse overrides on ctx0 exactly like the dateRange override this pattern is copied
// from (see lib/search/engine.ts's `search()` header comment on the override block). Every
// test here is mutation-style, not just green-path: each pairs a TEXT phrase the parser would
// resolve on its own with a CONFLICTING structured override, and asserts the override's
// answer — deleting the override (or flipping its precedence against dateRange) would flip
// these assertions, not just leave them green.
describe('Stage 2a — typed filter-chip params override parseQuery() (roadmap initiative 2)', () => {
  const { engine } = makeFixtureEngine();

  it('ageBands override replaces (not merges with) a conflicting text age phrase', () => {
    // Text alone: "kids" resolves to the 5-9 band only.
    const textOnly = engine.search({ q: 'open gym kids', now: FIXTURE_NOW, minResults: 0 });
    expect(textOnly.context.ageBands).toEqual(['5-9']);
    expect(textOnly.results.map((r) => r.listing.id)).not.toContain('l-familydropin-bby'); // under2/2-4 only

    // Structured override wins: under2, not 5-9.
    const overridden = engine.search({ q: 'open gym kids', now: FIXTURE_NOW, minResults: 0, ageBands: ['under2'] });
    expect(overridden.context.ageBands).toEqual(['under2']);
    expect(overridden.results.map((r) => r.listing.id)).toContain('l-familydropin-bby');
    expect(overridden.results.map((r) => r.listing.id)).not.toContain('l-rank-confirmed'); // 5-9 only, no under2

    // Neither text nor override → no age constraint (proves the fallback path still works).
    const neither = engine.search({ q: 'open gym', now: FIXTURE_NOW, minResults: 0 });
    expect(neither.context.ageBands).toEqual([]);
  });

  it('`when` override replaces a conflicting text date, and `dateRange` still wins over `when` (server-side precedence)', () => {
    // Text alone: "tomorrow" → 2026-07-14.
    const textOnly = engine.search({ q: 'open gym tomorrow', now: FIXTURE_NOW, minResults: 0 });
    expect(textOnly.context.date?.kind).toBe('tomorrow');
    expect(textOnly.results.map((r) => r.listing.id)).toContain('l-familydropin-bby'); // 2026-07-14
    expect(textOnly.results.map((r) => r.listing.id)).not.toContain('l-opengym-van'); // 2026-07-13

    // Structured override wins: 'today' beats the text "tomorrow".
    const overridden = engine.search({ q: 'open gym tomorrow', now: FIXTURE_NOW, minResults: 0, when: 'today' });
    expect(overridden.context.date?.kind).toBe('today');
    expect(overridden.results.map((r) => r.listing.id)).toContain('l-opengym-van');
    expect(overridden.results.map((r) => r.listing.id)).not.toContain('l-familydropin-bby');

    // `when: 'any'` is a no-op override — the text-parsed date survives untouched.
    const anyWhen = engine.search({ q: 'open gym tomorrow', now: FIXTURE_NOW, minResults: 0, when: 'any' });
    expect(anyWhen.context.date?.kind).toBe('tomorrow');

    // A structured dateRange still wins over a conflicting `when` — mirrors
    // app/search/_lib/params.ts's `when = dateFrom/dateTo set ? 'any' : whenPick`, server-side.
    // If the `when` override ran AFTER (instead of before) the dateRange block, this would flip:
    // l-opengym-van would appear and l-familydropin-bby would not.
    const rangeWins = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 0,
      limit: 100,
      when: 'today',
      dateRange: { from: '2026-07-14', to: '2026-07-14' },
    });
    expect(rangeWins.context.date).toMatchObject({ kind: 'range', isoDate: '2026-07-14', endIsoDate: '2026-07-14' });
    expect(rangeWins.results.map((r) => r.listing.id)).toContain('l-familydropin-bby');
    expect(rangeWins.results.map((r) => r.listing.id)).not.toContain('l-opengym-van');
  });

  it('timeOfDay override replaces a conflicting text day-part; "any" is a no-op', () => {
    const textOnly = engine.search({ q: 'open gym morning', now: FIXTURE_NOW, minResults: 0 });
    expect(textOnly.results.map((r) => r.listing.id)).toContain('l-opengym-van'); // 10:00 local
    expect(textOnly.results.map((r) => r.listing.id)).not.toContain('l-gymplay-nvan'); // 14:00 local

    const overridden = engine.search({ q: 'open gym morning', now: FIXTURE_NOW, minResults: 0, timeOfDay: 'afternoon' });
    expect(overridden.results.map((r) => r.listing.id)).toContain('l-gymplay-nvan');
    expect(overridden.results.map((r) => r.listing.id)).not.toContain('l-opengym-van');

    const anyTime = engine.search({ q: 'open gym morning', now: FIXTURE_NOW, minResults: 0, timeOfDay: 'any' });
    expect(anyTime.results.map((r) => r.listing.id)).toContain('l-opengym-van');
  });

  it('bookableNow override replaces a conflicting text state in BOTH directions (force on, force off)', () => {
    const baseline = engine.search({ q: 'open gym', now: FIXTURE_NOW, minResults: 0 });
    expect(baseline.results.map((r) => r.listing.id)).toContain('l-opengym-stale'); // stale, not bookable_open

    const forcedOn = engine.search({ q: 'open gym', now: FIXTURE_NOW, minResults: 0, bookableNow: true });
    expect(forcedOn.results.map((r) => r.listing.id)).not.toContain('l-opengym-stale');
    expect(forcedOn.results.map((r) => r.listing.id)).toContain('l-opengym-van'); // bookable_open

    // Structured false beats a conflicting "bookable now" TEXT phrase.
    const forcedOff = engine.search({ q: 'open gym bookable now', now: FIXTURE_NOW, minResults: 0, bookableNow: false });
    expect(forcedOff.results.map((r) => r.listing.id)).toContain('l-opengym-stale');
  });

  it('rainyDay override excludes an outdoor listing the text phrase never touched', () => {
    const baseline = engine.search({ q: 'train', now: FIXTURE_NOW, minResults: 0 });
    expect(baseline.results.map((r) => r.listing.id)).toContain('l-minitrain-van'); // outdoor

    const overridden = engine.search({ q: 'train', now: FIXTURE_NOW, minResults: 0, rainyDay: true });
    expect(overridden.results.map((r) => r.listing.id)).not.toContain('l-minitrain-van');
  });

  it('dropIn override narrows results a bare text query never restricted', () => {
    const baseline = engine.search({ q: 'open gym', now: FIXTURE_NOW, minResults: 0 });
    expect(baseline.results.map((r) => r.listing.id)).toContain('l-rank-confirmed'); // open_gym, not drop-in

    const overridden = engine.search({ q: 'open gym', now: FIXTURE_NOW, minResults: 0, dropIn: true });
    expect(overridden.results.map((r) => r.listing.id)).not.toContain('l-rank-confirmed');
    expect(overridden.results.map((r) => r.listing.id)).toContain('l-opengym-van');
  });

  it('free override (→ ctx.costFree) replaces a conflicting text state in BOTH directions', () => {
    const baseline = engine.search({ q: 'open gym', now: FIXTURE_NOW, minResults: 0 });
    expect(baseline.results.map((r) => r.listing.id)).toContain('l-gymplay-nvan'); // known $5, not free

    const forcedOn = engine.search({ q: 'open gym', now: FIXTURE_NOW, minResults: 0, free: true });
    expect(forcedOn.results.map((r) => r.listing.id)).not.toContain('l-gymplay-nvan');
    expect(forcedOn.results.map((r) => r.listing.id)).toContain('l-opengym-van'); // genuinely free

    // Structured false beats a conflicting "free" TEXT phrase.
    const forcedOff = engine.search({ q: 'open gym free', now: FIXTURE_NOW, minResults: 0, free: false });
    expect(forcedOff.results.map((r) => r.listing.id)).toContain('l-gymplay-nvan');
  });

  it('radiusKm override replaces a conflicting text radius phrase', () => {
    const textOnly = engine.search({
      q: 'skate within 5km', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, minResults: 0,
    });
    expect(textOnly.context.radiusKm).toBe(5);
    expect(textOnly.results.map((r) => r.listing.id)).not.toContain('l-skate-rmd'); // ~11km from eastVan

    const overridden = engine.search({
      q: 'skate within 5km', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, minResults: 0, radiusKm: 20,
    });
    expect(overridden.context.radiusKm).toBe(20);
    expect(overridden.results.map((r) => r.listing.id)).toContain('l-skate-rmd');
  });
});
