// lib/testing/disposable-db-setup.ts — Vitest setup file for the `db` project ONLY.
//
// Wired in vitest.workspace.ts's db project rather than in vitest.config.ts, because it OPENS A
// CONNECTION. The unit lane runs with DATABASE_URL set in CI but mocks the db seam, and adding a
// connect to ~300 unit files would cost real time and pool capacity for no safety at all. Workspace
// projects MERGE array options with the config they extend, so the db lane ends up running the base
// local-db-guard AND this one, in that order — address check first, then the database's own claim.
//
// No-op when DATABASE_URL is unset: the DB-gated suites already skip themselves via `hasDb`.
import { getPool } from '@/lib/db/client';
import { assertDisposableDatabase, assertDisposableDatabaseUrl } from '@/lib/testing/disposable-db';

// Top-level await: a setup file's module evaluation is awaited by Vitest, so a rejection here
// fails the file before any test runs — same failure shape as the synchronous guard.
//
// BOTH urls are guarded. USER_DATABASE_URL was missed in the first cut and it matters: the db
// lane's RLS and user-scoped suites write through that role, so covering only DATABASE_URL left a
// second door onto the same lane. DATABASE_URL reuses the shared pool (every DB suite opens it
// anyway); USER_DATABASE_URL gets a short-lived single-connection pool of its own, because it must
// be checked against the database IT names.
if (process.env.DATABASE_URL) {
  await assertDisposableDatabase(getPool(), process.env.DATABASE_URL);
}
if (process.env.USER_DATABASE_URL) {
  await assertDisposableDatabaseUrl(process.env.USER_DATABASE_URL, 'USER_DATABASE_URL');
}
