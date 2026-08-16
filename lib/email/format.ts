// lib/email/format.ts — pure presentation helpers for the digest (no DB / no I/O).
//
// All user-facing dates render in America/Vancouver (the product's single local
// timezone, TSD cross-cutting canon) regardless of the server's timezone. Cost and
// "when" strings follow the brand rule: pair every signal with a plain-language
// label, never colour/emoji alone.
import { readCost } from '@/lib/search/filters/cost';
import { formatRangeLabel, localIsoDate } from '@/lib/search/time/vancouver';
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

/**
 * Human "when" line for a listing, in Vancouver local time.
 *
 * Three shapes, matching the card's (app/preview/_data/format.ts#formatWhen) — an email a parent
 * has already acted on is the one channel where a wrong date cannot be taken back, so it must not
 * describe an occurrence differently from the page it links to:
 *   · open hours → the venue's own published sentence, verbatim, when we hold one;
 *   · multi-day span → "Jun 24 – Sep 1", never the first day dressed up as the only day;
 *   · single day → day + start time, unchanged.
 */
export function formatWhen(listing: ListingRecord): string {
  if (listing.openHours) {
    return listing.openHoursLabel?.trim() || 'Open hours — see listing';
  }
  if (!listing.startDatetimeUtc) return 'Date to be confirmed';
  const start = new Date(listing.startDatetimeUtc);
  if (Number.isNaN(start.getTime())) return 'Date to be confirmed';
  const spanEndDay = multiDayEndDay(listing, start);
  if (spanEndDay) return formatRangeLabel(localIsoDate(start), spanEndDay);
  return `${DAY_FMT.format(start)}, ${TIME_FMT.format(start)}`;
}

/** The occurrence's last local day when it runs past its first one; null for a single-day event. */
function multiDayEndDay(listing: ListingRecord, start: Date): string | null {
  if (!listing.endDatetimeUtc) return null;
  const end = new Date(listing.endDatetimeUtc);
  if (Number.isNaN(end.getTime())) return null;
  const endDay = localIsoDate(end);
  return endDay > localIsoDate(start) ? endDay : null;
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
 * The three not-a-number labels in `unstatedCostLabel` are deliberately distinct and are kept:
 * they say WHY we have no price, which the card (one label, less room) cannot. "Cost varies" is
 * the honest read for a listing whose status claims a known cost but whose bounds do not yield
 * one — including the lone-zero and contradictory (min > max) cases that used to print "Free"
 * and "$7–$0".
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
    case 'group_range':
      // A COLLAPSED CARD's span — different sessions at different prices — and deliberately NOT the
      // words "Cost varies". `unstatedCostLabel` already returns that exact string for a `known`
      // status that yields no printable number, which is a DIFFERENT claim: there, we hold no price
      // at all; here, we hold two. Two near-identical strings for two different claims is the same
      // collapsed-two-meanings-one-label defect the card's `group_range` wording is fenced against,
      // and this is the channel that cannot take a wrong label back.
      //
      // TYPE-REQUIRED AND RUNTIME-DEAD TODAY — REAL WORDS ANYWAY, ON PURPOSE. Nothing in the digest
      // path collapses: `lib/email/digest.ts#toActivity` maps a bare `ListingRecord`, and this file
      // calls `readCost`, which cannot return this arm — only `readGroupCost` can. The words ship so
      // that the day the digest does gain a group concept it is already honest, instead of shipping
      // a placeholder that has to be noticed first. A stub here would be the guard's whole point
      // wasted: it fired to ask this surface for words, not for a way past it.
      return `Varies by session: ${money(read.min)}–${money(read.max)}`;
    case 'unstated':
      return unstatedCostLabel(listing.costStatus);
    default: {
      // EXHAUSTIVENESS GUARD — `unstated` and `default` are deliberately NOT fused, and this is
      // the whole reason this arm exists.
      //
      // Fused (`case 'unstated': default:`), a NEW `CostRead` arm is swallowed as "we hold no
      // price": the digest would tell a parent "Cost not listed" about a listing we DO have cost
      // information for, and nothing anywhere would say so. This file already carries the reason
      // that is unacceptable here specifically — the digest is the irreversible channel, and it
      // has already shipped one Free-mislabel for this family of reason. Split, the assignment
      // below stops compiling the moment `CostRead` grows an arm this switch does not handle
      // (`read` narrows to `never` here only while every arm is covered), so the next person to
      // add one is told, at build time, that the digest needs words for it. The next queued cost
      // change IS a new arm, so this is the failure it is meant to hit.
      //
      // The guard is a type assignment rather than the absence of a `default:` on purpose: TS2366
      // would only bite while this function keeps an explicit non-undefined return annotation,
      // and it would leave a real path that returns `undefined` into an email. Keeping the arm
      // keeps the honest wording as the runtime floor.
      const unhandledArm: never = read;
      void unhandledArm;
      return unstatedCostLabel(listing.costStatus);
    }
  }
}

/**
 * The digest's three not-a-number labels — WHY we have no price, in the digest's own words.
 * Named so `formatCost`'s exhaustiveness guard can fall back on exactly these words instead of a
 * second copy of them (a second copy of a cost rule is the defect this whole area exists to end).
 */
function unstatedCostLabel(costStatus: ListingRecord['costStatus']): string {
  switch (costStatus) {
    case 'check_source':
      return 'Check source for cost';
    case 'known':
      return 'Cost varies';
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
