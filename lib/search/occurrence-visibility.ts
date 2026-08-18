// lib/search/occurrence-visibility.ts — the read-model visibility rule, over a loaded record.
//
// THIS IS A DELIBERATE MIRROR of `visibleOccurrenceWhereSql()` in ./postgres-repository.ts.
// Postgres owns the PRODUCTION copy of the rule, and must: it runs inside the catalogue query,
// so the rows never reach JavaScript in the first place. Two representations of one rule is a
// drift risk, taken on purpose and bounded deliberately:
//
//   WHY IT EXISTS. That SQL predicate is the mechanism behind the "Today is empty by 10pm"
//   report — the catalogue floor tracks `now()`, an INSTANT, so every occurrence that has
//   already ended leaves the read model and a `when=today` search monotonically empties as the
//   local day advances. Reproducing that against the live database means owning the wall clock,
//   which no test can. Expressed here, the same rule is pinnable at a fixed instant against a
//   fixed catalogue — see tests/search/today-window-exhaustion.test.ts, which is the regression
//   guard for the whole defect.
//
//   HOW DRIFT IS CAUGHT. The SQL is pinned to four canonical row shapes (expired-with-hours,
//   expired-plain, running-span, standing) by tests/search/postgres-repository.test.ts's
//   "excludes an expired dated occurrence even when it also carries an open-hours string".
//   The same four shapes are pinned against THIS function, so the two halves cannot disagree
//   in any of the cases that motivated either of them.
//
// The SQL's `o.archived_at IS NULL` arm has no counterpart below and needs none: `archived_at`
// is not part of the read model, so an archived row can never become a `ListingRecord` to test.

import type { ListingRecord } from './types';

/**
 * Is this occurrence still in the catalogue at `now`?
 *
 * The two arms are the SQL's two arms, in order:
 *   1. `o.start_datetime_utc IS NULL AND o.open_hours_state IS NOT NULL` — a genuinely dateless
 *      standing record (a pool, a drop-in gym). Visible indefinitely. Note that the openHours
 *      flag is required, exactly as in SQL: a row with neither a date nor an hours string is
 *      not "dateless", it is unusable, and `COALESCE(NULL, NULL) >= now()` is NULL, not true.
 *   2. `COALESCE(o.end_datetime_utc, o.start_datetime_utc) >= now()` — anything with a date is
 *      judged on its END (falling back to its start when it has none), whatever else it carries.
 */
export function isOccurrenceVisibleAt(listing: ListingRecord, now: Date): boolean {
  if (listing.startDatetimeUtc == null) return listing.openHours;
  const endsAt = Date.parse(listing.endDatetimeUtc ?? listing.startDatetimeUtc);
  // An unparseable timestamp is not a date in the future; SQL would compare against NULL and
  // drop the row, and a row we cannot place in time must not be shown as if it were current.
  if (Number.isNaN(endsAt)) return false;
  return endsAt >= now.getTime();
}

/** The catalogue as the read model would return it at `now` — every ended occurrence dropped. */
export function pruneEndedOccurrences(listings: readonly ListingRecord[], now: Date): ListingRecord[] {
  return listings.filter((l) => isOccurrenceVisibleAt(l, now));
}
