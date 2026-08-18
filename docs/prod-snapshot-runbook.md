# Operator runbook — anonymised production catalogue snapshots

**Audience:** the Operator. Every command here is yours to run. Nothing in this document is
automated today, and nothing in CI has been given a production credential.

**What this gives you:** the test suites run against a realistic, anonymised copy of the real
catalogue instead of only hand-written fixtures — so schema and data drift is caught by CI
rather than by a parent hitting a broken listing.

**Why it is needed:** a fixture only contains what somebody thought to put in it. The bugs that
have actually reached users were data-shape bugs — a live row differing from the fixture's
assumption. That class is invisible to fixtures *by construction*. §9 records what this pipeline
found on its very first real run.

---

## 1. What is and is not exported

**Exported — twelve catalogue tables**, all of which hold information scraped from public
municipal / library / rec-centre websites:

`region`, `category`, `tag`, `age_band`, `synonym_alias`, `source`, `venue`,
`activity_series`, `activity_occurrence`, `occurrence_age`, `occurrence_category_tag`,
`provenance`

**Never exported — every user, account and operations table**, unconditionally:

| Table | Why it is out |
|---|---|
| `user_profile` | **Children's data.** `saved_child_ages` holds real ages in months; `google_identity` holds a real account email; `home_postal`/`home_geo` locate a household. This is the table `scripts/pipeda-cleanup/` exists to clear. |
| `saved_search` | A real person's saved query — their neighbourhood, their children's ages, their schedule. |
| `admin_user`, `admin_audit_log` | Real people mapped to privileged roles; audit rows snapshot arbitrary row content. |
| `weekly_email_send` | Per-user send log. |
| `correction_report` | User-submitted: `reporter` is a user/session id, `note` is free text a member of the public typed. |
| `analytics_event` | `user_or_session` is a per-person identifier; `search_context_json` records what real people typed into the search box. |
| `organisation` | Has a literal `contact` free-text column and **zero readers or writers** anywhere in the codebase. |
| `source_check_run`, `job_queue`, `global_job_*`, `llm_batch_*`, `dedup_pair_adjudication`, `app_meta` | Operational state, raw upstream failure payloads, worker identities. Not catalogue data. |

This is an **allowlist, not a scrubber**. A table that is not named in
`lib/snapshot/policy.ts` is never read at all, so no scrub bug can leak it. The realistic risk
is therefore not a forgotten table — it is a migration adding a PII column to a table that is
*already* allowlisted (`venue.phone` arrived exactly that way in migration 0024). That is what
the schema guard in §8 exists for.

### Scrubbed vs preserved

| Column | Treatment |
|---|---|
| `activity_occurrence.description_snippet`, `venue.accessibility_notes`, `occurrence_age.age_notes` | **Aggressive redaction** — emails, phone numbers (punctuated and bare), Canadian postal codes, URL credentials, and `Contact/Instructor/ask for <Name>`. |
| `activity_occurrence.activity_name`, `activity_series.canonical_title`, `venue.name`, `open_hours_state` | **Title redaction** — as above, but only a narrow set of name-introducing phrases. Role words like "Coach" and "Host" survive because they carry full-text-search weight-A meaning; redacting them would break the search relevance this snapshot exists to test. |
| `venue.address`, all `*_url` columns | **Conservative redaction** — emails, phones, URL credentials only. Postal codes and proper nouns are *kept*: a public venue's street address is public catalogue data and the geo tests depend on its exact shape. |
| `venue.phone` | Replaced with a fictitious number of the **same shape** — same punctuation, same digit count. Null-vs-set and formatting variety both reach the rendered detail page, so they must survive; the number must not. |
| `source.robots_override_note` | Replaced with the constant `[redacted]`. Operator prose is where a human writes "spoke to <person> at the City"; nothing reads its content, only whether it is set. |
| `activity_occurrence.search_tsv` | **Not exported at all.** It is a lexeme index of the *pre-scrub* description — exporting it would hand back what the scrub removed, one word at a time. The target rebuilds it from the scrubbed text via the migration-0010 trigger. |

**Preserved byte-for-byte, deliberately:**

- every `timestamptz` — `start_datetime_utc`, `end_datetime_utc`, `last_checked_at`,
  `archived_at`, `created_at`, `updated_at`, …, at full **microsecond** precision;
- every age column — `occurrence_age.age_min_months` / `age_max_months` /
  `age_band_matches`, and all of `age_band`;
- every region identifier — `region.name` / `level` / `parent_id` / `centroid`,
  `venue.municipality_id`;
- costs (`numeric(10,2)`, exact), geometries (PostGIS), enums, and all ids.

These are the fields whose drift we are hunting. An anonymiser that bucketed dates or jittered
ages would leave a snapshot that is merely a slower fixture. §7 is how you prove this held.

> `occurrence_age` is the age suitability **of a public program** ("this session is for 5–9 year
> olds"). It is not, and must never be confused with, `user_profile.saved_child_ages`, which is a
> real child's age and is never exported.

No redaction here is reversible and none is keyed. There is no salt to leak and no mapping to
invert; two different phone numbers of the same shape become the same placeholder.

---

## 2. Prerequisites

On the machine you will run this from:

- Node 20–22 and this repo checked out, with `npm ci` run.
- `psql` on `PATH` (only for the local load, §6).
- Docker, if you want a local Postgres to load into.

**Credentials you need:** exactly one — a connection string for a dedicated read-only role on
the production database (§3). **No** Supabase service-role key, **no** app secret, **no**
`ADMIN_DASHBOARD_TOKEN`. The export never writes.

**Credentials you must NOT create:** do not put a production connection string into GitHub
Actions secrets. The CI `e2e` lane deliberately holds no production secret (see the comment on
that job in `.github/workflows/ci.yml`), and changing that is a decision for you and Jon, not a
side effect of adopting this tooling. §11 sets out the two options if you decide you want it.

---

## 3. One-time setup: the snapshot role

Run this **once**, as a superuser, against production. It creates a login role that can read the
twelve allowlisted tables and nothing else.

```sql
CREATE ROLE kf_snapshot_ro LOGIN PASSWORD '<generate a strong one>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

GRANT CONNECT ON DATABASE postgres TO kf_snapshot_ro;   -- adjust the database name
GRANT USAGE   ON SCHEMA public     TO kf_snapshot_ro;

GRANT SELECT ON
  region, category, tag, age_band, synonym_alias, source, venue,
  activity_series, activity_occurrence, occurrence_age,
  occurrence_category_tag, provenance,
  schema_migrations                        -- the migration ledger, for the schema fingerprint
TO kf_snapshot_ro;

-- REQUIRED. Read the note below before deciding this looks excessive.
ALTER ROLE kf_snapshot_ro BYPASSRLS;
```

> ### Why `BYPASSRLS` is required, and what happens without it
>
> Migration `0018_public_tables_default_deny_rls.sql` enables row-level security with **zero
> policies** on every catalogue table. A role holding `SELECT` but not bypassing RLS therefore
> reads **nothing — successfully**. Verified: such a role produces twelve cheerful `0 rows`
> lines, a valid manifest, and exit code 0.
>
> The export now refuses to write an all-empty snapshot for exactly this reason and tells you to
> come back here. But be aware of the shape of the trap: the failure is silent at the database
> level, not at the tool level.
>
> `BYPASSRLS` is a read-visibility attribute, not superuser. Combined with `SELECT` on twelve
> tables and nothing else, this role still cannot see `user_profile`, cannot write anything, and
> cannot create anything. That is the least privilege that actually works.

Store the connection string in your password manager. It is a production credential.

---

## 4. Produce a snapshot

```bash
cd /path/to/kids-fun

# Supply the connection string WITHOUT leaving it in shell history:
read -rs KF_SNAPSHOT_SOURCE_URL && export KF_SNAPSHOT_SOURCE_URL

npm run snapshot:export -- --label production
```

Output lands in `.snapshots/production-<timestamp>/` (gitignored — see §5) as one gzipped NDJSON
file per table plus a `manifest.json`.

The variable is `KF_SNAPSHOT_SOURCE_URL`, never `DATABASE_URL`, on purpose: `lib/testing/
local-db-guard.ts` refuses a non-local `DATABASE_URL`, and no tool should be the reason anyone
sets `KIDS_FUN_ALLOW_NONLOCAL_DB=1` and then leaves it set. The same convention as
`scripts/search-cap-probe.sh`.

**What it guarantees**

- Read-only: session-level `default_transaction_read_only`, and every statement inside one
  `REPEATABLE READ, READ ONLY` transaction — so the snapshot is also point-in-time consistent
  and referentially intact.
- Deny-by-default: the schema guard runs *before the first SELECT* and aborts if any allowlisted
  table has a column with no policy entry.
- Scrub before disk: rows are transformed in memory as they stream. A raw value never reaches a
  file.
- The connection string is never printed, never logged, and is not written into the manifest.
  Errors are sanitised before display (`lib/snapshot/safe-error.ts`).

Useful flags: `--out DIR`, `--batch N` (keyset page size, default 5000), `--allow-empty` (only
if the source genuinely has no catalogue).

---

## 5. Verify before the snapshot leaves the machine

```bash
npm run snapshot:verify -- --in .snapshots/production-<timestamp>
```

This is an **independent** re-scan: it re-reads what the export actually wrote and hunts for
personal data in it from the other side. It checks manifest integrity and checksums, that every
row's columns are exactly the policy's, that placeholder columns really are placeholders, that no
file exists for a non-allowlisted table, and that no email / phone / postal code / URL credential
survived in any column that should have been scrubbed.

**A non-zero exit means delete the snapshot.** Do not "fix it up" — correct
`lib/snapshot/policy.ts` and re-export. Violations are reported as `table.column row N`; the
offending value is never printed, because a leak report must not be a second leak.

### Handling and retention

- `.snapshots/` is gitignored. **Never commit a snapshot.** Git history cannot be un-shipped.
- The data is anonymised, not public. Treat a snapshot as internal: encrypted storage,
  access-controlled bucket or laptop disk encryption.
- Keep the most recent 7 nightly snapshots and delete older ones. There is no value in a
  months-old catalogue and every retained copy is a copy to look after.
- If you distribute snapshots to developers, prefer a short-lived signed URL over a shared drive.

---

## 6. Load it into a local database

```bash
# A disposable local Postgres with PostGIS:
docker run -d --name kf-local-db -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:5432:5432 postgis/postgis:16-3.4

export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/postgres'
npm run snapshot:load -- --in .snapshots/production-<timestamp>
```

`snapshot:load` runs `scripts/local-db-bootstrap.sh` first (auth stub + forward migrations — it
owns the *schema*) and then loads the rows (this owns the *data*). Pass `--skip-bootstrap` where
the schema is already current, e.g. in CI.

Safety properties:

- **Refuses any non-local `DATABASE_URL`, with no override.** The load `TRUNCATE`s the catalogue;
  it will only ever target a disposable database. Host resolution is shared with
  `lib/testing/local-db-guard.ts`, so a `?host=` override cannot smuggle a remote target past it.
- Re-runs the §5 verification before writing anything (`--skip-verify` exists; don't).
- Refuses a snapshot whose schema fingerprint does not match this database — a suite run against
  a mismatched snapshot proves nothing. `--allow-schema-drift` downgrades that to a warning for
  local debugging only.
- Runs in one transaction. A mid-load failure leaves the database exactly as it was.
- Prints the FK dependents `TRUNCATE ... CASCADE` will also clear, rather than clearing them
  silently.

---

## 7. Prove the pipeline once, before you trust it

```bash
KF_SNAPSHOT_SOURCE_URL='…source…' DATABASE_URL='…loaded local target…' \
  npm run snapshot:roundtrip-check
```

Read-only on both ends. It digests every `preserve` column on both databases and compares them.
Identical digests mean every date, age, region id, cost and geometry survived
export → scrub → gzip → load **byte-identically**; the scrubbed columns are separately confirmed
to have changed, because a scrub that changed nothing would be a scrub that did nothing.

This is also how a real bug was found during development: loading `occurrence_category_tag`
fires migration 0010's reindex trigger, which UPDATEs the occurrence, which fires migration
0003's `set_updated_at` trigger — silently rewriting `updated_at` on every tagged occurrence at
load time. The loader now restores `updated_at` as a final pass. Run this check after any change
to the pipeline.

**You do not need production access to exercise all of this.** `scripts/snapshot/
synthetic-production.sql` builds a production-shaped local database with planted canaries; the
whole round trip can be rehearsed against it (§11).

---

## 8. Run the suites against snapshot data

```bash
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/postgres' \
  npm run test:snapshot -- --in .snapshots/production-<timestamp>
```

Loads the snapshot and runs the DB lane with `KF_SNAPSHOT_MODE=1`, which un-skips
`tests/snapshot/catalogue-shape.test.ts` — universal "every row in the catalogue satisfies X"
assertions that only mean anything when the rows are real.

**Fixture mode remains the default and is unchanged.** `npm test` does not touch any of this.

Two guards run in ordinary CI, with no snapshot and no opt-in:

- `tests/snapshot/policy-schema-guard.test.ts` — diffs the allowlist against the migrated CI
  database. **This is the alarm.** If a migration adds a column to an allowlisted table, this
  goes red at PR time with the column named. The fix is never to relax the guard; it is to
  classify the column in `lib/snapshot/policy.ts`, or move the table to `EXCLUDED_TABLES`.
- `tests/snapshot/{scrub,policy,verify}.test.ts` — unit lane. They assert the exclusions table by
  table (`user_profile` by name), that dates/ages/regions are `preserve`, and that the verifier
  actually catches a planted leak.

---

## 9. What running with a database actually changes — measured

A common and reasonable misreading of this work is "the snapshot lights up hundreds of
already-written tests that never run". Measured on this branch, that is **not** what happens,
and it is worth knowing exactly what does, because the real answer is better.

Three configurations, same commit, full suite (`npx vitest run`):

| Config | Passed | Failed | **Skipped** |
|---|---|---|---|
| **A** — no `DATABASE_URL` | 2871 | 0 | **436** |
| **B** — `DATABASE_URL` + `local-db-bootstrap.sh` + `seed.sh` (**what CI does today**) | 3453 | 2 | **16** |
| **C** — snapshot loaded + `KF_SNAPSHOT_MODE=1` | 3466 | 5 | **0** |

- **420 of the 436** skips are un-skipped by config **B** — i.e. by simply having a bootstrapped,
  seeded Postgres. They are gated on `hasDb = Boolean(process.env.DATABASE_URL)`, not on
  snapshot data. **The `ci` job in `.github/workflows/ci.yml` already sets `DATABASE_URL` and
  runs `scripts/test.sh`, so those tests are not dark in CI.** They are dark only in a local
  `npx vitest run` with no database.
- **16** are un-skipped only by config **C**. They are `tests/snapshot/catalogue-shape.test.ts`,
  added by this work.
- Config **C** is the only configuration where the suite has **zero** skipped tests.

### The part that actually matters

The snapshot's value is not *how many* tests run. It is **what they run against**.

`tests/admin/data-health-db.test.ts` asserts that the set of municipality names in `region`
equals the app's `LAUNCH_REGIONS` constant. In fixture mode that assertion **cannot fail** — and
not because the code is right. The table was populated from `supabase/seeds/regions.sql`, and
the seed file and the constant were written together. The fixture *is* the expectation. It is a
tautology wearing a test's clothes.

Load a snapshot and the same assertion compares the app's constant against what **production
actually holds**. Demonstrated with `scripts/snapshot/synthetic-production-defect.sql`, which
renames a live municipality the way a real rename would drift from a months-old seed file:

```
FAIL tests/admin/data-health-db.test.ts
  → canonical launch-region constant matches the seeded municipalities
     -   "North Vancouver (District)"      ← what the database holds
     +   "North Vancouver"                 ← what the app's constant expects

FAIL tests/regions.test.ts
  → all seeded regions have a non-null centroid    (expected 1 to be 0)
```

Both are **pre-existing tests nobody had to write**. Region-name drift is one of the suspected
root causes this pipeline was commissioned to target, and this is the configuration in which it
becomes visible. The same applies to `tests/age_bands.test.ts`, `tests/geo/radius-postgres.test.ts`
and every other assertion over reference data: fixture mode checks the seed file against itself;
snapshot mode checks production against the app.

Reference tables are therefore load-bearing snapshot contents, not incidental ones — which is
why `region`, `category`, `tag`, `age_band` and `synonym_alias` are all on the allowlist. All of
`tests/regions.test.ts`, `tests/age_bands.test.ts`, `tests/geo/radius-postgres.test.ts`,
`tests/admin_guard.test.ts`, `tests/geo/venue-geo-golden.test.ts` and
`tests/email/account_deletion_cascade.test.ts` pass against snapshot-loaded data, so the load
path satisfies what they expect.

## 10. What snapshot mode reports today

From the first end-to-end run against a production-shaped dataset of 604 occurrences. Three of
these are **findings the fixture suites are structurally incapable of producing** — they only
appear once the catalogue has real cardinality.

| Suite | Finding |
|---|---|
| `tests/admin/qa-queue-db.test.ts` | `listReviewQueue()` is capped at 100 rows and ordered **oldest-first**. With 134 review-state occurrences, the 34 most recently flagged rows are unreachable through the admin QA queue. In production the catalogue is far larger, so the unreachable fraction is far larger. **Real defect.** |
| `tests/admin/qa-queue-dedup-db.test.ts` | Same cap, same cause, for the dedup-pair review path. |
| `tests/search/postgres-repository.test.ts` | "feeds DB storytime listings through the search engine" asserts a freshly-minted row lands in the top 5 for its own term. With 310 real storytime listings competing it does not. The test encodes an empty-catalogue assumption; whether the ranking is also wrong is worth a look. |
| `tests/coverage-status-db.test.ts` | **Pre-existing** — also red in fixture mode on `origin/main` @ `f975a40`, in isolation, on a fresh database. Not caused by snapshot data. |
| `tests/adapters/venue.test.ts` | **Pre-existing**, same. |

Expect this list to change. When a snapshot-mode suite goes red, read the named row before
assuming the test is wrong — usually the catalogue is telling you something.

---

## 11. Scheduling it nightly

The tooling is ready; **the scheduling decision is not mine to make**, because every option
below changes where a production credential lives. Two viable shapes:

### Option A — on the operator's own infrastructure (recommended)

The credential never leaves infrastructure you already control, and CI's "no production secrets"
property is preserved exactly as it is today.

On a host that already has production database access, `cron`:

```cron
# 02:15 America/Vancouver, nightly
15 2 * * *  /opt/kids-fun/bin/nightly-snapshot.sh >> /var/log/kf-snapshot.log 2>&1
```

```bash
#!/usr/bin/env bash
# /opt/kids-fun/bin/nightly-snapshot.sh
set -euo pipefail
cd /opt/kids-fun/repo

# Credential from a file readable only by this user (chmod 600) — not from the crontab,
# not from the process arguments, not from a shell profile every process inherits.
export KF_SNAPSHOT_SOURCE_URL="$(cat /etc/kids-fun/snapshot-url)"

OUT=".snapshots/production-$(date -u +%Y%m%dT%H%M%SZ)"
npm run snapshot:export -- --label production --out "$OUT"

# HARD GATE: a snapshot that does not verify is deleted, not published.
if ! npm run snapshot:verify -- --in "$OUT"; then
  rm -rf "$OUT"
  echo "VERIFY FAILED — snapshot deleted, nothing published" >&2
  exit 1
fi

tar -czf "$OUT.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"
# …upload $OUT.tar.gz to your access-controlled store…
rm -rf "$OUT"

# Retention: keep 7.
ls -1dt .snapshots/production-*.tar.gz | tail -n +8 | xargs -r rm -f
```

Then either publish the artefact for developers to load locally, or have CI download the latest
one — CI needs read access to the *artefact store*, which is a much smaller grant than access to
the production database.

### Option B — GitHub Actions with a production secret

Only if you and Jon decide the trade is worth it. This **removes the property** that the CI
workflow holds no production credential, and it means every workflow run on that repository is a
potential exfiltration path. If you go this way: a separate workflow (not `ci.yml`), restricted
to `workflow_dispatch` + `schedule`, an environment-scoped secret with required reviewers, and
never `pull_request`-triggered.

**Do not adopt Option B silently.** The comment on the `e2e` job in `.github/workflows/ci.yml`
records the current property deliberately; if it changes, that comment must change with it.

---

## 12. Rehearsing without production access

Everything above can be exercised locally, which is how the pipeline was validated:

```bash
docker run -d --name kf-src -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:55611:5432 postgis/postgis:16-3.4
docker run -d --name kf-dst -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:55612:5432 postgis/postgis:16-3.4

export KF_SNAPSHOT_SOURCE_URL='postgres://postgres:postgres@127.0.0.1:55611/postgres'
DATABASE_URL="$KF_SNAPSHOT_SOURCE_URL" bash scripts/local-db-bootstrap.sh
DATABASE_URL="$KF_SNAPSHOT_SOURCE_URL" bash scripts/seed.sh
psql "$KF_SNAPSHOT_SOURCE_URL" -v ON_ERROR_STOP=1 -f scripts/snapshot/synthetic-production.sql

npm run snapshot:export -- --label synthprod
npm run snapshot:verify -- --in "$(ls -1dt .snapshots/*/ | head -1)"

export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55612/postgres'
npm run snapshot:load -- --in "$(ls -1dt .snapshots/*/ | head -1)"
npm run snapshot:roundtrip-check
```

`synthetic-production.sql` plants the token `CANARY` in every excluded table — real-looking
children's ages, a Google identity, a saved search, an analytics event — so the allowlist can be
proven by grep rather than argued:

```bash
zcat .snapshots/*/*.ndjson.gz | grep -c CANARY    # must be 0
```

It also plants realistic emails, phone numbers, postal codes and instructor names in the
catalogue's own free text, to exercise the redactors.

`scripts/snapshot/synthetic-production-defect.sql` plants one deliberate data defect (a
`municipality` region with a NULL centroid). Apply it, re-export, re-load and run
`npm run test:snapshot` to watch the shape suite catch a bug no fixture could contain.

---

## 13. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `every allowlisted table came back EMPTY` | The role does not bypass RLS. §3. |
| `UNCLASSIFIED COLUMN <table>.<column>` and nothing was exported | A migration added a column to an allowlisted table. This is the guard working. Classify it in `lib/snapshot/policy.ts` — `preserve` **with a stated reason** if it is public catalogue data, a redaction action if it could carry personal data, or move the whole table to `EXCLUDED_TABLES`. |
| `STALE POLICY: <table>.<column>` | A column was dropped. Remove its policy entry. |
| `policy fingerprint mismatch` on verify/load | The snapshot predates a change to `lib/snapshot/policy.ts` — possibly a scrub-rule tightening. Re-export rather than trusting it. |
| `schema drift` on load | The target's migrations differ from the source's. Run `bash scripts/local-db-bootstrap.sh`, or take a fresh snapshot. |
| `DATABASE_URL points at non-local host` | Working as intended. The loader truncates; it will not target a remote database. |
| `RESIDUAL PERSONAL DATA (…)` on verify | The scrub missed something. **Delete the snapshot.** Fix the rule in `lib/snapshot/scrub.ts` or the column's action in `lib/snapshot/policy.ts`, add a case to `tests/snapshot/scrub.test.ts`, re-export. |
| `N occurrence(s) have a NULL search_tsv after load` | The migration-0010 FTS trigger did not fire. The target's schema is wrong — re-bootstrap. |

---

## 14. Where the code lives

| Path | Role |
|---|---|
| `lib/snapshot/policy.ts` | **The allowlist.** Tables, per-column actions, and the reason for each. Start here. |
| `lib/snapshot/scrub.ts` | The redaction rules. Pure functions, unit-tested. |
| `lib/snapshot/transform.ts` | Applies the policy to a row. |
| `lib/snapshot/schema-guard.ts` | Diffs the policy against a live schema. The deny-by-default enforcement. |
| `lib/snapshot/verify.ts` | The independent re-scan. |
| `lib/snapshot/format.ts` | On-disk format and the schema fingerprint. |
| `scripts/snapshot/*.sh` | The operator CLIs. |
| `scripts/snapshot/synthetic-production*.sql` | Production-shaped local data, with canaries and a planted defect. |
| `tests/snapshot/` | Unit guards (always run) + the snapshot-mode shape suite. |
