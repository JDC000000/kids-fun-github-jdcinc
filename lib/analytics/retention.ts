// lib/analytics/retention.ts — the analytics retention ENFORCEMENT job (T31 / G-T31-3).
//
// A real, scheduled data-retention sweep: it DELETES `analytics_event` rows whose
// `retained_until` has passed. Deleting by the per-row `retained_until` stamp (set
// at insert from the app-owned window — see lib/analytics/config.ts) is the correct
// design: it honours the exact window each row was written under, and it is index-
// backed (idx_analytics_event_retained_until from migration 0006). This is the
// enforcement half of "retention is a real designed property, not a paper policy":
// the window is stamped on write and this job actually purges expired rows.
//
// The batched-delete mechanic is shared with correction_report's retention job via
// lib/db/retention-purge.ts — this module is now the thin analytics-specific wrapper
// (it supplies the table + the app-owned window it reports). Behaviour is unchanged.
//
// Scheduling: driven by the platform `schedule` skill hitting the secret-guarded
// POST /api/analytics/retention/run — the same recurring-job pattern as the weekly
// digest email (app/api/email/weekly/run). NO pg_cron / no new infra is stood up.
//
// Server-only: touches `pg` via the shared pool.
import {
  purgeExpiredByRetainedUntil,
  type RetentionPurgeOptions,
  type RetentionPurgeResult,
} from '@/lib/db/retention-purge';
import { retentionDays } from './config';

/** @deprecated import from '@/lib/db/retention-purge' — kept as a stable alias. */
export type PurgeOptions = RetentionPurgeOptions;
/** @deprecated import from '@/lib/db/retention-purge' — kept as a stable alias. */
export type PurgeResult = RetentionPurgeResult;

/**
 * Purge analytics events past their retention window. Deletes
 * `WHERE retained_until < now` in bounded batches. Throws on a real DB error
 * (a maintenance job SHOULD surface failures — unlike the best-effort event
 * writer); the run route catches and reports it.
 */
export async function purgeExpiredAnalyticsEvents(options: PurgeOptions = {}): Promise<PurgeResult> {
  return purgeExpiredByRetainedUntil('analytics_event', retentionDays(), options);
}
