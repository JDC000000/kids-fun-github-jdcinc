// tests/search/facets.perf.test.ts — Facet counting has to be cheap enough to run on EVERY
// filter interaction, because that is what a live count-driven rail does. This file pins ONE
// narrow property of that: the SHAPE of the cost curve. Facet counting is a handful of
// in-memory filter passes over the candidate set the search already built, so its cost should
// grow with the candidate count and NOT with candidates × facet values. That is all this file
// asserts. Read "WHAT THIS DOES NOT CATCH" before crediting it with more.
//
// HOW IT IS ASSERTED
// As a growth RATIO — the same operation timed at N and at 4N — rather than as a stopwatch
// ceiling. That is not a stylistic preference. An absolute millisecond budget standing in for a
// complexity claim cannot tell "the code went quadratic" from "the runner was busy", and fails
// on load alone: the `toBeLessThan(200)` this file used to carry duly failed at 202.6ms on an
// oversubscribed 4-core box with the code working perfectly. Linear predicts 4x; quadratic in
// the candidate count predicts 16x; the threshold of 8 is the geometric mean of the two, so it
// separates the two hypotheses instead of measuring the host.
//
// WHAT THIS DOES NOT CATCH — established by mutation, not by argument
// A growth ratio is blind to any cost that is CONSTANT or LINEAR in n, because such a cost
// scales identically in both windows and divides out. Both blind spots were demonstrated
// against this exact assertion by running it:
//   • a LINEAR mutation (600 units of extra work per candidate) PASSED GREEN while
//     QUADRUPLING this file's runtime;
//   • a CONSTANT per-facet-value mutation — which is the shape of a per-value repository call —
//     PASSED GREEN and LOWERED the ratio. That regression makes this test MORE green, not less.
// So this file does NOT pin "facets add no I/O and no second text match", and does not pin the
// absolute magnitude of the facet cost either. Earlier versions of this header claimed it did;
// they were wrong, and the claim was wrong in the specific direction that matters — the FIRST
// regression it named, a per-value repository call, is one the test actively rewards.
//
// Those gaps are known debt, deliberately deferred rather than overlooked. Closing them means
// adding NEW wall-clock assertions, and this suite's wall-clock methodology is what has
// repeatedly minted flakes here (three separate times now: the 200ms ceiling, the deleted
// marginal-cost sibling, and the blocked sampling replaced below). Fix the measurement first,
// add coverage second. Outstanding: facet cost magnitude, "no I/O", "no second text match", and
// a real text query at ~500 listings (today's page size).
//
// WHY THE SAMPLING IS INTERLEAVED, AND WHY THAT IS THE WHOLE POINT
// A ratio cancels host load only when the two measurements see the SAME load. Timing them in
// disjoint, sequential blocks does not give you that — it only gives it to you for STATIONARY
// interference. Under a burst the blocks are not exchangeable, and there were FOUR of them, not
// two: each half of the ratio is itself a difference (facets-on minus plain), evaluated fully at
// N and only then fully at 4N. A burst landing in one block and not the others does not cancel,
// it divides — inflating a minuend or depressing a subtrahend swings the ratio without bound.
//
// Measured, not argued — and measured under the interference that actually dominates this file.
// Everything below is the FULL dataset, not a capture of one: every round taken is counted here.
//
// THE CONDITION. `bash scripts/test.sh` — the whole suite, both lanes running CONCURRENTLY, with
// the db lane at FULL STRENGTH: 71 of 71 db-lane files, 486 of 486 db-lane tests, zero skipped,
// in every round counted below. That is not incidental rigour. scripts/test.sh:12-13 says
// overlapping the unit lane with the db lane "hides the unit lane's cost almost entirely" — the
// db lane IS the dominant interference source for this file, and its cost is bursty rather than
// steady, which is exactly the shape a ratio has to survive. An earlier version of this header
// attributed its numbers to duty-cycled CPU spinners and did not disclose that the db lane was
// not running for any of them: it documented a PROXY for this condition as though it were this
// condition. Those figures are gone; these replace them.
//
// THE METHOD. The old (blocked) and new (interleaved) estimators were TIMED IN THE SAME ROUND —
// same lane, same live load, same catalogue and fixtures — with the running order alternated
// round by round so neither is permanently second. They cannot both be read off one capture: the
// two differ ONLY in schedule, so a schedule has to be executed, not replayed.
//
// THE RESULT — 13 paired rounds, 1-min load average 6.57–14.32:
//   blocked sampling,  9 samples   2.409 – 18.794   RED (>=8) in 3 of 13   ← ON CLEAN CODE
//   interleaved,      15 samples   2.968 –  5.041   RED       in 0 of 13   ← the same 13 rounds
// The blocked schedule's worst clean-code reading, 18.794, is above the 16x a purely quadratic
// regression predicts — a build failing there is indistinguishable from a catastrophic one — and
// above the 12.324 the SAME schedule produced in the same lane on code deliberately made
// quadratic. Reading HIGHER on correct code than on broken code is the worst property a perf
// assertion can have. Separately, 15 full-suite runs on the shipped schedule at load average
// 6.40–12.46, same 71/71 db lane: green 15 of 15.
//
// THE TEETH, so this is not merely "fewer reds". A quadratic mutation inside lib/search/facets.ts
// count(), tuned off set.length (the candidate count this ratio varies, never off n) at the
// WEAKEST strength tried, replicated 9x in the same full lane at load average 9.7–12.8: RED 9 of
// 9, minimum 9.470. So the two distributions are separated, and in the right order:
//   false-positive ceiling   5.041   worst clean-code reading, 13 rounds
//   threshold                    8   between them
//   true-positive floor      9.470   weakest real regression, 9 replications
// The blocked schedule INVERTED that pair, and an inverted pair is what makes a perf assertion
// worse than useless. Un-inverting it is the entire point of interleaving: samples of every
// stream inside every window, so a burst lands proportionally in all four and cancels the way the
// ratio always claimed it did. The estimator ALGEBRA below is unchanged — only the schedule and
// the sample count (9 → 15; see SAMPLES).
//
// LIMITS OF THIS EVIDENCE, stated so nobody reads it as more than it is. 13 rounds and 9
// replications bound the tails loosely. This says the shipped schedule did not go red in 28
// full-strength observations while the blocked one went red 3 times in 13, and that the weakest
// mutation never landed below 9.470 in 9 tries under load at least as heavy — not that either
// tail is impossible.
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
// negative protection, so removing it was right. What was NOT right was the claim attached to
// it. The commit that removed it (be1b025) said the property it guarded is "pinned — with teeth —
// by the growth ratio below"; the mutations in WHAT THIS DOES NOT CATCH show it is not, and the
// same commit also said the growth test was "left exactly as it is" while its own diff changed
// the `at4N` floor. That floor change is harmless (a negative numerator used to yield a negative
// ratio, which passed; it now yields 0, which also passes — it cannot turn a red run green), but
// it was not a no-op, and the record should say so.

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
 * Timed calls per operation. 15 rather than 9: on one capture under CPU spinners it tightened the
 * ratio spread from 3.04–5.72 to 3.31–4.71, for ~0.6s of unloaded runtime. Read that pair as the
 * reason it was TRIED, not as its warrant — it is half of one earlier dataset and was taken with
 * the db lane inert. The warrant is the header: the schedule was re-measured at 15 samples under
 * the full-strength condition, and it is those numbers the threshold is judged against.
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
    // so it separates the two hypotheses instead of measuring the host. Observed 2.968-5.041 on
    // clean code across ALL 13 paired rounds of the full suite (db lane 71/71 files, 486/486
    // tests, zero skipped) at 1-min load average 6.57-14.32, against a floor of 9.470 for the
    // weakest real quadratic regression measured in the same lane. Conditions, the full dataset
    // and its limits are in the header — do not quote this line without them.
    expect(growth).toBeLessThan(8);
  });
});
