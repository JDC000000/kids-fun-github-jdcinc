# Attribution — every polluted `source` row → the test file that mints it

All 56 rows created in production between 2026-09-21 18:39 and 18:55 UTC were matched to exactly
one test file by the literal that file writes. **Zero were unattributable.** This is what justifies
deleting them by identity rather than by date window: each row has a named author.

| Rows | Test file | Matched by |
|---:|---|---|
| 12 | `tests/scheduler/robots-override-db.test.ts` | `name LIKE 'f5robots_<epoch>_<rand> %'` (its `TAG`) |
| 11 | `tests/ingestion/ingest-runner.test.ts` | `Ingest Runner Source <uuid>`, `Assess Run {Source,Sustained,Switching,OK Source} <uuid>`, `Ingest Idempotent Source <uuid>`, `AssessRun {Alert,Quiet} Source <uuid>`, `Confident Ingest Source <uuid>`, `Title Normalise Source <uuid>`, `Editorial Candidate Source <uuid>` |
| 7 | `tests/search/*` repository/engine suites | `{Repository Test,Engine Test,Expired Repository,Phone Repository,Hidden Status,Registration Roundtrip,Visibility Test} Source <uuid>` |
| 6 | `tests/admin/health-verdict-visibility-db.test.ts` | `name LIKE 'f11_<epoch>_<rand> %'` (its `TAG`) |
| 5 | `tests/llm/dedup-adjudication-db.test.ts` | `family = 'test_adjudication'` |
| 4 | `tests/llm/dedup-deterministic-db.test.ts` | `family = 'test_optd_dedup'` |
| 3 | `tests/scheduler/job-dispatch-db.test.ts` | `family = 'test_job_dispatch'` |
| 2 | `tests/adapters/venue.test.ts` | `Venue Ingest Source <uuid>` |
| 1 | `tests/scheduler/global-jobs-db.test.ts` | `family = 'test_global_sched'` |
| 1 | `tests/ingestion/age.test.ts` | `Age Wiring Source <uuid>` |
| 1 | `tests/admin/operating-db.test.ts` | `name LIKE 't41test_<epoch>_<rand> %'` (its `TAG`) |
| 1 | `tests/core/venue-authority.test.ts` | `VAUTH Source <uuid>` |
| 1 | `tests/sms/preferences_weekly-db.test.ts` | `name = 'stage-c-db-fixture'` |
| 1 | `tests/sms/click_through-db.test.ts` | `name = 'stage-d-db-fixture'` |

**Read the families carefully.** Only four (`test_adjudication`, `test_optd_dedup`,
`test_global_sched`, `test_job_dispatch`) are test-only. The rest of these rows carry REAL
production family values — `noop`, `manual`, `activenet`, `library_bibliocommons`, `perfectmind`,
`venue_html`, `editorial_roundup` — because the suites mint fixtures under the families they
exercise. Deleting by family would delete real sources. That is why the cleanup script works from
an explicit UUID manifest and re-verifies each fingerprint before deleting anything.

**Why leftovers exist at all:** these suites *do* clean up (`afterAll` deletes by `family`). Rows
survived because the run was aborted or `afterAll` threw part-way. Families that a later file
cascade-deletes were cleaned anyway — which is why `vvtest` is absent from production while
`test_adjudication` survived. Teardown was not the root cause; the environment was.
