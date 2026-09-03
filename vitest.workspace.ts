import { configDefaults, defineWorkspace } from 'vitest/config';

// ─────────────────────────────────────────────────────────────────────────────
// H3 — two test lanes, so only the suites that NEED serial execution pay for it.
//
// THE PROBLEM THIS SOLVES
// Round 21 fixed a real race (T32's trends/benchmark suites became the 2nd and 3rd
// concurrent writer of recent `analytics_event` rows, and the delta assertions in
// tests/analytics/kpi.test.ts started seeing their neighbours' writes) by setting
// `fileParallelism: false` in vitest.config.ts. Correct fix, blunt blast radius: it
// serialised EVERY test file. The suite was small then; it is now 166 files / 1373 tests,
// and the 103 files that never open a database connection were paying for the 63 that do.
// Measured on a 4-core box, fresh Postgres per run: 55.6s before → 26.8s after (2.07x),
// ~29s reclaimed on every CI run.
//
// THE SPLIT
//   • `unit` — every test file that CANNOT reach the shared Postgres: pure logic, and
//     route/component tests that `vi.mock` the db seam or run with DATABASE_URL unset.
//     Nothing they do is observable by another file, so they run fully parallel.
//   • `db`   — DB_INTEGRATION_SUITES below: the files that execute real SQL against the
//     one shared database. They run one file at a time (vitest.config.ts's
//     `fileParallelism: false`, which is a NON-project option — it cannot be set per
//     project, which is why the two lanes are two vitest invocations; see scripts/test.sh).
//
// WHY THE WHOLE DB LANE IS SERIAL, NOT JUST THE ANALYTICS FILES
// "Touches the database" is genuinely not the same as "racy", and the split above turns
// on exactly that distinction — e.g. tests/search/route-db-no-fixture-leak.test.ts has
// "db" in its name but vi.mocks the entire db seam, so it is in the `unit` lane. Within
// the DB lane, though, the conflict graph closes over essentially the whole set, because
// these suites are integration tests over ONE database and most of them read a global
// aggregate somewhere. Representative, individually verified conflicts:
//   • analytics deltas — kpi/trends/benchmark/operating read a GLOBAL aggregate, insert,
//     then assert the exact delta. Any concurrent `analytics_event` writer corrupts it.
//   • tests/admin/dashboard-data.test.ts asserts `sum(byType) === totalEvents` and
//     `registry.enabledSources === ingestion.length` — each pair is two unsynchronised
//     queries, so ANY concurrent `analytics_event`/`source` write breaks the identity.
//   • tests/regions.test.ts asserts `count(*) FROM region WHERE centroid IS NULL === 0`,
//     while tests/admin/taxonomy-crud-db.test.ts creates regions with a NULL centroid.
//   • tests/ingestion/framework.test.ts runs an unscoped `DELETE FROM job_queue` and then
//     claims "the next job", while tests/scheduler/cadence.test.ts enqueues into the same
//     queue (framework.test.ts's own comment still claims it is the sole job_queue writer).
//   • tests/llm/{age,dedup,watermark}-db.test.ts all mint fixtures under
//     `source.family = 'vvtest'`, and two of them cascade-DELETE that whole family in
//     afterAll — deleting each other's rows mid-run.
//   • worker/health/stale.ts's flipStaleOccurrences is an UNSCOPED UPDATE over
//     activity_occurrence; tests/analytics/retention.test.ts and
//     tests/corrections/retention.test.ts purge their tables globally.
// This is measured, not argued: running the db lane WITH --fileParallelism over 10 runs on
// a fresh database failed 3 times, in analytics/kpi ("expected 7 to be 3"), admin/dashboard-
// data ("expected 29 to be 28"), llm/dedup-db and admin/qa-queue-dedup-db — i.e. exactly the
// mechanisms listed above. The same 10 runs serial: 10/10 green.
//
// A handful of DB files are provably self-contained (tests/admin/source-vocab-db.test.ts
// only reads pg_catalog; tests/age_bands.test.ts only reads the seeded `age_band` table;
// the user_profile/saved_search suites are random-uuid scoped). Moving them to a third,
// parallel-DB lane would save ~4s and would need per-pair proof for each one, so they stay
// serial deliberately — documented here as the follow-up, not as an oversight.
//
// ADDING A TEST: any new test file that executes real SQL MUST be added to the list below.
// tests/vitest-lane-split.test.ts enforces that mechanically and fails with the exact
// file name if you forget — it is not a convention you have to remember.
// ─────────────────────────────────────────────────────────────────────────────
export const DB_INTEGRATION_SUITES = [
  'evals/scenarios/golden-db.test.ts',
  'evals/scenarios/kpi-launch-gate.test.ts',
  'evals/scenarios/uat.test.ts',
  'tests/account_data_export.test.ts',
  'tests/account_deletion.test.ts',
  'tests/adapters/venue.test.ts',
  'tests/analytics/trend-query-db.test.ts',
  'tests/admin/audit-db.test.ts',
  'tests/admin/audit-tx-db.test.ts',
  'tests/admin/corrections-resolve-db.test.ts',
  'tests/admin/dashboard-data.test.ts',
  'tests/admin/data-health-db.test.ts',
  'tests/admin/f1-e2e-adminpath.test.ts',
  'tests/admin/gate-db.test.ts',
  'tests/admin/health-verdict-visibility-db.test.ts',
  'tests/admin/manual-listing-db.test.ts',
  'tests/admin/operating-db.test.ts',
  'tests/admin/qa-queue-db.test.ts',
  'tests/admin/sms-subscribers-db.test.ts',
  'tests/retention/sms-retention-db.test.ts',
  'tests/admin/qa-queue-dedup-db.test.ts',
  'tests/admin/qa-queue-paging-db.test.ts',
  'tests/admin/source-crud-db.test.ts',
  'tests/admin/source-vocab-db.test.ts',
  'tests/admin/taxonomy-crud-db.test.ts',
  'tests/admin_guard.test.ts',
  'tests/age_bands.test.ts',
  'tests/analytics/benchmark.test.ts',
  'tests/analytics/kpi.test.ts',
  'tests/analytics/operating.test.ts',
  'tests/analytics/retention-route.test.ts',
  'tests/analytics/retention.test.ts',
  'tests/analytics/trends.test.ts',
  'tests/core/venue-authority.test.ts',
  'tests/corrections/retention-route.test.ts',
  'tests/corrections/retention.test.ts',
  'tests/coverage-status-db.test.ts',
  'tests/email/account_deletion_cascade.test.ts',
  'tests/email/weekly_send.test.ts',
  'tests/geo/backfill-clobber-guard.test.ts',
  'tests/geo/radius-postgres.test.ts',
  'tests/geo/venue-geo-golden.test.ts',
  'tests/health/policy.test.ts',
  'tests/health/season.test.ts',
  'tests/health/sla.test.ts',
  'tests/health/stale.test.ts',
  'tests/ingestion/adapter-registry.test.ts',
  'tests/ingestion/age.test.ts',
  'tests/ingestion/category-tags-db.test.ts',
  'tests/ingestion/confirmed-terms-invariant-db.test.ts',
  'tests/ingestion/framework.test.ts',
  'tests/ingestion/ingest-runner.test.ts',
  'tests/ingestion/reconcile.test.ts',
  'tests/ingestion/seasonal-watcher-db.test.ts',
  'tests/ingestion/series.test.ts',
  'tests/ingestion/source-runner.test.ts',
  'tests/ingestion/venue.test.ts',
  'tests/llm/age-db.test.ts',
  'tests/llm/category-cost-db.test.ts',
  'tests/llm/dedup-adjudication-db.test.ts',
  'tests/llm/dedup-db.test.ts',
  'tests/llm/dedup-deterministic-db.test.ts',
  'tests/llm/dedup-merge-fixture.test.ts',
  'tests/llm/route.test.ts',
  'tests/llm/watermark-db.test.ts',
  'tests/notify/region-notify-db.test.ts',
  'tests/regions.test.ts',
  'tests/rls_admin.test.ts',
  'tests/rls_public_tables.test.ts',
  'tests/rls_user.test.ts',
  'tests/saved_search_crud.test.ts',
  'tests/saved_search_ui_roundtrip.test.ts',
  'tests/scheduler/cadence.test.ts',
  'tests/scheduler/global-jobs-db.test.ts',
  'tests/scheduler/job-dispatch-db.test.ts',
  'tests/scheduler/robots-override-db.test.ts',
  'tests/scheduler/shutdown-sql-db.test.ts',
  // Stage A: the first suites on this branch that write a real sms_consent row.
  'tests/sms/signup_persistence-db.test.ts',
  'tests/sms/send_log-db.test.ts',
  'tests/sms/preferences_weekly-db.test.ts',
  'tests/sms/click_through-db.test.ts',
  'tests/sms/waitlist_store-db.test.ts',
  'tests/sms/inbound_stop_unchanged-db.test.ts',
  'tests/sms/test_number_isolation-db.test.ts',
  'tests/search/postgres-repository.test.ts',
  'tests/snapshot/catalogue-shape.test.ts',
  'tests/snapshot/policy-schema-guard.test.ts',
  'tests/user_profile_provisioning.test.ts',
  'tests/user_profile_update.test.ts',
  'tests/user_scoped_client.test.ts',
];

/** The suite's file roots — previously `test.include` in vitest.config.ts. */
export const TEST_INCLUDE = [
  'tests/**/*.test.{ts,tsx}',
  'app/**/*.test.{ts,tsx}',
  'evals/**/*.test.ts',
  'components/**/*.test.{ts,tsx}',
];

// ─────────────────────────────────────────────────────────────────────────────
// A THIRD LANE — the metamorphic/invariant suite, and why it lives OUTSIDE `tests/`.
//
// invariants/ holds property-style invariants over the combinatorial filter space (region × age
// × date × time-of-day × cost × chips), run at four pinned clocks. It is deliberately NOT under
// `tests/`, and that is a routing decision rather than a filing one:
//
//   • It must NOT run in `scripts/test.sh`. That script is the BLOCKING `ci` job, and this suite
//     is commissioned as report-only (.github/workflows/ci.yml's e2e lane, Jon's ruling
//     2026-08-16, reaffirmed 2026-08-18). test.sh invokes `--project unit` and `--project db`
//     explicitly, so a lane that is neither is out of the gate by construction — no exclude list
//     to keep in sync, and no way for a future edit to make it blocking by accident.
//   • Everything under `tests/` is routed into exactly one of unit/db by
//     tests/vitest-lane-split.test.ts, whose partition assertion is a real drift guard for the
//     shared-Postgres race it exists to prevent. Adding a third destination inside its walk would
//     mean rewriting that guard to know about a lane it has no stake in.
//
// It still runs on a bare `npx vitest run` (the workspace includes it), which is what keeps it
// from rotting the way an unrun Playwright suite did — see the e2e job's own header.
// ─────────────────────────────────────────────────────────────────────────────
export const INVARIANT_INCLUDE = ['invariants/**/*.test.ts'];

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: TEST_INCLUDE,
      exclude: [...configDefaults.exclude, ...DB_INTEGRATION_SUITES],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'db',
      include: DB_INTEGRATION_SUITES,
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'invariants',
      include: INVARIANT_INCLUDE,
      // No `fileParallelism` here on purpose — it is a vitest NON-project option (see the note
      // in vitest.config.ts). npm's `test:invariants` passes --fileParallelism on the command
      // line instead; this suite opens no connection and each file builds its own in-memory
      // catalogue, so nothing it does is observable by a neighbour.
    },
  },
]);
