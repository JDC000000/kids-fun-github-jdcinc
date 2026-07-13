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

/** Half-open interval overlap: [aStart,aEnd) ∩ [bStart,bEnd) ≠ ∅. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Does a listing's occurrence fall within the requested local day-part window?
 * - Fixed occurrence → convert start/end to local minutes, overlap with window.
 * - Open-hours attraction → overlap its daily open window (or, if unknown, treated as
 *   available all day and therefore matching any day-part).
 */
export function matchesTimeOfDay(listing: ListingRecord, timeOfDay: DayPart | null): boolean {
  if (!timeOfDay) return true;
  const window = DAY_PART_WINDOWS[timeOfDay];

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
 * Does a listing occur on the requested local date?
 * Open-hours attractions are available every day → always match a date filter.
 */
export function matchesDate(listing: ListingRecord, date: DateIntent | null): boolean {
  if (!date || !date.isoDate) return true;
  if (listing.openHours) return true;
  if (!listing.startDatetimeUtc) return false;
  return localIsoDate(new Date(listing.startDatetimeUtc)) === date.isoDate;
}
