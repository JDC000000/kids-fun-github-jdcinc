// lib/analytics/types.ts — Analytics event-capture foundation (M5 / T31).
//
// Typed contract shared by the server write helper (events.ts), the generic
// emitter (emit.ts), the request validator (validate.ts), the POST
// /api/analytics/event route, and the fire-and-forget browser helper (client.ts).
// Rows land in the existing `analytics_event` table
// (supabase/migrations/0006_provenance_ops.sql):
//   event_type · search_context_json · result_summary_json · user_or_session ·
//   source_id · occurrence_id · created_at · retained_until.
// event_type is a free-form text column, so the full catalog below needs no
// migration — see lib/analytics/catalog.ts for per-event provenance + wiring.
//
// `retained_until` is stamped at insert time from the app-owned retention window
// (lib/analytics/config.ts::retentionDays), and the retention job
// (lib/analytics/retention.ts) enforces it by deleting rows once it has passed.

/**
 * The full launch-scoped analytics event catalog (PRD/TSD §9). Every member maps
 * to a documented event or KPI in lib/analytics/catalog.ts. `search_autocomplete_selected`
 * is intentionally ABSENT — autocomplete is not built at launch, so that PRD §9
 * event is formally deferred (N/A); see DEFERRED_EVENT_TYPES in catalog.ts.
 */
export type AnalyticsEventType =
  // ── client-fireable engagement signals (accepted by the public POST route) ──
  | 'search_performed' // a search/browse query was run (PRD §9 `search_submitted`)
  | 'listing_viewed' // parent opened a real occurrence detail page (Screen 3)
  | 'outbound_source_click' // parent clicked through to an official source/booking page
  // ── server-only events (emitted by trusted server code; never via the public route) ──
  | 'saved_search_created' // parent saved a search (repeat-use / account-value KPI)
  | 'weekly_email_opt_in' // parent opted in to the weekly digest email
  | 'account_signed_in' // a Google account sign-in completed (returning-user KPI)
  | 'correction_report_submitted' // a "wrong info" correction was filed (trust KPI)
  | 'listing_status_changed' // an occurrence's status_state transitioned (ingestion)
  | 'sms_offer_viewed' // the home page PRESENTED the SMS signup offer (the funnel denominator)
  // ── the one client-fireable half of the SMS front-door funnel ──
  | 'sms_signup_cta_clicked'; // a parent tapped the home page's primary signup action

export const KNOWN_EVENT_TYPES: readonly AnalyticsEventType[] = [
  'search_performed',
  'listing_viewed',
  'outbound_source_click',
  'saved_search_created',
  'weekly_email_opt_in',
  'account_signed_in',
  'correction_report_submitted',
  'listing_status_changed',
  'sms_offer_viewed',
  'sms_signup_cta_clicked',
];

/**
 * The subset the PUBLIC POST /api/analytics/event route will accept from a
 * browser. These are low-stakes engagement signals where a spoofed row is
 * harmless. Everything else is SERVER-ONLY: it is emitted from trusted server
 * code (auth callback, corrections API, ingestion worker, saved-search API) and
 * must never be injectable by an untrusted client, so the validator rejects it.
 *
 * ═══ THE SMS FRONT-DOOR PAIR IS SPLIT ACROSS THIS LINE, DELIBERATELY ═══
 * `sms_offer_viewed` and `sms_signup_cta_clicked` measure the two ends of ONE
 * funnel, so the ratio between them IS the conversion rate the homepage pivot is
 * judged on. That makes which side of this line each one sits on a data-integrity
 * decision, not a filing one:
 *   • the CLICK is here, because it happens in a browser and the server never sees
 *     it — the CTA is an internal <Link>, not a form post, so there is no
 *     server-side vantage point to fire it from. A spoofed row over-counts the
 *     NUMERATOR, which is the cheap direction: it inflates a number already read
 *     as an upper bound.
 *   • the IMPRESSION is NOT here. It is the DENOMINATOR, and it is emitted during
 *     the home page's own render, where whether the offer was actually presented
 *     is a fact only the server holds (see lib/sms/availability.ts). Accepting it
 *     from a browser would let anything inflate the denominator and silently
 *     DEPRESS the measured conversion rate — a corruption that looks like a
 *     product result and cannot be untangled after the fact.
 */
export type ClientEventType =
  | 'search_performed'
  | 'listing_viewed'
  | 'outbound_source_click'
  | 'sms_signup_cta_clicked';

export const CLIENT_EVENT_TYPES: readonly ClientEventType[] = [
  'search_performed',
  'listing_viewed',
  'outbound_source_click',
  'sms_signup_cta_clicked',
];

/** Events that are only ever written by trusted server code (the complement of CLIENT_EVENT_TYPES). */
export const SERVER_EVENT_TYPES: readonly AnalyticsEventType[] = KNOWN_EVENT_TYPES.filter(
  (t) => !(CLIENT_EVENT_TYPES as readonly string[]).includes(t)
);

export function isClientFireableEvent(type: string): type is ClientEventType {
  return (CLIENT_EVENT_TYPES as readonly string[]).includes(type);
}

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
