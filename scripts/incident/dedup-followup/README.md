# 2026-09-21 — dedup pipeline follow-up (2 fixes)

Two small, independent, reversible fixes for the LLM dedup residue the 2026-09-21 DB-lane run left
in production. They are separate from `../cleanup-2026-09-21-fixture-pollution.*` (fixture rows) and
from the still-undecided recovery of the 16,561 stale-flipped occurrences. Each can be run,
reviewed and reverted on its own.

Both are **dry-run by default**, read **`KF_CLEANUP_TARGET_URL`** (never `DATABASE_URL`), require
**both** `--commit` and `--yes-write-production` to write, and take a **JSON backup with
ready-to-run restore SQL** before deleting anything — including in dry-run mode, so the restore path
can be reviewed before anyone commits.

```bash
KF_CLEANUP_TARGET_URL='postgres://…' bash scripts/incident/dedup-followup/reset-dedup-watermark.sh
KF_CLEANUP_TARGET_URL='postgres://…' bash scripts/incident/dedup-followup/remove-fake-dedup-decisions.sh
# add --commit --yes-write-production to actually write
```

## ⏱ Sequencing: apply Fix 1 BEFORE the LLM batch job is ever run for real

Not a code defect — an ordering dependency, raised by the independent re-check. `lib/llm/dedup.ts`'s
deterministic path needs no LLM key and calls `advanceWatermark(status: 'ok_deterministic')` on any
**non-dry-run** invocation — the very path the poisoned row came through. So the first real run of
that job, whenever someone wires it up or triggers it by hand, will advance the watermark off the
poisoned value by itself. At that point this script does the right thing (its drift check fires and
it refuses) but it is no longer the tool that fixes anything, and the ~20,518 occurrences stay
excluded from incremental dedup until the row is deleted some other way.

There is no ticking clock today — no scheduled job on this satellite currently hits that route, and
a **dry-run** invocation is harmless (it does not touch the watermark). But this fix is blocked on
nothing technical, so it should go first. If the job does get run first, the remedy is the same
row-delete, just without this script's fingerprint safety.

## Fix 1 — `reset-dedup-watermark`
Production's `llm_batch_run` row for `llm_dedup_adjudication` holds a **test** watermark
(2026-09-21T18:53:36.054Z, with `records_considered=33` / `records_actioned=8` — the fixture counts).
`lib/llm/watermark.ts` resolves the incremental predicate as
`coalesce((SELECT last_watermark …), '-infinity')`, so **20,518 real occurrences currently sit at or
below that watermark and are skipped as already-adjudicated**. Real duplicates among them cannot
surface. The dedup job has not run since, so nothing self-corrects.

Deleting the row is the fix, and deliberately not a guessed value: a missing row is the well-defined
"never run" state, so the next run scans everything. The pre-incident value is unknowable (the test's
`ON CONFLICT DO UPDATE` overwrote it in place and the table has no `created_at`), so any value we
invented would be a fabrication. The only cost is that one later run does a full scan — more work,
not wrong work.

Aborts if the watermark or the run counters have moved, i.e. if the dedup job has since run for real.

## Fix 2 — `remove-fake-dedup-decisions`
The run drove the real adjudication pipeline, which wrote **49 `llm_batch_decision` rows**
(all `llm_dedup_adjudication` / `dedup` / `route_to_review`) against **18 real production listings**
— a machine verdict recorded during a test, about real data, that no human ever reviewed. Verified
read-only against production: those 49 are the table's **entire** contents, so there is no genuine
decision history to preserve; the script asserts that rather than assuming it, and aborts if the
table has changed.

**It deliberately does not touch the 18 listings' `status_state`.** They were moved to
`manual_candidate` by the same run, and reverting hits the same wall as the 16,561 stale flips: the
prior state is unrecoverable from inside the database (six candidate states, no status history, no
status provenance), so any revert would be a guess. They are also all past-dated — none is visible
in search today — so nothing justifies guessing. They belong to the point-in-time-restore pass,
where the real prior value can be read instead of inferred. Removing a false claim without inventing
a replacement claim is the coherent half to do now.

## How these were verified
Rehearsed against a local replica seeded with the exact production rows (same UUIDs, same `jsonb`
payloads): dry run → commit → independent post-state check → **restore from the backup's own
`restore_sql`** → re-run. The round trip reproduces the rows byte-for-byte, including nested quotes
and em-dashes in the `detail` jsonb.

That round-trip found two real defects in the backup writer, both now fixed. First, it stringified
every value, so a `jsonb` column was written as `[object Object]` and the restore SQL failed with
`invalid input syntax for type json`. Second — caught by the independent re-check after the first
fix — keying off the JS runtime type was still wrong: a `jsonb` column whose document is a SCALAR
(bare string/number/boolean) arrives from node-postgres as a JS primitive and missed the object
branch entirely, and a `jsonb` `null` DOCUMENT arrives as JS `null`, indistinguishable from SQL NULL,
so it would have restored as SQL NULL silently. The writer now keys off the COLUMN type: jsonb
columns are selected as `::text` (which keeps SQL NULL and the JSON document `null` distinguishable)
and re-cast with `::jsonb` on the way back. Verified across all six jsonb shapes — object, array,
string, number, boolean and `null` — byte-exact, zero failed statements.

A backup that cannot restore is not a backup, and it fails at exactly the moment it is needed.

Negative tests, all confirmed to abort without writing: watermark drift (dedup job ran since),
run-counter drift, a new legitimate decision row appearing after the manifest, half-confirmation
(`--commit` without `--yes-write-production` — which now exits **3**, not 0, so a wrapper script
cannot read a half-confirmation as success), missing `KF_CLEANUP_TARGET_URL`, wrong database,
missing manifest, duplicate ids in the manifest, and re-running after the fix is already applied.

## Where backups go — and why not in the repo

Backups are written to a **per-run directory outside the repository**:
`<repo>/../kf-incident-backups/<runId>/`, overridable with `--backup-dir` or
`KF_INCIDENT_BACKUP_ROOT`, and **an explicit destination is REQUIRED in commit mode** (a dry run may
use the default). The script refuses an in-repo path, and refuses any run directory that already
holds a file it did not write this run.

That is not caution in the abstract. The first design defaulted backups to a gitignored directory
*inside* the shared worktree, and while rehearsing these tools I ran `rm -rf` on it three times
believing the files were mine — destroying two reviewer sessions' evidence. Two of my own choices
made that likely and invisible at once: a shared default location, and a gitignore rule that kept
the collision out of `git status`. A path-scoped delete cannot tell whose files it is removing.

So this toolkit **never deletes by path**. It deletes only specific file paths it created and
recorded in the same run, and `tests/testing/incident-toolkit-safety.test.ts` fails the build if any
script here grows an `rm -rf`, a recursive `rmSync`, or an in-repo backup default.
