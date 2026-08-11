// lib/email/format.ts — pure presentation helpers for the digest (no DB / no I/O).
//
// All user-facing dates render in America/Vancouver (the product's single local
// timezone, TSD cross-cutting canon) regardless of the server's timezone. Cost and
// "when" strings follow the brand rule: pair every signal with a plain-language
// label, never colour/emoji alone.
import { readCost } from '@/lib/search/filters/cost';
import type { ListingRecord } from '@/lib/search/types';

const TZ = 'America/Vancouver';

const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const TIME_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  hour: 'numeric',
  minute: '2-digit',
});

/** Human "when" line for a listing, in Vancouver local time. Open-hours attractions
 *  show their opening-window string; timed occurrences show day + start time. */
export function formatWhen(listing: ListingRecord): string {
  if (listing.openHours) {
    return listing.openHoursLocal
      ? 'Open daily'
      : 'Open hours — see listing';
  }
  if (!listing.startDatetimeUtc) return 'Date to be confirmed';
  const start = new Date(listing.startDatetimeUtc);
  if (Number.isNaN(start.getTime())) return 'Date to be confirmed';
  return `${DAY_FMT.format(start)}, ${TIME_FMT.format(start)}`;
}

/** Money as the digest prints it: whole dollars bare, part-dollars to the cent. */
function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/**
 * Plain-language cost label (BR-11: unknown/check_source is NEVER shown as free).
 *
 * WHAT IS FREE, AND WHAT COUNTS AS A NUMBER WE HOLD, IS NOT DECIDED HERE. `readCost()` in
 * lib/search/filters/cost.ts decides both, by calling the same `isFree()` the Free quick filter
 * uses; this function owns only the digest's WORDS. Until that split, this file carried its own
 * mirror of the rule and told a parent "Free" for `known/min=0/max=null` — a listing `isFree()`
 * rules NOT free and the Free filter therefore EXCLUDES. A promise of free is bad enough on a
 * card the parent can re-check; in an email it has already been read and acted on by the time
 * anyone notices, and there is no way to take it back. The email is the irreversible channel,
 * so it is the one that must not guess.
 *
 * The three not-a-number labels below are deliberately distinct and are kept: they say WHY we
 * have no price, which the card (one label, less room) cannot. "Cost varies" is the honest read
 * for a listing whose status claims a known cost but whose bounds do not yield one — including
 * the lone-zero and contradictory (min > max) cases that used to print "Free" and "$7–$0".
 */
export function formatCost(listing: ListingRecord): string {
  const read = readCost(listing);
  switch (read.kind) {
    case 'free':
      return 'Free';
    case 'amount':
      return money(read.amount);
    case 'range':
      return `${money(read.min)}–${money(read.max)}`;
    case 'unstated':
    default:
      switch (listing.costStatus) {
        case 'check_source':
          return 'Check source for cost';
        case 'known':
          return 'Cost varies';
        case 'unknown':
        default:
          return 'Cost not listed';
      }
  }
}

/** The best outbound link for a listing (booking preferred, then source, then the app). */
export function listingLink(listing: ListingRecord, detailUrl: string): string {
  return listing.bookingUrl || listing.sourceUrl || detailUrl;
}

/** A short, honest label for the saved search (its name, or a fallback from its query). */
export function savedSearchLabel(name: string | null, query: string | undefined): string {
  if (name && name.trim()) return name.trim();
  const q = (query ?? '').trim();
  return q ? `“${q}”` : 'Your saved search';
}
