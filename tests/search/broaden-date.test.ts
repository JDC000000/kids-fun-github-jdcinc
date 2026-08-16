// tests/search/broaden-date.test.ts
//
// The `adjacent_date` rung of the broadening ladder used to read:
//
//     if (ctx.date) { cur = { ...cur, date: null };
//                     rungs.push({ key: 'adjacent_date', label: 'Included nearby dates', ... }) }
//
// The LABEL said "nearby dates". The CODE removed the date constraint outright. Because an
// unconstrained query trivially clears `minResults`, the ladder then stopped on that rung —
// so a parent who asked for one sparse day was handed the ENTIRE catalogue, filtered by
// nothing, with no indication their date had been discarded. Measured on production
// 2026-08-16: `?from=2026-09-14&to=2026-09-14` returned total 4070 (the global unfiltered
// count) with `context.date: null`, while the neighbouring `2026-09-13` (dense) and a
// 3.5-month range (wide enough to clear the threshold) both worked correctly. The defect was
// never "the date filter is broken" — it was "the date filter is silently abandoned exactly
// when the answer is thin", which is the case a parent is least able to detect.
//
// These are the guards. Each asserts the property that the old code violated: the ladder may
// WIDEN a date request by a bounded amount, and must never substitute an unfiltered set for it.
import { describe, expect, it } from 'vitest';
import { makeFixtureEngine, FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import { ADJACENT_DATE_DAYS, buildBroadeningLadder, widenDateIntent } from '@/lib/search/broaden';
import { parseQuery } from '@/lib/search/parse';
import { localIsoDate } from '@/lib/search/time/vancouver';
import type { DateIntent, SearchContext } from '@/lib/search/types';

const { engine } = makeFixtureEngine();

/** Fixture catalogue days (America/Vancouver local): 2026-07-13, -14, -15. */
const DENSE_DAY = '2026-07-13';
/** Three days past the last dated fixture — sparse, but within a bounded widen of it. */
const SPARSE_NEARBY_DAY = '2026-07-17';
/** Two months past every dated fixture — no widen of it can reach a dated listing. */
const SPARSE_FAR_DAY = '2026-09-14';

function ctxWithDate(date: DateIntent | null): SearchContext {
  return { ...parseQuery('', { now: FIXTURE_NOW }), date };
}

function range(from: string, to: string): DateIntent {
  return { kind: 'range', isoDate: from, endIsoDate: to, weekday: null };
}

/** The whole visible fixture catalogue — the number an unfiltered search returns. */
const UNFILTERED_TOTAL = engine.search({ q: '', now: FIXTURE_NOW, minResults: 0, limit: 100 }).total;

describe('broaden: the date rung widens, it does not delete', () => {
  it('DECISIVE: the ladder never produces a null date for a dated query', () => {
    const rungs = buildBroadeningLadder(ctxWithDate(range(SPARSE_FAR_DAY, SPARSE_FAR_DAY)));
    expect(rungs.length).toBeGreaterThan(0);
    for (const rung of rungs) {
      expect(rung.context.date, `rung ${rung.key} dropped the date constraint`).not.toBeNull();
      expect(rung.context.date?.isoDate).toBeTruthy();
    }
  });

  it('widens a single day by a BOUNDED window on each side', () => {
    const rung = buildBroadeningLadder(ctxWithDate(range('2026-09-14', '2026-09-14'))).find(
      (r) => r.key === 'adjacent_date',
    );
    expect(rung).toBeDefined();
    expect(rung!.context.date).toEqual(range('2026-09-11', '2026-09-17'));
    // Bounded, not open-ended: 3 days either side of a single day is a 7-day window.
    expect(ADJACENT_DATE_DAYS).toBe(3);
  });

  it('widens a multi-day range around BOTH ends, keeping the requested span inside it', () => {
    expect(widenDateIntent(range('2026-09-14', '2026-12-31'))).toEqual(
      range('2026-09-11', '2027-01-03'),
    );
  });

  it('states the window it applied in its own label — no rung describes a behaviour it lacks', () => {
    const rung = buildBroadeningLadder(ctxWithDate(range('2026-09-14', '2026-09-14'))).find(
      (r) => r.key === 'adjacent_date',
    );
    expect(rung!.label).toContain('2026-09-11');
    expect(rung!.label).toContain('2026-09-17');
  });

  it('offers no date rung when there is nothing to widen around', () => {
    expect(widenDateIntent({ kind: 'explicit', isoDate: null, weekday: null })).toBeNull();
    expect(buildBroadeningLadder(ctxWithDate(null)).some((r) => r.key === 'adjacent_date')).toBe(false);
  });

  it('leaves the other rungs alone (radius / text / chip ladders are out of scope)', () => {
    const ctx = { ...ctxWithDate(range(SPARSE_FAR_DAY, SPARSE_FAR_DAY)), terms: ['swim'], radiusKm: 10, dropIn: true };
    const keys = buildBroadeningLadder(ctx).map((r) => r.key);
    expect(keys).toEqual(['synonym_widen', 'radius_expand', 'adjacent_date', 'drop_chip', 'expected_section']);
    const radius = buildBroadeningLadder(ctx).find((r) => r.key === 'radius_expand')!;
    expect(radius.context.radiusKm).toBe(20);
    expect(buildBroadeningLadder(ctx).find((r) => r.key === 'drop_chip')!.context.dropIn).toBe(false);
  });
});

describe('engine: a thin dated search widens honestly instead of going unfiltered', () => {
  it('DECISIVE: a too-few-results day keeps a bounded date constraint, not the whole catalogue', () => {
    const exact = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 0,
      limit: 100,
      dateRange: { from: SPARSE_NEARBY_DAY, to: SPARSE_NEARBY_DAY },
    });
    // Precondition: this really is the sparse case that trips the ladder.
    expect(exact.total).toBeLessThan(3);

    const broadened = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
      dateRange: { from: SPARSE_NEARBY_DAY, to: SPARSE_NEARBY_DAY },
    });
    expect(broadened.broadening.applied.map((r) => r.key)).toContain('adjacent_date');
    // The date survived, bounded to the requested day ± ADJACENT_DATE_DAYS...
    expect(broadened.context.date).toEqual(range('2026-07-14', '2026-07-20'));
    // ...and the answer is the NEARBY days, not "everything we have".
    expect(broadened.total).toBeGreaterThan(exact.total);
    expect(broadened.total).toBeLessThan(UNFILTERED_TOTAL);
  });

  it('every returned listing is still inside the widened window (or is undated open-hours)', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
      dateRange: { from: SPARSE_NEARBY_DAY, to: SPARSE_NEARBY_DAY },
    });
    for (const item of res.results) {
      if (item.listing.openHours) continue; // available every day; belongs to no single date
      const day = localIsoDate(new Date(item.listing.startDatetimeUtc!));
      expect(day >= '2026-07-14' && day <= '2026-07-20', `${item.listing.id} @ ${day} is outside the widen`).toBe(true);
    }
  });

  it('does not invent results when even the widened window is empty — it stays honest and short', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
      dateRange: { from: SPARSE_FAR_DAY, to: SPARSE_FAR_DAY },
    });
    // The ladder ran out of date rungs and kept climbing rather than silently going unfiltered.
    expect(res.context.date).toEqual(range('2026-09-11', '2026-09-17'));
    expect(res.total).toBeLessThan(UNFILTERED_TOTAL);
    // Regression pin on the exact production symptom: never the global unfiltered count.
    expect(res.total).not.toBe(UNFILTERED_TOTAL);
  });

  it('a dated search with enough results is untouched — no widen, no relabelling', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
      dateRange: { from: DENSE_DAY, to: DENSE_DAY },
    });
    expect(res.broadening.applied).toHaveLength(0);
    expect(res.context.date).toEqual(range(DENSE_DAY, DENSE_DAY));
  });

  it('a wide range with enough results is untouched — the range is the answer, not a hint', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 3,
      limit: 100,
      dateRange: { from: '2026-07-14', to: '2026-12-31' },
    });
    expect(res.broadening.applied).toHaveLength(0);
    expect(res.context.date).toEqual(range('2026-07-14', '2026-12-31'));
  });

  it('a caller that declines broadening still gets exactly the dates it asked for', () => {
    // lib/email/digest.ts is this caller: a weekly email must contain genuine matches only.
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      minResults: 0,
      limit: 100,
      dateRange: { from: SPARSE_FAR_DAY, to: SPARSE_FAR_DAY },
    });
    expect(res.broadening.applied).toHaveLength(0);
    expect(res.context.date).toEqual(range(SPARSE_FAR_DAY, SPARSE_FAR_DAY));
  });
});
