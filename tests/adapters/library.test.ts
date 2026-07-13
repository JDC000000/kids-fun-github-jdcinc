import { describe, it, expect } from 'vitest';
import { loadLibraryAdapters, LIBRARY_SYSTEMS } from '../../worker/adapters/library';

// G-T9-1/2 — Library adapter scaffold (TSD §5.1 Adapter B).
describe('Library adapter scaffold (G-T9-1/2)', () => {
  it('covers >=2 library systems across both platforms', () => {
    expect(LIBRARY_SYSTEMS.length).toBeGreaterThanOrEqual(2);
    const platforms = new Set(LIBRARY_SYSTEMS.map((s) => s.platform));
    expect(platforms.has('bibliocommons')).toBe(true);
    expect(platforms.has('communico')).toBe(true);
    expect(loadLibraryAdapters().every((a) => a.family === 'library')).toBe(true);
  });

  it('parses BiblioCommons + Communico storytime with branch + age + exact date', async () => {
    // All systems' records across the launch library adapters.
    const all = (
      await Promise.all(loadLibraryAdapters().map(async (a) => a.extract(await a.fetch())))
    ).flat();
    expect(all.every((r) => r.categoryHint === 'storytime')).toBe(true);

    const baby = all.find((r) => r.title === 'Baby Storytime')!; // BiblioCommons
    expect(baby.venueName).toContain('Central'); // branch/location provenance
    expect(baby.ageText).toBe('0-2 years');
    expect(baby.startDatetimeUtc).toBe('2026-07-15T17:30:00.000Z');
    expect(baby.costStatus).toBe('free');

    const toddler = all.find((r) => r.title === 'Toddler Storytime')!; // Communico
    expect(toddler.ageText).toBe('Ages 2-5');
    expect(toddler.venueName).toContain('City Centre');
  });
});
