// Pure, deterministic formatters for the mobile shell. No React, no I/O — unit-tested.
// Every number a parent reads (time, age, cost, distance, freshness) is formatted
// here so it stays consistent and honest across card + detail (D2 tabular numerals).

import { readGroupCost } from '@/lib/search/filters/cost';
import { formatRangeLabel, localIsoDate, localMinutesOfDay } from '@/lib/search/time/vancouver';
import type { Activity, ConfidenceLabel, StatusMeta, StatusState } from './types';

const VANCOUVER_TZ = 'America/Vancouver';

/**
 * Reference "now" for the static fixtures (matches the sprint date).
 *
 * NOT the default for the freshness math any more, and that is the whole of P0-3. This constant
 * used to be the default `nowIso` of `daysSince`/`formatChecked`, so every LIVE card measured its
 * last check against 13 July 2026 — a frozen date, months behind the reader — and `daysSince`'s
 * `Math.max(0, …)` floor collapsed every one of those negative differences to 0. The badge was
 * therefore not "sometimes wrong": every listing checked at any point after 13 July 2026, which
 * is every listing the crawler has ever touched, printed **"Checked today"**, permanently,
 * regardless of when it was actually checked. Measured against the 2026-08-18 snapshot DB
 * (603 live occurrences, last_checked_at spanning 16–17 August): 603 of 603 rendered "Checked
 * today". The honest readings, in the Vancouver calendar-day frame this module measures in,
 * are "Checked yesterday" (183) and "Checked 2 days ago" (420) — not one listing of the 603
 * had been checked on the day it claimed to have been.
 *
 * This badge is the product's stated differentiator, so a badge that is structurally incapable
 * of saying anything but "today" is the most expensive untruth on the card — the same shape of
 * defect as `formatAges`' fabricated "All ages" and `formatCost`' invented "$0", except this one
 * was making an affirmative claim about our own diligence.
 */
export const FIXTURE_NOW = '2026-07-13T09:00:00-07:00';

/** The when-line a card and a detail page both print: a day (or span) plus a time (or hours). */
export interface WhenLine {
  day: string;
  time: string;
}

/** Heading for a listing the source publishes with no fixed date. Matches the day-group bucket. */
export const NO_FIXED_DATE_DAY = 'Available any day';
/** Fallback when a dateless listing's source did not publish its hours either. */
const NO_FIXED_DATE_TIME = 'Check opening hours';
/** A multi-day span whose edges are not whole days: the per-day times are not ours to invent. */
const MULTI_DAY_TIME = 'See listing for times';
/** A multi-day span that covers its days end to end. */
const ALL_DAY_TIME = 'All day';
/** Local minute at/after which an end instant is treated as closing out its whole day. */
const END_OF_DAY_MIN = 23 * 60 + 58;

/**
 * The Vancouver-local when-line for an occurrence — the one place "when is this on?" is turned
 * into words. Three shapes, because occurrences genuinely come in three shapes:
 *
 *  1. NO FIXED DATE (`startIso === null`) → "Available any day · Daily 10 AM–5 PM". A standing
 *     open-hours record has no start instant; printing the venue's own hours is the only honest
 *     answer. Previously the mapper substituted `new Date()` to satisfy a non-nullable type, so
 *     these rendered as a zero-length event at page-load time (and as 1969-12-31 anywhere the
 *     null reached `new Date()` directly).
 *
 *  2. MULTI-DAY SPAN (end lands on a LATER local day than start) → "Jul 8 – Sep 2 · All day".
 *     This is the defect the effectiveness testing caught: Richmond Public Library publishes
 *     summer programmes as single occurrences spanning weeks (Summer Scavenger Hunt, verified
 *     live: 2026-07-08 → 2026-09-03). Taking the day from `start` and the clock from both ends
 *     printed "Wed, Jul 8 · 12 AM–11:59 PM" — a parent on 16 August reads a one-day event that
 *     finished five weeks ago, stamped "Confirmed · Checked today". The listing was never
 *     expired and the data was never wrong; only this line was.
 *
 *  3. SINGLE DAY → "Wed, Jul 8 · 2 PM–4:30 PM", unchanged.
 *
 * Pure and deterministic: it never consults the clock, so it states what the occurrence IS, not
 * how it relates to now.
 */
export function formatWhen(
  startIso: string | null,
  endIso: string | null,
  openHoursLabel?: string | null,
): WhenLine {
  if (!startIso) {
    return { day: NO_FIXED_DATE_DAY, time: openHoursLabel?.trim() || NO_FIXED_DATE_TIME };
  }
  const start = new Date(startIso);
  const end = new Date(endIso ?? startIso);
  if (Number.isNaN(start.getTime())) {
    return { day: NO_FIXED_DATE_DAY, time: openHoursLabel?.trim() || NO_FIXED_DATE_TIME };
  }
  // An unparseable or backwards end must never widen the span; fall back to a single-day read.
  const usableEnd = Number.isNaN(end.getTime()) || end < start ? start : end;

  const startDay = localIsoDate(start);
  const endDay = localIsoDate(usableEnd);
  if (endDay > startDay) {
    return {
      day: formatRangeLabel(startDay, endDay),
      time: coversWholeDays(start, usableEnd) ? ALL_DAY_TIME : MULTI_DAY_TIME,
    };
  }

  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: VANCOUVER_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(start);
  return { day, time: `${formatClock(start)}–${formatClock(usableEnd)}` }; // en-dash range
}

/**
 * "Open 10 AM–5 PM" from a daily opening window in local minutes-past-midnight.
 *
 * The second of the two shapes a standing-hours record can hold: the live read model carries the
 * venue's sentence verbatim (`open_hours_state`), while a parsed record carries a numeric window
 * (`openHoursLocal`). Either is a real published fact about when the place is open; both must
 * reach the when-line, because a dateless listing with neither is a listing we cannot honestly
 * say anything about.
 */
export function formatOpenHoursWindow(window: { startMin: number; endMin: number }): string {
  return `Open ${clockFromMinutes(window.startMin)}–${clockFromMinutes(window.endMin)}`;
}

function clockFromMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minute === 0 ? `${hour12} ${meridiem}` : `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

/** Does a multi-day span run from the very start of its first local day to the end of its last? */
function coversWholeDays(start: Date, end: Date): boolean {
  return localMinutesOfDay(start) === 0 && localMinutesOfDay(end) >= END_OF_DAY_MIN;
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

/**
 * The words for a listing whose source never stated an age. NOT "All ages" — see formatAges.
 * One constant so the card, the detail stat row, the "Who it's for" panel and the share
 * meta-description cannot drift into three different phrasings of the same absence.
 */
export const AGE_NOT_STATED = 'Age not stated by source';

/**
 * "Ages 5–9", "Under 6", "Ages 16+", "All ages", or — when the source stated nothing —
 * "Age not stated by source".
 *
 * WHY THE LAST CASE EXISTS, AND WHY IT IS NOT "All ages". A missing age used to reach this
 * function as the concrete pair (0, 18) — a fallback invented one layer up in search-api.ts —
 * and fell straight into the "All ages" arm. Measured on the live API 2026-08-16: 41 of 100
 * sampled listings held null bounds and every one of them told parents "All ages". That is a
 * permissive claim manufactured out of silence, and it is the reason the age facet read as
 * inert: a parent filtering for a two-year-old saw lane swim, adult programmes and
 * "Sauna and Whirlpool Only" all wearing the same reassuring label.
 *
 * Absent data must render as absent. The listing is still SHOWN under every age filter — an
 * honestly-unknown age is not grounds for hiding a listing (lib/search/filters/age.ts's
 * "empty → don't hide" rule is deliberate and stays) — it is simply no longer allowed to claim
 * it suits everybody.
 *
 * A `max` of null means OPEN-ENDED when `min` is known, and unknown only when `min` is null
 * too, so a source that genuinely does say "all ages" (min 0, no upper bound) keeps saying so.
 */
export function formatAges(min: number | null, max: number | null): string {
  if (min === null && max === null) return AGE_NOT_STATED;
  const lower = min ?? 0;
  // null = the source set no ceiling; 18+ = past any meaningful kids-band bound.
  const openEnded = max === null || max >= 18;
  if (lower <= 0 && openEnded) return 'All ages';
  if (openEnded) return `Ages ${lower}+`;
  if (lower <= 0) return `Under ${max! + 1}`;
  if (lower === max) return `Age ${lower}`;
  return `Ages ${lower}–${max}`;
}

/**
 * The card's one not-a-number cost read. Unknown cost gets THIS, never a price and never "Free".
 *
 * STRENGTHENED FROM "Cost — check source" (Option C, Jon's ruling 2026-08-17). User testing
 * flagged that admitting unpriced listings under the Free filter "looks like a lie" — the
 * standing ruling (this module, and lib/search/filters/cost.ts) is that unpriced listings must
 * NEVER be hidden, so the fix is honesty, not suppression: the label itself has to read as a
 * clear statement of uncertainty ("we don't know"), not a neutral pointer ("go look elsewhere").
 * "check source" stays, because a parent still needs to know where to find the real number.
 */
const COST_UNKNOWN = 'Price not confirmed — check source';

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
 *
 * ONE CARD CAN STAND FOR SEVERAL SESSIONS, AND IT MAY NOT PRINT ONE OF THEM AS IF IT SPOKE FOR ALL.
 * Collapsing (lib/search/collapse.ts) puts every same-series-same-day occurrence behind ONE card,
 * and this formatter used to read only the representative's three cost fields — so a card standing
 * for a $103 session and a $240 session said "$103". Measured 2026-08-11, all-time: 9 such groups.
 * `readGroupCost` is therefore the authority here, and `activity.slotCosts` is the group; a card
 * with no `slotCosts` passes itself as a group of one, which is why every single-slot card's label
 * is unchanged to the byte. The words for a disagreeing group are BELOW and are deliberately not
 * the `range` words — see the `group_range` arm.
 */
export function formatCost(
  activity: Pick<Activity, 'costStatus' | 'costMinCad' | 'costMaxCad' | 'slotCosts'>,
): string {
  const read = readGroupCost(activity.slotCosts ?? [activity]);
  switch (read.kind) {
    case 'free':
      return 'Free';
    case 'amount':
      return `$${read.amount} approx.`;
    case 'range':
      return `$${read.min}–$${read.max}`;
    case 'group_range':
      // A GROUP's span, and it must not be readable as ONE session's bounds. `$103–$240` on the arm
      // above already means a single session whose own price spans that; this card means one
      // session at $103 and a different one at $240. Same string for both claims and the card is
      // back to stating a price that is true of something other than what it stands for, which is
      // the whole defect. The leading word is the difference, and it is a hard fence (Jon, 2026-08-12).
      return `Varies: $${read.min}–$${read.max}`;
    case 'unstated':
      return COST_UNKNOWN;
    default: {
      // EXHAUSTIVENESS GUARD — `unstated` and `default` are deliberately NOT fused.
      //
      // Fused (`case 'unstated': default:`), a NEW `CostRead` arm is swallowed as "we hold no
      // price": this card would print COST_UNKNOWN's words for a listing we DO have cost
      // information for, which is the same shape of silent mislabel the hand-rolled mirror above
      // this function was deleted for. Split, the assignment below stops compiling the moment
      // `CostRead` grows an arm this switch does not handle (`read` narrows to `never` here only
      // while every arm is covered), so whoever adds one is told at build time that the card
      // needs words for it. The next queued cost change IS a new arm.
      //
      // The arm is kept (rather than deleted to let the missing return bite) so the card still
      // has an honest runtime floor, and so the guard does not depend on this function keeping an
      // explicit return annotation.
      const unhandledArm: never = read;
      void unhandledArm;
      return COST_UNKNOWN;
    }
  }
}

/**
 * The card's one not-a-number distance read — the sibling of COST_UNKNOWN above, and used for
 * the same reason: a missing measurement is stated, never filled in. Reached whenever the search
 * had no origin to measure from (no near-me coordinates, no saved location — the DEFAULT for an
 * anonymous search) or the venue is un-geocoded. Both are true of "unavailable"; naming a cause
 * ("set your location") would be a guess, and would be wrong for the un-geocoded half.
 */
const DISTANCE_UNKNOWN = 'Distance unavailable';

/**
 * "Trout Lake · 12 min drive · 4.1 km" — geography as a practical travel radius — or
 * "Trout Lake · Distance unavailable" when there is no measured distance to state.
 *
 * The AREA is kept in both readings on purpose. It is the one piece of geography we always
 * hold, it is what the line is for once the number is gone, and keeping it means the meta row
 * neither collapses nor changes height between the two states.
 */
export function formatDistance(activity: Pick<Activity, 'area' | 'driveMinutes' | 'distanceKm'>): string {
  if (activity.distanceKm == null) return `${activity.area} · ${DISTANCE_UNKNOWN}`;
  const km = activity.distanceKm.toFixed(1);
  return `${activity.area} · ${activity.driveMinutes} min drive · ${km} km`;
}

/**
 * The bare distance for the detail page's stat row — "4.1 km", or "Unavailable" under the
 * row's own "Distance" label (which is already the noun, so the label is not repeated).
 */
export function formatDistanceValue(activity: Pick<Activity, 'distanceKm'>): string {
  return activity.distanceKm == null ? 'Unavailable' : `${activity.distanceKm.toFixed(1)} km`;
}

/**
 * Whole-day difference between a check timestamp and now, in the Vancouver day frame — or
 * `null` when there is no usable timestamp to measure from (absent, or unparseable).
 *
 * `nowIso` defaults to the REAL clock. It stays injectable, because the fixture shell and every
 * test need a fixed reference, but a caller that passes nothing now gets today instead of the
 * sprint date this module used to hardcode (see FIXTURE_NOW's header for what that cost).
 *
 * THE 0 FLOOR STAYS, and is now only reachable by clock skew — a row stamped a little ahead of
 * the reader's clock. "Checked in -1 days" is not a sentence a parent can read. What made the
 * floor dangerous was never the floor; it was a default `now` months in the past, which turned a
 * guard against skew into a guarantee of "today".
 */
export function daysSince(
  lastCheckedIso: string | null,
  nowIso: string = new Date().toISOString(),
): number | null {
  if (!lastCheckedIso) return null;
  const then = new Date(lastCheckedIso);
  const now = new Date(nowIso);
  // An unparseable instant is "we don't know when", not "0 days ago" — and `startOfVancouverDay`
  // throws on an Invalid Date, so this guard is load-bearing as well as honest.
  if (Number.isNaN(then.getTime()) || Number.isNaN(now.getTime())) return null;
  const ms = startOfVancouverDay(now) - startOfVancouverDay(then);
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

/**
 * The words for a listing we hold no check timestamp for — the sibling of AGE_NOT_STATED,
 * COST_UNKNOWN and DISTANCE_UNKNOWN, and here for the same reason: an absent fact is STATED,
 * never filled in.
 *
 * Reached whenever `activity_occurrence.last_checked_at` is null — a row nothing has ever
 * ingested or re-checked. That null used to be replaced with `new Date().toISOString()` one
 * layer up in search-api.ts, which manufactured a freshness claim ("Checked today") out of a
 * row we have never once looked at. Of the two possible readings of a missing timestamp, that
 * boundary picked the single most flattering one and printed it with full confidence.
 *
 * Deliberately NOT "Not checked recently": we do not know that it wasn't: we know only that we
 * hold no record of a check. Naming the record, rather than guessing at the world, is the same
 * distinction `AGE_NOT_STATED` draws between "no age applies" and "the source stated no age".
 */
export const CHECK_NOT_RECORDED = 'Last check not recorded';

/**
 * Human "Checked today / Checked yesterday / Checked 12 days ago" for the freshness stamp —
 * or CHECK_NOT_RECORDED when we hold no timestamp for this listing.
 *
 * Measured against the REAL clock by default (see `daysSince`). No threshold buckets and no
 * upper cap: a listing last checked 200 days ago says so, in the same words as one checked
 * yesterday. A cap would put a floor under how bad the number is allowed to look, which is the
 * defect this function is being repaired from, one storey up.
 */
export function formatChecked(
  lastCheckedIso: string | null,
  nowIso: string = new Date().toISOString(),
): string {
  const days = daysSince(lastCheckedIso, nowIso);
  if (days === null) return CHECK_NOT_RECORDED;
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
 * One plain sentence explaining what a source-confidence tier means — the detail page's
 * "Source & freshness" panel used to print the raw `ConfidenceLabel` enum value verbatim
 * ("Confidence: candidate"), which is exactly the false-precision-by-omission this product's
 * honest-by-default voice forbids elsewhere (formatCost's COST_UNKNOWN, AGE_NOT_STATED):
 * a value a parent cannot interpret is not a fact they were told, it's jargon they were shown.
 *
 * Deliberately NOT "Reviewed by our editorial team" for the `editorial` tier, even though that
 * reads naturally: `editorial` here means the SOURCE is a third-party aggregator/round-up
 * (worker/core/confidence.ts's CANDIDATE_AUTHORITY_TIER comment — "a '10 best things to do
 * with kids' round-up, a what's-on blog"), not that this product's own team reviewed the
 * listing. Claiming an in-house review that never happened is the same shape of invented
 * specificity `formatCost`'s header warns against, just in prose instead of a number.
 *
 * Same tone/tier grouping as `confidenceMeta` (its four cases are the only values
 * `Activity.confidence` can ever hold — see `mapConfidence` in `search-api.ts`), so the label
 * badge and this sentence can never disagree about which tier a listing is in.
 */
export function confidenceSentence(confidence: ConfidenceLabel): string {
  switch (confidence) {
    case 'confirmed':
      return 'Verified — confirmed directly by the official source, and checked recently.';
    case 'official':
      return 'Verified — confirmed directly by the official source.';
    case 'editorial':
      return 'From an editorial or listings source, not directly confirmed by the venue or organiser.';
    case 'candidate':
    default:
      return 'Not yet verified — check the official source before you rely on it.';
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

export function ageGuide(min: number | null, max: number | null): AgeGuide {
  const range = formatAges(min, max);

  // Nothing to map onto a band, and nothing honest to say about siblings. The old code
  // reached here with the invented (0, 18) and confidently answered "Babies to teens · Wide
  // age range — one outing that can work for siblings of different ages" about a listing whose
  // source never mentioned age at all.
  if (min === null && max === null) {
    return {
      range,
      band: 'Not stated',
      siblingFit: "The source doesn't state who this is for — check the official listing before you go.",
      unspecified: true,
    };
  }

  const lower = min ?? 0;
  const upper = max ?? 18; // open-ended: treat as reaching the top band for the span read
  const unspecified = lower <= 0 && upper >= 15; // source gave no meaningful narrower bound

  const lo = bandIndex(Math.max(0, lower));
  const hi = bandIndex(upper);
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
  const facts: string[] = [];
  // A NULL reading prints nothing at all. This line used to be `activity.indoor ? 'Indoor' :
  // 'Outdoor'`, which had no way to abstain: every listing got one of the two labels whether or
  // not anything supported it, so "the source never said" was published as a flat "Outdoor" —
  // the mirror image of the `class_program` → "Indoor" defect, and just as actionable to a parent
  // packing a raincoat. "Good to know" is already conditional on `facts.length > 0`
  // (ActivityDetail), so an unknown listing simply drops the panel rather than filling it with a
  // guess. Same ruling as `ageGuide`'s "Not stated" a few hundred lines up.
  if (activity.indoor === true) facts.push('Indoor');
  else if (activity.indoor === false) facts.push('Outdoor');
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
