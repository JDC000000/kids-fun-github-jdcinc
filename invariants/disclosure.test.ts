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
  expectInvariant,
  localDaySpan,
  localMinuteSpan,
  overlaps,
  pinClock,
  unpinClock,
  violation,
  weekdayOf,
  type Violation,
} from './_harness';
import { casesFor, searchAt } from './_run';
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

/** The inclusive local-day window a DateIntent selects, or null when it constrains nothing. */
function windowOf(date: DateIntent | null): { from: string; to: string } | null {
  if (!date || !date.isoDate) return null;
  return { from: date.isoDate, to: date.kind === 'range' && date.endIsoDate ? date.endIsoDate : date.isoDate };
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
      for (const item of response.results) {
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

  it('when=weekend resolves to a weekend day that is not in the past and not more than a week out', () => {
    // DELIBERATELY WEAK. The product currently resolves "this weekend" to the upcoming Saturday
    // only; whether Sunday should be included is a PRODUCT question (it bites on the DST clock
    // below, which falls on a Sunday). Pinning today's answer here would make a future product
    // decision look like a regression, so this asserts only what must be true under any answer.
    const violations: Violation[] = [];
    let checked = 0;
    for (const clock of CLOCKS) {
      const query = { ...DEFAULT_QUERY, when: 'weekend' as const };
      const response = searchAt(clock, query, 0);
      const today = localDay(clock.utc);
      const iso = response.context.date?.isoDate ?? null;
      checked += 1;
      if (iso == null) {
        violations.push(violation(clock, query, 'when=weekend resolved to no date at all'));
        continue;
      }
      const weekday = weekdayOf(iso);
      if (iso < today) violations.push(violation(clock, query, `when=weekend resolved to ${iso}, which is before today (${today})`));
      if (iso > addDays(today, 7)) violations.push(violation(clock, query, `when=weekend resolved to ${iso}, more than a week after today (${today})`));
      if (weekday !== 6 && weekday !== 0) {
        violations.push(violation(clock, query, `when=weekend resolved to ${iso}, a ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday]} — not a weekend day`));
      }
    }
    expectInvariant('when=weekend resolves to an upcoming weekend day', violations, checked);
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
      for (const item of response.results) {
        const span = localMinuteSpan(item.listing);
        // An open-hours row with NO published hours is documented as "don't hide it" — exempt.
        if (!span) continue;
        checked += 1;
        if (!overlaps(span, window)) {
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

  it('pins the hours the day-part chips can reach — and names what falls outside them', () => {
    // ⚠️ A DOCUMENTED GAP, PINNED RATHER THAN ASSERTED AWAY. The three chips span 05:00–22:00
    // local and nothing else: an occurrence starting at 22:15 matches morning, afternoon and
    // evening ALL false, so it is reachable only through "Any" and is invisible to a parent using
    // the Evening chip. Measured, at the clock this suite was commissioned around:
    //     local 22:15 → []      local 23:00 → []      local 00:30 → []      local 04:30 → [morning]
    //
    // This is NOT written as a violation, because whether the day should end at 22:00 is a PRODUCT
    // question and nobody has ruled on it — encoding an assumption here is exactly the mistake this
    // suite exists not to make. It is written as a pin with the consequence stated, so that the day
    // someone changes the windows, they read this and know what it was hiding.
    for (const clock of CLOCKS) {
      const late = searchAt(clock, { ...DEFAULT_QUERY, timeOfDay: 'evening' }, 0);
      for (const item of late.results) {
        const span = localMinuteSpan(item.listing);
        if (!span) continue;
        expect(
          span.from < DAY_PART.evening.to,
          `"${item.listing.id}" starts at local minute ${span.from}, at or after the evening window's close ` +
            `(${DAY_PART.evening.to}) — the day-part windows have moved; see this test's note about the 22:00–05:00 gap`,
        ).toBe(true);
      }
    }
    expect(DAY_PART.morning.from).toBe(5 * 60);
    expect(DAY_PART.evening.to).toBe(22 * 60);
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
      for (const item of response.results) {
        const span = localMinuteSpan(item.listing);
        if (!span) continue;
        checked += 1;
        if (overlaps(span, forbidden) && !overlaps(span, allowed)) {
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
      for (const item of [...response.results, ...response.expected]) {
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
