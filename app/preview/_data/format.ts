// Pure, deterministic formatters for the mobile shell. No React, no I/O — unit-tested.
// Every number a parent reads (time, age, cost, distance, freshness) is formatted
// here so it stays consistent and honest across card + detail (D2 tabular numerals).

import type { Activity, StatusMeta, StatusState } from './types';

const VANCOUVER_TZ = 'America/Vancouver';

/** Reference "now" for the static fixtures (matches the sprint date). */
export const FIXTURE_NOW = '2026-07-13T09:00:00-07:00';

/** Format a start/end ISO pair into a Vancouver-local day + time range. */
export function formatWhen(startIso: string, endIso: string): { day: string; time: string } {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: VANCOUVER_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(start);
  const startTime = formatClock(start);
  const endTime = formatClock(end);
  return { day, time: `${startTime}–${endTime}` }; // en-dash range
}

function formatClock(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: VANCOUVER_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const meridiem = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toUpperCase();
  // Drop ":00" for whole hours so the range stays tight and scannable.
  return minute === '00' ? `${hour} ${meridiem}` : `${hour}:${minute} ${meridiem}`;
}

/** "Ages 5–9", "Under 6", "Ages 16+", or "All ages" for open-ended bands. */
export function formatAges(min: number, max: number): string {
  const allAges = max >= 18; // no meaningful upper kids-band bound past this
  if (min <= 0 && allAges) return 'All ages';
  if (allAges) return `Ages ${min}+`;
  if (min <= 0) return `Under ${max + 1}`;
  if (min === max) return `Age ${min}`;
  return `Ages ${min}–${max}`;
}

/** Cost copy — unknown is never presented as free (BR: "unknown ≠ free"). */
export function formatCost(activity: Pick<Activity, 'costStatus' | 'costMinCad' | 'costMaxCad'>): string {
  switch (activity.costStatus) {
    case 'free':
      return 'Free';
    case 'known': {
      const min = activity.costMinCad ?? 0;
      const max = activity.costMaxCad;
      if (max != null && max !== min) return `$${min}–$${max}`;
      return `$${min} approx.`;
    }
    case 'unknown':
    default:
      return 'Cost — check source';
  }
}

/** "Trout Lake · 12 min drive · 4.1 km" — geography as a practical travel radius. */
export function formatDistance(activity: Pick<Activity, 'area' | 'driveMinutes' | 'distanceKm'>): string {
  const km = activity.distanceKm.toFixed(1);
  return `${activity.area} · ${activity.driveMinutes} min drive · ${km} km`;
}

/** Whole-day difference between a checked date and "now", in the Vancouver day frame. */
export function daysSince(lastCheckedIso: string, nowIso: string = FIXTURE_NOW): number {
  const then = startOfVancouverDay(new Date(lastCheckedIso));
  const now = startOfVancouverDay(new Date(nowIso));
  const ms = now - then;
  return Math.max(0, Math.round(ms / 86_400_000));
}

function startOfVancouverDay(d: Date): number {
  // Compare on calendar-day boundaries in Vancouver, not raw 24h windows.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: VANCOUVER_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return new Date(`${ymd}T00:00:00-07:00`).getTime();
}

/** Human "Checked today / Checked 2 days ago" for the freshness stamp. */
export function formatChecked(lastCheckedIso: string, nowIso: string = FIXTURE_NOW): string {
  const days = daysSince(lastCheckedIso, nowIso);
  if (days === 0) return 'Checked today';
  if (days === 1) return 'Checked yesterday';
  return `Checked ${days} days ago`;
}

/**
 * Single source of truth for status → user-facing label, honest copy, section, tone, icon.
 * Never colour-only: every entry carries a text label + an icon.
 */
export function statusMeta(status: StatusState, seasonLabel?: string): StatusMeta {
  switch (status) {
    case 'confirmed':
      return { label: 'Confirmed', copy: 'Confirmed on the official source.', section: 'confirmed', tone: 'confirmed', icon: '✓' };
    case 'bookable_open':
      return { label: 'Bookable now', copy: 'Booking is open on the source site.', section: 'confirmed', tone: 'confirmed', icon: '✓' };
    case 'not_yet_bookable':
      return { label: 'Opens soon', copy: 'Not yet bookable — booking opens closer to the date.', section: 'expected', tone: 'info', icon: '◷' };
    case 'schedule_not_published':
      return { label: 'Not posted yet', copy: "Schedule not posted yet — we'll recheck.", section: 'expected', tone: 'expected', icon: '◴' };
    case 'inferred_recurring':
      return { label: 'Usually weekly', copy: 'Usually runs weekly — confirm the date on the source.', section: 'expected', tone: 'info', icon: '↻' };
    case 'seasonal_out_of_season':
      return {
        label: 'Seasonal',
        copy: seasonLabel ? `Seasonal — closed until ${seasonLabel}.` : 'Seasonal — closed for now.',
        section: 'expected',
        tone: 'expected',
        icon: '✵',
      };
    case 'stale':
      return { label: 'May be stale', copy: 'Last check is a few days old — may be stale.', section: 'expected', tone: 'muted', icon: '⧖' };
    case 'cancelled':
      return { label: 'Cancelled', copy: 'This occurrence was cancelled.', section: 'expected', tone: 'cancelled', icon: '✕' };
    case 'postponed':
      return { label: 'Postponed', copy: 'This occurrence was postponed.', section: 'expected', tone: 'cancelled', icon: '✕' };
    default:
      return { label: 'Unknown', copy: 'Status unknown — check the source.', section: 'expected', tone: 'muted', icon: '?' };
  }
}

/** Short booking/registration tag copy (empty string when nothing to book). */
export function bookingTag(booking: Activity['booking']): string {
  switch (booking) {
    case 'bookable_now':
      return 'Bookable now';
    case 'drop_in':
      return 'Drop-in';
    case 'registration':
      return 'Registration';
    case 'none':
    default:
      return '';
  }
}
