# PIPEDA data-cleanup scripts — Round 25 Task WW

> **STATUS: BUILT — AWAITING SIGN-OFF. NOT APPLIED to any database.**

These two SQL scripts clear values from **existing rows** of `user_profile` as the
data-minimization follow-up to the F-8 / F-9 code changes. They are kept here,
**outside** `supabase/migrations/`, on purpose:

- `scripts/migrate.sh` and `scripts/seed.sh` only glob `supabase/migrations/*.sql`
  and `supabase/seeds/*.sql`. Nothing in this directory is ever picked up by CI,
  by `npm run migrate`, or by a deploy. They do not appear in the
  `schema_migrations` ledger, so `scripts/check-migration-drift.sh` will not flag
  them either.
- They are applied **manually, once, after explicit human sign-off** — the same
  build-then-separately-authorize discipline used for the Round 20 RLS lockdown
  (built as Task HH; applied to staging only after a separate authorization step).

| Script | Effect | Column touched | Risk |
|---|---|---|---|
| `F-8-null-saved-child-ages.sql` | Reset collected children's ages to the empty-array default `'{}'` | `user_profile.saved_child_ages` only | Data clear — legacy ages become unrecoverable from this table (the intended PIPEDA outcome). Snapshot first if policy needs a rollback window. |
| `F-9-null-google-identity.sql` | NULL out the redundant stored Google email copy | `user_profile.google_identity` only | Low — pure redundant copy; the same email stays in `auth.users` and every consumer already resolves it live from there. Nulling loses nothing. |

Both scripts are **idempotent** (a second run affects 0 rows), **transaction-wrapped**,
and print BEFORE/AFTER counts so the operator can confirm the effect.

## Do NOT apply without sign-off

The code changes shipped in Task WW already **stop future collection/writes** and
are safe to merge on their own. These row-clearing scripts are a **separate,
optional** step. Applying them mutates live data and therefore must be an explicit,
signed-off action — never folded silently into a routine code merge.

## To apply (only after sign-off)

```bash
# saved_child_ages
DATABASE_URL=postgres://…  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f scripts/pipeda-cleanup/F-8-null-saved-child-ages.sql

# google_identity
DATABASE_URL=postgres://…  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f scripts/pipeda-cleanup/F-9-null-google-identity.sql
```
