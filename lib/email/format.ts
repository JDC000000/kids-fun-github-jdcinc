// lib/email/format.ts — pure presentation helpers for the digest (no DB / no I/O).
//
// All user-facing dates render in America/Vancouver (the product's single local
// timezone, TSD cross-cutting canon) regardless of the server's timezone. Cost and
// "when" strings follow the brand rule: pair every signal with a plain-language
// label, never colour/emoji alone.
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

/** Plain-language cost label (BR-11: unknown/check_source is NEVER shown as free). */
export function formatCost(listing: ListingRecord): string {
  switch (listing.costStatus) {
    case 'free':
      return 'Free';
    case 'known': {
      const { costMinCad: min, costMaxCad: max } = listing;
      if (min == null && max == null) return 'Cost varies';
      const fmt = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
      if (min != null && max != null && min !== max) return `${fmt(min)}–${fmt(max)}`;
      const one = (min ?? max) as number;
      return one === 0 ? 'Free' : fmt(one);
    }
    case 'check_source':
      return 'Check source for cost';
    case 'unknown':
    default:
      return 'Cost not listed';
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
