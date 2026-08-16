// lib/search/broaden.ts — Empty-state broadening ladder + constraint explanation (G-T20-1/2, FR-14, UXR-07, TSD §5A.5).
//
// Deterministic ladder when a query returns too few results:
//   (1) synonym/category widen → (2) radius expand (10→20km) → (3) adjacent dates/times
//   → (4) drop the most-restrictive chip → (5) surface expected/seasonal in a SEPARATE section.
// The UX must always explain WHICH constraint caused zero results (Flow 5); `explainEmptyState`
// probes single-constraint relaxations to name the blocking one.

import type { DateIntent, SearchContext } from './types';
import { addDaysIso } from './time/vancouver';

export type ConstraintKey =
  | 'text'
  | 'radius'
  | 'timeOfDay'
  | 'date'
  | 'bookableNow'
  | 'rainyDay'
  | 'dropIn'
  | 'costFree'
  // No 'costMax': the max-price ceiling was removed from the product (Jon's ruling,
  // 2026-08-11 — see lib/search/parse.ts). A constraint that can never be active cannot be
  // the thing blocking a query, so it must not appear in the ladder or the explanation.
  | 'ageBands';

export type BroadenRungKey =
  | 'synonym_widen'
  | 'radius_expand'
  | 'adjacent_time'
  | 'adjacent_date'
  | 'drop_chip'
  | 'expected_section';

export interface BroadenRung {
  rung: number;
  key: BroadenRungKey;
  label: string;
  /** Cumulative broadened context to re-run search with. */
  context: SearchContext;
}

/** Human-facing description per constraint (for the empty-state explanation). */
export const CONSTRAINT_LABELS: Record<ConstraintKey, string> = {
  text: 'search terms',
  radius: 'distance',
  timeOfDay: 'time of day',
  date: 'date',
  bookableNow: 'Bookable Now filter',
  rainyDay: 'Rainy-day (indoor) filter',
  dropIn: 'Drop-in filter',
  costFree: 'Free filter',
  ageBands: 'age filter',
};

const RADIUS_LADDER: Record<number, number> = { 5: 10, 10: 20 };
function nextRadius(km: number): number {
  return RADIUS_LADDER[km] ?? Math.max(km, 20);
}

/**
 * How far the `adjacent_date` rung (rung 3) reaches on either side of the window the parent
 * actually asked for. A BOUNDED widen, mirroring the radius ladder's shape — 10km→20km is
 * "further", not "anywhere", and "nearby dates" has to mean the same kind of thing.
 *
 * Three days is the smallest window that reaches the next weekend from a weekday and the
 * previous/next weekday from a weekend, which is the real substitution a parent is willing to
 * make ("not Wednesday then — what about Saturday?"). Wider than that stops being an answer to
 * the question that was asked.
 */
export const ADJACENT_DATE_DAYS = 3;

/**
 * Widen a date intent to the inclusive window [start − days, end + days].
 *
 * THIS RUNG USED TO SET `date: null`. That is not a widen, it is a removal: the parent's date
 * request was discarded wholesale, the query became date-unconstrained, and the ladder then
 * stopped because an unfiltered catalogue trivially clears `minResults`. A parent who asked for
 * one sparse day got the entire catalogue back, silently, under a label that said "Included
 * nearby dates" — the label described a behaviour the code did not have. The fix is to make the
 * code do what the label always claimed.
 *
 * Returns null when there is nothing to widen AROUND (`isoDate` unset) — such an intent already
 * filters nothing (see filters/time.ts matchesDate), so there is no rung to offer.
 */
export function widenDateIntent(date: DateIntent, days: number = ADJACENT_DATE_DAYS): DateIntent | null {
  if (!date.isoDate) return null;
  const end = date.endIsoDate ?? date.isoDate;
  return {
    kind: 'range',
    isoDate: addDaysIso(date.isoDate, -days),
    endIsoDate: addDaysIso(end, days),
    weekday: null,
  };
}

/** Chips ordered most-restrictive → least, for "drop the most restrictive chip" (rung 4). */
const CHIP_RESTRICTIVENESS: ConstraintKey[] = ['bookableNow', 'dropIn', 'rainyDay', 'costFree', 'ageBands'];

/** Which constraints are actually active (present) in this context. */
export function activeConstraints(ctx: SearchContext): ConstraintKey[] {
  const active: ConstraintKey[] = [];
  if (ctx.terms.length > 0) active.push('text');
  if (ctx.radiusKm < 20) active.push('radius');
  if (ctx.timeOfDay) active.push('timeOfDay');
  if (ctx.date) active.push('date');
  if (ctx.bookableNow) active.push('bookableNow');
  if (ctx.rainyDay) active.push('rainyDay');
  if (ctx.dropIn) active.push('dropIn');
  if (ctx.costFree) active.push('costFree');
  if (ctx.ageBands.length > 0) active.push('ageBands');
  return active;
}

/** Return a context with exactly ONE constraint relaxed (for probing / drop-chip). */
export function relaxSingle(ctx: SearchContext, key: ConstraintKey): SearchContext {
  switch (key) {
    case 'text': return { ...ctx, terms: [], widenText: true };
    case 'radius': return { ...ctx, radiusKm: nextRadius(ctx.radiusKm) };
    case 'timeOfDay': return { ...ctx, timeOfDay: null };
    case 'date': return { ...ctx, date: null };
    case 'bookableNow': return { ...ctx, bookableNow: false };
    case 'rainyDay': return { ...ctx, rainyDay: false };
    case 'dropIn': return { ...ctx, dropIn: false };
    case 'costFree': return { ...ctx, costFree: false };
    case 'ageBands': return { ...ctx, ageBands: [] };
  }
}

export interface ConstraintExplanation {
  /** The single constraint whose removal yields the most results (the thing to explain). */
  blockingConstraint: ConstraintKey | null;
  message: string;
  /** Per-constraint: how many results removing just that one would yield. */
  singleRelaxations: Array<{ constraint: ConstraintKey; label: string; wouldYield: number }>;
}

/**
 * Name the blocking constraint by probing each active constraint's single relaxation.
 * `probe(ctx)` returns the result count for a context (engine-supplied, fixture or DB).
 */
export function explainEmptyState(
  ctx: SearchContext,
  probe: (variant: SearchContext) => number,
): ConstraintExplanation {
  const active = activeConstraints(ctx);
  const singleRelaxations = active.map((constraint) => ({
    constraint,
    label: CONSTRAINT_LABELS[constraint],
    wouldYield: probe(relaxSingle(ctx, constraint)),
  }));
  // Blocking = the highest-priority FILTER whose relaxation unlocks results. Relaxing the
  // search terms ('text') abandons the query rather than unblocking it, so it ranks last —
  // only named when no filter relaxation helps.
  const priority: ConstraintKey[] = ['radius', 'timeOfDay', 'date', 'bookableNow', 'dropIn', 'rainyDay', 'costFree', 'ageBands', 'text'];
  const helpful = singleRelaxations
    .filter((r) => r.wouldYield > 0)
    .sort((a, b) => priority.indexOf(a.constraint) - priority.indexOf(b.constraint) || b.wouldYield - a.wouldYield);

  const blocking = helpful[0]?.constraint ?? null;
  const message = blocking
    ? `No exact matches. The ${CONSTRAINT_LABELS[blocking]} is the main thing narrowing your results — relaxing it shows ${helpful[0].wouldYield} more.`
    : active.length > 0
      ? `No matches even after relaxing individual filters — try broadening your search.`
      : `No activities found.`;

  return { blockingConstraint: blocking, message, singleRelaxations };
}

/**
 * Build the deterministic, CUMULATIVE broadening ladder (§5A.5). Each rung's `context`
 * includes all prior relaxations, so the engine can walk rungs until it has enough results.
 */
export function buildBroadeningLadder(ctx: SearchContext): BroadenRung[] {
  const rungs: BroadenRung[] = [];
  let cur = ctx;
  let n = 0;

  // (1) synonym / category widen
  if (ctx.terms.length > 0) {
    cur = { ...cur, widenText: true };
    rungs.push({ rung: ++n, key: 'synonym_widen', label: 'Widened to related categories and synonyms', context: cur });
  }
  // (2) radius expand
  if (ctx.radiusKm < 20) {
    cur = { ...cur, radiusKm: nextRadius(cur.radiusKm) };
    rungs.push({ rung: ++n, key: 'radius_expand', label: `Expanded distance to ${cur.radiusKm}km`, context: cur });
  }
  // (3) adjacent times, then dates
  if (ctx.timeOfDay) {
    cur = { ...cur, timeOfDay: null };
    rungs.push({ rung: ++n, key: 'adjacent_time', label: 'Included other times of day', context: cur });
  }
  // Nearby dates — a bounded window around the request, NEVER `date: null`. See widenDateIntent.
  const nearbyDates = ctx.date ? widenDateIntent(ctx.date) : null;
  if (nearbyDates && nearbyDates.endIsoDate) {
    cur = { ...cur, date: nearbyDates };
    rungs.push({
      rung: ++n,
      key: 'adjacent_date',
      // The label states the window it actually applied, so a rung can never again describe
      // one behaviour while performing another.
      label: `Included nearby dates (${nearbyDates.isoDate} to ${nearbyDates.endIsoDate})`,
      context: cur,
    });
  }
  // (4) drop the most restrictive chip
  const chip = CHIP_RESTRICTIVENESS.find((c) => activeConstraints(ctx).includes(c));
  if (chip) {
    cur = relaxSingle(cur, chip);
    rungs.push({ rung: ++n, key: 'drop_chip', label: `Dropped the ${CONSTRAINT_LABELS[chip]}`, context: cur });
  }
  // (5) expected / seasonal / evergreen in a separate section
  cur = { ...cur, includeExpected: true };
  rungs.push({ rung: ++n, key: 'expected_section', label: 'Showing expected & seasonal activities separately', context: cur });

  return rungs;
}
