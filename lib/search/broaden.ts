// lib/search/broaden.ts — Empty-state broadening ladder + constraint explanation (G-T20-1/2, FR-14, UXR-07, TSD §5A.5).
//
// Deterministic ladder when a query returns too few results:
//   (1) synonym/category widen → (2) radius expand (10→20km) → (3) adjacent dates/times
//   → (4) drop the most-restrictive chip → (5) surface expected/seasonal in a SEPARATE section.
// The UX must always explain WHICH constraint caused zero results (Flow 5); `explainEmptyState`
// probes single-constraint relaxations to name the blocking one.

import type { DateIntent, SearchContext } from './types';
import { addDaysIso } from './time/vancouver';
import { ADJACENT_DAY_PARTS } from './filters/time';
import { adjacentAgeBands } from './filters/age';

/** What the engine knows about the request that the context alone cannot express. */
export interface BroadeningOptions {
  /**
   * Whether a geo origin was resolved. Default true (offer the rung) so existing callers are
   * unchanged; the engine passes the real answer. See the radius rung for why it matters.
   */
  hasOrigin?: boolean;
  /**
   * The region chips currently applied (structured `region=` param). Absent/empty → the parent
   * is not filtering by area.
   *
   * It has to be passed in because region chips are the ONE narrowing filter that does not live
   * on `SearchContext` — they are carried beside it, as a separate argument, all the way down to
   * `filters/predicate.ts`. That structural difference is exactly why they went unexplained: see
   * `activeConstraints` below.
   */
  regionChipIds?: string[];
}

export type ConstraintKey =
  | 'text'
  | 'radius'
  // Region chips. NOT a SearchContext field — see BroadeningOptions.regionChipIds.
  | 'region'
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
  | 'adjacent_age'
  | 'drop_chip'
  | 'expected_section';

export interface BroadenRung {
  rung: number;
  key: BroadenRungKey;
  label: string;
  /**
   * Which constraint this rung acted on, when the rung's key alone does not say. Set for
   * `drop_chip`, whose whole job is picking ONE of several chips — without it a consumer would
   * have to parse the human label to find out which filter was set aside, and a notice that
   * misnames the filter it dropped is the same class of defect as one that says nothing.
   */
  constraint?: ConstraintKey;
  /** Cumulative broadened context to re-run search with. */
  context: SearchContext;
}

/**
 * A `BroadenRung`, plus a REAL pre-computed result count — "This weekend (12 results)" needs a
 * number behind the chip, not just the label. `BroadenRung` alone (see above) carries no count:
 * it is pure and has no repository to count against, so this shape only exists on the engine
 * side (lib/search/engine.ts), built by re-running the SAME primary pipeline the ladder itself
 * runs for each rung it actually applies — never a separate, cheaper-but-divergent estimate.
 * That is what lets a UI chip promise "7 results" and be right when a parent taps it.
 */
export interface BroadenAlternative {
  rung: number;
  key: BroadenRungKey;
  label: string;
  constraint?: ConstraintKey;
  /** Total primary results this rung's CUMULATIVE context would yield if applied. */
  count: number;
  /**
   * True when this rung is already reflected in the CURRENT results (it is one of
   * `SearchResponse.broadening.applied`). A chip only makes sense to OFFER when this is false —
   * offering to do something that already happened is not an alternative, it is the status quo.
   */
  applied: boolean;
  /**
   * The cumulative context this rung's count was measured against — same shape as
   * `BroadenRung.context`, carried through so a chip can be built into a real `/search` link
   * (radiusKm / date / ageBands / the dropped chip) without a consumer re-parsing `label`.
   */
  context: SearchContext;
}

/** Human-facing description per constraint (for the empty-state explanation). */
export const CONSTRAINT_LABELS: Record<ConstraintKey, string> = {
  text: 'search terms',
  radius: 'distance',
  region: 'area filter',
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

/**
 * Chips ordered most-restrictive → least, for "drop the most restrictive chip".
 *
 * Every entry is an OPT-IN BOOLEAN the parent switched on. Off is the only relaxation a
 * boolean has, so dropping one is the only move available here — which is why this rung stays
 * a drop while the graded constraints (date, time of day, age) each got a bounded widen
 * instead. What changes is that it can no longer do it silently: the rung is disclosed by the
 * /search broadening notice like every other rung that fired.
 *
 * TWO CONSTRAINTS WERE REMOVED FROM THIS LIST, for different reasons.
 *
 * `ageBands` is not a boolean at all — it is an ordered scale with a middle ground — and
 * relaxing it here meant `ageBands: []`, handing a parent filtering for an under-2 the whole
 * catalogue including teen programming. It now has its own bounded `adjacent_age` rung
 * (filters/age.ts adjacentAgeBands), so the ladder can never empty an age selection again.
 *
 * `costFree` IS a boolean, and it is still not droppable, because what it constrains is
 * different in kind. Measured on production 2026-08-16: `?q=free&region=bby` returned two
 * confirmed $21.25 hockey sessions with `context.costFree: false`, while the same query with
 * `minResults=0` — broadening declined — returned NOTHING. The honest answer was "there is
 * nothing free in Burnaby"; this rung turned it into an invoice. The other three chips are
 * conveniences, and dropping one still shows a parent something they can do. A parent
 * filtering for free may be unable to pay, so relaxing cost does not widen their search, it
 * discards the only part of it that was binding. Nothing here may bill a parent who asked for
 * free — the ladder pads a thin answer, and a price is not padding.
 *
 * This does NOT touch Jon's unknown-cost ruling (filters/cost.ts): listings whose price the
 * source never published stay visible under the Free filter, labelled honestly. That ruling is
 * about a cost we DO NOT HOLD. $21.25 is a cost we hold, know, and print.
 */
const CHIP_RESTRICTIVENESS: ConstraintKey[] = ['bookableNow', 'dropIn', 'rainyDay'];

/**
 * Which constraints are actually active (present) in this context.
 *
 * `hasOrigin` defaults to true so existing callers are unchanged, exactly as
 * `BroadeningOptions.hasOrigin` does — and for the same reason. A radius filters NOTHING
 * without an origin to measure from (filters/predicate.ts only applies `withinRadius` when
 * one resolved), so on an originless search `radiusKm < 20` describes a setting, not a
 * constraint.
 *
 * THIS IS THE SIBLING HALF OF A FIX THAT ONLY LANDED ON ONE SIDE. The radius RUNG was gated on
 * `hasOrigin` so the ladder could not report "Expanded distance to 20km" for a widen that
 * could not matter; this function sat next to it, ungated, still handing `explainEmptyState` a
 * radius to probe — so the empty state went on naming "distance" as the thing blocking searches
 * that were never distance-filtered. Same false disclosure, same query, one function over.
 *
 * REGION CHIPS WERE MISSING ENTIRELY, and the omission was structural rather than a judgement
 * call. Every other narrowing filter is a field on `SearchContext`, so enumerating them here was
 * a matter of reading that type; region chips travel as a separate `regionChipIds` argument
 * (filters/predicate.ts), so they were invisible to a function that only ever looked at the
 * context. The consequence was the worst possible answer to a blank page: a parent filtered to
 * Vancouver with sixty Burnaby listings behind the chip was told "No activities found" — and,
 * with any second filter active, "Relaxing any single filter adds nothing", while clearing the
 * area chip alone would have shown all sixty. Measured, not hypothesised: see
 * tests/search/empty-state-names-region-chip.test.ts.
 */
export function activeConstraints(ctx: SearchContext, opts: BroadeningOptions = {}): ConstraintKey[] {
  const active: ConstraintKey[] = [];
  if (ctx.terms.length > 0) active.push('text');
  if (ctx.radiusKm < 20 && opts.hasOrigin !== false) active.push('radius');
  if ((opts.regionChipIds?.length ?? 0) > 0) active.push('region');
  if (ctx.timeOfDay) active.push('timeOfDay');
  if (ctx.date) active.push('date');
  if (ctx.bookableNow) active.push('bookableNow');
  if (ctx.rainyDay) active.push('rainyDay');
  if (ctx.dropIn) active.push('dropIn');
  if (ctx.costFree) active.push('costFree');
  if (ctx.ageBands.length > 0) active.push('ageBands');
  return active;
}

/**
 * Return a context with exactly ONE constraint relaxed (for probing / drop-chip).
 *
 * `region` is the one key this CANNOT express, because region chips are not part of a
 * `SearchContext` at all — relaxing them means passing a different `regionChipIds` alongside the
 * context, which is what `explainEmptyState`'s probe does. Returning the context untouched keeps
 * this switch total over `ConstraintKey` without pretending to a power it does not have; every
 * caller that probes `region` must relax the chips itself.
 */
export function relaxSingle(ctx: SearchContext, key: ConstraintKey): SearchContext {
  switch (key) {
    case 'text': return { ...ctx, terms: [], widenText: true };
    case 'radius': return { ...ctx, radiusKm: nextRadius(ctx.radiusKm) };
    case 'region': return ctx;
    case 'timeOfDay': return { ...ctx, timeOfDay: null };
    case 'date': return { ...ctx, date: null };
    case 'bookableNow': return { ...ctx, bookableNow: false };
    case 'rainyDay': return { ...ctx, rainyDay: false };
    case 'dropIn': return { ...ctx, dropIn: false };
    case 'costFree': return { ...ctx, costFree: false };
    case 'ageBands': return { ...ctx, ageBands: [] };
  }
}

export interface SingleRelaxation {
  constraint: ConstraintKey;
  label: string;
  /** TOTAL results the query would return with just this constraint relaxed. */
  wouldYield: number;
  /**
   * How many results relaxing this constraint would ADD to what the parent can see now
   * (`wouldYield − baseline`, floored at zero). This — not `wouldYield` — is the honest
   * "shows N more", and the two only coincide when the current result count is zero.
   */
  addsResults: number;
}

export interface ConstraintExplanation {
  /** The single constraint whose removal adds the most results (the thing to explain). */
  blockingConstraint: ConstraintKey | null;
  message: string;
  /** Per-constraint: what relaxing just that one would yield, in total and as an addition. */
  singleRelaxations: SingleRelaxation[];
}

/** How much of the parent's own query the unreadable-query message quotes back. */
const MAX_ECHOED_QUERY_CHARS = 60;

/**
 * The empty-state explanation for a query the parser could read NOTHING of
 * (`SearchContext.unparsedQuery` — see lib/search/parse.ts and lib/search/engine.ts).
 *
 * AUTHORED, NOT MEASURED, and that is the point. `explainEmptyState` below names a blocking
 * constraint by probing single relaxations, but the only constraint active here is `text`,
 * and `relaxSingle(ctx, 'text')` sets `terms: []` — which is precisely the state that puts
 * lib/search/match.ts into `browseMode` and returns the entire catalogue. The probe would
 * therefore come back with a large, perfectly true number and the page would print
 * "Relaxing the search terms shows 4,812 more": the count of everything, offered as the
 * remedy for a question nobody understood. That sentence is the dressed-up form of the exact
 * defect this path exists to stop, so the probe is not run.
 *
 * `singleRelaxations` is EMPTY for the same reason — no relaxation was measured, and an empty
 * list is the honest record of that. A consumer reading it gets "nothing was probed" rather
 * than a fabricated row.
 *
 * `blockingConstraint` is `'text'` because the text genuinely is what blocked the search;
 * consumers that render CONSTRAINT_LABELS['text'] ("search terms") stay correct without
 * needing to know about this case at all.
 */
export function explainUnparsedQuery(raw: string): ConstraintExplanation {
  const trimmed = raw.trim();
  const echoed =
    trimmed.length > MAX_ECHOED_QUERY_CHARS ? `${trimmed.slice(0, MAX_ECHOED_QUERY_CHARS)}…` : trimmed;
  return {
    blockingConstraint: 'text',
    message:
      `We could not read any searchable words in “${echoed}”. Search matches English words for now, ` +
      `so try one like “swim”, “park” or “library” — showing you unrelated activities would be worse ` +
      `than saying so.`,
    singleRelaxations: [],
  };
}

/**
 * Deterministic tie-break ONLY, for constraints that would add exactly the same number of
 * results. It is not the ranking: ranking is by measured yield (see below). Ordering ties by a
 * fixed list keeps the explanation stable across runs rather than dependent on the order
 * `activeConstraints` happens to emit.
 */
const TIE_BREAK_ORDER: ConstraintKey[] = [
  'radius', 'region', 'timeOfDay', 'date', 'bookableNow', 'dropIn', 'rainyDay', 'costFree', 'ageBands', 'text',
];

export interface ExplainOptions extends BroadeningOptions {
  /** Results the parent can see before any relaxation. Default 0 (the zero-result case). */
  baseline?: number;
}

/**
 * Name the blocking constraint by probing each active constraint's single relaxation.
 * `probe(ctx, regionChipIds)` returns the result count for a selection (engine-supplied, fixture
 * or DB). The second argument exists because region chips are not part of the context (see
 * `relaxSingle`); a caller that does not filter by area may ignore it, and a one-parameter
 * callback stays perfectly valid.
 *
 * `opts.baseline` is how many results the parent can see RIGHT NOW (the unrelaxed count). It
 * defaults to 0 — the classic zero-result empty state — and matters whenever the caller
 * explains a THIN result set rather than an empty one.
 *
 * `opts.hasOrigin` is forwarded to `activeConstraints` so a radius that cannot filter anything
 * is never probed, never ranked, and never named. `opts.regionChipIds` is forwarded for the
 * opposite reason: without it an area filter is never probed, ranked or named EITHER, and the
 * page confidently reports that nothing would help.
 *
 * RANKING IS BY MEASURED YIELD, NOT BY A FIXED LIST. This function's contract has always been
 * "the constraint whose removal unlocks the most", but the implementation sorted by a
 * hard-coded priority ordering and used yield only to break ties. With radius ahead of
 * costFree in that list, a query blocked almost entirely by the Free filter but incidentally
 * narrowed by radius named "distance" as the reason and never mentioned Free at all — the
 * docstring described the intended behaviour and the code did something else. Now the list
 * survives only as a deterministic tie-break.
 *
 * `text` remains a LAST RESORT rather than a competitor on yield, and that is a different kind
 * of rule: relaxing the search terms abandons the question the parent asked instead of
 * unblocking it, and it almost always "wins" on raw count (an unfiltered catalogue beats every
 * real answer). It is named only when no filter relaxation adds anything.
 */
export function explainEmptyState(
  ctx: SearchContext,
  probe: (variant: SearchContext, regionChipIds: string[]) => number,
  opts: ExplainOptions = {},
): ConstraintExplanation {
  const baseline = opts.baseline ?? 0;
  const chips = opts.regionChipIds ?? [];
  const active = activeConstraints(ctx, opts);
  const singleRelaxations: SingleRelaxation[] = active.map((constraint) => {
    // Relaxing `region` means dropping the chips, not changing the context; every other
    // constraint means changing the context and keeping the chips exactly as they are.
    const wouldYield =
      constraint === 'region' ? probe(ctx, []) : probe(relaxSingle(ctx, constraint), chips);
    return {
      constraint,
      label: CONSTRAINT_LABELS[constraint],
      wouldYield,
      addsResults: Math.max(0, wouldYield - baseline),
    };
  });

  const byYield = (a: SingleRelaxation, b: SingleRelaxation) =>
    b.addsResults - a.addsResults ||
    TIE_BREAK_ORDER.indexOf(a.constraint) - TIE_BREAK_ORDER.indexOf(b.constraint);

  // A relaxation that adds nothing is not a remedy, however much it would "yield" in total.
  const helpful = singleRelaxations.filter((r) => r.addsResults > 0);
  const filters = helpful.filter((r) => r.constraint !== 'text').sort(byYield);
  const best = filters[0] ?? helpful.filter((r) => r.constraint === 'text')[0] ?? null;

  const blocking = best?.constraint ?? null;
  const lede = baseline === 0 ? 'No exact matches.' : `Only ${baseline} exact ${baseline === 1 ? 'match' : 'matches'}.`;
  // The constraint is the OBJECT of the sentence, never its subject, so the copy stays
  // grammatical across all nine labels: "The search terms is the main thing narrowing your
  // results" was the old template's output whenever text was the blocking constraint. Rare
  // enough to survive unnoticed while this rendered only at total===0; not rare enough now
  // that the page shows it for thin results too.
  const message = best
    ? `${lede} Relaxing the ${best.label} shows ${best.addsResults} more — it is the main thing narrowing your results.`
    : active.length > 0
      ? `${lede} Relaxing any single filter adds nothing — try broadening your search.`
      : baseline === 0
        ? `No activities found.`
        : lede;

  return { blockingConstraint: blocking, message, singleRelaxations };
}

/**
 * Build the deterministic, CUMULATIVE broadening ladder (§5A.5). Each rung's `context`
 * includes all prior relaxations, so the engine can walk rungs until it has enough results.
 */
export function buildBroadeningLadder(ctx: SearchContext, opts: BroadeningOptions = {}): BroadenRung[] {
  const rungs: BroadenRung[] = [];
  let cur = ctx;
  let n = 0;

  // (1) synonym / category widen. INERT — `widenText` is read by nothing (see types.ts). Kept
  // because the rung is spec'd (TSD §5A.5 / PRD T-11); it adds no results and is deliberately
  // excluded from the parent-facing notice so it cannot claim a widen that did not happen.
  if (ctx.terms.length > 0) {
    cur = { ...cur, widenText: true };
    rungs.push({ rung: ++n, key: 'synonym_widen', label: 'Widened to related categories and synonyms', context: cur });
  }
  // (2) radius expand — a genuine bounded widen already (5→10→20km, capped), left as designed.
  // It is only OFFERED when there is an origin to measure from: with no origin no radius filter
  // runs at all (see filters/predicate.ts), so the rung could not change a single result while
  // still reporting "Expanded distance to 20km" to anyone reading the applied rungs.
  if (ctx.radiusKm < 20 && opts.hasOrigin !== false) {
    cur = { ...cur, radiusKm: nextRadius(cur.radiusKm) };
    rungs.push({ rung: ++n, key: 'radius_expand', label: `Expanded distance to ${cur.radiusKm}km`, context: cur });
  }
  // (3) adjacent times — the NEIGHBOURING day-parts, never `timeOfDay: null`. Morning widens
  // into the afternoon; it does not widen into the evening, which is not an adjacent time.
  if (ctx.timeOfDay) {
    cur = { ...cur, timeOfDayAdjacent: true };
    const parts = ADJACENT_DAY_PARTS[ctx.timeOfDay];
    rungs.push({
      rung: ++n,
      key: 'adjacent_time',
      label: `Included adjacent times of day (${parts.join(', ')})`,
      context: cur,
    });
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
  // (4) adjacent ages — the neighbouring bands, never `ageBands: []`. See filters/age.ts for
  // why age is graded rather than a chip, and therefore widened rather than dropped.
  const nearbyAges = adjacentAgeBands(ctx.ageBands);
  if (nearbyAges.length > ctx.ageBands.length) {
    cur = { ...cur, ageBands: nearbyAges };
    rungs.push({
      rung: ++n,
      key: 'adjacent_age',
      label: `Included adjacent age groups (${nearbyAges.join(', ')})`,
      context: cur,
    });
  }
  // (5) drop the most restrictive chip — booleans only; a drop is their only relaxation.
  const chip = CHIP_RESTRICTIVENESS.find((c) => activeConstraints(ctx).includes(c));
  if (chip) {
    cur = relaxSingle(cur, chip);
    rungs.push({
      rung: ++n,
      key: 'drop_chip',
      label: `Dropped the ${CONSTRAINT_LABELS[chip]}`,
      constraint: chip,
      context: cur,
    });
  }
  // (6) expected / seasonal / evergreen in a separate section
  cur = { ...cur, includeExpected: true };
  rungs.push({ rung: ++n, key: 'expected_section', label: 'Showing expected & seasonal activities separately', context: cur });

  return rungs;
}
