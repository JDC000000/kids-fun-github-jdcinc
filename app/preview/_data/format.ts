// Pure, deterministic formatters for the mobile shell. No React, no I/O — unit-tested.
// Every number a parent reads (time, age, cost, distance, freshness) is formatted
// here so it stays consistent and honest across card + detail (D2 tabular numerals).

import { readCost } from '@/lib/search/filters/cost';
import type { Activity, ConfidenceLabel, StatusMeta, StatusState } from './types';

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

/** The card's one not-a-number cost read. Unknown cost gets THIS, never a price and never "Free". */
const COST_UNKNOWN = 'Cost — check source';

/**
 * Cost copy for the card face — unknown is never presented as free (BR-11, TSD §6.2;
 * lib/search/types.ts:15 "unknown/check_source is NEVER treated as free").
 *
 * THE MISSING NUMBER IS NOT A ZERO. `cost_status = 'known'` does not guarantee a number: the DTO,
 * the postgres read-model and the admin listing form all permit known with null bounds, and the
 * old `costMinCad ?? 0` turned every one of those into a printed price — "$0 approx." for a
 * listing whose cost we never had, and "$0–$30" for one where we only ever knew the ceiling. A
 * fabricated $0 is the single worst thing this formatter can say to a parent, because it is the
 * one reading they will act on. We only print a number we were actually given.
 *
 * WHAT THIS FUNCTION NO LONGER DECIDES. Which listings are free, and which hold a statable
 * number, is now `readCost()` in lib/search/filters/cost.ts — the same derivation the weekly
 * digest reads, sitting next to the `isFree()` the Free quick filter uses. This formatter is
 * left with the card's WORDS and nothing else.
 *
 * That split is the fix for a specific failure, not tidiness. This comment previously said
 * `isFree()` "requires BOTH bounds at zero". It does not: it requires the MAXIMUM to be zero and
 * lets the minimum be zero OR ABSENT. The two worked examples underneath the false sentence
 * happened to be correct, which is how it survived review — and the cell it mis-stated
 * (known/min=null/max=0) was consequently never enumerated, so this card said "Cost — check
 * source" about a listing the Free filter was already returning as free. A hand-rolled mirror of
 * a rule owned elsewhere can be wrong in exactly this silent way; a call cannot.
 */
export function formatCost(activity: Pick<Activity, 'costStatus' | 'costMinCad' | 'costMaxCad'>): string {
  const read = readCost(activity);
  switch (read.kind) {
    case 'free':
      return 'Free';
    case 'amount':
      return `$${read.amount} approx.`;
    case 'range':
      return `$${read.min}–$${read.max}`;
    case 'unstated':
    default:
      return COST_UNKNOWN;
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
 * Covers ALL 16 canonical `status_state` values (TSD §6.2, Appendix C UX Copy Rules), so no
 * live status ever falls through to a generic "Unknown". Two honesty invariants hold across
 * every entry (UXR-06 / T-07 / Appendix D "never show stale/expected/seasonal as confirmed"):
 *   1. Only `confirmed` and `bookable_open` carry `section: 'confirmed'`. Everything else —
 *      including a currently-in-season seasonal item or a full class — sits in the `expected`
 *      section, so nothing unverified is ever blurred into the confirmed list.
 *   2. Copy never overstates live availability: `full`/`waitlist` read as full (not "opens
 *      soon"), `suspended` reads as suspended (not "not posted yet"), seasonal states name
 *      their season phase honestly.
 * Never colour-only: every entry carries a text label + a paired icon. Tones are limited to
 * the five the stamp/card CSS defines (confirmed | info | expected | cancelled | muted).
 */
export function statusMeta(status: StatusState, seasonLabel?: string): StatusMeta {
  switch (status) {
    // ── Confirmed section — verified and actionable right now. ───────────────────
    case 'confirmed':
      return { label: 'Confirmed', copy: 'Confirmed on the official source.', section: 'confirmed', tone: 'confirmed', icon: '✓' };
    case 'bookable_open':
      return { label: 'Bookable now', copy: 'Booking is open on the source site.', section: 'confirmed', tone: 'confirmed', icon: '✓' };

    // ── Expected section — real, but not a confirmed-for-this-date event. ─────────
    case 'not_yet_bookable':
      return { label: 'Opens soon', copy: 'Not yet bookable — booking opens closer to the date.', section: 'expected', tone: 'info', icon: '◷' };
    case 'schedule_not_published':
      return { label: 'Not posted yet', copy: "Schedule not posted yet — we'll recheck.", section: 'expected', tone: 'expected', icon: '◴' };
    case 'inferred_recurring':
      return { label: 'Usually weekly', copy: 'Usually runs weekly — confirm the date on the source.', section: 'expected', tone: 'info', icon: '↻' };
    case 'manual_candidate':
      return {
        label: 'Unverified',
        copy: 'Community-listed — not yet checked against an official source.',
        section: 'expected',
        tone: 'muted',
        icon: '⋯',
      };
    case 'needs_review':
      return {
        label: 'Unverified',
        copy: 'Not yet verified — check the official source before you rely on it.',
        section: 'expected',
        tone: 'muted',
        icon: '⋯',
      };

    // ── Seasonal — named by season phase, always in the expected section (T-07). ──
    case 'seasonal_out_of_season':
      return {
        label: 'Out of season',
        copy: seasonLabel ? `Seasonal — closed until ${seasonLabel}.` : 'Seasonal — closed for now.',
        section: 'expected',
        tone: 'expected',
        icon: '✵',
      };
    case 'seasonal_preseason':
      return {
        label: 'Season starts soon',
        copy: seasonLabel ? `Seasonal — the season starts ${seasonLabel}.` : "Seasonal — the season hasn't started yet.",
        section: 'expected',
        tone: 'info',
        icon: '✵',
      };
    case 'seasonal_active':
      return {
        label: 'In season now',
        copy: 'Running this season — confirm the day and time on the source.',
        section: 'expected',
        tone: 'info',
        icon: '✵',
      };

    // ── Capacity / availability — honest about there being no open spot. ─────────
    case 'full':
      return {
        label: 'Full',
        copy: 'Full — no spots left right now; check the source in case one opens up.',
        section: 'expected',
        tone: 'muted',
        icon: '⊘',
      };
    case 'waitlist':
      return {
        label: 'Waitlist only',
        copy: 'Full — waitlist only. You can add your name on the source.',
        section: 'expected',
        tone: 'info',
        icon: '⊘',
      };

    // ── Freshness / lifecycle. ───────────────────────────────────────────────────
    case 'stale':
      return { label: 'May be stale', copy: 'Last check is a few days old — may be out of date.', section: 'expected', tone: 'muted', icon: '⧖' };
    case 'suspended':
      return {
        label: 'Suspended',
        copy: 'Temporarily suspended — check the source before you go.',
        section: 'expected',
        tone: 'cancelled',
        icon: '‖',
      };
    case 'cancelled':
      return { label: 'Cancelled', copy: 'This occurrence was cancelled.', section: 'expected', tone: 'cancelled', icon: '✕' };
    case 'postponed':
      return { label: 'Postponed', copy: 'This occurrence was postponed.', section: 'expected', tone: 'cancelled', icon: '✕' };

    default:
      // Unreachable for the 16 canonical values above; a defensive honest fallback for any
      // unexpected string so an unknown status is never silently shown as available.
      return { label: 'Unverified', copy: 'Status unclear — check the official source.', section: 'expected', tone: 'muted', icon: '⋯' };
  }
}

/** Card/detail-ready source-confidence read: an authority-tier label + a Badge tone. */
export interface ConfidenceMeta {
  /** Short, honest card label — the source-authority tier, not the occurrence status. */
  label: string;
  /** Badge variant (a subset of the shared `Badge` primitive's variants). */
  tone: 'confirmed' | 'info' | 'neutral';
}

/**
 * Source-confidence → card label + tone (BR-13; Brand V2 §11; Blueprint screen-2 "Confirmed ·
 * Official source"). This is the SOURCE-AUTHORITY read (who vouches for the listing), distinct
 * from the occurrence `status` (whether it runs) that `statusMeta` covers — the card surfaces
 * both so "source confidence" is visible, never colour-only (G-T22-2). Honest by tier: an
 * official source reads "Official source", an editorial aggregator reads "Editorial listing",
 * an unverified community row reads "Community-listed" (never dressed up as official).
 */
export function confidenceMeta(confidence: ConfidenceLabel): ConfidenceMeta {
  switch (confidence) {
    case 'confirmed':
    case 'official':
      return { label: 'Official source', tone: 'confirmed' };
    case 'editorial':
      return { label: 'Editorial listing', tone: 'info' };
    case 'candidate':
    default:
      return { label: 'Community-listed', tone: 'neutral' };
  }
}

/**
 * Plain-language age read for the "Who it's for" section. Grounded ONLY in the
 * numeric age_min/age_max the source gave us — no invented "fit score". Maps the
 * range onto the canonical age_band taxonomy (under2 / 2-4 / 5-9 / 10-14 / 15+)
 * for a parent-readable band label, and states the sibling read honestly from the
 * width of the range (how many bands it spans), never more than the data supports.
 */
export interface AgeGuide {
  /** The plain range, e.g. "Ages 5–9" — same source of truth as the stat row. */
  range: string;
  /** Parent-readable band, e.g. "Toddlers" or "Babies to tweens". */
  band: string;
  /** Honest sibling read, derived only from how wide the band is. */
  siblingFit: string;
  /** True when the source didn't narrow the ages (open 0–15+ span) — flag, don't overclaim. */
  unspecified: boolean;
}

// Canonical bands (TSD §6.1 age_band), upper bound inclusive in whole years.
const AGE_BANDS: { upperYear: number; label: string }[] = [
  { upperYear: 1, label: 'babies' },
  { upperYear: 4, label: 'toddlers' },
  { upperYear: 9, label: 'school-age kids' },
  { upperYear: 14, label: 'tweens' },
  { upperYear: Infinity, label: 'teens' },
];

function bandIndex(year: number): number {
  const i = AGE_BANDS.findIndex((b) => year <= b.upperYear);
  return i === -1 ? AGE_BANDS.length - 1 : i;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ageGuide(min: number, max: number): AgeGuide {
  const range = formatAges(min, max);
  const unspecified = min <= 0 && max >= 15; // source gave no meaningful narrower bound

  const lo = bandIndex(Math.max(0, min));
  const hi = bandIndex(max);
  const spanned = hi - lo + 1;
  const band =
    lo === hi ? capitalise(AGE_BANDS[lo].label) : `${capitalise(AGE_BANDS[lo].label)} to ${AGE_BANDS[hi].label}`;

  let siblingFit: string;
  if (unspecified) {
    siblingFit = "The source doesn't list an age limit — check the listing for any toddler restrictions.";
  } else if (spanned >= 3) {
    siblingFit = 'Wide age range — one outing that can work for siblings of different ages.';
  } else if (spanned === 2) {
    siblingFit = 'Spans two age groups — usually fine for close-in-age siblings.';
  } else {
    siblingFit = 'Aimed at one age group — best when your kids are close in age.';
  }

  return { range, band, siblingFit, unspecified };
}

/**
 * "Good to know" practical facts — scannable qualities drawn straight from real
 * boolean fields (indoor/outdoor, rainy-day suitability, drop-in). Additive to the
 * stat row, never a marketing claim. Order is stable for deterministic rendering.
 */
export function practicalFacts(
  activity: Pick<Activity, 'indoor' | 'rainyDay' | 'dropIn'>
): string[] {
  const facts = [activity.indoor ? 'Indoor' : 'Outdoor'];
  if (activity.rainyDay) facts.push('Rainy-day friendly');
  if (activity.dropIn) facts.push('No registration needed');
  return facts;
}

/** Trailing extension the ingest guard admits (`ext`/`x`/`extension`, ≤6 digits). */
const PHONE_EXTENSION = /\s*(?:ext|x|extension)\.?\s*(\d{1,6})\s*$/i;

/**
 * `tel:` target for a venue phone. The stored value is the SOURCE'S OWN rendering and is
 * displayed verbatim (docs/source-register.md §6.3.6) — only the dial target is normalised,
 * to the digits a dialer can actually use, keeping a leading `+` when the source gave one.
 *
 * The extension is split off rather than swept into the digit run: `normaliseVenuePhone`
 * admits `ext.`-suffixed values, and concatenating those digits onto the subscriber number
 * would dial a DIFFERENT number. RFC 3966's `;ext=` is what dialers actually understand.
 *
 * Returns null when nothing dialable survives, so a caller renders no link rather than a
 * dead one.
 */
export function telHref(phone: string): string | null {
  const value = phone.trim();
  const extension = value.match(PHONE_EXTENSION);
  const subscriber = extension ? value.slice(0, extension.index) : value;
  const digits = subscriber.replace(/\D/g, '');
  if (digits.length < 7) return null; // same floor the ingest guard uses (MIN_PHONE_DIGITS)
  const plus = subscriber.trimStart().startsWith('+') ? '+' : '';
  return `tel:${plus}${digits}${extension ? `;ext=${extension[1]}` : ''}`;
}

/**
 * "15 slots, 3:15 PM–7:30 PM" — the when-line for a card that stands for several same-day slots
 * of one series. Returns null for an ordinary single-slot card, whose caller keeps `formatWhen`.
 *
 * The span runs from the first slot's start to the LAST slot's end, so it describes the window a
 * parent can actually arrive in. Collapsing is same-day only, so this can never straddle a date.
 */
export function formatSlotSummary(
  activity: Pick<Activity, 'slotCount' | 'startIso' | 'slotEndIso' | 'endIso'>,
): string | null {
  const count = activity.slotCount ?? 1;
  if (count < 2) return null;
  const span = formatWhen(activity.startIso, activity.slotEndIso ?? activity.endIso);
  return `${count} slots, ${span.time}`;
}

/** The registration-required card tag. One phrase, used everywhere, so the label never drifts. */
export const REGISTRATION_REQUIRED_TAG = 'Registration required';

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
