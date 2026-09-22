# 2026-09-21 — the DB test lane ran against production

## What happened

A full `vitest run --project db` executed against the **production** database between
**18:40:01 and 18:53:36 UTC** on 2026-09-21. Proof it was a live run rather than a bulk import:
per-row `xmin` rises monotonically with `created_at` across the whole window (~2,000 transaction
ids consumed), i.e. thousands of individual statements.

The guard that exists to stop exactly this — `lib/testing/local-db-guard.ts`, wired as a Vitest
`setupFiles` entry and inherited by all three workspace projects — was **working**. It was
disabled by its own escape hatch. A QA worktree's `.env.qa` held, in one file, a production
superuser `DATABASE_URL` *and* `KIDS_FUN_ALLOW_NONLOCAL_DB=1`. One `set -a; . .env.qa; npm test`
aimed the whole DB lane at production with the safety net switched off.

The root cause is the **shape of the override**, not anyone's discipline. A boolean env var is
target-independent and sticky: exported once for a legitimate read-only probe, it silently
authorises whatever runs next in that shell, against whatever database that thing connects to.
The snapshot runbook already warned against setting it and leaving it set. The warning was correct
and insufficient, because the failure mode never required anyone to ignore it.

## Damage

Fixture rows were the small part. The DB suites deliberately run the **real scheduler**, whose
writes are table-wide:

| What | Detail |
|---|---|
| **16,561 real occurrences → `status_state='stale'`** | one unscoped UPDATE at 18:49:07.075Z (`worker/health/stale.ts` `flipStaleOccurrences`). Every `stale` row in prod carries that exact timestamp, so the population went ~0 → 16,561. **1,174 are future-dated and user-visible**, and `lib/search/rank.ts` scores `stale` at 0.15 (lowest), so they rank at the bottom of live search. |
| 27 other real occurrences mutated | 18 → `manual_candidate`, 5 → `confirmed`, 4 → `needs_review` |
| `job_queue` truncated | both scheduler suites run an unscoped `DELETE FROM job_queue`; pending prod ingest jobs were destroyed (queue refills from 19:00:45) |
| `llm_batch_run` corrupted | reduced to one row whose watermark is a test value (18:53:36) |
| 56 fixture `source` rows | 34 with `terms_status='allowed'`, so they counted as "enabled sources" — prod has only **17 real sources** |
| 41 series, 48 occurrences, 11 venues | |
| **2 orphan `admin_user` rows** (`role='admin'`, no matching `auth.users`) | fake admin grants; not usable without an auth user, but they are in prod |

### Correction: `analytics_event` was NOT polluted

An earlier version of this document claimed "604 synthetic `search_performed` events". **That was a
misattribution and it is withdrawn.** It came from counting rows in a time window and assuming they
were fixtures — the exact window-based inference this incident's cleanup design rejects everywhere
else.

Two independent checks: (1) of the 404 `analytics_event` rows in the confirmed window, **zero**
reference a fixture `source_id` or `occurrence_id`; (2) the surrounding baseline is 300–600
`search_performed` per 12-minute bucket both before and after the incident, and the buckets spanning
it are, if anything, *below* that average. They are ordinary production traffic.

So `analytics_event` needs no cleanup, and the KPI/product-health dashboards were never polluted by
this incident. (Different reviewers arrived at 604 and 503 for the same "synthetic" figure, from
different window boundaries — which is itself the tell that the number was measuring traffic, not
fixtures.)

## The fix (code)

1. **`lib/db/connection-host.ts`** — new `isManagedDatabaseHost()`: host shapes that can only ever
   be a hosted database (`db.*.supabase.co`, `*.pooler.supabase.com`, RDS, Neon, …). Deliberately
   *not* used for the SSL decision, which correctly keys off `isLocalDatabaseHost`.
2. **`lib/testing/local-db-guard.ts`** — the test path now calls `assertTestDatabaseUrl()`, which
   has **no boolean override**:
   - managed/hosted host → refused **absolutely**; no env var permits it;
   - any other non-local host → refused unless `KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST` names that
     **exact resolved host**. Naming the target is what makes the override non-sticky — a value
     left over from another database simply does not match, and fails closed. It compares the
     *resolved* host, so `?host=` cannot smuggle a different target past it.
   - `assertLocalDatabaseUrl()` keeps its old semantics for non-test callers; nothing in the test
     path calls it.
3. **`tests/testing/local-db-guard.test.ts`** — +11 tests, including the incident configuration
   verbatim (prod URL + `KIDS_FUN_ALLOW_NONLOCAL_DB=1` → must refuse) and the non-stickiness
   property a boolean flag cannot have.
4. **`tests/testing/env-files-no-prod-db.test.ts`** — catches the *file* one step earlier: any
   repo-root `.env*` naming a managed host, or shipping the boolean opt-out, fails CI by name.
   Verified with a negative control (a reconstruction of the incident file fails it).

## The fix (data) — this script

```bash
# dry run: does every check and every DELETE inside a transaction, prints real counts, ROLLS BACK
KF_CLEANUP_TARGET_URL='postgres://…' bash scripts/incident/cleanup-2026-09-21-fixture-pollution.sh

# with the admin fixtures too
… --include-admin-fixtures

# actually write (BOTH flags required)
… --include-admin-fixtures --commit --yes-write-production
```

It reads **`KF_CLEANUP_TARGET_URL`, never `DATABASE_URL`** — the environment that caused the
incident must not be able to reach the remediation tool, and it stays invisible to `npm test`,
`npm run dev` and CI.

**Safety model is identity, not inference.** The target set is a reviewed manifest of explicit
UUIDs (`manifest-2026-09-21-fixture-pollution.json`). The 45 source ids are re-verified at run time
against the family/name/`created_at` fingerprint recorded there; the dependent id arrays are checked
structurally — every manifest series id must still belong to a target source, every occurrence id to
a target series, and every venue id must still carry its recorded name. Any drift aborts. (An
earlier version of this file claimed fingerprint verification for all of them when only the sources
were checked; both reviewers caught it, and rather than soften the claim the checks were added.) This matters
because six of the polluted families (`activenet`, `library_bibliocommons`, `perfectmind`,
`venue_html`, `editorial_roundup`, `manual`) are **also real production families**; a family- or
window-scoped DELETE would be a second incident. All 56 rows were independently attributed to the
specific test file whose literal mints them — see `ATTRIBUTION.md` — with zero unattributable.

**Backups live outside the repo, per run.** `<repo>/../kf-incident-backups/<runId>/`, overridable
via `--backup-dir` / `KF_INCIDENT_BACKUP_ROOT`, mandatory in commit mode. See
`dedup-followup/README.md` for why — briefly: the first design put them in a gitignored directory
inside a shared worktree, and a path-scoped `rm -rf` (mine) destroyed another session's backups.

**⚠️ GAP, flagged not fixed: this cleanup script writes NO backup.** It performs 15 `DELETE`
statements removing ~183 production rows and, unlike the dedup-followup and stale-restore tools, it
captures nothing first. Its safety rests entirely on the reviewed UUID manifest and the fingerprint
re-verification — which is a real argument, but it is not a rollback. Adding a `writeBackup` call
before the deletions is a small change and, in my view, the right one; it is left undone here only
because this file is inside the scope two reviewers are currently pinned to, and slipping an
unreviewed behaviour change into it is the sort of thing tonight has taught us not to do. Operator's
call whether to take it before or after the current review round.

**Dry run is NOT read-only.** It executes the real `DELETE`s inside a transaction and rolls back, so
it takes row locks and runs full `count(*)` scans over `activity_occurrence` and the 3.2M-row
`analytics_event`. It deliberately cannot run under the `SET default_transaction_read_only = on`
discipline used for every investigative query in this incident — the point is that the printed
numbers are a real execution rather than a prediction. Run it in a quiet window, not casually.

**What it will not touch**
- the **11** source rows whose occurrences the Operator archived on the night. Contained,
  reversible via `archived_at`, and the Operator's call to close out. The run aborts if any of them
  appears in the target set.
- the **16,561 stale flips** — a separate, larger remediation with its own decision (let the real
  cadence re-check vs. restore prior status). The script asserts that count is *unchanged* across
  its own transaction, so it can neither cause nor hide movement there.
- the ~404 `analytics_event` rows in the incident window — they are real user traffic (see the
  correction above), so there is nothing to clean. The manifest records
  `expected_dependent_counts.analytics_event: 0` and the script asserts it deletes exactly 0.
- anything outside the manifest. Every precondition the manifest DECLARES is checked (not a
  locally-chosen subset), every dependent table's delete count is asserted against the manifest, and
  pre/post invariants assert that real-source count, total occurrences and the stale population do
  not move by even one row.

**Expected effect** (measured on a local replica of production, not predicted): −45 sources,
−27 series, −33 occurrences, −29 provenance, −29 source_check_run, −7 venues, and with
`--include-admin-fixtures` −2 `admin_user` / −2 `user_profile` / −3 `admin_audit_log`. 183 rows.
4 of the 11 fixture venues are **kept** and named in the output: they are still referenced by
series under the Operator-contained sources, and become deletable once those are closed out.

## Negative suite (`negative-suite.sh`)

The guards above are only worth what exercises them. A mutation sweep — neutralising each
`require_()` condition in turn and re-running — found **17 of 29 unexercised**: they could have been
deleted and nothing would have noticed. They had only ever been checked by ad-hoc shell commands
typed by hand during review, which is not a test.

```bash
KF_CLEANUP_TARGET_URL='postgres://…local replica…' \
KF_REPLICA_RESET='node /path/to/reset-replica.cjs' \
  bash scripts/incident/negative-suite.sh
```

18 cases, covering a baseline that must SUCCEED (so the suite cannot pass by breaking everything)
plus the refusals: wrong database, source fingerprint and `created_at` drift, duplicate target ids,
a `leave_alone` id smuggled into the target set, an undeclared/misspelled precondition or
dependent-count key, a dependent-count mismatch, nonexistent series/occurrence/venue ids, an
occurrence hanging off a non-target series, a renamed venue, an empty target set, an
Operator-archived row inside the target set, and an orphan profile that turns out to have a real
`auth.users` row.

The replica seeding tooling deliberately lives **outside** this repo: it is built from
production-derived data. Without `KF_REPLICA_RESET` the two database-mutating cases skip and the
rest still run.

**Post-condition assertions are not covered by this suite, by design.** Checks like
`post.occ_stale === pre.occ_stale` fire only if the delete itself misbehaves, so no bad input can
reach them — they need fault injection. Three were demonstrated that way (making the final
`DELETE FROM source` a no-op; flipping an extra row to `stale` mid-transaction; dragging a real
source's `created_at` into the incident window), and each was caught by the intended assertion
rather than by a Postgres error. The rest are the same shape but have not been individually
demonstrated.

## How it was verified (and how to re-verify)

A local replica was built matching production on every asserted count — 73 sources, 31,979
occurrences, 16,561 stale, 439 venues, 3 `admin_user` — with the real fixture UUIDs, the real
contained set, a real admin (with an `auth.users` row) as a negative control, and filler real data.
Then: dry run → commit → independent post-state query (13 assertions incl. dangling-FK checks),
plus ten negative tests (already-cleaned DB, fingerprint drift, containment trespass, precondition
drift, wrong database, missing/ tampered/ duplicate manifest, missing env var, half-confirmation).
Two real defects were found and fixed by that rehearsal: the venue delete originally aborted the
whole run instead of deleting the unreferenced subset, and pre-connection aborts escaped as an
unhandled stack trace instead of a clean refusal.

Rehearsal harness: `/opt/projects/crhq-satellite/.scratch/kf-source-pollution/` (`dump-replica.cjs`,
`seed-replica.cjs`, `reset-replica.cjs`). A seeded template database `kf_incident_template` is left
on `127.0.0.1:55622`; `node reset-replica.cjs` restores a fresh `kf_incident_rehearsal` from it.

## Still open — not for this script

1. **The 16,561 stale flips.** Needs a decision, then its own reviewed remediation.
2. **Credential rotation.** The production superuser password sat in a plaintext scratch file for
   11 days (`.scratch/kf-prod-qa/.env.qa`, since deleted). Rotate it.
3. **Who ran it.** No session memory or activity log records the run. The timing is adjacent to the
   admin-login merge (custody handover 18:40:44Z, pollution 18:40:01–18:53:36, commit `c13162e` at
   18:54:38Z) but the admin-login QA harness itself was verifiably loopback-isolated. Unresolved.
