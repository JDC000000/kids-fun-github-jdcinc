// worker/adapters/activenet/index.ts — G-T7-1: ActiveNet adapter scaffold
// (TSD §5.1 Adapter A). Proves the Adapter contract + config wiring for
// >=2 tenants.
//
// This scaffold does NOT make live requests: every ActiveNet source row is
// terms_status='pending' (supabase/seeds/sources.sql), and G-T5-6's gate
// blocks any production run until a terms decision lands (D-6, decisions
// register). fetch() is a dry-run against a local fixture payload. Wiring a
// real HTTP fetch is T7-2 onward, once a tenant's terms status clears.
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
import { ACTIVENET_TENANTS, getTenantConfig, type ActiveNetTenantConfig } from './config';

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
      sourceUrl: this.tenant.calendarBaseUrl,
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

export { ACTIVENET_TENANTS, getTenantConfig };
