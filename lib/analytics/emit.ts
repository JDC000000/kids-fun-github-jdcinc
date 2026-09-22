// lib/analytics/emit.ts — the generic analytics emitter (T31 / G-T31-1).
//
// The canonical low-level entry point the scope-to-task doc specifies:
//   emitEvent(type, searchContext, resultSummary, actor, refs)
// It writes one row into `analytics_event` with a `retained_until` computed from
// the app-owned retention window (lib/analytics/config.ts::retentionDays), so the
// retention window is a real, single-sourced, enforced property rather than only a
// DB default. Like every write on this path it is BEST-EFFORT: a DB/validation
// hiccup resolves to { ok: false } and can never throw or block the caller.
//
// Server-only: delegates to lib/analytics/events.ts, which touches `pg`.
import type { AnalyticsEventType } from './types';
import { writeAnalyticsEvent } from './events';

/** Foreign-key references for an event (only persisted when valid UUIDs). */
export interface EmitRefs {
  occurrenceId?: string | null;
  sourceId?: string | null;
  /** analytics_event.search_minute_request_count (migration 0052) — see lib/analytics/types.ts's
   *  `AnalyticsEventWrite.searchMinuteRequestCount` for what this is and why it lives on the write
   *  contract rather than in searchContext/resultSummary (it is a moderation signal, not product
   *  data, and lib/analytics/kpi.ts needs it as a real column to index and filter on). */
  searchMinuteRequestCount?: number | null;
}

/**
 * Emit one analytics event. Matches the T31 `emitEvent(type, searchContext,
 * resultSummary, actor, refs)` contract. `actor` is written to `user_or_session`
 * (an anon kf_anon_id or a pseudonymous user id — never a name/email). Never throws.
 */
export async function emitEvent(
  type: AnalyticsEventType,
  searchContext?: Record<string, unknown> | null,
  resultSummary?: Record<string, unknown> | null,
  actor?: string | null,
  refs?: EmitRefs
): Promise<{ ok: boolean }> {
  return writeAnalyticsEvent({
    eventType: type,
    userOrSession: actor ?? null,
    searchContext: searchContext ?? null,
    resultSummary: resultSummary ?? null,
    occurrenceId: refs?.occurrenceId ?? null,
    sourceId: refs?.sourceId ?? null,
    searchMinuteRequestCount: refs?.searchMinuteRequestCount ?? null,
  });
}
