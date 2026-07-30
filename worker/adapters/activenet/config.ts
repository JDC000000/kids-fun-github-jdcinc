// worker/adapters/activenet/config.ts — G-T7-1: ActiveNet tenant config
// (TSD §5.1 Adapter A). Config-driven so adding an ActiveNet municipality never
// needs new per-venue code — only a new entry here. `sourceName` ties each
// tenant to its `source` row (supabase/seeds/sources.sql).
//
// ─────────────────────────────────────────────────────────────────────────────
// COMPLIANCE — read before adding a URL to this file.
//
// The ActiveCommunities rec-portal (anc.ca.apm.activecommunities.com/<tenant>)
// is BARRED by ACTIVE Network's Terms of Use for automated access by ANY
// technique — a plain JSON GET is as prohibited as a headless render. Portal
// URLs were removed from this config on purpose (they previously sat in a
// `calendarBaseUrl` field): a config entry is exactly how a barred host later
// gets wired into a live fetch by accident. Do not reintroduce them.
//
// The one confirmed-compliant path is ACTIVE's own official public Activity
// Search API v2 (developer.active.com) — read-only JSON whose express documented
// purpose is third-party redistribution of activity listings. Municipal ActiveNet
// tenants appear there as an *organization* whose records carry
// sourceSystem.sourceSystemName = 'ActiveNet CA'. That is why tenants below are
// keyed by `apiOrganizationName`, not by a portal URL.
// ─────────────────────────────────────────────────────────────────────────────

/** Official ACTIVE Activity Search API v2 endpoint — the only permitted host. */
export const ACTIVE_SEARCH_API_URL = 'https://api.amp.active.com/v2/search';

/** Public human-facing landing page, used for record attribution/provenance. */
export const ACTIVE_PUBLIC_BASE_URL = 'https://www.active.com';

/**
 * Whether a tenant's ActiveNet data is actually retrievable from the official
 * API — established empirically by the T7 confirming query (2026-07-30), not
 * assumed. Drives whether a tenant may ever be enabled in staging/production.
 */
export type ActiveNetSyndicationStatus =
  /** Organization publishes CURRENT listings to the official API. Ingestable. */
  | 'syndicated_current'
  /** Organization exists in the API but its newest records are historical. NOT ingestable. */
  | 'syndicated_stale'
  /** Organization is absent from the official API entirely. NOT ingestable. */
  | 'not_syndicated';

export interface ActiveNetTenantConfig {
  tenantKey: string;
  municipality: string;
  /** `source` row name (supabase/seeds/sources.sql). */
  sourceName: string;
  /**
   * organization.organizationName as it appears in Activity Search API v2
   * results. This is the join key for a tenant's records — undefined when the
   * tenant has no presence in the official API at all.
   */
  apiOrganizationName?: string;
  syndicationStatus: ActiveNetSyndicationStatus;
  /**
   * Newest activity date observed for this tenant in the official API during the
   * T7 confirming query. Undefined when the tenant is absent from the API.
   * Evidence for the enablement decision — see docs/source-register.md §6.1.
   */
  lastObservedActivityDate?: string;
  /** Why this tenant is / is not ingestable, in one line. */
  evidenceNote: string;
}

export const ACTIVENET_TENANTS: ActiveNetTenantConfig[] = [
  {
    tenantKey: 'vancouver',
    municipality: 'Vancouver',
    sourceName: 'City of Vancouver ActiveNet',
    apiOrganizationName: 'Vancouver Board of Parks and Recreation',
    // Present in the official API with the right sourceSystem ('ActiveNet CA')
    // and the right content (Open Gym / Public Swim / Public Skate) — but the
    // syndication STOPPED: 2021:1497, 2022:1342, 2023:~10k(capped), 2024:22,
    // 2025:0, 2026:0 activities. The newest drop-in record ends 2023-08-26 and
    // the final 22 records (2024-06-04) are preschool deposits, not drop-ins.
    syndicationStatus: 'syndicated_stale',
    lastObservedActivityDate: '2024-06-04',
    evidenceNote:
      'ActiveNet CA syndication ceased ~2024-06; zero 2025/2026 activities. Drop-in listings present but ~3yr stale.',
  },
  {
    tenantKey: 'burnaby',
    municipality: 'Burnaby',
    sourceName: 'City of Burnaby ActiveNet',
    // No municipal organization in the official API. Burnaby's 2026 records are
    // 100% private organizations (hockey schools, swim clubs) via 'AW Camps 3.0'
    // / 'ActiveWorks Team Sports' — not the City's ActiveNet tenant.
    syndicationStatus: 'not_syndicated',
    evidenceNote:
      'No City of Burnaby organization in the official API; 2026 Burnaby records are private orgs on AW Camps 3.0.',
  },
  {
    tenantKey: 'west_vancouver',
    municipality: 'West Vancouver',
    sourceName: 'District of West Vancouver ActiveNet',
    // Same as Burnaby: 2026 West Vancouver records are 100% private schools and
    // clubs (Collingwood School, Mulgrave School, Last Raps Baseball) on
    // 'AW Camps 3.0'. No District ActiveNet organization.
    syndicationStatus: 'not_syndicated',
    evidenceNote:
      'No District of West Vancouver organization in the official API; 2026 records are private schools/clubs on AW Camps 3.0.',
  },
];

export function getTenantConfig(tenantKey: string): ActiveNetTenantConfig | undefined {
  return ACTIVENET_TENANTS.find((t) => t.tenantKey === tenantKey);
}

/**
 * The only tenants that could ever be ingested. Empty today — Vancouver's feed
 * is stale and the other two are absent (see each tenant's evidenceNote).
 * Enablement must re-run the confirming query, not just flip a flag.
 */
export function ingestableTenants(): ActiveNetTenantConfig[] {
  return ACTIVENET_TENANTS.filter((t) => t.syndicationStatus === 'syndicated_current');
}
