// lib/search/filters/status.ts — Status predicates (G-T16-6, TSD §5A.4/§5A.5, Appendix C).
//
// Quick-chip predicates (Bookable Now, Rainy-day) plus result-status classification
// that decides what belongs in the primary result list vs the "expected / seasonal"
// broadening section (§5A.5) vs never-shown. Honest ranking (§5A.3) then boosts
// confirmed/bookable within the primary set.

import type { ListingRecord, StatusState } from '../types';

/** Where a status may appear in results. */
export type StatusClass = 'primary' | 'expected' | 'hidden';

/** Classification of every status_state (Appendix C). */
export const STATUS_CLASS: Record<StatusState, StatusClass> = {
  confirmed: 'primary',
  bookable_open: 'primary',
  not_yet_bookable: 'primary',
  schedule_not_published: 'primary',
  inferred_recurring: 'primary',
  seasonal_active: 'primary',
  waitlist: 'primary',
  full: 'primary',
  postponed: 'primary',
  stale: 'primary', // shown but ranked low (§5A.3)
  // Out-of-window seasonal / low-confidence candidates → separate "expected" section only.
  seasonal_preseason: 'expected',
  seasonal_out_of_season: 'expected',
  manual_candidate: 'expected',
  // Never surface these to parents.
  cancelled: 'hidden',
  suspended: 'hidden',
  needs_review: 'hidden',
};

// Tags denoting a rainy-day-friendly (indoor) activity. Track B models this as the
// context tag `rainy_day`; fixtures/ingest may also carry an `indoor` suitability tag.
// Accept either so the predicate is robust across both vocabularies.
const RAINY_DAY_TAGS = ['rainy_day', 'indoor'] as const;

export interface StatusFilter {
  /** Bookable-Now chip — only listings that can be booked right now. */
  bookableNow: boolean;
  /** Rainy-day chip — indoor suitability. */
  rainyDay: boolean;
}

/** Bookable-Now predicate (chip). */
export function isBookableNow(listing: ListingRecord): boolean {
  return listing.statusState === 'bookable_open';
}

/** Rainy-day predicate (chip) — indoor suitability (`rainy_day` or `indoor` tag). */
export function isRainyDayFriendly(listing: ListingRecord): boolean {
  const tags = [...listing.suitabilityTags, ...listing.categoryTags];
  return RAINY_DAY_TAGS.some((t) => tags.includes(t));
}

/** Belongs in the primary result list. */
export function isPrimaryResult(listing: ListingRecord): boolean {
  return STATUS_CLASS[listing.statusState] === 'primary';
}

/** Belongs in the separate "expected / seasonal / evergreen" section (broadening §5A.5). */
export function isExpectedSection(listing: ListingRecord): boolean {
  return STATUS_CLASS[listing.statusState] === 'expected';
}

/** Never shown to parents. */
export function isHidden(listing: ListingRecord): boolean {
  return STATUS_CLASS[listing.statusState] === 'hidden';
}

/** Apply the active status chips to a listing. */
export function matchesStatus(listing: ListingRecord, filter: StatusFilter): boolean {
  if (filter.bookableNow && !isBookableNow(listing)) return false;
  if (filter.rainyDay && !isRainyDayFriendly(listing)) return false;
  return true;
}
