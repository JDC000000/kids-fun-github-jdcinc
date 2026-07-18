// lib/analytics/kpi.ts — READ-SIDE product-health KPI rollups (M5 / T32).
//
// Computes the launch-scoped product-health KPIs the admin dashboard renders as
// tiles, straight from the real `analytics_event` table (the same rows Task P's
// emit/record write-side populates). This file is a pure CONSUMER: every
// statement is a SELECT, nothing mutates, and it imports NOTHING from the
// analytics write side (emit.ts / catalog.ts / events.ts / record.ts / client.ts)
// — the write/read split is deliberate so this can never perturb capture.
//
// Every KPI here is grounded in fields the §9 event catalog actually persists
// (see lib/analytics/record.ts for the payload each event writes):
//   • search_performed  → result_summary_json.total (result count), .broadened
//   • listing_viewed / outbound_source_click → engagement volume
//   • any event         → user_or_session (DAU/WAU/MAU distinct-actor windows)
//   • saved_search_created / weekly_email_opt_in / account_signed_in → account value
// No metric is invented that the data cannot support (e.g. relevance-graded
// "search success" is intentionally absent — the events carry no relevance label).
//
// Server-only: uses the shared pg pool (lib/db/client). Robust to an EMPTY table
// (every count returns 0 and the ratio helpers return null → the UI shows "—").
import { query } from '@/lib/db/client';

// ── Rolling windows (calendar days). Kept as named constants so tests, the data
//    layer, and the UI copy all read the exact same number. ──
/** Engagement volume/rates (searches, views, clicks, CTR, zero-result) window. */
export const ENGAGEMENT_WINDOW_DAYS = 7;
/** Active-user windows: DAU = 1 day, WAU = 7 days, MAU = 30 days. */
export const DAU_WINDOW_DAYS = 1;
export const WAU_WINDOW_DAYS = 7;
export const MAU_WINDOW_DAYS = 30;
/** Account-value window (saved searches, email opt-ins, sign-ins). */
export const ACCOUNT_WINDOW_DAYS = 30;

/** §12.5 KPI #7 target: source click-through ≥ 25%. */
export const SOURCE_CTR_TARGET_PCT = 25;

/** Raw engagement counts over ENGAGEMENT_WINDOW_DAYS. */
export interface EngagementCounts {
  searches: number;
  listingViews: number;
  outboundClicks: number;
  /** search_performed rows that carry a result `total` (the CTR/zero-result denominator). */
  searchesWithResults: number;
  /** …of those, how many returned zero results. */
  zeroResultSearches: number;
  /** …searches the engine broadened to recover a thin/empty result set (§12.5 recovery). */
  broadenedSearches: number;
}

/** Distinct-actor active-user counts (by `user_or_session`). */
export interface ActiveUsers {
  dau: number;
  wau: number;
  mau: number;
}

/** Account-value / retention-signal counts over ACCOUNT_WINDOW_DAYS. */
export interface AccountValue {
  savedSearches: number;
  /** weekly_email_opt_in events where the new state was opted-IN. */
  emailOptIns: number;
  /** account_signed_in events (raw sign-in count). */
  signInEvents: number;
  /** distinct actors who signed in at least once (KPI #15 "logged in once"). */
  signedInUsers: number;
}

export interface ProductHealthKpis {
  windows: {
    engagementDays: number;
    dauDays: number;
    wauDays: number;
    mauDays: number;
    accountDays: number;
  };
  engagement: EngagementCounts;
  activeUsers: ActiveUsers;
  accountValue: AccountValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure, DB-free math helpers — exported so they can be unit-tested without a
// database and reused by the UI. All are null-safe on empty inputs.
// ─────────────────────────────────────────────────────────────────────────────

/** Average per calendar day over `days`, rounded to 1 dp. `days<=0` → 0. */
export function perDay(total: number, days: number): number {
  if (!Number.isFinite(total) || days <= 0) return 0;
  return Math.round((total / days) * 10) / 10;
}

/**
 * A percentage `numer/denom`, rounded to a whole number. Returns `null` when the
 * denominator is 0 (i.e. "not enough data to state a rate") so the UI can show an
 * em-dash instead of a misleading 0%.
 */
export function pct(numer: number, denom: number): number | null {
  if (!Number.isFinite(numer) || !Number.isFinite(denom) || denom <= 0) return null;
  return Math.round((numer / denom) * 100);
}

/** Source click-through rate %: outbound_source_click ÷ listing_viewed. */
export function sourceCtrPct(outboundClicks: number, listingViews: number): number | null {
  return pct(outboundClicks, listingViews);
}

/** Zero-result rate %: searches that returned nothing ÷ searches with result data. */
export function zeroResultPct(zeroResultSearches: number, searchesWithResults: number): number | null {
  return pct(zeroResultSearches, searchesWithResults);
}

/** Share of active users (MAU) who signed in at least once, as a %. */
export function signedInSharePct(signedInUsers: number, mau: number): number | null {
  return pct(signedInUsers, mau);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read queries. Each is a single SELECT with a parameterised day-window; FILTER
// clauses do the per-event-type slicing in one table pass. Robust to an empty
// table (COUNT → 0). String comparisons on the ->> extractions avoid any cast
// that a legacy/hand-inserted row could error the whole query with.
// ─────────────────────────────────────────────────────────────────────────────

async function getEngagementCounts(windowDays: number): Promise<EngagementCounts> {
  const rows = await query<{
    searches: number;
    listing_views: number;
    outbound_clicks: number;
    searches_with_results: number;
    zero_result_searches: number;
    broadened_searches: number;
  }>(
    `
    SELECT
      count(*) FILTER (WHERE event_type = 'search_performed')::int AS searches,
      count(*) FILTER (WHERE event_type = 'listing_viewed')::int AS listing_views,
      count(*) FILTER (WHERE event_type = 'outbound_source_click')::int AS outbound_clicks,
      count(*) FILTER (
        WHERE event_type = 'search_performed' AND result_summary_json ? 'total'
      )::int AS searches_with_results,
      count(*) FILTER (
        WHERE event_type = 'search_performed'
          AND result_summary_json ? 'total'
          AND (result_summary_json ->> 'total') = '0'
      )::int AS zero_result_searches,
      count(*) FILTER (
        WHERE event_type = 'search_performed'
          AND (result_summary_json ->> 'broadened') = 'true'
      )::int AS broadened_searches
    FROM analytics_event
    WHERE created_at >= now() - ($1::int * interval '1 day')
    `,
    [windowDays]
  );
  const r = rows[0];
  return {
    searches: r?.searches ?? 0,
    listingViews: r?.listing_views ?? 0,
    outboundClicks: r?.outbound_clicks ?? 0,
    searchesWithResults: r?.searches_with_results ?? 0,
    zeroResultSearches: r?.zero_result_searches ?? 0,
    broadenedSearches: r?.broadened_searches ?? 0,
  };
}

async function getActiveUsers(): Promise<ActiveUsers> {
  // One pass over the last MAU_WINDOW_DAYS; the tighter DAU/WAU windows are carved
  // out with FILTER so we never scan the table three times. Null/blank actor ids
  // are excluded so a malformed row can't inflate the distinct counts.
  const rows = await query<{ dau: number; wau: number; mau: number }>(
    `
    SELECT
      count(DISTINCT user_or_session) FILTER (WHERE created_at >= now() - ($1::int * interval '1 day'))::int AS dau,
      count(DISTINCT user_or_session) FILTER (WHERE created_at >= now() - ($2::int * interval '1 day'))::int AS wau,
      count(DISTINCT user_or_session)::int AS mau
    FROM analytics_event
    WHERE created_at >= now() - ($3::int * interval '1 day')
      AND user_or_session IS NOT NULL
      AND user_or_session <> ''
    `,
    [DAU_WINDOW_DAYS, WAU_WINDOW_DAYS, MAU_WINDOW_DAYS]
  );
  const r = rows[0];
  return { dau: r?.dau ?? 0, wau: r?.wau ?? 0, mau: r?.mau ?? 0 };
}

async function getAccountValue(windowDays: number): Promise<AccountValue> {
  const rows = await query<{
    saved_searches: number;
    email_opt_ins: number;
    sign_in_events: number;
    signed_in_users: number;
  }>(
    `
    SELECT
      count(*) FILTER (WHERE event_type = 'saved_search_created')::int AS saved_searches,
      count(*) FILTER (
        WHERE event_type = 'weekly_email_opt_in'
          AND (result_summary_json ->> 'optedIn') = 'true'
      )::int AS email_opt_ins,
      count(*) FILTER (WHERE event_type = 'account_signed_in')::int AS sign_in_events,
      count(DISTINCT user_or_session) FILTER (
        WHERE event_type = 'account_signed_in'
          AND user_or_session IS NOT NULL
          AND user_or_session <> ''
      )::int AS signed_in_users
    FROM analytics_event
    WHERE created_at >= now() - ($1::int * interval '1 day')
    `,
    [windowDays]
  );
  const r = rows[0];
  return {
    savedSearches: r?.saved_searches ?? 0,
    emailOptIns: r?.email_opt_ins ?? 0,
    signInEvents: r?.sign_in_events ?? 0,
    signedInUsers: r?.signed_in_users ?? 0,
  };
}

/**
 * Assemble the full product-health KPI payload the dashboard renders. All three
 * read groups run concurrently. Every value derives ONLY from `analytics_event`,
 * so the tiles reflect the live database, never a fixture. Safe on an empty table.
 */
export async function getProductHealthKpis(): Promise<ProductHealthKpis> {
  const [engagement, activeUsers, accountValue] = await Promise.all([
    getEngagementCounts(ENGAGEMENT_WINDOW_DAYS),
    getActiveUsers(),
    getAccountValue(ACCOUNT_WINDOW_DAYS),
  ]);
  return {
    windows: {
      engagementDays: ENGAGEMENT_WINDOW_DAYS,
      dauDays: DAU_WINDOW_DAYS,
      wauDays: WAU_WINDOW_DAYS,
      mauDays: MAU_WINDOW_DAYS,
      accountDays: ACCOUNT_WINDOW_DAYS,
    },
    engagement,
    activeUsers,
    accountValue,
  };
}
