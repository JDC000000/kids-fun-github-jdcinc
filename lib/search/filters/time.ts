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
 * A range intent (`kind === 'range'` with an `endIsoDate`, T26 / FR-04) matches every
 * occurrence whose local day falls in the inclusive interval [isoDate, endIsoDate].
 * YYYY-MM-DD strings compare lexicographically identically to chronologically, so the
 * range test needs no Date arithmetic.
 */
export function matchesDate(listing: ListingRecord, date: DateIntent | null): boolean {
  if (!date || !date.isoDate) return true;
  if (listing.openHours) return true;
  if (!listing.startDatetimeUtc) return false;
  const day = localIsoDate(new Date(listing.startDatetimeUtc));
  if (date.kind === 'range' && date.endIsoDate) {
    return day >= date.isoDate && day <= date.endIsoDate;
  }
  return day === date.isoDate;
}
