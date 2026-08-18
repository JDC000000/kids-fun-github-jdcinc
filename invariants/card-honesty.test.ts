// invariants/card-honesty.test.ts — What a single card is allowed to say about itself.
//
// The three families next door are about the result SET. This one is about each card in it, and
// it is aimed at the shape of defect this repo has already paid for more than once: a surface
// printing a number it was never given. A fabricated distance ("2.1 km away" measured from
// nowhere), a collapsed card standing for occurrences that are not its own, a stated time span
// that ends before it starts. None of those are filtering bugs and none would be caught by any
// subset relation — they are claims, and a claim needs an invariant of its own.
//
// Same rules as the rest of the suite: pinned clocks, sets not counts, and every assertion stated
// against what the response DECLARES rather than against a hard-coded expectation.

import { describe, it, afterAll, beforeAll, expect } from 'vitest';
import { facetGroup } from '../lib/search/facets';
import { localDay } from './_time';
import { CLOCKS, allItems, expectInvariant, pinClock, primaryItems, unpinClock, violation, type Violation } from './_harness';
import { casesFor, runFor, searchAt } from './_run';
import { spine } from './_space';

beforeAll(() => pinClock(CLOCKS[0]));
afterAll(() => unpinClock());

describe('CARD HONESTY — distance', () => {
  it('a search with no origin never puts a distance on a card', () => {
    // A distance with no origin is a number measured from nowhere. It is also the most
    // believable thing a card can print, which is what makes it worth an invariant rather than
    // a code comment.
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      if (response.origin != null) continue;
      for (const item of allItems(response)) {
        checked += 1;
        if (item.distanceKm != null) {
          violations.push(violation(clock, query, `"${item.listing.id}" carries distanceKm=${item.distanceKm} but the response resolved no origin`));
        }
      }
    }
    expectInvariant('no distance without an origin', violations, checked);
  });

  it('with an origin, every primary result is inside the radius the response declares', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      if (response.origin == null) continue;
      const radius = response.context.radiusKm;
      // Both primary sections: the radius filter applies to every primary result, and the
      // age split decides which HEADING a result sits under, never which filters it survived.
      for (const item of primaryItems(response)) {
        checked += 1;
        if (item.distanceKm == null) {
          violations.push(violation(clock, query, `"${item.listing.id}" survived a radius search but carries no distance (geo=${JSON.stringify(item.listing.geo)})`));
          continue;
        }
        // Floating-point slack only — a whole metre, against a filter measured in kilometres.
        if (item.distanceKm > radius + 0.001) {
          violations.push(violation(clock, query, `"${item.listing.id}" is ${item.distanceKm.toFixed(3)}km away but the response declares a ${radius}km radius`));
        }
      }
    }
    expectInvariant('results are inside the DECLARED radius', violations, checked);
  });

  it('the radius rung is the only thing that can move the declared radius, and it only widens it', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        if (!base.origin) continue;
        const strict = searchAt(clock, base, 0);
        const broadened = searchAt(clock, base, 3);
        checked += 1;
        const widened = broadened.context.radiusKm > strict.context.radiusKm;
        const narrowed = broadened.context.radiusKm < strict.context.radiusKm;
        const declares = broadened.broadening.applied.some((r) => r.key === 'radius_expand');
        if (narrowed) violations.push(violation(clock, base, `broadening NARROWED the radius from ${strict.context.radiusKm}km to ${broadened.context.radiusKm}km`));
        if (widened !== declares) {
          violations.push(violation(clock, base, `radius moved ${strict.context.radiusKm}km → ${broadened.context.radiusKm}km but radius_expand ${declares ? 'IS' : 'is NOT'} in broadening.applied`));
        }
      }
    }
    expectInvariant('the declared radius only ever widens, and only with disclosure', violations, checked);
  });
});

describe('CARD HONESTY — a collapsed card stands only for its own occurrences', () => {
  it('every slot shares the representative series', () => {
    // The collapse contract (lib/search/collapse.ts): the grouping key is the seriesId. If a card
    // ever seated a slot from another series, its "15 slots, 3:15 PM–7:30 PM" line would describe
    // activities a parent cannot attend together.
    const violations: Violation[] = [];
    let checked = 0;
    let collapsedCards = 0;
    for (const { clock, query, response } of casesFor(3)) {
      const corpus = runFor(clock).byId;
      for (const item of allItems(response)) {
        checked += 1;
        if (item.slots.length > 1) collapsedCards += 1;
        // Open-hours / undated rows belong to no point in time and are documented as never collapsed.
        if (item.listing.openHours || item.listing.startDatetimeUtc == null) {
          if (item.slots.length !== 1) {
            violations.push(violation(clock, query, `"${item.listing.id}" has no start instant but was collapsed into ${item.slots.length} slots`));
          }
          continue;
        }
        for (const slot of item.slots) {
          const member = corpus.get(slot.id);
          if (!member) {
            violations.push(violation(clock, query, `card "${item.listing.id}" seats slot "${slot.id}", which is not in the catalogue`));
            continue;
          }
          if (member.seriesId !== item.listing.seriesId) {
            violations.push(violation(clock, query, `card "${item.listing.id}" (series ${item.listing.seriesId}) seats slot "${slot.id}" from series ${member.seriesId}`));
          }
        }
      }
    }
    expectInvariant('a collapsed card seats only its own series', violations, checked);
    expect(collapsedCards, 'nothing in the corpus ever collapsed — the contract is untested').toBeGreaterThan(0);
  });

  it('a card that runs on several days states those DAYS and no single time span', () => {
    // THE RULE THE (seriesId, local day) KEY USED TO ENFORCE, now enforced where it belongs.
    // Collapsing merges a recurring programme across days (report P1-2, 2026-08-18), so the first
    // start and last end of one card can sit on different dates — "Tuesday 6:30 AM to Friday
    // 8:30 AM" is not a window anyone can attend. Such a card must therefore publish NO span at
    // all, and must instead list every local day it runs on, in agreement with its own slots.
    const violations: Violation[] = [];
    let checked = 0;
    let multiDayCards = 0;
    for (const { clock, query, response } of casesFor(3)) {
      for (const item of allItems(response)) {
        checked += 1;
        const slotDays = [...new Set(item.slots.filter((s) => s.startDatetimeUtc).map((s) => localDay(new Date(s.startDatetimeUtc!))))].sort();
        if (JSON.stringify(item.slotDays) !== JSON.stringify(slotDays)) {
          violations.push(violation(clock, query, `card "${item.listing.id}" reports days ${JSON.stringify(item.slotDays)} but its slots run on ${JSON.stringify(slotDays)}`));
        }
        if (slotDays.length <= 1) continue;
        multiDayCards += 1;
        if (item.slotSpanEndUtc != null) {
          violations.push(violation(clock, query, `card "${item.listing.id}" spans ${slotDays.length} local days yet states a span ending ${item.slotSpanEndUtc}`));
        }
      }
    }
    expectInvariant('a multi-day card states its days, never a span it does not occupy', violations, checked);
    expect(multiDayCards, 'no card in the corpus ever spanned days — the contract is untested').toBeGreaterThan(0);
  });

  it('a card never states a time span that ends before it begins, and its slots are in order', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      for (const item of allItems(response)) {
        const starts = item.slots.map((s) => (s.startDatetimeUtc ? Date.parse(s.startDatetimeUtc) : null));
        checked += 1;
        for (let i = 1; i < starts.length; i += 1) {
          const prev = starts[i - 1];
          const cur = starts[i];
          if (prev != null && cur != null && cur < prev) {
            violations.push(violation(clock, query, `card "${item.listing.id}" lists slot ${item.slots[i].id} before slot ${item.slots[i - 1].id} in time`));
          }
        }
        const first = starts.find((s) => s != null) ?? null;
        const end = item.slotSpanEndUtc ? Date.parse(item.slotSpanEndUtc) : null;
        if (first != null && end != null && end < first) {
          violations.push(violation(clock, query, `card "${item.listing.id}" states a span ending ${item.slotSpanEndUtc}, before its first slot starts`));
        }
      }
    }
    expectInvariant('a card\'s stated time span is coherent', violations, checked);
  });

  it('no response seats the same occurrence twice, in one section or across two', () => {
    // The venue cap (lib/search/venue-diversity.ts) REORDERS the page — it defers a card from an
    // over-represented venue to the next round rather than dropping it. A reorder that duplicated
    // or lost a card would be indistinguishable from a working one on a count, so this asserts
    // identity: every occurrence the response mentions, whether as a card or as a slot inside
    // one, is mentioned exactly once across the whole payload.
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      const seen = new Set<string>();
      for (const item of allItems(response)) {
        checked += 1;
        for (const slot of item.slots) {
          if (seen.has(slot.id)) {
            violations.push(violation(clock, query, `occurrence "${slot.id}" appears more than once in the response (card "${item.listing.id}")`));
          }
          seen.add(slot.id);
        }
      }
    }
    expectInvariant('every occurrence is seated exactly once', violations, checked);
  });

  it('every card the engine returns is a listing the catalogue actually holds', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      const corpus = runFor(clock).byId;
      for (const item of allItems(response)) {
        checked += 1;
        if (!corpus.has(item.listing.id)) {
          violations.push(violation(clock, query, `card "${item.listing.id}" is not in the catalogue the engine was given`));
        }
      }
    }
    expectInvariant('no result is synthesised', violations, checked);
  });

  it('`total` counts the cards the caller was actually handed (no limit is in play)', () => {
    // THE PRIMARY PAGE IS TWO ARRAYS, and `total` counts both.
    //
    // Under an active age filter the engine splits the primary list into `results` (a genuine
    // band intersection) and `ageUnconfirmed` (admitted by matchesAge's "unknown → don't hide"
    // rule, held under their own heading — Jon's ruling 2026-08-18, option b). Nothing is
    // dropped by that split, so the count it describes must not shrink either: `total` is
    // documented as reachability across BOTH primary sections, which is also what keeps it equal
    // to `facets.total` (asserted separately below, from the other direction).
    //
    // Note what is NOT being relaxed here. The assertion is still an EXACT equality against the
    // cards actually handed over — it now just adds up the whole page instead of one section of
    // it. A `total` that over- or under-counted either array still fails.
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      checked += 1;
      const handed = response.results.length + response.ageUnconfirmed.length;
      if (response.total !== handed) {
        violations.push(
          violation(clock, query, `total says ${response.total} but ${handed} cards were returned (${response.results.length} confirmed-age + ${response.ageUnconfirmed.length} age-unconfirmed)`),
        );
      }
      if (response.context.raw !== query.q) {
        violations.push(violation(clock, query, `context.raw is "${response.context.raw}" for a query of "${query.q}"`));
      }
    }
    expectInvariant('total describes the returned page', violations, checked);
  });
});

describe('CARD HONESTY — the filter rail cannot promise what the list will not deliver', () => {
  it('a drop-one facet count never contradicts the page it was computed for', () => {
    // Drop-one (disjunctive) faceting has two consequences that must always hold, and they are
    // what make the numbers usable rather than decorative:
    //   • the group's own "any" is the count with that group's constraint REMOVED, so it can
    //     never be smaller than the page; and
    //   • a value the page has ALREADY selected must count exactly the page — a single-select
    //     chip that says a different number than the list beneath it is the lie these counts
    //     exist to prevent.
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const query of spine()) {
        const response = searchAt(clock, query, 3, true);
        const facets = response.facets;
        if (!facets) continue;
        for (const group of facets.groups) {
          for (const value of group.values) {
            checked += 1;
            if (value.count < 0) {
              violations.push(violation(clock, query, `facet ${group.key}/${value.value} reports a negative count (${value.count})`));
            }
          }
          const any = group.values.find((v) => v.value === 'any');
          if (any && any.count < response.total) {
            violations.push(violation(clock, query, `facet ${group.key}/any promises ${any.count} but the page already shows ${response.total}`));
          }
          // Only single-select and independent-toggle groups can be checked for equality: a
          // multi-select group's per-value count is OR-within-group and is measured for that
          // value ALONE, so it is legitimately smaller than a multi-value selection's page.
          if (group.selection === 'single' || group.selection === 'toggle') {
            for (const value of group.values.filter((v) => v.selected)) {
              if (value.count !== response.total) {
                violations.push(
                  violation(clock, query, `facet ${group.key}/${value.value} is marked selected and promises ${value.count}, but the page it describes shows ${response.total}`),
                );
              }
            }
          }
        }
      }
    }
    expectInvariant('facet counts agree with the page they describe', violations, checked);
  });

  it('the areas facet is derived from the hierarchy, not from a hard-coded chip list', () => {
    // In database mode the region ids are UUIDs and the UI's hard-coded 'van'/'nvan' chips cannot
    // match them; the fix was to serve the vocabulary from the data. Pinned so a later
    // "simplification" back to a literal list is visible here rather than in production.
    for (const clock of CLOCKS) {
      const response = searchAt(clock, spine()[0], 3, true);
      const areas = facetGroup(response.facets!, 'areas');
      expect(areas, 'no areas facet group was published').toBeDefined();
      const values = areas!.values.filter((v) => v.value !== 'any');
      expect(values.length, 'the areas facet published no municipalities').toBeGreaterThan(0);
      for (const value of values) {
        expect(value.label, `area "${value.value}" was published with no human label`).toBeTruthy();
      }
    }
  });
});
