// lib/testing/today-seed-anchor.ts — a SQL instant for DB tests that seed "N minutes/hours
// ago" rows and then assert on TODAY's date_trunc('day', now()) bucket.
//
// Seeding at `now() - interval '3 hours'` only lands in today while at least 3 hours of today
// have elapsed. Just after midnight (in the session time zone, UTC in CI, which is 17:00-22:00
// in Vancouver) those rows fall into yesterday's bucket and the "counts into today" assertions
// fail, so the result depended on the time of day the suite ran.
//
// Seeding relative to this anchor instead keeps it deterministic:
//   • it is always inside today's bucket, at least 6 hours in, so an offset of up to 6 hours
//     still lands today;
//   • from 06:00 onward it IS now(), so behaviour is unchanged for most of the day;
//   • offsets in whole days still land exactly N calendar days back.
// Before 06:00 the seeded rows sit up to 6 hours in the future. The operating read models bucket
// with date_trunc and apply no `<= now()` bound, so this does not change what they count.
export const TODAY_SEED_ANCHOR_SQL = "GREATEST(now(), date_trunc('day', now()) + interval '6 hours')";
