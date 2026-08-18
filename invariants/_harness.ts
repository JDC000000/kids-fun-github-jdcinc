// invariants/_harness.ts — Pinned clocks, result-set identity, and how a violation is reported.
//
// THREE THINGS THIS FILE EXISTS FOR.
//
// 1. PINNED CLOCKS. Several of the defects this suite is aimed at are time-of-day dependent —
//    a "today" that is computed in UTC is correct all morning in Vancouver and wrong after 17:00
//    (PDT) or 16:00 (PST), because the UTC calendar has already rolled over. A suite that passes
//    at 07:00 and fails at 22:35 is worse than no suite, so the clock is never the machine's: it
//    is one of CLOCKS below, and the corpus is regenerated around each one.
//
// 2. RESULT-SET IDENTITY. The unit of comparison is the set of OCCURRENCE (slot) ids behind the
//    cards, never the card count and never the representative id. Counts are the documented trap
//    (a flat cap masks filtering), but representative ids are a subtler one: results are collapsed
//    to one card per series per local day AFTER sorting, so removing one occurrence with a filter
//    can promote a different member of the same group to representative. Compared by
//    representative, a strictly narrowing filter then looks like it INTRODUCED a result. Compared
//    by slot ids, it does not — because it did not.
//
// 3. FAILURE MESSAGES A HUMAN CAN ACT ON. This suite runs in a report-only CI lane, so a failure
//    nobody can reproduce is worthless. Every violation carries the exact query (as JSON), the
//    clock it was run at, and the listing id that broke the rule — enough to paste into a test.

import { expect, vi } from 'vitest';
import type { ListingRecord } from '../lib/search/types';
import type { SearchResponse, SearchResultItem } from '../lib/search/engine';
import { localDay, localMinutes, localParts } from './_time';
import { coverageNote, queryKey, type Query } from './_space';

export interface Clock {
  label: string;
  /** The pinned instant, as UTC. */
  utc: Date;
  /** Why this clock is in the list — every one of them is here for a stated reason. */
  why: string;
}

/**
 * The pinned clocks. Every one has the UTC calendar day and the Vancouver calendar day in a
 * DIFFERENT relationship, because that relationship is the bug class.
 */
export const CLOCKS: Clock[] = [
  {
    label: '07:15 PDT (UTC day == local day)',
    utc: new Date('2026-08-18T14:15:00Z'),
    why: 'Control. A UTC-day implementation and a local-day implementation agree here, so anything that fails at this clock is not a timezone defect.',
  },
  {
    label: '22:35 PDT (UTC day is ALREADY tomorrow)',
    utc: new Date('2026-08-19T05:35:00Z'),
    why: 'Required by the brief. 22:35 America/Vancouver on 2026-08-18 is 05:35Z on 2026-08-19 — a UTC-derived "today" is off by one, in the direction that silently empties an evening search.',
  },
  {
    label: '22:35 PST (winter offset, UTC day is ALREADY tomorrow)',
    utc: new Date('2026-01-16T06:35:00Z'),
    why: 'The same late-evening rollover at UTC-8 rather than UTC-7, so a hard-coded -7 offset fails here and passes at the clock above.',
  },
  {
    label: '01:30 PDT on the DST fall-back Sunday',
    utc: new Date('2026-11-01T08:30:00Z'),
    why: '2026-11-01 is the fall-back transition and a Sunday. 01:30 local occurs twice that day, and Sunday is the weekday on which "this weekend" has to decide whether it means today or the next Saturday.',
  },
];

/** Pin `Date` (only) to a clock. Anything in the stack that reaches for `new Date()` sees this. */
export function pinClock(clock: Clock): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock.utc);
}

export function unpinClock(): void {
  vi.useRealTimers();
}

// ── Result-set identity ──────────────────────────────────────────────────────────────────────

/** Every occurrence behind these cards. THE canonical result-set identity for this suite. */
export function slotIds(items: SearchResultItem[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) for (const slot of item.slots) out.add(slot.id);
  return out;
}

/** Members of `subset` that are not in `superset`, sorted — empty means the subset property holds. */
export function notContainedIn(subset: Set<string>, superset: Set<string>): string[] {
  return [...subset].filter((id) => !superset.has(id)).sort();
}

/**
 * Every item a response surfaced, in EVERY section.
 *
 * ONE definition, because "everywhere a listing can appear" is now a three-element list and an
 * inline `[...results, ...expected]` at a call site is how an invariant silently stops seeing a
 * whole section. That is not hypothetical: `ageUnconfirmed` (the age-not-stated split, Jon's
 * ruling 2026-08-18) holds exactly the listings an age-related invariant most needs to inspect,
 * and every safety invariant of the form "X must never be surfaced" is weakened — quietly, while
 * still passing — by a section it does not look in.
 */
export function allItems(response: SearchResponse): SearchResultItem[] {
  return [...primaryItems(response), ...response.expected];
}

/**
 * The PRIMARY page — both the confirmed-age section and the age-not-stated one, in render order.
 *
 * The distinction from `allItems` is the expected/seasonal section, which is genuinely a
 * different result class: the strict temporal and status filters are deliberately not applied to
 * it (lib/search/filters/predicate.ts), so an invariant about what the primary list is allowed to
 * contain would be asserted against listings it was never meant to describe.
 */
export function primaryItems(response: SearchResponse): SearchResultItem[] {
  return [...response.results, ...response.ageUnconfirmed];
}

/** Every listing a response surfaced, in every section, as records. */
export function allListings(response: SearchResponse): ListingRecord[] {
  return allItems(response).map((item) => item.listing);
}

/**
 * Every occurrence behind the PRIMARY page — both the confirmed-age section and the
 * age-unconfirmed one.
 *
 * This is the identity the monotonicity relations are stated in. Filtering is about what a search
 * can REACH, and the age split moves cards between sections without changing reachability, so a
 * subset property asserted against `results` alone would read a re-sectioning as a removal and
 * stop measuring the filter. Compared as slot ids for the reason `slotIds` documents.
 */
export function primarySlotIds(response: SearchResponse): Set<string> {
  return slotIds(primaryItems(response));
}

// ── Oracles (test-owned; deliberately NOT the product's own predicates) ──────────────────────

/** Local day-part windows, in Vancouver minutes past midnight. Restated here, not imported. */
export const DAY_PART: Record<string, { from: number; to: number }> = {
  morning: { from: 5 * 60, to: 12 * 60 },
  afternoon: { from: 12 * 60, to: 17 * 60 },
  evening: { from: 17 * 60, to: 22 * 60 },
};

/** The union window a day-part widens to when the adjacent-time rung has fired. */
export const ADJACENT_DAY_PART: Record<string, { from: number; to: number }> = {
  morning: { from: 5 * 60, to: 17 * 60 },
  afternoon: { from: 5 * 60, to: 22 * 60 },
  evening: { from: 12 * 60, to: 22 * 60 },
};

/**
 * The inclusive local day span an occurrence runs over, or null when it belongs to no single day.
 *
 * Null is NOT a failure state: an open-hours attraction (an aquarium, a mini-train) has no date
 * and the product documents it as available every day, so date invariants exempt it rather than
 * asserting a containment it cannot have.
 */
export function localDaySpan(listing: ListingRecord): { first: string; last: string } | null {
  if (listing.openHours) return null;
  if (!listing.startDatetimeUtc) return null;
  const start = new Date(listing.startDatetimeUtc);
  if (Number.isNaN(start.getTime())) return null;
  const first = localDay(start);
  if (!listing.endDatetimeUtc) return { first, last: first };
  const end = new Date(listing.endDatetimeUtc);
  if (Number.isNaN(end.getTime())) return { first, last: first };
  const endDay = localDay(end);
  return { first, last: endDay > first ? endDay : first };
}

/** The local minute span an occurrence occupies, unwrapped past midnight. Null for open-hours. */
export function localMinuteSpan(listing: ListingRecord): { from: number; to: number } | null {
  if (listing.openHours) {
    return listing.openHoursLocal
      ? { from: listing.openHoursLocal.startMin, to: listing.openHoursLocal.endMin }
      : null;
  }
  if (!listing.startDatetimeUtc) return null;
  const from = localMinutes(new Date(listing.startDatetimeUtc));
  let to = listing.endDatetimeUtc ? localMinutes(new Date(listing.endDatetimeUtc)) : from;
  if (to < from) to += 24 * 60;
  if (to === from) to += 1;
  return { from, to };
}

/** Half-open interval overlap. */
export function overlaps(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from < b.to && b.from < a.to;
}

/** Vancouver-local weekday (0=Sun) of a local YYYY-MM-DD. */
export function weekdayOf(isoDate: string): number {
  return localParts(new Date(`${isoDate}T12:00:00-07:00`)).weekday;
}

// ── Violations ───────────────────────────────────────────────────────────────────────────────

export interface Violation {
  clock: string;
  query: string;
  detail: string;
}

export function violation(clock: Clock, query: Query, detail: string): Violation {
  return { clock: clock.label, query: queryKey(query), detail };
}

const MAX_REPORTED = 12;

/**
 * Assert an invariant held, and prove the assertion was not vacuous.
 *
 * `checked` matters as much as `violations`: an invariant over a corpus that can never violate it
 * is a green test that measures nothing, and this suite generates its own corpus, so that failure
 * mode is one typo away. Every call therefore states how many observations it made and fails if
 * it made none.
 */
export function expectInvariant(
  name: string,
  violations: Violation[],
  checked: number,
): void {
  const shown = violations.slice(0, MAX_REPORTED);
  const more = violations.length > MAX_REPORTED ? `\n  … and ${violations.length - MAX_REPORTED} more` : '';
  expect(
    violations.length,
    violations.length === 0
      ? ''
      : `INVARIANT VIOLATED — ${name}\n${coverageNote(name, checked)}\n` +
        shown
          .map((v, i) => `  [${i + 1}] clock: ${v.clock}\n      query: ${v.query}\n      ${v.detail}`)
          .join('\n') +
        more,
  ).toBe(0);
  expect(checked, `${name} made no observations — the corpus or the query space cannot exercise it`).toBeGreaterThan(0);
}
