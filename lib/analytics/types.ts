// lib/analytics/types.ts — Analytics event-capture foundation (M5 / T31 first slice).
//
// Typed contract shared by the server write helper (events.ts), the request
// validator (validate.ts), the POST /api/analytics/event route, and the
// fire-and-forget browser helper (client.ts). Rows land in the existing
// `analytics_event` table (supabase/migrations/0006_provenance_ops.sql):
//   event_type · search_context_json · result_summary_json · user_or_session ·
//   source_id · occurrence_id · created_at · retained_until (13-month default).
// The table already fits basic event capture — no migration is added by this task.

/** The small, known set of events this first slice can capture. Extend as M5 grows. */
export type AnalyticsEventType =
  | 'listing_viewed' // parent opened a real occurrence detail page (Screen 3)
  | 'search_performed' // a search/browse query was run
  | 'outbound_source_click'; // parent clicked through to an official source/booking page

export const KNOWN_EVENT_TYPES: readonly AnalyticsEventType[] = [
  'listing_viewed',
  'search_performed',
  'outbound_source_click',
];

/** Whole-request payload cap for the API route — a sanity ceiling against abuse. */
export const MAX_ANALYTICS_PAYLOAD_BYTES = 8 * 1024; // 8 KB

/** Per-jsonb-field cap so a single event can't stuff the table with a huge blob. */
export const MAX_JSON_FIELD_BYTES = 4 * 1024; // 4 KB per json field

/** Loose UUID shape check (mirrors lib/db/session.ts) — used to guard the
 *  occurrence_id / source_id foreign keys before an insert is attempted. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * A fully-resolved event ready to be written. Optional foreign keys are only
 * persisted when they are valid UUIDs; the free-form context/summary land in the
 * two jsonb columns. `userOrSession` is set server-side from the anon session id.
 */
export interface AnalyticsEventWrite {
  eventType: AnalyticsEventType;
  userOrSession?: string | null;
  occurrenceId?: string | null;
  sourceId?: string | null;
  searchContext?: Record<string, unknown> | null;
  resultSummary?: Record<string, unknown> | null;
}
