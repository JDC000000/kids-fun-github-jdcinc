// tests/search/broaden-ladder.test.ts
//
// THE DEFECT, which ran through most of the broadening ladder rather than one rung of it:
// several rungs "relaxed" a constraint by DELETING it, under labels that promised a widen.
//
//     if (ctx.date)      { cur = { ...cur, date: null };      label: 'Included nearby dates' }
//     if (ctx.timeOfDay) { cur = { ...cur, timeOfDay: null }; label: 'Included other times of day' }
//     drop_chip          → relaxSingle(ageBands) === { ageBands: [] }
//
// An unconstrained query trivially clears `minResults`, so the ladder stopped on the first
// such rung having discarded the parent's request. A parent who asked for one sparse day was
// handed the ENTIRE catalogue with no indication their date had gone. Measured on production
// 2026-08-16: `?from=2026-09-14&to=2026-09-14` returned total 4070 (the global unfiltered
// count) with `context.date: null`, while the neighbouring `2026-09-13` (dense) and a
// 3.5-month range (wide enough to clear the threshold) both answered correctly. The defect was
// never "the date filter is broken" — it was "the constraint is silently abandoned exactly
// when the answer is thin", which is the case a parent is least able to detect.
//
// These are the guards. Every one asserts the property the old code violated: a graded
// constraint (date, time of day, age) may be WIDENED by a bounded amount and must never be
// deleted; the boolean chips may still be dropped, but must say which one.
import { describe, expect, it } from 'vitest';
import { makeFixtureEngine, FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';
import { ADJACENT_DATE_DAYS, buildBroadeningLadder, widenDateIntent } from '@/lib/search/broaden';
import { ADJACENT_DAY_PARTS, matchesTimeOfDay } from '@/lib/search/filters/time';
import { adjacentAgeBands } from '@/lib/search/filters/age';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { parseQuery } from '@/lib/search/parse';
import { localIsoDate } from '@/lib/search/time/vancouver';
import type { DateIntent, ListingRecord, SearchContext } from '@/lib/search/types';

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

  it('keeps the radius ladder exactly as designed (a real bounded widen, 10→20km)', () => {
    const ctx = { ...ctxWithDate(range(SPARSE_FAR_DAY, SPARSE_FAR_DAY)), terms: ['swim'], radiusKm: 10, dropIn: true };
    const keys = buildBroadeningLadder(ctx).map((r) => r.key);
    expect(keys).toEqual(['synonym_widen', 'radius_expand', 'adjacent_date', 'drop_chip', 'expected_section']);
    expect(buildBroadeningLadder(ctx).find((r) => r.key === 'radius_expand')!.context.radiusKm).toBe(20);
    expect(buildBroadeningLadder(ctx).find((r) => r.key === 'drop_chip')!.context.dropIn).toBe(false);
  });

  it('does not offer a radius rung when there is no origin to measure from', () => {
    // With no origin no radius filter runs at all, so the rung cannot change a result — but it
    // WOULD still have reported "Expanded distance to 20km" to anyone reading the applied rungs.
    const ctx = { ...ctxWithDate(range(SPARSE_FAR_DAY, SPARSE_FAR_DAY)), radiusKm: 10 };
    expect(buildBroadeningLadder(ctx, { hasOrigin: false }).map((r) => r.key)).not.toContain('radius_expand');
    expect(buildBroadeningLadder(ctx, { hasOrigin: true }).map((r) => r.key)).toContain('radius_expand');
  });
});

describe('broaden: the time-of-day rung widens to ADJACENT bands, it does not delete', () => {
  it('DECISIVE: the ladder never produces a null timeOfDay', () => {
    for (const part of ['morning', 'afternoon', 'evening'] as const) {
      const rungs = buildBroadeningLadder({ ...ctxWithDate(null), timeOfDay: part });
      for (const rung of rungs) {
        expect(rung.context.timeOfDay, `rung ${rung.key} dropped the time constraint`).toBe(part);
      }
      expect(rungs.find((r) => r.key === 'adjacent_time')!.context.timeOfDayAdjacent).toBe(true);
    }
  });

  it('morning reaches the afternoon and NEVER the evening — that is not an adjacent time', () => {
    expect(ADJACENT_DAY_PARTS.morning).toEqual(['morning', 'afternoon']);
    expect(ADJACENT_DAY_PARTS.evening).toEqual(['afternoon', 'evening']);
    expect(ADJACENT_DAY_PARTS.afternoon).toEqual(['morning', 'afternoon', 'evening']);
  });

  it('the widened predicate accepts the neighbouring band but still refuses the far one', () => {
    // America/Vancouver is UTC−7 in July; 19:00 local lands on the following UTC day.
    const at = (utc: string): ListingRecord => makeListing({ startDatetimeUtc: utc });
    const morningClass = at('2026-07-13T16:00:00Z'); // 09:00 local
    const afternoonClass = at('2026-07-13T21:00:00Z'); // 14:00 local
    const eveningClass = at('2026-07-14T02:00:00Z'); // 19:00 local

    // Exact: morning only.
    expect(matchesTimeOfDay(afternoonClass, 'morning')).toBe(false);
    // Widened: the neighbour is in...
    expect(matchesTimeOfDay(afternoonClass, 'morning', { includeAdjacent: true })).toBe(true);
    expect(matchesTimeOfDay(morningClass, 'morning', { includeAdjacent: true })).toBe(true);
    // ...and the far band is still out. A full drop would have let this through.
    expect(matchesTimeOfDay(eveningClass, 'morning', { includeAdjacent: true })).toBe(false);
  });
});

describe('broaden: age is widened to neighbouring bands, never emptied', () => {
  it('DECISIVE: the ladder never empties an age selection', () => {
    const rungs = buildBroadeningLadder({ ...ctxWithDate(null), ageBands: ['under2'] });
    for (const rung of rungs) {
      expect(rung.context.ageBands.length, `rung ${rung.key} emptied the age filter`).toBeGreaterThan(0);
    }
  });

  it('an under-2 search reaches 2–4 and NEVER teen programming', () => {
    expect(adjacentAgeBands(['under2'])).toEqual(['under2', '2-4']);
    expect(adjacentAgeBands(['under2'])).not.toContain('15+');
    expect(adjacentAgeBands(['5-9'])).toEqual(['2-4', '5-9', '10-14']);
    expect(adjacentAgeBands(['15+'])).toEqual(['10-14', '15+']);
  });

  it('a multi-band selection widens to the union of its neighbours, in band order', () => {
    expect(adjacentAgeBands(['under2', '10-14'])).toEqual(['under2', '2-4', '5-9', '10-14', '15+']);
  });

  it('leaves an unset age filter alone — there is nothing to widen', () => {
    expect(adjacentAgeBands([])).toEqual([]);
    expect(buildBroadeningLadder(ctxWithDate(null)).some((r) => r.key === 'adjacent_age')).toBe(false);
  });

  it('age is no longer droppable by the chip rung — it has its own bounded rung instead', () => {
    const ctx = { ...ctxWithDate(null), ageBands: ['under2' as const], dropIn: true };
    const rungs = buildBroadeningLadder(ctx);
    // The chip rung fires (Drop-in is a boolean and a drop is its only relaxation)...
    const chip = rungs.find((r) => r.key === 'drop_chip')!;
    expect(chip.constraint).toBe('dropIn');
    expect(chip.context.dropIn).toBe(false);
    // ...and it took the boolean, not the age scale.
    expect(chip.context.ageBands).toEqual(['under2', '2-4']);
  });
});

describe('broaden: the chip rung still drops, but names what it dropped', () => {
  it.each(['bookableNow', 'dropIn', 'rainyDay'] as const)(
    'carries the constraint key so a notice cannot misname it: %s',
    (chipKey) => {
      const rung = buildBroadeningLadder({ ...ctxWithDate(null), [chipKey]: true }).find((r) => r.key === 'drop_chip');
      expect(rung).toBeDefined();
      expect(rung!.constraint).toBe(chipKey);
      expect(rung!.context[chipKey]).toBe(false);
    },
  );

  it('DECISIVE: costFree is NOT in the rung — the ladder may not bill a parent who asked for free', () => {
    // Deliberately changed from the earlier revision of this file, which asserted costFree WAS
    // droppable. See tests/search/broaden-never-drops-free.test.ts for the production case
    // ($21.25 hockey returned under `?q=free&region=bby`) that made that the wrong behaviour.
    const rungs = buildBroadeningLadder({ ...ctxWithDate(null), costFree: true });
    expect(rungs.some((r) => r.key === 'drop_chip')).toBe(false);
    for (const rung of rungs) {
      expect(rung.context.costFree, `rung ${rung.key} dropped the Free filter`).toBe(true);
    }
  });

  it('drops only the ONE most-restrictive chip, leaving Free untouched beside it', () => {
    const rungs = buildBroadeningLadder({ ...ctxWithDate(null), bookableNow: true, dropIn: true, costFree: true });
    const chip = rungs.find((r) => r.key === 'drop_chip')!;
    expect(chip.constraint).toBe('bookableNow');
    expect(chip.context.dropIn).toBe(true); // only one chip per rung, as before
    expect(chip.context.costFree).toBe(true); // and never this one
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
