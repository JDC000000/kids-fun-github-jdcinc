// lib/search/filters/time.ts — Time-of-day + date predicates (G-T16-4, FR-09, TSD §5A.4).
//
// Backend query support is required, not just UI chips. Occurrence times are stored
// UTC and evaluated in America/Vancouver local day-part windows with overlap semantics.
// A 10:00 occurrence matches "morning"; an open-hours 09:00–17:00 attraction
// intersects "afternoon".

import type { DayPart, DateIntent, ListingRecord } from '../types';
import { localMinutesOfDay, localIsoDate } from '../time/vancouver';

/**
 * Day-part windows as America/Vancouver minutes-past-midnight [start, end).
 *
 * THESE THREE WINDOWS TILE THE WHOLE CLOCK, and that is load-bearing. They used to span
 * 05:00–22:00 and nothing else, which left 22:00–05:00 belonging to no day-part at all: a
 * 22:15 occurrence matched morning, afternoon and evening ALL false and was reachable only
 * through "Any time". Three testers opened the app at 22:35, tapped the Evening chip, got
 * nothing, and concluded the product was broken — they were looking at the one window in the
 * day where every chip is guaranteed to be empty.
 *
 * `evening` therefore now runs to 05:00 the NEXT morning — the same hour `morning` opens, so
 * the three windows abut with no gap and no overlap. Absorbing the small hours into "evening"
 * rather than minting a fourth `DayPart` is deliberate: `parse.ts` already resolves both
 * "night" and "tonight" to `evening`, so the product's own vocabulary has always treated night
 * as the tail of the evening, and a fourth value would have to be threaded through the facet
 * counts, the chip set, the broadening ladder's adjacency map and both preview surfaces to fix
 * a defect that lives in one constant. See ADJACENT_DAY_PARTS below for the other half.
 *
 * EXPRESSED AS 29:00, NOT AS A WRAP TO 05:00. Keeping `startMin < endMin` for every window is
 * what lets `adjacentWindow` stay a plain min/max union and lets one comparison serve all three
 * parts; the wrap is handled once, on the comparison side, by `overlapsOnClock`.
 */
export const DAY_PART_WINDOWS: Record<DayPart, { startMin: number; endMin: number }> = {
  morning: { startMin: 5 * 60, endMin: 12 * 60 }, // 05:00–12:00
  afternoon: { startMin: 12 * 60, endMin: 17 * 60 }, // 12:00–17:00
  evening: { startMin: 17 * 60, endMin: 29 * 60 }, // 17:00–05:00 the next local day
};

/** One turn of the clock face, in minutes. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Each day-part's NEIGHBOURING parts, itself included — the bounded relaxation behind the
 * broadening ladder's "adjacent_time" rung (lib/search/broaden.ts).
 *
 * That rung used to set `timeOfDay: null`, which is not "other times of day", it is ALL times
 * of day: a parent who asked for a morning activity was silently handed evening ones. Morning
 * and evening are not adjacent to each other, so neither can reach the other here — the only
 * band with two neighbours is the one in the middle.
 *
 * This map is unchanged by evening's reach into the small hours, and that is the right answer,
 * not an omission. Evening and morning still meet at 05:00, but "abuts" is not "adjacent": the
 * point of this map is that a parent asking for one end of the day is never handed the other,
 * and 04:00 is the far end of the day from 09:00 no matter which side of midnight it sits on.
 */
export const ADJACENT_DAY_PARTS: Record<DayPart, DayPart[]> = {
  morning: ['morning', 'afternoon'],
  afternoon: ['morning', 'afternoon', 'evening'],
  evening: ['afternoon', 'evening'],
};

/** Half-open interval overlap: [aStart,aEnd) ∩ [bStart,bEnd) ≠ ∅. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Overlap on a 24-HOUR CLOCK FACE rather than on the number line.
 *
 * Local minutes-past-midnight are a position on a circle, not a magnitude: 00:30 (minute 30)
 * and 24:30 (minute 1470) name the same place, one turn apart. That never mattered while every
 * window ended before midnight, but `evening` now runs to minute 1740, so a plain numeric
 * comparison would answer "no overlap" for a 00:30 occurrence — precisely the late-night rows
 * the window was widened to reach.
 *
 * Both intervals are at most one full turn long, so testing the occurrence in place, one turn
 * back, and one turn forward covers every real alignment. The backward turn is not redundant:
 * an occurrence running 23:00→06:00 (1380..1800) reaches into the NEXT morning, and only the
 * shifted copy places it inside 05:00–12:00 where it genuinely belongs.
 */
function overlapsOnClock(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return (
    overlaps(aStart, aEnd, bStart, bEnd) ||
    overlaps(aStart + MINUTES_PER_DAY, aEnd + MINUTES_PER_DAY, bStart, bEnd) ||
    overlaps(aStart - MINUTES_PER_DAY, aEnd - MINUTES_PER_DAY, bStart, bEnd)
  );
}

/**
 * The contiguous window spanning a day-part and its neighbours. The three parts abut
 * (05:00–12:00–17:00–05:00), so their union is always one interval — no gap to reason about.
 * Because every window keeps `startMin < endMin` (evening ends at 29:00, not at a wrapped
 * 05:00), that union is still a plain min/max and needs no circular arithmetic of its own.
 */
function adjacentWindow(part: DayPart): { startMin: number; endMin: number } {
  const parts = ADJACENT_DAY_PARTS[part].map((p) => DAY_PART_WINDOWS[p]);
  return {
    startMin: Math.min(...parts.map((w) => w.startMin)),
    endMin: Math.max(...parts.map((w) => w.endMin)),
  };
}

/**
 * Does a listing's occurrence fall within the requested local day-part window?
 * - Fixed occurrence → convert start/end to local minutes, overlap with window.
 * - Open-hours attraction → overlap its daily open window (or, if unknown, treated as
 *   available all day and therefore matching any day-part).
 */
export function matchesTimeOfDay(
  listing: ListingRecord,
  timeOfDay: DayPart | null,
  opts: { includeAdjacent?: boolean } = {},
): boolean {
  if (!timeOfDay) return true;
  const window = opts.includeAdjacent ? adjacentWindow(timeOfDay) : DAY_PART_WINDOWS[timeOfDay];

  if (listing.openHours) {
    if (!listing.openHoursLocal) return true; // unknown hours → don't hide it
    const openFrom = listing.openHoursLocal.startMin;
    // A venue open 20:00–02:00 has published hours whose end precedes their start, for the same
    // reason a 21:00–00:30 occurrence does. Unwrap it the same way rather than letting the
    // comparison silently decide the place is never open.
    let openTo = listing.openHoursLocal.endMin;
    if (openTo < openFrom) openTo += MINUTES_PER_DAY;
    return overlapsOnClock(openFrom, openTo, window.startMin, window.endMin);
  }

  if (!listing.startDatetimeUtc) return false;
  const startMin = localMinutesOfDay(new Date(listing.startDatetimeUtc));
  let endMin = listing.endDatetimeUtc ? localMinutesOfDay(new Date(listing.endDatetimeUtc)) : startMin;
  if (endMin < startMin) endMin += MINUTES_PER_DAY; // crosses local midnight
  // Treat a zero-length instant as a 1-minute span so a point exactly at window start still matches.
  if (endMin === startMin) endMin = startMin + 1;
  return overlapsOnClock(startMin, endMin, window.startMin, window.endMin);
}

/**
 * Does a listing occur on the requested local date (or within a local date RANGE)?
 * Open-hours attractions are available every day → always match a date filter.
 *
 * AN OCCURRENCE IS A SPAN, NOT AN INSTANT. Most occurrences start and end on the same local
 * day, and for those this is exactly the old start-day equality test. But a source may publish
 * a genuinely multi-day programme as ONE occurrence — Richmond Public Library's summer
 * programmes run 24 Jun → 1 Sep as a single row — and such a listing IS on today, every day it
 * runs. Testing only the start day answered "did it begin today?", which is a different
 * question, and it answered "no" for every day of a running programme but its first.
 *
 * Both the point query and the range intent (`kind === 'range'` with an `endIsoDate`, T26 /
 * FR-04) therefore ask the same thing: do the occurrence's local days and the requested local
 * days overlap? YYYY-MM-DD strings compare lexicographically identically to chronologically, so
 * the overlap test needs no Date arithmetic.
 */
export function matchesDate(listing: ListingRecord, date: DateIntent | null): boolean {
  if (!date || !date.isoDate) return true;
  if (listing.openHours) return true;
  if (!listing.startDatetimeUtc) return false;
  const firstDay = localIsoDate(new Date(listing.startDatetimeUtc));
  const lastDay = occurrenceLastDay(listing, firstDay);
  const wantedFrom = date.isoDate;
  const wantedTo = date.kind === 'range' && date.endIsoDate ? date.endIsoDate : date.isoDate;
  return firstDay <= wantedTo && lastDay >= wantedFrom;
}

/**
 * Last local day the occurrence runs on. Falls back to the start day when there is no end, and
 * when the stored end precedes the start — a backwards row must never widen what it matches.
 */
function occurrenceLastDay(listing: ListingRecord, firstDay: string): string {
  if (!listing.endDatetimeUtc) return firstDay;
  const end = new Date(listing.endDatetimeUtc);
  if (Number.isNaN(end.getTime())) return firstDay;
  const endDay = localIsoDate(end);
  return endDay > firstDay ? endDay : firstDay;
}
