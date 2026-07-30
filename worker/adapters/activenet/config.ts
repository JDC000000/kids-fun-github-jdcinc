// worker/adapters/activenet/config.ts — G-T7R-1: ActiveCommunities portal tenant config
// (TSD §5.1 Adapter A). Config-driven so adding an ActiveCommunities municipality is a
// config entry, never new code. `sourceName` ties each tenant to its `source` row
// (supabase/seeds/sources.sql).
//
// ─────────────────────────────────────────────────────────────────────────────
// AUTHORITY — read before changing anything in this file.
//
// Automated access to the ActiveCommunities rec-portal is prohibited by ACTIVE
// Network's Terms of Use. That prohibition has been OVERRIDDEN by the business owner
// (decisions_register D-10, 2026-07-30 — Jon's direct, twice-stated, informed override).
// The risk is stated here unsoftened, because that is the point of recording it:
// we are reading a third party's portal against its published Terms of Use, on an
// explicit business decision to accept that risk. ACTIVE would be within its stated
// terms to block us, and we would have no recourse. Nothing in this file's polite
// engineering makes that go away — it bounds the operational risk, not the terms risk.
//
// What D-10 did NOT do: it did not authorise deceptive or access-control-defeating
// access. Every request stays an identified, contactable, credential-free read
// (KidsFunBot UA, no cookie, no session, no CSRF/anti-forgery token, no browser
// spoof, no headless render) — all of which was verified UNNECESSARY against the
// live API on 2026-07-30. tests/compliance/no-bypass.test.ts still enforces every
// one of those prohibitions; the only amendment it carries is the narrow, named
// READ_ONLY_POST_SEARCH allowance (decisions_register D-11) for the vendor's
// POST-as-query search endpoints, which mutate nothing.
// ─────────────────────────────────────────────────────────────────────────────
//
// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL EVIDENCE — why the OFFICIAL ACTIVE API route was abandoned (preserved
// deliberately from the prior T7 compliance-hardening pass; do not delete).
//
// T7 first tried ACTIVE's official public Activity Search API v2
// (api.amp.active.com/v2/search) under D-9. The credentials worked and the API was
// healthy, but the DATA was dead for our tenants (confirming query, 2026-07-30):
//   • Vancouver Park Board — present as org 'Vancouver Board of Parks and Recreation'
//     (sourceSystem 'ActiveNet CA'), but syndication CEASED ~2024-06. Activity counts
//     by year: 2021→1,497 · 2022→1,342 · 2023→~10,000 (result cap) · 2024→22 ·
//     2025→0 · 2026→0. Newest drop-in record ended 2023-08-26; the final 22 records
//     (2024-06-04) were preschool deposits, not drop-ins.
//   • Burnaby / West Vancouver — NO municipal organization in the official API at all;
//     their 2026 records are 100% private orgs (hockey schools, private schools, swim
//     and baseball clubs) on 'AW Camps 3.0' / 'ActiveWorks Team Sports'.
// That is why this config is now keyed by PORTAL TENANT, not by `apiOrganizationName`,
// and why `syndicationStatus` is gone: the official-API axis described a dead route.
// See docs/source-register.md §6.2 for the full record.
// ─────────────────────────────────────────────────────────────────────────────

/** The ActiveCommunities portal host every tenant lives on. */
export const ACTIVENET_PORTAL_HOST = 'anc.ca.apm.activecommunities.com';

/**
 * Portal build stamps observed on the tenant page shell (`window.__version` /
 * `window.__cuiVersion`) at capture time. These are the BREAKAGE CANARY for a set of
 * undocumented, unversioned endpoints: a bump means the SPA moved and the payload
 * contract may have moved with it.
 *
 * Measured 2026-07-30 at https://anc.ca.apm.activecommunities.com/{tenant}/calendars —
 * BOTH tenants carry the SAME pair. (The D-10 scoping doc recorded these as
 * "26.9.53 Vancouver / 26.9.37 Burnaby"; that was a misattribution — they are two
 * different globals on the same page, identical across tenants. Corrected here from
 * a direct re-measurement.)
 */
export const ACTIVENET_PORTAL_VERSION = {
  version: '26.9.53',
  cuiVersion: '26.9.37',
  observedAt: '2026-07-30',
} as const;

export interface ActiveNetTenantConfig {
  tenantKey: string;
  /** Portal host — always ACTIVENET_PORTAL_HOST; explicit so a tenant move is config. */
  host: string;
  /** Tenant path segment on the host, e.g. '/vancouver'. */
  sitePath: string;
  municipality: string;
  /** IANA zone the portal's offset-less local timestamps are expressed in. */
  timezone: string;
  /** `source` row name (supabase/seeds/sources.sql). */
  sourceName: string;
  /**
   * Drop-in calendar ids to ingest. Enumerated from the tenant's own
   * `/onlinecalendar/calendars` response at capture time. Hard-coded (rather than
   * "ingest whatever the portal lists") so a new calendar is a reviewed decision;
   * the client re-lists calendars every run and WARNS on drift, so an addition or
   * removal surfaces instead of being silently absorbed.
   */
  dropInCalendarIds: number[];
  /** Config-level "this tenant has ingestable drop-in data". Runtime still requires
   *  the KIDS_FUN_LIVE_ACTIVENET env allow-list AND the DB terms gate. */
  enabled: boolean;
  /** Hard per-run request cap for this tenant (bounds the crawl footprint). */
  maxRequestsPerRun: number;
  /** What was measured for this tenant, in one line. Evidence, not aspiration. */
  evidenceNote: string;
}

export const ACTIVENET_TENANTS: ActiveNetTenantConfig[] = [
  {
    tenantKey: 'vancouver',
    host: ACTIVENET_PORTAL_HOST,
    sitePath: '/vancouver',
    municipality: 'Vancouver',
    timezone: 'America/Vancouver',
    sourceName: 'City of Vancouver ActiveNet',
    // 24 calendars are returned; calendar 23 is the "**Choose a Calendar" UI
    // placeholder and is excluded. The remaining 23 are listed here.
    dropInCalendarIds: [1, 3, 5, 6, 8, 9, 10, 11, 14, 15, 16, 20, 22, 26, 30, 32, 43, 46, 47, 49, 55, 56, 60],
    enabled: true,
    maxRequestsPerRun: 60,
    evidenceNote:
      '2026-07-30: 24 calendars listed (23 real + 1 UI placeholder), 36 centres, 10,146 occurrences over the 2026-07-26→09-20 calendar period (1,596 in the 08-03→08-09 week). Calendar 60 "Queer Inclusion" has zero centres configured and returns zero.',
  },
  {
    tenantKey: 'burnaby',
    host: ACTIVENET_PORTAL_HOST,
    sitePath: '/burnaby',
    municipality: 'Burnaby',
    timezone: 'America/Vancouver',
    sourceName: 'City of Burnaby ActiveNet',
    dropInCalendarIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 19],
    enabled: true,
    maxRequestsPerRun: 48,
    evidenceNote:
      '2026-07-30: 17 calendars, 7 centres, 4,786 occurrences over the 2026-07-27→11-08 calendar period (589 in the 08-03→08-09 week). Calendars 3/5/6 (Floor Hockey, Indoor Cycling, Multi-sport) have zero centres and return zero. 98% of titles are "Reserve In Advance:" pre-booked slots, not walk-in drop-ins — see docs/source-register.md §6.3.',
  },
  {
    tenantKey: 'west_vancouver',
    host: ACTIVENET_PORTAL_HOST,
    sitePath: '/westvanrec',
    municipality: 'West Vancouver',
    timezone: 'America/Vancouver',
    sourceName: 'District of West Vancouver ActiveNet',
    // Deliberately empty, and deliberately PRESENT: recording the measured zero is
    // the point. West Van must not be silently counted as a drop-in launch tenant.
    dropInCalendarIds: [],
    enabled: false,
    maxRequestsPerRun: 4,
    evidenceNote:
      'ZERO drop-in coverage. Verified 2026-07-30: the tenant is live and holds 6,566 registered activities, but /onlinecalendar/calendars returns an EMPTY array — the District does not use the online-calendar module at all. Report as zero; do NOT backfill with registered activities and call it drop-in coverage.',
  },
];

export function getTenantConfig(tenantKey: string): ActiveNetTenantConfig | undefined {
  return ACTIVENET_TENANTS.find((t) => t.tenantKey === tenantKey);
}

/** Tenants with measured, ingestable drop-in data. Runtime enablement additionally
 *  requires the env allow-list and the DB terms gate — this is the config half. */
export function ingestableTenants(): ActiveNetTenantConfig[] {
  return ACTIVENET_TENANTS.filter((t) => t.enabled && t.dropInCalendarIds.length > 0);
}

/** Base URL for the tenant's internal JSON REST API. */
export function restBaseUrl(tenant: ActiveNetTenantConfig): string {
  return `https://${tenant.host}${tenant.sitePath}/rest`;
}

/** Human-facing online-calendar page for the tenant — provenance/attribution fallback
 *  when an occurrence carries no `activity_detail_url`. */
export function calendarPageUrl(tenant: ActiveNetTenantConfig): string {
  return `https://${tenant.host}${tenant.sitePath}/calendars`;
}

/** Stable per-source politeness key (rate-limit + backoff state). */
export function policyKeyFor(tenant: ActiveNetTenantConfig): string {
  return `activenet::${tenant.tenantKey}`;
}
