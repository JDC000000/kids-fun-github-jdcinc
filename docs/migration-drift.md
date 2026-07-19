# KIDS FUN — Migration Drift Detection

Source: Round 21 / Task KK. Closes the process gap Round 20's security incident surfaced.

## The problem this closes

Two deploy channels move independently:

| Channel | Mechanism | Trigger |
|---|---|---|
| **App code** | Vercel git integration (`vercel.json` → `github.silent`) | **automatic** on merge to `main` |
| **DB migrations** | `scripts/migrate.sh` against the real Supabase DB | **manual** — a human runs it |

Nothing forced the two to stay together. In Round 20 the staging DB sat a full
round behind the committed migration head — `schema_migrations` at `0016` while
`main` was at `0018` (missing `0017_weekly_email_send` and, critically, the
`0018` default-deny RLS migration). It was invisible until a security fix tripped
over it. The app looked healthy the whole time; only the schema was behind.

## The detector

`scripts/check-migration-drift.sh` — a **read-only** mirror of `migrate.sh`.
`migrate.sh` *writes* the ledger (applies migrations); this script only *reads*
it (SELECT-only, never modifies the target DB) and compares the live
`schema_migrations` table against the committed `supabase/migrations/*.sql` set.

```bash
DATABASE_URL=postgres://…/kids_fun_staging bash scripts/check-migration-drift.sh
# add --json for a machine-readable summary (alerting hooks / agents)
# add --quiet to suppress the per-migration "= ok" lines
```

Drift classes it catches:

| Class | Meaning | The Round 20 case |
|---|---|---|
| `missing` | committed migration NOT in the live ledger | ✅ this — DB behind head |
| `checksum-mismatch` | applied version whose committed file content changed since apply (forward-only violation) | independent catch of an edited-after-apply migration |
| `unknown` | ledger row with no committed file (DB ahead of code / applied out-of-band) | rogue/reverted migration |

Exit codes: `0` in sync · `1` drift detected · `2` error (no `psql`, unreachable
DB, or the DB has never been migrated — no `schema_migrations` ledger at all).

Legacy rows applied before the `checksum` column existed store an empty checksum;
they're reported as `applied (unverified)` — informational, not drift. `migrate.sh`
backfills them on its next run.

## The scheduled check

`.github/workflows/migration-drift.yml` runs the detector against staging:

- **on merge to `main`** that touches `supabase/migrations/**` (or the migration
  scripts) — checks staging immediately. It goes **RED until someone applies the
  migration to staging**. That red is the whole point: a self-clearing "apply me"
  reminder for the manual step. It is a *separate* workflow from `ci.yml` and does
  **not** mean the build is broken.
- **every 6 hours** as a backstop for out-of-band drift (a rogue or reverted
  migration that no push would catch).
- **on demand** via the Actions "Run workflow" button.

It is **detection only** — it never applies migrations. Applying stays a
deliberate human action.

### Activation (one step)

Set the repo secret **`STAGING_DATABASE_URL`** to the staging Supabase Postgres
connection string. A read-capable role is sufficient — the check runs only
`SELECT`s. Provision via `system-administrator` from vault
`kids-fun-supabase-staging`.

Until that secret exists the workflow is a **no-op that annotates a warning** (it
does not sit perpetually red before it's wired up). If you'd rather an unwired
check be loud, flip the guard in the workflow's run step from `exit 0` to `exit 1`
(fail-closed) — noted inline in the workflow file.

> Do **not** add the drift check to `ci.yml`: that workflow runs against an
> ephemeral, freshly-migrated Postgres, so it is in sync by construction — a drift
> check there is meaningless. Drift only exists against the *real* staging DB.

## Verification performed (Task KK)

Reproduced against an ephemeral `postgis/postgis:16-3.4` container (same image as
CI), using the real `migrate.sh` to build a genuine "staging behind" ledger:

| Scenario | Result |
|---|---|
| Ledger at `0016`, committed head `0018` (the incident) | ✗ reports `0017`+`0018` missing → exit 1 |
| After `migrate.sh` applies the rest | ✔ in sync 18/18 → exit 0 |
| Applied migration's checksum tampered | ✗ checksum-mismatch → exit 1 |
| Rogue `9999_*` row inserted in ledger | ✗ unknown → exit 1 |
| DB with no `schema_migrations` table | ✗ clear "never migrated" → exit 2 |
| Unreachable DB | ✗ clear connection error → exit 2 |
| Ledger + schema byte-identical before/after two runs | ✅ read-only confirmed |

---

## Recommendation for a human decision: auto-applying migrations to staging

Task KK deliberately did **not** build automatic migration apply. Running SQL
automatically against a live database on every merge is a real risk surface and
this decision belongs to a human (Architect / operator), not an overnight agent.
The detector above is the cheap, safe, high-value piece and it fully closes the
"silently behind" failure mode by making it loud. Auto-apply is optional on top.

If you choose to pursue it, a conservative design:

1. **Staging only, never production.** Prod migrations stay a gated, manual,
   human-reviewed step. No exceptions.
2. **Additive-only auto-apply; destructive migrations always stop for a human.**
   Gate on a static scan of the pending migration SQL for destructive verbs —
   `DROP TABLE`, `DROP COLUMN`, `ALTER … DROP`, `TRUNCATE`, `DELETE`, `DROP TYPE`,
   etc. If any pending migration matches, the job refuses to auto-apply and pings
   a human. Only clean forward-additive migrations auto-apply.
3. **Lean on the guards `migrate.sh` already has.** It is forward-only, atomic
   per file (`-1`), idempotent (skips applied), and rejects an applied migration
   whose content changed (checksum guard). Auto-apply inherits all of these.
4. **Use a GitHub Environment with required reviewers** for the apply job, so even
   the "additive" path can be set to one-click human approval rather than
   fully unattended, if that's the risk posture you want.
5. **Alert on every auto-apply** (what ran, against which DB, the resulting ledger
   head) so it's never silent.
6. **The detector is the safety net regardless** — run it immediately after any
   auto-apply to confirm the ledger now matches the committed head.

Recommended sequencing: ship detection now (it would have caught Round 20
automatically); decide on auto-apply separately with the Architect once detection
has been running and the team is comfortable with the signal.
