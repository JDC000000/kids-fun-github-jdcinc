import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  loadActiveNetAdapters,
  ACTIVENET_TENANTS,
  getTenantConfig,
  ingestableTenants,
} from '../../worker/adapters/activenet';

// G-T7-1 — ActiveNet adapter scaffold + tenant/calendar config (TSD §5.1).
describe('ActiveNet adapter scaffold (G-T7-1)', () => {
  it('loads config for at least 2 launch municipalities', () => {
    expect(ACTIVENET_TENANTS.length).toBeGreaterThanOrEqual(2);
    expect(getTenantConfig('vancouver')?.municipality).toBe('Vancouver');
    expect(getTenantConfig('burnaby')?.municipality).toBe('Burnaby');
  });

  it('registers one adapter instance per configured tenant (config-driven, no per-venue code)', () => {
    const adapters = loadActiveNetAdapters();
    expect(adapters).toHaveLength(ACTIVENET_TENANTS.length);
    expect(adapters.every((a) => a.family === 'activenet')).toBe(true);
  });

  it('dry-run fetch + extract yields a structured record with a tenant-scoped dedup key', async () => {
    const [vancouver] = loadActiveNetAdapters();
    const raw = await vancouver.fetch();
    const records = vancouver.extract(raw);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].categoryHint).toBe('open_gym');
    const key = vancouver.dedupKeys(records[0]);
    expect(key.key).toContain('activenet::vancouver::');
  });
});

// T7 confirming query (2026-07-30) — the ActiveCommunities rec-portal is barred by
// ACTIVE's ToU, and the one compliant path (official Activity Search API v2) carries
// no CURRENT data for any of our three tenants. These tests pin both facts so a
// later round cannot quietly reintroduce the barred host or enable a dead tenant.
describe('ActiveNet compliance + syndication guards (T7 confirming query)', () => {
  const ADAPTER_FILES = ['index.ts', 'config.ts'].map((f) =>
    join(process.cwd(), 'worker/adapters/activenet', f)
  );

  it('no adapter file references the ToU-barred ActiveCommunities portal host', () => {
    for (const file of ADAPTER_FILES) {
      // Strip comments: the COMPLIANCE note names the barred host deliberately, to
      // warn future readers. What must never reappear is an executable reference.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} must not reference the barred rec-portal host`).not.toMatch(
        /activecommunities\.com/i
      );
    }
  });

  it('only the official ACTIVE API host is configured as a data endpoint', () => {
    const config = readFileSync(ADAPTER_FILES[1], 'utf8');
    expect(config).toContain('https://api.amp.active.com/v2/search');
  });

  it('no tenant is ingestable — Vancouver stale, Burnaby/West Van absent', () => {
    // Guard, not a wish: flipping a tenant to 'syndicated_current' must be backed by
    // a fresh confirming query, which is what this failing test forces you to do.
    expect(ingestableTenants()).toHaveLength(0);
    expect(getTenantConfig('vancouver')?.syndicationStatus).toBe('syndicated_stale');
    expect(getTenantConfig('burnaby')?.syndicationStatus).toBe('not_syndicated');
    expect(getTenantConfig('west_vancouver')?.syndicationStatus).toBe('not_syndicated');
  });

  it('every tenant carries evidence for its exclusion', () => {
    for (const tenant of ACTIVENET_TENANTS) {
      expect(tenant.evidenceNote.length, `${tenant.tenantKey} needs an evidenceNote`).toBeGreaterThan(20);
    }
    // Vancouver is the only one that exists in the API, so it is the only one with
    // an observed last-activity date.
    expect(getTenantConfig('vancouver')?.lastObservedActivityDate).toBe('2024-06-04');
    expect(getTenantConfig('burnaby')?.lastObservedActivityDate).toBeUndefined();
  });
});
