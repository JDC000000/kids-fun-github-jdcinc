// lib/analytics/catalog.ts — the analytics event catalog, self-documenting.
//
// One authoritative place that describes every launch-scoped analytics event:
// what it means, the PRD/TSD provenance and KPI it feeds (TSD §12.5), whether it
// is fired from the browser or from trusted server code, and — importantly for a
// multi-stream round — WHERE it is wired today. T31 owns the *capture layer*
// (lib/analytics/** + the analytics API routes). Several events fire from files
// owned by other streams (search UI, account, corrections API, ingestion worker);
// for those, this task ships a typed recorder helper + validated write path so
// the owning stream can wire the emit in a single line, and this catalog records
// that boundary explicitly rather than reaching into another stream's files.
//
// Consumers: the product-health / data-health dashboards (T32/T33) can read this
// catalog to enumerate expected events, and the tests assert its invariants.
import {
  type AnalyticsEventType,
  CLIENT_EVENT_TYPES,
  KNOWN_EVENT_TYPES,
} from './types';

/**
 * Wiring status of an event in the codebase RIGHT NOW.
 *  - `wired`        — an emit call exists on the real product path today.
 *  - `capture_ready`— the recorder helper + write path exist here; the emit call
 *                     lives in a file owned by another stream, wired by them.
 *  - `deferred`     — formally N/A at launch (see DEFERRED_EVENT_TYPES).
 */
export type EventWiring = 'wired' | 'capture_ready' | 'deferred';

export interface EventCatalogEntry {
  type: AnalyticsEventType;
  /** Who may emit it: the browser (client) or trusted server code only. */
  origin: 'client' | 'server';
  wiring: EventWiring;
  /** Where the emit fires (or should fire) — for the capture_ready boundary note. */
  firedFrom: string;
  /** PRD/TSD §9 name or §12.5 KPI number(s) this event serves. */
  provenance: string;
  description: string;
}

export const EVENT_CATALOG: readonly EventCatalogEntry[] = [
  {
    type: 'search_performed',
    origin: 'client',
    wiring: 'wired',
    firedFrom: 'app/search/page.tsx (server component; recordSearchPerformed)',
    provenance: 'PRD §9 `search_submitted`; TSD §12.5 KPI #1,2,6',
    description: 'A real search/browse query executed (non-PII query text + filter tokens + result counts).',
  },
  {
    type: 'listing_viewed',
    origin: 'client',
    wiring: 'wired',
    firedFrom: 'app/preview/[id]/page.tsx (server component; recordListingView)',
    provenance: 'TSD §12.5 KPI #7 (detail/source CTA engagement)',
    description: 'A parent opened a real occurrence detail page.',
  },
  {
    type: 'outbound_source_click',
    origin: 'client',
    wiring: 'capture_ready',
    firedFrom: 'source/booking CTA (cards + detail) — owned by the detail/cards stream; call trackEvent()',
    provenance: 'TSD §12.5 KPI #7 (source click-through ≥25%)',
    description: 'A parent clicked through to an official source/booking page.',
  },
  {
    type: 'saved_search_created',
    origin: 'server',
    wiring: 'capture_ready',
    firedFrom: 'saved-search create path — owned by the account/saved-search stream; call recordSavedSearchCreated()',
    provenance: 'TSD §12.5 KPI #10,12 (repeat use / account value)',
    description: 'A parent saved a search (non-PII filter tokens only, never coordinates).',
  },
  {
    type: 'weekly_email_opt_in',
    origin: 'server',
    wiring: 'capture_ready',
    firedFrom: 'account settings opt-in toggle — owned by the account stream; call recordWeeklyEmailOptIn()',
    provenance: 'TSD §12.5 KPI #10,12 (email opt-in)',
    description: 'A parent opted in to the weekly digest email (pseudonymous user id only, never the address).',
  },
  {
    type: 'account_signed_in',
    origin: 'server',
    wiring: 'capture_ready',
    firedFrom: 'auth callback — owned by the auth stream; call recordAccountSignedIn()',
    provenance: 'TSD §12.5 KPI #10 (returning signed-in), #12',
    description: 'A Google account sign-in completed (pseudonymous user id only, never email/profile).',
  },
  {
    type: 'correction_report_submitted',
    origin: 'server',
    wiring: 'capture_ready',
    firedFrom: 'app/api/corrections route — owned by the corrections stream; call recordCorrectionReport()',
    provenance: 'TSD §12.5 KPI #8 (correction rate / trust <2 per 100 clicks)',
    description: 'A "wrong info" correction was filed (occurrence ref + issue_type only, never the free-text note).',
  },
  {
    type: 'listing_status_changed',
    origin: 'server',
    wiring: 'capture_ready',
    firedFrom: 'ingestion worker on a status_state transition — owned by the ingestion stream; call recordListingStatusChanged()',
    provenance: 'PRD/TSD §9 named event `listing_status_changed`',
    description: 'An occurrence status_state transitioned (from/to states + occurrence ref; no PII).',
  },
  // ── the homepage → SMS front door funnel (TSD §9 M1 / AC-09) ──────────────
  // Two entries, one measurement. `sms_offer_viewed` is the denominator and
  // `sms_signup_cta_clicked` the numerator of the conversion rate the pivot is
  // judged on, which is why they are the only pair here whose client/server split
  // is argued in lib/analytics/types.ts rather than merely stated.
  {
    type: 'sms_offer_viewed',
    origin: 'server',
    wiring: 'wired',
    firedFrom: 'app/page.tsx (server component; recordSmsOfferViewed) — ONLY when the offer is actually presented',
    provenance: 'TSD §9 M1 T1.5 / AC-09 (impression half); denominator of the S-03 signup conversion rate',
    description:
      'The home page presented the SMS signup offer. NOT emitted on the fail-safe degraded render (AC-12) — a render with no offer on it is not an offer seen, and counting it would depress the conversion rate with rows that never had a chance to convert.',
  },
  {
    type: 'sms_signup_cta_clicked',
    origin: 'client',
    wiring: 'capture_ready',
    firedFrom: 'app/_components/SmsSignupCta.tsx (client island; trackEvent) — rendered by app/page.tsx',
    provenance: 'TSD §9 M1 T1.6 / AC-09 (click half); numerator of the S-03 signup conversion rate',
    description:
      "A parent tapped the home page's primary SMS signup action. Fired from the browser because the CTA is an internal <Link> the server never observes; best-effort, and it never delays or blocks the navigation it measures.",
  },
];

/**
 * PRD §9 events that are formally DEFERRED / N/A at launch. Kept here (not in the
 * live union) so the deferral is explicit and testable, per T31 G-T31-2:
 * "if autocomplete deferred, explicitly mark `search_autocomplete_selected` N/A."
 */
export const DEFERRED_EVENT_TYPES: readonly { type: string; reason: string }[] = [
  {
    type: 'search_autocomplete_selected',
    reason:
      'Typeahead/autocomplete is not built at launch (TSD §5A / Task 16 note), so this PRD §9 event is formally N/A. If autocomplete ships later, add it to AnalyticsEventType + CLIENT_EVENT_TYPES and wire trackEvent() on selection.',
  },
];

/** Look up a catalog entry (or undefined for an unknown/deferred type). */
export function catalogEntry(type: string): EventCatalogEntry | undefined {
  return EVENT_CATALOG.find((e) => e.type === type);
}

// ── invariants (also asserted in tests/analytics/catalog.test.ts) ──
// Every known event type has exactly one catalog entry, and vice-versa; every
// client-fireable event is marked origin:'client'. These throw at import time in
// dev/test if the catalog and the type sets ever drift apart.
{
  const catalogued = new Set(EVENT_CATALOG.map((e) => e.type));
  for (const t of KNOWN_EVENT_TYPES) {
    if (!catalogued.has(t)) throw new Error(`[analytics] catalog missing entry for known event: ${t}`);
  }
  if (catalogued.size !== EVENT_CATALOG.length) {
    throw new Error('[analytics] duplicate event type in EVENT_CATALOG');
  }
  for (const e of EVENT_CATALOG) {
    const shouldBeClient = (CLIENT_EVENT_TYPES as readonly string[]).includes(e.type);
    if (shouldBeClient !== (e.origin === 'client')) {
      throw new Error(`[analytics] catalog origin/${e.origin} disagrees with CLIENT_EVENT_TYPES for ${e.type}`);
    }
  }
}
