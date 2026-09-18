// lib/admin/snapshot-config.ts — env plumbing for the admin snapshot refresh job.
//
// Its own module, matching lib/analytics/config.ts's separation and for the same mechanical
// reason: the ROUTE needs the secret, and a route that imported snapshot-refresh.ts only to
// reach a string would pull the whole pg-touching build chain into places that just want to
// check a header.
//
//   ADMIN_SNAPSHOT_CRON_SECRET — shared secret guarding POST /api/admin/snapshot/refresh/run.
//                                Unset → the route 503s and precomputation never runs, which
//                                leaves the /admin pages on their "no snapshot yet" notice.
//                                Fail-closed is the right default for an endpoint whose whole
//                                job is to spend three minutes of database time.

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** The env var name, exported so a log line or a test can name it without re-spelling it. */
export const ADMIN_SNAPSHOT_CRON_SECRET_ENV = 'ADMIN_SNAPSHOT_CRON_SECRET';

/** The configured refresh secret, or null when the job is not configured. */
export function adminSnapshotCronSecret(): string | null {
  return env(ADMIN_SNAPSHOT_CRON_SECRET_ENV) ?? null;
}
