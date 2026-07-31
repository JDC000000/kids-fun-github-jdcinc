// worker/adapters/perfectmind/config.ts — G-T8-2: PerfectMind / Xplor BookMe4
// tenant config (TSD §5.1 Adapter F, family `perfectmind`).
//
// ─────────────────────────────────────────────────────────────────────────────
// AUTHORITY — read before changing anything in this file.
//
// Automated access to the BookMe4 rec-portal is outside the vendor's published
// Terms of Use, on the same footing as ActiveNet. That prohibition has been
// OVERRIDDEN by the business owner (decisions_register D-10, 2026-07-30 — Jon's
// direct, twice-stated, informed override), and the read-only POST-as-query
// pattern is covered by the D-11 compliance-tripwire amendment. The risk is
// stated here unsoftened, because that is the point of recording it: we are
// reading a third party's portal against its published terms, on an explicit
// business decision to accept that risk. Xplor would be within its stated terms
// to block us and we would have no recourse. Nothing in this file's polite
// engineering makes that go away — it bounds the operational risk, not the terms
// risk.
//
// What D-10 did NOT do: it did not authorise deceptive or access-control-
// defeating access. Every request stays an identified, contactable,
// credential-free read (KidsFunBot UA, no cookie, no session, no
// __RequestVerificationToken, no browser spoof, no headless render) — all of
// which was verified UNNECESSARY against the live API on 2026-07-30 and
// RE-VERIFIED independently on 2026-07-31. tests/compliance/no-bypass.test.ts
// enforces every one of those prohibitions.
// ─────────────────────────────────────────────────────────────────────────────
//
// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION TO THE ROUND-13 SCAFFOLD (2026-07-13), preserved deliberately.
//
// The scaffold this file replaces asserted that BookMe4 "renders schedules with
// dynamic widgets + anti-forgery tokens, so it needs the headless worker
// runtime, not a JSON parse". THAT IS WRONG, and was written before anyone had
// probed the real API. Measured against the live tenant, twice:
//
//   POST /23734/Clients/BookMe4BookingPagesV2/ClassesV2
//   with NO token, NO cookie, and the project's own KidsFunBot UA
//   -> HTTP 200, ~130 KB of JSON.
//
// The page shell is an ASP.NET MVC + Kendo UI client that embeds a
// `__RequestVerificationToken` and sends it (`$.ajaxAntiForgeryPost`) — but the
// SERVER DOES NOT REQUIRE IT. So the anti-forgery prohibition stays absolutely
// banned for us: we never send one, and tests/adapters/perfectmind.test.ts
// proves it rather than leaving it true by omission.
//
// The vendor's NextRec rebrand did NOT move tenant URLs: `nvrc.nextrec.com` and
// `richmondcity.nextrec.com` are NXDOMAIN; the perfectmind tenant hosts below are
// live and current.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BookMe4 static-asset build stamp observed on the tenant page shell
 * (`/Scripts/....js?07231003`). This is the BREAKAGE CANARY for a set of
 * undocumented, unversioned endpoints: a bump means the widget bundle moved and
 * the payload contract may have moved with it. Re-measured 2026-07-31 against
 * NVRC's own `BookMe4BookingPages/Classes` shell.
 */
export const BOOKME4_ASSET_BUILD_STAMP = {
  stamp: '07231003',
  observedAt: '2026-07-31',
} as const;

export interface PerfectMindTenantConfig {
  tenantKey: string;
  /** Tenant host. EXACT — the D-10 override is host-scoped, not technique-scoped. */
  host: string;
  /** Numeric org id in the path: `https://{host}/{orgId}/Clients/...`. */
  orgId: string;
  /** Public BookMe4 widget GUID (no auth). */
  widgetId: string;
  municipality: string;
  /** IANA zone the portal's offset-less local timestamps are expressed in. */
  timezone: string;
  /** `source` row name (supabase/seeds/sources.sql). */
  sourceName: string;
  /**
   * Category names in the widget's own tree whose calendars carry DROP-IN
   * occurrences. Calendars are discovered dynamically per run via
   * GetCategoriesDataV2 rather than hard-coded, because the calendar GUIDs churn;
   * the CATEGORY name is the stable, reviewable unit.
   */
  dropInCategoryNames: string[];
  /** Config-level "this tenant has ingestable drop-in data". Runtime additionally
   *  requires the KIDS_FUN_LIVE_PERFECTMIND env allow-list AND the DB terms gate. */
  enabled: boolean;
  /** Hard per-run request cap for this tenant (bounds the crawl footprint). */
  maxRequestsPerRun: number;
  /** What was measured for this tenant, in one line. Evidence, not aspiration. */
  evidenceNote: string;
}

export const PERFECTMIND_TENANTS: PerfectMindTenantConfig[] = [
  {
    tenantKey: 'nvrc',
    host: 'nvrc.perfectmind.com',
    orgId: '23734',
    widgetId: 'a28b2c65-61af-407f-80d1-eaa58f30a94a',
    municipality: 'North Vancouver',
    timezone: 'America/Vancouver',
    sourceName: 'NVRC (North Vancouver) PerfectMind',
    dropInCategoryNames: ['**Drop-In Schedules'],
    enabled: true,
    maxRequestsPerRun: 60,
    evidenceNote:
      '2026-07-31 re-verified: 12 categories; the "**Drop-In Schedules" category holds 9 calendars (Art, Fitness Studio Workout, Indoor Playtime (Parent Participation), North Shore Neighbourhood House, Open Gym, Parkgate Society, Skate, Swim, Youth Services). Open Gym alone returned 55 occurrences over 2026-07-31..08-05 in one page. North Shore Neighbourhood House carries an EMPTY BookingLink and is expected to yield nothing.',
  },
  {
    tenantKey: 'richmond',
    host: 'richmondcity.perfectmind.com',
    orgId: '23650',
    widgetId: '15f6af07-39c5-473e-b053-96653f77a406',
    municipality: 'Richmond',
    timezone: 'America/Vancouver',
    sourceName: 'City of Richmond PerfectMind',
    // Deliberately EMPTY, and deliberately PRESENT: recording the measured zero is
    // the point (same treatment as ActiveNet's West Vancouver). Richmond must not
    // be silently counted as a drop-in launch tenant on the strength of its
    // registration data.
    dropInCategoryNames: [],
    enabled: false,
    maxRequestsPerRun: 4,
    evidenceNote:
      'ZERO drop-in coverage on PerfectMind. G-T8-1, 2026-07-31: the tenant is live, but its only public widget is a REGISTRATION widget. Its 8 categories hold 122 calendars, of which the 22 ClassesV2 can serve are 13 "*Registered Visits" facility calendars (book-ahead paid adult/senior slots — yoga, cycle-fit, table tennis 55+, badminton 18+), 6 "Events and Seasonal Programs" and 2 plant sales. NO drop-in category exists. Richmond publishes its actual walk-in drop-in schedules (public swim, public skate, gym, drop-in fitness) as PDFs on richmond.ca. Report as zero; do NOT backfill with registered visits or courses and call it drop-in coverage.',
  },
];

export function getPerfectMindTenant(tenantKey: string): PerfectMindTenantConfig | undefined {
  return PERFECTMIND_TENANTS.find((t) => t.tenantKey === tenantKey);
}

/** Tenants with measured, ingestable drop-in data. Runtime enablement additionally
 *  requires the env allow-list and the DB terms gate — this is the config half. */
export function ingestableTenants(): PerfectMindTenantConfig[] {
  return PERFECTMIND_TENANTS.filter((t) => t.enabled && t.dropInCategoryNames.length > 0);
}

/** Base URL for the tenant's BookMe4 client endpoints. */
export function clientsBaseUrl(tenant: PerfectMindTenantConfig): string {
  return `https://${tenant.host}/${tenant.orgId}/Clients`;
}

/** Human-facing widget start page — provenance/attribution fallback. */
export function widgetStartPageUrl(tenant: PerfectMindTenantConfig): string {
  return `${clientsBaseUrl(tenant)}/BookMe4?widgetId=${tenant.widgetId}`;
}

/** Human-facing schedule page for one calendar — the per-occurrence source URL. */
export function calendarPageUrl(tenant: PerfectMindTenantConfig, calendarId: string): string {
  return `${clientsBaseUrl(tenant)}/BookMe4BookingPages/Classes?calendarId=${calendarId}&widgetId=${tenant.widgetId}&embed=False`;
}

/** Stable per-source politeness key (rate-limit + backoff state). */
export function policyKeyFor(tenant: PerfectMindTenantConfig): string {
  return `perfectmind::${tenant.tenantKey}`;
}
