// invariants/algebra.test.ts — Metamorphic relations between two runs of the SAME engine.
//
// Nothing here asserts WHICH listings come back. Each test changes one thing about a query and
// asserts a relation between the two result sets — subset, superset, equality, permutation. That
// is what makes the family cheap to extend and hard to make wrong: it needs no expected output,
// only a rule about how the output must move.
//
// TWO RULES OF CONSTRUCTION, both learned from defects this repo has already paid for.
//
// 1. THE LADDER IS DECLINED (`minResults: 0`, the digest's documented opt-out) for every subset
//    relation. Broadening deliberately ADDS results the caller did not ask for, so "adding a
//    filter never adds results" asserted with the ladder live is a statement about padding, not
//    about filtering — and it would fail against entirely correct behaviour.
//
// 2. SETS ARE COMPARED BY SLOT ID, never by count and never by card id. A flat result cap makes
//    counts unable to distinguish filtering from truncation; card ids are worse still, because
//    collapse (one card per series per local day) runs AFTER sorting, so removing one occurrence
//    can promote a different member of its group to representative — and a strictly narrowing
//    filter then looks like it INTRODUCED a result.
//
// 3. THE SET IS THE WHOLE PRIMARY PAGE — `primarySlotIds`, i.e. `results` ∪ `ageUnconfirmed` —
//    not the `results` array alone. Under an active age filter the engine now SECTIONS the
//    primary list, holding listings whose source never stated an age under their own heading
//    instead of mixing them in (Jon's ruling 2026-08-18, option b). That is a presentation
//    change: nothing is filtered out and everything stays reachable. These relations are about
//    FILTERING, so reading `results` alone would score a re-sectioning as a removal and quietly
//    stop measuring the age filter — the relations would keep passing while asserting less.

import { describe, it, afterAll, beforeAll, expect } from 'vitest';
import { buildCorpus, makeEngine } from './_corpus';
import { CLOCKS, expectInvariant, notContainedIn, pinClock, primarySlotIds, unpinClock, violation, type Violation } from './_harness';
import { searchAt } from './_run';
import { SORT_VALUES, spine, toRequest, type Query } from './_space';

/**
 * Filters that can only ever REMOVE results. `includeRegistration` is deliberately absent: it is
 * an inclusion widener (SearchContext.includeRegistration: "turning it on can only ever ADD
 * results"), so it gets the opposite invariant, below.
 */
const NARROWING: Array<{ name: string; patch: Partial<Query>; appliesTo: (q: Query) => boolean }> = [
  { name: 'region=van', patch: { region: ['van'] }, appliesTo: (q) => q.region.length === 0 },
  { name: 'region=bby', patch: { region: ['bby'] }, appliesTo: (q) => q.region.length === 0 },
  { name: 'ageBands=5-9', patch: { ageBands: ['5-9'] }, appliesTo: (q) => q.ageBands.length === 0 },
  { name: 'ageBands=under2', patch: { ageBands: ['under2'] }, appliesTo: (q) => q.ageBands.length === 0 },
  { name: 'when=today', patch: { when: 'today' }, appliesTo: (q) => q.when === 'any' },
  { name: 'timeOfDay=morning', patch: { timeOfDay: 'morning' }, appliesTo: (q) => q.timeOfDay === 'any' },
  { name: 'free=1', patch: { free: true }, appliesTo: (q) => !q.free },
  { name: 'dropIn=1', patch: { dropIn: true }, appliesTo: (q) => !q.dropIn },
  { name: 'rainyDay=1', patch: { rainyDay: true }, appliesTo: (q) => !q.rainyDay },
  { name: 'bookableNow=1', patch: { bookableNow: true }, appliesTo: (q) => !q.bookableNow },
  { name: 'origin (radius)', patch: { origin: true }, appliesTo: (q) => !q.origin },
  { name: 'text query', patch: { q: 'gym' }, appliesTo: (q) => q.q === '' },
];

beforeAll(() => pinClock(CLOCKS[0]));
afterAll(() => unpinClock());

describe('ALGEBRA — monotonicity', () => {
  it('adding a narrowing filter never introduces a result (ladder declined, compared by set)', () => {
    const violations: Violation[] = [];
    let checked = 0;
    let observedShrink = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        const before = primarySlotIds(searchAt(clock, base, 0));
        for (const { name, patch, appliesTo } of NARROWING) {
          if (!appliesTo(base)) continue;
          const narrowed = { ...base, ...patch };
          const after = primarySlotIds(searchAt(clock, narrowed, 0));
          checked += 1;
          if (after.size < before.size) observedShrink += 1;
          const introduced = notContainedIn(after, before);
          if (introduced.length > 0) {
            violations.push(
              violation(clock, narrowed, `adding ${name} INTRODUCED ${introduced.length} result(s) absent from the unfiltered set: [${introduced.slice(0, 6).join(', ')}]`),
            );
          }
        }
      }
    }
    expectInvariant('a narrowing filter never introduces a result', violations, checked);
    expect(observedShrink, 'no narrowing filter removed anything anywhere — the corpus cannot exercise this').toBeGreaterThan(0);
  });

  it('the registration opt-in is a WIDENER — turning it on never removes a result', () => {
    // The mirror image, and it exists so nobody "fixes" the monotonicity table above by adding
    // includeRegistration to it. Its documented contract is the opposite: an inclusion widener.
    const violations: Violation[] = [];
    let checked = 0;
    let observedGrowth = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        if (base.includeRegistration) continue;
        const off = primarySlotIds(searchAt(clock, base, 0));
        const on = primarySlotIds(searchAt(clock, { ...base, includeRegistration: true }, 0));
        checked += 1;
        if (on.size > off.size) observedGrowth += 1;
        const lost = notContainedIn(off, on);
        if (lost.length > 0) {
          violations.push(
            violation(clock, { ...base, includeRegistration: true }, `the registration opt-in REMOVED ${lost.length} result(s): [${lost.slice(0, 6).join(', ')}]`),
          );
        }
      }
    }
    expectInvariant('the registration opt-in only ever adds', violations, checked);
    expect(observedGrowth, 'the registration opt-in never added anything — the corpus cannot exercise this').toBeGreaterThan(0);
  });

  it('declining the broadening ladder never yields a result the ladder would not have', () => {
    // Every rung is a RELAXATION of the context below it, so the broadened set must contain the
    // unbroadened one. A rung that swapped one constraint for another rather than loosening it
    // would show up here as a result that exists without broadening and vanishes with it.
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        const strict = primarySlotIds(searchAt(clock, base, 0));
        const broadened = primarySlotIds(searchAt(clock, base, 3));
        checked += 1;
        const lost = notContainedIn(strict, broadened);
        if (lost.length > 0) {
          violations.push(
            violation(clock, base, `broadening LOST ${lost.length} result(s) the unbroadened search returned: [${lost.slice(0, 6).join(', ')}]`),
          );
        }
      }
    }
    expectInvariant('broadening never loses an exact match', violations, checked);
  });
});

describe('ALGEBRA — region chips are additive', () => {
  it('a sub-area selection is contained in its municipality selection', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        if (base.region.length > 0) continue;
        const subArea = primarySlotIds(searchAt(clock, { ...base, region: ['van-east'] }, 0));
        const municipality = primarySlotIds(searchAt(clock, { ...base, region: ['van'] }, 0));
        checked += 1;
        const outside = notContainedIn(subArea, municipality);
        if (outside.length > 0) {
          violations.push(violation(clock, { ...base, region: ['van-east'] }, `East Van results not present under Vancouver: [${outside.slice(0, 6).join(', ')}]`));
        }
      }
    }
    expectInvariant('a sub-area is a subset of its municipality (BR-08)', violations, checked);
  });

  it('two chips return exactly the union of what each returns alone (FR-07, multi-select)', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        if (base.region.length > 0) continue;
        const a = primarySlotIds(searchAt(clock, { ...base, region: ['nvan'] }, 0));
        const b = primarySlotIds(searchAt(clock, { ...base, region: ['rmd'] }, 0));
        const both = primarySlotIds(searchAt(clock, { ...base, region: ['nvan', 'rmd'] }, 0));
        checked += 1;
        const union = new Set([...a, ...b]);
        const extra = notContainedIn(both, union);
        const missing = notContainedIn(union, both);
        if (extra.length > 0 || missing.length > 0) {
          violations.push(
            violation(clock, { ...base, region: ['nvan', 'rmd'] }, `chip union is not additive — ${extra.length} extra [${extra.slice(0, 4).join(', ')}], ${missing.length} missing [${missing.slice(0, 4).join(', ')}]`),
          );
        }
      }
    }
    expectInvariant('multi-select region chips union their results', violations, checked);
  });
});

describe('ALGEBRA — sort is an ordering, not a search', () => {
  it('every sort returns the same set of occurrences, and the same total', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        const reference = searchAt(clock, { ...base, sort: 'best_match' }, 0);
        const referenceIds = primarySlotIds(reference);
        for (const sort of SORT_VALUES) {
          if (sort === 'best_match') continue;
          const other = searchAt(clock, { ...base, sort }, 0);
          const ids = primarySlotIds(other);
          checked += 1;
          const extra = notContainedIn(ids, referenceIds);
          const missing = notContainedIn(referenceIds, ids);
          if (extra.length > 0 || missing.length > 0) {
            violations.push(
              violation(clock, { ...base, sort }, `sort=${sort} changed the result SET (extra [${extra.slice(0, 4).join(', ')}], missing [${missing.slice(0, 4).join(', ')}])`),
            );
          }
          if (other.total !== reference.total) {
            violations.push(violation(clock, { ...base, sort }, `sort=${sort} returned ${other.total} cards, best_match returned ${reference.total}`));
          }
        }
      }
    }
    expectInvariant('sorting permutes the result set, never filters it', violations, checked);
  });
});

describe('ALGEBRA — determinism', () => {
  it('the same query twice against the same engine returns an identical response', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        const first = searchAt(clock, base, 3);
        const second = searchAt(clock, base, 3);
        checked += 1;
        if (JSON.stringify(digest(first)) !== JSON.stringify(digest(second))) {
          violations.push(violation(clock, base, 'two identical searches returned different responses'));
        }
      }
    }
    expectInvariant('search is idempotent', violations, checked);
  });

  it('a freshly built engine over an identically generated corpus returns identical responses', () => {
    // Idempotence on ONE engine cannot see per-process state: the matcher memoises a token index
    // per listing and the local-time helper memoises a bounded parts cache. If either ever became
    // request-dependent, only a second engine would show it.
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      const fresh = makeEngine(buildCorpus(clock.utc));
      for (const base of spine()) {
        const viaShared = digest(searchAt(clock, base, 3));
        const viaFresh = digest(fresh.search(toRequest(base, clock.utc, { minResults: 3 })));
        checked += 1;
        if (JSON.stringify(viaShared) !== JSON.stringify(viaFresh)) {
          violations.push(violation(clock, base, 'a fresh engine over the same catalogue returned a different response'));
        }
      }
    }
    expectInvariant('search carries no cross-request state', violations, checked);
  });
});

/**
 * The parts of a response whose stability is what "deterministic" means here.
 *
 * BOTH primary sections are digested. Determinism has to cover the SPLIT as well as the order —
 * an engine that filed the same card under a different heading on a second identical run would
 * be non-deterministic in the way a parent would actually notice.
 */
type DigestSection = Array<{ listing: { id: string }; slots: Array<{ id: string }> }>;
function digest(response: { results: DigestSection; ageUnconfirmed: DigestSection; total: number; broadening: { applied: Array<{ key: string }> }; context: { date: unknown; ageBands: string[]; radiusKm: number } }) {
  const section = (items: DigestSection) => ({
    order: items.map((r) => r.listing.id),
    slots: items.map((r) => r.slots.map((s) => s.id)),
  });
  return {
    total: response.total,
    ...section(response.results),
    ageUnconfirmed: section(response.ageUnconfirmed),
    rungs: response.broadening.applied.map((r) => r.key),
    context: { date: response.context.date, ageBands: response.context.ageBands, radiusKm: response.context.radiusKm },
  };
}
