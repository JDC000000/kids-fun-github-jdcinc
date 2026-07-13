// worker/adapters/activenet/config.ts — G-T7-1: ActiveNet tenant/calendar
// config (TSD §5.1 Adapter A). Config-driven so adding an ActiveNet
// municipality never needs new per-venue code — only a new entry here.
// sourceName ties each tenant to its `source` row (supabase/seeds/sources.sql).

export interface ActiveNetTenantConfig {
  tenantKey: string;
  municipality: string;
  /** ActiveCommunities/ActiveNet public calendar base URL for this tenant. */
  calendarBaseUrl: string;
  sourceName: string;
}

export const ACTIVENET_TENANTS: ActiveNetTenantConfig[] = [
  {
    tenantKey: 'vancouver',
    municipality: 'Vancouver',
    calendarBaseUrl: 'https://anc.ca.apm.activecommunities.com/vancouver/activity/search',
    sourceName: 'City of Vancouver ActiveNet',
  },
  {
    tenantKey: 'burnaby',
    municipality: 'Burnaby',
    calendarBaseUrl: 'https://anc.ca.apm.activecommunities.com/burnaby/activity/search',
    sourceName: 'City of Burnaby ActiveNet',
  },
  {
    tenantKey: 'west_vancouver',
    municipality: 'West Vancouver',
    calendarBaseUrl: 'https://anc.ca.apm.activecommunities.com/westvancouver/activity/search',
    sourceName: 'District of West Vancouver ActiveNet',
  },
];

export function getTenantConfig(tenantKey: string): ActiveNetTenantConfig | undefined {
  return ACTIVENET_TENANTS.find((t) => t.tenantKey === tenantKey);
}
