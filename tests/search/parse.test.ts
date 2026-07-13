import { describe, it, expect } from 'vitest';
import { parseQuery } from '../../lib/search/parse';

// G-T16-1 — query parser (TSD §5A.2).
describe('parseQuery (G-T16-1)', () => {
  it('parses "open gym near me saturday morning free" into a structured context', () => {
    const ctx = parseQuery('open gym near me saturday morning free');
    expect(ctx.nearMe).toBe(true);
    expect(ctx.timeOfDay).toBe('morning');
    expect(ctx.costIntent).toBe('free');
    expect(ctx.freeText).toContain('open gym');
    expect(ctx.freeText).toContain('saturday');
    expect(ctx.freeText).not.toContain('near me');
    expect(ctx.freeText).not.toContain('free');
  });

  it('extracts a radius in km', () => {
    const ctx = parseQuery('storytime within 5km');
    expect(ctx.radiusKm).toBe(5);
  });

  it('extracts date intent (today/tomorrow/weekend)', () => {
    expect(parseQuery('skate today').dateIntent).toBe('today');
    expect(parseQuery('swim tomorrow').dateIntent).toBe('tomorrow');
    expect(parseQuery('festival this weekend').dateIntent).toBe('this_weekend');
  });

  it('extracts free-text age hints', () => {
    const ctx = parseQuery('toddler storytime for a 3 year old');
    expect(ctx.ageHints).toContain('toddler');
    expect(ctx.ageHints.some((h) => h.includes('3'))).toBe(true);
  });

  it('is idempotent on already-lowercase input and trims whitespace', () => {
    const ctx = parseQuery('  open   gym  ');
    expect(ctx.freeText).toBe('open gym');
  });
});
