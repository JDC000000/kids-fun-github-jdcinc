// lib/sms/instant-picks.ts — "Instant Picks": the fuller, fresh list a subscriber can generate
// for THEMSELVES from the "Last Friday" section of /u/[preferencesToken] (Instant Picks plan v1.0).
//
// ═══ WHAT THIS IS: A WRAPPER, NOT A SECOND SELECTOR ═══
// Every selection rule — the broadening ladder, the dedup pass, the age-coverage swap, the venue
// and category diversity stages — lives in `selectWeeklyPicks` and is NOT reimplemented here. This
// file does three things and nothing else:
//
//   1. resolves the subscriber's postal code to an origin (the SAME two calls lib/sms/weekly-send.ts
//      makes, in the same order, so the two surfaces cannot disagree about where "near" is);
//   2. calls `selectWeeklyPicks` with the pause counter NEUTRALISED (see below — this is the whole
//      reason this file exists rather than the route calling the selector directly);
//   3. flattens the result into a view model the page can render, dropping every field that only
//      means something to a send.
//
// ═══ THE WINDOW IS THE WEEKEND, AND THAT IS THE DECISION, NOT AN OVERSIGHT ═══
// `selectWeeklyPicks` builds a weekend-shaped request and takes no date option (see
// `buildPicksRequest`). Pressed on a Tuesday this returns the coming Saturday and Sunday, not
// Tuesday. That is deliberate and was decided before this was built: the section is headed "Last
// Friday" and the ask was for MORE THINGS IN IT, so a longer version of the Friday list is the
// answer. A "today" mode would need a window option on weekly-picks.ts — a file two other
// scoped-but-unbuilt workstreams are already queued to modify — for no stated benefit, and "today"
// checked at 7pm honestly collapses to whatever has not finished yet, which is not the fuller list
// this button promises. DO NOT ADD A DATE PARAMETER HERE TO "FIX" THAT.
//
// ═══ IT WRITES NOTHING. THAT IS A REQUIREMENT, NOT A SIDE EFFECT ═══
// In particular NOT `sms_send_log`. That table is what the "Last Friday" panel directly above this
// button READS FROM (lib/sms/preferences.ts `findLastWeek`), so logging a press there would corrupt
// the very section this feature is adding to, and would put presses into PRD §6's send metrics as
// though they were texts. Render and discard.
//
// This module therefore imports NO database seam and NO send-log writer, and
// tests/sms/instant_picks_no_persistence.test.ts asserts that statically — so the guarantee is a
// property of the import graph rather than a promise in a comment. If you are about to add an
// import from `@/lib/db/client` or `./send-log` to this file, that test is the one telling you not
// to, and it is right.

import type { SearchEngine } from '@/lib/search/engine';
import { fsaGeocoder, areaLabelForPostal } from '@/lib/geo/postal-fsa';
import { activityPath } from './click-through';
import {
  selectWeeklyPicks,
  type EmptyReason,
  type WeeklyPicks,
  type WeeklyPicksInput,
} from './weekly-picks';

/**
 * ═══ THE PAUSE LANDMINE, DEFUSED IN ONE PLACE ═══
 *
 * `selectWeeklyPicks` reports `shouldPause: consecutiveEmptyWeeks + 1 >= 3` on an empty result.
 * That is CORRECT for the Friday cron — three empty weeks in a row is a subscription worth
 * pausing — and it is WRONG here in a way that costs a real person their subscription: this path
 * is a button, a subscriber can press it on a quiet Tuesday, and the weekly counter is a fact
 * about SENDS that a press is not part of.
 *
 * Two independent guards, because one of them is exactly the kind of thing a future refactor
 * pattern-matches away:
 *
 *   1. THE COUNTER PASSED IN IS ALWAYS THIS ZERO, never the subscriber's real
 *      `consecutive_empty_weeks`. The row's true count is not even read on this path — the route's
 *      subscriber loader does not select it — so there is no value in scope to pass by accident.
 *   2. `InstantPicks` HAS NO `shouldPause` FIELD. The flag is destructured off and dropped at the
 *      one boundary below; a caller cannot act on what it cannot reach.
 *
 * tests/sms/instant_picks.test.ts proves both, including against a selector stubbed to return
 * `shouldPause: true` — so the guard survives someone "simplifying" the constant away.
 */
export const INSTANT_PICKS_EMPTY_WEEKS = 0;

/** The stored fields a press actually uses. No phone number, no internal counters. */
export interface InstantPicksSubscriber {
  /** `sms_consent.postal_code`. Null on a purged row — resolves to `unavailable`. */
  postalCode: string | null;
  /** `sms_consent.birth_years` — one YEAR per child. Empty means "no age filter", honestly. */
  birthYears: readonly number[];
  /** `sms_consent.category_interests`. Empty/absent = no category filter. */
  categoryInterests?: readonly string[];
  /** Travel radius in km. Defaults to the product-wide default inside the selector. */
  radiusKm?: number;
}

export interface InstantPicksInput {
  engine: SearchEngine;
  /** The clock. Passed, never ambient — same rule the selector it wraps runs on. */
  now: Date;
  subscriber: InstantPicksSubscriber;
  /**
   * The selector. Injected ONLY so a test can make it lie (return `shouldPause: true`) and prove
   * this wrapper still drops the flag. Production always gets the real one.
   */
  select?: (input: WeeklyPicksInput) => WeeklyPicks;
}

/** One row of the rendered list. Carries what the panel prints and nothing else. */
export interface InstantPick {
  occurrenceId: string;
  /** 1-based, in the selector's own ranked order. */
  rank: number;
  activityName: string;
  venueName: string;
  /**
   * A PLAIN `/activity/{id}` LINK, NOT A SHORT LINK — and that is the same argument as the
   * send-log one above, one layer along.
   *
   * `/s/{token}` exists to attribute a tap to a SEND (`sms_click_event.link_origin`, migration
   * 0036), and PRD §6's click-through metric divides taps by messages delivered. These picks were
   * never sent, so there is no send for a tap to be attributed to: routing them through the short
   * link would either write click events against a send-log row that does not exist, or inflate
   * the 'hub' bucket with taps that had no message behind them. Both make the metric answer a
   * question nobody asked. An honest unattributed link is the correct one here.
   */
  href: string;
}

export type InstantPicksOutcome =
  /** A list to render. */
  | 'picks'
  /** The search ran and honestly produced nothing that clears the floor. */
  | 'empty'
  /**
   * We could not CHECK — the postal code resolves to no covered municipality.
   *
   * Never folded into `empty`, for the reason lib/sms/weekly-send.ts gives about its own
   * `geocode_failed`: telling a parent "nothing near you" about a search that never ran is a
   * false statement about the catalogue.
   */
  | 'unavailable';

export interface InstantPicks {
  outcome: InstantPicksOutcome;
  /** Ranked. Empty unless `outcome === 'picks'`. */
  picks: InstantPick[];
  /** The subscriber's area as the page says it ("East Van"). Null when it could not be resolved. */
  areaLabel: string | null;
  /** Set only when `outcome === 'empty'` — which honest nothing this is. */
  emptyReason: EmptyReason | null;
  /** True when the selector had to widen to get here. Worth saying on the page. */
  widened: boolean;
  /** True when the widened attempt also had to drop the subscriber's stated interests. */
  interestsDropped: boolean;
  // NOTE: there is deliberately NO `shouldPause` here, and adding one would reintroduce the exact
  // defect INSTANT_PICKS_EMPTY_WEEKS exists to prevent. See its comment.
}

/**
 * This subscriber's fuller list, right now. PURE: the only I/O is whatever the engine was wired
 * with by the caller, exactly like the selector it wraps.
 *
 * NEVER THROWS on a subscriber's data — a missing or out-of-area postal code is an `unavailable`
 * outcome, not an exception. The page this feeds is the CASL unsubscribe path; a button on it must
 * not be able to take the page down.
 */
export function selectInstantPicks(input: InstantPicksInput): InstantPicks {
  const { engine, now, subscriber } = input;
  const select = input.select ?? selectWeeklyPicks;

  // ── Origin. The same pure table lookup lib/sms/weekly-send.ts makes, in the same order: no paid
  //    geocoder, no signed-in caller, and an out-of-area postal gets its own outcome. ──
  const geo = fsaGeocoder.geocodePostal(subscriber.postalCode ?? '');
  const areaLabel = areaLabelForPostal(subscriber.postalCode ?? '');
  if (!geo || !areaLabel) {
    return {
      outcome: 'unavailable',
      picks: [],
      areaLabel: null,
      emptyReason: null,
      widened: false,
      interestsDropped: false,
    };
  }

  const result = select({
    engine,
    now,
    subscriber: {
      origin: { geo, label: areaLabel },
      radiusKm: subscriber.radiusKm,
      birthYears: subscriber.birthYears,
      categoryInterests: subscriber.categoryInterests,
      // ⚠ NOT the subscriber's real counter. See INSTANT_PICKS_EMPTY_WEEKS.
      consecutiveEmptyWeeks: INSTANT_PICKS_EMPTY_WEEKS,
    },
    // `excludeOccurrenceIds` is deliberately NOT passed. The novelty filter exists so a TEXT does
    // not repeat itself week to week; a parent who asked for the fuller list of what is on wants
    // what is on, including the three things they were already told about. Omitting it is the
    // choice, not an oversight.
    //
    // `floorPicks` is likewise left at the default. Below the floor the selector WIDENS before it
    // gives up, and that widening is what produces the longer list this button is for — lowering
    // the floor would skip it and hand back two things instead.
  });

  // ⚠ THE ONE BOUNDARY THE PAUSE FLAG DIES AT. `result.shouldPause` is in scope right here and is
  // never read: `InstantPicks` has no field for it and nothing below constructs one.
  if (result.outcome === 'empty') {
    return {
      outcome: 'empty',
      picks: [],
      areaLabel,
      emptyReason: result.emptyReason,
      widened: result.retried,
      interestsDropped: result.interestsDropped,
    };
  }

  return {
    outcome: 'picks',
    picks: result.picks.map((pick) => ({
      occurrenceId: pick.item.listing.id,
      rank: pick.rank,
      activityName: pick.item.listing.activityName,
      venueName: pick.item.listing.venueName,
      href: activityPath(pick.item.listing.id),
    })),
    areaLabel,
    emptyReason: null,
    widened: result.retried,
    interestsDropped: result.interestsDropped,
  };
}
