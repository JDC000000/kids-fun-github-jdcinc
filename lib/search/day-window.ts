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
 *   · `day_over`    — past the last day-part window; nothing listed can still be ahead.
 */
export type DayWindowState = 'day_ahead' | 'day_closing' | 'day_over';

export interface RequestedDayWindow {
  /** The single America/Vancouver local day the search asked for (YYYY-MM-DD). */
  isoDate: string;
  /** True when that day is the CURRENT local day — "today" in the parent's own timezone. */
  isToday: boolean;
  state: DayWindowState;
}

// The boundaries come from the day-part windows the product already filters and labels by
// (filters/time.ts), rather than from two fresh numbers invented here. "Evening" runs 17:00–22:00,
// so 17:00 is the hour after which a parent is looking at the tail of the day, and 22:00 is the
// hour after which the day has no listed hours left at all.
const EVENING_OPENS_MIN = DAY_PART_WINDOWS.evening.startMin;
const EVENING_CLOSES_MIN = DAY_PART_WINDOWS.evening.endMin;

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
    minutes >= EVENING_CLOSES_MIN ? 'day_over' : minutes >= EVENING_OPENS_MIN ? 'day_closing' : 'day_ahead';
  return { isoDate, isToday: true, state };
}
