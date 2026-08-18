// lib/search/filters/time.ts — Time-of-day + date predicates (G-T16-4, FR-09, TSD §5A.4).
//
// Backend query support is required, not just UI chips. Occurrence times are stored
// UTC and evaluated in America/Vancouver local day-part windows with overlap semantics.
// A 10:00 occurrence matches "morning"; an open-hours 09:00–17:00 attraction
// intersects "afternoon".

import type { DayPart, DateIntent, ListingRecord } from '../types';
import { localMinutesOfDay, localIsoDate } from '../time/vancouver';

/** Day-part windows as America/Vancouver minutes-past-midnight [start, end). */
export const DAY_PART_WINDOWS: Record<DayPart, { startMin: number; endMin: number }> = {
  morning: { startMin: 5 * 60, endMin: 12 * 60 }, // 05:00–12:00
  afternoon: { startMin: 12 * 60, endMin: 17 * 60 }, // 12:00–17:00
  evening: { startMin: 17 * 60, endMin: 22 * 60 }, // 17:00–22:00
};

/**
 * Each day-part's NEIGHBOURING parts, itself included — the bounded relaxation behind the
 * broadening ladder's "adjacent_time" rung (lib/search/broaden.ts).
 *
 * That rung used to set `timeOfDay: null`, which is not "other times of day", it is ALL times
 * of day: a parent who asked for a morning activity was silently handed evening ones. Morning
 * and evening are not adjacent to each other, so neither can reach the other here — the only
 * band with two neighbours is the one in the middle.
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
 * The contiguous window spanning a day-part and its neighbours. The three parts abut
 * (05:00–12:00–17:00–22:00), so their union is always one interval — no gap to reason about.
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
    return overlaps(listing.openHoursLocal.startMin, listing.openHoursLocal.endMin, window.startMin, window.endMin);
  }

  if (!listing.startDatetimeUtc) return false;
  const startMin = localMinutesOfDay(new Date(listing.startDatetimeUtc));
  let endMin = listing.endDatetimeUtc ? localMinutesOfDay(new Date(listing.endDatetimeUtc)) : startMin;
  if (endMin < startMin) endMin += 24 * 60; // crosses local midnight
  // Treat a zero-length instant as a 1-minute span so a point exactly at window start still matches.
  if (endMin === startMin) endMin = startMin + 1;
  return overlaps(startMin, endMin, window.startMin, window.endMin);
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
 * Both the point query and the multi-day intents (`endIsoDate` set — a custom `range`, T26 /
 * FR-04, or a `weekend`, which is Saturday AND Sunday) therefore ask the same thing: do the
 * occurrence's local days and the requested local days overlap? YYYY-MM-DD strings compare
 * lexicographically identically to chronologically, so the overlap test needs no Date arithmetic.
 *
 * THE REQUESTED WINDOW IS KEYED OFF `endIsoDate`, NOT OFF `kind`. It used to read
 * `kind === 'range' && endIsoDate`, which meant a second kind that legitimately spans days was
 * silently narrowed back to its start day — exactly what happened to `weekend` when it grew its
 * Sunday: the intent said Sat–Sun and this predicate still matched Saturday only. The end of the
 * window is a property of the window, so it is read from the field that carries it and every
 * present and future multi-day kind is covered by construction.
 */
export function matchesDate(listing: ListingRecord, date: DateIntent | null): boolean {
  if (!date || !date.isoDate) return true;
  if (listing.openHours) return true;
  if (!listing.startDatetimeUtc) return false;
  const firstDay = localIsoDate(new Date(listing.startDatetimeUtc));
  const lastDay = occurrenceLastDay(listing, firstDay);
  const wantedFrom = date.isoDate;
  // A backwards intent must never widen what it matches (mirrors occurrenceLastDay below).
  const wantedTo = date.endIsoDate && date.endIsoDate > date.isoDate ? date.endIsoDate : date.isoDate;
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
