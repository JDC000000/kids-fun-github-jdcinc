// tests/search/facets.perf.test.ts — Facet counting has to be cheap enough to run on EVERY
// filter interaction, because that is what a live count-driven rail does. This pins the property
// that makes that true and would be silently lost in a refactor: facets add no I/O and no second
// text match — they are a handful of in-memory filter passes over the candidate set the search
// already built — so their cost grows with the candidate count, not with candidates × values.
//
// That is asserted as a growth RATIO: the SAME operation timed at two catalogue sizes. Which is
// not a stylistic preference, it is the whole reason this file can live in CI. An absolute
// millisecond ceiling standing in for a complexity claim cannot tell "the code went quadratic"
// from "the runner was busy", so it fails on load alone: the previous `toBeLessThan(200)` here
// duly failed at 202.6ms on an oversubscribed 4-core box with the code working perfectly. Timing
// one operation at N and at 4N puts host load into BOTH measurements, where it cancels, and
// leaves a number that means what the test name says. This budget catches an order-of-magnitude
// regression — a per-value repository call, a re-run matcher, an accidental O(n²) — and is not
// there to police milliseconds.
//
// WHY THE SAMPLING IS INTERLEAVED, AND WHY THAT IS THE WHOLE POINT
// A ratio cancels host load only when the two measurements see the SAME load. Timing them in
// disjoint, sequential blocks does not give you that — it only gives it to you for STATIONARY
// interference. Under a burst the blocks are not exchangeable, and there were FOUR of them, not
// two: each half of the ratio is itself a difference (facets-on minus plain), evaluated fully at
// N and only then fully at 4N. A burst landing in one block and not the others does not cancel,
// it divides — inflating a minuend or depressing a subtrahend swings the ratio without bound.
//
// Measured, not argued. 14 rounds on a 4-core box at 1-min load average 9.9–17.9, driven by
// duty-cycled CPU spinners (bursts, not steady load, because steady load is the case that
// already worked):
//   blocked sampling, 9 samples      ratio spread 2.77 – 7.20   (threshold is 8)
//   interleaved,      9 samples      ratio spread 3.04 – 5.72
//   interleaved,     15 samples      ratio spread 3.31 – 4.71
// The blocked estimator reached 90% of the threshold on unmodified code; independently it has
// been observed at 9.825 — RED, and higher than the 8.854 a genuinely quadratic mutation
// produced, which is the worst property a perf assertion can have. Interleaving samples every
// stream inside every window, so a burst lands proportionally in all four and cancels the way
// the ratio always claimed it did. The estimator ALGEBRA below is unchanged; only the schedule
// is. Raising the sample count from 9 to 15 costs ~0.6s of unloaded runtime and was kept
// because it measurably tightened the spread on the same captured data.
//
// A serial lane of its own for this file was considered and rejected: it would remove the other
// test files as a source of bursts but not the host, and the numbers above were taken with the
// interference the acceptance case actually cares about — external, bursty, and unaffected by
// which lane this file runs in. It would also need a third vitest invocation and a third
// workspace project, and would leave tests/vitest-lane-split.test.ts asserting a two-way
// partition that no longer exists. Interleaving fixes the mechanism; a lane only hides one
// source of it.
//
// REMOVED, and please do not re-add it in good faith: a sibling assertion that facets cost "only
// a fraction" of the search they ride along with — `marginal < withoutFacets * 2`, where
// `marginal = withFacets - withoutFacets`. It looked like the same load-cancelling trick. It was
// not one. A ratio cancels host load only when both terms time the SAME operation; that one was a
// DIFFERENCE between two DIFFERENT operations of similar magnitude — a true facet cost of
// ~0.05–0.6ms buried inside a ~1.2–3.3ms search — and differencing similar-sized noisy quantities
// AMPLIFIES jitter rather than cancelling it. Both consequences were then demonstrated by
// execution rather than argued: it had NO TEETH (it passed under a deliberately quadratic facet
// implementation at every strength tried, up to 16x-per-candidate work, at one point measuring a
// marginal cost of MINUS 1.108ms — facet counting apparently costing less than nothing under a
// severe regression), and it was GENUINELY FLAKY (red on unmodified code at load average 7.29;
// eleven baseline ratios spanned -0.14 to 1.86 against its threshold of 2.0, four of them
// negative). A test that cannot fail for the right reason but can fail for the wrong one is
// negative protection, so net coverage went UP when it was deleted. The property it claimed to
// guard is pinned — with teeth — by the growth ratio below, which trips under that same quadratic
// mutation at 8x.

import { describe, it, expect } from 'vitest';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { RegionHierarchy } from '../../lib/geo/region';
import { REGIONS, REGION_IDS } from '../../lib/search/__fixtures__/regions';
import { makeListing, resetSeq } from '../../lib/search/__fixtures__/factory';
import { FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';
import type { AgeBandKey, ListingRecord, StatusState } from '../../lib/search/types';

const MUNICIPALITIES = [REGION_IDS.vancouver, REGION_IDS.northVan, REGION_IDS.westVan, REGION_IDS.burnaby, REGION_IDS.richmond];
const STATUSES: StatusState[] = ['confirmed', 'bookable_open', 'stale', 'seasonal_active', 'full'];
const AGE_BANDS: AgeBandKey[] = ['under2', '2-4', '5-9', '10-14', '15+'];
const CATEGORIES = ['open_gym', 'public_swim', 'skate', 'storytime', 'indoor_play', 'nature'];

/** A deterministic, evenly-spread catalogue — every facet value has real work to count. */
function buildCatalogue(size: number): ListingRecord[] {
  resetSeq();
  // 2026-07-13 16:00Z = 09:00 local. Spread over 4 days (today → this weekend) and 10 hours
  // (09:00–18:00 local) so morning / afternoon / evening all carry results.
  const epoch = Date.UTC(2026, 6, 13, 16, 0, 0);
  const HOUR = 3_600_000;
  return Array.from({ length: size }, (_, i) => {
    const start = new Date(epoch + ((i % 4) * 24 + (i % 10)) * HOUR);
    return makeListing({
      id: `perf-${i}`,
      activityName: `${CATEGORIES[i % CATEGORIES.length]} session ${i}`,
      primaryCategoryKey: CATEGORIES[i % CATEGORIES.length],
      venueName: `Centre ${i % 40}`,
      suitabilityTags: i % 3 === 0 ? ['indoor', 'drop_in'] : ['outdoor'],
      startDatetimeUtc: start.toISOString(),
      endDatetimeUtc: new Date(start.getTime() + HOUR).toISOString(),
      costStatus: i % 5 === 0 ? 'free' : 'known',
      costMinCad: i % 5 === 0 ? null : (i % 12) * 5,
      costMaxCad: i % 5 === 0 ? null : (i % 12) * 5,
      statusState: STATUSES[i % STATUSES.length],
      ageBandMatches: [AGE_BANDS[i % AGE_BANDS.length], AGE_BANDS[(i + 1) % AGE_BANDS.length]],
      geo: { lat: 49.2 + (i % 20) * 0.01, lng: -123.2 + (i % 25) * 0.01 },
      municipalityId: MUNICIPALITIES[i % MUNICIPALITIES.length],
    });
  });
}

function makeEngine(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: false,
  });
}

/**
 * Timed calls per operation. 15 rather than 9: on the same captured samples under bursty load
 * it tightened the ratio spread from 3.04–5.72 to 3.31–4.71, for ~0.6s of unloaded runtime.
 */
const SAMPLES = 15;

/**
 * Median wall-clock of each op, sampled ROUND-ROBIN rather than one op at a time.
 *
 * Every op is timed once per iteration, so all of them span the SAME wall-clock window and a
 * burst of host load lands in all of them proportionally — which is the only condition under
 * which a ratio of these numbers cancels load (see the header). The starting op rotates each
 * iteration so no op is permanently first or permanently behind the heaviest one. Warm-up runs
 * first, per op, to absorb JIT and first-call noise.
 */
function interleavedMedians(runs: number, ops: Array<() => void>): number[] {
  for (const op of ops) for (let i = 0; i < 3; i += 1) op();
  const samples: number[][] = ops.map(() => []);
  for (let i = 0; i < runs; i += 1) {
    for (let k = 0; k < ops.length; k += 1) {
      const j = (i + k) % ops.length;
      const t0 = performance.now();
      ops[j]();
      samples[j].push(performance.now() - t0);
    }
  }
  return samples.map((xs) => xs.sort((a, b) => a - b)[Math.floor(runs / 2)]);
}

describe('facet counting cost', () => {
  it('scales linearly with the candidate count, not with candidates × facet values', () => {
    // N and 4N of the SAME catalogue shape, so the only variable is the candidate count.
    const N = 1_000;
    const small = makeEngine(buildCatalogue(N));
    const large = makeEngine(buildCatalogue(N * 4));
    const req = { q: '', now: FIXTURE_NOW, minResults: 0, includeUnknownCost: true, limit: 60 };

    // All four streams, interleaved. Subtracting the plain search leaves the facet cost alone;
    // the two subtractions are what the ratio is taken over.
    const [facetsAtN, plainAtN, facetsAt4N, plainAt4N] = interleavedMedians(SAMPLES, [
      () => void small.search({ ...req, facets: true }),
      () => void small.search(req),
      () => void large.search({ ...req, facets: true }),
      () => void large.search(req),
    ]);

    // Both floors are divide-by-zero / sign hygiene, NOT load protection: atN measures ~18-38ms
    // here, 360-760x the 0.05 floor, so it has never engaged and cannot defend a denominator
    // that load has merely depressed. Interleaving is what defends that; see the header.
    const atN = Math.max(facetsAtN - plainAtN, 0.05); // floor: never divide by timer noise
    const at4N = Math.max(facetsAt4N - plainAt4N, 0); // floor: a negative numerator is jitter, not a speed-up
    const growth = at4N / atN;

    // Linear predicts 4x. Quadratic in the candidate count predicts 16x. The threshold is the
    // geometric mean of the two — double the headroom over linear, half the margin to quadratic —
    // so it separates the two hypotheses instead of measuring the host. Observed 3.3x-4.7x across
    // 14 rounds at load average 9.9-17.9, with both measurements (18-38ms and 60-100ms) far
    // enough above timer resolution that neither is noise.
    expect(growth).toBeLessThan(8);
  });
});
