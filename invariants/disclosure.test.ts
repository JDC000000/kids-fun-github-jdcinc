// invariants/disclosure.test.ts — What the app CLAIMS versus what it RETURNS.
//
// ⚠️ THE MISTAKE THIS FILE IS BUILT TO AVOID.
// The obvious date invariant — "every result's date falls within the requested [from, to]" — is
// FALSE against intended behaviour and must never be written here. The ±3-day broadening ladder
// (lib/search/broaden.ts, ADJACENT_DATE_DAYS) deliberately widens the window when a search is too
// thin to fill `minResults`. A suite asserting strict containment reports a shipped, deliberate,
// parent-visible feature as a defect — which is how four testers lost an evening on 2026-08-17.
//
// The correct shape, and the shape every invariant below takes, is DISCLOSURE:
//   • a result falls within the window the response DECLARES it searched; and
//   • where the declared window differs from the requested one, the response SAYS SO, in the
//     dimension it actually changed.
// Permissive matching plus honest disclosure is this codebase's stated philosophy (see the
// load-bearing headers in lib/geo/region.ts, lib/search/filters/age.ts, lib/search/filters/
// cost.ts). An invariant that assumes strict exclusion is testing a product we did not build.
//
// The REQUESTED value is never hard-coded here either. It is read from the same query run with
// the ladder declined (`minResults: 0` — the digest's documented opt-out), so these invariants
// pin the RELATIONSHIP between the two runs rather than pinning any particular product decision
// about what "this weekend" means.

import { describe, it, afterAll, beforeAll, expect } from 'vitest';
import type { AgeBandKey, DateIntent, SearchContext } from '../lib/search/types';
import type { SearchResponse } from '../lib/search/engine';
import { addDays, localDay } from './_time';
import {
  ADJACENT_DAY_PART,
  CLOCKS,
  DAY_PART,
  allItems,
  expectInvariant,
  localDaySpan,
  primaryItems,
  primarySlotIds,
  slotIds,
  localMinuteSpan,
  overlaps,
  overlapsOnClock,
  pinClock,
  unpinClock,
  violation,
  weekdayOf,
  type Violation,
} from './_harness';
import { casesFor, runFor, searchAt } from './_run';
import { DEFAULT_QUERY, queryKey, spine } from './_space';

/** The ladder's stated reach on either side of the requested window (broaden.ts ADJACENT_DATE_DAYS). */
const LADDER_DAYS = 3;

/** Age bands youngest-first. Restated here so "adjacent" is checked, not delegated. */
const AGE_ORDER: AgeBandKey[] = ['under2', '2-4', '5-9', '10-14', '15+'];

function adjacentBands(selected: AgeBandKey[]): AgeBandKey[] {
  if (selected.length === 0) return [];
  const widened = new Set<AgeBandKey>(selected);
  for (const band of selected) {
    const i = AGE_ORDER.indexOf(band);
    if (i < 0) continue;
    if (i > 0) widened.add(AGE_ORDER[i - 1]);
    if (i < AGE_ORDER.length - 1) widened.add(AGE_ORDER[i + 1]);
  }
  return AGE_ORDER.filter((b) => widened.has(b));
}

/**
 * The inclusive local-day window a DateIntent selects, or null when it constrains nothing.
 *
 * Keyed off `endIsoDate`, exactly as lib/search/filters/time.ts `matchesDate` is — these
 * invariants compare what the response DECLARES against what it RETURNS, so if this helper and
 * the predicate disagree about where a window ends, the suite measures its own drift instead of
 * the product's. `weekend` is the second kind to carry an end (Sat+Sun) and the first to prove it.
 */
function windowOf(date: DateIntent | null): { from: string; to: string } | null {
  if (!date || !date.isoDate) return null;
  return { from: date.isoDate, to: date.endIsoDate && date.endIsoDate > date.isoDate ? date.endIsoDate : date.isoDate };
}

const sameWindow = (a: { from: string; to: string } | null, b: { from: string; to: string } | null) =>
  a == null || b == null ? a === b : a.from === b.from && a.to === b.to;

const show = (w: { from: string; to: string } | null) => (w ? `${w.from}..${w.to}` : 'unconstrained');

/**
 * Pair each ladder-on response with the SAME query run with the ladder declined. The declined run
 * is the reference for "what was requested" — no product date semantics are restated here.
 */
function pairedCases() {
  const withLadder = casesFor(3);
  const withoutLadder = casesFor(0);
  expect(withLadder.length, 'the two ladder modes walked different spaces').toBe(withoutLadder.length);
  return withLadder.map((c, i) => {
    const baseline = withoutLadder[i];
    expect(queryKey(baseline.query), 'paired runs fell out of alignment').toBe(queryKey(c.query));
    expect(baseline.clock.label).toBe(c.clock.label);
    return { ...c, baseline: baseline.response };
  });
}

const appliedKeys = (r: SearchResponse) => r.broadening.applied.map((rung) => rung.key);

beforeAll(() => pinClock(CLOCKS[0]));
afterAll(() => unpinClock());

describe('DISCLOSURE — date: containment OR declared broadening (never strict containment)', () => {
  it('every primary result falls inside the window the response DECLARES it searched', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      const declared = windowOf(response.context.date);
      if (!declared) continue;
      // Both primary sections. The age split changes which HEADING a primary result sits under,
      // never which filters it passed, so a date claim that must hold for the confirmed list
      // holds identically for the age-not-stated one.
      for (const item of primaryItems(response)) {
        const span = localDaySpan(item.listing);
        // Open-hours attractions belong to no single day and the product documents them as
        // available every day — exempt, not a violation.
        if (!span) continue;
        checked += 1;
        if (!(span.first <= declared.to && declared.from <= span.last)) {
          violations.push(
            violation(
              clock,
              query,
              `"${item.listing.id}" runs ${span.first}..${span.last} (America/Vancouver) but the response ` +
                `declares it searched ${show(declared)}`,
            ),
          );
        }
      }
    }
    expectInvariant('results fall inside the DECLARED date window', violations, checked);
  });

  it('a declared window wider than the requested one is always accompanied by the adjacent_date rung', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response, baseline } of pairedCases()) {
      const requested = windowOf(baseline.context.date);
      const declared = windowOf(response.context.date);
      checked += 1;
      const broadened = !sameWindow(requested, declared);
      const declaresIt = appliedKeys(response).includes('adjacent_date');
      if (broadened && !declaresIt) {
        violations.push(
          violation(clock, query, `date window moved ${show(requested)} → ${show(declared)} with NO adjacent_date rung in broadening.applied`),
        );
        continue;
      }
      if (!broadened && declaresIt) {
        violations.push(
          violation(clock, query, `an adjacent_date rung was declared but the window is unchanged at ${show(declared)}`),
        );
        continue;
      }
      if (broadened && requested) {
        // The ladder states its reach; a rung that widens further than it claims is the same
        // class of defect as one that does not disclose at all.
        const expected = { from: addDays(requested.from, -LADDER_DAYS), to: addDays(requested.to, LADDER_DAYS) };
        if (!sameWindow(declared, expected)) {
          violations.push(
            violation(clock, query, `adjacent_date widened ${show(requested)} to ${show(declared)}, not the stated ±${LADDER_DAYS} days (${show(expected)})`),
          );
        }
      }
    }
    expectInvariant('date broadening is disclosed and bounded to its stated reach', violations, checked);
  });

  it('the adjacent_date rung label names the window it actually applied', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      for (const rung of response.broadening.applied) {
        if (rung.key !== 'adjacent_date') continue;
        checked += 1;
        const w = windowOf(rung.context.date);
        if (!w || !rung.label.includes(w.from) || !rung.label.includes(w.to)) {
          violations.push(violation(clock, query, `rung label "${rung.label}" does not state its applied window ${show(w)}`));
        }
      }
    }
    expectInvariant('the adjacent_date label states the window it applied', violations, checked);
  });
});

describe('DISCLOSURE — relative dates resolve in America/Vancouver, not UTC', () => {
  // THE bug class this suite was commissioned for. At 22:35 America/Vancouver the UTC calendar has
  // already rolled to the next day, so a UTC-derived "today" silently searches tomorrow. The
  // expected value here comes from invariants/_time.ts, which does not import from lib/.
  it('when=today and when=tomorrow resolve to the Vancouver local day at every pinned clock', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      const today = localDay(clock.utc);
      for (const [when, expected] of [['today', today], ['tomorrow', addDays(today, 1)]] as const) {
        const query = { ...DEFAULT_QUERY, when };
        // Ladder declined: this is a statement about what was REQUESTED, before any relaxation.
        const response = searchAt(clock, query, 0);
        checked += 1;
        const got = response.context.date?.isoDate ?? null;
        if (got !== expected) {
          violations.push(
            violation(clock, query, `when=${when} resolved to ${got}, but the Vancouver local day at this instant makes it ${expected} (UTC day is ${clock.utc.toISOString().slice(0, 10)})`),
          );
        }
      }
    }
    expectInvariant('when=today/tomorrow resolve to the America/Vancouver local day', violations, checked);
  });

  it('when=weekend resolves to a Saturday AND its Sunday, and contains today when today is one of them', () => {
    // THIS WAS DELIBERATELY WEAK — "some weekend day within 7 days" — because the product
    // resolved "this weekend" to the upcoming Saturday only, and whether Sunday belonged was an
    // open PRODUCT question that this file declined to pre-empt. It is not open any more (Jon,
    // 2026-08-18: "saturday and sundays are always a weekend together... very important that
    // sunday is always included in the weekend search"), and left loose it now PERMITS the exact
    // bug it was written around — including on the DST fall-back clock below, a Sunday, where the
    // old `(6 - wd + 7) % 7` jumped six days to the NEXT Saturday and skipped that very day.
    // Tightened to pin the decision rather than leave it an accident.
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      const query = { ...DEFAULT_QUERY, when: 'weekend' as const };
      const response = searchAt(clock, query, 0);
      const today = localDay(clock.utc);
      const from = response.context.date?.isoDate ?? null;
      const to = response.context.date?.endIsoDate ?? null;
      checked += 1;
      if (from == null || to == null) {
        violations.push(
          violation(clock, query, `when=weekend resolved to ${from ?? 'no start date'}..${to ?? 'no end date'} — a weekend is two days and the intent must declare both`),
        );
        continue;
      }
      if (weekdayOf(from) !== 6) {
        violations.push(violation(clock, query, `when=weekend opens on ${from}, a ${DAY_NAMES[weekdayOf(from)]} — the window must open on Saturday`));
      }
      if (weekdayOf(to) !== 0) {
        violations.push(violation(clock, query, `when=weekend closes on ${to}, a ${DAY_NAMES[weekdayOf(to)]} — the window must close on Sunday`));
      }
      if (to !== addDays(from, 1)) {
        violations.push(violation(clock, query, `when=weekend resolved to ${from}..${to} — Saturday and Sunday are consecutive, so the window is exactly two days`));
      }
      // It is the NEAREST pair, not next week's. Both halves matter: the old code satisfied the
      // second and broke the first, which is the whole bug.
      const todayIsWeekend = weekdayOf(today) === 6 || weekdayOf(today) === 0;
      if (todayIsWeekend && !(from <= today && today <= to)) {
        violations.push(
          violation(clock, query, `today (${today}) is a ${DAY_NAMES[weekdayOf(today)]} but when=weekend resolved to ${from}..${to}, which does not contain it`),
        );
      }
      // Mon..Fri: the coming Saturday is 1–5 days out and is never behind us.
      if (!todayIsWeekend && (from <= today || from > addDays(today, 5))) {
        violations.push(
          violation(clock, query, `today (${today}) is a ${DAY_NAMES[weekdayOf(today)]} but when=weekend opens on ${from} — not the coming Saturday`),
        );
      }
    }
    expectInvariant('when=weekend resolves to the nearest Saturday+Sunday pair, both days', violations, checked);
  });
});

describe('DISCLOSURE — time of day', () => {
  it('every primary result overlaps the day-part window the response declares, adjacency included', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      const part = response.context.timeOfDay;
      if (!part) continue;
      const window = response.context.timeOfDayAdjacent ? ADJACENT_DAY_PART[part] : DAY_PART[part];
      for (const item of primaryItems(response)) {
        const span = localMinuteSpan(item.listing);
        // An open-hours row with NO published hours is documented as "don't hide it" — exempt.
        if (!span) continue;
        checked += 1;
        // On a clock face, not a number line: `evening` reaches past midnight, so a 00:30 result
        // is inside it even though 30 < 1020. See overlapsOnClock in _harness.ts.
        if (!overlapsOnClock(span, window)) {
          violations.push(
            violation(clock, query, `"${item.listing.id}" occupies local minutes ${span.from}..${span.to} but the response declares ${part}${response.context.timeOfDayAdjacent ? ' (+adjacent)' : ''} = ${window.from}..${window.to}`),
          );
        }
      }
    }
    expectInvariant('results overlap the DECLARED day-part window', violations, checked);
  });

  it('an adjacent day-part relaxation is always declared by the adjacent_time rung', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      checked += 1;
      const relaxed = response.context.timeOfDayAdjacent === true;
      const declared = appliedKeys(response).includes('adjacent_time');
      if (relaxed !== declared) {
        violations.push(
          violation(clock, query, `timeOfDayAdjacent=${relaxed} but adjacent_time ${declared ? 'IS' : 'is NOT'} in broadening.applied`),
        );
      }
    }
    expectInvariant('adjacent day-part relaxation is disclosed', violations, checked);
  });

  it('the day-part chips reach every hour of the clock — the 22:00–05:00 gap is closed', () => {
    // ⚠️ THIS TEST USED TO PIN THE GAP RATHER THAN ASSERT IT AWAY, and the note it carried is
    // worth keeping because it is what got the defect fixed. The three chips used to span
    // 05:00–22:00 and nothing else, so an occurrence starting at 22:15 matched morning,
    // afternoon and evening ALL false and was reachable only through "Any time". Measured then:
    //     local 22:15 → []      local 23:00 → []      local 00:30 → []      local 04:30 → [morning]
    // Whether the day should end at 22:00 was a PRODUCT question nobody had ruled on, so this
    // suite pinned the consequence instead of encoding an assumption. It has since been ruled
    // on — evening was widened to 05:00 the next morning — so the pin becomes an assertion.
    //
    // The claim is COVERAGE AND DISJOINTNESS over the whole 24 hours, stated over the oracle
    // windows rather than over a corpus, because "some hour reaches nothing" is a property of
    // the windows themselves and a corpus can only ever sample it.
    const parts = [DAY_PART.morning, DAY_PART.afternoon, DAY_PART.evening];
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const matching = parts.filter((w) => overlapsOnClock({ from: minute, to: minute + 1 }, w));
      expect(
        matching.length,
        `local minute ${minute} (${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}) ` +
          `is matched by ${matching.length} day-part windows, not exactly 1 — the chips have re-opened a gap or begun to overlap`,
      ).toBe(1);
    }

    // The boundaries themselves, named, so a future edit has to face them one at a time.
    expect(DAY_PART.morning.from).toBe(5 * 60); // …and evening now ends exactly here, one turn on.
    expect(DAY_PART.evening.to).toBe(29 * 60);

    // And the product agrees with the oracle where it used to disagree: an evening search now
    // returns late-night rows instead of guaranteeing an empty page. `trap-late-night` (22:30)
    // and `trap-after-midnight` (00:30) exist in the corpus for exactly this assertion.
    for (const clock of CLOCKS) {
      const late = searchAt(clock, { ...DEFAULT_QUERY, timeOfDay: 'evening' }, 0);
      // primaryItems(), not late.results alone: the age-rerank split moves cards between the
      // confirmed and age-unconfirmed sections without changing reachability, so a check against
      // `results` alone would misread a re-sectioned trap listing as unreachable.
      const items = primaryItems(late);
      const reached = slotIds(items);
      for (const id of ['trap-late-night', 'trap-after-midnight']) {
        expect(reached.has(id), `${id} is not reachable through the Evening chip at ${clock.label}`).toBe(true);
      }
      for (const item of items) {
        const span = localMinuteSpan(item.listing);
        if (!span) continue;
        expect(
          span.from < DAY_PART.evening.to,
          `"${item.listing.id}" starts at local minute ${span.from}, at or after the evening window's close ` +
            `(${DAY_PART.evening.to}) — the day-part windows have moved; see this test's note about the 22:00–05:00 gap`,
        ).toBe(true);
      }
    }
  });

  it('morning never widens into evening (and evening never into morning)', () => {
    // ADJACENT_DAY_PARTS is a bounded relaxation, not "any time of day": the rung that used to set
    // timeOfDay:null handed a parent asking for a morning activity an evening one. Only the middle
    // band has two neighbours.
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      const requested = query.timeOfDay;
      if (requested !== 'morning' && requested !== 'evening') continue;
      const forbidden = requested === 'morning' ? DAY_PART.evening : DAY_PART.morning;
      const allowed = ADJACENT_DAY_PART[requested];
      for (const item of primaryItems(response)) {
        const span = localMinuteSpan(item.listing);
        if (!span) continue;
        checked += 1;
        if (overlapsOnClock(span, forbidden) && !overlapsOnClock(span, allowed)) {
          violations.push(
            violation(clock, query, `"${item.listing.id}" (local ${span.from}..${span.to}) is ${requested === 'morning' ? 'evening' : 'morning'}-only content returned for a ${requested} search`),
          );
        }
      }
    }
    expectInvariant('day-part widening never crosses to the opposite end of the day', violations, checked);
  });
});

describe('DISCLOSURE — age', () => {
  it('no result asserts an age match it cannot support', () => {
    // matchesAge's documented permissiveness: a listing with NO derived bands (all-ages / unknown)
    // is never hidden by an age filter. That is a legal state and not a violation. What would be a
    // violation is a listing that DOES declare bands, none of which the response's declared
    // selection contains — i.e. a positive age claim the listing itself contradicts.
    const violations: Violation[] = [];
    let checked = 0;
    let allAgesAdmitted = 0;
    for (const { clock, query, response } of casesFor(3)) {
      const bands = response.context.ageBands;
      if (bands.length === 0) continue;
      for (const item of allItems(response)) {
        const listingBands = item.listing.ageBandMatches;
        if (listingBands.length === 0) {
          allAgesAdmitted += 1;
          continue;
        }
        checked += 1;
        if (!listingBands.some((b) => bands.includes(b))) {
          violations.push(
            violation(clock, query, `"${item.listing.id}" declares bands [${listingBands.join(', ')}], disjoint from the declared selection [${bands.join(', ')}]`),
          );
        }
      }
    }
    expectInvariant('every aged result intersects the declared age selection', violations, checked);
    expect(
      allAgesAdmitted,
      'no all-ages/unknown-age listing survived any age filter. That is NOT this invariant passing — ' +
        'matchesAge deliberately does not hide them (lib/search/filters/age.ts).',
    ).toBeGreaterThan(0);
  });

  it('the primary sections partition on the ONE fact that names them: a genuine band intersection', () => {
    // Jon's ruling 2026-08-18, option b. `matchesAge` still admits a listing whose source stated
    // no age under every age filter — that permissiveness is correct and is NOT what changed. What
    // changed is that those listings no longer sit inside the confirmed list pretending to be
    // matches: the engine puts them in `ageUnconfirmed`, under a heading that says so.
    //
    // The rule has to hold in BOTH directions or the heading is worthless. A confirmed-list card
    // with no stated age is the original defect back again; an `ageUnconfirmed` card that DOES
    // intersect the selection is a genuine match being demoted for no reason, which is its own
    // kind of dishonesty and would quietly bury correct results.
    //
    // Stated per CARD, and a card is confirmed when ANY slot it stands for intersects — the same
    // rule engine.ts's `splitAgeUnconfirmed` applies, restated here rather than imported, because
    // an oracle that calls the implementation asserts only that the implementation equals itself.
    const violations: Violation[] = [];
    let checked = 0;
    let confirmedCards = 0;
    let unconfirmedCards = 0;
    for (const { clock, query, response } of casesFor(3)) {
      const bands = response.context.ageBands;
      const corpus = runFor(clock).byId;
      // Does any occurrence behind this card declare a band the selection asked for?
      const intersects = (item: (typeof response.results)[number]) =>
        item.slots.some((slot) => (corpus.get(slot.id)?.ageBandMatches ?? []).some((b) => bands.includes(b)));

      if (bands.length === 0) {
        // No age filter → nothing to qualify, so the section must not exist at all. A stray card
        // here would be a listing separated out for a selection nobody made.
        checked += 1;
        if (response.ageUnconfirmed.length > 0) {
          violations.push(
            violation(clock, query, `${response.ageUnconfirmed.length} card(s) were filed as age-unconfirmed with NO age filter active`),
          );
        }
        continue;
      }

      for (const item of response.results) {
        checked += 1;
        confirmedCards += 1;
        if (!intersects(item)) {
          violations.push(
            violation(clock, query, `"${item.listing.id}" is in the CONFIRMED list under selection [${bands.join(', ')}] but no slot of it declares any of those bands`),
          );
        }
      }
      for (const item of response.ageUnconfirmed) {
        checked += 1;
        unconfirmedCards += 1;
        if (intersects(item)) {
          violations.push(
            violation(clock, query, `"${item.listing.id}" is in the AGE-UNCONFIRMED section but a slot of it genuinely declares a band in [${bands.join(', ')}]`),
          );
        }
      }
    }
    expectInvariant('the age split is exactly the confirmed/unconfirmed partition it claims to be', violations, checked);
    expect(confirmedCards, 'no card was ever filed as a confirmed age match — the corpus cannot exercise the split').toBeGreaterThan(0);
    expect(
      unconfirmedCards,
      'no card was ever filed as age-unconfirmed anywhere in the space. That is NOT this invariant ' +
        'passing — it means either the corpus holds no unstated-age listing, or the "unknown → do ' +
        'not hide" rule has been inverted (which Jon ruled against: lib/search/filters/age.ts).',
    ).toBeGreaterThan(0);
  });

  it('turning on an age filter SECTIONS the page — it never silently deletes a listing', () => {
    // The whole promise of option (b) over option (a). Everything an un-aged search could reach,
    // an aged search must still be able to reach SOMEWHERE — under the confirmed heading if it
    // genuinely matches, under the age-not-stated heading if the source never said, and nowhere
    // at all only if its own declared bands really are disjoint from the selection (which is the
    // filter doing its job, not the split hiding anything).
    //
    // Compared by SLOT ID and with the ladder declined, for the reasons algebra.test.ts's header
    // gives. The check is a REACHABILITY one, so it reads every section of both responses.
    const violations: Violation[] = [];
    let checked = 0;
    let rescued = 0;
    for (const clock of CLOCKS) {
      const corpus = runFor(clock).byId;
      for (const base of spine()) {
        if (base.ageBands.length > 0) continue;
        const unaged = searchAt(clock, base, 0);
        for (const bands of [['under2'], ['2-4'], ['5-9'], ['10-14']] as AgeBandKey[][]) {
          const aged = searchAt(clock, { ...base, ageBands: bands }, 0);
          const reachable = new Set([...primarySlotIds(aged), ...slotIds(aged.expected)]);
          for (const id of new Set([...primarySlotIds(unaged), ...slotIds(unaged.expected)])) {
            const listing = corpus.get(id);
            if (!listing) continue;
            // A listing with declared bands that miss the selection is legitimately filtered out.
            if (listing.ageBandMatches.length > 0) continue;
            checked += 1;
            if (!reachable.has(id)) {
              violations.push(
                violation(clock, { ...base, ageBands: bands }, `"${id}" states no age and was reachable without an age filter, but selecting [${bands.join(', ')}] made it unreachable in EVERY section`),
              );
            } else if (slotIds(aged.ageUnconfirmed).has(id)) {
              rescued += 1;
            }
          }
        }
      }
    }
    expectInvariant('an age filter re-sections unstated-age listings, it does not drop them', violations, checked);
    expect(
      rescued,
      'no unstated-age listing was ever observed landing in the age-not-stated section — the ' +
        'reachability check above is passing on listings that never needed rescuing',
    ).toBeGreaterThan(0);
  });

  it('a widened age selection is disclosed by the adjacent_age rung and reaches neighbours only', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response, baseline } of pairedCases()) {
      const requested = baseline.context.ageBands;
      const declared = response.context.ageBands;
      checked += 1;
      const widened = declared.length !== requested.length || declared.some((b) => !requested.includes(b));
      const declares = appliedKeys(response).includes('adjacent_age');
      if (widened !== declares) {
        violations.push(
          violation(clock, query, `age selection [${requested.join(', ')}] → [${declared.join(', ')}] but adjacent_age ${declares ? 'IS' : 'is NOT'} in broadening.applied`),
        );
        continue;
      }
      if (!widened) continue;
      const expected = adjacentBands(requested);
      if (declared.length !== expected.length || declared.some((b) => !expected.includes(b))) {
        violations.push(
          violation(clock, query, `adjacent_age widened [${requested.join(', ')}] to [${declared.join(', ')}]; immediate neighbours only would be [${expected.join(', ')}]`),
        );
      }
    }
    expectInvariant('age widening is disclosed and reaches immediate neighbours only', violations, checked);
  });
});

describe('DISCLOSURE — region', () => {
  it('an unrecognised region value degrades to an unfiltered search, never to a silently empty one', () => {
    // lib/geo/region.ts: an unrecognised chip is IGNORED, never treated as "match nothing" — a
    // data-shaped "nothing matches your search" is the wrong answer to "we did not understand that
    // filter". Asserted by SET IDENTITY against the no-chip search, because a 60-result cap makes
    // a count comparison unable to tell suppression from coincidence.
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const base of spine()) {
        if (base.region.length > 0) continue;
        const none = searchAt(clock, base, 0);
        const junk = searchAt(clock, { ...base, region: ['not-a-region-at-all'] }, 0);
        const mixed = searchAt(clock, { ...base, region: ['van', 'not-a-region-at-all'] }, 0);
        const known = searchAt(clock, { ...base, region: ['van'] }, 0);
        checked += 1;
        const ids = (r: SearchResponse) => r.results.flatMap((i) => i.slots.map((s) => s.id)).sort().join(',');
        if (ids(junk) !== ids(none)) {
          violations.push(violation(clock, { ...base, region: ['not-a-region-at-all'] }, 'an unrecognised region chip changed the result set instead of being ignored'));
        }
        if (ids(mixed) !== ids(known)) {
          violations.push(violation(clock, { ...base, region: ['van', 'not-a-region-at-all'] }, 'adding an unrecognised chip beside a recognised one changed what the recognised one admits'));
        }
      }
    }
    expectInvariant('an unrecognised region value is ignored, not treated as match-nothing', violations, checked);
  });
});

describe('DISCLOSURE — the broadening ladder describes what it did', () => {
  it('every applied rung actually changed the declared context in the dimension it names', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response, baseline } of pairedCases()) {
      const before = baseline.context;
      const after = response.context;
      for (const rung of response.broadening.applied) {
        checked += 1;
        const changed = rungChangedContext(rung.key, rung.constraint, before, after);
        if (!changed) {
          violations.push(violation(clock, query, `rung ${rung.rung} (${rung.key}) is reported as applied but the declared context shows no change in that dimension`));
        }
      }
    }
    expectInvariant('an applied rung changed the dimension it names', violations, checked);
  });

  it('the applied rungs are exactly the alternatives marked applied, and the last one owns `total`', () => {
    // Every alternative chip promises a real count ("This weekend (12 results)"). The one the
    // engine actually applied is the one whose count IS the page — if those two disagree, every
    // other chip's number is an estimate wearing a promise.
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      const { applied, alternatives } = response.broadening;
      const markedApplied = alternatives.filter((a) => a.applied);
      checked += 1;
      if (applied.map((r) => r.key).join('>') !== markedApplied.map((a) => a.key).join('>')) {
        violations.push(
          violation(clock, query, `broadening.applied [${applied.map((r) => r.key).join(', ')}] disagrees with the alternatives marked applied [${markedApplied.map((a) => a.key).join(', ')}]`),
        );
      }
      const last = markedApplied[markedApplied.length - 1];
      if (last && last.count !== response.total) {
        violations.push(violation(clock, query, `the last applied rung (${last.key}) promises ${last.count} results but the page returned ${response.total}`));
      }
      if (applied.length > 0 && alternatives.length === 0) {
        violations.push(violation(clock, query, 'rungs were applied but no alternatives were published'));
      }
    }
    expectInvariant('applied rungs and their published counts agree with the page', violations, checked);
  });

  it('nothing about DISTANCE is ever disclosed for a search that has no origin to measure from', () => {
    // The sibling-half defect in broaden.ts: the radius RUNG was gated on hasOrigin while
    // activeConstraints was not, so the empty state went on naming "distance" as the blocker for
    // searches that were never distance-filtered. Same false disclosure, one function over.
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      if (response.origin != null) continue;
      checked += 1;
      if (appliedKeys(response).includes('radius_expand')) {
        violations.push(violation(clock, query, 'a radius_expand rung was applied to a search with no origin'));
      }
      const named = response.broadening.emptyState?.singleRelaxations.some((r) => r.constraint === 'radius');
      if (named) {
        violations.push(violation(clock, query, 'the empty-state explanation names "distance" for a search with no origin'));
      }
    }
    expectInvariant('distance is never disclosed as a constraint without an origin', violations, checked);
  });

  it('an empty-state explanation is published only when a parent can act on it', () => {
    // ⚠️ THIS IS MEASURED AGAINST THE UNBROADENED RUN, AND THE FIRST DRAFT THAT USED
    // `response.total` WAS WRONG — in exactly the way this file's header warns about. The engine
    // decides whether to explain from the PRIMARY (pre-broadening) count: a search with no exact
    // matches is always explained, "even if no single relaxation helps", and the ladder then pads
    // the page. So an explanation sitting above two broadened results is the DESIGNED outcome,
    // not a complaint about a page that is working — the explanation is why those results are
    // broadened ones. Judging it against the post-ladder total reported 145 correct behaviours as
    // defects. The baseline run (ladder declined) is the number the engine actually branched on.
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response, baseline } of pairedCases()) {
      checked += 1;
      const state = response.broadening.emptyState;
      const exact = baseline.total; // results before any relaxation — what the engine branches on
      if (state && exact > 0 && state.blockingConstraint == null) {
        violations.push(
          violation(clock, query, `an explanation naming no unlockable constraint was published for a search with ${exact} exact matches`),
        );
      }
      if (!state && exact === 0) {
        violations.push(violation(clock, query, 'a search with no exact matches was returned with no explanation of what emptied it'));
      }
      if (state && state.message.trim().length === 0) {
        violations.push(violation(clock, query, 'an explanation was published with an empty message'));
      }
      // `addsResults` is the honest "shows N more": it must be the yield MINUS what the parent can
      // already see, never the relaxed total (which overstates the remedy by exactly the number of
      // results already on screen).
      for (const relaxation of state?.singleRelaxations ?? []) {
        if (relaxation.addsResults !== Math.max(0, relaxation.wouldYield - exact)) {
          violations.push(
            violation(clock, query, `relaxing "${relaxation.constraint}" claims it adds ${relaxation.addsResults} but yields ${relaxation.wouldYield} against ${exact} already visible`),
          );
        }
      }
    }
    expectInvariant('the empty-state explanation is published exactly when it is actionable', violations, checked);
  });
});

describe('DISCLOSURE — sections and facets cannot contradict the list', () => {
  it('the primary list and the expected/seasonal section never contain the same listing', () => {
    const violations: Violation[] = [];
    let checked = 0;
    for (const { clock, query, response } of casesFor(3)) {
      if (response.expected.length === 0) continue;
      checked += 1;
      const primary = new Set(response.results.flatMap((i) => i.slots.map((s) => s.id)));
      for (const item of response.expected) {
        for (const slot of item.slots) {
          if (primary.has(slot.id)) {
            violations.push(violation(clock, query, `"${slot.id}" appears in BOTH the primary list and the expected section`));
          }
        }
      }
    }
    expectInvariant('the two result sections are disjoint', violations, checked);
  });

  it('facets.total always equals the page total it was computed for', () => {
    // facets.ts states this outright ("Always equals SearchResponse.total"). It is the one number
    // that makes every other facet count trustworthy: a rail that says "Vancouver 47" above a list
    // of 31 cards is the exact lie these counts exist to prevent.
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      for (const query of spine()) {
        const response = searchAt(clock, query, 3, true);
        checked += 1;
        if (!response.facets) {
          violations.push(violation(clock, query, 'facets were requested but not returned'));
          continue;
        }
        if (response.facets.total !== response.total) {
          violations.push(violation(clock, query, `facets.total is ${response.facets.total} but the page returned ${response.total} results`));
        }
      }
    }
    expectInvariant('facets.total equals the page total', violations, checked);
  });
});

/** Did an applied rung leave a trace in the dimension it claims to have relaxed? */
function rungChangedContext(
  key: string,
  constraint: string | undefined,
  before: SearchContext,
  after: SearchContext,
): boolean {
  switch (key) {
    case 'synonym_widen':
      // Documented as INERT (types.ts widenText): it changes the flag and nothing else, and it is
      // deliberately excluded from the parent-facing notice. The flag IS its trace.
      return after.widenText === true;
    case 'radius_expand':
      return after.radiusKm > before.radiusKm;
    case 'adjacent_time':
      return after.timeOfDayAdjacent === true;
    case 'adjacent_date':
      return !sameWindow(windowOf(before.date), windowOf(after.date));
    case 'adjacent_age':
      return after.ageBands.length > before.ageBands.length;
    case 'drop_chip':
      return (
        constraint != null &&
        (before as unknown as Record<string, unknown>)[constraint] === true &&
        (after as unknown as Record<string, unknown>)[constraint] === false
      );
    case 'expected_section':
      return after.includeExpected === true;
    default:
      return false;
  }
}
