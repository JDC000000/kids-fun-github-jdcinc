// invariants/safety.test.ts — The invariants whose violation is a HARM, not a nuisance.
//
// Everything in this file is about content a parent must never be shown, or a claim the product
// must never make. They are asserted over the whole sampled filter space at every pinned clock,
// because "adult-only content is excluded" is worth nothing if it is only true for the default
// selection.
//
// ⚠️ READ THIS BEFORE ADDING A COST INVARIANT.
// "A Free-filtered result's price is never > $0" is FALSE against intended behaviour and must not
// be written. `matchesCost()` deliberately admits unknown / check_source cost under the Free
// filter (Jon's ruling, 2026-08-17: unpriced listings must NEVER be hidden — "the fix is honesty,
// not suppression"). The correct statement is about CONFIRMED cost: no result may carry a cost the
// product is willing to STATE that is greater than zero. An unstated or unknown cost is a legal,
// intended, shipped state, and a suite that reports it is reporting a feature as a bug.

import { describe, it, afterAll, beforeAll, expect } from 'vitest';
import { readCost, readGroupCost } from '../lib/search/filters/cost';
import { HIDDEN_STATUSES } from '../lib/search/filters/status';
import { CLOCKS, expectInvariant, pinClock, slotIds, unpinClock, violation, type Violation } from './_harness';
import { casesFor, runFor, searchAt, SAMPLE_SIZE } from './_run';
import { coverageNote, DEFAULT_QUERY, queryKey, spine, type Query } from './_space';

/** Listings that must never reach a parent, whatever the selection. */
const NEVER_VISIBLE = [
  'trap-adult-title', // "Adult 19yrs+ Swim" — adult-only by title prose
  'trap-senior-title', // "Seniors Tai Chi" — senior-only by title prose
  'trap-senior-structural', // "Mah Jong" — senior-only by an open-ended 55y+ age floor
  'trap-suspended', // suspended — the hidden status class
];

/**
 * Listings that must remain REACHABLE. Half of a safety rule is that it is not over-broad: an
 * exclusion that also removes parent-and-child sessions has traded one harm for another.
 */
const MUST_REMAIN_REACHABLE = [
  'trap-parent-and-child', // "Family Badminton (6-13 with adult)" — says "adult", is kids content
  'trap-registration-vetoed', // "Reserve In Advance: Public Swim" — the drop-in veto keeps it in
];

beforeAll(() => pinClock(CLOCKS[0]));
afterAll(() => unpinClock());

describe('SAFETY — content that must never surface', () => {
  it('adult-only and senior-only programming never appears, in either section, under any selection', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      for (const section of ['results', 'expected'] as const) {
        for (const item of response[section]) {
          checked += 1;
          for (const slot of item.slots) {
            if (NEVER_VISIBLE.includes(slot.id)) {
              violations.push(
                violation(clock, query, `${section} surfaced "${slot.id}" (${item.listing.activityName})`),
              );
            }
          }
        }
      }
    }
    expectInvariant('adult/senior-only content is never surfaced', violations, checked);
  });

  it('the hidden status class (cancelled / suspended / needs_review) never appears', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      for (const item of [...response.results, ...response.expected]) {
        checked += 1;
        if (HIDDEN_STATUSES.includes(item.listing.statusState)) {
          violations.push(
            violation(clock, query, `surfaced "${item.listing.id}" with hidden status ${item.listing.statusState}`),
          );
        }
      }
    }
    expectInvariant('hidden statuses are never surfaced', violations, checked);
  });

  it('the exclusion is not over-broad — parent-and-child and drop-in-vetoed content stays reachable', () => {
    // NOT an invariant over the space: a REACHABILITY check, which is the other half of a hard
    // exclusion. Asserted at every clock because the corpus moves with the clock.
    for (const clock of CLOCKS) {
      const response = searchAt(clock, { ...DEFAULT_QUERY }, 0);
      const ids = slotIds(response.results);
      for (const id of MUST_REMAIN_REACHABLE) {
        expect(
          ids.has(id),
          `"${id}" is not reachable from the default search at ${clock.label} — a hard exclusion has become over-broad`,
        ).toBe(true);
      }
    }
  });
});

describe('SAFETY — cost: no CONFIRMED price above zero under the Free filter', () => {
  it('no result carries a statable cost > $0 when the response declares costFree', () => {
    const violations: Violation[] = [];
    let checked = 0;
    // Non-vacuity counters: the invariant is trivially satisfiable by returning nothing, and it is
    // ALSO trivially satisfiable by a product that (wrongly) hides every unpriced listing. Both are
    // counted so a green pass cannot mean either of those things.
    let freeResults = 0;
    let unstatedResults = 0;

    for (const { clock, query, response } of casesFor(3)) {
      if (!response.context.costFree) continue;
      for (const section of ['results', 'expected'] as const) {
        for (const item of response[section]) {
          checked += 1;
          freeResults += 1;
          // What the product is willing to SAY about this card's cost — its own claim, not a
          // second mirror of the rule (lib/search/filters/cost.ts is the single authority).
          const single = readCost(item.listing);
          const group = readGroupCost(item.slots);
          if (single.kind === 'unstated' || group.kind === 'unstated') unstatedResults += 1;
          for (const [label, read] of [['readCost', single], ['readGroupCost', group]] as const) {
            const amount =
              read.kind === 'amount' ? read.amount
              : read.kind === 'range' ? read.max
              : read.kind === 'group_range' ? read.max
              : 0;
            if (amount > 0) {
              violations.push(
                violation(
                  clock,
                  query,
                  `${section} card "${item.listing.id}" states a CONFIRMED cost of $${amount} via ${label} ` +
                    `(costStatus=${item.listing.costStatus}, min=${item.listing.costMinCad}, max=${item.listing.costMaxCad}) ` +
                    `while context.costFree is true`,
                ),
              );
            }
          }
        }
      }
    }

    expectInvariant('no CONFIRMED cost > $0 under the Free filter', violations, checked);
    expect(freeResults, 'the Free filter returned nothing anywhere in the space — the check is vacuous').toBeGreaterThan(0);
    expect(
      unstatedResults,
      'no unpriced listing survived the Free filter anywhere in the space. That is NOT this ' +
        'invariant passing — it is Option C (2026-08-17) regressing: unpriced listings must never be hidden.',
    ).toBeGreaterThan(0);
  });

  it('a listing with a known, non-zero price never survives the Free filter — in either section', () => {
    // The two rows whose exclusion is the whole point of the filter, one of them in the EXPECTED
    // section (predicate.ts applies cost in BOTH modes precisely so a priced seasonal row cannot
    // arrive through the section next door).
    const priced = ['trap-cost-known-85', 'trap-cost-preseason-priced'];
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      if (!response.context.costFree) continue;
      checked += 1;
      const surfaced = new Set([...slotIds(response.results), ...slotIds(response.expected)]);
      for (const id of priced) {
        if (surfaced.has(id)) violations.push(violation(clock, query, `priced row "${id}" survived the Free filter`));
      }
    }
    expectInvariant('a known, non-zero price never survives the Free filter', violations, checked);
  });

  it('the asymmetric free cells are treated as documented (max=0 is free, min=0 is not)', () => {
    // lib/search/filters/cost.ts states this asymmetry and warns that paraphrasing it as "both
    // bounds zero" gets the first cell wrong: `known/min=null/max=0` IS free; `known/min=0/max=null`
    // is NOT. Pinned end-to-end through the engine, not at the predicate, because the paraphrase has
    // previously escaped into a CONSUMER rather than into the rule.
    //
    // Stated METAMORPHICALLY — "the Free filter does not remove it" — rather than as "it is in the
    // results". A listing can be absent for a dozen legitimate reasons that have nothing to do with
    // cost (it is cancelled, it is adult-only, it is a registration course, it is out of the date
    // window), so asserting presence would make this test a proxy for every other filter in the
    // product and it would fail on entirely correct behaviour. Comparing the SAME query with the
    // Free filter off and on isolates the one thing being asserted.
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      const withoutFree = searchAt(clock, { ...DEFAULT_QUERY }, 0);
      const withFree = slotIds(searchAt(clock, { ...DEFAULT_QUERY, free: true }, 0).results);
      const visible = new Map(runFor(clock).corpus.map((l) => [l.id, l]));
      for (const id of slotIds(withoutFree.results)) {
        const listing = visible.get(id);
        if (!listing) continue;
        const isZeroCeiling = listing.costStatus === 'known' && listing.costMaxCad === 0 && (listing.costMinCad ?? 0) === 0;
        const isZeroFloor = listing.costStatus === 'known' && listing.costMinCad === 0 && listing.costMaxCad == null;
        if (isZeroCeiling) {
          checked += 1;
          if (!withFree.has(id)) {
            violations.push(violation(clock, { ...DEFAULT_QUERY, free: true }, `"${id}" is known/min=null/max=$0 — free — but the Free filter dropped it`));
          }
        }
        if (isZeroFloor) {
          checked += 1;
          if (withFree.has(id)) {
            violations.push(violation(clock, { ...DEFAULT_QUERY, free: true }, `"${id}" is known/min=$0/max=null — a floor of zero is NOT free — but it survived the Free filter`));
          }
        }
      }
    }
    expectInvariant('the asymmetric free cells are honoured end-to-end', violations, checked);
  });
});

describe('SAFETY — registration content is opt-in AND labelled', () => {
  it('nothing registration-shaped is returned while the opt-in is off', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      if (response.context.includeRegistration) continue;
      for (const item of [...response.results, ...response.expected]) {
        checked += 1;
        if (item.registrationRequired) {
          violations.push(
            violation(clock, query, `"${item.listing.id}" (${item.listing.activityName}) is registration content but the opt-in is off`),
          );
        }
      }
    }
    expectInvariant('registration content stays out of the default result set', violations, checked);
  });

  it('every result the opt-in ADDS says on its own card that it is registration content', () => {
    // The product's stated deal: registration content is not deleted, it is opt-in AND labelled.
    // So the delta between opt-out and opt-in is exactly the set that must be self-declaring —
    // a card that arrives only because the opt-in was flipped and does not say so is the defect.
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        if (base.includeRegistration) continue;
        const off = searchAt(clock, base, 0);
        const on = searchAt(clock, { ...base, includeRegistration: true }, 0);
        const before = slotIds(off.results);
        checked += 1;
        for (const item of on.results) {
          const addedHere = item.slots.filter((s) => !before.has(s.id));
          if (addedHere.length === 0) continue;
          if (!item.registrationRequired) {
            violations.push(
              violation(
                clock,
                { ...base, includeRegistration: true },
                `card "${item.listing.id}" (${item.listing.activityName}) appeared only with the registration opt-in on, ` +
                  `carrying slots [${addedHere.map((s) => s.id).join(', ')}], but is NOT labelled registrationRequired`,
              ),
            );
          }
        }
      }
    }
    expectInvariant('opt-in registration results are labelled as registration content', violations, checked);
  });
});

describe('coverage', () => {
  it('reports what this run actually covered (and what it did not)', () => {
    const cases = casesFor(3);
    const perClock = cases.length / CLOCKS.length;
    // Printed, not asserted-away: a suite that silently caps its own coverage reads as
    // "we checked everything" when it did not.
    // eslint-disable-next-line no-console
    console.log(
      [
        coverageNote('filter-invariant space', perClock),
        `  clocks: ${CLOCKS.map((c) => c.label).join(' | ')}`,
        `  per clock: exhaustive single-dimension spine (${spine().length}) + ${SAMPLE_SIZE} sampled full combinations, de-duplicated → ${perClock}`,
        `  NOT covered: every selection outside that sample, and every catalogue other than invariants/_corpus.ts`,
        `  default selection: ${queryKey(DEFAULT_QUERY as Query)}`,
      ].join('\n'),
    );
    expect(perClock).toBeGreaterThan(100);
  });
});
