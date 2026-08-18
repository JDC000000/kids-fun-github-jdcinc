// invariants/_space.ts — The combinatorial filter space, and how this suite samples it.
//
// The product's filter surface is region × age × date × time-of-day × cost × three quick chips ×
// the registration opt-in × an optional geo origin × five sorts × the text query. That is 752,640
// distinct selections. Enumerating them at four pinned clocks is not a test, it is a batch job,
// so this module does two things instead — and SAYS which, because a suite that silently caps its
// own coverage reads as "we checked everything" when it did not (see `coverageNote`).
//
//   1. A SPINE, enumerated exhaustively: every value of every dimension, once, with every other
//      dimension at its default. Nothing can be added to a dimension and never exercised.
//   2. A deterministic SAMPLE of full combinations, drawn with a fixed-seed LCG. Same sample on
//      every machine, every run — a metamorphic suite that reshuffled its own inputs would find a
//      different bug each night and none of them twice.
//
// Sampling is what makes the trade explicit rather than hidden: raising SAMPLE_SIZE buys coverage
// linearly in runtime, and `coverageNote()` prints exactly what fraction is being bought.

import type { AgeBandKey, SortKey } from '../lib/search/types';
import type { SearchRequest } from '../lib/search/engine';
import type { TimeOfDayKey, WhenKey } from '../app/search/_lib/params';
import { CORPUS_TOKEN, ORIGIN_COORDS, lcg } from './_corpus';

export interface Query {
  q: string;
  region: string[];
  ageBands: AgeBandKey[];
  when: WhenKey;
  timeOfDay: TimeOfDayKey;
  free: boolean;
  dropIn: boolean;
  rainyDay: boolean;
  bookableNow: boolean;
  includeRegistration: boolean;
  /** near_me origin at the East-Van point, which also turns the radius filter on. */
  origin: boolean;
  sort: SortKey;
}

/** Region chip selections. Includes a value no hierarchy knows, and a mix of known + unknown. */
export const REGION_VALUES: string[][] = [
  [],
  ['van'],
  ['van-east'],
  ['bby'],
  ['nvan', 'rmd'],
  ['not-a-region-at-all'],
  ['van', 'not-a-region-at-all'],
];

export const AGE_VALUES: AgeBandKey[][] = [
  [],
  ['under2'],
  ['2-4'],
  ['5-9'],
  ['10-14'],
  ['15+'],
  ['under2', '15+'],
];

export const WHEN_VALUES: WhenKey[] = ['any', 'today', 'tomorrow', 'weekend'];
export const TIME_VALUES: TimeOfDayKey[] = ['any', 'morning', 'afternoon', 'evening'];
export const SORT_VALUES: SortKey[] = ['best_match', 'distance', 'soonest', 'lowest_cost', 'newest'];
/** '' is browse mode (every listing is a candidate); CORPUS_TOKEN addresses the whole corpus. */
export const TEXT_VALUES: string[] = ['', CORPUS_TOKEN, 'gym'];

export const DEFAULT_QUERY: Query = {
  q: '',
  region: [],
  ageBands: [],
  when: 'any',
  timeOfDay: 'any',
  free: false,
  dropIn: false,
  rainyDay: false,
  bookableNow: false,
  includeRegistration: false,
  origin: false,
  sort: 'best_match',
};

/** Total distinct selections this space contains — the denominator `coverageNote` reports. */
export const SPACE_SIZE =
  TEXT_VALUES.length *
  REGION_VALUES.length *
  AGE_VALUES.length *
  WHEN_VALUES.length *
  TIME_VALUES.length *
  2 * // free
  2 * // dropIn
  2 * // rainyDay
  2 * // bookableNow
  2 * // includeRegistration
  2 * // origin
  SORT_VALUES.length;

/** Stable, human-readable identity for a selection — this is what a failure message prints. */
export function queryKey(query: Query): string {
  return JSON.stringify({
    q: query.q,
    region: query.region,
    ageBands: query.ageBands,
    when: query.when,
    timeOfDay: query.timeOfDay,
    free: query.free,
    dropIn: query.dropIn,
    rainyDay: query.rainyDay,
    bookableNow: query.bookableNow,
    includeRegistration: query.includeRegistration,
    origin: query.origin,
    sort: query.sort,
  });
}

/** One query per value of every dimension, all other dimensions at their default. */
export function spine(): Query[] {
  const out: Query[] = [{ ...DEFAULT_QUERY }];
  const add = (patch: Partial<Query>) => out.push({ ...DEFAULT_QUERY, ...patch });
  TEXT_VALUES.forEach((q) => add({ q }));
  REGION_VALUES.forEach((region) => add({ region }));
  AGE_VALUES.forEach((ageBands) => add({ ageBands }));
  WHEN_VALUES.forEach((when) => add({ when }));
  TIME_VALUES.forEach((timeOfDay) => add({ timeOfDay }));
  SORT_VALUES.forEach((sort) => add({ sort }));
  [true, false].forEach((v) => {
    add({ free: v });
    add({ dropIn: v });
    add({ rainyDay: v });
    add({ bookableNow: v });
    add({ includeRegistration: v });
    add({ origin: v });
  });
  return dedupe(out);
}

/** Deterministic draw of full combinations. */
export function sample(count: number, seed: number): Query[] {
  const rng = lcg(seed);
  const of = <T,>(list: readonly T[]): T => list[Math.floor(rng() * list.length) % list.length];
  const bool = () => rng() < 0.5;
  const out: Query[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      q: of(TEXT_VALUES),
      region: of(REGION_VALUES),
      ageBands: of(AGE_VALUES),
      when: of(WHEN_VALUES),
      timeOfDay: of(TIME_VALUES),
      free: bool(),
      dropIn: bool(),
      rainyDay: bool(),
      bookableNow: bool(),
      includeRegistration: bool(),
      origin: bool(),
      sort: of(SORT_VALUES),
    });
  }
  return out;
}

/** Spine + deterministic sample, de-duplicated and ordered so every run walks the same list. */
export function querySpace(sampleSize: number, seed: number): Query[] {
  return dedupe([...spine(), ...sample(sampleSize, seed)]);
}

function dedupe(queries: Query[]): Query[] {
  const seen = new Map<string, Query>();
  for (const query of queries) {
    const key = queryKey(query);
    if (!seen.has(key)) seen.set(key, query);
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, q]) => q);
}

export interface RequestOptions {
  /** 0 declines the broadening ladder entirely (the digest's opt-out). Default 3. */
  minResults?: number;
  facets?: boolean;
}

/**
 * A `Query` as the engine's own request shape.
 *
 * NO `limit` IS EVER SET, deliberately. The known gotcha in this area is that a flat result cap
 * masks filtering when you compare counts; this suite compares SETS, but a cap would still hide
 * membership at the tail, so the cap is simply not applied and every invariant sees the whole set.
 */
export function toRequest(query: Query, now: Date, opts: RequestOptions = {}): SearchRequest {
  return {
    q: query.q,
    now,
    origin: query.origin ? { mode: 'near_me', coords: { ...ORIGIN_COORDS } } : null,
    regionChipIds: query.region,
    ageBands: query.ageBands,
    when: query.when,
    timeOfDay: query.timeOfDay,
    free: query.free,
    dropIn: query.dropIn,
    rainyDay: query.rainyDay,
    bookableNow: query.bookableNow,
    includeRegistration: query.includeRegistration,
    sort: query.sort,
    minResults: opts.minResults ?? 3,
    facets: opts.facets,
  };
}

/** What this run actually covered, printed by every suite so coverage is never implied. */
export function coverageNote(label: string, checked: number): string {
  const pct = ((checked / SPACE_SIZE) * 100).toFixed(3);
  return `${label}: ${checked} of ${SPACE_SIZE} selections (${pct}%), deterministic fixed-seed sample — the remainder is NOT covered by this run.`;
}
