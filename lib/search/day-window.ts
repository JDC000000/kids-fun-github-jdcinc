// lib/search/day-window.ts — "how much of the day the parent asked for is still ahead?"
//
// WHY THIS EXISTS. The read model only ever contains occurrences that have not yet ended
// (`visibleOccurrenceWhereSql()` in ./postgres-repository.ts prunes against `now()`, an instant).
// So a `when=today` result set does not answer "what is on today"; it answers "what is LEFT of
// today". Those are the same answer at nine in the morning and completely different answers at
// half past ten at night, when the list collapses to open-hours attractions and still-running
// multi-day programmes. Three testers hit exactly that and concluded the product was broken.
//
// The list cannot explain itself, because by the time it exists the evidence is gone: the ended
// occurrences were dropped before any filter ran, so the engine cannot count them and must not
// pretend to. What it CAN state, from a fact it holds with certainty, is where the local clock
// sits inside the requested day. That is enough to separate the two things a thin "Today" might
// mean — "the day is over" and "there is nothing on" — without inventing either.
//
// This is deliberately a statement about the CLOCK, never about the data. Nothing here claims
// how many activities ran earlier, because nothing here knows.

import type { DateIntent } from './types';
import { localIsoDate, localMinutesOfDay } from './time/vancouver';
import { DAY_PART_WINDOWS } from './filters/time';

/**
 * Where the local clock sits inside the requested day.
 *   · `day_ahead`   — the day's listed hours are still to come (or mostly so).
 *   · `day_closing` — the evening day-part has opened: anything earlier is already behind us.
 *   · `day_over`    — past the hour (22:00) at which the listed day runs out of scheduled starts.
 */
export type DayWindowState = 'day_ahead' | 'day_closing' | 'day_over';

export interface RequestedDayWindow {
  /** The single America/Vancouver local day the search asked for (YYYY-MM-DD). */
  isoDate: string;
  /** True when that day is the CURRENT local day — "today" in the parent's own timezone. */
  isToday: boolean;
  state: DayWindowState;
}

// 17:00 still comes from the day-part window the product filters and labels by: it is the hour
// the evening chip opens, and therefore the hour after which a parent is looking at the tail of
// the day.
const EVENING_OPENS_MIN = DAY_PART_WINDOWS.evening.startMin;

// 22:00 USED TO BE `DAY_PART_WINDOWS.evening.endMin` AND DELIBERATELY IS NOT ANY MORE.
//
// The evening day-part was widened to 05:00 the next morning (see filters/time.ts) to close a
// window in which no chip could match anything. That fixed which occurrences the Evening chip
// can REACH; it says nothing about when a listed day runs out of scheduled hours, which is the
// only question this module asks. Left derived, the constant would have become 29:00 — a value
// `localMinutesOfDay` can never return — and `day_over` would silently have stopped firing for
// today at all, turning a live disclosure into dead code without a single failing assertion.
//
// So it is stated here, as its own number, with its own meaning: the hour past which this
// product's catalogue has effectively nothing left that STARTS today.
//
// KNOWN TENSION, NOT AN OVERSIGHT: the catalogue does contain rows that run past 22:00 (a late
// public swim, a multi-day programme), so `day_over`'s "nothing listed can still be ahead" is a
// touch stronger than the corpus strictly supports — and the day-part fix makes those rows
// easier to reach than they were, which makes the wording easier to catch out. That is a
// product call about disclosure copy, not a side effect for a day-part fix to decide, so the
// behaviour here is preserved exactly and the question is flagged rather than answered.
const LISTED_DAY_ENDS_MIN = 22 * 60;

/**
 * Describe the single local day a search asked for, relative to `now` — or null when the request
 * is not about one particular day, in which case there is nothing honest to say.
 *
 * Returns null for a multi-day RANGE on purpose. "That day is over" is a claim about one day; a
 * range spanning today and the next two contains days in both states at once, and collapsing that
 * into a single verdict would be exactly the kind of confident-and-wrong sentence this module
 * exists to avoid. A `weekend` intent resolves to one Saturday and is treated as the single day
 * `matchesDate` actually filters on.
 */
export function describeRequestedDay(date: DateIntent | null, now: Date): RequestedDayWindow | null {
  const isoDate = date?.isoDate;
  if (!isoDate) return null;
  if ((date.endIsoDate ?? isoDate) !== isoDate) return null;

  const today = localIsoDate(now);
  // YYYY-MM-DD compares lexicographically exactly as it compares chronologically.
  if (isoDate > today) return { isoDate, isToday: false, state: 'day_ahead' };
  if (isoDate < today) return { isoDate, isToday: false, state: 'day_over' };

  const minutes = localMinutesOfDay(now);
  const state: DayWindowState =
    minutes >= LISTED_DAY_ENDS_MIN ? 'day_over' : minutes >= EVENING_OPENS_MIN ? 'day_closing' : 'day_ahead';
  return { isoDate, isToday: true, state };
}
