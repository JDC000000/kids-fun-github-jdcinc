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

/** Cap the free-text query stored on a search event — a defensive bound on the
 *  jsonb blob, well under MAX_JSON_FIELD_BYTES. Not a PII scrub: the query text is
 *  intentionally captured (product signal), but nothing beyond it is. */
const MAX_QUERY_CHARS = 200;

/** Non-PII context for a `search_performed` event. Deliberately EXCLUDES the near-me
 *  origin coordinates (location is identifying) — only the boolean intent + radius. */
export interface SearchPerformedContext {
  /** Raw parent-typed query text (product signal; truncated, never coordinates). */
  q?: string | null;
  /** Active sort key (e.g. 'best_match'). */
  sort?: string | null;
  /** Region-chip ids the search unioned over (e.g. ['van','rmd']). */
  regions?: string[];
  /** Stable non-region filter tokens (e.g. 'when:weekend', 'age:5-9', 'free', 'near_me'). */
  filters?: string[];
  /** Travel radius in km — only meaningful when a near-me origin was set. */
  radiusKm?: number | null;
  /** Whether unknown-cost listings were included (the default-on cost toggle). */
  includeUnknownCost?: boolean;
}

/** Result-shape summary for a `search_performed` event (counts only, no listing PII). */
export interface SearchPerformedSummary {
  total: number;
  confirmed?: number;
  expected?: number;
  /** 'database' (live staging) vs 'fixture' — lets the dashboard trust/flag the row. */
  backend?: string;
  /** Whether the engine broadened the query to fill a thin result set. */
  broadened?: boolean;
}

/**
 * Record a "search performed" event for a real query/browse on /search.
 * Best-effort and awaited (matches recordListingView) so the row lands
 * deterministically, but it can never throw or block the render.
 *
 * Only non-PII, product-useful fields are captured: the query text, the active
 * filters/regions (as stable tokens), and the result shape. The anonymous session
 * id (kf_anon_id) is the ONLY identifier, exactly as with listing views. Near-me
 * coordinates are never persisted — only the boolean `near_me` filter + radius.
 */
export async function recordSearchPerformed(
  context: SearchPerformedContext,
  summary: SearchPerformedSummary
): Promise<void> {
  const q = typeof context.q === 'string' ? context.q.trim().slice(0, MAX_QUERY_CHARS) : '';
  const regions = (context.regions ?? []).filter((r) => typeof r === 'string' && r.length > 0);
  const filters = (context.filters ?? []).filter((f) => typeof f === 'string' && f.length > 0);

  await writeAnalyticsEvent({
    eventType: 'search_performed',
    userOrSession: currentAnonId(),
    searchContext: {
      q,
      sort: context.sort ?? null,
      regions,
      filters,
      radiusKm: context.radiusKm ?? null,
      includeUnknownCost: context.includeUnknownCost ?? null,
    },
    resultSummary: {
      total: summary.total,
      confirmed: summary.confirmed ?? null,
      expected: summary.expected ?? null,
      backend: summary.backend ?? (process.env.KIDS_FUN_SEARCH_BACKEND === 'database' ? 'database' : 'fixture'),
      broadened: summary.broadened ?? false,
      hasQuery: q.length > 0,
    },
  });
}
