// tests/search/empty-state-without-broadening.test.ts
//
// The engine used to fuse two policies into one condition:
//
//     if (run.scored.length < minResults) { explain(); broaden(); }
//
// A caller that declines broadening does so with `minResults: 0` — lib/email/digest.ts,
// because a weekly email must contain only genuine matches. But `0 < 0` is false, so that
// caller also never got the EXPLANATION, and the digest went silent about a saved search
// without ever computing why it was empty. /search, which always broadens, always explained
// itself. Two empty-state policies, nothing asserting which one wins.
//
// These are the guards for the split. Each has a named mutation that reddens it, recorded in
// the unit's report.
import { describe, expect, it } from 'vitest';
import { makeFixtureEngine, FIXTURE_NOW } from '@/lib/search/__fixtures__/engine';

const { engine } = makeFixtureEngine();

/** Fixture queries that genuinely return ZERO primary results, one per constraint kind. */
const ZERO_RESULT_QUERIES: Array<{ q: string; expectBlocking: string }> = [
  { q: 'swim this weekend', expectBlocking: 'date' },
  { q: 'storytime evening', expectBlocking: 'timeOfDay' },
  { q: 'swim free', expectBlocking: 'costFree' },
  { q: 'swim drop-in', expectBlocking: 'dropIn' },
];

describe('engine: explaining an empty result set is independent of broadening', () => {
  it.each(ZERO_RESULT_QUERIES)(
    'names the blocking constraint with minResults 0 (no broadening): $q',
    ({ q, expectBlocking }) => {
      const res = engine.search({ q, now: FIXTURE_NOW, minResults: 0, limit: 100 });

      // The search really is empty, and really did not broaden.
      expect(res.total).toBe(0);
      expect(res.results).toHaveLength(0);
      expect(res.broadening.applied).toHaveLength(0);

      // ...and it now SAYS why. This is the whole defect.
      expect(res.broadening.emptyState).not.toBeNull();
      expect(res.broadening.emptyState?.blockingConstraint).toBe(expectBlocking);
      expect(res.broadening.emptyState?.message).toBeTruthy();
    },
  );

  it('still refuses to pad a minResults-0 search — explanation adds no results', () => {
    for (const { q } of ZERO_RESULT_QUERIES) {
      const res = engine.search({ q, now: FIXTURE_NOW, minResults: 0, limit: 100 });
      expect(res.results).toHaveLength(0);
      expect(res.total).toBe(0);
      expect(res.broadening.applied).toHaveLength(0);
    }
  });

  it('leaves /search alone: minResults 3 still climbs the ladder and still explains', () => {
    const res = engine.search({ q: 'swim this weekend', now: FIXTURE_NOW, minResults: 3, limit: 100 });
    expect(res.broadening.applied.length).toBeGreaterThan(0);
    expect(res.broadening.emptyState?.blockingConstraint).toBe('date');
  });

  it('a search with results is not explained, at either minResults', () => {
    // 'storytime' matches in the fixtures, so there is nothing to explain and the engine
    // must not invent a blocking constraint for a search that is working.
    const res = engine.search({ q: 'storytime', now: FIXTURE_NOW, minResults: 0, limit: 100 });
    expect(res.total).toBeGreaterThan(0);
    expect(res.broadening.emptyState).toBeNull();
    expect(res.broadening.applied).toHaveLength(0);
  });
});
