// lib/analytics/record.ts — server-component convenience recorders.
//
// Thin wrappers a server component can call in a single additive line. They read
// the anonymous session id (kf_anon_id cookie, read-only — allowed in server
// components) for `user_or_session`, then delegate to the best-effort writer.
// Server-only: imports next/headers + the pg-backed write helper.
import { cookies } from 'next/headers';
import { ANON_SESSION_COOKIE, getOrCreateAnonId } from '@/lib/db/session';
import { writeAnalyticsEvent } from './events';

function currentAnonId(): string {
  try {
    return getOrCreateAnonId(cookies().get(ANON_SESSION_COOKIE)?.value);
  } catch {
    // Outside a request scope (or cookies unavailable) — still mint a non-null id.
    return getOrCreateAnonId(undefined);
  }
}

/**
 * Record a "listing viewed" event for a real occurrence detail page.
 * Best-effort and awaited so the row lands deterministically, but it can never
 * throw or block the render — writeAnalyticsEvent swallows all failures.
 * `occurrenceId` is only persisted to the FK column when it is a real UUID
 * (DB-backed pages); fixture ids are kept in the result summary instead.
 */
export async function recordListingView(
  occurrenceId: string,
  meta: { activityName?: string; category?: string; sourceName?: string; backend?: string } = {}
): Promise<void> {
  await writeAnalyticsEvent({
    eventType: 'listing_viewed',
    userOrSession: currentAnonId(),
    occurrenceId,
    resultSummary: {
      id: occurrenceId,
      activityName: meta.activityName ?? null,
      category: meta.category ?? null,
      sourceName: meta.sourceName ?? null,
      backend: meta.backend ?? (process.env.KIDS_FUN_SEARCH_BACKEND === 'database' ? 'database' : 'fixture'),
    },
  });
}
