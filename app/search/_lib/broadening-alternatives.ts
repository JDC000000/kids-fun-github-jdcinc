// app/search/_lib/broadening-alternatives.ts — pre-counted, clickable broadening chips
// ("Nearby dates, Jul 14–20 (7 results)"): a parent's direct pick from among the SPECIFIC
// widenings the ladder considered, rather than a single all-or-nothing "we widened it" line.
//
// The data behind every chip's number is `SearchResponse.broadening.alternatives`
// (lib/search/broaden.ts's `BroadenAlternative`, computed in lib/search/engine.ts) — a REAL
// primary-result count per ladder rung, gated to only compute at all when the search is
// already thin (same condition that runs the ladder itself). See broaden.ts's own comment on
// `BroadenAlternative` for why that count is provably real rather than estimated.
//
// A chip is offered only when BOTH of these hold:
//   • it is NOT already reflected in the current results (`applied: false` — offering to do
//     something that already happened is not a choice, it is the status quo, and it is what
//     `_lib/broadening-notice.ts`'s "we widened your search to include…" line already says);
//   • its FULL cumulative context can be reproduced by a real `/search` URL.
//
// THAT SECOND POINT MUST BE CUMULATIVE, NOT PER-RUNG, because `BroadenAlternative.context`
// (lib/search/broaden.ts) is cumulative — a not-yet-applied rung's count was measured against
// every relaxation the ladder made ON THE WAY to it too, including ones already reflected in
// the CURRENT page (an `applied: true` sibling). A first cut of this file built the href from
// only the ONE field the offered rung's own key nominally changed (e.g. `drop_chip` → just
// `{ dropIn: false }`), which silently dropped any earlier-applied radius/date/age widening —
// so a chip claiming "14 results" could link to a narrower query the ladder had to re-broaden
// from scratch, landing somewhere else entirely. Reading every field off `alt.context` instead
// (see `overridesFor`) is what keeps the href and the count describing the same search.
//
// Two things still make a rung's context UN-reproducible by any URL, and those get no chip:
//   • `synonym_widen` is inert (nothing downstream reads `widenText` — see broaden.ts) and
//     `expected_section` is not a constraint relaxation at all — the results page already
//     renders its own "Expected / not yet posted" heading whenever it has anything.
//   • `timeOfDayAdjacent` (set by the `adjacent_time` rung) has no structured URL param — so
//     if the CUMULATIVE context for ANY alternative carries it (whether adjacent_time is the
//     rung on offer or merely fired earlier in the same chain), that alternative is skipped
//     entirely rather than linked to a URL that cannot reproduce its count.
// Silently rendering a chip that goes nowhere, or somewhere else, would be the same class of
// defect the rest of this feature exists to close: a control that claims a result count
// without honestly being able to produce it via the link a parent actually taps.

import type { BroadenAlternative } from '@/lib/search/broaden';
import { hrefFor, RADIUS_OPTIONS, type RadiusKm, type SearchState } from './params';

export interface AlternativeChip {
  key: string;
  /** Rung label + the real count, e.g. "Expanded distance to 20km — 7 results". */
  text: string;
  href: string;
}

/**
 * The state-field overrides for a rung's FULL cumulative context, or null when that context
 * cannot be honestly reproduced by any `/search` URL (see file header).
 */
function overridesFor(alt: BroadenAlternative): Partial<SearchState> | null {
  if (alt.context.timeOfDayAdjacent) return null; // no URL param can carry this forward
  if (alt.key === 'synonym_widen' || alt.key === 'expected_section') return null; // not a link
  // Defense in depth, not load-bearing: broaden.ts's CHIP_RESTRICTIVENESS guarantees a
  // drop_chip rung can never target costFree (a parent asking for Free may be unable to pay —
  // see broaden.ts's own extensive note, and tests/search/broaden-never-drops-free.test.ts's
  // DECISIVE pin). `overridesFor` never touches `state.free` below regardless, so this branch
  // is unreachable today; it stays as a second, independent guard against the one relaxation
  // this product must never silently offer, exactly like the engine-side guarantee it mirrors.
  if (alt.key === 'drop_chip' && alt.constraint === 'costFree') return null;
  // Defensive, unreachable for a REAL adjacent_date rung (buildBroadeningLadder only ever
  // produces one when it has a genuine widened window — see broaden.ts): a chip nominally
  // ABOUT a date widen that somehow carried no usable window would otherwise still render,
  // silently missing the one thing it claims to offer.
  if (alt.key === 'adjacent_date' && !(alt.context.date?.isoDate && alt.context.date?.endIsoDate)) return null;

  const overrides: Partial<SearchState> = {
    // The three boolean quick filters ALWAYS come straight off the context, regardless of
    // which rung is on offer: a `drop_chip` rung for e.g. `dropIn` only sets ONE of the three
    // false (broaden.ts's CHIP_RESTRICTIVENESS drops one at a time), and reading all three
    // every time is what carries the other two through unchanged.
    bookableNow: alt.context.bookableNow,
    dropIn: alt.context.dropIn,
    rainyDay: alt.context.rainyDay,
  };
  if ((RADIUS_OPTIONS as readonly number[]).includes(alt.context.radiusKm)) {
    overrides.radiusKm = alt.context.radiusKm as RadiusKm;
  }
  if (alt.context.date?.isoDate && alt.context.date?.endIsoDate) {
    // A custom range and the When quick-pick are mutually exclusive (params.ts) — carrying
    // this context forward means the range, not whatever quick-pick word might still be set.
    overrides.dateFrom = alt.context.date.isoDate;
    overrides.dateTo = alt.context.date.endIsoDate;
    overrides.when = 'any';
  }
  if (alt.context.ageBands.length > 0) overrides.ages = alt.context.ageBands;
  return overrides;
}

function pluralResults(count: number): string {
  return `${count} ${count === 1 ? 'result' : 'results'}`;
}

/**
 * Build the clickable alternative chips for the current state, or `[]` when the search is not
 * thin (the common case — `alternatives` is only populated at all when it was) or every
 * candidate rung is either already applied or has no URL representation.
 */
export function describeBroadeningAlternatives(
  alternatives: BroadenAlternative[] | undefined,
  state: SearchState,
): AlternativeChip[] {
  const chips: AlternativeChip[] = [];
  for (const alt of alternatives ?? []) {
    if (alt.applied) continue;
    const overrides = overridesFor(alt);
    if (!overrides) continue;
    chips.push({
      key: alt.key,
      text: `${alt.label} — ${pluralResults(alt.count)}`,
      href: hrefFor(state, overrides),
    });
  }
  return chips;
}
