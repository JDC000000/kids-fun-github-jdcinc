// lib/corrections/retention-config.ts — environment configuration for the
// correction_report retention job. Mirrors lib/analytics/config.ts's operational
// surface (a cron secret + a dry-run kill-switch), with ONE deliberate difference
// noted below on the retention window.
//
// Nothing here returns a secret to a caller that would print it —
// correctionRetentionCronSecret() is only ever compared, in constant time, against a
// presented header inside the retention run route.
//
// Env vars (added to .env.example):
//   CORRECTION_RETENTION_CRON_SECRET — shared secret guarding POST
//                                      /api/corrections/retention/run.
//   CORRECTION_RETENTION_DRY_RUN     — "true" forces the retention job to COUNT ONLY
//                                      (delete nothing), regardless of caller. An
//                                      operator kill-switch for observe-first;
//                                      unset/false = the job actually deletes.
//
// WINDOW is intentionally NOT env-overridable (unlike ANALYTICS_RETENTION_DAYS).
// analytics_event stamps retained_until in the app writer from that env, so the env
// IS the source of truth there. correction_report rows are stamped by the column
// DEFAULT (migration 0020) — the write helper (report.ts) never sets the column — so
// the DB default is the single source of truth. Exposing a window env here would let
// the audit line silently disagree with the real DB window, so we keep it a documented
// constant that must equal the migration's `interval '6 months'` default.

/**
 * The correction_report retention window in whole days, for the job's audit/response
 * line ONLY. 183 ≈ the migration 0020 DB DEFAULT of `now() + interval '6 months'`
 * (6 calendar months averages ~182.6 days). The DB DEFAULT — not this constant — is
 * what actually determines how long a row is kept; keep the two in sync if either
 * changes (a window change is a new ALTER-DEFAULT migration, not an env tweak).
 */
export const CORRECTION_RETENTION_DAYS = 183;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** The window (in days) echoed in the retention job's result/audit line. Constant —
 *  the authoritative window is the correction_report.retained_until DB DEFAULT. */
export function correctionRetentionDays(): number {
  return CORRECTION_RETENTION_DAYS;
}

/** The retention-job shared secret, or null if unconfigured (route then fails closed). */
export function correctionRetentionCronSecret(): string | null {
  return env('CORRECTION_RETENTION_CRON_SECRET') ?? null;
}

/**
 * Whether the retention job is forced to dry-run (count only, delete nothing).
 * Default FALSE — the job's whole purpose is to actually enforce retention, so it
 * deletes by default; this is an operator kill-switch to observe first.
 */
export function correctionRetentionDryRunForced(): boolean {
  return env('CORRECTION_RETENTION_DRY_RUN') === 'true';
}
