// lib/analytics/record.ts — server-side convenience recorders (one per event).
//
// Thin, typed wrappers a server component / route / worker can call in a single
// additive line. The anonymous recorders read the kf_anon_id cookie (read-only —
// allowed in server components) for `user_or_session`; the account/system
// recorders take an explicit pseudonymous actor (a user id or "system"). All
// delegate to emitEvent (best-effort — never throws or blocks the caller).
//
// PRIVACY DISCIPLINE (same bar as Tasks 13/38/B/H): only what the stated analytics
// purpose needs is captured — never raw PII (name/email/note text), never raw
// precise coordinates. See each recorder's doc for exactly what it stores.
//
// Server-only: imports next/headers + the pg-backed emitter.
import { cookies } from 'next/headers';
import { ANON_SESSION_COOKIE, getOrCreateAnonId } from '@/lib/db/session';
import { emitEvent } from './emit';

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
  await emitEvent(
    'listing_viewed',
    null,
    {
      id: occurrenceId,
      activityName: meta.activityName ?? null,
      category: meta.category ?? null,
      sourceName: meta.sourceName ?? null,
      backend: meta.backend ?? (process.env.KIDS_FUN_SEARCH_BACKEND === 'database' ? 'database' : 'fixture'),
    },
    currentAnonId(),
    { occurrenceId }
  );
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

  await emitEvent(
    'search_performed',
    {
      q,
      sort: context.sort ?? null,
      regions,
      filters,
      radiusKm: context.radiusKm ?? null,
      includeUnknownCost: context.includeUnknownCost ?? null,
    },
    {
      total: summary.total,
      confirmed: summary.confirmed ?? null,
      expected: summary.expected ?? null,
      backend: summary.backend ?? (process.env.KIDS_FUN_SEARCH_BACKEND === 'database' ? 'database' : 'fixture'),
      broadened: summary.broadened ?? false,
      hasQuery: q.length > 0,
    },
    currentAnonId()
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Additional launch-scoped recorders (full PRD §9 set). These fire from files
// owned by OTHER streams this round (auth callback, corrections API, account
// settings, saved-search API, ingestion worker) — see lib/analytics/catalog.ts.
// T31 ships the typed, privacy-safe capture path; the owning stream adds the
// one-line call. All are best-effort and never throw.
// ─────────────────────────────────────────────────────────────────────────────

/** Trim any stable token to a defensive length (not a PII scrub — these are ids/enums). */
const MAX_TOKEN_CHARS = 64;
function token(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_TOKEN_CHARS) : null;
}
function tokens(v: unknown): string[] {
  return Array.isArray(v) ? v.map(token).filter((t): t is string => t !== null) : [];
}

/**
 * `saved_search_created` — a parent saved a search (TSD §12.5 KPI #10,12).
 * Captures only the search's stable, non-PII shape (regions + filter tokens +
 * whether a free-text query was present), NEVER coordinates and NEVER the raw
 * query text (a saved search can be re-run from the account UI — analytics only
 * needs the shape, not the content). `actor` is the pseudonymous signed-in user id.
 */
export async function recordSavedSearchCreated(
  actor: string,
  context: { regions?: string[]; filters?: string[]; hasQuery?: boolean; sort?: string | null } = {}
): Promise<void> {
  await emitEvent(
    'saved_search_created',
    {
      regions: tokens(context.regions),
      filters: tokens(context.filters),
      hasQuery: Boolean(context.hasQuery),
      sort: token(context.sort),
    },
    null,
    actor
  );
}

/**
 * `weekly_email_opt_in` — a parent toggled the weekly digest opt-in (KPI #10,12).
 * Stores ONLY the pseudonymous user id + the new boolean state; never the email
 * address (that lives solely in Supabase auth.users).
 */
export async function recordWeeklyEmailOptIn(actor: string, optedIn: boolean): Promise<void> {
  await emitEvent('weekly_email_opt_in', null, { optedIn: Boolean(optedIn) }, actor);
}

/**
 * `account_signed_in` — a Google sign-in completed (KPI #10 returning-signed-in).
 * Stores ONLY the pseudonymous user id + coarse method/returning flags; never the
 * name/email/profile from the OAuth identity.
 */
export async function recordAccountSignedIn(
  actor: string,
  meta: { method?: string; returning?: boolean } = {}
): Promise<void> {
  await emitEvent('account_signed_in', null, {
    method: token(meta.method) ?? 'google',
    returning: meta.returning ?? null,
  }, actor);
}

/**
 * `correction_report_submitted` — a "wrong info" report was filed (KPI #8 trust).
 * Captures the occurrence reference + the controlled issue_type ONLY — never the
 * free-text note (which can contain arbitrary parent-typed PII). `actor` is the
 * reporter's anon session or user id.
 */
export async function recordCorrectionReport(
  occurrenceId: string,
  issueType: string,
  actor?: string | null
): Promise<void> {
  await emitEvent(
    'correction_report_submitted',
    { issueType: token(issueType) },
    null,
    actor ?? null,
    { occurrenceId }
  );
}

/**
 * `listing_status_changed` — an occurrence's status_state transitioned (PRD §9).
 * A SYSTEM event emitted by the ingestion worker; stores the occurrence/source
 * refs + the from/to status states only. No user, no PII.
 */
export async function recordListingStatusChanged(
  occurrenceId: string,
  fromStatus: string | null,
  toStatus: string,
  sourceId?: string | null
): Promise<void> {
  await emitEvent(
    'listing_status_changed',
    null,
    { from: token(fromStatus), to: token(toStatus) },
    'system',
    { occurrenceId, sourceId: sourceId ?? null }
  );
}
