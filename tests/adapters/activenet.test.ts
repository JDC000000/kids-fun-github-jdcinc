import { describe, it, expect } from 'vitest';
import { loadActiveNetAdapters, ACTIVENET_TENANTS, getTenantConfig } from '../../worker/adapters/activenet';

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
