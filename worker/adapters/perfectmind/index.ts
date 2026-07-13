// worker/adapters/perfectmind/index.ts — G-T8-1: PerfectMind adapter scaffold
// (TSD §5.1 Adapter F). Distinct from ActiveNet (family 'perfectmind').
//
// This scaffold does NOT make live requests: PerfectMind sources are
// terms_status='pending' and G-T5-6's gate blocks any production run until a
// terms decision lands. fetch() is a dry-run over a synthetic post-render
// BookMe4 schedule fixture; the live headless render (BookMe4 dynamic widgets +
// anti-forgery handling in the worker runtime) is G-T8-2 onward, once a
// tenant's terms status clears. No login / CAPTCHA / anti-bot bypass.
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
import {
  PERFECTMIND_TENANTS,
  getPerfectMindTenant,
  type PerfectMindTenantConfig,
} from './config';

/** One row of a rendered BookMe4 schedule (post client-side render). */
interface BookMe4Row {
  id: string;
  title: string;
  venue: string;
  start: string;
  end: string;
  costCad: number;
  ages: string;
}

/** Deterministic category hint from the drop-in title (parent-language, §5A.2). */
function categoryHint(title: string): string | undefined {
  const t = title.toLowerCase();
  if (/open gym|drop.?in gym|gym time/.test(t)) return 'open_gym';
  if (/family swim|public swim|leisure swim/.test(t)) return 'public_swim';
  if (/public skate|family skate|open skate/.test(t)) return 'skate';
  return undefined;
}

export class PerfectMindAdapter implements Adapter {
  readonly family = 'perfectmind';

  constructor(private readonly tenant: PerfectMindTenantConfig) {}

  async fetch(): Promise<unknown[]> {
    // Synthetic post-render fixture (no live BookMe4 request). Shape only.
    const rows: BookMe4Row[] = [
      {
        id: `${this.tenant.tenantKey}-open-gym-1`,
        title: 'Open Gym - Parent & Tot',
        venue: `${this.tenant.municipality} Community Centre`,
        start: '2026-07-14T16:00:00.000Z',
        end: '2026-07-14T17:30:00.000Z',
        costCad: 0,
        ages: '0-5 years',
      },
      {
        id: `${this.tenant.tenantKey}-family-swim-1`,
        title: 'Family Swim - Public Swim',
        venue: `${this.tenant.municipality} Aquatic Centre`,
        start: '2026-07-14T20:30:00.000Z',
        end: '2026-07-14T22:30:00.000Z',
        costCad: 3.25,
        ages: 'All ages',
      },
    ];
    return rows;
  }

  extract(raw: unknown[]): StructuredRecord[] {
    return (raw as BookMe4Row[]).map((r) => ({
      sourceRecordId: r.id,
      title: r.title,
      venueName: r.venue,
      startDatetimeUtc: r.start,
      endDatetimeUtc: r.end,
      costMinCad: r.costCad,
      costMaxCad: r.costCad,
      costStatus: r.costCad === 0 ? ('free' as const) : ('known' as const),
      ageText: r.ages, // free-text → months resolved by normalizeHook / T13
      categoryHint: categoryHint(r.title),
      sourceUrl: this.tenant.widgetBaseUrl,
      raw: r,
    }));
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `perfectmind::${this.tenant.tenantKey}::${record.sourceRecordId}` };
  }
}

export function loadPerfectMindAdapters(): PerfectMindAdapter[] {
  return PERFECTMIND_TENANTS.map((tenant) => new PerfectMindAdapter(tenant));
}

export { PERFECTMIND_TENANTS, getPerfectMindTenant };
