// lib/analytics/config.ts — environment configuration for analytics + retention.
//
// One place that knows every analytics-related env var, mirroring lib/email/config.ts.
// Nothing here ever returns a secret to a caller that would print it —
// retentionCronSecret() is used only to compare against a presented header, in
// constant time, inside the retention run route.
//
// Env vars (all added to .env.example):
//   ANALYTICS_RETENTION_DAYS          — retention window in days for analytics_event
//                                       rows. Default 395 (~13 months) to match the
//                                       DB DEFAULT in migration 0006 and the ~13-month
//                                       kf_anon_id cookie. Floored at 1 day.
//   ANALYTICS_RETENTION_CRON_SECRET   — shared secret guarding POST
//                                       /api/analytics/retention/run.
//   ANALYTICS_RETENTION_DRY_RUN       — "true" forces the retention job to COUNT
//                                       ONLY (delete nothing), regardless of caller.
//                                       An operator kill-switch for observe-first;
//                                       unset/false = the job actually deletes.

/**
 * Default retention window for analytics events, in days. 395 ≈ 13 months, chosen
 * to equal the `retained_until` DB DEFAULT set in migration 0006
 * (`now() + interval '13 months'`) and the ~13-month kf_anon_id cookie lifetime,
 * so the app-stamped value and the schema default never disagree.
 */
export const DEFAULT_RETENTION_DAYS = 395;

/** Hard floor so a misconfigured window can never make freshly-written rows expire immediately. */
export const MIN_RETENTION_DAYS = 1;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * The retention window in whole days. Env-overridable, but always a finite integer
 * ≥ MIN_RETENTION_DAYS — a non-numeric / zero / negative override falls back to the
 * default rather than producing a dangerous window.
 */
export function retentionDays(): number {
  const raw = env('ANALYTICS_RETENTION_DAYS');
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_RETENTION_DAYS) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

/**
 * The timestamp a row written NOW should be retained until = now + the window.
 * Stamped into `analytics_event.retained_until` at insert time (emit/writer) so
 * the retention job can enforce the window by deleting rows once it has passed.
 */
export function retainedUntil(now: Date = new Date()): Date {
  return new Date(now.getTime() + retentionDays() * 24 * 60 * 60 * 1000);
}

/** The retention-job shared secret, or null if unconfigured (route then fails closed). */
export function retentionCronSecret(): string | null {
  return env('ANALYTICS_RETENTION_CRON_SECRET') ?? null;
}

/**
 * Whether the retention job is forced to dry-run (count only, delete nothing).
 * Default FALSE — the job's whole purpose is to actually enforce retention, so it
 * deletes by default; this is an operator kill-switch to observe first.
 */
export function retentionDryRunForced(): boolean {
  return env('ANALYTICS_RETENTION_DRY_RUN') === 'true';
}
