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

  it('extracts radius, age bands and include-unknown flag', () => {
    const ctx = parseQuery('toddler swim within 20km include unknown', { now: FIXTURE_NOW });
    expect(ctx.radiusKm).toBe(20);
    expect(ctx.ageBands).toEqual(expect.arrayContaining(['under2', '2-4']));
    expect(ctx.includeUnknownCost).toBe(true);
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

  it('parses an "under $N" max-price ceiling into costMaxCad and strips it (G-T21-4)', () => {
    const ctx = parseQuery('swim under $20', { now: FIXTURE_NOW });
    expect(ctx.costMaxCad).toBe(20);
    expect(ctx.terms).toEqual(['swim']); // ceiling phrase stripped, not leaked to text
    expect(parseQuery('up to 50 gym', { now: FIXTURE_NOW }).costMaxCad).toBe(50);
  });

  it('the "under 2" AGE phrase is NOT swallowed by the cost ceiling (single digit)', () => {
    const ctx = parseQuery('under 2 swim', { now: FIXTURE_NOW });
    expect(ctx.costMaxCad).toBeNull(); // requires 2+ digits, so "under 2" stays an age band
    expect(ctx.ageBands).toEqual(['under2']);
  });

  it('parses the "drop-in" chip phrase into dropIn and strips it (G-T21-3)', () => {
    const ctx = parseQuery('drop-in gym', { now: FIXTURE_NOW });
    expect(ctx.dropIn).toBe(true);
    expect(ctx.terms).toEqual(['gym']);
    expect(parseQuery('drop in skate', { now: FIXTURE_NOW }).dropIn).toBe(true);
  });
});
