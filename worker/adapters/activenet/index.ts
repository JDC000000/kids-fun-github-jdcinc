// worker/adapters/activenet/index.ts — G-T7-1: ActiveNet adapter scaffold
// (TSD §5.1 Adapter A). Proves the Adapter contract + config wiring for
// >=2 tenants.
//
// STILL FIXTURE-ONLY — and now for a DATA reason, not just a terms reason.
//
// The terms blocker cleared (D-9: Jon authorised use of ACTIVE's official
// Activity Search API v2 on the existing credentials). The T7 confirming query
// then ran against that API on 2026-07-30 and found the data itself unusable:
// Vancouver Park Board's 'ActiveNet CA' syndication STOPPED around 2024-06 —
// zero 2025 and zero 2026 activities, newest drop-in record ending 2023-08-26.
// Burnaby and West Vancouver have no municipal organization in the API at all.
// See docs/source-register.md §6.1 and config.ts for the per-tenant evidence.
//
// So the live fetch/parse/map path (G-T7-2..T7-6) was deliberately NOT built:
// there is nothing current to ingest, and wiring it would have meant dismantling
// the tests/compliance/no-bypass.test.ts tripwire to import ~3-year-old listings.
// fetch() therefore remains a local fixture dry-run making zero network calls,
// and this adapter still exposes no isLiveFetchEnabled().
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
import {
  ACTIVENET_TENANTS,
  ACTIVE_PUBLIC_BASE_URL,
  getTenantConfig,
  ingestableTenants,
  type ActiveNetTenantConfig,
} from './config';

interface ActiveNetFixtureEntry {
  id: string;
  title: string;
  venue: string;
  start: string;
  cost: number;
}

export class ActiveNetAdapter implements Adapter {
  readonly family = 'activenet';

  constructor(private readonly tenant: ActiveNetTenantConfig) {}

  async fetch(): Promise<unknown[]> {
    const fixture: ActiveNetFixtureEntry = {
      id: `${this.tenant.tenantKey}-open-gym-1`,
      title: 'Open Gym Drop-in',
      venue: `${this.tenant.municipality} Community Centre`,
      start: new Date().toISOString(),
      cost: 0,
    };
    return [fixture];
  }

  extract(raw: unknown[]): StructuredRecord[] {
    return (raw as ActiveNetFixtureEntry[]).map((r) => ({
      sourceRecordId: r.id,
      title: r.title,
      venueName: r.venue,
      startDatetimeUtc: r.start,
      costMinCad: r.cost,
      costMaxCad: r.cost,
      costStatus: r.cost === 0 ? ('free' as const) : ('known' as const),
      categoryHint: 'open_gym',
      // Never the barred ActiveCommunities portal — see config.ts COMPLIANCE note.
      sourceUrl: ACTIVE_PUBLIC_BASE_URL,
      raw: r,
    }));
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `activenet::${this.tenant.tenantKey}::${record.sourceRecordId}` };
  }
}

export function loadActiveNetAdapters(): ActiveNetAdapter[] {
  return ACTIVENET_TENANTS.map((tenant) => new ActiveNetAdapter(tenant));
}

export { ACTIVENET_TENANTS, getTenantConfig, ingestableTenants };
