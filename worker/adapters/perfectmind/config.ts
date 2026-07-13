// worker/adapters/perfectmind/config.ts — G-T8-1: PerfectMind / Xplor BookMe4
// tenant config (TSD §5.1 Adapter F). A SEPARATE adapter from ActiveNet:
// BookMe4 renders schedules with dynamic widgets + anti-forgery tokens, so it
// needs the headless worker runtime (§3A.1), not a JSON parse. Launch tenants
// are Richmond + NVRC/North Vancouver; New West / Coquitlam / Surrey are later
// low-marginal-cost expansion candidates. Config-driven — a new municipality is
// a data change here, not new code.

export interface PerfectMindTenantConfig {
  tenantKey: string;
  municipality: string;
  /** Public BookMe4 widget/calendar URL (no auth). */
  widgetBaseUrl: string;
  /** BookMe4 pages are dynamic → require headless render in the worker runtime. */
  requiresRender: boolean;
  launchStatus: 'launch' | 'candidate';
}

export const PERFECTMIND_TENANTS: PerfectMindTenantConfig[] = [
  {
    tenantKey: 'richmond',
    municipality: 'Richmond',
    widgetBaseUrl: 'https://richmond.perfectmind.com/booking/richmond-dropin',
    requiresRender: true,
    launchStatus: 'launch',
  },
  {
    tenantKey: 'nvrc',
    municipality: 'North Vancouver (NVRC)',
    widgetBaseUrl: 'https://nvrc.perfectmind.com/booking/nvrc-dropin',
    requiresRender: true,
    launchStatus: 'launch',
  },
  {
    tenantKey: 'newwest',
    municipality: 'New Westminster',
    widgetBaseUrl: 'https://newwest.perfectmind.com/booking/newwest-dropin',
    requiresRender: true,
    launchStatus: 'candidate',
  },
];

export function getPerfectMindTenant(tenantKey: string): PerfectMindTenantConfig | undefined {
  return PERFECTMIND_TENANTS.find((t) => t.tenantKey === tenantKey);
}
