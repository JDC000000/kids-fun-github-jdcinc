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
  // ── CAPACITY: EXCLUDED FROM RESULTS ENTIRELY (Jon, 2026-09-03) ──
  // A session with no spot left is not an answer to "what can I take my kid to". These were
  // `primary` on the reasoning that each card wears its own status stamp, so "Full" was honest
  // in a list — but honest and useful are different tests, and a parent scanning results is
  // being asked to read past rows they cannot act on.
  //
  // NO VISIBLE EFFECT TODAY. Neither value has ever been set on a live occurrence (0 of ~22,318
  // as of this change): no connector detects capacity yet. This is a guard placed BEFORE the
  // data arrives, so that whichever connector learns to set it cannot ship full sessions into
  // results as a side effect.
  //
  // Set here rather than as a bespoke filter because this table is the single source of truth:
  // `HIDDEN_STATUSES` is derived from it and applied by the SQL read model, and `isHidden` runs
  // over the in-memory pipeline, so one edit closes both. The weekly SMS picks are already
  // stricter — they take only `CONFIRMED_SECTION_STATUSES` — and are unaffected.
  waitlist: 'hidden',
  full: 'hidden',
  postponed: 'primary',
  stale: 'primary', // shown but ranked low (§5A.3)
  // Out-of-window seasonal / low-confidence candidates → separate "expected" section only.
  seasonal_preseason: 'expected',
  seasonal_out_of_season: 'expected',
  manual_candidate: 'expected',
  // Never surface these to parents. (`full`/`waitlist` are also hidden — see the note above.)
  cancelled: 'hidden',
  suspended: 'hidden',
  needs_review: 'hidden',
};

/**
 * The statuses parents are never shown, derived from STATUS_CLASS so the two can never drift.
 *
 * Exported because the DB read model applies this same set in SQL: hidden rows are never useful
 * to catalogue discovery, and if a caller explicitly asks the repository for a bounded diagnostic
 * page, that budget must be spent on showable content. `isHidden` below still runs in the engine:
 * it is the only guard for the fixture backend, and it keeps the in-memory pipeline correct on its
 * own terms rather than trusting the query that fed it.
 */
export const HIDDEN_STATUSES: StatusState[] = (Object.keys(STATUS_CLASS) as StatusState[]).filter(
  (state) => STATUS_CLASS[state] === 'hidden',
);

// Tags denoting a rainy-day-friendly (indoor) activity. Track B models this as the
// context tag `rainy_day`; fixtures/ingest may also carry an `indoor` suitability tag.
// Accept either so the predicate is robust across both vocabularies.
const RAINY_DAY_TAGS = ['rainy_day', 'indoor'] as const;

/** Context tag denoting a drop-in (no-booking, just-show-up) activity. */
const DROP_IN_TAG = 'drop_in';

export interface StatusFilter {
  /** Bookable-Now chip — only listings that can be booked right now. */
  bookableNow: boolean;
  /** Rainy-day chip — indoor suitability. */
  rainyDay: boolean;
  /** Drop-in chip — activities you can just show up to (no booking). */
  dropIn?: boolean;
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

/** Drop-in predicate (chip) — the `drop_in` suitability/context tag (no booking needed). */
export function isDropIn(listing: ListingRecord): boolean {
  const tags = [...listing.suitabilityTags, ...listing.categoryTags];
  return tags.includes(DROP_IN_TAG);
}

/**
 * The statuses that are VERIFIED AND ACTIONABLE RIGHT NOW — the only ones a surface with no room
 * for a caveat may present as an answer.
 *
 * Narrower than `primary`, and the gap is the point. `primary` means "belongs in the result
 * LIST", which is a list a parent reads with each card's own status stamp beside it: `stale`
 * ("last check is a few days old"), `full`, `waitlist` and `postponed` are all primary, all
 * honestly labelled there, and all wrong as one of three bare recommendations on the front door —
 * a parent who acts on "postponed" has been sent somewhere that is not happening.
 *
 * THIS IS THE DOMAIN-SIDE STATEMENT OF A RULE THE RENDER LAYER ALREADY MAKES.
 * `app/preview/_data/format.ts#statusMeta` assigns `section: 'confirmed'` to exactly these two
 * statuses and `section: 'expected'` to all fourteen others, and says so in its own header note
 * (1). That switch cannot be reused here — it is a UI module returning labels, copy, icons and
 * tones, and `lib/` does not import `app/` — so the set is stated once here for the domain, and
 * `tests/recommend/status-section-parity.test.ts` pins the two against each other across all 16
 * states so they cannot drift apart silently.
 */
export const CONFIRMED_SECTION_STATUSES: readonly StatusState[] = ['confirmed', 'bookable_open'] as const;

/**
 * True when a listing is verified and actionable now — see `CONFIRMED_SECTION_STATUSES`.
 *
 * Takes a plain `string` rather than `StatusState` so the surfaces holding a narrower shape can
 * ask this module instead of hand-rolling a second copy of the rule — the same reason
 * `cost.ts#isFree` takes a structural `CostFacts` and `audience.ts` takes an
 * `AudienceSignalInput`. The DTO that crosses the wire types `statusState` as `string`, and an
 * unrecognised value answers `false`, which is the correct fail-safe direction for a gate that
 * decides whether something may be presented with no caveat.
 */
export function isConfirmedSection(listing: { statusState: string }): boolean {
  return (CONFIRMED_SECTION_STATUSES as readonly string[]).includes(listing.statusState);
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
  if (filter.dropIn && !isDropIn(listing)) return false;
  return true;
}
