// lib/analytics/events.ts — server-side event write helper (best-effort).
//
// Inserts into `analytics_event` via the shared pg pool (lib/db/client). This is
// deliberately BEST-EFFORT: an analytics failure must never surface to the caller
// or break the page/request that fired the event. Every failure is swallowed and
// reported as { ok: false } — callers may ignore the result entirely.
//
// Server-only: touches `pg`. Do not import from client/browser code.
import { query } from '@/lib/db/client';
import { type AnalyticsEventWrite, isUuid } from './types';

/**
 * Write one analytics event. Never throws — DB/validation hiccups resolve to
 * { ok: false } so a view/search flow is never blocked or errored by analytics.
 * Foreign keys (occurrence_id / source_id) are only persisted when they are
 * well-formed UUIDs; jsonb columns are serialised explicitly.
 */
export async function writeAnalyticsEvent(event: AnalyticsEventWrite): Promise<{ ok: boolean }> {
  try {
    const occurrenceId = isUuid(event.occurrenceId) ? event.occurrenceId : null;
    const sourceId = isUuid(event.sourceId) ? event.sourceId : null;
    const searchContext = event.searchContext ? JSON.stringify(event.searchContext) : null;
    const resultSummary = event.resultSummary ? JSON.stringify(event.resultSummary) : null;

    await query(
      `INSERT INTO analytics_event
         (event_type, user_or_session, occurrence_id, source_id, search_context_json, result_summary_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.eventType, event.userOrSession ?? null, occurrenceId, sourceId, searchContext, resultSummary]
    );
    return { ok: true };
  } catch (err) {
    // Best-effort: log at warn level and move on. Analytics is never load-bearing.
    console.warn('[analytics] event write failed:', (err as Error)?.message ?? err);
    return { ok: false };
  }
}
